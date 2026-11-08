import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { databaseFailure } from '../prisma/database-failure';

@Catch(
  Prisma.PrismaClientKnownRequestError,
  Prisma.PrismaClientInitializationError,
  Prisma.PrismaClientUnknownRequestError,
  Prisma.PrismaClientValidationError,
)
export class DatabaseExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DatabaseExceptionFilter.name);
  catch(error: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const failure = databaseFailure(error);
    const requestId = res.getHeader('x-request-id');
    this.logger.error(
      JSON.stringify({
        event: 'database_request_failed',
        code: failure.code,
        prismaCode:
          error instanceof Prisma.PrismaClientKnownRequestError
            ? error.code
            : undefined,
        requestId,
        method: req.method,
        route: (req.route as { path?: string })?.path || 'unmatched',
      }),
    );
    res.status(failure.status).json({
      statusCode: failure.status,
      code: failure.code,
      message: failure.message,
      ...(typeof requestId === 'string' ? { requestId } : {}),
    });
  }
}
