import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { NotificationsService } from '../src/notifications/notifications.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { startupStatus } from '../src/config/startup-status';
import {
  createTestApp,
  createUserWithToken,
  resetDatabase,
  auth,
} from './utils/test-app';

describe('Shared screen failures when database and image are out of sync', () => {
  let app: INestApplication;
  let db: PrismaService;
  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(PrismaService);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDatabase(app);
    startupStatus.clearError();
  });
  it('rejects readiness and reports actionable errors across authenticated screens when a required column is missing', async () => {
    const admin = await createUserWithToken(app, {
      name: 'Admin',
      email: 'migration@example.test',
      role: 'ADMIN',
    });
    await db.$executeRawUnsafe(
      'ALTER TABLE "User" RENAME COLUMN "tokenVersion" TO "oldTokenVersion"',
    );
    try {
      const ready = await request(app.getHttpServer())
        .get('/api/health/ready')
        .expect(503);
      expect(ready.body).toMatchObject({
        status: 'not-ready',
        database: 'up',
        schema: 'outdated',
      });
      const live = await request(app.getHttpServer())
        .get('/api/health')
        .expect(200);
      expect(live.body.status).toBe('degraded');
      for (const endpoint of [
        '/api/assets',
        '/api/reports/dashboard',
        '/api/bookings',
        '/api/notifications',
      ]) {
        const response = await request(app.getHttpServer())
          .get(endpoint)
          .set(auth(admin.token))
          .expect(503);
        expect(response.body.code).toBe('DATABASE_SCHEMA_NOT_READY');
        expect(response.body.message).toMatch(/migrations/);
        expect(response.body.requestId).toBe(response.headers['x-request-id']);
        expect(response.text).not.toMatch(
          /oldTokenVersion|SELECT|passwordHash/,
        );
      }
    } finally {
      await db.$executeRawUnsafe(
        'ALTER TABLE "User" RENAME COLUMN "oldTokenVersion" TO "tokenVersion"',
      );
    }
    await request(app.getHttpServer()).get('/api/health/ready').expect(200);
    await request(app.getHttpServer())
      .get('/api/assets')
      .set(auth(admin.token))
      .expect(200);
  });
  it('serves real notifications and event writes without the worker-only dedupeKey column', async () => {
    const owner = await createUserWithToken(app, {
      name: 'Owner',
      email: 'notification-owner@example.test',
    });
    const other = await createUserWithToken(app, {
      name: 'Other',
      email: 'notification-other@example.test',
    });
    const notifications = app.get(NotificationsService);
    await notifications.notify({
      userId: other.user.id,
      type: 'ASSET_ASSIGNED',
      message: 'Private to other user',
    });
    await db.$executeRawUnsafe(
      'ALTER TABLE "Notification" RENAME COLUMN "dedupeKey" TO "oldDedupeKey"',
    );
    try {
      // Reproduce the exact old implicit SELECT failure, without mocking Prisma.
      await expect(db.notification.findMany()).rejects.toMatchObject({
        code: 'P2022',
      });
      await request(app.getHttpServer())
        .get('/api/auth/me')
        .set(auth(owner.token))
        .expect(200);
      await notifications.notify({
        userId: owner.user.id,
        type: 'ASSET_ASSIGNED',
        message: 'Your real notification',
      });
      const listed = await request(app.getHttpServer())
        .get('/api/notifications')
        .set(auth(owner.token))
        .expect(200);
      expect(listed.body.unreadCount).toBe(1);
      expect(listed.body.items).toHaveLength(1);
      expect(listed.body.items[0]).toMatchObject({
        userId: owner.user.id,
        message: 'Your real notification',
        isRead: false,
      });
      expect(listed.body.items[0]).not.toHaveProperty('dedupeKey');
      // Read endpoints still enforce ownership and unread filtering.
      await request(app.getHttpServer())
        .patch(`/api/notifications/${listed.body.items[0].id}/read`)
        .set(auth(other.token))
        .expect(200);
      const stillUnread = await request(app.getHttpServer())
        .get('/api/notifications?unread=true')
        .set(auth(owner.token))
        .expect(200);
      expect(stillUnread.body.items).toHaveLength(1);
      await request(app.getHttpServer())
        .patch(`/api/notifications/${listed.body.items[0].id}/read`)
        .set(auth(owner.token))
        .expect(200);
      const read = await request(app.getHttpServer())
        .get('/api/notifications?unread=true')
        .set(auth(owner.token))
        .expect(200);
      expect(read.body).toMatchObject({ items: [], unreadCount: 0 });
      // Compatibility is not a substitute for completing the database migration.
      const ready = await request(app.getHttpServer())
        .get('/api/health/ready')
        .expect(503);
      expect(ready.body.schema).toBe('outdated');
    } finally {
      await db.$executeRawUnsafe(
        'ALTER TABLE "Notification" RENAME COLUMN "oldDedupeKey" TO "dedupeKey"',
      );
    }
    await request(app.getHttpServer()).get('/api/health/ready').expect(200);
  });
  it('detects missing optional-feature tables even when connectivity works', async () => {
    await db.$executeRawUnsafe(
      'ALTER TABLE "Attachment" RENAME TO "OldAttachment"',
    );
    try {
      const ready = await request(app.getHttpServer())
        .get('/api/health/ready')
        .expect(503);
      expect(ready.body.schema).toBe('outdated');
    } finally {
      await db.$executeRawUnsafe(
        'ALTER TABLE "OldAttachment" RENAME TO "Attachment"',
      );
    }
    await request(app.getHttpServer()).get('/api/health/ready').expect(200);
  });
  it('returns HTTP 503 for invalid startup configuration (not a green container probe)', async () => {
    startupStatus.setError('Required configuration is missing');
    try {
      const ready = await request(app.getHttpServer())
        .get('/api/health/ready')
        .expect(503);
      expect(ready.body.status).toBe('not-ready');
    } finally {
      startupStatus.clearError();
    }
  });
  it('returns 503 without leaking connection errors when the database is unavailable', async () => {
    const query = jest
      .spyOn(db, '$queryRaw')
      .mockRejectedValueOnce(
        new Error('postgres://private-user:SECRET@private-host/db'),
      );
    try {
      const ready = await request(app.getHttpServer())
        .get('/api/health/ready')
        .expect(503);
      expect(ready.body.database).toBe('down');
      expect(ready.text).not.toMatch(/SECRET|private-host|private-user/);
    } finally {
      query.mockRestore();
    }
  });
});
