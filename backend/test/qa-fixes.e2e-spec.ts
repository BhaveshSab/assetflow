/**
 * Regression tests for the four defects the role-by-role QA pass found
 * (QA_REPORT.md). Each test fails on the previous commit and passes after the
 * fix, so none of them can come back silently.
 *
 *  1. /reports/dashboard leaked organisation-wide counters to an employee.
 *  2. A DEPARTMENT_HEAD could read another department's employee by id.
 *  3. AUDIT_DISCREPANCY notifications were never produced.
 *  4. BOOKING_REMINDER / OVERDUE_RETURN were never produced.
 */
import { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';

import { NotificationsService } from '../src/notifications/notifications.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  auth,
  createAsset,
  createTestApp,
  createUserWithToken,
  resetDatabase,
  seedFixtures,
} from './utils/test-app';
import type { Fixtures } from './utils/test-app';

describe('QA regressions — scoping and notification producers', () => {
  let app: INestApplication<App>;
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

  it('keeps the dashboard operational counters scoped for an employee', async () => {
    const { user: employee, token: employeeToken } = await createUserWithToken(
      app,
      {
        name: 'Ada',
        email: 'ada@example.com',
        role: Role.EMPLOYEE,
        departmentId: fixtures.it.id,
      },
    );
    const { user: other } = await createUserWithToken(app, {
      name: 'Bob',
      email: 'bob@example.com',
      role: Role.EMPLOYEE,
      departmentId: fixtures.it.id,
    });
    const { token: adminToken } = await createUserWithToken(app, {
      name: 'Root',
      email: 'root@example.com',
      role: Role.ADMIN,
    });

    const mine = await createAsset(app, {
      name: 'My Laptop',
      categoryId: fixtures.electronics.id,
    });
    const theirs = await createAsset(app, {
      name: 'Their Laptop',
      categoryId: fixtures.electronics.id,
    });

    for (const [assetId, holderUserId] of [
      [mine.id, employee.id],
      [theirs.id, other.id],
    ]) {
      await request(app.getHttpServer())
        .post('/api/allocations')
        .set(auth(adminToken))
        .send({ assetId, holderUserId })
        .expect(201);
    }

    const employeeDash = await request(app.getHttpServer())
      .get('/api/reports/dashboard')
      .set(auth(employeeToken))
      .expect(200);
    const adminDash = await request(app.getHttpServer())
      .get('/api/reports/dashboard')
      .set(auth(adminToken))
      .expect(200);

    // The employee holds one of the two allocated assets.
    expect(employeeDash.body.assetsAllocated).toBe(1);
    expect(adminDash.body.assetsAllocated).toBe(2);
    expect(employeeDash.body.assetsAllocated).not.toBe(
      adminDash.body.assetsAllocated,
    );
  });

  it('scopes the transfer queue for an employee', async () => {
    const { token: employeeToken } = await createUserWithToken(app, {
      name: 'Ada',
      email: 'ada@example.com',
      role: Role.EMPLOYEE,
      departmentId: fixtures.it.id,
    });
    const { user: other } = await createUserWithToken(app, {
      name: 'Bob',
      email: 'bob@example.com',
      role: Role.EMPLOYEE,
      departmentId: fixtures.it.id,
    });
    const { token: adminToken } = await createUserWithToken(app, {
      name: 'Root',
      email: 'root@example.com',
      role: Role.ADMIN,
    });

    const asset = await createAsset(app, {
      name: 'Projector',
      categoryId: fixtures.electronics.id,
    });
    await request(app.getHttpServer())
      .post('/api/allocations')
      .set(auth(adminToken))
      .send({ assetId: asset.id, holderUserId: other.id })
      .expect(201);

    // Somebody else's transfer request.
    await request(app.getHttpServer())
      .post('/api/transfers')
      .set(auth(adminToken))
      .send({ assetId: asset.id, toUserId: other.id })
      .expect(201);

    const dash = await request(app.getHttpServer())
      .get('/api/reports/dashboard')
      .set(auth(employeeToken))
      .expect(200);

    expect(dash.body.pendingTransfers).toBe(0);
  });

  it('refuses a department head reading another department’s employee by id', async () => {
    const { user: head, token: headToken } = await createUserWithToken(app, {
      name: 'Hana',
      email: 'hana@example.com',
      role: Role.DEPARTMENT_HEAD,
      departmentId: fixtures.it.id,
    });
    const { user: outsider } = await createUserWithToken(app, {
      name: 'Raj',
      email: 'raj@example.com',
      role: Role.EMPLOYEE,
      departmentId: fixtures.facilities.id,
    });

    await request(app.getHttpServer())
      .get(`/api/org/employees/${head.id}`)
      .set(auth(headToken))
      .expect(200);

    await request(app.getHttpServer())
      .get(`/api/org/employees/${outsider.id}`)
      .set(auth(headToken))
      .expect(403);

    // The list cannot be used to walk around the detail route either.
    const list = await request(app.getHttpServer())
      .get('/api/org/employees')
      .set(auth(headToken))
      .expect(200);
    expect(
      list.body.items.every(
        (u: { departmentId: string | null }) =>
          u.departmentId === fixtures.it.id,
      ),
    ).toBe(true);
  });

  it('raises an AUDIT_DISCREPANCY when an auditor marks an item MISSING', async () => {
    const { token: adminToken } = await createUserWithToken(app, {
      name: 'Root',
      email: 'root@example.com',
      role: Role.ADMIN,
    });
    const { user: auditor, token: auditorToken } = await createUserWithToken(
      app,
      {
        name: 'Ada',
        email: 'ada@example.com',
        role: Role.EMPLOYEE,
        departmentId: fixtures.it.id,
      },
    );

    const prisma = app.get(PrismaService);
    // A cycle is scoped by location, so seed the asset at the scoped location.
    await createAsset(app, {
      name: 'Audited Laptop',
      categoryId: fixtures.electronics.id,
      location: 'HQ-3F',
    });

    const cycle = await request(app.getHttpServer())
      .post('/api/audits')
      .set(auth(adminToken))
      .send({
        name: 'QA discrepancy cycle',
        scopeLocation: 'HQ-3F',
        startDate: new Date().toISOString(),
        endDate: new Date(Date.now() + 86_400_000).toISOString(),
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/api/audits/${cycle.body.id}/auditors`)
      .set(auth(adminToken))
      .send({ auditorIds: [auditor.id] })
      .expect(201);

    const item = await prisma.auditItem.findFirst({
      where: { auditCycleId: cycle.body.id },
    });
    if (!item) throw new Error('the cycle has no audit items to mark');

    await request(app.getHttpServer())
      .patch(`/api/audits/${cycle.body.id}/items/${item.id}`)
      .set(auth(auditorToken))
      .send({ result: 'MISSING', notes: 'not on the shelf' })
      .expect(200);

    const notes = await request(app.getHttpServer())
      .get('/api/notifications')
      .set(auth(adminToken))
      .expect(200);

    const discrepancy = notes.body.items.find(
      (n: { type: string }) => n.type === 'AUDIT_DISCREPANCY',
    );
    expect(discrepancy).toBeDefined();
    expect(discrepancy.message).toContain('MISSING');
  });

  it('reminds about an upcoming booking exactly once', async () => {
    const { user: employee, token: employeeToken } = await createUserWithToken(
      app,
      {
        name: 'Ada',
        email: 'ada@example.com',
        role: Role.EMPLOYEE,
        departmentId: fixtures.it.id,
      },
    );
    const room = await createAsset(app, {
      name: 'Meeting Room B2',
      categoryId: fixtures.furniture.id,
      isBookable: true,
    });

    await request(app.getHttpServer())
      .post('/api/bookings')
      .set(auth(employeeToken))
      .send({
        assetId: room.id,
        startTime: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        endTime: new Date(Date.now() + 70 * 60 * 1000).toISOString(),
      })
      .expect(201);

    const notifications = app.get(NotificationsService);
    const first = await notifications.sweepReminders();
    expect(first.bookingReminders).toBe(1);

    const second = await notifications.sweepReminders();
    expect(second.bookingReminders).toBe(0);

    const mine = await request(app.getHttpServer())
      .get('/api/notifications')
      .set(auth(employeeToken))
      .expect(200);
    expect(
      mine.body.items.filter(
        (n: { type: string }) => n.type === 'BOOKING_REMINDER',
      ),
    ).toHaveLength(1);
    expect(employee.id).toBeTruthy();
  });

  it('alerts the holder of an overdue allocation exactly once', async () => {
    const { token: adminToken } = await createUserWithToken(app, {
      name: 'Root',
      email: 'root@example.com',
      role: Role.ADMIN,
    });
    const { user: employee, token: employeeToken } = await createUserWithToken(
      app,
      {
        name: 'Ada',
        email: 'ada@example.com',
        role: Role.EMPLOYEE,
        departmentId: fixtures.it.id,
      },
    );
    const asset = await createAsset(app, {
      name: 'Overdue Laptop',
      categoryId: fixtures.electronics.id,
    });

    await request(app.getHttpServer())
      .post('/api/allocations')
      .set(auth(adminToken))
      .send({
        assetId: asset.id,
        holderUserId: employee.id,
        expectedReturnDate: new Date(
          Date.now() - 3 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      })
      .expect(201);

    const notifications = app.get(NotificationsService);
    const first = await notifications.sweepReminders();
    expect(first.overdueAlerts).toBe(1);

    const second = await notifications.sweepReminders();
    expect(second.overdueAlerts).toBe(0);

    const mine = await request(app.getHttpServer())
      .get('/api/notifications')
      .set(auth(employeeToken))
      .expect(200);
    expect(
      mine.body.items.filter(
        (n: { type: string }) => n.type === 'OVERDUE_RETURN',
      ),
    ).toHaveLength(1);

    // Sanity: the sweep did not touch the allocation itself.
    const prisma = app.get(PrismaService);
    const allocation = await prisma.allocation.findFirst({
      where: { assetId: asset.id },
    });
    expect(allocation?.status).toBe('ACTIVE');
  });

  it('refuses a second pending transfer for the same asset', async () => {
    const { token: adminToken } = await createUserWithToken(app, {
      name: 'Root',
      email: 'root@example.com',
      role: Role.ADMIN,
    });
    const { user: holder } = await createUserWithToken(app, {
      name: 'Ada',
      email: 'ada@example.com',
      role: Role.EMPLOYEE,
    });
    const { user: target } = await createUserWithToken(app, {
      name: 'Bob',
      email: 'bob@example.com',
      role: Role.EMPLOYEE,
    });
    const asset = await createAsset(app, {
      name: 'Shared Laptop',
      categoryId: fixtures.electronics.id,
    });

    await request(app.getHttpServer())
      .post('/api/allocations')
      .set(auth(adminToken))
      .send({ assetId: asset.id, holderUserId: holder.id })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/transfers')
      .set(auth(adminToken))
      .send({ assetId: asset.id, toUserId: target.id, reason: 'first' })
      .expect(201);

    const duplicate = await request(app.getHttpServer())
      .post('/api/transfers')
      .set(auth(adminToken))
      .send({ assetId: asset.id, toUserId: target.id, reason: 'second' })
      .expect(409);
    expect(duplicate.body.message).toContain('already pending approval');

    const prisma = app.get(PrismaService);
    expect(
      await prisma.transferRequest.count({ where: { assetId: asset.id } }),
    ).toBe(1);
  });
});
