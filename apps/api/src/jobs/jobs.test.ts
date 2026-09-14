import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, testDb, truncateAll } from '../test/db';
import type { Db } from '../db/database';
import { JobQueue } from './job-queue';
import { Worker } from './worker';

let db: Db;
beforeAll(async () => { db = await testDb(); });
afterAll(closeTestDb);
beforeEach(() => truncateAll(db));

describe('job queue', () => {
  it('rolls back a job with the transaction that enqueued it', async () => {
    const queue = new JobQueue(db);
    await expect(db.transaction().execute(async (tx) => {
      await queue.enqueue(tx, 'x', { a: 1 });
      throw new Error('abort');
    })).rejects.toThrow('abort');
    expect(await queue.claim('w')).toEqual([]);
  });

  it('dedupes on key while queued and runs each job once across workers', async () => {
    const queue = new JobQueue(db);
    expect(await queue.enqueue(db, 'tick', {}, { dedupeKey: 'tick' })).not.toBeNull();
    expect(await queue.enqueue(db, 'tick', {}, { dedupeKey: 'tick' })).toBeNull();
    for (let i = 0; i < 20; i++) await queue.enqueue(db, 'n', { i });
    const seen: number[] = [];
    const mk = () => { const w = new Worker(queue); w.register('n', async (p) => { seen.push(p.i as number); }); w.register('tick', async () => undefined); return w; };
    await Promise.all([mk().drain('a'), mk().drain('b'), mk().drain('c')]);
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it('retries with backoff and dies after max attempts', async () => {
    const queue = new JobQueue(db);
    await queue.enqueue(db, 'boom', {}, { maxAttempts: 2 });
    const w = new Worker(queue);
    w.register('boom', async () => { throw new Error('nope'); });
    await w.drain();
    let job = await db.selectFrom('job').selectAll().executeTakeFirstOrThrow();
    expect(job.status).toBe('queued');
    expect(job.attempts).toBe(1);
    await db.updateTable('job').set({ run_at: new Date(0) }).execute();
    await w.drain();
    job = await db.selectFrom('job').selectAll().executeTakeFirstOrThrow();
    expect(job.status).toBe('dead');
    expect(job.last_error).toContain('nope');
  });
});
