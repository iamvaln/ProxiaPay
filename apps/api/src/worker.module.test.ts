import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './test/context';
import { Worker } from './jobs/worker';
import { RECURRING_JOBS } from './worker.module';

let t: TestContext;
beforeAll(async () => { t = await createTestContext(); });
afterAll(() => t.close());

describe('recurring work', () => {
  it('has a handler for every job it seeds, so none is queued forever with nothing to run it', () => {
    const handled = t.app.get(Worker).kinds();
    for (const kind of RECURRING_JOBS) expect(handled, kind).toContain(kind);
  });

  it('measures float drift continuously, not only inside a reconciliation run', () => {
    expect(RECURRING_JOBS).toContain('float.drift');
  });
});
