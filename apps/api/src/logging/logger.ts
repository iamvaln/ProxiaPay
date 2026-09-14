import { AsyncLocalStorage } from 'node:async_hooks';
import pino, { type Logger } from 'pino';

export interface RequestContext {
  requestId: string;
  correlationId?: string;
  projectId?: string;
  administratorId?: string;
}

/** Request-scoped context that follows a payment through every log line without being passed by hand. */
export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Structured logs with the secrets the specification names kept out: bearer tokens, cookies,
 * secrets, one-time codes, browser-step addresses and full payer identifiers never reach a log
 * aggregator, whatever a caller passes.
 */
export const rootLogger: Logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  // Synchronous stdout so a fatal line is never lost to process.exit.
  transport: undefined,
  redact: {
    paths: [
      'req.headers.authorization', 'req.headers.cookie', 'headers.authorization', 'headers.cookie',
      '*.client_secret', '*.secret', '*.password', '*.code', '*.access_token', '*.token', '*.url', '*.action.url',
      '*.msisdn', '*.phoneNumber', '*.counterparty.msisdn', 'msisdn', 'client_secret', 'secret', 'password', 'code', 'access_token',
    ],
    censor: '[redacted]',
  },
  mixin() {
    const ctx = requestContext.getStore();
    return ctx ? { request_id: ctx.requestId, correlation_id: ctx.correlationId, project_id: ctx.projectId, administrator_id: ctx.administratorId } : {};
  },
}, pino.destination({ fd: 1, sync: true }));

export const log = (name: string): Logger => rootLogger.child({ module: name });
