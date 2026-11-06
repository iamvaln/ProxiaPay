import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { AuditService } from '../audit/audit.service';
import { PlatformError } from '../common/errors';
import { DB_TOKEN, type Db, type Executor, type Tx } from '../db/database';
import { InvitationService, isUuid, type Invited } from './invitation.service';

const LAST_OWNER = 'A client keeps at least one active owner; invite a successor first.';
const CLIENT_DISABLED = 'That client is disabled.';

/** Clients and their memberships, from the platform side (spec: client accounts). Writes run in the caller's transaction. */
@Injectable()
export class ClientsService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db, private readonly invitations: InvitationService, private readonly audit: AuditService) {}

  /** The owner's mail goes out through `deliver`, once the caller's transaction has committed. */
  async createClient(tx: Tx, input: { name: string; ownerName: string; ownerEmail: string; language: 'en' | 'fr' }, actorId: string): Promise<{ clientId: string } & Pick<Invited, 'status' | 'deliver'>> {
    const client = await tx.insertInto('client').values({ name: input.name, created_by: actorId }).returning('id').executeTakeFirstOrThrow();
    await this.audit.record(tx, { actorId, action: 'client.create', subjectType: 'client', subjectId: client.id, next: { name: input.name } });
    const invited = await this.invitations.invite(tx, { clientId: client.id, name: input.ownerName, email: input.ownerEmail, language: input.language, profile: 'owner', projectIds: [] }, actorId, { auditAction: 'client.invite_owner' });
    return { clientId: client.id, ...invited };
  }

  /** Another owner, for example a successor. */
  async inviteOwner(tx: Tx, clientId: string, input: { name: string; email: string; language: 'en' | 'fr' }, actorId: string): Promise<Invited> {
    const client = isUuid(clientId) ? await tx.selectFrom('client').select('status').where('id', '=', clientId).executeTakeFirst() : undefined;
    if (!client) throw new PlatformError('NOT_FOUND', 'No such client.');
    // The link could not be accepted: an invitation only opens in an active client.
    if (client.status === 'disabled') throw new PlatformError('RULE_VIOLATION', CLIENT_DISABLED);
    return this.invitations.invite(tx, { clientId, ...input, profile: 'owner', projectIds: [] }, actorId, { auditAction: 'client.invite_owner' });
  }

  /** Disabling switches off the active memberships and ends the sessions in the client; enabling restores only what that switched off. */
  async setClientStatus(tx: Tx, clientId: string, status: 'active' | 'disabled', actorId: string) {
    const client = isUuid(clientId) ? await tx.selectFrom('client').select('status').where('id', '=', clientId).forUpdate().executeTakeFirst() : undefined;
    if (!client) throw new PlatformError('NOT_FOUND', 'No such client.');
    let touched: number;
    if (status === 'disabled') {
      const off = await tx.updateTable('client_membership').set({ status: 'disabled', disabled_by_client: true }).where('client_id', '=', clientId).where('status', '=', 'active').returning('id').execute();
      touched = off.length;
      await tx.updateTable('admin_session').set({ revoked_at: sql`now()`, revoked_by: actorId }).where('active_client_id', '=', clientId).where('revoked_at', 'is', null).execute();
    } else {
      const on = await tx.updateTable('client_membership').set({ status: 'active', disabled_by_client: false }).where('client_id', '=', clientId).where('disabled_by_client', '=', true).returning('id').execute();
      touched = on.length;
    }
    await tx.updateTable('client').set({ status }).where('id', '=', clientId).execute();
    await this.audit.record(tx, { actorId, action: 'client.status', subjectType: 'client', subjectId: clientId, prior: { status: client.status }, next: { status, memberships: touched } });
    return { client_id: clientId, status };
  }

  async setMembershipStatus(tx: Tx, membershipId: string, status: 'active' | 'disabled', actorId: string) {
    const m = isUuid(membershipId)
      ? await tx.selectFrom('client_membership as m').innerJoin('client as c', 'c.id', 'm.client_id').select(['m.id', 'm.client_id', 'm.status', 'c.status as client_status']).where('m.id', '=', membershipId).executeTakeFirst()
      : undefined;
    if (!m) throw new PlatformError('NOT_FOUND', 'No such member.');
    // The client row serialises concurrent changes to its owners, so two disablings cannot each see the other owner still active.
    await tx.selectFrom('client').select('id').where('id', '=', m.client_id).forUpdate().execute();
    if (status === 'active' && m.client_status === 'disabled') throw new PlatformError('RULE_VIOLATION', CLIENT_DISABLED);
    if (status === 'disabled' && m.status === 'active' && m.client_status === 'active' && (await this.invitations.accessOf(tx, m.id)).profile === 'owner') {
      const others = await tx
        .selectFrom('client_membership as m2')
        .innerJoin('role_assignment as ra', 'ra.membership_id', 'm2.id')
        .innerJoin('role as r', 'r.id', 'ra.role_id')
        .select('m2.id')
        .where('m2.client_id', '=', m.client_id)
        .where('m2.status', '=', 'active')
        .where('m2.id', '!=', m.id)
        .where('r.name', '=', 'Client owner')
        .limit(1)
        .execute();
      if (others.length === 0) throw new PlatformError('FIELD_INVALID', LAST_OWNER);
    }
    return this.invitations.setStatus(tx, m.id, status, actorId, { auditAction: 'membership.status' });
  }

  async resend(tx: Tx, membershipId: string, actorId: string): Promise<Invited> {
    if (!isUuid(membershipId)) throw new PlatformError('NOT_FOUND', 'No such member.');
    return this.invitations.resend(tx, membershipId, actorId, { auditAction: 'membership.resend' });
  }

  /** The person, in every client they work for. A platform account is disabled from the administrators page. */
  async disableAccount(tx: Tx, administratorId: string, actorId: string) {
    const a = isUuid(administratorId)
      ? await tx.selectFrom('administrator').select(['id', 'status']).where('id', '=', administratorId).where('kind', '=', 'client').forUpdate().executeTakeFirst()
      : undefined;
    if (!a) throw new PlatformError('NOT_FOUND', 'No such account.');
    await tx.updateTable('administrator').set({ status: 'disabled' }).where('id', '=', a.id).execute();
    await tx.updateTable('admin_session').set({ revoked_at: sql`now()`, revoked_by: actorId }).where('administrator_id', '=', a.id).where('revoked_at', 'is', null).execute();
    await this.audit.record(tx, { actorId, action: 'administrator.disable', subjectType: 'administrator', subjectId: a.id, prior: { status: a.status }, next: { status: 'disabled' } });
    return { administrator_id: a.id, status: 'disabled' as const };
  }

  async list(exec: Executor = this.db) {
    const rows = await exec
      .selectFrom('client as c')
      .select(['c.id', 'c.name', 'c.status', 'c.created_at'])
      .select(sql<number>`(select count(*)::int from client_membership m where m.client_id = c.id)`.as('members'))
      .select(sql<number>`(select count(*)::int from project p where p.client_id = c.id)`.as('projects'))
      .orderBy('c.name')
      .orderBy('c.id')
      .execute();
    return { clients: rows };
  }

  async detail(clientId: string, exec: Executor = this.db) {
    const client = isUuid(clientId) ? await exec.selectFrom('client').select(['id', 'name', 'status', 'created_at']).where('id', '=', clientId).executeTakeFirst() : undefined;
    if (!client) throw new PlatformError('NOT_FOUND', 'No such client.');
    const members = await this.invitations.membersOf(exec, client.id);
    const projects = await exec.selectFrom('project').select(['id', 'code', 'name', 'status']).where('client_id', '=', client.id).orderBy('code').execute();
    return { ...client, members, projects };
  }
}
