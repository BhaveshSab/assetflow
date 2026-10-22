import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { PrismaService } from '../src/prisma/prisma.service';
import {
  auth,
  createAsset,
  createTestApp,
  createUser,
  createUserWithToken,
  resetDatabase,
  seedFixtures,
  type Fixtures,
} from './utils/test-app';

describe('Allocations & Transfers (e2e)', () => {
  let app: INestApplication;
  let fixtures: Fixtures;
  let adminToken: string;
  let managerToken: string;
  let employeeToken: string;
  let otherEmployeeToken: string;
  let headToken: string;

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
    otherEmployeeToken = (
      await createUserWithToken(app, {
        name: 'Raj',
        email: 'raj@example.com',
        departmentId: fixtures.facilities.id,
      })
    ).token;
    headToken = (
      await createUserWithToken(app, {
        name: 'Hana Head',
        email: 'head@example.com',
        role: 'DEPARTMENT_HEAD',
        departmentId: fixtures.it.id,
      })
    ).token;
  });

  describe('POST /allocations', () => {
    it('allocates an available asset to an employee', async () => {
      const asset = await createAsset(app, {
        name: 'Laptop',
        assetTag: 'AF-0001',
        categoryId: fixtures.electronics.id,
      });
      const holder = await request(app.getHttpServer())
        .get('/api/org/employees/directory')
        .set(auth(adminToken))
        .expect(200);
      const priya = holder.body.find(
        (u: any) => u.email === 'priya@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/api/allocations')
        .set(auth(managerToken))
        .send({ assetId: asset.id, holderUserId: priya.id })
        .expect(201);

      expect(res.body.status).toBe('ACTIVE');

      const assetAfter = await request(app.getHttpServer())
        .get(`/api/assets/${asset.id}`)
        .set(auth(adminToken))
        .expect(200);
      expect(assetAfter.body.status).toBe('ALLOCATED');
    });

    it('rejects a second allocation of the same asset (409)', async () => {
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
      const raj = directory.body.find(
        (u: any) => u.email === 'raj@example.com',
      );

      await request(app.getHttpServer())
        .post('/api/allocations')
        .set(auth(managerToken))
        .send({ assetId: asset.id, holderUserId: priya.id })
        .expect(201);

      const conflict = await request(app.getHttpServer())
        .post('/api/allocations')
        .set(auth(managerToken))
        .send({ assetId: asset.id, holderUserId: raj.id })
        .expect(409);

      expect(conflict.body.currentHolder?.name).toBe('Priya');
    });

    it('requires exactly one holder type', async () => {
      const asset = await createAsset(app, {
        name: 'Laptop',
        assetTag: 'AF-0003',
        categoryId: fixtures.electronics.id,
      });

      await request(app.getHttpServer())
        .post('/api/allocations')
        .set(auth(managerToken))
        .send({ assetId: asset.id })
        .expect(400);

      await request(app.getHttpServer())
        .post('/api/allocations')
        .set(auth(managerToken))
        .send({ assetId: asset.id, holderUserId: 'x', departmentId: 'y' })
        .expect(400);
    });

    it('refuses to allocate to a deactivated user', async () => {
      const asset = await createAsset(app, {
        name: 'Laptop',
        assetTag: 'AF-0004',
        categoryId: fixtures.electronics.id,
      });
      const user = await createUser(app, {
        name: 'Ghost',
        email: 'ghost@example.com',
        status: 'INACTIVE',
      });

      const res = await request(app.getHttpServer())
        .post('/api/allocations')
        .set(auth(managerToken))
        .send({ assetId: asset.id, holderUserId: user.id })
        .expect(400);

      expect(String(res.body.message)).toMatch(/deactivated/i);
    });

    it('is forbidden for employees', async () => {
      const asset = await createAsset(app, {
        name: 'Laptop',
        assetTag: 'AF-0005',
        categoryId: fixtures.electronics.id,
      });

      await request(app.getHttpServer())
        .post('/api/allocations')
        .set(auth(employeeToken))
        .send({ assetId: asset.id, departmentId: fixtures.it.id })
        .expect(403);
    });
  });

  describe('POST /allocations/:id/return', () => {
    async function allocateToPriya(assetTag: string) {
      const asset = await createAsset(app, {
        name: 'Laptop',
        assetTag,
        categoryId: fixtures.electronics.id,
      });
      const directory = await request(app.getHttpServer())
        .get('/api/org/employees/directory')
        .set(auth(adminToken))
        .expect(200);
      const priya = directory.body.find(
        (u: any) => u.email === 'priya@example.com',
      );
      const res = await request(app.getHttpServer())
        .post('/api/allocations')
        .set(auth(managerToken))
        .send({ assetId: asset.id, holderUserId: priya.id })
        .expect(201);
      return { asset, allocation: res.body };
    }

    it('lets the holder return their own asset', async () => {
      const { asset, allocation } = await allocateToPriya('AF-0100');

      const res = await request(app.getHttpServer())
        .post(`/api/allocations/${allocation.id}/return`)
        .set(auth(employeeToken))
        .send({ checkInNotes: 'All good' })
        .expect(200);

      expect(res.body.status).toBe('RETURNED');

      const after = await request(app.getHttpServer())
        .get(`/api/assets/${asset.id}`)
        .set(auth(adminToken))
        .expect(200);
      expect(after.body.status).toBe('AVAILABLE');
    });

    it('refuses to return somebody else’s asset', async () => {
      const { allocation } = await allocateToPriya('AF-0101');

      await request(app.getHttpServer())
        .post(`/api/allocations/${allocation.id}/return`)
        .set(auth(otherEmployeeToken))
        .send({})
        .expect(403);
    });

    it('scopes a department head to their own department', async () => {
      // Raj (Facilities) holds the asset; Hana heads IT → she may not return it.
      const asset = await createAsset(app, {
        name: 'Laptop',
        assetTag: 'AF-0102',
        categoryId: fixtures.electronics.id,
      });
      const directory = await request(app.getHttpServer())
        .get('/api/org/employees/directory')
        .set(auth(adminToken))
        .expect(200);
      const raj = directory.body.find(
        (u: any) => u.email === 'raj@example.com',
      );
      const allocation = await request(app.getHttpServer())
        .post('/api/allocations')
        .set(auth(managerToken))
        .send({ assetId: asset.id, holderUserId: raj.id })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/allocations/${allocation.body.id}/return`)
        .set(auth(headToken))
        .send({})
        .expect(403);
    });

    it('rejects returning an allocation twice (409)', async () => {
      const { allocation } = await allocateToPriya('AF-0103');

      await request(app.getHttpServer())
        .post(`/api/allocations/${allocation.id}/return`)
        .set(auth(adminToken))
        .send({})
        .expect(200);

      await request(app.getHttpServer())
        .post(`/api/allocations/${allocation.id}/return`)
        .set(auth(adminToken))
        .send({})
        .expect(409);
    });
  });

  describe('transfer workflow', () => {
    async function allocate(assetTag: string, holderEmail: string) {
      const asset = await createAsset(app, {
        name: 'Laptop',
        assetTag,
        categoryId: fixtures.electronics.id,
      });
      const directory = await request(app.getHttpServer())
        .get('/api/org/employees/directory')
        .set(auth(adminToken))
        .expect(200);
      const holder = directory.body.find((u: any) => u.email === holderEmail);
      const allocation = await request(app.getHttpServer())
        .post('/api/allocations')
        .set(auth(managerToken))
        .send({ assetId: asset.id, holderUserId: holder.id })
        .expect(201);
      return { asset, allocation: allocation.body, directory: directory.body };
    }

    it('lets the holder request a transfer', async () => {
      const { asset, directory } = await allocate(
        'AF-0200',
        'priya@example.com',
      );
      const raj = directory.find((u: any) => u.email === 'raj@example.com');

      const res = await request(app.getHttpServer())
        .post('/api/transfers')
        .set(auth(employeeToken))
        .send({ assetId: asset.id, toUserId: raj.id, reason: 'Team change' })
        .expect(201);

      expect(res.body.status).toBe('REQUESTED');
    });

    it('refuses a transfer request for an asset the caller does not hold', async () => {
      const { asset, directory } = await allocate(
        'AF-0201',
        'priya@example.com',
      );
      const raj = directory.find((u: any) => u.email === 'raj@example.com');

      await request(app.getHttpServer())
        .post('/api/transfers')
        .set(auth(otherEmployeeToken))
        .send({ assetId: asset.id, toUserId: raj.id })
        .expect(403);
    });

    it('re-allocates the asset on approval', async () => {
      const { asset, directory } = await allocate(
        'AF-0202',
        'priya@example.com',
      );
      const raj = directory.find((u: any) => u.email === 'raj@example.com');

      const transfer = await request(app.getHttpServer())
        .post('/api/transfers')
        .set(auth(employeeToken))
        .send({ assetId: asset.id, toUserId: raj.id })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/transfers/${transfer.body.id}/approve`)
        .set(auth(managerToken))
        .expect(200);

      const mine = await request(app.getHttpServer())
        .get('/api/allocations/my')
        .set(auth(otherEmployeeToken))
        .expect(200);

      const held = mine.body.items.find(
        (a: any) => a.assetId === asset.id && a.status === 'ACTIVE',
      );
      expect(held).toBeDefined();
      expect(held.holderUser.email).toBe('raj@example.com');
    });

    it('keeps the expected return date across a transfer', async () => {
      const { asset, directory } = await allocate(
        'AF-0203',
        'priya@example.com',
      );
      const raj = directory.find((u: any) => u.email === 'raj@example.com');
      const due = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();

      const allocation = await request(app.getHttpServer())
        .get('/api/allocations')
        .set(auth(managerToken))
        .expect(200);
      const active = allocation.body.items.find(
        (a: any) => a.assetId === asset.id,
      );

      // Give the allocation a return deadline.
      const prisma = app.get(PrismaService);
      await prisma.allocation.update({
        where: { id: active.id },
        data: { expectedReturnDate: new Date(due) },
      });

      const transfer = await request(app.getHttpServer())
        .post('/api/transfers')
        .set(auth(employeeToken))
        .send({ assetId: asset.id, toUserId: raj.id })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/transfers/${transfer.body.id}/approve`)
        .set(auth(managerToken))
        .expect(200);

      const after = await request(app.getHttpServer())
        .get('/api/allocations')
        .set(auth(managerToken))
        .expect(200);
      const newActive = after.body.items.find(
        (a: any) => a.assetId === asset.id && a.status === 'ACTIVE',
      );
      expect(newActive.expectedReturnDate).toBeTruthy();
    });

    it('rejects approving a transfer twice', async () => {
      const { asset, directory } = await allocate(
        'AF-0204',
        'priya@example.com',
      );
      const raj = directory.find((u: any) => u.email === 'raj@example.com');

      const transfer = await request(app.getHttpServer())
        .post('/api/transfers')
        .set(auth(employeeToken))
        .send({ assetId: asset.id, toUserId: raj.id })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/transfers/${transfer.body.id}/approve`)
        .set(auth(managerToken))
        .expect(200);

      await request(app.getHttpServer())
        .post(`/api/transfers/${transfer.body.id}/approve`)
        .set(auth(managerToken))
        .expect(409);
    });
  });

  describe('GET /allocations', () => {
    it('scopes a department head to their own department', async () => {
      const asset = await createAsset(app, {
        name: 'Laptop',
        assetTag: 'AF-0300',
        categoryId: fixtures.electronics.id,
      });
      const directory = await request(app.getHttpServer())
        .get('/api/org/employees/directory')
        .set(auth(adminToken))
        .expect(200);
      const raj = directory.body.find(
        (u: any) => u.email === 'raj@example.com',
      );

      await request(app.getHttpServer())
        .post('/api/allocations')
        .set(auth(managerToken))
        .send({ assetId: asset.id, holderUserId: raj.id })
        .expect(201);

      const headView = await request(app.getHttpServer())
        .get('/api/allocations')
        .set(auth(headToken))
        .expect(200);
      expect(headView.body.total).toBe(0);

      const adminView = await request(app.getHttpServer())
        .get('/api/allocations')
        .set(auth(adminToken))
        .expect(200);
      expect(adminView.body.total).toBe(1);
    });
  });
});
