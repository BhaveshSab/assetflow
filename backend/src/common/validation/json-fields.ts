import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

/**
 * Validators for the two free-form JSON columns of the asset model.
 *
 * Both columns are stored as `Json`, so class-validator cannot describe them
 * with a plain decorator — without these checks a client could store an
 * arbitrarily large / deeply nested payload (a DoS through the JSON column) or
 * smuggle executable content into a field that is later rendered.
 */

/** Maximum number of document links per asset. */
export const MAX_DOCUMENTS = 20;
/** Maximum number of custom field values per asset. */
export const MAX_CUSTOM_FIELDS = 50;
/** Maximum length of a single document name / URL / custom value. */
export const MAX_JSON_STRING = 2048;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

/** Only http(s) URLs and root-relative paths are allowed. */
function isSafeUrl(value: string): boolean {
  if (value.startsWith('/')) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * `documents` must be an array of `{ name, url }` objects with sane sizes.
 */
export function IsDocumentList(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isDocumentList',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          if (value === undefined || value === null) return true;
          if (!Array.isArray(value)) return false;
          if (value.length > MAX_DOCUMENTS) return false;

          return value.every((entry) => {
            if (!isPlainObject(entry)) return false;
            const { name, url } = entry;
            if (typeof name !== 'string' || name.length === 0) return false;
            if (name.length > MAX_JSON_STRING) return false;
            if (typeof url !== 'string' || url.length === 0) return false;
            if (url.length > MAX_JSON_STRING) return false;
            return isSafeUrl(url);
          });
        },
        defaultMessage(args: ValidationArguments) {
          return (
            `${args.property} must be an array of at most ${MAX_DOCUMENTS} ` +
            `{ name, url } objects (http(s) URL or root-relative path)`
          );
        },
      },
    });
  };
}

/**
 * `customFieldValues` must be a flat object of scalar values (string, number
 * or boolean) — no nested objects, arrays, or exotic types.
 */
export function IsCustomFieldMap(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isCustomFieldMap',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          if (value === undefined || value === null) return true;
          if (!isPlainObject(value)) return false;

          const entries = Object.entries(value);
          if (entries.length > MAX_CUSTOM_FIELDS) return false;

          return entries.every(([key, val]) => {
            if (key.length === 0 || key.length > 128) return false;
            if (typeof val === 'string') return val.length <= MAX_JSON_STRING;
            if (typeof val === 'number') return Number.isFinite(val);
            return typeof val === 'boolean';
          });
        },
        defaultMessage(args: ValidationArguments) {
          return (
            `${args.property} must be an object with at most ${MAX_CUSTOM_FIELDS} ` +
            `scalar (string | number | boolean) values`
          );
        },
      },
    });
  };
}
