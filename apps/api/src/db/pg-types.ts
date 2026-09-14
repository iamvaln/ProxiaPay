import { types } from 'pg';

/**
 * Monetary columns are BIGINT. node-postgres returns them as strings by default; the platform
 * reads them as JavaScript numbers, which are exact below 2^53. A value beyond that is a defect
 * somewhere upstream and is refused rather than silently rounded.
 */
export function configurePgTypes(): void {
  types.setTypeParser(types.builtins.INT8, (value: string) => {
    const n = Number(value);
    if (!Number.isSafeInteger(n)) {
      throw new RangeError(`BIGINT value ${value} exceeds the safe integer range`);
    }
    return n;
  });
  // Keep timestamptz as Date (default) and numeric as string (default): numeric is used only by
  // the reporting rate table and never by the money path.
}
