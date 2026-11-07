/**
 * Self-service account management, end to end.
 *
 * Everything a person can do to their **own** account once the database says
 * who they are:
 *
 *   * forget the password and get a working, single-use, expiring link;
 *   * change the password while signed in;
 *   * edit their name and picture;
 *   * sign out of every device;
 *   * and have a later credential change invalidate the tokens that came
 *     before it.
 *
 * The suite also covers the first-administrator path (BOOTSTRAP_ADMIN_EMAIL),
 * because that is the only way an empty deployment can ever be administered.
 */
import { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';

import { hashResetToken } from '../src/common/security/reset-token';
import { sentMail } from '../src/mail/dev-mailer';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  DEFAULT_PASSWORD,
  auth,
  createTestApp,
  createUser,
  createUserWithToken,
  login,
  resetDatabase,
} from './utils/test-app';

describe('self-service account management (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app);
  });

  /** The token of the most recent reset e-mail. */
  function lastToken(): string {
    const mail = [...sentMail].reverse().find((m) => m.token);
    if (!mail?.token) throw new Error('no reset mail was sent');
    return mail.token;
  }

  // ── forgot password ──────────────────────────────────────────────────

  describe('POST /auth/forgot-password', () => {
    it('answers 202 for an address that has no account, and sends nothing', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/forgot-password')
        .send({ email: 'nobody@example.com' })
        .expect(202);

      expect(res.body.message).toMatch(/if an account exists/i);
      expect(sentMail).toHaveLength(0);
    });

    it('sends a link that actually resets the password', async () => {
      await createUser(app, { name: 'Ada', email: 'ada@example.com' });

      await request(app.getHttpServer())
        .post('/api/auth/forgot-password')
        .send({ email: 'ada@example.com' })
        .expect(202);

      expect(sentMail).toHaveLength(1);
      expect(sentMail[0].to).toBe('ada@example.com');
      // The mail must carry the link, never the stored hash.
      const stored = await prisma.passwordResetToken.findMany();
      expect(stored).toHaveLength(1);
      expect(sentMail[0].body).not.toContain(stored[0].tokenHash);

      await request(app.getHttpServer())
        .post('/api/auth/reset-password')
        .send({ token: lastToken(), password: 'brand-new-passphrase' })
        .expect(200);

      // The new password signs in; the old one no longer does.
      await expect(
        login(app, 'ada@example.com', 'brand-new-passphrase'),
      ).resolves.toEqual(expect.any(String));
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'ada@example.com', password: DEFAULT_PASSWORD })
        .expect(401);
    });

    it('sends nothing to a deactivated account', async () => {
      await createUser(app, {
        name: 'Gone',
        email: 'gone@example.com',
        status: 'INACTIVE',
      });

      await request(app.getHttpServer())
        .post('/api/auth/forgot-password')
        .send({ email: 'gone@example.com' })
        .expect(202);

      expect(sentMail).toHaveLength(0);
      expect(await prisma.passwordResetToken.count()).toBe(0);
    });

    it('sends nothing to a Google-only account (there is no password to reset)', async () => {
      const user = await createUser(app, {
        name: 'Google Only',
        email: 'google.only@example.com',
      });
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: null, googleId: 'google-sub-9' },
      });

      await request(app.getHttpServer())
        .post('/api/auth/forgot-password')
        .send({ email: 'google.only@example.com' })
        .expect(202);

      expect(sentMail).toHaveLength(0);
    });

    it('returns the same body whether or not the account exists', async () => {
      await createUser(app, { name: 'Real', email: 'real@example.com' });

      const known = await request(app.getHttpServer())
        .post('/api/auth/forgot-password')
        .send({ email: 'real@example.com' })
        .expect(202);
      const unknown = await request(app.getHttpServer())
        .post('/api/auth/forgot-password')
        .send({ email: 'not.here@example.com' })
        .expect(202);

      expect(known.body).toEqual(unknown.body);
    });
  });

  // ── reset password ───────────────────────────────────────────────────

  describe('POST /auth/reset-password', () => {
    it('refuses a token that was already used', async () => {
      await createUser(app, { name: 'Ada', email: 'ada@example.com' });
      await request(app.getHttpServer())
        .post('/api/auth/forgot-password')
        .send({ email: 'ada@example.com' })
        .expect(202);
      const token = lastToken();

      await request(app.getHttpServer())
        .post('/api/auth/reset-password')
        .send({ token, password: 'first-new-password' })
        .expect(200);

      await request(app.getHttpServer())
        .post('/api/auth/reset-password')
        .send({ token, password: 'second-new-password' })
        .expect(400);
    });

    it('invalidates the previous link when a new one is requested', async () => {
      await createUser(app, { name: 'Ada', email: 'ada@example.com' });

      await request(app.getHttpServer())
        .post('/api/auth/forgot-password')
        .send({ email: 'ada@example.com' })
        .expect(202);
      const first = lastToken();

      await request(app.getHttpServer())
        .post('/api/auth/forgot-password')
        .send({ email: 'ada@example.com' })
        .expect(202);
      const second = lastToken();

      expect(second).not.toBe(first);
      await request(app.getHttpServer())
        .post('/api/auth/reset-password')
        .send({ token: first, password: 'first-new-password' })
        .expect(400);
      await request(app.getHttpServer())
        .post('/api/auth/reset-password')
        .send({ token: second, password: 'second-new-password' })
        .expect(200);
    });

    it('refuses an expired token', async () => {
      const user = await createUser(app, {
        name: 'Ada',
        email: 'ada@example.com',
      });
      const token = 'expired-token-value-1234567890';
      await prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: hashResetToken(token),
          expiresAt: new Date(Date.now() - 60_000),
        },
      });

      await request(app.getHttpServer())
        .post('/api/auth/reset-password')
        .send({ token, password: 'whatever-new-password' })
        .expect(400);
    });

    it('refuses a token that never existed', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/reset-password')
        .send({
          token: 'not-a-real-token-value-1234',
          password: 'whatever-new-password',
        })
        .expect(400);
    });

    it('signs out the sessions that were open before the reset', async () => {
      const { token: oldToken } = await createUserWithToken(app, {
        name: 'Ada',
        email: 'ada@example.com',
      });

      await request(app.getHttpServer())
        .post('/api/auth/forgot-password')
        .send({ email: 'ada@example.com' })
        .expect(202);
      await request(app.getHttpServer())
        .post('/api/auth/reset-password')
        .send({ token: lastToken(), password: 'brand-new-passphrase' })
        .expect(200);

      await request(app.getHttpServer())
        .get('/api/auth/me')
        .set(auth(oldToken))
        .expect(401);
    });

    it('stores only the hash of the token, and bumps the token version', async () => {
      const user = await createUser(app, {
        name: 'Ada',
        email: 'ada@example.com',
      });

      await request(app.getHttpServer())
        .post('/api/auth/forgot-password')
        .send({ email: 'ada@example.com' })
        .expect(202);
      const token = lastToken();
      await request(app.getHttpServer())
        .post('/api/auth/reset-password')
        .send({ token, password: 'brand-new-passphrase' })
        .expect(200);

      const rows = await prisma.passwordResetToken.findMany();
      // The used token is deleted, so nothing links the e-mail to the account.
      expect(rows).toHaveLength(0);

      const after = await prisma.user.findUnique({ where: { id: user.id } });
      expect(after?.tokenVersion).toBe(1);
      expect(after?.credentialsChangedAt).toBeInstanceOf(Date);
    });
  });

  // ── change password (signed in) ──────────────────────────────────────

  describe('POST /auth/change-password', () => {
    it('requires the current password', async () => {
      const { token } = await createUserWithToken(app, {
        name: 'Ada',
        email: 'ada@example.com',
      });

      await request(app.getHttpServer())
        .post('/api/auth/change-password')
        .set(auth(token))
        .send({
          currentPassword: 'wrong-password',
          newPassword: 'new-password-1',
        })
        .expect(400);
    });

    it('refuses to reuse the current password as the new one', async () => {
      const { token } = await createUserWithToken(app, {
        name: 'Ada',
        email: 'ada@example.com',
      });

      await request(app.getHttpServer())
        .post('/api/auth/change-password')
        .set(auth(token))
        .send({
          currentPassword: DEFAULT_PASSWORD,
          newPassword: DEFAULT_PASSWORD,
        })
        .expect(400);
    });

    it('changes the password, returns a working token and kills the old one', async () => {
      const { token } = await createUserWithToken(app, {
        name: 'Ada',
        email: 'ada@example.com',
      });

      const res = await request(app.getHttpServer())
        .post('/api/auth/change-password')
        .set(auth(token))
        .send({
          currentPassword: DEFAULT_PASSWORD,
          newPassword: 'brand-new-passphrase',
        })
        .expect(200);

      // The caller is not thrown out of the tab they just used…
      expect(await prisma.user.findFirst()).toMatchObject({ tokenVersion: 1 });
      await request(app.getHttpServer())
        .get('/api/auth/me')
        .set(auth(res.body.token))
        .expect(200);

      // …but the token that made the request is now stale.
      await request(app.getHttpServer())
        .get('/api/auth/me')
        .set(auth(token))
        .expect(401);

      // And the new password is the one that works.
      await expect(
        login(app, 'ada@example.com', 'brand-new-passphrase'),
      ).resolves.toEqual(expect.any(String));
      // The change is announced by mail, so a silent takeover is noticeable.
      expect(sentMail.some((m) => /password changed/i.test(m.subject))).toBe(
        true,
      );
    });
  });

  // ── profile ──────────────────────────────────────────────────────────

  describe('PATCH /auth/me', () => {
    it('updates the name and never leaks the password hash', async () => {
      const { token } = await createUserWithToken(app, {
        name: 'Ada',
        email: 'ada@example.com',
      });

      const res = await request(app.getHttpServer())
        .patch('/api/auth/me')
        .set(auth(token))
        .send({ name: 'Ada Lovelace' })
        .expect(200);

      expect(res.body).toMatchObject({
        name: 'Ada Lovelace',
        email: 'ada@example.com',
      });
      expect(res.body).not.toHaveProperty('passwordHash');

      const me = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set(auth(token))
        .expect(200);
      expect(me.body.name).toBe('Ada Lovelace');
    });

    it('accepts an https picture and can clear it again', async () => {
      const { token } = await createUserWithToken(app, {
        name: 'Ada',
        email: 'ada@example.com',
      });

      const set = await request(app.getHttpServer())
        .patch('/api/auth/me')
        .set(auth(token))
        .send({ avatarUrl: 'https://images.example.com/ada.png' })
        .expect(200);
      expect(set.body.avatarUrl).toBe('https://images.example.com/ada.png');

      const cleared = await request(app.getHttpServer())
        .patch('/api/auth/me')
        .set(auth(token))
        .send({ avatarUrl: null })
        .expect(200);
      expect(cleared.body.avatarUrl).toBeNull();
    });

    it('rejects a picture URL that is not https', async () => {
      const { token } = await createUserWithToken(app, {
        name: 'Ada',
        email: 'ada@example.com',
      });

      for (const avatarUrl of [
        'http://images.example.com/ada.png',
        'javascript:alert(1)',
        'not-a-url',
      ]) {
        await request(app.getHttpServer())
          .patch('/api/auth/me')
          .set(auth(token))
          .send({ avatarUrl })
          .expect(400);
      }
    });

    it('cannot be used to change the role or the status', async () => {
      const { token } = await createUserWithToken(app, {
        name: 'Ada',
        email: 'ada@example.com',
      });

      // `forbidNonWhitelisted` turns the extra keys into a 400 rather than
      // silently ignoring them — a client must not believe it worked.
      await request(app.getHttpServer())
        .patch('/api/auth/me')
        .set(auth(token))
        .send({ name: 'Ada', role: Role.ADMIN })
        .expect(400);

      const row = await prisma.user.findFirst();
      expect(row?.role).toBe(Role.EMPLOYEE);
    });

    it('requires a signed-in caller', async () => {
      await request(app.getHttpServer())
        .patch('/api/auth/me')
        .send({ name: 'Nobody' })
        .expect(401);
    });
  });

  // ── sign out everywhere ──────────────────────────────────────────────

  describe('POST /auth/logout-everywhere', () => {
    it('invalidates every token, including the caller’s own', async () => {
      const { token } = await createUserWithToken(app, {
        name: 'Ada',
        email: 'ada@example.com',
      });

      await request(app.getHttpServer())
        .post('/api/auth/logout-everywhere')
        .set(auth(token))
        .expect(200);

      await request(app.getHttpServer())
        .get('/api/auth/me')
        .set(auth(token))
        .expect(401);

      // A fresh sign-in still works — the account itself is fine.
      await expect(login(app, 'ada@example.com')).resolves.toEqual(
        expect.any(String),
      );
    });
  });

  // ── throttling ───────────────────────────────────────────────────────

  describe('attempt limits', () => {
    const originalLimit = process.env.AUTH_THROTTLE_LIMIT;

    afterEach(() => {
      process.env.AUTH_THROTTLE_LIMIT = originalLimit;
    });

    it('stops a sign-up flood with 429', async () => {
      process.env.AUTH_THROTTLE_LIMIT = '2';

      const signup = (n: number) =>
        request(app.getHttpServer())
          .post('/api/auth/signup')
          .send({
            name: `Flood ${n}`,
            email: `flood${n}@example.com`,
            password: 'password123',
          });

      await signup(1).expect(201);
      await signup(2).expect(201);
      const blocked = await signup(3).expect(429);
      expect(blocked.body.message).toMatch(/Too many accounts/i);
    });

    it('stops a reset-mail flood for one address with 429', async () => {
      process.env.AUTH_THROTTLE_LIMIT = '2';
      await createUser(app, { name: 'Ada', email: 'ada@example.com' });

      const forgot = () =>
        request(app.getHttpServer())
          .post('/api/auth/forgot-password')
          .send({ email: 'ada@example.com' });

      await forgot().expect(202);
      await forgot().expect(202);
      const blocked = await forgot().expect(429);
      expect(blocked.body.message).toMatch(/Too many reset requests/i);
      // The blocked call sent nothing — the limit protects the mailbox.
      expect(sentMail).toHaveLength(2);
    });
  });
});

// ── the first administrator ─────────────────────────────────────────────

describe('first administrator bootstrap (e2e)', () => {
  /** Boot an app, prepare the database, then boot a second one with `env`. */
  async function bootBootstrap(
    env: Record<string, string>,
    prepare: (app: INestApplication) => Promise<void>,
  ) {
    const setup = await createTestApp();
    try {
      await resetDatabase(setup);
      await prepare(setup);
    } finally {
      await setup.close();
    }

    const app = await createTestApp(env);
    return app;
  }

  it('promotes an existing account when the database has no administrator', async () => {
    const app = await bootBootstrap(
      { BOOTSTRAP_ADMIN_EMAIL: 'ada@example.com' },
      async (setup) => {
        await createUser(setup, { name: 'Ada', email: 'ada@example.com' });
      },
    );

    try {
      const prisma = app.get(PrismaService);
      const user = await prisma.user.findFirst({
        where: { email: 'ada@example.com' },
      });
      expect(user?.role).toBe(Role.ADMIN);

      // The promotion is auditable and announced in the app.
      const log = await prisma.activityLog.findFirst({
        where: { action: 'user.role_changed' },
      });
      expect(log?.metadata).toMatchObject({ to: 'ADMIN', source: 'bootstrap' });

      const notification = await prisma.notification.findFirst({
        where: { userId: user?.id, type: 'USER_ROLE_CHANGED' },
      });
      expect(notification).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('never creates an account when the address does not exist', async () => {
    const app = await bootBootstrap(
      { BOOTSTRAP_ADMIN_EMAIL: 'ghost@example.com' },
      async () => {
        // deliberately empty: the address must NOT be created
      },
    );

    try {
      const prisma = app.get(PrismaService);
      expect(await prisma.user.count()).toBe(0);
      expect(await prisma.user.count({ where: { role: Role.ADMIN } })).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('does nothing when an active administrator already exists', async () => {
    const app = await bootBootstrap(
      { BOOTSTRAP_ADMIN_EMAIL: 'mallory@example.com' },
      async (setup) => {
        await createUser(setup, {
          name: 'Real Admin',
          email: 'admin@example.com',
          role: Role.ADMIN,
        });
        await createUser(setup, {
          name: 'Mallory',
          email: 'mallory@example.com',
        });
      },
    );

    try {
      const prisma = app.get(PrismaService);
      const mallory = await prisma.user.findFirst({
        where: { email: 'mallory@example.com' },
      });
      expect(mallory?.role).toBe(Role.EMPLOYEE);
      expect(await prisma.user.count({ where: { role: Role.ADMIN } })).toBe(1);
    } finally {
      await app.close();
    }
  });
});
