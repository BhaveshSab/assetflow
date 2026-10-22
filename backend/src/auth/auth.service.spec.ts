import { ConfigService } from '@nestjs/config';
import { Role } from '@prisma/client';

import { AuthService } from './auth.service';
import { LoginThrottleService } from './login-throttle.service';

type UserRecord = {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: 'ACTIVE' | 'INACTIVE';
  departmentId: string | null;
  passwordHash: string;
};

const VALID_HASH =
  '$2b$10$jWl8m5xNdRFlXlK4AcU1kuRuONp11gwyLA6yPvOvjbwANi8fJqgb2';

function makeService(
  overrides: { user?: UserRecord | null; existing?: UserRecord | null } = {},
) {
  const user: UserRecord | null =
    overrides.user === undefined
      ? {
          id: 'u1',
          name: 'Ada',
          email: 'ada@example.com',
          role: Role.EMPLOYEE,
          status: 'ACTIVE',
          departmentId: null,
          passwordHash: VALID_HASH,
        }
      : overrides.user;

  // `existing` is what the *duplicate e-mail* check sees; `user` is what the
  // login lookup sees.
  const existing: UserRecord | null =
    overrides.existing === undefined ? null : overrides.existing;

  // The signup duplicate-check selects only the id, the login lookup does
  // not — that is how the two calls are told apart here.
  const findFirst = jest
    .fn()
    .mockImplementation(async (args: any) => (args?.select ? existing : user));
  const create = jest.fn().mockImplementation(async ({ data }: any) => ({
    id: 'u2',
    name: data.name,
    email: data.email,
    role: data.role,
    status: 'ACTIVE',
    departmentId: null,
  }));

  const prisma = {
    user: { findFirst, create },
  } as any;

  const jwt = { sign: jest.fn().mockReturnValue('signed-token') } as any;
  const config = {
    get: jest.fn().mockReturnValue(4),
  } as unknown as ConfigService;
  const throttle = new LoginThrottleService(config);

  const service = new AuthService(prisma, jwt, config, throttle);
  return { service, prisma, jwt, throttle, findFirst, create };
}

describe('AuthService', () => {
  it('normalises the e-mail on signup', async () => {
    const { service, create } = makeService();
    await service.signup({
      name: 'Ada',
      email: '  Ada@Example.COM ',
      password: 'password123',
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'ada@example.com',
          role: Role.EMPLOYEE,
        }),
      }),
    );
  });

  it('rejects a duplicate e-mail regardless of casing', async () => {
    const { service } = makeService({
      existing: {
        id: 'u1',
        name: 'Ada',
        email: 'ada@example.com',
        role: Role.EMPLOYEE,
        status: 'ACTIVE',
        departmentId: null,
        passwordHash: VALID_HASH,
      },
    });

    await expect(
      service.signup({
        name: 'Ada',
        email: 'ADA@example.com',
        password: 'password123',
      } as any),
    ).rejects.toThrow(/already exists/i);
  });

  it('never grants a role at signup', async () => {
    const { service, create } = makeService();
    await service.signup({
      name: 'Mallory',
      email: 'mallory@example.com',
      password: 'password123',
      role: 'ADMIN',
    } as any);

    const data = create.mock.calls[0][0].data;
    expect(data.role).toBe(Role.EMPLOYEE);
  });

  it('looks the user up case-insensitively on login', async () => {
    const { service, findFirst } = makeService();
    await service
      .login(
        {
          email: 'ADA@example.com',
          password: 'assetflow-timing-equalizer',
        } as any,
        '1.2.3.4',
      )
      .catch(() => undefined);

    expect(findFirst).toHaveBeenCalledWith({
      where: { email: { equals: 'ada@example.com', mode: 'insensitive' } },
    });
  });

  it('returns the same error for an unknown account and a wrong password', async () => {
    const unknown = makeService({ user: null });
    const wrong = makeService();

    const errorOf = async (svc: ReturnType<typeof makeService>) => {
      try {
        await svc.service.login(
          { email: 'ada@example.com', password: 'nope' },
          '1.2.3.4',
        );
        return null;
      } catch (err) {
        return (err as Error).message;
      }
    };

    const a = await errorOf(unknown);
    const b = await errorOf(wrong);
    expect(a).toBe(b);
    expect(a).toMatch(/invalid email or password/i);
  });

  it('refuses a deactivated account', async () => {
    const { service } = makeService({
      user: {
        id: 'u1',
        name: 'Ada',
        email: 'ada@example.com',
        role: Role.EMPLOYEE,
        status: 'INACTIVE',
        departmentId: null,
        passwordHash: VALID_HASH,
      },
    });

    await expect(
      service.login(
        {
          email: 'ada@example.com',
          password: 'assetflow-timing-equalizer',
        } as any,
        '1.2.3.4',
      ),
    ).rejects.toThrow(/deactivated/i);
  });

  it('never leaks the password hash', async () => {
    const { service } = makeService();
    const res = await service.login(
      {
        email: 'ada@example.com',
        password: 'assetflow-timing-equalizer',
      },
      '1.2.3.4',
    );
    expect(res.user).not.toHaveProperty('passwordHash');
    expect(res.token).toBe('signed-token');
  });
});
