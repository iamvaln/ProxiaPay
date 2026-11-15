import { json } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';

/** A logo travels as base64 in JSON: 200 KB is about 273 KB encoded, past the 100 KB every other route keeps. */
export const LOGO_BODY_LIMIT = '300kb';
const LOGO_ROUTE = /^\/console\/projects\/[^/]+\/brand\/logo\/?$/;

/**
 * Called by main.ts and by the HTTP tests, so both see the same limits. The logo parser comes first
 * and marks the body read, so Nest's default parser (rawBody on, 100 KB) skips that one path.
 */
export function configureBodyParsers(app: NestExpressApplication): void {
  const logo = json({ limit: LOGO_BODY_LIMIT });
  app.use((req: { path: string }, res: unknown, next: (e?: unknown) => void) => (LOGO_ROUTE.test(req.path) ? (logo as unknown as (a: unknown, b: unknown, c: unknown) => void)(req, res, next) : next()));
}
