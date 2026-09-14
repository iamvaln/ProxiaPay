import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DB_TOKEN, type Db, type Executor } from '../db/database';
import { log } from '../logging/logger';

export interface EnqueueOptions {
  runAt?: Date;
  /** Only one queued or running job with this key exists at a time. */
  dedupeKey?: string;
  maxAttempts?: number;
}

export interface ClaimedJob {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

/**
 * Background work is enqueued in the same database transaction as the state change that
 * produced it (spec 15.3), so a job commits or rolls back with its cause. Workers claim jobs
 * under a row lock that skips rows already claimed, which is what lets several background
 * processes run without coordination.
 */
@Injectable()
export class JobQueue {
  private readonly logger = log('jobs');
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async enqueue(exec: Executor, kind: string, payload: Record<string, unknown> = {}, opts: EnqueueOptions = {}): Promise<number | null> {
    const row = await exec
      .insertInto('job')
      .values({
        kind,
        payload: JSON.stringify(payload),
        dedupe_key: opts.dedupeKey ?? null,
        run_at: opts.runAt ?? sql`now()`,
        max_attempts: opts.maxAttempts ?? 10,
      })
      .onConflict((oc) => oc.doNothing())
      .returning('id')
      .executeTakeFirst();
    return row?.id ?? null;
  }

  async claim(workerName: string, limit = 5, kinds?: string[]): Promise<ClaimedJob[]> {
    const kindFilter = kinds && kinds.length ? sql`and kind in (${sql.join(kinds)})` : sql``;
    const { rows } = await sql<ClaimedJob>`
      with due as (
        select id from job
         where status = 'queued' and run_at <= now() ${kindFilter}
         order by run_at
         limit ${limit}
         for update skip locked
      )
      update job j set status = 'running', locked_at = now(), locked_by = ${workerName}, attempts = j.attempts + 1
        from due where j.id = due.id
      returning j.id, j.kind, j.payload, j.attempts, j.max_attempts`.execute(this.db);
    return rows;
  }

  async complete(id: number): Promise<void> {
    await this.db.updateTable('job').set({ status: 'done', finished_at: new Date(), locked_at: null, locked_by: null }).where('id', '=', id).execute();
  }

  /** Requeues with a widening interval, or marks the job dead once its attempts are spent. */
  async fail(job: ClaimedJob, error: unknown): Promise<void> {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    if (job.attempts >= job.max_attempts) {
      this.logger.error({ job_id: job.id, kind: job.kind, err: message }, 'job dead after max attempts');
      await this.db.updateTable('job').set({ status: 'dead', last_error: message.slice(0, 2000), finished_at: new Date(), locked_at: null, locked_by: null }).where('id', '=', job.id).execute();
      return;
    }
    const delaySeconds = Math.min(3600, 5 * 2 ** (job.attempts - 1));
    await this.db
      .updateTable('job')
      .set({ status: 'queued', last_error: message.slice(0, 2000), run_at: sql`now() + make_interval(secs => ${delaySeconds})`, locked_at: null, locked_by: null })
      .where('id', '=', job.id)
      .execute();
  }

  /** Reschedules a recurring job for its next run without spending an attempt. */
  async reschedule(id: number, runAt: Date): Promise<void> {
    await this.db.updateTable('job').set({ status: 'queued', run_at: runAt, attempts: 0, locked_at: null, locked_by: null }).where('id', '=', id).execute();
  }

  /** Jobs whose worker died mid-run are returned to the queue after a grace period. */
  async recoverStale(graceSeconds = 600): Promise<number> {
    const result = await this.db
      .updateTable('job')
      .set({ status: 'queued', locked_at: null, locked_by: null, last_error: 'recovered after worker loss' })
      .where('status', '=', 'running')
      .where('locked_at', '<', sql<Date>`now() - make_interval(secs => ${graceSeconds})`)
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0);
  }
}
