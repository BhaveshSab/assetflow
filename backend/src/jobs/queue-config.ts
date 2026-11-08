/** Dedicated persistent Redis, deliberately not REDIS_URL (rate-limit LRU).
 * Never include this URL or Redis error messages in logs/API responses.
 */
export function queueConnection(url: string | undefined) {
  if (!url) throw new Error('JOBS_REDIS_URL is required for the worker');
  const parsed = new URL(url);
  if (!['redis:', 'rediss:'].includes(parsed.protocol))
    throw new Error('Use redis:// or rediss:// for jobs');
  const db = Number(parsed.pathname.slice(1) || 0);
  if (!Number.isInteger(db) || db < 0)
    throw new Error('Invalid jobs Redis database');
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db,
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
    connectTimeout: 5000,
  };
}
