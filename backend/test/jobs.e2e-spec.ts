import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { processReminder } from '../src/jobs/reminder-processor';
import { scheduleBookingReminder } from '../src/jobs/booking-reminder';
import { JobsService } from '../src/jobs/jobs.service';
import {
  auth,
  createAsset,
  createTestApp,
  createUserWithToken,
  resetDatabase,
  seedFixtures,
} from './utils/test-app';

describe('Durable booking reminders (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let admin: { user: { id: string }; token: string };
  let asset: { id: string };
  beforeAll(async () => {
    app = await createTestApp({ JOBS_ENABLED: 'true' });
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDatabase(app);
    const fixtures = await seedFixtures(app);
    ({ token } = await createUserWithToken(app, {
      name: 'Booker',
      email: 'booker@example.com',
    }));
    admin = await createUserWithToken(app, {
      name: 'Admin',
      email: 'admin@example.com',
      role: 'ADMIN',
    });
    asset = await createAsset(app, {
      name: 'Room',
      categoryId: fixtures.electronics.id,
      isBookable: true,
    });
  });
  const times = (minutes: number) => ({
    startTime: new Date(Date.now() + minutes * 60000).toISOString(),
    endTime: new Date(Date.now() + (minutes + 30) * 60000).toISOString(),
  });
  async function book(minutes = 20) {
    return (
      await request(app.getHttpServer())
        .post('/api/bookings')
        .set(auth(token))
        .send({ assetId: asset.id, ...times(minutes) })
        .expect(201)
    ).body;
  }
  async function event(id: string, version = 0) {
    return prisma.jobOutbox.findUniqueOrThrow({
      where: { bookingId_version: { bookingId: id, version } },
    });
  }
  async function reminders(id: string) {
    return prisma.notification.findMany({
      where: { relatedEntityId: id, type: 'BOOKING_REMINDER' },
    });
  }

  it('commits a booking and due event together without needing Redis', async () => {
    const booking = await book();
    const row = await event(booking.id);
    expect(row.status).toBe('PENDING');
    expect(row.availableAt.getTime()).toBe(
      new Date(booking.startTime).getTime() - 1800000,
    );
  });
  it('rolls back both booking and event when the business transaction fails', async () => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: 'booker@example.com' },
    });
    await expect(
      prisma.$transaction(async (tx) => {
        const booking = await tx.booking.create({
          data: {
            assetId: asset.id,
            bookedById: user.id,
            startTime: new Date(Date.now() + 3600000),
            endTime: new Date(Date.now() + 7200000),
          },
        });
        await scheduleBookingReminder(tx, booking);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await prisma.booking.count()).toBe(0);
    expect(await prisma.jobOutbox.count()).toBe(0);
  });
  it('does not create an outbox event for a rejected overlapping booking', async () => {
    const booking = await book();
    await request(app.getHttpServer())
      .post('/api/bookings')
      .set(auth(token))
      .send({
        assetId: asset.id,
        startTime: booking.startTime,
        endTime: booking.endTime,
      })
      .expect(409);
    expect(await prisma.jobOutbox.count()).toBe(1);
  });
  it('duplicate delivery produces one notification, including concurrent delivery', async () => {
    const booking = await book();
    const row = await event(booking.id);
    await Promise.all([
      processReminder(prisma, row.id, 0),
      processReminder(prisma, row.id, 0),
    ]);
    await processReminder(prisma, row.id, 0);
    expect(await reminders(booking.id)).toHaveLength(1);
    expect((await event(booking.id)).status).toBe('DONE');
  });
  it('cancelled bookings suppress already queued reminders', async () => {
    const booking = await book();
    const row = await event(booking.id);
    await request(app.getHttpServer())
      .post(`/api/bookings/${booking.id}/cancel`)
      .set(auth(token))
      .expect(200);
    await processReminder(prisma, row.id, 0);
    expect(await reminders(booking.id)).toHaveLength(0);
    expect((await event(booking.id)).status).toBe('DONE');
  });
  it('rescheduling fences stale events and creates one reminder for the new revision', async () => {
    const booking = await book();
    const original = await event(booking.id);
    await request(app.getHttpServer())
      .patch(`/api/bookings/${booking.id}/reschedule`)
      .set(auth(token))
      .send(times(25))
      .expect(200);
    await processReminder(prisma, original.id, 0);
    expect(await reminders(booking.id)).toHaveLength(0);
    const current = await event(booking.id, 1);
    await processReminder(prisma, current.id, 0);
    await processReminder(prisma, current.id, 0);
    expect(await reminders(booking.id)).toHaveLength(1);
  });
  it('rejects early delivery without creating a notification', async () => {
    const booking = await book(90);
    const row = await event(booking.id);
    await expect(processReminder(prisma, row.id, 0)).rejects.toThrow(
      'ReminderNotDue',
    );
    expect(await reminders(booking.id)).toHaveLength(0);
    expect((await event(booking.id)).status).toBe('PENDING');
  });
  it('skips expired bookings after worker downtime', async () => {
    const booking = await book();
    const row = await event(booking.id);
    await processReminder(
      prisma,
      row.id,
      0,
      new Date(Date.now() + 24 * 3600000),
    );
    expect(await reminders(booking.id)).toHaveLength(0);
  });
  it('skips inactive recipients', async () => {
    const booking = await book();
    const row = await event(booking.id);
    await prisma.user.update({
      where: { id: booking.bookedById },
      data: { status: 'INACTIVE' },
    });
    await processReminder(prisma, row.id, 0);
    expect(await reminders(booking.id)).toHaveLength(0);
  });
  it('requires admin privileges for job inspection and retries', async () => {
    await request(app.getHttpServer()).get('/api/jobs').expect(401);
    await request(app.getHttpServer())
      .get('/api/jobs')
      .set(auth(token))
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/jobs/missing/retry')
      .set(auth(token))
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/jobs')
      .set(auth(admin.token))
      .expect(200);
  });
  it('retries failed jobs in a new epoch, records audit and ignores old deliveries', async () => {
    const booking = await book();
    const row = await event(booking.id);
    await prisma.jobOutbox.update({
      where: { id: row.id },
      data: { status: 'FAILED', attempts: 5 },
    });
    await request(app.getHttpServer())
      .post(`/api/jobs/${row.id}/retry`)
      .set(auth(admin.token))
      .expect(200);
    expect((await event(booking.id)).retryEpoch).toBe(1);
    await processReminder(prisma, row.id, 0);
    expect(await reminders(booking.id)).toHaveLength(0);
    await processReminder(prisma, row.id, 1);
    expect(await reminders(booking.id)).toHaveLength(1);
    expect(
      await prisma.activityLog.count({
        where: { action: 'job.retried', entityId: row.id },
      }),
    ).toBe(1);
    await expect(
      new JobsService(prisma).retry(row.id, admin.user.id),
    ).rejects.toThrow('Only failed');
  });
  it('stops work at the durable attempt limit even after Redis state loss', async () => {
    const booking = await book();
    const row = await event(booking.id);
    await prisma.jobOutbox.update({
      where: { id: row.id },
      data: { attempts: 5 },
    });
    await processReminder(prisma, row.id, 0);
    expect((await event(booking.id)).status).toBe('FAILED');
    expect(await reminders(booking.id)).toHaveLength(0);
  });
});
