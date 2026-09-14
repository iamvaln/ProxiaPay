import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { PlatformError } from '../common/errors';
import { log } from '../logging/logger';

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
      const message = status === 404 ? 'No such resource.' : status === 400 || status === 413 ? 'The request body could not be read.' : 'A fault occurred in the platform.';
      if (status >= 500) this.logger.error({ err: exception }, 'unhandled http exception');
      res.status(status).json({ error: { code, message, retryable: status >= 500 } });
      return;
    }
    this.logger.error({ err: exception }, 'unhandled error');
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'A fault occurred in the platform.', retryable: true } });
  }
}
