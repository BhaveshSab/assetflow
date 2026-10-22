import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { PrismaService } from '../src/prisma/prisma.service';
import {
  auth,
  createAsset,
  createTestApp,
  createUserWithToken,
  resetDatabase,
  seedFixtures,
  type Fixtures,
} from './utils/test-app';

describe('Assets (e2e)', () => {
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
        name: 'Priya Employee',
        email: 'priya@example.com',
        departmentId: fixtures.it.id,
      })
    ).token;
  });

  describe('POST /assets', () => {
    it('auto-generates a sequential asset tag', async () => {
      const first = await request(app.getHttpServer())
        .post('/api/assets')
        .set(auth(adminToken))
        .send({ name: 'MacBook Pro', categoryId: fixtures.electronics.id })
        .expect(201);

      const second = await request(app.getHttpServer())
        .post('/api/assets')
        .set(auth(adminToken))
        .send({ name: 'ThinkPad', categoryId: fixtures.electronics.id })
        .expect(201);

      expect(first.body.assetTag).toBe('AF-0001');
      expect(second.body.assetTag).toBe('AF-0002');
    });

    it('keeps counting past 9999 (numeric, not lexicographic, ordering)', async () => {
      const prisma = app.get(PrismaService);
      await prisma.asset.create({
        data: {
          assetTag: 'AF-9999',
          name: 'Last four-digit tag',
          categoryId: fixtures.electronics.id,
        },
      });
      await prisma.asset.create({
        data: {
          assetTag: 'AF-10000',
          name: 'Five-digit tag',
          categoryId: fixtures.electronics.id,
        },
      });

      const res = await request(app.getHttpServer())
        .post('/api/assets')
        .set(auth(adminToken))
        .send({ name: 'After 10000', categoryId: fixtures.electronics.id })
        .expect(201);

      // "AF-10001" — a lexicographic MAX() would have produced "AF-10001" too,
      // but a string-sorted MAX() would have returned "AF-9999" → "AF-10000"
      // (a duplicate).
      expect(res.body.assetTag).toBe('AF-10001');
    });

    it('rejects an unknown category', async () => {
      await request(app.getHttpServer())
        .post('/api/assets')
        .set(auth(adminToken))
        .send({ name: 'Ghost', categoryId: 'does-not-exist' })
        .expect(400);
    });

    it('is forbidden for employees', async () => {
      await request(app.getHttpServer())
        .post('/api/assets')
        .set(auth(employeeToken))
        .send({ name: 'Nope', categoryId: fixtures.electronics.id })
        .expect(403);
    });
  });

  describe('GET /assets', () => {
    it('filters by search term, category and status', async () => {
      await createAsset(app, {
        name: 'Dell Monitor',
        assetTag: 'AF-0100',
        categoryId: fixtures.electronics.id,
      });
      await createAsset(app, {
        name: 'Ergonomic Chair',
        assetTag: 'AF-0101',
        categoryId: fixtures.furniture.id,
        status: 'RETIRED',
      });

      const byName = await request(app.getHttpServer())
        .get('/api/assets?q=monitor')
        .set(auth(employeeToken))
        .expect(200);
      expect(byName.body.total).toBe(1);
      expect(byName.body.items[0].name).toBe('Dell Monitor');

      const byCategory = await request(app.getHttpServer())
        .get(`/api/assets?categoryId=${fixtures.furniture.id}`)
        .set(auth(employeeToken))
        .expect(200);
      expect(byCategory.body.total).toBe(1);

      const byStatus = await request(app.getHttpServer())
        .get('/api/assets?status=RETIRED')
        .set(auth(employeeToken))
        .expect(200);
      expect(byStatus.body.total).toBe(1);
    });

    it('rejects an invalid status filter', async () => {
      await request(app.getHttpServer())
        .get('/api/assets?status=NOT_A_STATUS')
        .set(auth(employeeToken))
        .expect(400);
    });

    it('caps the page size', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/assets?take=9999')
        .set(auth(employeeToken))
        .expect(400);
      expect(String(res.body.message)).toMatch(/take/i);
    });
  });

  describe('PATCH /assets/:id', () => {
    it('lets a manager retire an asset', async () => {
      const asset = await createAsset(app, {
        name: 'Old Laptop',
        assetTag: 'AF-0200',
        categoryId: fixtures.electronics.id,
      });

      const res = await request(app.getHttpServer())
        .patch(`/api/assets/${asset.id}`)
        .set(auth(adminToken))
        .send({ status: 'RETIRED' })
        .expect(200);

      expect(res.body.status).toBe('RETIRED');
    });

    it('refuses to hand-set a workflow-owned status', async () => {
      const asset = await createAsset(app, {
        name: 'Busy Laptop',
        assetTag: 'AF-0201',
        categoryId: fixtures.electronics.id,
      });

      const res = await request(app.getHttpServer())
        .patch(`/api/assets/${asset.id}`)
        .set(auth(adminToken))
        .send({ status: 'ALLOCATED' })
        .expect(400);

      expect(String(res.body.message)).toMatch(/workflow/i);
    });

    it('is forbidden for employees', async () => {
      const asset = await createAsset(app, {
        name: 'Laptop',
        assetTag: 'AF-0202',
        categoryId: fixtures.electronics.id,
      });

      await request(app.getHttpServer())
        .patch(`/api/assets/${asset.id}`)
        .set(auth(employeeToken))
        .send({ name: 'Hacked' })
        .expect(403);
    });
  });

  describe('GET /assets/:id/history', () => {
    it('returns allocations and maintenance for the asset', async () => {
      const asset = await createAsset(app, {
        name: 'Laptop',
        assetTag: 'AF-0300',
        categoryId: fixtures.electronics.id,
      });

      const res = await request(app.getHttpServer())
        .get(`/api/assets/${asset.id}/history`)
        .set(auth(employeeToken))
        .expect(200);

      expect(res.body).toHaveProperty('allocations');
      expect(res.body).toHaveProperty('maintenance');
    });
  });
});
