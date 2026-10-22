import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import {
  auth,
  createAsset,
  createTestApp,
  createUserWithToken,
  resetDatabase,
  seedFixtures,
  type Fixtures,
} from './utils/test-app';

describe('Notifications & Activity log (e2e)', () => {
  let app: INestApplication;
  let fixtures: Fixtures;
  let adminToken: string;
  let managerToken: string;
  let employeeToken: string;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app);
    fixtures = await seedFixtures(app);
    adminToken = (
      await createUserWithToken(app, {
        name: 'Ava Admin',
        email: 'admin@example.com',
        role: 'ADMIN',
      })
    ).token;
    managerToken = (
      await createUserWithToken(app, {
        name: 'Manav Manager',
        email: 'manager@example.com',
        role: 'ASSET_MANAGER',
      })
    ).token;
    employeeToken = (
      await createUserWithToken(app, {
        name: 'Priya',
        email: 'priya@example.com',
        departmentId: fixtures.it.id,
      })
    ).token;
  });

  it('notifies the holder when an asset is allocated', async () => {
    const asset = await createAsset(app, {
      name: 'Laptop',
      assetTag: 'AF-0001',
      categoryId: fixtures.electronics.id,
    });
    const directory = await request(app.getHttpServer())
      .get('/api/org/employees/directory')
      .set(auth(adminToken))
      .expect(200);
    const priya = directory.body.find(
      (u: any) => u.email === 'priya@example.com',
    );

    await request(app.getHttpServer())
      .post('/api/allocations')
      .set(auth(managerToken))
      .send({ assetId: asset.id, holderUserId: priya.id })
      .expect(201);

    const notifications = await request(app.getHttpServer())
      .get('/api/notifications')
      .set(auth(employeeToken))
      .expect(200);

    expect(notifications.body.items[0].type).toBe('ASSET_ASSIGNED');
    expect(notifications.body.unreadCount).toBeGreaterThan(0);
  });

  it('only lets a user mark their own notifications as read', async () => {
    const asset = await createAsset(app, {
      name: 'Laptop',
      assetTag: 'AF-0002',
      categoryId: fixtures.electronics.id,
    });
    const directory = await request(app.getHttpServer())
      .get('/api/org/employees/directory')
      .set(auth(adminToken))
      .expect(200);
    const priya = directory.body.find(
      (u: any) => u.email === 'priya@example.com',
    );

    await request(app.getHttpServer())
      .post('/api/allocations')
      .set(auth(managerToken))
      .send({ assetId: asset.id, holderUserId: priya.id })
      .expect(201);

    const notifications = await request(app.getHttpServer())
      .get('/api/notifications')
      .set(auth(employeeToken))
      .expect(200);
    const notificationId = notifications.body.items[0].id;

    // Marking someone else's notification must not change it.
    await request(app.getHttpServer())
      .patch(`/api/notifications/${notificationId}/read`)
      .set(auth(adminToken))
      .expect(200);

    const stillUnread = await request(app.getHttpServer())
      .get('/api/notifications?unread=true')
      .set(auth(employeeToken))
      .expect(200);
    expect(stillUnread.body.items.length).toBe(1);
    expect(stillUnread.body.unreadCount).toBe(1);

    await request(app.getHttpServer())
      .patch(`/api/notifications/${notificationId}/read`)
      .set(auth(employeeToken))
      .expect(200);

    const read = await request(app.getHttpServer())
      .get('/api/notifications?unread=true')
      .set(auth(employeeToken))
      .expect(200);
    expect(read.body.items.length).toBe(0);
    expect(read.body.unreadCount).toBe(0);
  });

  it('marks every notification as read at once', async () => {
    const asset = await createAsset(app, {
      name: 'Laptop',
      assetTag: 'AF-0003',
      categoryId: fixtures.electronics.id,
    });
    const directory = await request(app.getHttpServer())
      .get('/api/org/employees/directory')
      .set(auth(adminToken))
      .expect(200);
    const priya = directory.body.find(
      (u: any) => u.email === 'priya@example.com',
    );

    await request(app.getHttpServer())
      .post('/api/allocations')
      .set(auth(managerToken))
      .send({ assetId: asset.id, holderUserId: priya.id })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/notifications/read-all')
      .set(auth(employeeToken))
      .expect(201);

    const unread = await request(app.getHttpServer())
      .get('/api/notifications?unread=true')
      .set(auth(employeeToken))
      .expect(200);
    expect(unread.body.items.length).toBe(0);
    expect(unread.body.unreadCount).toBe(0);
  });

  it('restricts the overdue reminder to managers', async () => {
    const asset = await createAsset(app, {
      name: 'Laptop',
      assetTag: 'AF-0004',
      categoryId: fixtures.electronics.id,
    });
    const directory = await request(app.getHttpServer())
      .get('/api/org/employees/directory')
      .set(auth(adminToken))
      .expect(200);
    const priya = directory.body.find(
      (u: any) => u.email === 'priya@example.com',
    );

    const allocation = await request(app.getHttpServer())
      .post('/api/allocations')
      .set(auth(managerToken))
      .send({
        assetId: asset.id,
        holderUserId: priya.id,
        expectedReturnDate: new Date(Date.now() - 86400000).toISOString(),
      })
      .expect(201);

    // An employee may not ping.
    await request(app.getHttpServer())
      .post('/api/notifications/ping')
      .set(auth(employeeToken))
      .send({ allocationId: allocation.body.id })
      .expect(403);

    // A manager may.
    await request(app.getHttpServer())
      .post('/api/notifications/ping')
      .set(auth(managerToken))
      .send({ allocationId: allocation.body.id })
      .expect(200);
  });

  it('rejects a ping without an allocation id', async () => {
    await request(app.getHttpServer())
      .post('/api/notifications/ping')
      .set(auth(managerToken))
      .send({})
      .expect(400);
  });

  it('records an immutable activity trail', async () => {
    const asset = await createAsset(app, {
      name: 'Laptop',
      assetTag: 'AF-0005',
      categoryId: fixtures.electronics.id,
    });

    await request(app.getHttpServer())
      .post('/api/assets')
      .set(auth(adminToken))
      .send({ name: 'ThinkPad', categoryId: fixtures.electronics.id })
      .expect(201);

    const activity = await request(app.getHttpServer())
      .get('/api/activity?take=10')
      .set(auth(adminToken))
      .expect(200);

    expect(activity.body.total).toBeGreaterThan(0);
    expect(activity.body.items[0].action).toBe('asset.registered');
    expect(asset.id).toBeTruthy();
  });

  it('rejects an invalid pagination parameter', async () => {
    await request(app.getHttpServer())
      .get('/api/activity?take=abc')
      .set(auth(adminToken))
      .expect(400);
  });
});
