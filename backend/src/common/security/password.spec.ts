import { BCRYPT_MAX_BYTES, hashPassword, verifyPassword } from './password';

describe('password helpers', () => {
  it('hashes and verifies a password', async () => {
    const hash = await hashPassword('password123', { rounds: 4 });
    expect(hash).not.toBe('password123');
    await expect(verifyPassword('password123', hash)).resolves.toBe(true);
    await expect(verifyPassword('password124', hash)).resolves.toBe(false);
  });

  it('never truncates long passwords (bcrypt 72-byte limit)', async () => {
    const base = 'a'.repeat(BCRYPT_MAX_BYTES);
    const longer = `${base}-and-some-more`;

    const hash = await hashPassword(longer, { rounds: 4 });

    // Without pre-hashing, bcrypt would cut both passwords at 72 bytes and
    // they would authenticate each other.
    await expect(verifyPassword(longer, hash)).resolves.toBe(true);
    await expect(verifyPassword(base, hash)).resolves.toBe(false);
  });

  it('still verifies a legacy plain-bcrypt hash', async () => {
    // $2b$10$... — the format used before the pre-hash was introduced.
    const legacy =
      '$2b$10$jWl8m5xNdRFlXlK4AcU1kuRuONp11gwyLA6yPvOvjbwANi8fJqgb2';
    // This hash was created for "assetflow-timing-equalizer".
    await expect(
      verifyPassword('assetflow-timing-equalizer', legacy),
    ).resolves.toBe(true);
    await expect(verifyPassword('something-else', legacy)).resolves.toBe(false);
  });

  it('returns false for an empty hash', async () => {
    await expect(verifyPassword('password123', '')).resolves.toBe(false);
  });
});
