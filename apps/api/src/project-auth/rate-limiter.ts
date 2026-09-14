import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DB_TOKEN, type Db } from '../db/database';

export interface RateLimitState { limit: number; remaining: number; resetAt: Date; exceeded: boolean }

/**
 * Fixed one-minute windows held in the store, so a project's limit is one figure however
 * many instances serve it (spec 15.6). Cheap at the platform's target rate; a shared cache
 * would replace this at volumes well beyond it.
 */
@Injectable()
export class RateLimiter {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async hit(key: string, limit: number, windowSeconds = 60): Promise<RateLimitState> {
    const { rows } = await sql<{ count: number; window_start: Date }>`
      insert into rate_limit_window (key, window_start, count)
      values (${key}, to_timestamp(floor(extract(epoch from now()) / ${windowSeconds}) * ${windowSeconds}), 1)
      on conflict (key, window_start) do update set count = rate_limit_window.count + 1
      returning count, window_start`.execute(this.db);
    const { count, window_start } = rows[0]!;
    const resetAt = new Date(window_start.getTime() + windowSeconds * 1000);
    return { limit, remaining: Math.max(0, limit - count), resetAt, exceeded: count > limit };
  }

  /** Drops windows older than an hour; run from the worker. */
  async prune(): Promise<void> {
    await sql`delete from rate_limit_window where window_start < now() - interval '1 hour'`.execute(this.db);
  }
}
