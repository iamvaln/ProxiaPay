import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { assertPasswordStrength } from '../admin-auth/admin-auth.service';
import { AlertService } from '../alerts/alert.service';
import { Mailer, type Mail } from '../alerts/mailer';
import { AuditService } from '../audit/audit.service';
import { PlatformError } from '../common/errors';
import { CONFIG, type AppConfig } from '../config/config';
import { CryptoService } from '../crypto/crypto.service';
import { DB_TOKEN, type Db, type Executor, type Tx } from '../db/database';
import { CLIENT_ROLES } from '../permissions/permissions';

export type ClientProfile = 'owner' | 'developer' | 'finance';

export interface InviteInput {
  clientId: string;
  name: string;
  email: string;
  /** Used for a new account; an existing account is written to in the language it already has. */
  language: 'en' | 'fr';
  profile: ClientProfile;
  /** Ignored for an owner, whose scope is every project of the client. */
  projectIds: string[];
}

const SENT = { status: 'invitation_sent' } as const;
const VALIDITY_HOURS = 72;
const NO_LONGER_VALID = 'This invitation link is no longer valid. Ask for a new one.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID.test(s);

/**
 * Invitations by link and the memberships they open (spec: client accounts). The answer to an
 * invitation never depends on what the address already is, so the inviter learns nothing about it;
 * a membership grants nothing until the invitee accepts it.
 */
@Injectable()
export class InvitationService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Pick<AppConfig, 'PUBLIC_BASE_URL' | 'PROXIAPAY_ENV'>,
    private readonly mailer: Mailer,
    private readonly alerts: AlertService,
    private readonly audit: AuditService,
  ) {}

  /** Runs in the caller's transaction, the mail last, so a refused mail leaves no invitation behind. Platform side passes its own audit action. */
  async invite(tx: Tx, input: InviteInput, actorId: string, opts: { auditAction?: string } = {}): Promise<{ status: 'invitation_sent' }> {
    // Checked before the address is looked at: a configuration gap must not answer differently by address.
    const base = this.baseUrl();
    const email = input.email.trim().toLowerCase();
    const client = await tx.selectFrom('client').select(['id', 'name']).where('id', '=', input.clientId).executeTakeFirst();
    if (!client) throw new PlatformError('NOT_FOUND', 'No such client.');
    const projectIds = input.profile === 'owner' ? [] : await this.assertProjects(tx, client.id, input.projectIds);

    const existing = await tx.selectFrom('administrator').select(['id', 'kind', 'name', 'password_hash', 'language']).where('email', '=', email).executeTakeFirst();
    if (existing?.kind === 'platform') {
      // A platform account never joins a team. The inviter is told the same thing; Valentine is told the truth.
      await this.alerts.raise({
        category: 'security', severity: 'informational', subjectType: 'client', subjectReference: client.name,
        fingerprint: `invite_platform:${email}`, title: 'Invitation to a platform account', detail: { client_id: client.id, invited_by: actorId }, actionReference: '/oversight/administrators',
      }, tx);
      return SENT;
    }
    let invitee: { id: string; name: string; language: 'en' | 'fr'; setsPassword: boolean };
    if (existing) {
      const member = await tx.selectFrom('client_membership').select('id').where('client_id', '=', client.id).where('administrator_id', '=', existing.id).executeTakeFirst();
      if (member) return SENT;
      // An account invited elsewhere that never chose a password chooses it here.
      invitee = { id: existing.id, name: existing.name, language: existing.language as 'en' | 'fr', setsPassword: existing.password_hash === null };
    } else {
      const created = await tx.insertInto('administrator').values({ name: input.name.trim(), email, kind: 'client', password_hash: null, language: input.language }).returning('id').executeTakeFirstOrThrow();
      invitee = { id: created.id, name: input.name.trim(), language: input.language, setsPassword: true };
    }
    const membership = await tx.insertInto('client_membership').values({ client_id: client.id, administrator_id: invitee.id, status: 'pending', invited_by: actorId }).returning('id').executeTakeFirstOrThrow();
    await this.writeAssignment(tx, invitee.id, membership.id, input.profile, projectIds, actorId);
    await this.audit.record(tx, {
      actorId, action: opts.auditAction ?? 'team.invite', subjectType: 'client_membership', subjectId: membership.id,
      next: { client_id: client.id, email, profile: input.profile, project_ids: projectIds, new_account: !existing },
    });
    await this.issue(tx, base, membership.id, { email, ...invitee }, client.name);
    return SENT;
  }

  /** A fresh link for a membership not yet accepted; every earlier link stops working. */
  async resend(tx: Tx, membershipId: string, actorId: string, opts: { auditAction?: string } = {}): Promise<{ status: 'invitation_sent' }> {
    const base = this.baseUrl();
    const m = await tx
      .selectFrom('client_membership as m')
      .innerJoin('administrator as a', 'a.id', 'm.administrator_id')
      .innerJoin('client as c', 'c.id', 'm.client_id')
      .select(['m.id', 'm.status', 'a.email', 'a.name', 'a.language', 'a.password_hash', 'c.name as client_name'])
      .where('m.id', '=', membershipId)
      .forUpdate()
      .executeTakeFirst();
    if (!m) throw new PlatformError('NOT_FOUND', 'No such member.');
    if (m.status !== 'pending') throw new PlatformError('RULE_VIOLATION', 'Only an invitation that is not yet accepted can be sent again.');
    await tx.updateTable('invitation').set({ expires_at: sql`now()` }).where('membership_id', '=', m.id).where('used_at', 'is', null).where('expires_at', '>', sql<Date>`now()`).execute();
    await this.audit.record(tx, { actorId, action: opts.auditAction ?? 'team.resend', subjectType: 'client_membership', subjectId: m.id });
    await this.issue(tx, base, m.id, { email: m.email, name: m.name, language: m.language as 'en' | 'fr', setsPassword: m.password_hash === null }, m.client_name);
    return SENT;
  }

  /** What the invitation page shows before accepting. Unknown, expired and used links answer alike. */
  async preview(token: string): Promise<{ client_name: string; sets_password: boolean }> {
    const inv = await this.valid(this.db, token);
    return { client_name: inv.client_name, sets_password: inv.sets_password };
  }

  async accept(token: string, input: { password?: string }): Promise<{ ok: true }> {
    // Hashed before the transaction: argon2 need not hold the row lock.
    const inv = await this.valid(this.db, token);
    let hash: string | null = null;
    if (inv.sets_password) {
      assertPasswordStrength(input.password as string);
      hash = await CryptoService.hashSecret(input.password!);
    }
    return this.db.transaction().execute(async (tx) => {
      // Read again under lock, so two concurrent uses of one link activate it once.
      const locked = await this.valid(tx, token, true);
      if (locked.sets_password && hash) await tx.updateTable('administrator').set({ password_hash: hash }).where('id', '=', locked.administrator_id).where('password_hash', 'is', null).execute();
      await this.activate(tx, locked.membership_id, locked.administrator_id);
      return { ok: true as const };
    });
  }

  /** The existing-account path: a signed-in person accepts a pending membership of their own. Anyone else's is absent. */
  async acceptMembership(administratorId: string, membershipId: string): Promise<{ ok: true }> {
    if (!isUuid(membershipId)) throw new PlatformError('NOT_FOUND', 'Not found.');
    return this.db.transaction().execute(async (tx) => {
      const m = await tx
        .selectFrom('client_membership as m')
        .innerJoin('client as c', 'c.id', 'm.client_id')
        .select('m.id')
        .where('m.id', '=', membershipId)
        .where('m.administrator_id', '=', administratorId)
        .where('m.status', '=', 'pending')
        .where('c.status', '=', 'active')
        .forUpdate()
        .executeTakeFirst();
      if (!m) throw new PlatformError('NOT_FOUND', 'Not found.');
      await this.activate(tx, m.id, administratorId);
      return { ok: true as const };
    });
  }

  /** Replaces a membership's assignment in one go and ends the member's sessions in that client, so the new access applies at once. */
  async replaceAccess(tx: Tx, membershipId: string, profile: ClientProfile, projectIds: string[], actorId: string, opts: { auditAction?: string } = {}) {
    const m = await tx.selectFrom('client_membership').select(['id', 'client_id', 'administrator_id']).where('id', '=', membershipId).forUpdate().executeTakeFirstOrThrow();
    const scoped = profile === 'owner' ? [] : await this.assertProjects(tx, m.client_id, projectIds);
    const prior = await this.accessOf(tx, m.id);
    await tx.deleteFrom('role_assignment').where('membership_id', '=', m.id).execute();
    await this.writeAssignment(tx, m.administrator_id, m.id, profile, scoped, actorId);
    await this.revokeSessionsIn(tx, m.administrator_id, m.client_id, actorId);
    await this.audit.record(tx, { actorId, action: opts.auditAction ?? 'team.access', subjectType: 'client_membership', subjectId: m.id, prior, next: { profile, project_ids: scoped } });
    return { membership_id: m.id, profile, project_ids: scoped };
  }

  /**
   * Disables a membership, ending its sessions in that client, or enables it again. A membership never
   * accepted goes back to pending, never to active: enabling must not stand in for the invitee's acceptance.
   */
  async setStatus(tx: Tx, membershipId: string, status: 'active' | 'disabled', actorId: string, opts: { auditAction?: string } = {}) {
    const m = await tx.selectFrom('client_membership').select(['id', 'client_id', 'administrator_id', 'status', 'accepted_at']).where('id', '=', membershipId).forUpdate().executeTakeFirstOrThrow();
    const next = status === 'disabled' ? 'disabled' : (m.accepted_at ? 'active' : 'pending');
    await tx.updateTable('client_membership').set({ status: next, disabled_by_client: false }).where('id', '=', m.id).execute();
    if (next === 'disabled') await this.revokeSessionsIn(tx, m.administrator_id, m.client_id, actorId);
    await this.audit.record(tx, { actorId, action: opts.auditAction ?? 'team.status', subjectType: 'client_membership', subjectId: m.id, prior: { status: m.status }, next: { status: next } });
    return { membership_id: m.id, status: next };
  }

  /** The profile and project list of a membership's assignment. */
  async accessOf(exec: Executor, membershipId: string): Promise<{ profile: ClientProfile | null; project_ids: string[] }> {
    const rows = await exec
      .selectFrom('role_assignment as ra')
      .innerJoin('role as r', 'r.id', 'ra.role_id')
      .leftJoin('role_assignment_scope as s', 's.assignment_id', 'ra.id')
      .select(['r.name', 's.project_id'])
      .where('ra.membership_id', '=', membershipId)
      .orderBy('s.project_id')
      .execute();
    return { profile: CLIENT_ROLES.find((r) => r.name === rows[0]?.name)?.profile ?? null, project_ids: rows.flatMap((r) => (r.project_id ? [r.project_id] : [])) };
  }

  /** Every listed project must belong to this client, whoever writes the assignment. */
  async assertProjects(exec: Executor, clientId: string, projectIds: string[]): Promise<string[]> {
    const ids = [...new Set(projectIds)];
    if (ids.length === 0) return [];
    const unknown = () => new PlatformError('FIELD_INVALID', 'Unknown project.', { field: 'project_ids' });
    if (!ids.every(isUuid)) throw unknown();
    const found = await exec.selectFrom('project').select('id').where('id', 'in', ids).where('client_id', '=', clientId).execute();
    if (found.length !== ids.length) throw unknown();
    return ids;
  }

  private baseUrl(): string {
    // A relative link in a mail is worse than no mail: it would point nowhere, or somewhere else.
    if (!this.config.PUBLIC_BASE_URL) throw new PlatformError('RULE_VIOLATION', 'Invitations cannot be sent: PUBLIC_BASE_URL is not configured.');
    return this.config.PUBLIC_BASE_URL.replace(/\/+$/, '');
  }

  private async writeAssignment(tx: Tx, administratorId: string, membershipId: string, profile: ClientProfile, projectIds: string[], actorId: string): Promise<void> {
    const roleName = CLIENT_ROLES.find((r) => r.profile === profile)!.name;
    const role = await tx.selectFrom('role').select('id').where('name', '=', roleName).where('kind', '=', 'client').executeTakeFirstOrThrow();
    const assignment = await tx
      .insertInto('role_assignment')
      .values({ administrator_id: administratorId, role_id: role.id, scope_type: profile === 'owner' ? 'client' : 'projects', membership_id: membershipId, granted_by: actorId })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (profile !== 'owner' && projectIds.length) {
      await tx.insertInto('role_assignment_scope').values(projectIds.map((project_id) => ({ assignment_id: assignment.id, project_id }))).execute();
    }
  }

  private async revokeSessionsIn(tx: Tx, administratorId: string, clientId: string, actorId: string): Promise<void> {
    await tx.updateTable('admin_session').set({ revoked_at: sql`now()`, revoked_by: actorId })
      .where('administrator_id', '=', administratorId).where('active_client_id', '=', clientId).where('revoked_at', 'is', null).execute();
  }

  /** One link per call: 32 random bytes, kept only as a hash, valid 72 hours. */
  private async issue(tx: Tx, base: string, membershipId: string, invitee: { email: string; name: string; language: 'en' | 'fr'; setsPassword: boolean }, clientName: string): Promise<void> {
    const token = CryptoService.randomToken(32);
    await tx.insertInto('invitation').values({
      membership_id: membershipId, token_hash: CryptoService.tokenHash(token), sets_password: invitee.setsPassword,
      expires_at: sql`now() + make_interval(hours => ${VALIDITY_HOURS})`,
    }).execute();
    await this.mailer.send(this.mail(invitee, clientName, `${base}/console/invitation/${token}`));
  }

  /**
   * The invitation behind a token, if it can still be used. One query for every case, its conditions in SQL,
   * so an unknown, expired, used or withdrawn link takes the same path and gets the same answer.
   */
  private async valid(exec: Executor, token: string, lock = false) {
    let q = exec
      .selectFrom('invitation as i')
      .innerJoin('client_membership as m', 'm.id', 'i.membership_id')
      .innerJoin('client as c', 'c.id', 'm.client_id')
      .innerJoin('administrator as a', 'a.id', 'm.administrator_id')
      .select(['i.id', 'i.membership_id', 'm.administrator_id', 'c.name as client_name', sql<boolean>`i.sets_password and a.password_hash is null`.as('sets_password')])
      .where('i.token_hash', '=', CryptoService.tokenHash(token))
      .where('i.used_at', 'is', null)
      .where('i.expires_at', '>', sql<Date>`now()`)
      .where('m.status', '=', 'pending')
      .where('c.status', '=', 'active')
      .where('a.status', '=', 'active');
    if (lock) q = q.forUpdate();
    const row = await q.executeTakeFirst();
    if (!row) throw new PlatformError('FIELD_INVALID', NO_LONGER_VALID, { field: 'token' });
    return row;
  }

  private async activate(tx: Tx, membershipId: string, administratorId: string): Promise<void> {
    await tx.updateTable('client_membership').set({ status: 'active', accepted_at: sql`now()` }).where('id', '=', membershipId).where('status', '=', 'pending').execute();
    await tx.updateTable('invitation').set({ used_at: sql`now()` }).where('membership_id', '=', membershipId).where('used_at', 'is', null).execute();
    await this.audit.record(tx, { actorId: administratorId, action: 'invitation.accept', subjectType: 'client_membership', subjectId: membershipId });
  }

  /** The invitation mail in the invitee's language. An account still without a password is told to choose one. */
  private mail(invitee: { email: string; name: string; language: 'en' | 'fr'; setsPassword: boolean }, clientName: string, link: string): Mail {
    const sandbox = this.config.PROXIAPAY_ENV === 'sandbox';
    const fr = invitee.language === 'fr';
    const subject = invitee.setsPassword
      ? (fr ? 'Votre accès à la console ProxiaPay' : 'Your access to the ProxiaPay console')
      : (fr ? `Vous avez été ajouté à l'équipe de ${clientName} sur ProxiaPay` : `You were added to ${clientName}'s team on ProxiaPay`);
    const lines = fr
      ? [
          `Bonjour ${invitee.name},`,
          '',
          invitee.setsPassword
            ? `${clientName} vous invite sur la console ProxiaPay. Ouvrez ce lien pour choisir votre mot de passe :`
            : `${clientName} vous a ajouté à son équipe sur la console ProxiaPay. Ouvrez ce lien pour accepter, ou acceptez depuis la console une fois connecté :`,
          link,
          `Le lien ne sert qu'une fois et expire dans ${VALIDITY_HOURS} heures.`,
          '',
          sandbox
            ? 'Environnement : sandbox. À la connexion, le code demandé après le mot de passe accepte six chiffres quelconques.'
            : 'Environnement : production. À la première connexion, vous associerez une application d\'authentification pour le second facteur.',
        ]
      : [
          `Hello ${invitee.name},`,
          '',
          invitee.setsPassword
            ? `${clientName} invites you to the ProxiaPay console. Open this link to choose your password:`
            : `${clientName} added you to its team on the ProxiaPay console. Open this link to accept, or accept from the console once signed in:`,
          link,
          `The link works once and expires in ${VALIDITY_HOURS} hours.`,
          '',
          sandbox
            ? 'Environment: sandbox. At sign-in, the code asked for after the password is any six digits.'
            : 'Environment: production. At your first sign-in you will set up an authenticator app for the second factor.',
        ];
    return { to: invitee.email, subject, text: lines.join('\n'), sensitive: true };
  }
}
