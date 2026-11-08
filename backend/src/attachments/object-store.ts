import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** SDK credential chain: use an instance/task role, not credentials in source. */
@Injectable()
export class ObjectStore {
  onModuleDestroy() {
    this.client?.destroy();
  }
  private client?: S3Client;
  private get config() {
    const bucket = process.env.ATTACHMENTS_BUCKET;
    const region = process.env.AWS_REGION;
    if (process.env.ATTACHMENTS_ENABLED !== 'true' || !bucket || !region)
      throw new ServiceUnavailableException(
        'Private attachments are not configured',
      );
    this.client ??= new S3Client({ region });
    return { bucket, client: this.client };
  }
  async upload(
    key: string,
    contentType: string,
    checksum: string,
    size: number,
  ) {
    const { bucket, client } = this.config;
    return getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType,
        ContentLength: size,
        ChecksumSHA256: checksum,
        IfNoneMatch: '*',
        ServerSideEncryption: 'AES256',
      }),
      {
        expiresIn: 120,
        unhoistableHeaders: new Set([
          'x-amz-checksum-sha256',
          'x-amz-server-side-encryption',
        ]),
        signableHeaders: new Set([
          'if-none-match',
          'content-type',
          'content-length',
        ]),
      },
    );
  }
  async inspect(key: string) {
    const { bucket, client } = this.config;
    const head = await client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
        ChecksumMode: 'ENABLED',
      }),
    );
    const object = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        VersionId: head.VersionId,
        Range: 'bytes=0-511',
      }),
    );
    return {
      size: head.ContentLength,
      type: head.ContentType,
      checksum: head.ChecksumSHA256,
      version: head.VersionId,
      bytes: await object.Body?.transformToByteArray(),
    };
  }
  async download(key: string, version: string, filename: string) {
    const { bucket, client } = this.config;
    return getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        VersionId: version,
        ResponseContentType: 'application/octet-stream',
        ResponseContentDisposition: `attachment; filename="${filename.replace(/[^a-zA-Z0-9._ -]/g, '_')}"`,
        ResponseCacheControl: 'private, no-store',
      }),
      { expiresIn: 60 },
    );
  }
}
