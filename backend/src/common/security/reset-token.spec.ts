import {
  RESET_TOKEN_TTL_MINUTES,
  hashResetToken,
  isExpired,
  issueResetToken,
  resetUrl,
  tokensMatch,
} from './reset-token';

describe('reset tokens', () => {
  it('mints a 256-bit, URL-safe token that is not what gets stored', () => {
    const issued = issueResetToken();

    // base64url of 32 bytes = 43 characters, alphabet-safe for a query string.
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // 32 bytes of entropy, encoded: the token cannot be guessed.
    expect(Buffer.from(issued.token, 'base64url')).toHaveLength(32);

    expect(issued.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(issued.hash).not.toBe(issued.token);
    expect(issued.hash).toBe(hashResetToken(issued.token));
  });

  it('never repeats a token', () => {
    const tokens = new Set(
      Array.from({ length: 200 }, () => issueResetToken().token),
    );
    expect(tokens.size).toBe(200);
  });

  it('expires 30 minutes after it was minted', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const issued = issueResetToken(now);

    expect(issued.expiresAt.toISOString()).toBe(
      new Date(now.getTime() + RESET_TOKEN_TTL_MINUTES * 60_000).toISOString(),
    );
    expect(isExpired(issued.expiresAt, now)).toBe(false);
    expect(
      isExpired(issued.expiresAt, new Date(issued.expiresAt.getTime() + 1)),
    ).toBe(true);
  });

  it('treats exactly the expiry instant as expired', () => {
    const now = new Date();
    expect(isExpired(now, now)).toBe(true);
  });

  it('compares digests without leaking a prefix match', () => {
    const hash = hashResetToken('one');
    expect(tokensMatch(hash, hashResetToken('one'))).toBe(true);
    expect(tokensMatch(hash, hashResetToken('two'))).toBe(false);
    // Different lengths must be false, not an exception from timingSafeEqual.
    expect(tokensMatch(hash, 'abc')).toBe(false);
  });

  it('builds the link against the front end, with or without a trailing slash', () => {
    const token = 'abc-123';
    expect(resetUrl('https://assetflow.app', token)).toBe(
      'https://assetflow.app/reset-password?token=abc-123',
    );
    expect(resetUrl('https://assetflow.app/', token)).toBe(
      'https://assetflow.app/reset-password?token=abc-123',
    );
    // Tokens are base64url, so nothing needs escaping — but the URL stays
    // correct if that ever changes.
    expect(resetUrl('https://assetflow.app', 'a b')).toContain('token=a%20b');
  });
});
