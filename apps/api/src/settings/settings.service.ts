import { Inject, Injectable } from '@nestjs/common';
import { DB_TOKEN, type Db, type Executor } from '../db/database';
import { DEFAULT_SETTINGS } from '../seed/catalogue';

/**
 * The configured values of spec 14.7, read from the store with the specification's defaults
 * behind them, cached briefly so the payment path never waits on a settings query.
 */
@Injectable()
export class SettingsService {
  private cache: { at: number; values: Record<string, unknown> } | undefined;
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async all(exec: Executor = this.db): Promise<Record<string, unknown>> {
    if (this.cache && Date.now() - this.cache.at < 5000) return this.cache.values;
    const rows = await exec.selectFrom('platform_setting').select(['key', 'value']).execute();
    const values: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const r of rows) values[r.key] = r.value;
    this.cache = { at: Date.now(), values };
    return values;
  }

  async number(key: keyof typeof DEFAULT_SETTINGS | string, exec?: Executor): Promise<number> {
    const v = (await this.all(exec))[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`setting ${key} is not a number`);
    return v;
  }

  async set(exec: Executor, key: string, value: unknown, updatedBy: string | null): Promise<void> {
    await exec
      .insertInto('platform_setting')
      .values({ key, value: JSON.stringify(value), updated_by: updatedBy })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(value), updated_by: updatedBy, updated_at: new Date() }))
      .execute();
    this.cache = undefined;
  }

  invalidate(): void {
    this.cache = undefined;
  }
}
