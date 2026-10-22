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

describe('Reports & Analytics (e2e)', () => {
  let app: INestApplication;
  let fixtures: Fixtures;
  let adminToken: string;
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
    employeeToken = (
      await createUserWithToken(app, {
        name: 'Priya',
        email: 'priya@example.com',
        departmentId: fixtures.it.id,
      })
    ).token;
  });

  it('returns the dashboard KPIs', async () => {
    await createAsset(app, {
      name: 'Laptop',
      assetTag: 'AF-0001',
      categoryId: fixtures.electronics.id,
    });

    const res = await request(app.getHttpServer())
      .get('/api/reports/dashboard')
      .set(auth(employeeToken))
      .expect(200);

    expect(res.body.assetsAvailable).toBe(1);
    expect(res.body.assetsAllocated).toBe(0);
    expect(res.body.overdueReturns).toBe(0);
    expect(Array.isArray(res.body.overdueList)).toBe(true);
  });

  it('counts overdue allocations', async () => {
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
      .set(auth(adminToken))
      .send({
        assetId: asset.id,
        holderUserId: priya.id,
        expectedReturnDate: new Date(Date.now() - 86400000).toISOString(),
      })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/api/reports/dashboard')
      .set(auth(adminToken))
      .expect(200);
    expect(res.body.overdueReturns).toBe(1);

    const overdue = await request(app.getHttpServer())
      .get('/api/allocations/overdue')
      .set(auth(adminToken))
      .expect(200);
    expect(overdue.body.total).toBe(1);
  });

  it('returns the employee KPIs', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/reports/dashboard/employee/kpis')
      .set(auth(employeeToken))
      .expect(200);

    expect(res.body).toHaveProperty('myAllocations');
    expect(res.body).toHaveProperty('myActiveBookings');
  });

  it('builds the analytics payload', async () => {
    await createAsset(app, {
      name: 'Laptop',
      assetTag: 'AF-0003',
      categoryId: fixtures.electronics.id,
    });

    const res = await request(app.getHttpServer())
      .get('/api/reports/analytics')
      .set(auth(adminToken))
      .expect(200);

    expect(res.body.kpis.totalAssets).toBe(1);
    expect(Array.isArray(res.body.utilizationTrend)).toBe(true);
    expect(Array.isArray(res.body.assetStatus)).toBe(true);
  });

  it('exports the asset list as CSV', async () => {
    await createAsset(app, {
      name: 'Laptop, 14"',
      assetTag: 'AF-0004',
      categoryId: fixtures.electronics.id,
      location: 'HQ-1F',
    });

    const res = await request(app.getHttpServer())
      .get('/api/reports/export/assets.csv')
      .set(auth(adminToken))
      .expect(200);

    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toContain('assetTag');
    // The comma inside the name has to be quoted.
    expect(res.text).toContain('"Laptop, 14"""');
  });

  it('neutralises CSV formula injection', async () => {
    await createAsset(app, {
      name: '=cmd|calc',
      assetTag: 'AF-0005',
      categoryId: fixtures.electronics.id,
    });

    const res = await request(app.getHttpServer())
      .get('/api/reports/export/assets.csv')
      .set(auth(adminToken))
      .expect(200);

    expect(res.text).not.toMatch(/,=cmd\|calc/);
    expect(res.text).toContain("'=cmd|calc");
  });

  it('keeps the analytics endpoints away from employees', async () => {
    await request(app.getHttpServer())
      .get('/api/reports/analytics')
      .set(auth(employeeToken))
      .expect(403);

    await request(app.getHttpServer())
      .get('/api/reports/export/assets.csv')
      .set(auth(employeeToken))
      .expect(403);
  });

  it('groups the maintenance frequency by asset', async () => {
    const asset = await createAsset(app, {
      name: 'Laptop',
      assetTag: 'AF-0006',
      categoryId: fixtures.electronics.id,
    });

    await request(app.getHttpServer())
      .post('/api/maintenance')
      .set(auth(employeeToken))
      .send({ assetId: asset.id, description: 'Bent' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/api/reports/maintenance-frequency')
      .set(auth(adminToken))
      .expect(200);

    expect(res.body.byAsset.length).toBe(1);
    expect(res.body.byAsset[0].assetId).toBe(asset.id);
  });
});
