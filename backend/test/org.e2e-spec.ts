import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import {
  auth,
  createTestApp,
  createUser,
  createUserWithToken,
  resetDatabase,
} from './utils/test-app';

describe('Organization setup (e2e)', () => {
  let app: INestApplication;
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
      })
    ).token;
  });

  describe('departments', () => {
    it('creates, lists and updates a department', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/org/departments')
        .set(auth(adminToken))
        .send({ name: 'Engineering' })
        .expect(201);

      expect(created.body.name).toBe('Engineering');

      const list = await request(app.getHttpServer())
        .get('/api/org/departments?q=engineering')
        .set(auth(employeeToken))
        .expect(200);
      expect(list.body.total).toBe(1);

      const updated = await request(app.getHttpServer())
        .patch(`/api/org/departments/${created.body.id}`)
        .set(auth(adminToken))
        .send({ name: 'Engineering & Research' })
        .expect(200);
      expect(updated.body.name).toBe('Engineering & Research');
    });

    it('rejects a duplicate department name', async () => {
      await request(app.getHttpServer())
        .post('/api/org/departments')
        .set(auth(adminToken))
        .send({ name: 'IT' })
        .expect(201);

      await request(app.getHttpServer())
        .post('/api/org/departments')
        .set(auth(adminToken))
        .send({ name: 'IT' })
        .expect(409);
    });

    it('refuses to create a department as an employee', async () => {
      await request(app.getHttpServer())
        .post('/api/org/departments')
        .set(auth(employeeToken))
        .send({ name: 'Shadow' })
        .expect(403);
    });

    it('rejects a cycle in the hierarchy', async () => {
      const parent = await request(app.getHttpServer())
        .post('/api/org/departments')
        .set(auth(adminToken))
        .send({ name: 'Parent' })
        .expect(201);
      const child = await request(app.getHttpServer())
        .post('/api/org/departments')
        .set(auth(adminToken))
        .send({ name: 'Child', parentDepartmentId: parent.body.id })
        .expect(201);

      await request(app.getHttpServer())
        .patch(`/api/org/departments/${parent.body.id}`)
        .set(auth(adminToken))
        .send({ parentDepartmentId: child.body.id })
        .expect(400);
    });
  });

  describe('categories', () => {
    it('creates a category with custom fields', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/org/categories')
        .set(auth(adminToken))
        .send({
          name: 'Vehicles',
          customFields: [{ key: 'warrantyMonths', type: 'number' }],
        })
        .expect(201);

      expect(res.body.customFields).toEqual([
        { key: 'warrantyMonths', type: 'number' },
      ]);
    });
  });

  describe('employees', () => {
    it('provisions an account and returns a temporary password', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/org/employees')
        .set(auth(adminToken))
        .send({ name: 'New Hire', email: 'newhire@example.com' })
        .expect(201);

      expect(res.body.email).toBe('newhire@example.com');
      expect(res.body.role).toBe('EMPLOYEE');
      expect(res.body.passwordHash).toBeUndefined();
      // A strong temporary password is handed back exactly once.
      expect(typeof res.body.temporaryPassword).toBe('string');
      expect(res.body.temporaryPassword.length).toBeGreaterThanOrEqual(12);

      // ...and it actually works.
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({
          email: 'newhire@example.com',
          password: res.body.temporaryPassword,
        })
        .expect(200);
    });

    it('never exposes the password hash', async () => {
      const list = await request(app.getHttpServer())
        .get('/api/org/employees')
        .set(auth(adminToken))
        .expect(200);

      expect(list.body.items[0].passwordHash).toBeUndefined();
    });

    it('is the only place a role can change', async () => {
      const user = await createUser(app, {
        name: 'Promote Me',
        email: 'promote@example.com',
      });

      const res = await request(app.getHttpServer())
        .patch(`/api/org/employees/${user.id}/role`)
        .set(auth(adminToken))
        .send({ role: 'ASSET_MANAGER' })
        .expect(200);
      expect(res.body.role).toBe('ASSET_MANAGER');
    });

    it('refuses to demote the last active admin', async () => {
      const admins = await request(app.getHttpServer())
        .get('/api/org/employees?role=ADMIN')
        .set(auth(adminToken))
        .expect(200);
      const admin = admins.body.items[0];

      const res = await request(app.getHttpServer())
        .patch(`/api/org/employees/${admin.id}/role`)
        .set(auth(adminToken))
        .send({ role: 'EMPLOYEE' })
        .expect(409);

      expect(String(res.body.message)).toMatch(/last remaining admin/i);
    });

    it('refuses to deactivate the last active admin', async () => {
      const admins = await request(app.getHttpServer())
        .get('/api/org/employees?role=ADMIN')
        .set(auth(adminToken))
        .expect(200);
      const admin = admins.body.items[0];

      await request(app.getHttpServer())
        .patch(`/api/org/employees/${admin.id}`)
        .set(auth(adminToken))
        .send({ status: 'INACTIVE' })
        .expect(409);
    });

    it('cannot change a role through the profile endpoint', async () => {
      const user = await createUser(app, {
        name: 'Sneaky',
        email: 'sneaky@example.com',
      });

      await request(app.getHttpServer())
        .patch(`/api/org/employees/${user.id}`)
        .set(auth(adminToken))
        .send({ role: 'ADMIN' })
        .expect(400);
    });

    it('keeps the employee directory available to every signed-in user', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/org/employees/directory')
        .set(auth(employeeToken))
        .expect(200);

      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body[0].passwordHash).toBeUndefined();
      expect(res.body[0].role).toBeUndefined();
    });
  });
});
