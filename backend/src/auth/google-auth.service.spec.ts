import { ConfigService } from '@nestjs/config';
import { RecordStatus, Role } from '@prisma/client';
import { OAuth2Client } from 'google-auth-library';

import { AuthService } from './auth.service';
import { LoginThrottleService } from './login-throttle.service';

jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn(),
}));

const MockOAuth2Client = OAuth2Client as unknown as jest.Mock;
const CLIENT_ID = 'test-client.apps.googleusercontent.com';

type UserRecord = {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: RecordStatus;
  departmentId: string | null;
  passwordHash: string | null;
  googleId: string | null;
};

function makeUser(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: 'u1',
    name: 'Ada',
    email: 'ada@example.com',
    role: Role.EMPLOYEE,
    status: RecordStatus.ACTIVE,
    departmentId: null,
    passwordHash: null,
    googleId: null,
    ...overrides,
  };
}

function makeService(options: {
  clientId?: string | null;
  user?: UserRecord | null;
}) {
  const clientId =
    options.clientId === undefined ? CLIENT_ID : options.clientId;
  const user = options.user ?? null;

  const verifyIdToken = jest.fn();
  MockOAuth2Client.mockImplementation(() => ({ verifyIdToken }));

  const findFirst = jest.fn().mockResolvedValue(user);
  const update = jest.fn().mockImplementation(async ({ data }: any) => ({
    ...user,
    ...data,
  }));
  const create = jest.fn().mockImplementation(async ({ data }: any) => ({
    id: 'u2',
    name: data.name,
    email: data.email,
    role: data.role,
    status: RecordStatus.ACTIVE,
    departmentId: null,
    passwordHash: data.passwordHash ?? null,
    googleId: data.googleId ?? null,
  }));

  const prisma = {
    user: { findFirst, update, create },
  } as any;
  const jwt = { sign: jest.fn().mockReturnValue('signed-token') } as any;
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'GOOGLE_CLIENT_ID') return clientId;
      if (key === 'BCRYPT_ROUNDS') return 4;
      return undefined;
    }),
  } as unknown as ConfigService;

  const service = new AuthService(
    prisma,
    jwt,
    config,
    new LoginThrottleService(config),
  );

  return { service, verifyIdToken, findFirst, update, create, prisma };
}

function verifiedPayload(overrides: Record<string, unknown> = {}) {
  return {
    sub: 'google-sub-1',
    email: 'ada@example.com',
    email_verified: true,
    name: 'Ada Lovelace',
    ...overrides,
  };
}

describe('AuthService — Google sign-in', () => {
  beforeEach(() => {
    MockOAuth2Client.mockReset();
  });

  it('reports Google as unavailable when no client id is configured', async () => {
    const { service, verifyIdToken } = makeService({ clientId: null });

    expect(service.providerConfig()).toEqual({ googleClientId: null });
    await expect(
      service.googleLogin({ credential: 'x'.repeat(30) }),
    ).rejects.toThrow(/not configured/i);
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it('rejects a token Google does not verify', async () => {
    const { service, verifyIdToken } = makeService({});
    verifyIdToken.mockRejectedValue(new Error('invalid signature'));

    await expect(
      service.googleLogin({ credential: 'x'.repeat(30) }),
    ).rejects.toThrow(/google sign-in failed/i);
  });

  it('creates an EMPLOYEE for a new, verified Google account', async () => {
    const { service, verifyIdToken, create } = makeService({});
    verifyIdToken.mockResolvedValue({
      getPayload: () => verifiedPayload(),
    });

    const res = await service.googleLogin({ credential: 'x'.repeat(30) });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        passwordHash: null,
        googleId: 'google-sub-1',
        role: Role.EMPLOYEE,
      }),
    });
    expect(res.token).toBe('signed-token');
    expect(res.user.email).toBe('ada@example.com');
  });

  it('links a Google identity to an existing password account', async () => {
    const existing = makeUser({ passwordHash: 'a-bcrypt-hash' });
    const { service, verifyIdToken, update } = makeService({ user: existing });
    verifyIdToken.mockResolvedValue({
      getPayload: () => verifiedPayload({ email: 'ADA@example.com' }),
    });

    const res = await service.googleLogin({ credential: 'x'.repeat(30) });

    expect(update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { googleId: 'google-sub-1' },
    });
    expect(res.user.id).toBe('u1');
  });

  it('refuses an unverified Google email', async () => {
    const { service, verifyIdToken } = makeService({});
    verifyIdToken.mockResolvedValue({
      getPayload: () => verifiedPayload({ email_verified: false }),
    });

    await expect(
      service.googleLogin({ credential: 'x'.repeat(30) }),
    ).rejects.toThrow(/verified email/i);
  });

  it('refuses a deactivated account', async () => {
    const { service, verifyIdToken } = makeService({
      user: makeUser({ status: RecordStatus.INACTIVE }),
    });
    verifyIdToken.mockResolvedValue({
      getPayload: () => verifiedPayload(),
    });

    await expect(
      service.googleLogin({ credential: 'x'.repeat(30) }),
    ).rejects.toThrow(/deactivated/i);
  });

  it('refuses to attach a second Google identity to one email', async () => {
    const { service, verifyIdToken } = makeService({
      user: makeUser({ googleId: 'another-google-sub' }),
    });
    verifyIdToken.mockResolvedValue({
      getPayload: () => verifiedPayload(),
    });

    await expect(
      service.googleLogin({ credential: 'x'.repeat(30) }),
    ).rejects.toThrow(/different google account/i);
  });
});
