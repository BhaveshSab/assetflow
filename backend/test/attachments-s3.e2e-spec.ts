/** Explicit opt-in: use a dedicated private VERSIONED test bucket, never backup storage. */
import { INestApplication } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  createTestApp,
  resetDatabase,
  seedFixtures,
  createUserWithToken,
  createAsset,
  auth,
} from './utils/test-app';
const live = process.env.TEST_ATTACHMENTS_BUCKET ? describe : describe.skip;
live(
  'Private attachments against an explicitly configured real S3 test bucket',
  () => {
    let app: INestApplication;
    let token: string;
    let path: string;
    beforeAll(async () => {
      if (!process.env.AWS_REGION)
        throw new Error('AWS_REGION is required for the opt-in S3 test');
      app = await createTestApp({
        ATTACHMENTS_ENABLED: 'true',
        ATTACHMENTS_BUCKET: process.env.TEST_ATTACHMENTS_BUCKET!,
      });
      await resetDatabase(app);
      const fixtures = await seedFixtures(app);
      token = (
        await createUserWithToken(app, {
          name: 'S3 Test',
          email: 's3@example.test',
          role: 'ADMIN',
        })
      ).token;
      const asset = await createAsset(app, {
        name: 'S3 test asset',
        categoryId: fixtures.electronics.id,
      });
      path = `/api/assets/${asset.id}/attachments`;
    });
    afterAll(async () => {
      if (!app) return;
      // Delete only the exact immutable versions created by this isolated test DB.
      const rows = await app.get(PrismaService).attachment.findMany();
      const client = new S3Client({ region: process.env.AWS_REGION });
      try {
        for (const row of rows)
          if (row.versionId)
            await client.send(
              new DeleteObjectCommand({
                Bucket: process.env.TEST_ATTACHMENTS_BUCKET,
                Key: row.objectKey,
                VersionId: row.versionId,
              }),
            );
      } finally {
        client.destroy();
        await app.close();
      }
    });
    it('uploads via the real signed URL, rejects replay, completes verification and downloads the pinned private object', async () => {
      const body = Buffer.from('%PDF-1.7\nAssetFlow integration fixture\n');
      const signed = await request(app.getHttpServer())
        .post(path)
        .set(auth(token))
        .send({
          filename: 'test.pdf',
          contentType: 'application/pdf',
          size: body.length,
          checksum: createHash('sha256').update(body).digest('base64'),
        })
        .expect(201);
      const put = () =>
        fetch(signed.body.uploadUrl, {
          method: 'PUT',
          headers: signed.body.headers,
          body,
        });
      expect((await put()).status).toBe(200);
      expect((await put()).status).toBe(412);
      await request(app.getHttpServer())
        .post(`${path}/${signed.body.id}/complete`)
        .set(auth(token))
        .expect(201);
      const download = await request(app.getHttpServer())
        .post(`${path}/${signed.body.id}/download`)
        .set(auth(token))
        .expect(201);
      const result = await fetch(download.body.url);
      expect(result.status).toBe(200);
      expect(Buffer.from(await result.arrayBuffer())).toEqual(body);
      const unsigned = new URL(download.body.url);
      unsigned.search = '';
      expect((await fetch(unsigned)).status).toBe(403);
      if (process.env.TEST_ATTACHMENTS_ORIGIN) {
        const origin = process.env.TEST_ATTACHMENTS_ORIGIN;
        const preflight = await fetch(signed.body.uploadUrl, {
          method: 'OPTIONS',
          headers: {
            Origin: origin,
            'Access-Control-Request-Method': 'PUT',
            'Access-Control-Request-Headers':
              'content-type,if-none-match,x-amz-checksum-sha256,x-amz-server-side-encryption',
          },
        });
        expect(preflight.ok).toBe(true);
        expect(preflight.headers.get('access-control-allow-origin')).toBe(
          origin,
        );
      }
    });
  },
);
