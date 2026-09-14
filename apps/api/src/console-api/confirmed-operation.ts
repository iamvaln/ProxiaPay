import { z } from 'zod';
import { PlatformError } from '../common/errors';
import { ConfirmationService } from '../admin-auth/confirmation.service';
import type { Db, Tx } from '../db/database';
import type { SessionPrincipal } from '../admin-auth/admin-auth.service';

export const confirmationSchema = z.object({ id: z.string().uuid(), code: z.string().regex(/^\d{6}$/) });
export type ConfirmationInput = z.infer<typeof confirmationSchema>;

/**
 * Runs an operation that requires a one-time code (console spec 11.1). The code is consumed
 * inside the operation's transaction against a fingerprint of the submitted values; a wrong
 * code rolls the operation back and the failed attempt is recorded on its own.
 */
export async function withConfirmation<T>(
  db: Db,
  confirmations: ConfirmationService,
  principal: SessionPrincipal,
  operationType: string,
  values: unknown,
  confirmation: ConfirmationInput | undefined,
  fn: (tx: Tx, confirmationId: string) => Promise<T>,
): Promise<T> {
  if (!confirmation) throw new PlatformError('CONFIRMATION_REQUIRED', 'This operation requires a one-time code.', { details: { operation_type: operationType } });
  try {
    return await db.transaction().execute(async (tx) => {
      const confirmationId = await confirmations.consume(tx, principal.administratorId, confirmation.id, confirmation.code, operationType, values);
      return fn(tx, confirmationId);
    });
  } catch (e) {
    if (e instanceof PlatformError && e.code === 'CONFIRMATION_INVALID' && e.options.details && 'attempts_remaining' in e.options.details) {
      await confirmations.recordFailedAttempt(confirmation.id, principal.administratorId, Boolean(e.options.details.exhausted));
    }
    throw e;
  }
}
