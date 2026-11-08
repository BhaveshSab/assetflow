import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { ObjectStore } from '../src/attachments/object-store';
import { processImport } from '../src/imports/import-processor';
import {
  createTestApp,
  resetDatabase,
  seedFixtures,
  createUserWithToken,
  createAsset,
  auth,
  type Fixtures,
} from './utils/test-app';

describe('Asset extensions: HTTP + migrated Postgres, mocked S3 boundary', () => {
  let app: INestApplication;
  let db: PrismaService;
  let fixtures: Fixtures;
  let admin: string;
  let employee: string;
  let manager: string;
  let employeeId: string;
  let assetId: string;
  let tag: string;
  const checksum = Buffer.alloc(32).toString('base64');
  const upload = {
    filename: 'manual.pdf',
    contentType: 'application/pdf',
    size: 10,
    checksum,
  };
  const object = {
    size: 10,
    type: 'application/pdf',
    checksum,
    version: 'version-1',
    bytes: Buffer.from('%PDF-hello'),
  };
  beforeAll(async () => {
    app = await createTestApp({ JOBS_ENABLED: 'true' });
    db = app.get(PrismaService);
    jest
      .spyOn(app.get(ObjectStore), 'upload')
      .mockResolvedValue('https://s3.example/signed-upload');
    jest
      .spyOn(app.get(ObjectStore), 'download')
      .mockResolvedValue('https://s3.example/signed-download');
    jest.spyOn(app.get(ObjectStore), 'inspect').mockResolvedValue(object);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDatabase(app);
    fixtures = await seedFixtures(app);
    admin = (
      await createUserWithToken(app, {
        name: 'Admin',
        email: 'admin@extensions.test',
        role: 'ADMIN',
      })
    ).token;
    manager = (
      await createUserWithToken(app, {
        name: 'Manager',
        email: 'manager@extensions.test',
        role: 'ASSET_MANAGER',
      })
    ).token;
    const e = await createUserWithToken(app, {
      name: 'Employee',
      email: 'employee@extensions.test',
    });
    employee = e.token;
    employeeId = e.user.id;
    const asset = await createAsset(app, {
      name: 'Laptop',
      categoryId: fixtures.electronics.id,
    });
    assetId = asset.id;
    tag = asset.assetTag;
    jest.spyOn(app.get(ObjectStore), 'inspect').mockResolvedValue(object);
  });
  const path = () => `/api/assets/${assetId}/attachments`;
  const begin = async () =>
    (
      await request(app.getHttpServer())
        .post(path())
        .set(auth(admin))
        .send(upload)
        .expect(201)
    ).body.id as string;
  it('requires authentication/management and rejects unsafe uploads', async () => {
    await request(app.getHttpServer()).get(path()).expect(401);
    await request(app.getHttpServer())
      .post(path())
      .set(auth(employee))
      .send(upload)
      .expect(403);
    for (const invalid of [
      { size: 5242881 },
      { filename: '../evil.html' },
      { contentType: 'text/html' },
    ])
      await request(app.getHttpServer())
        .post(path())
        .set(auth(admin))
        .send({ ...upload, ...invalid })
        .expect(400);
  });
  it('verifies before exposing a private, version-pinned attachment; deletion and cross-asset access are enforced', async () => {
    const id = await begin();
    await request(app.getHttpServer())
      .post(`${path()}/${id}/download`)
      .set(auth(employee))
      .expect(409);
    for (let i = 0; i < 2; i++)
      await request(app.getHttpServer())
        .post(`${path()}/${id}/complete`)
        .set(auth(admin))
        .expect(201);
    const list = await request(app.getHttpServer())
      .get(path())
      .set(auth(employee))
      .expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].objectKey).toBeUndefined();
    await request(app.getHttpServer())
      .post(`${path()}/${id}/download`)
      .set(auth(employee))
      .expect(201);
    expect(jest.spyOn(app.get(ObjectStore), 'download')).toHaveBeenCalledWith(
      expect.any(String),
      'version-1',
      'manual.pdf',
    );
    await request(app.getHttpServer())
      .post(`/api/assets/another/attachments/${id}/download`)
      .set(auth(admin))
      .expect(404);
    await request(app.getHttpServer())
      .delete(`${path()}/${id}`)
      .set(auth(employee))
      .expect(403);
    await request(app.getHttpServer())
      .delete(`${path()}/${id}`)
      .set(auth(admin))
      .expect(200);
    await request(app.getHttpServer())
      .post(`${path()}/${id}/download`)
      .set(auth(admin))
      .expect(404);
    expect(
      await db.activityLog.count({ where: { action: 'attachment.created' } }),
    ).toBe(1);
  });
  it.each([
    { size: 99 },
    { type: 'text/html' },
    { checksum: 'wrong' },
    { version: undefined },
    { version: 'null' },
    { bytes: Buffer.from('<html>bad') },
  ])(
    'rejects incorrect object metadata/signature/version: %j',
    async (change) => {
      const id = await begin();
      jest
        .spyOn(app.get(ObjectStore), 'inspect')
        .mockResolvedValue({ ...object, ...change });
      await request(app.getHttpServer())
        .post(`${path()}/${id}/complete`)
        .set(auth(admin))
        .expect(400);
      expect(
        (await db.attachment.findUniqueOrThrow({ where: { id } })).status,
      ).toBe('PENDING');
    },
  );
  it('rejects expired uploads', async () => {
    const id = await begin();
    await db.attachment.update({
      where: { id },
      data: { expiresAt: new Date(0) },
    });
    await request(app.getHttpServer())
      .post(`${path()}/${id}/complete`)
      .set(auth(admin))
      .expect(409);
  });
  const csv = () =>
    `name,categoryId,condition,isBookable\n"Laptop, imported",${fixtures.electronics.id},GOOD,true\nChair,${fixtures.furniture.id},NEW,false`;
  const preview = async (token = admin) =>
    (
      await request(app.getHttpServer())
        .post('/api/asset-imports/preview')
        .set(auth(token))
        .send({ csv: csv() })
        .expect(201)
    ).body;
  const transition = async (
    id: string,
    action: string,
    token = admin,
    status = 201,
  ) =>
    request(app.getHttpServer())
      .post(`/api/asset-imports/${id}/${action}`)
      .set(auth(token))
      .expect(status);
  it('previews without side effects; confirmation and redelivery are idempotent', async () => {
    const p = await preview();
    expect(p.errors).toEqual([]);
    expect(p.total).toBe(2);
    expect(await db.asset.count()).toBe(1);
    await transition(p.id, 'confirm');
    await transition(p.id, 'confirm');
    await processImport(db, p.id, 0);
    await processImport(db, p.id, 0);
    expect(await db.asset.count()).toBe(3);
    expect(
      (await db.asset.findMany({ orderBy: { assetTag: 'asc' } })).map(
        (a) => a.assetTag,
      ),
    ).toEqual(
      [0, 1, 2].map(
        (i) => `AF-${String(Number(tag.slice(3)) + i).padStart(4, '0')}`,
      ),
    );
    const job = await request(app.getHttpServer())
      .get(`/api/asset-imports/${p.id}`)
      .set(auth(admin))
      .expect(200);
    expect(job.body.status).toBe('DONE');
    expect(job.body.imported).toBe(2);
    expect(job.body.rows).toBeUndefined();
    expect(
      await db.activityLog.count({
        where: { action: 'asset.import_completed' },
      }),
    ).toBe(1);
  });
  it('rolls back assets, counter and completion when the database rejects a batch', async () => {
    const p = await preview();
    await transition(p.id, 'confirm');
    const before = await db.assetTagCounter.findUniqueOrThrow({
      where: { id: 1 },
    });
    await db.$executeRawUnsafe(
      `ALTER TABLE "Asset" ADD CONSTRAINT "test_import_rejection" CHECK (name <> 'Chair')`,
    );
    try {
      await expect(processImport(db, p.id, 0)).rejects.toThrow();
      expect(await db.asset.count()).toBe(1);
      expect(
        (await db.assetTagCounter.findUniqueOrThrow({ where: { id: 1 } }))
          .value,
      ).toBe(before.value);
      expect(
        (await db.assetImport.findUniqueOrThrow({ where: { id: p.id } }))
          .imported,
      ).toBe(0);
    } finally {
      await db.$executeRawUnsafe(
        'ALTER TABLE "Asset" DROP CONSTRAINT "test_import_rejection"',
      );
    }
    await processImport(db, p.id, 0);
    expect(await db.asset.count()).toBe(3);
  });
  it('returns row errors and rejects malformed, duplicate/unknown-header and oversized CSV', async () => {
    const p = await request(app.getHttpServer())
      .post('/api/asset-imports/preview')
      .set(auth(admin))
      .send({ csv: 'name,categoryId,isBookable\n=BAD,no-category,maybe' })
      .expect(201);
    expect(p.body.id).toBeNull();
    expect(p.body.errors.length).toBeGreaterThanOrEqual(3);
    for (const text of [
      'name,categoryId\n"broken',
      'name,role\nA,ADMIN',
      'name,name,categoryId\nA,B,C',
      'name,categoryId\n' + Array(201).fill('A,B').join('\n'),
    ])
      await request(app.getHttpServer())
        .post('/api/asset-imports/preview')
        .set(auth(admin))
        .send({ csv: text })
        .expect(400);
    expect(await db.assetImport.count()).toBe(0);
  });
  it('enforces roles/ownership and cancellation fences late delivery', async () => {
    await request(app.getHttpServer())
      .post('/api/asset-imports/preview')
      .set(auth(employee))
      .send({ csv: csv() })
      .expect(403);
    const p = await preview();
    await request(app.getHttpServer())
      .get(`/api/asset-imports/${p.id}`)
      .set(auth(manager))
      .expect(403);
    await transition(p.id, 'confirm');
    await transition(p.id, 'cancel');
    await processImport(db, p.id, 0);
    expect(await db.asset.count()).toBe(1);
  });
  it('revalidates categories, rolls back the whole batch and fences manual retries', async () => {
    const p = await preview();
    await transition(p.id, 'confirm');
    await db.assetCategory.update({
      where: { id: fixtures.furniture.id },
      data: { status: 'INACTIVE' },
    });
    await processImport(db, p.id, 0);
    expect(
      (await db.assetImport.findUniqueOrThrow({ where: { id: p.id } })).status,
    ).toBe('FAILED');
    expect(await db.asset.count()).toBe(1);
    await db.assetCategory.update({
      where: { id: fixtures.furniture.id },
      data: { status: 'ACTIVE' },
    });
    await transition(p.id, 'retry');
    await processImport(db, p.id, 0);
    expect(await db.asset.count()).toBe(1);
    await processImport(db, p.id, 1);
    expect(await db.asset.count()).toBe(3);
    const stale = await preview();
    await db.assetImport.update({
      where: { id: stale.id },
      data: { createdAt: new Date(0) },
    });
    await transition(stale.id, 'confirm', admin, 400);
  });
  it('rechecks owner roles and bounds durable attempts after Redis loss', async () => {
    const p = await preview(manager);
    await transition(p.id, 'confirm', manager);
    const job = await db.assetImport.findUniqueOrThrow({ where: { id: p.id } });
    await db.user.update({
      where: { id: job.ownerId },
      data: { role: 'EMPLOYEE' },
    });
    await processImport(db, p.id, 0);
    expect(await db.asset.count()).toBe(1);
    const exhausted = await preview();
    await db.assetImport.update({
      where: { id: exhausted.id },
      data: { status: 'QUEUED', attempts: 3 },
    });
    await processImport(db, exhausted.id, 0);
    expect(
      (await db.assetImport.findUniqueOrThrow({ where: { id: exhausted.id } }))
        .status,
    ).toBe('FAILED');
  });
  it('QR lookup authenticates and validates; scan only resolves an in-cycle item, with explicit authorized marking', async () => {
    await request(app.getHttpServer())
      .get(`/api/assets/lookup/by-tag?tag=${tag}`)
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/assets/lookup/by-tag?tag=https://evil.example')
      .set(auth(admin))
      .expect(400);
    const found = await request(app.getHttpServer())
      .get(`/api/assets/lookup/by-tag?tag=${tag}`)
      .set(auth(employee))
      .expect(200);
    expect(found.body.id).toBe(assetId);
    const cycle = await request(app.getHttpServer())
      .post('/api/audits')
      .set(auth(admin))
      .send({
        name: 'QR audit',
        startDate: '2026-10-01',
        endDate: '2026-10-31',
      })
      .expect(201);
    const id = cycle.body.id;
    await request(app.getHttpServer())
      .post(`/api/audits/${id}/scan`)
      .set(auth(employee))
      .send({ tag })
      .expect(403);
    await db.auditAssignment.create({
      data: { auditCycleId: id, auditorId: employeeId },
    });
    const scanned = await request(app.getHttpServer())
      .post(`/api/audits/${id}/scan`)
      .set(auth(employee))
      .send({ tag })
      .expect(201);
    expect(scanned.body.result).toBe('PENDING');
    await request(app.getHttpServer())
      .patch(`/api/audits/${id}/items/${scanned.body.id}`)
      .set(auth(employee))
      .send({ result: 'VERIFIED' })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/audits/${id}/scan`)
      .set(auth(employee))
      .send({ tag: 'AF-999999' })
      .expect(404);
    await request(app.getHttpServer())
      .post(`/api/audits/${id}/close`)
      .set(auth(admin))
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/audits/${id}/scan`)
      .set(auth(employee))
      .send({ tag })
      .expect(409);
  });
});
