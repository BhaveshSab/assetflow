import { Queue, Worker } from 'bullmq';
import { createServer } from 'node:http';
import { Gauge, Registry } from 'prom-client';
import { PrismaService } from '../prisma/prisma.service';
import { queueConnection } from './queue-config';
import { processReminder } from './reminder-processor';

import { processImport } from '../imports/import-processor';
import { traced } from '../telemetry/tracing';
const QUEUE = 'assetflow-booking-reminders';

/** Runs only in the dedicated worker entry point, never inside an API import. */
export async function startJobsWorker(
  prisma: PrismaService,
  queueName = QUEUE,
) {
  if (process.env.JOBS_ENABLED !== 'true')
    throw new Error('Set JOBS_ENABLED=true to start the worker');
  const connection = queueConnection(process.env.JOBS_REDIS_URL);
  const port = Number(process.env.JOBS_METRICS_PORT || 4001);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid JOBS_METRICS_PORT');
  const queue = new Queue(queueName, {
    connection: {
      ...connection,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    },
  });
  // Only IDs go into Redis; current permissions/state/content live in Postgres.
  const worker = new Worker<{ eventId: string; epoch: number }>(
    queueName,
    async (job) => {
      const { eventId, epoch } = job.data;
      const source = await prisma.jobOutbox.findUnique({
        where: { id: eventId },
        select: { traceparent: true },
      });
      await traced('booking.reminder.process', source?.traceparent, () =>
        processReminder(prisma, eventId, epoch),
      );
    },
    {
      connection: { ...connection, maxRetriesPerRequest: null },
      concurrency: 2,
    },
  );
  const safeError = () =>
    console.error('Job runtime dependency error; inspect DB/Redis health');
  queue.on('error', safeError);
  worker.on('error', safeError);
  worker.on('failed', (job) => {
    if (job && job.attemptsMade >= 5) {
      void prisma.jobOutbox
        .updateMany({
          where: {
            id: job.data.eventId,
            retryEpoch: job.data.epoch,
            status: { not: 'DONE' },
          },
          data: {
            status: 'FAILED',
            leaseUntil: null,
            lastError: 'DeliveryFailed',
          },
        })
        .catch(safeError);
    }
  });
  const importQueue = new Queue(`${queueName}-imports`, {
    connection: {
      ...connection,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    },
  });
  const importWorker = new Worker<{ id: string; epoch: number }>(
    `${queueName}-imports`,
    (job) => processImport(prisma, job.data.id, job.data.epoch),
    {
      connection: { ...connection, maxRetriesPerRequest: null },
      concurrency: 1,
    },
  );
  importQueue.on('error', safeError);
  importWorker.on('error', safeError);
  importWorker.on('failed', (job) => {
    if (job && job.attemptsMade >= 3)
      void prisma.assetImport
        .updateMany({
          where: {
            id: job.data.id,
            retryEpoch: job.data.epoch,
            status: { in: ['PENDING', 'QUEUED'] },
          },
          data: {
            status: 'FAILED',
            lastError: 'ImportDeliveryFailed',
            leaseUntil: null,
          },
        })
        .catch(safeError);
  });
  const registry = new Registry();
  const states = new Gauge({
    name: 'assetflow_jobs_outbox',
    help: 'Durable job rows by state',
    labelNames: ['state'],
    registers: [registry],
  });
  const queueStates = new Gauge({
    name: 'assetflow_jobs_queue',
    help: 'BullMQ job counts by state',
    labelNames: ['state'],
    registers: [registry],
  });
  const oldest = new Gauge({
    name: 'assetflow_jobs_oldest_due_seconds',
    help: 'Age of oldest unfinished due reminder',
    registers: [registry],
  });
  let lastHealthy = 0;
  let stopping = false;
  let inFlight: Promise<void> | undefined;
  async function tick() {
    // Backfill pre-feature bookings in bounded batches. No Redis is involved
    // in business transactions; new bookings already have their own outbox.
    await prisma.$executeRaw`
      INSERT INTO "JobOutbox" (id, topic, "bookingId", version, "availableAt")
      SELECT 'booking_' || md5(b.id || ':' || b."reminderVersion"::text),
        'booking.reminder', b.id, b."reminderVersion", b."startTime" - interval '30 minutes'
      FROM "Booking" b WHERE b.status <> 'CANCELLED' AND b."startTime" > NOW()
        AND NOT EXISTS (SELECT 1 FROM "JobOutbox" o WHERE o."bookingId" = b.id AND o.version = b."reminderVersion")
      ORDER BY b."startTime" LIMIT 100 ON CONFLICT DO NOTHING`;
    // Atomically claim a short lease. Multiple publishers cannot claim the
    // same row concurrently. Crashed publishers become eligible again.
    const claimed = await prisma.$queryRaw<
      { id: string; retryEpoch: number }[]
    >`
      UPDATE "JobOutbox" SET status='QUEUED', "leaseUntil"=NOW()+interval '5 minutes'
      WHERE id IN (SELECT id FROM "JobOutbox"
        WHERE status IN ('PENDING','QUEUED') AND "availableAt"<=NOW()
          AND ("leaseUntil" IS NULL OR "leaseUntil"<NOW())
        ORDER BY "availableAt" LIMIT 50 FOR UPDATE SKIP LOCKED)
      RETURNING id, "retryEpoch"`;
    for (const event of claimed) {
      await queue.add(
        'booking.reminder',
        { eventId: event.id, epoch: event.retryEpoch },
        {
          jobId: `${event.id}-${event.retryEpoch}`,
          attempts: 5,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: { age: 86400, count: 1000 },
          removeOnFail: { age: 7 * 86400, count: 1000 },
        },
      );
    }
    // Durable lease + stable job ID recover from publisher/Redis loss.
    const imports = await prisma.$queryRaw<
      { id: string; retryEpoch: number }[]
    >`
      UPDATE "AssetImport" SET status='QUEUED', "leaseUntil"=NOW()+interval '5 minutes'
      WHERE id IN (SELECT id FROM "AssetImport" WHERE status IN ('PENDING','QUEUED')
        AND ("leaseUntil" IS NULL OR "leaseUntil"<NOW())
        ORDER BY "createdAt" LIMIT 5 FOR UPDATE SKIP LOCKED)
      RETURNING id, "retryEpoch"`;
    for (const job of imports)
      await importQueue.add(
        'asset.import',
        { id: job.id, epoch: job.retryEpoch },
        {
          jobId: `${job.id}-${job.retryEpoch}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: { age: 86400, count: 1000 },
          removeOnFail: { age: 604800, count: 1000 },
        },
      );
    const counts = await queue.getJobCounts(
      'waiting',
      'active',
      'failed',
      'delayed',
    );
    for (const [state, value] of Object.entries(counts))
      queueStates.set({ state }, value);
    const rows = await prisma.jobOutbox.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    for (const state of ['PENDING', 'QUEUED', 'DONE', 'FAILED'])
      states.set(
        { state },
        rows.find((r) => r.status === state)?._count._all || 0,
      );
    const pending = await prisma.jobOutbox.findFirst({
      where: {
        status: { in: ['PENDING', 'QUEUED', 'FAILED'] },
        availableAt: { lte: new Date() },
      },
      orderBy: { availableAt: 'asc' },
    });
    oldest.set(
      pending
        ? Math.max(0, (Date.now() - pending.availableAt.getTime()) / 1000)
        : 0,
    );
    lastHealthy = Date.now();
  }
  const poll = () => {
    if (stopping || inFlight) return;
    inFlight = tick()
      .catch(safeError)
      .finally(() => {
        inFlight = undefined;
      });
  };
  const timer = setInterval(poll, 5000);
  poll();
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.statusCode = Date.now() - lastHealthy < 30000 ? 200 : 503;
      res.end(res.statusCode === 200 ? 'ready' : 'dependencies unavailable');
    } else if (req.url === '/metrics') {
      res.setHeader('Content-Type', registry.contentType);
      void registry
        .metrics()
        .then((body) => res.end(body))
        .catch(() => {
          res.statusCode = 500;
          res.end();
        });
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });
  return async () => {
    stopping = true;
    clearInterval(timer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await worker.close();
    await importWorker.close();
    await inFlight;
    await queue.close();
    await importQueue.close();
  };
}
