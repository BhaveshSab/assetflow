/**
 * Translate database constraint violations into HTTP errors.
 *
 * The application checks its invariants before writing (and locks the row it
 * checks), so in normal operation these never fire. They fire when something
 * else writes to the same tables — a script, a migration, a second process that
 * skipped the lock — which is exactly the case the constraints exist for.
 *
 * Without this translation a violation surfaces as a 500 with a Prisma stack
 * trace in the logs. With it, the client gets the same 409/400 it would have
 * received from the application check, and the logs stay quiet.
 */

/** Postgres SQLSTATE codes, which survive the Prisma driver adapters. */
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_CHECK_VIOLATION = '23514';
export const PG_EXCLUSION_VIOLATION = '23P01';

type MaybePrismaError = {
  code?: string;
  message?: string;
  meta?: { target?: unknown; code?: string };
};

/** Narrow an unknown thrown value to the fields Prisma puts on its errors. */
function asError(err: unknown): MaybePrismaError {
  return typeof err === 'object' && err !== null ? err : {};
}

/** `meta.target` is a column list, a constraint name, or absent entirely. */
function targetText(target: unknown): string {
  if (Array.isArray(target)) return target.map(String).join(',');
  if (typeof target === 'string') return target;
  return '';
}

/** Every string Prisma could have put the constraint or column names in. */
function haystack(err: unknown): string {
  const e = asError(err);
  return [e.message ?? '', targetText(e.meta?.target), e.meta?.code ?? ''].join(
    ' ',
  );
}

/** P2002 (Prisma) or 23505 (Postgres) naming one of `constraints`. */
export function isUniqueViolation(
  err: unknown,
  constraints: string[],
): boolean {
  const e = asError(err);
  const uniqueCode = e.code === 'P2002' || e.code === PG_UNIQUE_VIOLATION;
  if (!uniqueCode) return false;
  const text = haystack(err);
  return constraints.some((c) => text.includes(c));
}

/** An EXCLUDE constraint refused the write (two overlapping ranges). */
export function isExclusionViolation(
  err: unknown,
  constraint: string,
): boolean {
  const e = asError(err);
  const text = haystack(err);
  const looksLikeExclusion =
    e.code === PG_EXCLUSION_VIOLATION ||
    e.code === 'P2010' ||
    e.code === 'P2002' || // some driver versions surface EXCLUDE as a unique clash
    /exclusion constraint|conflicting key value violates exclusion/i.test(text);
  return looksLikeExclusion && text.includes(constraint);
}

/** A CHECK constraint refused the write (e.g. endTime before startTime). */
export function isCheckViolation(err: unknown, constraint: string): boolean {
  const e = asError(err);
  const text = haystack(err);
  const looksLikeCheck =
    e.code === PG_CHECK_VIOLATION ||
    e.code === 'P2010' ||
    /violates check constraint/i.test(text);
  return looksLikeCheck && text.includes(constraint);
}
