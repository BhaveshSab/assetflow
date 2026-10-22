/**
 * Row-level scoping + asset/allocation consistency.
 *
 * These tests lock in the rules that keep one department from seeing (or
 * corrupting) another department's data.
 */
import { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';

import {
  Fixtures,
  auth,
  createAsset,
  createTestApp,
  createUserWithToken,
  login,
  resetDatabase,
  seedFixtures,
} from './utils/test-app';

describe('Scoping & consistency (e2e)', () => {
  let app: INestApplication;
  let fixtures: Fixtures;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app);
    fixtures = await seedFixtures(app);
  });

  // -------------------------------------------------------------------------
  // Reports dashboard
  // -------------------------------------------------------------------------

  it('only counts the caller’s own overdue allocations on the dashboard', async () => {
    const { user: employee, token: employeeToken } = await createUserWithToken(
      app,
      { name: 'Ada', email: 'ada@example.com', role: Role.EMPLOYEE },
    );
    const { user: other } = await createUserWithToken(app, {
      name: 'Bob',
      email: 'bob@example.com',
      role: Role.EMPLOYEE,
    });
    const { token: adminToken } = await createUserWithToken(app, {
      name: 'Root',
      email: 'admin@example.com',
      role: Role.ADMIN,
    });

    const mine = await createAsset(app, {
      name: 'Laptop',
      categoryId: fixtures.electronics.id,
    });
    const theirs = await createAsset(app, {
      name: 'Projector',
      categoryId: fixtures.electronics.id,
    });

    const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    await request(app.getHttpServer())
      .post('/api/allocations')
      .set(auth(adminToken))
      .send({
        assetId: mine.id,
        holderUserId: employee.id,
        expectedReturnDate: past,
      })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/allocations')
      .set(auth(adminToken))
      .send({
        assetId: theirs.id,
        holderUserId: other.id,
        expectedReturnDate: past,
      })
      .expect(201);

    const employeeDash = await request(app.getHttpServer())
      .get('/api/reports/dashboard')
      .set(auth(employeeToken))
      .expect(200);
    expect(employeeDash.body.overdueReturns).toBe(1);
    expect(employeeDash.body.overdueList).toHaveLength(1);
    expect(employeeDash.body.overdueList[0].holderUser.email).toBe(
      'ada@example.com',
    );

    const adminDash = await request(app.getHttpServer())
      .get('/api/reports/dashboard')
      .set(auth(adminToken))
      .expect(200);
    expect(adminDash.body.overdueReturns).toBe(2);
    expect(adminDash.body.overdueList).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Bookings
  // -------------------------------------------------------------------------

  it('hides another user’s booking behind a 404', async () => {
    const { user: owner } = await createUserWithToken(app, {
      name: 'Owner',
      email: 'owner@example.com',
      role: Role.EMPLOYEE,
    });
    const { token: otherToken } = await createUserWithToken(app, {
      name: 'Other',
      email: 'other@example.com',
      role: Role.EMPLOYEE,
    });
    const { token: adminToken } = await createUserWithToken(app, {
      name: 'Root',
      email: 'admin@example.com',
      role: Role.ADMIN,
    });

    const room = await createAsset(app, {
      name: 'Meeting room',
      categoryId: fixtures.furniture.id,
      isBookable: true,
    });

    const created = await request(app.getHttpServer())
      .post('/api/bookings')
      .set(auth(await login(app, 'owner@example.com')))
      .send({
        assetId: room.id,
        startTime: new Date(Date.now() + 86400000).toISOString(),
        endTime: new Date(Date.now() + 90000000).toISOString(),
      })
      .expect(201);

    await request(app.getHttpServer())
      .get(`/api/bookings/${created.body.id}`)
      .set(auth(otherToken))
      .expect(404);

    // …but the owner and a manager can read it.
    await request(app.getHttpServer())
      .get(`/api/bookings/${created.body.id}`)
      .set(auth(await login(app, 'owner@example.com')))
      .expect(200);
    await request(app.getHttpServer())
      .get(`/api/bookings/${created.body.id}`)
      .set(auth(adminToken))
      .expect(200);
    expect(owner.id).toBeTruthy();
  });

  it('lets a department head see their own department’s booking only', async () => {
    const { token: headToken } = await createUserWithToken(app, {
      name: 'Head',
      email: 'head@example.com',
      role: Role.DEPARTMENT_HEAD,
      departmentId: fixtures.it.id,
    });
    const { token: otherToken } = await createUserWithToken(app, {
      name: 'Other',
      email: 'other@example.com',
      role: Role.EMPLOYEE,
    });

    const room = await createAsset(app, {
      name: 'Meeting room',
      categoryId: fixtures.furniture.id,
      isBookable: true,
    });

    const created = await request(app.getHttpServer())
      .post('/api/bookings')
      .set(auth(otherToken))
      .send({
        assetId: room.id,
        startTime: new Date(Date.now() + 86400000).toISOString(),
        endTime: new Date(Date.now() + 90000000).toISOString(),
      })
      .expect(201);

    // The booker is not in the IT department → hidden from its head.
    await request(app.getHttpServer())
      .get(`/api/bookings/${created.body.id}`)
      .set(auth(headToken))
      .expect(404);
  });

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  it('lists only the caller’s own maintenance requests for an employee', async () => {
    const { token: employeeToken } = await createUserWithToken(app, {
      name: 'Ada',
      email: 'ada@example.com',
      role: Role.EMPLOYEE,
    });
    const { token: otherToken } = await createUserWithToken(app, {
      name: 'Bob',
      email: 'bob@example.com',
      role: Role.EMPLOYEE,
    });
    const { token: adminToken } = await createUserWithToken(app, {
      name: 'Root',
      email: 'admin@example.com',
      role: Role.ADMIN,
    });

    const asset = await createAsset(app, {
      name: 'Laptop',
      categoryId: fixtures.electronics.id,
    });

    await request(app.getHttpServer())
      .post('/api/maintenance')
      .set(auth(employeeToken))
      .send({ assetId: asset.id, description: 'Screen flickers' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/maintenance')
      .set(auth(otherToken))
      .send({ assetId: asset.id, description: 'Keyboard broken' })
      .expect(201);

    const mine = await request(app.getHttpServer())
      .get('/api/maintenance')
      .set(auth(employeeToken))
      .expect(200);
    expect(mine.body.total).toBe(1);
    expect(mine.body.items[0].description).toBe('Screen flickers');

    const all = await request(app.getHttpServer())
      .get('/api/maintenance')
      .set(auth(adminToken))
      .expect(200);
    expect(all.body.total).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Asset status vs. allocation
  // -------------------------------------------------------------------------

  it('refuses to hand-set AVAILABLE while the asset is still allocated', async () => {
    const { user: employee } = await createUserWithToken(app, {
      name: 'Ada',
      email: 'ada@example.com',
      role: Role.EMPLOYEE,
    });
    const { token: adminToken } = await createUserWithToken(app, {
      name: 'Root',
      email: 'admin@example.com',
      role: Role.ADMIN,
    });

    const asset = await createAsset(app, {
      name: 'Laptop',
      categoryId: fixtures.electronics.id,
    });

    await request(app.getHttpServer())
      .post('/api/allocations')
      .set(auth(adminToken))
      .send({ assetId: asset.id, holderUserId: employee.id })
      .expect(201);

    const res = await request(app.getHttpServer())
      .patch(`/api/assets/${asset.id}`)
      .set(auth(adminToken))
      .send({ status: 'AVAILABLE' })
      .expect(400);
    expect(String(res.body.message)).toMatch(/allocated/i);
  });

  it('keeps an asset UNDER_MAINTENANCE when it is returned', async () => {
    const { user: employee } = await createUserWithToken(app, {
      name: 'Ada',
      email: 'ada@example.com',
      role: Role.EMPLOYEE,
    });
    const { token: adminToken } = await createUserWithToken(app, {
      name: 'Root',
      email: 'admin@example.com',
      role: Role.ADMIN,
    });

    const asset = await createAsset(app, {
      name: 'Laptop',
      categoryId: fixtures.electronics.id,
    });

    const allocation = await request(app.getHttpServer())
      .post('/api/allocations')
      .set(auth(adminToken))
      .send({ assetId: asset.id, holderUserId: employee.id })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/maintenance')
      .set(auth(adminToken))
      .send({ assetId: asset.id, description: 'Fan noise' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/api/allocations/${allocation.body.id}/return`)
      .set(auth(adminToken))
      .send({})
      .expect(200);

    const after = await request(app.getHttpServer())
      .get(`/api/assets/${asset.id}`)
      .set(auth(adminToken))
      .expect(200);
    expect(after.body.status).toBe('UNDER_MAINTENANCE');
  });

  // -------------------------------------------------------------------------
  // JSON columns
  // -------------------------------------------------------------------------

  it('rejects malformed documents / custom field values', async () => {
    const { token: adminToken } = await createUserWithToken(app, {
      name: 'Root',
      email: 'admin@example.com',
      role: Role.ADMIN,
    });

    await request(app.getHttpServer())
      .post('/api/assets')
      .set(auth(adminToken))
      .send({
        name: 'Laptop',
        categoryId: fixtures.electronics.id,
        documents: [{ name: 'invoice', url: 'javascript:alert(1)' }],
      })
      .expect(400);

    await request(app.getHttpServer())
      .post('/api/assets')
      .set(auth(adminToken))
      .send({
        name: 'Laptop',
        categoryId: fixtures.electronics.id,
        customFieldValues: { ram: { nested: true } },
      })
      .expect(400);

    // A well-formed document list is accepted.
    await request(app.getHttpServer())
      .post('/api/assets')
      .set(auth(adminToken))
      .send({
        name: 'Laptop',
        categoryId: fixtures.electronics.id,
        documents: [
          { name: 'invoice', url: 'https://example.com/invoice.pdf' },
        ],
        customFieldValues: { ram: '16GB', cores: 8 },
      })
      .expect(201);
  });
});
