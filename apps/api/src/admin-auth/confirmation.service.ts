import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { PlatformError } from '../common/errors';
import { CryptoService } from '../crypto/crypto.service';
import { DB_TOKEN, type Db, type Tx } from '../db/database';
import { SettingsService } from '../settings/settings.service';
import { Mailer } from '../alerts/mailer';
import { AuditService } from '../audit/audit.service';

/**
 * One-time codes confirming sensitive operations (spec 10.1, console spec 11.1). A code is
 * bound to the operation and a fingerprint of the values submitted, is single use, expires
 * shortly after issue, and admits a limited number of attempts. Every outcome is audited.
 */
@Injectable()
export class ConfirmationService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly mailer: Mailer,
    private readonly audit: AuditService,
  ) {}

  static fingerprint(operationType: string, values: unknown): string {
    return createHash('sha256').update(`${operationType}\n${canonical(values)}`).digest('hex');
  }

  /** Issues a code for the operation and values, delivering it to the administrator. Any earlier pending code for the same administrator is abandoned. */
  async request(administratorId: string, email: string, language: 'en' | 'fr', operationType: string, values: unknown, subjectReference = ''): Promise<{ confirmationId: string; expiresAt: Date }> {
    const validity = await this.settings.number('confirmation.validity_seconds');
    const code = CryptoService.randomNumericCode(6);
    const fingerprint = ConfirmationService.fingerprint(operationType, values);
    const row = await this.db.transaction().execute(async (tx) => {
      await tx.updateTable('operation_confirmation').set({ outcome: 'abandoned' }).where('administrator_id', '=', administratorId).where('outcome', '=', 'pending').execute();
      const inserted = await tx
        .insertInto('operation_confirmation')
        .values({
          administrator_id: administratorId,
          operation_type: operationType,
          subject_reference: subjectReference,
          fingerprint,
          code_hash: CryptoService.tokenHash(`${fingerprint}:${code}`),
          expires_at: sql`now() + make_interval(secs => ${validity})`,
        })
        .returning(['id', 'expires_at'])
        .executeTakeFirstOrThrow();
      await this.audit.record(tx, { actorId: administratorId, action: 'confirmation.issued', subjectType: 'operation_confirmation', subjectId: inserted.id, next: { operation_type: operationType, subject: subjectReference } });
      return inserted;
    });
    await this.mailer.send({
      to: email,
      subject: language === 'fr' ? 'ProxiaPay : code de confirmation' : 'ProxiaPay: confirmation code',
      text: language === 'fr'
        ? `Votre code pour confirmer l'opération « ${operationType} » est ${code}. Il expire dans ${Math.round(validity / 60)} minutes.`
        : `Your code to confirm the operation "${operationType}" is ${code}. It expires in ${Math.round(validity / 60)} minutes.`,
      sensitive: true,
    });
    return { confirmationId: row.id, expiresAt: row.expires_at };
  }

  /**
   * Consumes the code for exactly these values. Called inside the transaction that performs
   * the operation, so a failed operation leaves the code unconsumed only if the whole thing rolls back.
   */
  async consume(tx: Tx, administratorId: string, confirmationId: string, code: string, operationType: string, values: unknown): Promise<string> {
    const attempts = await this.settings.number('confirmation.attempts');
    const fingerprint = ConfirmationService.fingerprint(operationType, values);
    const row = await tx.selectFrom('operation_confirmation').selectAll().where('id', '=', confirmationId).where('administrator_id', '=', administratorId).forUpdate().executeTakeFirst();
    if (!row || row.outcome !== 'pending') throw new PlatformError('CONFIRMATION_INVALID', 'No pending confirmation matches; request a new code.');
    if (row.expires_at.getTime() < Date.now()) {
      await tx.updateTable('operation_confirmation').set({ outcome: 'expired' }).where('id', '=', row.id).execute();
      await this.audit.record(tx, { actorId: administratorId, action: 'confirmation.expired', subjectType: 'operation_confirmation', subjectId: row.id });
      throw new PlatformError('CONFIRMATION_INVALID', 'The code expired; start the operation again.');
    }
    if (row.fingerprint !== fingerprint || row.operation_type !== operationType) {
      await tx.updateTable('operation_confirmation').set({ outcome: 'abandoned' }).where('id', '=', row.id).execute();
      await this.audit.record(tx, { actorId: administratorId, action: 'confirmation.abandoned', subjectType: 'operation_confirmation', subjectId: row.id, next: { reason: 'values changed after the code was requested' } });
      throw new PlatformError('CONFIRMATION_INVALID', 'The values changed after the code was requested; request a new code.');
    }
    const expected = CryptoService.tokenHash(`${fingerprint}:${code}`);
    if (!CryptoService.constantTimeEqual(expected, row.code_hash)) {
      const made = row.attempts + 1;
      const exhausted = made >= attempts;
      await tx.updateTable('operation_confirmation').set({ attempts: made, outcome: exhausted ? 'exhausted' : 'pending' }).where('id', '=', row.id).execute();
      await this.audit.record(tx, { actorId: administratorId, action: exhausted ? 'confirmation.exhausted' : 'confirmation.attempt_failed', subjectType: 'operation_confirmation', subjectId: row.id, next: { attempts: made } });
      // The transaction performing the operation must not commit; the caller propagates this error.
      throw new PlatformError('CONFIRMATION_INVALID', exhausted ? 'The code attempts are exhausted; start the operation again.' : 'The code was not accepted.', { details: { attempts_remaining: Math.max(0, attempts - made), exhausted } });
    }
    await tx.updateTable('operation_confirmation').set({ outcome: 'confirmed', consumed_at: sql`now()`, attempts: row.attempts + 1 }).where('id', '=', row.id).execute();
    await this.audit.record(tx, { actorId: administratorId, action: 'confirmation.confirmed', subjectType: 'operation_confirmation', subjectId: row.id });
    return row.id;
  }

  /** Records a failed attempt in its own transaction, since the operation's transaction rolls back with the error. */
  async recordFailedAttempt(confirmationId: string, administratorId: string, exhausted: boolean): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const row = await tx.selectFrom('operation_confirmation').select(['attempts', 'outcome']).where('id', '=', confirmationId).forUpdate().executeTakeFirst();
      if (!row || row.outcome !== 'pending') return;
      await tx.updateTable('operation_confirmation').set({ attempts: row.attempts + 1, outcome: exhausted ? 'exhausted' : 'pending' }).where('id', '=', confirmationId).execute();
      await this.audit.record(tx, { actorId: administratorId, action: exhausted ? 'confirmation.exhausted' : 'confirmation.attempt_failed', subjectType: 'operation_confirmation', subjectId: confirmationId, next: { attempts: row.attempts + 1 } });
    });
  }
}

/** Stable JSON: sorted keys, no whitespace, so the same values always fingerprint the same way. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}
