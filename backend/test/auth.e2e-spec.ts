import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { PrismaService } from '../src/prisma/prisma.service';
import {
  auth,
  createTestApp,
  createUser,
  createUserWithToken,
  resetDatabase,
} from './utils/test-app';

describe('Auth & RBAC (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app);
  });

  describe('POST /auth/signup', () => {
    it('creates an EMPLOYEE and returns a token', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/signup')
        .send({
          name: 'Ada Lovelace',
          email: 'ada@example.com',
          password: 'password123',
        })
        .expect(201);

      expect(res.body.token).toEqual(expect.any(String));
      expect(res.body.user).toMatchObject({
        email: 'ada@example.com',
        role: 'EMPLOYEE',
      });
      // The password hash must never leave the server.
      expect(res.body.user.passwordHash).toBeUndefined();
    });

    it('never lets a caller self-assign a privileged role', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/signup')
        .send({
          name: 'Mallory',
          email: 'mallory@example.com',
          password: 'password123',
          role: 'ADMIN',
        })
        .expect(400); // `role` is not whitelisted → rejected

      expect(res.body.message).toBeDefined();
    });

    it('rejects a duplicate e-mail regardless of casing', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/signup')
        .send({
          name: 'Ada',
          email: 'ada@example.com',
          password: 'password123',
        })
        .expect(201);

      await request(app.getHttpServer())
        .post('/api/auth/signup')
        .send({
          name: 'Ada 2',
          email: 'ADA@example.com',
          password: 'password123',
        })
        .expect(409);
    });

    it('rejects a weak password', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/signup')
        .send({ name: 'Short', email: 'short@example.com', password: '123' })
        .expect(400);
    });
  });

  describe('POST /auth/login', () => {
    it('accepts the right password, whatever the e-mail casing', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/signup')
        .send({
          name: 'Ada',
          email: 'ada@example.com',
          password: 'password123',
        })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'ADA@Example.com', password: 'password123' })
        .expect(200);

      expect(res.body.token).toEqual(expect.any(String));
    });

    it('returns the same error for an unknown account and a wrong password', async () => {
      await createUserWithToken(app, {
        name: 'Ada',
        email: 'ada@example.com',
      });

      const unknown = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'nobody@example.com', password: 'password123' })
        .expect(401);

      const wrong = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'ada@example.com', password: 'wrong-password' })
        .expect(401);

      expect(unknown.body.message).toBe(wrong.body.message);
    });

    it('refuses a deactivated account', async () => {
      await createUser(app, {
        name: 'Ada',
        email: 'ada@example.com',
        status: 'INACTIVE',
      });

      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'ada@example.com', password: 'password123' })
        .expect(401);
    });

    it('blocks an account after too many failed attempts (429)', async () => {
      await createUser(app, {
        name: 'Ada',
        email: 'ada@example.com',
      });

      const previousLimit = process.env.AUTH_THROTTLE_LIMIT;
      process.env.AUTH_THROTTLE_LIMIT = '5';
      try {
        for (let i = 0; i < 5; i++) {
          await request(app.getHttpServer())
            .post('/api/auth/login')
            .send({ email: 'ada@example.com', password: 'nope' })
            .expect(401);
        }

        // The 6th attempt is refused with 429 — even with the CORRECT password.
        const blocked = await request(app.getHttpServer())
          .post('/api/auth/login')
          .send({ email: 'ada@example.com', password: 'password123' })
          .expect(429);

        expect(String(blocked.body.message)).toMatch(/too many/i);
      } finally {
        if (previousLimit === undefined) {
          delete process.env.AUTH_THROTTLE_LIMIT;
        } else {
          process.env.AUTH_THROTTLE_LIMIT = previousLimit;
        }
      }
    });
  });

  describe('GET /auth/config', () => {
    it('reports Google sign-in as unavailable when no client id is set', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/auth/config')
        .expect(200);

      expect(res.body).toEqual({ googleClientId: null });
    });
  });

  describe('POST /auth/google', () => {
    it('answers 503 when Google sign-in is not configured', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/google')
        .send({ credential: 'x'.repeat(30) })
        .expect(503);

      expect(String(res.body.message)).toMatch(/not configured/i);
    });

    it('rejects a malformed body', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/google')
        .send({ credential: 'short' })
        .expect(400);
    });
  });

  describe('GET /auth/me', () => {
    it('returns the current user for a valid token', async () => {
      const { token } = await createUserWithToken(app, {
        name: 'Ada',
        email: 'ada@example.com',
      });

      const res = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set(auth(token))
        .expect(200);

      expect(res.body.email).toBe('ada@example.com');
      expect(res.body.passwordHash).toBeUndefined();
    });

    it('rejects a missing or malformed token', async () => {
      await request(app.getHttpServer()).get('/api/auth/me').expect(401);
      await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', 'Bearer not-a-jwt')
        .expect(401);
    });

    it('stops working once the account is deactivated', async () => {
      const { token, user } = await createUserWithToken(app, {
        name: 'Ada',
        email: 'ada@example.com',
      });

      const prisma = app.get(PrismaService);
      await prisma.user.update({
        where: { id: user.id },
        data: { status: 'INACTIVE' },
      });

      await request(app.getHttpServer())
        .get('/api/auth/me')
        .set(auth(token))
        .expect(401);
    });
  });

  describe('route protection', () => {
    it('requires a token on every private route', async () => {
      const routes: Array<[string, string]> = [
        ['get', '/api/assets'],
        ['post', '/api/assets'],
        ['get', '/api/allocations'],
        ['post', '/api/bookings'],
        ['get', '/api/maintenance'],
        ['get', '/api/audits'],
        ['get', '/api/reports/dashboard'],
        ['get', '/api/notifications'],
        ['get', '/api/org/employees'],
      ];

      for (const [method, path] of routes) {
        await (request(app.getHttpServer()) as any)[method](path).expect(401);
      }
    });

    it('keeps manager-only routes away from employees', async () => {
      const { token } = await createUserWithToken(app, {
        name: 'Employee',
        email: 'employee@example.com',
      });

      await request(app.getHttpServer())
        .post('/api/assets')
        .set(auth(token))
        .send({ name: 'Laptop', categoryId: 'whatever' })
        .expect(403);

      await request(app.getHttpServer())
        .get('/api/reports/analytics')
        .set(auth(token))
        .expect(403);

      await request(app.getHttpServer())
        .get('/api/activity')
        .set(auth(token))
        .expect(403);
    });

    it('rejects unknown fields in a request body', async () => {
      const { token } = await createUserWithToken(app, {
        name: 'Admin',
        email: 'admin@example.com',
        role: 'ADMIN',
      });

      await request(app.getHttpServer())
        .post('/api/assets')
        .set(auth(token))
        .send({ name: 'Laptop', categoryId: 'x', sneaky: true })
        .expect(400);
    });
  });
});
