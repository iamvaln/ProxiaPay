import { z, type ZodType } from 'zod';
import { PlatformError, fieldInvalid } from '../common/errors';

/**
 * Validates a request body against a zod schema, mapping the first issue to the catalogue:
 * amount problems become AMOUNT_INVALID, everything else FIELD_INVALID naming the field.
 */
export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (result.success) return result.data;
  const issue = result.error.issues[0]!;
  const field = issue.path.map(String).join('.') || 'body';
  if (field === 'amount') throw new PlatformError('AMOUNT_INVALID', 'Amount must be a positive integer in minor units.', { field });
  throw fieldInvalid(field, `${field}: ${issue.message}`);
}

export const minorUnits = z.number({ error: 'must be an integer' }).int('must be an integer in minor units').positive('must be positive').max(Number.MAX_SAFE_INTEGER);
export const nonEmpty = (max = 256) => z.string().trim().min(1).max(max);
