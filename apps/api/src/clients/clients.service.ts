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
    const client = await this.createWithoutInvite(tx, input.name, actorId);
    const invited = await this.invitations.invite(tx, { clientId: client.id, name: input.ownerName, email: input.ownerEmail, language: input.language, profile: 'owner', projectIds: [] }, actorId, { auditAction: 'client.invite_owner' });
    return { clientId: client.id, ...invited };
  }

  /**
   * A client with no owner invitation: its owner is an existing platform account, attached with `attachSelf`. Only the house-partner
   * CLI takes this path; the console always invites.
   */
  async createWithoutInvite(tx: Tx, name: string, actorId: string): Promise<{ id: string }> {
    const client = await tx.insertInto('client').values({ name, created_by: actorId }).returning('id').executeTakeFirstOrThrow();
    await this.audit.record(tx, { actorId, action: 'client.create', subjectType: 'client', subjectId: client.id, next: { name } });
    return client;
  }

  /** Another owner, for example a successor. */
  async inviteOwner(tx: Tx, clientId: string, input: { name: string; email: string; language: 'en' | 'fr' }, actorId: string): Promise<Invited> {
    const client = isUuid(clientId) ? await tx.selectFrom('client').select('status').where('id', '=', clientId).executeTakeFirst() : undefined;
    if (!client) throw new PlatformError('NOT_FOUND', 'No such client.');
    // The link could not be accepted: an invitation only opens in an active client.
    if (client.status === 'disabled') throw new PlatformError('RULE_VIOLATION', CLIENT_DISABLED);
    return this.invitations.invite(tx, { clientId, ...input, profile: 'owner', projectIds: [] }, actorId, { auditAction: 'client.invite_owner' });
  }

  /**
   * The actor's own platform account becomes an active owner of the client, with no invitation: the rule that a platform
   * account never joins a team holds for invitations, which still refuse platform addresses.
   */
  async attachSelf(tx: Tx, clientId: string, actorId: string, confirmationId: string | null): Promise<{ membership_id: string; client_id: string }> {
    const client = isUuid(clientId) ? await tx.selectFrom('client').select('status').where('id', '=', clientId).forUpdate().executeTakeFirst() : undefined;
    if (!client) throw new PlatformError('NOT_FOUND', 'No such client.');
    if (client.status === 'disabled') throw new PlatformError('RULE_VIOLATION', CLIENT_DISABLED);
    const actor = await tx.selectFrom('administrator').select('kind').where('id', '=', actorId).executeTakeFirstOrThrow();
    if (actor.kind !== 'platform') throw new PlatformError('PERMISSION_DENIED', 'Only a platform account attaches itself to a client.');
    // Any membership, in any state: a disabled one is re-enabled from the client page, never duplicated.
    const existing = await tx.selectFrom('client_membership').select('id').where('client_id', '=', clientId).where('administrator_id', '=', actorId).executeTakeFirst();
    if (existing) throw new PlatformError('CONFLICT', 'You already belong to this client.');
    const membership = await tx.insertInto('client_membership').values({ client_id: clientId, administrator_id: actorId, status: 'active', invited_by: actorId, accepted_at: sql`now()` }).returning('id').executeTakeFirstOrThrow();
    const role = await tx.selectFrom('role').select('id').where('name', '=', 'Client owner').where('kind', '=', 'client').executeTakeFirstOrThrow();
    await tx.insertInto('role_assignment').values({ administrator_id: actorId, role_id: role.id, scope_type: 'client', membership_id: membership.id, granted_by: actorId }).execute();
    await this.audit.record(tx, { actorId, action: 'client.attach_self', subjectType: 'client_membership', subjectId: membership.id, next: { client_id: clientId, profile: 'owner' }, confirmationId });
    return { membership_id: membership.id, client_id: clientId };
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
    if (status === 'disabled' && m.status === 'active' && m.client_status === 'active' && (await this.invitations.accessOf(tx, m.id)).profile === 'owner') await this.assertOtherOwner(tx, m.client_id, m.id);
    return this.invitations.setStatus(tx, m.id, status, actorId, { auditAction: 'membership.status' });
  }

  /** Another active owner must remain in the client. */
  private async assertOtherOwner(tx: Tx, clientId: string, membershipId: string): Promise<void> {
    const others = await tx
      .selectFrom('client_membership as m2')
      .innerJoin('role_assignment as ra', 'ra.membership_id', 'm2.id')
      .innerJoin('role as r', 'r.id', 'ra.role_id')
      .select('m2.id')
      .where('m2.client_id', '=', clientId)
      .where('m2.status', '=', 'active')
      .where('m2.id', '!=', membershipId)
      .where('r.name', '=', 'Client owner')
      .limit(1)
      .execute();
    if (others.length === 0) throw new PlatformError('FIELD_INVALID', LAST_OWNER);
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
    // Every active client this person owns must keep another active owner. Client rows are locked in order, as setMembershipStatus does.
    const owned = await tx.selectFrom('client_membership as m').innerJoin('client as c', 'c.id', 'm.client_id').select(['m.id', 'm.client_id']).where('m.administrator_id', '=', a.id).where('m.status', '=', 'active').where('c.status', '=', 'active').orderBy('m.client_id').execute();
    for (const m of owned) {
      await tx.selectFrom('client').select('id').where('id', '=', m.client_id).forUpdate().execute();
      if ((await this.invitations.accessOf(tx, m.id)).profile === 'owner') await this.assertOtherOwner(tx, m.client_id, m.id);
    }
    await tx.updateTable('administrator').set({ status: 'disabled' }).where('id', '=', a.id).execute();
    await tx.updateTable('admin_session').set({ revoked_at: sql`now()`, revoked_by: actorId }).where('administrator_id', '=', a.id).where('revoked_at', 'is', null).execute();
    await this.audit.record(tx, { actorId, action: 'administrator.disable', subjectType: 'administrator', subjectId: a.id, prior: { status: a.status }, next: { status: 'disabled' } });
    return { administrator_id: a.id, status: 'disabled' as const };
  }

  /** Undoes disableAccount. Memberships keep their own status: a membership disabled on its own stays so. Sessions revoked at the disable stay revoked. */
  async enableAccount(tx: Tx, administratorId: string, actorId: string) {
    const a = isUuid(administratorId)
      ? await tx.selectFrom('administrator').select(['id', 'status']).where('id', '=', administratorId).where('kind', '=', 'client').forUpdate().executeTakeFirst()
      : undefined;
    if (!a) throw new PlatformError('NOT_FOUND', 'No such account.');
    await tx.updateTable('administrator').set({ status: 'active' }).where('id', '=', a.id).execute();
    await this.audit.record(tx, { actorId, action: 'administrator.enable', subjectType: 'administrator', subjectId: a.id, prior: { status: a.status }, next: { status: 'active' } });
    return { administrator_id: a.id, status: 'active' as const };
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
    // The account's own status beside the membership's: the platform disables and re-enables the person from here.
    const members = await this.invitations.membersOf(exec, client.id);
    const accounts = members.length ? await exec.selectFrom('administrator').select(['id', 'status', 'kind']).where('id', 'in', members.map((m) => m.administrator_id)).execute() : [];
    // A platform account attached as owner is disabled from the administrators page, not from here.
    const withAccounts = members.map((m) => {
      const account = accounts.find((a) => a.id === m.administrator_id)!;
      return { ...m, account_status: account.status, account_kind: account.kind };
    });
    const projects = await exec.selectFrom('project').select(['id', 'code', 'name', 'status']).where('client_id', '=', client.id).orderBy('code').execute();
    return { ...client, members: withAccounts, projects };
  }
}
