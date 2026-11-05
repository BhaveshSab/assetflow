/**
 * The shape of a raw answer from the API.
 *
 * The backend owns these records, so their fields are not written down in
 * the frontend. They used to be typed as `Record<string, any>`, which meant
 * a missing field travelled all the way to the screen as `undefined` and
 * showed up as an empty cell with no explanation.
 *
 * Instead the fields are read through the small helpers below: they always
 * return a value of the right type, so a field that the API did not send
 * becomes an empty string or a zero — never `undefined`.
 */
export type ApiRecord = Record<string, unknown>;

/** A record, or `undefined` — for the fields that may be missing. */
export function isRecord(value: unknown): value is ApiRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value as a string ("" when it is missing or of another type). */
export function str(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

/** The value as a number (0 when it is missing or of another type). */
export function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * A field inside a record, e.g. `field(record, "category", "name")` reads
 * `record.category.name` without the three `?.` in between.
 */
export function field(record: ApiRecord, ...path: string[]): unknown {
  let current: unknown = record;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** The same as `field`, but always as a string. */
export function fieldStr(
  record: ApiRecord,
  fallback = "",
  ...path: string[]
): string {
  return str(field(record, ...path), fallback);
}

/** The same as `field`, but always as a number. */
export function fieldNum(record: ApiRecord, fallback = 0, ...path: string[]): number {
  return num(field(record, ...path), fallback);
}

/**
 * The custom fields of a category: the API sends either a list of strings
 * or a list of `{ key, type }` objects.
 */
export function customFieldKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (isRecord(entry)) return str(entry.key);
      return str(entry);
    })
    .filter(Boolean);
}
