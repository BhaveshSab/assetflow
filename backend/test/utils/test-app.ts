/**
 * Shared helpers for the end-to-end suites: booting the Nest app, seeding
 * fixtures and talking to the API with supertest.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from '../../src/app.module';
import { LoginThrottleService } from '../../src/auth/login-throttle.service';
import { configureApp } from '../../src/configure-app';
import { hashPassword } from '../../src/common/security/password';
import { PrismaService } from '../../src/prisma/prisma.service';

export const DEFAULT_PASSWORD = 'password123';

/** Boot the real application (all modules, guards and pipes included). */
export async function createTestApp(): Promise<INestApplication<App>> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  return app;
}

/** Wipe every table so each suite starts from a clean slate. */
export async function resetDatabase(app: INestApplication) {
  const prisma = app.get(PrismaService);
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Notification", "ActivityLog", "AuditItem", "AuditAssignment", "AuditCycle", "MaintenanceRequest", "Booking", "TransferRequest", "Allocation", "Asset", "AssetCategory", "Department", "User" CASCADE',
  );

  // The brute-force counter is in-process — clear it between tests so one
  // suite cannot lock another one out.
  await app.get(LoginThrottleService).reset();
}

export type TestUser = {
  id: string;
  name: string;
  email: string;
  role: Role;
  departmentId: string | null;
};

/** Create a user straight in the database (fast setup, no HTTP round-trip). */
export async function createUser(
  app: INestApplication,
  options: {
    name: string;
    email: string;
    role?: Role;
    departmentId?: string | null;
    status?: 'ACTIVE' | 'INACTIVE';
    password?: string;
  },
): Promise<TestUser> {
  const prisma = app.get(PrismaService);
  const user = await prisma.user.create({
    data: {
      name: options.name,
      email: options.email.toLowerCase(),
      passwordHash: await hashPassword(options.password ?? DEFAULT_PASSWORD, {
        rounds: 4,
      }),
      role: options.role ?? Role.EMPLOYEE,
      status: options.status ?? 'ACTIVE',
      departmentId: options.departmentId ?? null,
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      departmentId: true,
    },
  });
  return user;
}

/** Sign in through the API and return the bearer token. */
export async function login(
  app: INestApplication,
  email: string,
  password = DEFAULT_PASSWORD,
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/auth/login')
    .send({ email, password })
    .expect(200);
  return res.body.token as string;
}

/** Convenience: create a user and immediately sign in. */
export async function createUserWithToken(
  app: INestApplication,
  options: Parameters<typeof createUser>[1],
): Promise<{ user: TestUser; token: string }> {
  const user = await createUser(app, options);
  const token = await login(app, user.email, options.password);
  return { user, token };
}

/** Authenticated request helper. */
export function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

export type Fixtures = {
  it: { id: string; name: string };
  facilities: { id: string; name: string };
  electronics: { id: string; name: string };
  furniture: { id: string; name: string };
};

/** Create the master data every suite needs (2 departments, 2 categories). */
export async function seedFixtures(app: INestApplication): Promise<Fixtures> {
  const prisma = app.get(PrismaService);
  const it = await prisma.department.create({ data: { name: 'IT' } });
  const facilities = await prisma.department.create({
    data: { name: 'Facilities' },
  });
  const electronics = await prisma.assetCategory.create({
    data: { name: 'Electronics' },
  });
  const furniture = await prisma.assetCategory.create({
    data: { name: 'Furniture' },
  });
  return { it, facilities, electronics, furniture };
}

/** Register an asset straight in the database (skips the HTTP round-trip). */
export async function createAsset(
  app: INestApplication,
  options: {
    name: string;
    categoryId: string;
    assetTag?: string;
    isBookable?: boolean;
    location?: string;
    status?:
      | 'AVAILABLE'
      | 'ALLOCATED'
      | 'UNDER_MAINTENANCE'
      | 'RETIRED'
      | 'DISPOSED'
      | 'LOST'
      | 'RESERVED';
  },
) {
  const prisma = app.get(PrismaService);
  return prisma.asset.create({
    data: {
      assetTag:
        options.assetTag ??
        `AF-${Math.floor(Math.random() * 100000)
          .toString()
          .padStart(5, '0')}`,
      name: options.name,
      categoryId: options.categoryId,
      isBookable: options.isBookable ?? false,
      location: options.location ?? 'HQ-1F',
      status: options.status ?? 'AVAILABLE',
    },
  });
}
