import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { requestContext } from '../logging/logger';

/** Every response carries X-Request-Id, and every log line written while serving it carries the same value. */
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = randomUUID();
  res.setHeader('X-Request-Id', requestId);
  requestContext.run({ requestId }, () => next());
}
