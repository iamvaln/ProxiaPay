import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { PlatformError } from '../common/errors';
import { CONFIG, type AppConfig } from '../config/config';
import { CryptoService } from '../crypto/crypto.service';
import { newCredentialKey, newCredentialSecret } from '../crypto/references';
import { DB_TOKEN, type Db, type Tx } from '../db/database';
import { AuditService } from '../audit/audit.service';

export const CREDENTIAL_SCOPES = ['collection', 'disbursement', 'read'] as const;
export type CredentialScope = (typeof CREDENTIAL_SCOPES)[number];

/**
 * Project credentials and their rotation (spec 7.1). A project holds at most one credential in
 * each role and at least one active; a new credential enters as secondary, promotion swaps the
 * roles, deletion completes a rotation, and revocation takes effect at once whatever the role.
 */
@Injectable()
export class CredentialService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Pick<AppConfig, 'PROXIAPAY_ENV'>,
    private readonly audit: AuditService,
  ) {}

  async issue(tx: Tx, projectId: string, scopes: CredentialScope[], issuedBy: string | null, confirmationId?: string): Promise<{ id: string; key: string; secret: string; role: 'primary' | 'secondary' }> {
    await sql`select pg_advisory_xact_lock(hashtext('project_credential'), hashtext(${projectId}))`.execute(tx);
    const active = await tx.selectFrom('project_credential').select(['role']).where('project_id', '=', projectId).where('status', '=', 'active').execute();
    if (active.length >= 2) throw new PlatformError('CONFLICT', 'The project already holds a primary and a secondary credential; complete the rotation first.');
    const role = active.some((c) => c.role === 'primary') ? 'secondary' : 'primary';
    const key = newCredentialKey(this.config.PROXIAPAY_ENV);
    const secret = newCredentialSecret(this.config.PROXIAPAY_ENV);
    const row = await tx
      .insertInto('project_credential')
      .values({ project_id: projectId, key, secret_hash: await CryptoService.hashSecret(secret), scopes, role, issued_by: issuedBy })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.audit.record(tx, { actorId: issuedBy, action: 'credential.issue', subjectType: 'project_credential', subjectId: row.id, next: { project_id: projectId, key, role, scopes }, confirmationId });
    return { id: row.id, key, secret, role };
  }

  async promote(tx: Tx, credentialId: string, actorId: string, confirmationId?: string): Promise<void> {
    const cred = await this.active(tx, credentialId);
    if (cred.role === 'primary') throw new PlatformError('CONFLICT', 'The credential is already primary.');
    await sql`select pg_advisory_xact_lock(hashtext('project_credential'), hashtext(${cred.project_id}))`.execute(tx);
    const primary = await tx.selectFrom('project_credential').select('id').where('project_id', '=', cred.project_id).where('status', '=', 'active').where('role', '=', 'primary').executeTakeFirst();
    // Swap through a transient role to satisfy the one-per-role index within the statement sequence.
    if (primary) await tx.updateTable('project_credential').set({ status: 'deleted' }).where('id', '=', primary.id).execute();
    await tx.updateTable('project_credential').set({ role: 'primary' }).where('id', '=', cred.id).execute();
    if (primary) await tx.updateTable('project_credential').set({ status: 'active', role: 'secondary' }).where('id', '=', primary.id).execute();
    await this.audit.record(tx, { actorId, action: 'credential.promote', subjectType: 'project_credential', subjectId: cred.id, prior: { role: 'secondary', former_primary: primary?.id ?? null }, next: { role: 'primary' }, confirmationId });
  }

  /** Deleting the only credential, or the primary, is refused so a rotation cannot end with nothing that works. */
  async delete(tx: Tx, credentialId: string, actorId: string, confirmationId?: string): Promise<void> {
    const cred = await this.active(tx, credentialId);
    await sql`select pg_advisory_xact_lock(hashtext('project_credential'), hashtext(${cred.project_id}))`.execute(tx);
    if (cred.role === 'primary') throw new PlatformError('RULE_VIOLATION', 'The primary credential cannot be deleted; promote the secondary first.');
    const others = await tx.selectFrom('project_credential').select('id').where('project_id', '=', cred.project_id).where('status', '=', 'active').where('id', '<>', cred.id).execute();
    if (others.length === 0) throw new PlatformError('RULE_VIOLATION', 'A project keeps at least one credential; issue another before deleting this one.');
    await tx.updateTable('project_credential').set({ status: 'deleted', deleted_at: sql`now()`, deleted_by: actorId }).where('id', '=', cred.id).execute();
    await tx.updateTable('project_token').set({ revoked_at: sql`now()` }).where('credential_id', '=', cred.id).where('revoked_at', 'is', null).execute();
    await this.audit.record(tx, { actorId, action: 'credential.delete', subjectType: 'project_credential', subjectId: cred.id, prior: { role: cred.role, status: 'active' }, next: { status: 'deleted' }, confirmationId });
  }

  /** Revocation stands apart from rotation: immediate, whatever the role, and every token under it dies with it. */
  async revoke(tx: Tx, credentialId: string, actorId: string, reason: string, confirmationId?: string): Promise<void> {
    const cred = await this.active(tx, credentialId);
    await tx.updateTable('project_credential').set({ status: 'revoked', revoked_at: sql`now()`, revoked_by: actorId, revoked_reason: reason }).where('id', '=', cred.id).execute();
    await tx.updateTable('project_token').set({ revoked_at: sql`now()` }).where('credential_id', '=', cred.id).where('revoked_at', 'is', null).execute();
    await this.audit.record(tx, { actorId, action: 'credential.revoke', subjectType: 'project_credential', subjectId: cred.id, prior: { role: cred.role, status: 'active' }, next: { status: 'revoked', reason }, confirmationId });
  }

  private async active(tx: Tx, id: string) {
    const cred = await tx.selectFrom('project_credential').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!cred) throw new PlatformError('NOT_FOUND', 'No such credential.');
    if (cred.status !== 'active') throw new PlatformError('CONFLICT', `The credential is ${cred.status}.`);
    return cred;
  }

  async listForProject(projectId: string) {
    return this.db
      .selectFrom('project_credential')
      .select(['id', 'key', 'scopes', 'role', 'status', 'issued_by', 'issued_at', 'revoked_at', 'revoked_reason', 'deleted_at'])
      .where('project_id', '=', projectId)
      .orderBy('issued_at', 'desc')
      .execute();
  }
}
