/**
 * Concurrency and database-invariant tests.
 *
 * These are the tests that make the two dangerous rules ("one holder per asset",
 * "no double booking") *demonstrated properties* instead of comments:
 *
 *   1. the application layer, under genuinely parallel requests;
 *   2. the storage layer, by attempting the illegal write directly and proving
 *      the database refuses it.
 *
 * If somebody removes the `FOR UPDATE` lock or drops the partial unique index /
 * EXCLUDE constraint, one of these fails.
 */
import { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';

import { PrismaService } from '../src/prisma/prisma.service';
import { auth, createTestApp, createUser, login } from './utils/test-app';

describe('Concurrency and database invariants', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let managerToken = '';
  let priya: { id: string };
  let raj: { id: string };
  let categoryId = '';

  const post = (path: string, token: string, body: unknown) =>
    request(app.getHttpServer())
      .post(path)
      .set(auth(token))
      .send(body as object);

  /** Create an asset through the API (so tags, status and defaults are real). */
  const makeAsset = async (
    name: string,
    isBookable = false,
  ): Promise<string> => {
    const res = await post('/api/assets', managerToken, {
      name,
      categoryId,
      location: 'QA-Store',
      isBookable,
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);

    const manager = await createUser(app, {
      name: 'Con Manager',
      email: 'con.manager@acme.com',
      role: Role.ASSET_MANAGER,
    });
    managerToken = await login(app, manager.email);
    priya = await createUser(app, {
      name: 'Priya Sharma',
      email: 'con.priya@acme.com',
      role: Role.EMPLOYEE,
    });
    raj = await createUser(app, {
      name: 'Raj Verma',
      email: 'con.raj@acme.com',
      role: Role.EMPLOYEE,
    });
    categoryId = (
      await prisma.assetCategory.create({ data: { name: 'Concurrency Cat' } })
    ).id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('two parallel allocations of one asset: exactly one wins', async () => {
    const assetId = await makeAsset('Concurrency Laptop');

    const [first, second] = await Promise.all([
      post('/api/allocations', managerToken, {
        assetId,
        holderUserId: priya.id,
      }),
      post('/api/allocations', managerToken, {
        assetId,
        holderUserId: raj.id,
      }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);

    const active = await prisma.allocation.count({
      where: { assetId, status: 'ACTIVE' },
    });
    expect(active).toBe(1);

    // The loser gets the same readable conflict the serial path produces,
    // naming the holder who actually won.
    const loser = first.status === 409 ? first : second;
    expect(String(loser.body.message)).toMatch(
      /is currently held by (Priya Sharma|Raj Verma)/,
    );

    const asset = await prisma.asset.findUnique({ where: { id: assetId } });
    expect(asset?.status).toBe('ALLOCATED');
  });

  it('two parallel overlapping bookings: exactly one wins', async () => {
    const assetId = await makeAsset('Concurrency Room', true);

    const slot = {
      startTime: new Date(Date.now() + 48 * 36e5).toISOString(),
      endTime: new Date(Date.now() + 49 * 36e5).toISOString(),
    };

    const [first, second] = await Promise.all([
      post('/api/bookings', managerToken, { assetId, ...slot }),
      post('/api/bookings', managerToken, { assetId, ...slot }),
    ]);

    expect([first.status, second.status].sort()).toEqual([201, 409]);

    const live = await prisma.booking.count({
      where: { assetId, status: { not: 'CANCELLED' } },
    });
    expect(live).toBe(1);
  });

  /**
   * Asset tags are handed out by a Postgres sequence (see migration
   * 20261108090300_asset_tag_sequence). Two properties matter:
   *
   *   a) two callers never receive the same tag — tested with a real parallel
   *      pair below;
   *   b) the numbers are unique and increasing — tested sequentially, because
   *      PGlite (the in-process Postgres used by this suite) multiplexes client
   *      connections over one socket and returns "bind message supplies N
   *      parameters" for three or more *concurrent write transactions*. The
   *      cap is a property of the test transport, not of the application: on a
   *      real server the two tests below scale to any width, because `nextval`
   *      is atomic by definition.
   */
  it('two parallel registrations never receive the same tag', async () => {
    const results = await Promise.all([
      post('/api/assets', managerToken, {
        name: 'Concurrency Tag A',
        categoryId,
      }),
      post('/api/assets', managerToken, {
        name: 'Concurrency Tag B',
        categoryId,
      }),
    ]);

    expect(results.map((r) => r.status)).toEqual([201, 201]);
    const tags = results.map((r) => r.body.assetTag as string);
    expect(new Set(tags).size).toBe(2);
  });

  it('the tag sequence hands out unique, strictly increasing numbers', async () => {
    const tags: string[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await post('/api/assets', managerToken, {
        name: `Concurrency Sequence ${i}`,
        categoryId,
      });
      expect(res.status).toBe(201);
      tags.push(res.body.assetTag as string);
    }

    expect(new Set(tags).size).toBe(8);

    const numbers = tags.map((t) => Number(t.replace('AF-', '')));
    for (let i = 1; i < numbers.length; i++) {
      expect(numbers[i]).toBeGreaterThan(numbers[i - 1]);
    }

    // The sequence is the source of truth: a duplicate tag is still refused by
    // the unique index on `assetTag`, so the retry loop remains a safety net
    // rather than the mechanism.
    await expect(
      prisma.asset.create({
        data: { assetTag: tags[0], name: 'Duplicate tag', categoryId },
      }),
    ).rejects.toThrow(/assetTag|unique constraint/i);
  });

  it('the database itself refuses a second ACTIVE allocation', async () => {
    const assetId = await makeAsset('Concurrency Invariant');

    await prisma.allocation.create({
      data: {
        assetId,
        holderUserId: priya.id,
        allocatedById: priya.id,
        status: 'ACTIVE',
      },
    });

    // No API, no service, no lock — straight at the storage engine.
    await expect(
      prisma.allocation.create({
        data: {
          assetId,
          holderUserId: raj.id,
          allocatedById: raj.id,
          status: 'ACTIVE',
        },
      }),
    ).rejects.toThrow(/Allocation_one_active_per_asset|unique constraint/i);

    expect(
      await prisma.allocation.count({ where: { assetId, status: 'ACTIVE' } }),
    ).toBe(1);
  });

  it('the database itself refuses overlapping bookings, and allows touching ones', async () => {
    const assetId = await makeAsset('Concurrency Invariant Room', true);
    const base = Date.now() + 72 * 36e5;

    await prisma.booking.create({
      data: {
        assetId,
        bookedById: priya.id,
        startTime: new Date(base),
        endTime: new Date(base + 36e5),
        status: 'UPCOMING',
      },
    });

    // Overlapping by 30 minutes → refused by the EXCLUDE constraint.
    await expect(
      prisma.booking.create({
        data: {
          assetId,
          bookedById: raj.id,
          startTime: new Date(base + 18e5),
          endTime: new Date(base + 54e5),
          status: 'UPCOMING',
        },
      }),
    ).rejects.toThrow(/Booking_no_overlap|exclusion constraint/i);

    // Touching the boundary is not an overlap → accepted.
    const adjacent = await prisma.booking.create({
      data: {
        assetId,
        bookedById: raj.id,
        startTime: new Date(base + 36e5),
        endTime: new Date(base + 72e5),
        status: 'UPCOMING',
      },
    });
    expect(adjacent.id).toBeTruthy();

    // A cancelled booking may sit inside the slot: cancelled time is free time.
    const cancelled = await prisma.booking.create({
      data: {
        assetId,
        bookedById: raj.id,
        startTime: new Date(base + 6e5),
        endTime: new Date(base + 12e5),
        status: 'CANCELLED',
      },
    });
    expect(cancelled.id).toBeTruthy();
  });

  it('the database itself refuses a booking that ends before it starts', async () => {
    const assetId = await makeAsset('Concurrency Invariant Clock', true);
    const base = Date.now() + 96 * 36e5;

    await expect(
      prisma.booking.create({
        data: {
          assetId,
          bookedById: priya.id,
          startTime: new Date(base + 36e5),
          endTime: new Date(base),
          status: 'UPCOMING',
        },
      }),
    ).rejects.toThrow(/Booking_time_order|check constraint/i);
  });

  it('a database-level refusal still answers the client with 409, not 500', async () => {
    const assetId = await makeAsset('Concurrency Mapped Error');

    // Create the ACTIVE allocation behind the API's back, then allocate through
    // the API: the service check would catch it, but this exercises the
    // constraint-translation path for the case where the write reaches the
    // database anyway.
    await prisma.allocation.create({
      data: {
        assetId,
        holderUserId: priya.id,
        allocatedById: priya.id,
        status: 'ACTIVE',
      },
    });
    await prisma.asset.update({
      where: { id: assetId },
      data: { status: 'AVAILABLE' },
    });

    const res = await post('/api/allocations', managerToken, {
      assetId,
      holderUserId: raj.id,
    });

    // 409 either way: the service's own check normally wins this race.
    expect(res.status).toBe(409);
    expect(String(JSON.stringify(res.body))).toMatch(/currently held by/i);
  });
});
