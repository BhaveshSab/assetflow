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

describe('Maintenance (e2e)', () => {
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

  async function raiseRequest(
    assetTag = 'AF-0001',
    description = 'Screen flickers',
  ) {
    const asset = await createAsset(app, {
      name: 'Laptop',
      assetTag,
      categoryId: fixtures.electronics.id,
    });
    const res = await request(app.getHttpServer())
      .post('/api/maintenance')
      .set(auth(employeeToken))
      .send({ assetId: asset.id, description, priority: 'HIGH' })
      .expect(201);
    return { asset, request: res.body };
  }

  it('runs the full workflow', async () => {
    const { asset, request: req } = await raiseRequest();

    const approved = await request(app.getHttpServer())
      .post(`/api/maintenance/${req.id}/approve`)
      .set(auth(adminToken))
      .expect(200);
    expect(approved.body.status).toBe('APPROVED');

    const during = await request(app.getHttpServer())
      .get(`/api/assets/${asset.id}`)
      .set(auth(adminToken))
      .expect(200);
    expect(during.body.status).toBe('UNDER_MAINTENANCE');

    await request(app.getHttpServer())
      .post(`/api/maintenance/${req.id}/assign`)
      .set(auth(adminToken))
      .send({ technicianName: 'Ravi from IT' })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/maintenance/${req.id}/start`)
      .set(auth(adminToken))
      .expect(200);

    const resolved = await request(app.getHttpServer())
      .post(`/api/maintenance/${req.id}/resolve`)
      .set(auth(adminToken))
      .send({ resolutionNotes: 'Replaced the panel' })
      .expect(200);
    expect(resolved.body.status).toBe('RESOLVED');

    const after = await request(app.getHttpServer())
      .get(`/api/assets/${asset.id}`)
      .set(auth(adminToken))
      .expect(200);
    expect(after.body.status).toBe('AVAILABLE');
  });

  it('rejects an invalid state jump (409)', async () => {
    const { request: req } = await raiseRequest('AF-0002');

    // Cannot "start" a PENDING request.
    await request(app.getHttpServer())
      .post(`/api/maintenance/${req.id}/start`)
      .set(auth(adminToken))
      .expect(409);

    // Cannot "resolve" a PENDING request either.
    await request(app.getHttpServer())
      .post(`/api/maintenance/${req.id}/resolve`)
      .set(auth(adminToken))
      .send({})
      .expect(409);
  });

  it('rejects approving twice', async () => {
    const { request: req } = await raiseRequest('AF-0003');

    await request(app.getHttpServer())
      .post(`/api/maintenance/${req.id}/approve`)
      .set(auth(adminToken))
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/maintenance/${req.id}/approve`)
      .set(auth(adminToken))
      .expect(409);
  });

  it('keeps employee-only users away from the approval buttons', async () => {
    const { request: req } = await raiseRequest('AF-0004');

    await request(app.getHttpServer())
      .post(`/api/maintenance/${req.id}/approve`)
      .set(auth(employeeToken))
      .expect(403);
  });

  it('refuses to send an out-of-service asset under maintenance', async () => {
    const asset = await createAsset(app, {
      name: 'Old Laptop',
      assetTag: 'AF-0005',
      categoryId: fixtures.electronics.id,
      status: 'RETIRED',
    });

    const res = await request(app.getHttpServer())
      .post('/api/maintenance')
      .set(auth(employeeToken))
      .send({ assetId: asset.id, description: 'Broken hinge' })
      .expect(400);

    expect(String(res.body.message)).toMatch(/out of service/i);
  });

  it('notifies the raiser when the request is resolved', async () => {
    const { request: req } = await raiseRequest('AF-0006');

    await request(app.getHttpServer())
      .post(`/api/maintenance/${req.id}/approve`)
      .set(auth(adminToken))
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/maintenance/${req.id}/resolve`)
      .set(auth(adminToken))
      .send({ resolutionNotes: 'Done' })
      .expect(200);

    const notifications = await request(app.getHttpServer())
      .get('/api/notifications')
      .set(auth(employeeToken))
      .expect(200);

    const types = notifications.body.items.map((n: any) => n.type);
    expect(types).toContain('MAINTENANCE_APPROVED');
    expect(types).toContain('MAINTENANCE_RESOLVED');
  });

  it('filters by status and by mine', async () => {
    const { request: req } = await raiseRequest('AF-0007');

    const pending = await request(app.getHttpServer())
      .get('/api/maintenance?status=PENDING')
      .set(auth(adminToken))
      .expect(200);
    expect(pending.body.total).toBe(1);

    const mine = await request(app.getHttpServer())
      .get('/api/maintenance?mine=true')
      .set(auth(employeeToken))
      .expect(200);
    expect(mine.body.total).toBe(1);

    await request(app.getHttpServer())
      .post(`/api/maintenance/${req.id}/reject`)
      .set(auth(adminToken))
      .expect(200);

    const rejected = await request(app.getHttpServer())
      .get('/api/maintenance?status=REJECTED')
      .set(auth(adminToken))
      .expect(200);
    expect(rejected.body.total).toBe(1);
  });
});
