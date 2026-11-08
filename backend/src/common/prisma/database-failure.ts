import { Prisma } from '@prisma/client';

export interface DatabaseFailure {
  status: number;
  code: string;
  message: string;
}
/** Public-safe descriptions. Never return SQL, raw adapter messages or credentials. */
export function databaseFailure(error: unknown): DatabaseFailure {
  const code =
    error instanceof Prisma.PrismaClientKnownRequestError
      ? error.code
      : error instanceof Prisma.PrismaClientInitializationError
        ? error.errorCode
        : undefined;
  if (code === 'P2021' || code === 'P2022')
    return {
      status: 503,
      code: 'DATABASE_SCHEMA_NOT_READY',
      message:
        'The database schema is not ready for this API version. An operator must apply the database migrations and verify permissions.',
    };
  if (
    [
      'P1000',
      'P1001',
      'P1002',
      'P1003',
      'P1008',
      'P1010',
      'P1011',
      'P1017',
      'P2024',
      'P2037',
    ].includes(code || '')
  )
    return {
      status: 503,
      code: 'DATABASE_UNAVAILABLE',
      message: 'The database is temporarily unavailable. Please retry shortly.',
    };
  if (code === 'P2002')
    return {
      status: 409,
      code: 'RECORD_CONFLICT',
      message: 'A record with these values already exists.',
    };
  if (code === 'P2003')
    return {
      status: 409,
      code: 'REFERENCE_CONFLICT',
      message:
        'This operation conflicts with a related record. Refresh and try again.',
    };
  if (code === 'P2025')
    return {
      status: 404,
      code: 'RECORD_NOT_FOUND',
      message: 'The requested record was not found.',
    };
  if (code === 'P2034')
    return {
      status: 409,
      code: 'CONCURRENT_UPDATE',
      message: 'Another operation changed this record. Refresh and try again.',
    };
  return {
    status: 500,
    code: 'DATABASE_REQUEST_FAILED',
    message: 'The server could not complete the database operation.',
  };
}
