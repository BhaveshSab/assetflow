import { ObjectStore } from './object-store';
import { validSignature } from './attachments.service';
describe('S3 signing and file signatures', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  it('fails closed when private storage is disabled', async () => {
    delete process.env.ATTACHMENTS_ENABLED;
    await expect(
      new ObjectStore().upload('key', 'text/plain', 'hash', 10),
    ).rejects.toThrow('not configured');
  });
  it('signs an exact-length conditional checksum upload and a version-pinned private download without contacting AWS', async () => {
    Object.assign(process.env, {
      ATTACHMENTS_ENABLED: 'true',
      ATTACHMENTS_BUCKET: 'test-private-bucket',
      AWS_REGION: 'ap-southeast-2',
      AWS_ACCESS_KEY_ID: 'test-access',
      AWS_SECRET_ACCESS_KEY: 'test-secret',
    });
    const store = new ObjectStore();
    const url = new URL(
      await store.upload(
        'attachments/asset/id',
        'text/plain',
        Buffer.alloc(32).toString('base64'),
        10,
      ),
    );
    expect(url.searchParams.get('X-Amz-Expires')).toBe('120');
    const signed = url.searchParams.get('X-Amz-SignedHeaders');
    for (const name of [
      'content-length',
      'content-type',
      'if-none-match',
      'x-amz-checksum-sha256',
      'x-amz-server-side-encryption',
    ])
      expect(signed).toContain(name);
    const download = new URL(
      await store.download(
        'attachments/asset/id',
        'immutable-version',
        '../../x.html',
      ),
    );
    expect(download.searchParams.get('versionId')).toBe('immutable-version');
    expect(download.searchParams.get('X-Amz-Expires')).toBe('60');
    expect(
      download.searchParams.get('response-content-disposition'),
    ).not.toContain('/');
    expect(download.searchParams.get('response-content-type')).toBe(
      'application/octet-stream',
    );
  });
  it('checks known binary signatures', () => {
    expect(
      validSignature(
        'image/png',
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      ),
    ).toBe(true);
    expect(validSignature('image/jpeg', Buffer.from([255, 216, 255]))).toBe(
      true,
    );
    expect(validSignature('application/pdf', Buffer.from('%PDF-1.7'))).toBe(
      true,
    );
    expect(validSignature('image/png', Buffer.from('<svg>'))).toBe(false);
    expect(validSignature('text/plain', Buffer.from([65, 0, 66]))).toBe(false);
  });
});
