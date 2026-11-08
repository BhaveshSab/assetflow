/** Uses an explicitly supplied disposable Redis, never REDIS_URL/JOBS_REDIS_URL. */
import { INestApplication } from '@nestjs/common';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { startJobsWorker } from '../src/jobs/jobs-worker';
import { queueConnection } from '../src/jobs/queue-config';
import { scheduleBookingReminder } from '../src/jobs/booking-reminder';
import { JobsService } from '../src/jobs/jobs.service';
import {
  createAsset,
  createTestApp,
  createUser,
  resetDatabase,
  seedFixtures,
} from './utils/test-app';

const queueSuite = process.env.TEST_JOBS_REDIS_URL ? describe : describe.skip;
queueSuite('BullMQ publisher/worker integration (disposable Redis)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let queue: Queue;
  let close: (() => Promise<void>) | undefined;
  let name: string;
  let userId: string;
  let assetId: string;
  async function waitFor(check: () => Promise<boolean>) {
    const until = Date.now() + 35000;
    while (Date.now() < until) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('Worker condition timed out');
  }
  beforeAll(async () => {
    app = await createTestApp({
      JOBS_ENABLED: 'true',
      JOBS_REDIS_URL: process.env.TEST_JOBS_REDIS_URL!,
      JOBS_METRICS_PORT: '14001',
    });
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDatabase(app);
    const fixtures = await seedFixtures(app);
    const user = await createUser(app, {
      name: 'Booker',
      email: 'queue@example.com',
      role: 'ADMIN',
    });
    userId = user.id;
    assetId = (
      await createAsset(app, {
        name: 'Room',
        categoryId: fixtures.electronics.id,
        isBookable: true,
      })
    ).id;
    name = `assetflow-test-${randomUUID()}`;
    queue = new Queue(name, {
      connection: {
        ...queueConnection(process.env.TEST_JOBS_REDIS_URL),
        maxRetriesPerRequest: 1,
      },
    });
    await queue.waitUntilReady();
  });
  afterEach(async () => {
    if (close) {
      await close();
      close = undefined;
    }
    await queue.obliterate({ force: true }); // Only this suite's unique queue.
    await queue.close();
  });
  async function fixture() {
    return prisma.$transaction(async (tx) => {
      const booking = await tx.booking.create({
        data: {
          assetId,
          bookedById: userId,
          startTime: new Date(Date.now() + 1200000),
          endTime: new Date(Date.now() + 2400000),
        },
      });
      return scheduleBookingReminder(tx, booking);
    });
  }
  it('publishes due rows, processes real jobs and serves dependency/queue metrics', async () => {
    const event = await fixture();
    close = await startJobsWorker(prisma, name);
    await waitFor(
      async () =>
        (await prisma.jobOutbox.findUniqueOrThrow({ where: { id: event.id } }))
          .status === 'DONE',
    );
    expect(
      await prisma.notification.count({ where: { type: 'BOOKING_REMINDER' } }),
    ).toBe(1);
    await waitFor(
      async () => (await fetch('http://localhost:14001/health')).status === 200,
    );
    const metrics = await (
      await fetch('http://localhost:14001/metrics')
    ).text();
    expect(metrics).toContain('assetflow_jobs_queue');
    expect(metrics).toContain('assetflow_jobs_outbox');
    expect(metrics).toContain('assetflow_jobs_oldest_due_seconds');
  });
  it('recovers a claimed event after Redis queue loss and publisher restart', async () => {
    const event = await fixture();
    await prisma.jobOutbox.update({
      where: { id: event.id },
      data: { status: 'QUEUED', leaseUntil: new Date(Date.now() - 1000) },
    });
    // The Redis queue is empty but PostgreSQL still holds the claimed work.
    close = await startJobsWorker(prisma, name);
    await waitFor(
      async () =>
        (await prisma.jobOutbox.findUniqueOrThrow({ where: { id: event.id } }))
          .status === 'DONE',
    );
    expect(
      await prisma.notification.count({ where: { type: 'BOOKING_REMINDER' } }),
    ).toBe(1);
  });
  it('backfills existing bookings which predate the outbox feature', async () => {
    const event = await fixture();
    await prisma.jobOutbox.delete({ where: { id: event.id } });
    close = await startJobsWorker(prisma, name);
    await waitFor(
      async () =>
        (await prisma.notification.count({
          where: { type: 'BOOKING_REMINDER' },
        })) === 1,
    );
    expect((await prisma.jobOutbox.findFirstOrThrow()).status).toBe('DONE');
  });
  it('bounds failed delivery retries and an authorised new epoch can recover', async () => {
    const event = await fixture();
    await prisma.jobOutbox.update({
      where: { id: event.id },
      data: { topic: 'unsupported.test' },
    });
    close = await startJobsWorker(prisma, name);
    await waitFor(
      async () =>
        (await prisma.jobOutbox.findUniqueOrThrow({ where: { id: event.id } }))
          .status === 'FAILED',
    );
    expect(
      (await prisma.jobOutbox.findUniqueOrThrow({ where: { id: event.id } }))
        .attempts,
    ).toBe(5);
    expect(await prisma.notification.count()).toBe(0);
    await prisma.jobOutbox.update({
      where: { id: event.id },
      data: { topic: 'booking.reminder' },
    });
    await new JobsService(prisma).retry(event.id, userId);
    await waitFor(
      async () =>
        (await prisma.jobOutbox.findUniqueOrThrow({ where: { id: event.id } }))
          .status === 'DONE',
    );
    expect(await prisma.notification.count()).toBe(1);
  });
});
