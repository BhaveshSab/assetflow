import { LoggerService } from '@nestjs/common';

/**
 * A Nest logger that writes JSON instead of pretty text.
 *
 * A log shipper (or `jq`) can only parse one JSON object per line — the
 * default Nest output is human-readable and has to be transformed first.
 */
export class JsonLogger implements LoggerService {
  log(message: unknown, context?: string): void {
    this.write('info', message, context);
  }

  error(message: unknown, stack?: string, context?: string): void {
    this.write('error', message, context, stack);
  }

  warn(message: unknown, context?: string): void {
    this.write('warn', message, context);
  }

  debug(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }

  verbose(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }

  fatal(message: unknown, context?: string): void {
    this.write('fatal', message, context);
  }

  private write(
    level: string,
    message: unknown,
    context?: string,
    stack?: string,
  ): void {
    const entry = {
      ts: new Date().toISOString(),
      level,
      context,
      message: typeof message === 'string' ? message : JSON.stringify(message),
      ...(stack ? { stack } : {}),
    };

    if (level === 'error' || level === 'fatal') {
      console.error(JSON.stringify(entry));
    } else {
      console.log(JSON.stringify(entry));
    }
  }
}
