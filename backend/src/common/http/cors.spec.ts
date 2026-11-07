import {
  corsHeadersFor,
  isOriginAllowed,
  LOCAL_DEV_ORIGINS,
  parseOrigins,
} from './cors';

describe('parseOrigins', () => {
  it('splits, trims and de-duplicates the list', () => {
    expect(
      parseOrigins(
        ' https://a.example , https://b.example ,https://a.example ',
      ),
    ).toEqual(['https://a.example', 'https://b.example']);
  });

  it('drops the trailing slash a browser never sends', () => {
    // `https://app.example.com/` would otherwise match nothing at all, which
    // is the classic "the value looks right but everything is blocked" bug.
    expect(parseOrigins('https://app.example.com/')).toEqual([
      'https://app.example.com',
    ]);
  });

  it('falls back to the local dev ports when the variable is empty', () => {
    expect(parseOrigins(undefined)).toEqual([...LOCAL_DEV_ORIGINS]);
    expect(parseOrigins('')).toEqual([...LOCAL_DEV_ORIGINS]);
    expect(parseOrigins('   ')).toEqual([...LOCAL_DEV_ORIGINS]);
    expect(parseOrigins(',,')).toEqual([...LOCAL_DEV_ORIGINS]);
  });
});

describe('isOriginAllowed', () => {
  const origins = parseOrigins('https://app.example.com');

  it('allows a listed origin', () => {
    expect(isOriginAllowed('https://app.example.com', origins)).toBe(true);
  });

  it('tolerates the trailing slash on the incoming value too', () => {
    expect(isOriginAllowed('https://app.example.com/', origins)).toBe(true);
  });

  it('refuses an unlisted origin', () => {
    expect(isOriginAllowed('https://spa.vercel.app', origins)).toBe(false);
  });

  it('refuses a look-alike host', () => {
    expect(isOriginAllowed('https://app.example.com.evil.test', origins)).toBe(
      false,
    );
    expect(isOriginAllowed('http://app.example.com', origins)).toBe(false);
  });

  it('allows requests without an Origin header', () => {
    // Not a cross-origin browser call: curl, a health probe, server-to-server.
    expect(isOriginAllowed(undefined, origins)).toBe(true);
  });

  it('honours a wildcard entry', () => {
    expect(isOriginAllowed('https://anything.test', parseOrigins('*'))).toBe(
      true,
    );
  });
});

describe('corsHeadersFor', () => {
  const origins = parseOrigins('https://app.example.com');

  it('echoes an allowed origin and allows credentials', () => {
    expect(corsHeadersFor('https://app.example.com', origins)).toEqual({
      Vary: 'Origin',
      'Access-Control-Allow-Origin': 'https://app.example.com',
      'Access-Control-Allow-Credentials': 'true',
    });
  });

  it('sends no allow-origin header for a refused origin', () => {
    expect(corsHeadersFor('https://spa.vercel.app', origins)).toEqual({
      Vary: 'Origin',
    });
  });

  it('sends nothing when there is no origin', () => {
    expect(corsHeadersFor(undefined, origins)).toEqual({});
  });
});
