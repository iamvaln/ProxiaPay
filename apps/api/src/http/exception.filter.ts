import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { DatabaseError } from 'pg';
import { PlatformError } from '../common/errors';
import { log } from '../logging/logger';

const BODY_TOO_LARGE = 'The request body is too large.';
const BODY_UNREADABLE = 'The request body could not be read.';

/** Errors body-parser raises before any handler runs (http-errors with a `type`, a 4xx status and `expose`): the caller's doing. */
function bodyParserError(e: unknown): { type: string } | null {
  if (typeof e !== 'object' || e === null) return null;
  const { type, status, expose } = e as { type?: unknown; status?: unknown; expose?: unknown };
  return typeof type === 'string' && expose === true && typeof status === 'number' && status >= 400 && status < 500 ? { type } : null;
}

/** Every error leaves as the shape of API reference section 4.1; faults never leak their internals. */
@Catch()
export class PlatformExceptionFilter implements ExceptionFilter {
  private readonly logger = log('http');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof PlatformError) {
      for (const [k, v] of Object.entries(exception.options.headers ?? {})) res.setHeader(k, v);
      res.status(exception.status).json(exception.toBody());
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = status === 404 ? 'NOT_FOUND' : status === 400 ? 'FIELD_INVALID' : status === 413 ? 'FIELD_INVALID' : 'INTERNAL_ERROR';
      const message = status === 404 ? 'No such resource.' : status === 413 ? BODY_TOO_LARGE : status === 400 ? BODY_UNREADABLE : 'A fault occurred in the platform.';
      if (status >= 500) this.logger.error({ err: exception }, 'unhandled http exception');
      res.status(status).json({ error: { code, message, retryable: status >= 500 } });
      return;
    }
    const parser = bodyParserError(exception);
    if (parser) {
      const tooLarge = parser.type === 'entity.too.large';
      res.status(tooLarge ? 413 : 400).json({ error: { code: 'FIELD_INVALID', message: tooLarge ? BODY_TOO_LARGE : BODY_UNREADABLE, retryable: false } });
      return;
    }
    // A path parameter the store cannot read as its type (a malformed uuid): no such row can exist.
    if (exception instanceof DatabaseError && exception.code === '22P02') {
      // Handlers validate ids first, so reaching here may be a real defect; keep a trace (the message, never the request).
      this.logger.warn({ err: exception }, 'malformed value reached the store; answered as not found');
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such resource.', retryable: false } });
      return;
    }
    this.logger.error({ err: exception }, 'unhandled error');
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'A fault occurred in the platform.', retryable: true } });
  }
}
