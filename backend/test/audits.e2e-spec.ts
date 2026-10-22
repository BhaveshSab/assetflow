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

describe('Audits (e2e)', () => {
  let app: INestApplication;
  let fixtures: Fixtures;
  let adminToken: string;
  let auditorToken: string;
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
    auditorToken = (
      await createUserWithToken(app, {
        name: 'Hana Auditor',
        email: 'auditor@example.com',
        departmentId: fixtures.it.id,
      })
    ).token;
    employeeToken = (
      await createUserWithToken(app, {
        name: 'Priya',
        email: 'priya@example.com',
      })
    ).token;
  });

  async function createCycle(scopeLocation?: string) {
    return request(app.getHttpServer())
      .post('/api/audits')
      .set(auth(adminToken))
      .send({
        name: 'Q3 audit',
        scopeLocation,
        startDate: new Date().toISOString(),
        endDate: new Date(Date.now() + 7 * 86400000).toISOString(),
      })
      .expect(201);
  }

  it('creates a cycle and auto-generates items for the in-scope assets', async () => {
    await createAsset(app, {
      name: 'Laptop',
      assetTag: 'AF-0001',
      categoryId: fixtures.electronics.id,
      location: 'HQ-1F',
    });
    await createAsset(app, {
      name: 'Chair',
      assetTag: 'AF-0002',
      categoryId: fixtures.furniture.id,
      location: 'HQ-2F',
    });

    const cycle = await createCycle('HQ-1F');
    expect(cycle.body.itemCount).toBe(1);
    expect(cycle.body.status).toBe('OPEN');

    const items = await request(app.getHttpServer())
      .get(`/api/audits/${cycle.body.id}/items`)
      .set(auth(adminToken))
      .expect(200);
    expect(items.body.total).toBe(1);
    expect(items.body.items[0].result).toBe('PENDING');
  });

  it('is admin-only to create a cycle', async () => {
    await request(app.getHttpServer())
      .post('/api/audits')
      .set(auth(employeeToken))
      .send({
        name: 'Sneaky audit',
        startDate: new Date().toISOString(),
        endDate: new Date().toISOString(),
      })
      .expect(403);
  });

  it('lets an assigned auditor mark items', async () => {
    await createAsset(app, {
      name: 'Laptop',
      assetTag: 'AF-0003',
      categoryId: fixtures.electronics.id,
    });
    const cycle = await createCycle();

    const directory = await request(app.getHttpServer())
      .get('/api/org/employees/directory')
      .set(auth(adminToken))
      .expect(200);
    const auditor = directory.body.find(
      (u: any) => u.email === 'auditor@example.com',
    );

    await request(app.getHttpServer())
      .post(`/api/audits/${cycle.body.id}/auditors`)
      .set(auth(adminToken))
      .send({ auditorIds: [auditor.id] })
      .expect(201);

    const items = await request(app.getHttpServer())
      .get(`/api/audits/${cycle.body.id}/items`)
      .set(auth(auditorToken))
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/api/audits/${cycle.body.id}/items/${items.body.items[0].id}`)
      .set(auth(auditorToken))
      .send({ result: 'VERIFIED', notes: 'Looks fine' })
      .expect(200);
  });

  it('keeps a non-assigned employee out of the items', async () => {
    await createAsset(app, {
      name: 'Laptop',
      assetTag: 'AF-0004',
      categoryId: fixtures.electronics.id,
    });
    const cycle = await createCycle();

    await request(app.getHttpServer())
      .get(`/api/audits/${cycle.body.id}/items`)
      .set(auth(employeeToken))
      .expect(403);
  });

  it('rejects a PENDING mark', async () => {
    await createAsset(app, {
      name: 'Laptop',
      assetTag: 'AF-0005',
      categoryId: fixtures.electronics.id,
    });
    const cycle = await createCycle();
    const items = await request(app.getHttpServer())
      .get(`/api/audits/${cycle.body.id}/items`)
      .set(auth(adminToken))
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/api/audits/${cycle.body.id}/items/${items.body.items[0].id}`)
      .set(auth(adminToken))
      .send({ result: 'PENDING' })
      .expect(400);
  });

  it('marks MISSING assets LOST and DAMAGED assets DAMAGED on close', async () => {
    const missing = await createAsset(app, {
      name: 'Laptop',
      assetTag: 'AF-0006',
      categoryId: fixtures.electronics.id,
    });
    const damaged = await createAsset(app, {
      name: 'Chair',
      assetTag: 'AF-0007',
      categoryId: fixtures.furniture.id,
    });
    const cycle = await createCycle();

    const items = await request(app.getHttpServer())
      .get(`/api/audits/${cycle.body.id}/items`)
      .set(auth(adminToken))
      .expect(200);

    const missingItem = items.body.items.find(
      (i: any) => i.assetId === missing.id,
    );
    const damagedItem = items.body.items.find(
      (i: any) => i.assetId === damaged.id,
    );

    await request(app.getHttpServer())
      .patch(`/api/audits/${cycle.body.id}/items/${missingItem.id}`)
      .set(auth(adminToken))
      .send({ result: 'MISSING' })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/api/audits/${cycle.body.id}/items/${damagedItem.id}`)
      .set(auth(adminToken))
      .send({ result: 'DAMAGED' })
      .expect(200);

    const discrepancies = await request(app.getHttpServer())
      .get(`/api/audits/${cycle.body.id}/discrepancies`)
      .set(auth(adminToken))
      .expect(200);
    expect(discrepancies.body.total).toBe(2);

    await request(app.getHttpServer())
      .post(`/api/audits/${cycle.body.id}/close`)
      .set(auth(adminToken))
      .expect(200);

    const missingAfter = await request(app.getHttpServer())
      .get(`/api/assets/${missing.id}`)
      .set(auth(adminToken))
      .expect(200);
    expect(missingAfter.body.status).toBe('LOST');

    const damagedAfter = await request(app.getHttpServer())
      .get(`/api/assets/${damaged.id}`)
      .set(auth(adminToken))
      .expect(200);
    expect(damagedAfter.body.condition).toBe('DAMAGED');
  });

  it('refuses to mark a closed cycle', async () => {
    await createAsset(app, {
      name: 'Laptop',
      assetTag: 'AF-0008',
      categoryId: fixtures.electronics.id,
    });
    const cycle = await createCycle();
    const items = await request(app.getHttpServer())
      .get(`/api/audits/${cycle.body.id}/items`)
      .set(auth(adminToken))
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/audits/${cycle.body.id}/close`)
      .set(auth(adminToken))
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/api/audits/${cycle.body.id}/items/${items.body.items[0].id}`)
      .set(auth(adminToken))
      .send({ result: 'VERIFIED' })
      .expect(409);
  });

  it('rejects an invalid status filter', async () => {
    await request(app.getHttpServer())
      .get('/api/audits?status=NOPE')
      .set(auth(adminToken))
      .expect(400);
  });
});
