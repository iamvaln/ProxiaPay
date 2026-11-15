import type { ArgumentsHost } from '@nestjs/common';
import { PlatformExceptionFilter } from '../http/exception.filter';

/** What the platform's exception filter answers for one exception, for tests that call handlers directly. */
export function filtered(exception: unknown): { status: number; body: unknown } {
  const out = { status: 0, body: undefined as unknown };
  const res = { status(s: number) { out.status = s; return res; }, json(b: unknown) { out.body = b; return res; }, setHeader() { return res; } };
  new PlatformExceptionFilter().catch(exception, { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost);
  return out;
}
