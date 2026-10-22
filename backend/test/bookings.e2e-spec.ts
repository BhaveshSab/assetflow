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

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

describe('Resource Booking (e2e)', () => {
  let app: INestApplication;
  let fixtures: Fixtures;
  let adminToken: string;
  let employeeToken: string;
  let otherToken: string;

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
    otherToken = (
      await createUserWithToken(app, {
        name: 'Raj',
        email: 'raj@example.com',
        departmentId: fixtures.facilities.id,
      })
    ).token;
  });

  it('books a bookable asset', async () => {
    const asset = await createAsset(app, {
      name: 'Meeting Room B2',
      assetTag: 'AF-0001',
      categoryId: fixtures.furniture.id,
      isBookable: true,
    });

    const res = await request(app.getHttpServer())
      .post('/api/bookings')
      .set(auth(employeeToken))
      .send({
        assetId: asset.id,
        startTime: iso(3600_000),
        endTime: iso(7200_000),
        purpose: 'Stand-up',
      })
      .expect(201);

    expect(res.body.status).toBe('UPCOMING');
    expect(res.body.effectiveStatus).toBe('UPCOMING');
    expect(res.body.bookedBy.email).toBe('priya@example.com');
  });

  it('refuses to book an asset that is not bookable', async () => {
    const asset = await createAsset(app, {
      name: 'Laptop',
      assetTag: 'AF-0002',
      categoryId: fixtures.electronics.id,
      isBookable: false,
    });

    const res = await request(app.getHttpServer())
      .post('/api/bookings')
      .set(auth(employeeToken))
      .send({
        assetId: asset.id,
        startTime: iso(3600_000),
        endTime: iso(7200_000),
      })
      .expect(409);

    expect(String(res.body.message)).toMatch(/not bookable/i);
  });

  it('refuses to book an asset that is out of service', async () => {
    const asset = await createAsset(app, {
      name: 'Projector',
      assetTag: 'AF-0003',
      categoryId: fixtures.electronics.id,
      isBookable: true,
      status: 'UNDER_MAINTENANCE',
    });

    await request(app.getHttpServer())
      .post('/api/bookings')
      .set(auth(employeeToken))
      .send({
        assetId: asset.id,
        startTime: iso(3600_000),
        endTime: iso(7200_000),
      })
      .expect(409);
  });

  it('rejects an overlapping booking (409) but allows touching slots', async () => {
    const asset = await createAsset(app, {
      name: 'Meeting Room',
      assetTag: 'AF-0004',
      categoryId: fixtures.furniture.id,
      isBookable: true,
    });

    await request(app.getHttpServer())
      .post('/api/bookings')
      .set(auth(employeeToken))
      .send({
        assetId: asset.id,
        startTime: iso(3600_000),
        endTime: iso(7200_000),
      })
      .expect(201);

    // Overlapping → 409
    await request(app.getHttpServer())
      .post('/api/bookings')
      .set(auth(otherToken))
      .send({
        assetId: asset.id,
        startTime: iso(5400_000),
        endTime: iso(9000_000),
      })
      .expect(409);

    // Touching boundary (starts exactly when the other ends) → allowed
    await request(app.getHttpServer())
      .post('/api/bookings')
      .set(auth(otherToken))
      .send({
        assetId: asset.id,
        startTime: iso(7200_000),
        endTime: iso(10800_000),
      })
      .expect(201);
  });

  it('rejects a booking in the past', async () => {
    const asset = await createAsset(app, {
      name: 'Meeting Room',
      assetTag: 'AF-0005',
      categoryId: fixtures.furniture.id,
      isBookable: true,
    });

    const res = await request(app.getHttpServer())
      .post('/api/bookings')
      .set(auth(employeeToken))
      .send({
        assetId: asset.id,
        startTime: iso(-7200_000),
        endTime: iso(-3600_000),
      })
      .expect(400);

    expect(String(res.body.message)).toMatch(/future/i);
  });

  it('rejects an inverted time range', async () => {
    const asset = await createAsset(app, {
      name: 'Meeting Room',
      assetTag: 'AF-0006',
      categoryId: fixtures.furniture.id,
      isBookable: true,
    });

    await request(app.getHttpServer())
      .post('/api/bookings')
      .set(auth(employeeToken))
      .send({
        assetId: asset.id,
        startTime: iso(7200_000),
        endTime: iso(3600_000),
      })
      .expect(400);
  });

  it('lets the booker cancel but nobody else', async () => {
    const asset = await createAsset(app, {
      name: 'Meeting Room',
      assetTag: 'AF-0007',
      categoryId: fixtures.furniture.id,
      isBookable: true,
    });
    const booking = await request(app.getHttpServer())
      .post('/api/bookings')
      .set(auth(employeeToken))
      .send({
        assetId: asset.id,
        startTime: iso(3600_000),
        endTime: iso(7200_000),
      })
      .expect(201);

    // A different employee may not cancel it.
    await request(app.getHttpServer())
      .post(`/api/bookings/${booking.body.id}/cancel`)
      .set(auth(otherToken))
      .expect(403);

    // A manager may.
    await request(app.getHttpServer())
      .post(`/api/bookings/${booking.body.id}/cancel`)
      .set(auth(adminToken))
      .expect(200);

    // Cancelling twice is a conflict.
    await request(app.getHttpServer())
      .post(`/api/bookings/${booking.body.id}/cancel`)
      .set(auth(employeeToken))
      .expect(409);
  });

  it('re-schedules a booking and re-validates the overlap', async () => {
    const asset = await createAsset(app, {
      name: 'Meeting Room',
      assetTag: 'AF-0008',
      categoryId: fixtures.furniture.id,
      isBookable: true,
    });
    const booking = await request(app.getHttpServer())
      .post('/api/bookings')
      .set(auth(employeeToken))
      .send({
        assetId: asset.id,
        startTime: iso(3600_000),
        endTime: iso(7200_000),
      })
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/api/bookings/${booking.body.id}/reschedule`)
      .set(auth(employeeToken))
      .send({ startTime: iso(10800_000), endTime: iso(14400_000) })
      .expect(200);

    // The original slot is free again.
    await request(app.getHttpServer())
      .post('/api/bookings')
      .set(auth(otherToken))
      .send({
        assetId: asset.id,
        startTime: iso(3600_000),
        endTime: iso(7200_000),
      })
      .expect(201);
  });

  it('refuses to re-schedule into an occupied slot', async () => {
    const asset = await createAsset(app, {
      name: 'Meeting Room',
      assetTag: 'AF-0009',
      categoryId: fixtures.furniture.id,
      isBookable: true,
    });
    const booking = await request(app.getHttpServer())
      .post('/api/bookings')
      .set(auth(employeeToken))
      .send({
        assetId: asset.id,
        startTime: iso(3600_000),
        endTime: iso(7200_000),
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/bookings')
      .set(auth(otherToken))
      .send({
        assetId: asset.id,
        startTime: iso(10800_000),
        endTime: iso(14400_000),
      })
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/api/bookings/${booking.body.id}/reschedule`)
      .set(auth(employeeToken))
      .send({ startTime: iso(10800_000), endTime: iso(14400_000) })
      .expect(409);
  });

  it('filters the calendar with ?mine=true', async () => {
    const asset = await createAsset(app, {
      name: 'Meeting Room',
      assetTag: 'AF-0010',
      categoryId: fixtures.furniture.id,
      isBookable: true,
    });
    await request(app.getHttpServer())
      .post('/api/bookings')
      .set(auth(employeeToken))
      .send({
        assetId: asset.id,
        startTime: iso(3600_000),
        endTime: iso(7200_000),
      })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/bookings')
      .set(auth(otherToken))
      .send({
        assetId: asset.id,
        startTime: iso(10800_000),
        endTime: iso(14400_000),
      })
      .expect(201);

    const mine = await request(app.getHttpServer())
      .get('/api/bookings?mine=true')
      .set(auth(employeeToken))
      .expect(200);
    expect(mine.body.total).toBe(1);

    const all = await request(app.getHttpServer())
      .get('/api/bookings')
      .set(auth(employeeToken))
      .expect(200);
    expect(all.body.total).toBe(2);
  });
});
