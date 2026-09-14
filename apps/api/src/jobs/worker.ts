import { Injectable } from '@nestjs/common';
import { log } from '../logging/logger';
import { JobQueue, type ClaimedJob } from './job-queue';

export type JobHandler = (payload: Record<string, unknown>, job: ClaimedJob) => Promise<void | { rescheduleAt: Date }>;

/**
 * Polls the queue and runs registered handlers. A handler returning a reschedule time is a
 * recurring job (the status sweep, alert evaluation, float cover) that re-arms itself; every
 * other job completes or fails with backoff.
 */
@Injectable()
export class Worker {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly logger = log('worker');
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  private inFlight = 0;

  constructor(private readonly queue: JobQueue) {}

  register(kind: string, handler: JobHandler): void {
    if (this.handlers.has(kind)) throw new Error(`handler for ${kind} already registered`);
    this.handlers.set(kind, handler);
  }

  kinds(): string[] {
    return [...this.handlers.keys()];
  }

  start(name: string, pollMs = 500, concurrency = 8): void {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      try {
        const capacity = concurrency - this.inFlight;
        if (capacity > 0) {
          const jobs = await this.queue.claim(name, capacity, this.kinds());
          for (const job of jobs) void this.run(job);
        }
      } catch (e) {
        this.logger.error({ err: e }, 'claim failed');
      }
      this.timer = setTimeout(tick, pollMs);
    };
    void tick();
    setInterval(() => void this.queue.recoverStale().catch(() => undefined), 60_000).unref();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    while (this.inFlight > 0) await new Promise((r) => setTimeout(r, 50));
  }

  /** Runs every due job once and returns; used by tests and by one-shot maintenance commands. */
  async drain(name = 'drain', kinds?: string[]): Promise<number> {
    let total = 0;
    for (;;) {
      const jobs = await this.queue.claim(name, 20, kinds ?? this.kinds());
      if (jobs.length === 0) return total;
      for (const job of jobs) await this.run(job);
      total += jobs.length;
    }
  }

  private async run(job: ClaimedJob): Promise<void> {
    const handler = this.handlers.get(job.kind);
    this.inFlight++;
    try {
      if (!handler) throw new Error(`no handler for ${job.kind}`);
      const result = await handler(job.payload, job);
      if (result && 'rescheduleAt' in result) await this.queue.reschedule(job.id, result.rescheduleAt);
      else await this.queue.complete(job.id);
    } catch (e) {
      this.logger.warn({ job_id: job.id, kind: job.kind, attempt: job.attempts, err: e }, 'job failed');
      await this.queue.fail(job, e);
    } finally {
      this.inFlight--;
    }
  }
}
