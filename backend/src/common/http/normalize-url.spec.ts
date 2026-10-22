import { normalizeUrl } from './normalize-url';

describe('normalizeUrl', () => {
  it('leaves a normal API path untouched', () => {
    expect(normalizeUrl('/api/assets')).toBe('/api/assets');
    expect(normalizeUrl('/api/health')).toBe('/api/health');
  });

  it('maps the function file onto the API root', () => {
    expect(normalizeUrl('/api/index.js')).toBe('/api');
  });

  it('maps a sub-path of the function file onto the API', () => {
    expect(normalizeUrl('/api/index.js/assets')).toBe('/api/assets');
    expect(normalizeUrl('/api/index.js/org/departments')).toBe(
      '/api/org/departments',
    );
  });

  it('keeps the query string', () => {
    expect(normalizeUrl('/api/index.js?take=10')).toBe('/api?take=10');
    expect(normalizeUrl('/api/index.js/assets?q=laptop&take=5')).toBe(
      '/api/assets?q=laptop&take=5',
    );
  });

  it('does not touch an empty url', () => {
    expect(normalizeUrl(undefined)).toBeUndefined();
    expect(normalizeUrl('')).toBe('');
  });
});
