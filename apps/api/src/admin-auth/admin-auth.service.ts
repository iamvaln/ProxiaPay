import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { PlatformError } from '../common/errors';
import { CryptoService } from '../crypto/crypto.service';
import { generateTotpSecret, totpUri, verifyTotp } from '../crypto/totp';
import { DB_TOKEN, type Db, type Executor } from '../db/database';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../audit/audit.service';

export interface SessionPrincipal {
  sessionId: string;
  administratorId: string;
  name: string;
  email: string;
  language: 'en' | 'fr';
  timezone: string;
  secondFactorComplete: boolean;
}

interface Client { address: string; description: string }

/**
 * Administrator authentication (spec 10, console spec 4.1): email and password, then a
 * second factor, with lockout after repeated failures, every attempt recorded, and sessions
 * held in the store so any instance can serve them and any of them can be revoked.
 */
@Injectable()
export class AdminAuthService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly crypto: CryptoService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  async createAdministrator(exec: Executor, input: { name: string; email: string; password: string; language?: 'en' | 'fr'; createdBy?: string | null }): Promise<{ id: string }> {
    assertPasswordStrength(input.password);
    const row = await exec
      .insertInto('administrator')
      .values({ name: input.name, email: input.email.trim().toLowerCase(), password_hash: await CryptoService.hashSecret(input.password), language: input.language ?? 'en' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.audit.record(exec, { actorId: input.createdBy ?? null, action: 'administrator.create', subjectType: 'administrator', subjectId: row.id, next: { name: input.name, email: input.email } });
    return row;
  }

  /**
   * Step one of sign-in. On success a session exists but is not yet usable: the second factor
   * must complete before any console operation is served. Failures name neither which of the
   * two inputs was wrong nor whether the address is known.
   */
  async signIn(email: string, password: string, client: Client): Promise<{ sessionToken: string; secondFactor: 'verify' | 'enrol' } | { locked_until: Date }> {
    const normalised = email.trim().toLowerCase();
    const admin = await this.db.selectFrom('administrator').selectAll().where('email', '=', normalised).executeTakeFirst();
    const now = new Date();
    if (admin?.locked_until && admin.locked_until > now) {
      await this.recordAuthEvent({ email: normalised, administratorId: admin.id, outcome: 'locked', reason: 'account locked', client });
      return { locked_until: admin.locked_until };
    }
    // Verify against a real hash even when no administrator matches, so timing does not reveal which addresses exist.
    const ok = admin ? await CryptoService.verifySecret(admin.password_hash, password) : await CryptoService.verifySecret(DUMMY_HASH, password).then(() => false);
    if (!admin || admin.status !== 'active' || !ok) {
      await this.recordAuthEvent({ email: normalised, administratorId: admin?.id ?? null, outcome: 'failure', reason: admin ? (admin.status !== 'active' ? 'disabled' : 'password mismatch') : 'unknown address', client });
      if (admin) await this.maybeLock(admin.id, normalised, client);
      throw new PlatformError('CREDENTIALS_INVALID', 'The address and password did not match.');
    }
    const absolute = await this.settings.number('session.absolute_seconds');
    const token = CryptoService.randomToken(32);
    await this.db
      .insertInto('admin_session')
      .values({
        administrator_id: admin.id,
        token_hash: CryptoService.tokenHash(token),
        expires_at: new Date(now.getTime() + absolute * 1000),
        origin_address: client.address,
        client_description: client.description.slice(0, 256),
      })
      .execute();
    await this.recordAuthEvent({ email: normalised, administratorId: admin.id, outcome: 'success', reason: 'password accepted; second factor pending', client });
    return { sessionToken: token, secondFactor: admin.totp_enrolled_at ? 'verify' : 'enrol' };
  }

  /** Begins enrolment of an authenticator for an administrator who has none. The secret is sealed and shown once. */
  async beginTotpEnrolment(principal: SessionPrincipal): Promise<{ secret: string; uri: string }> {
    const admin = await this.db.selectFrom('administrator').select(['totp_enrolled_at', 'email']).where('id', '=', principal.administratorId).executeTakeFirstOrThrow();
    if (admin.totp_enrolled_at) throw new PlatformError('CONFLICT', 'A second factor is already enrolled.');
    const secret = generateTotpSecret();
    await this.db.updateTable('administrator').set({ totp_secret_ciphertext: this.crypto.seal(secret, `totp:${principal.administratorId}`) }).where('id', '=', principal.administratorId).execute();
    return { secret, uri: totpUri('ProxiaPay', admin.email, secret) };
  }

  /** Completes the second factor for a session, whether verifying an enrolled authenticator or finishing enrolment. */
  async completeSecondFactor(principal: SessionPrincipal, code: string, client: Client): Promise<void> {
    const admin = await this.db.selectFrom('administrator').selectAll().where('id', '=', principal.administratorId).executeTakeFirstOrThrow();
    if (!admin.totp_secret_ciphertext) throw new PlatformError('SECOND_FACTOR_REQUIRED', 'Enrol an authenticator first.');
    const secret = this.crypto.openString(admin.totp_secret_ciphertext, `totp:${admin.id}`);
    if (!verifyTotp(secret, code)) {
      await this.recordAuthEvent({ email: admin.email, administratorId: admin.id, outcome: 'second_factor_failure', reason: 'code rejected', client });
      await this.maybeLock(admin.id, admin.email, client);
      throw new PlatformError('CREDENTIALS_INVALID', 'The code was not accepted.');
    }
    await this.db.transaction().execute(async (tx) => {
      await tx.updateTable('admin_session').set({ second_factor_at: new Date(), last_seen_at: new Date() }).where('id', '=', principal.sessionId).execute();
      const patch: Record<string, unknown> = { last_sign_in_at: new Date(), locked_until: null };
      if (!admin.totp_enrolled_at) patch.totp_enrolled_at = new Date();
      await tx.updateTable('administrator').set(patch).where('id', '=', admin.id).execute();
    });
    await this.recordAuthEvent({ email: admin.email, administratorId: admin.id, outcome: 'success', reason: admin.totp_enrolled_at ? 'second factor accepted' : 'authenticator enrolled', client });
  }

  /** Resolves a session token to its principal, applying idle and absolute expiry from the store's clock. */
  async resolveSession(token: string): Promise<SessionPrincipal | undefined> {
    if (!token) return undefined;
    const idle = await this.settings.number('session.idle_seconds');
    const row = await this.db
      .selectFrom('admin_session as s')
      .innerJoin('administrator as a', 'a.id', 's.administrator_id')
      .select(['s.id as session_id', 's.second_factor_at', 's.expires_at', 's.last_seen_at', 'a.id as admin_id', 'a.name', 'a.email', 'a.language', 'a.timezone', 'a.status'])
      .where('s.token_hash', '=', CryptoService.tokenHash(token))
      .where('s.revoked_at', 'is', null)
      .where('s.expires_at', '>', sql<Date>`now()`)
      .where('s.last_seen_at', '>', sql<Date>`now() - make_interval(secs => ${idle})`)
      .executeTakeFirst();
    if (!row || row.status !== 'active') return undefined;
    // Touch at most once a minute to keep the write cheap.
    if (Date.now() - row.last_seen_at.getTime() > 60_000) {
      await this.db.updateTable('admin_session').set({ last_seen_at: sql`now()` }).where('id', '=', row.session_id).execute();
    }
    return {
      sessionId: row.session_id,
      administratorId: row.admin_id,
      name: row.name,
      email: row.email,
      language: row.language as 'en' | 'fr',
      timezone: row.timezone,
      secondFactorComplete: row.second_factor_at != null,
    };
  }

  async revokeSession(sessionId: string, revokedBy: string | null): Promise<void> {
    await this.db.updateTable('admin_session').set({ revoked_at: sql`now()`, revoked_by: revokedBy }).where('id', '=', sessionId).where('revoked_at', 'is', null).execute();
  }

  async revokeAllSessions(administratorId: string, revokedBy: string | null): Promise<void> {
    await this.db.updateTable('admin_session').set({ revoked_at: sql`now()`, revoked_by: revokedBy }).where('administrator_id', '=', administratorId).where('revoked_at', 'is', null).execute();
  }

  async listSessions(administratorId: string) {
    return this.db.selectFrom('admin_session').select(['id', 'issued_at', 'expires_at', 'last_seen_at', 'origin_address', 'client_description', 'revoked_at'])
      .where('administrator_id', '=', administratorId).orderBy('issued_at', 'desc').limit(50).execute();
  }

  async changePassword(administratorId: string, current: string, next: string): Promise<void> {
    const admin = await this.db.selectFrom('administrator').select('password_hash').where('id', '=', administratorId).executeTakeFirstOrThrow();
    if (!(await CryptoService.verifySecret(admin.password_hash, current))) throw new PlatformError('CREDENTIALS_INVALID', 'The current password did not match.');
    assertPasswordStrength(next);
    await this.db.updateTable('administrator').set({ password_hash: await CryptoService.hashSecret(next) }).where('id', '=', administratorId).execute();
  }

  private async maybeLock(administratorId: string, email: string, client: Client): Promise<void> {
    const failures = await this.settings.number('auth.lockout_failures');
    const windowSeconds = await this.settings.number('auth.lockout_window_seconds');
    const lockSeconds = await this.settings.number('auth.lockout_seconds');
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from authentication_event
       where administrator_id = ${administratorId} and outcome in ('failure', 'second_factor_failure')
         and occurred_at > now() - make_interval(secs => ${windowSeconds})`.execute(this.db);
    if (rows[0]!.n >= failures) {
      await this.db.updateTable('administrator').set({ locked_until: sql`now() + make_interval(secs => ${lockSeconds})` }).where('id', '=', administratorId).execute();
      await this.recordAuthEvent({ email, administratorId, outcome: 'locked', reason: `locked after ${rows[0]!.n} failures`, client });
    }
  }

  async recordAuthEvent(e: { email: string; administratorId: string | null; outcome: 'success' | 'failure' | 'locked' | 'second_factor_failure'; reason: string; client: Client }): Promise<void> {
    await this.db
      .insertInto('authentication_event')
      .values({ email_presented: e.email, administrator_id: e.administratorId, outcome: e.outcome, reason: e.reason, origin_address: e.client.address, client_description: e.client.description.slice(0, 256) })
      .execute();
  }
}

/** A valid argon2id hash of a random value, verified against on unknown addresses so response time matches a real one. */
const DUMMY_HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$Uv6yGt0d2hcCzc0h3Y8f2Y3nQmC7l3l3Y9m3bS6y4Ck';

export function assertPasswordStrength(password: string): void {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
    throw new PlatformError('FIELD_INVALID', 'Password must be between 12 and 256 characters.', { field: 'password' });
  }
}
