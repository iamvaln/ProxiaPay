import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { PlatformError } from '../common/errors';
import { CONFIG, type AppConfig } from '../config/config';
import { CryptoService } from '../crypto/crypto.service';
import { DB_TOKEN, type Db } from '../db/database';
import { addressInCidr } from '../http/client-address';
import { SettingsService } from '../settings/settings.service';
import { RateLimiter, type RateLimitState } from './rate-limiter';
import { AlertService } from '../alerts/alert.service';
import type { CredentialScope } from './credential.service';

export interface ProjectPrincipal {
  projectId: string;
  projectCode: string;
  credentialId: string;
  credentialKey: string;
  scopes: CredentialScope[];
  tokenId: string;
}

/**
 * The project side of authentication (spec 7.1, API reference 3): origin is checked before
 * anything else, a key and secret exchange for a token held hashed in the store, tokens are
 * concurrent and independent, and revoking a credential invalidates every token under it.
 */
@Injectable()
export class ProjectAuthService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Pick<AppConfig, 'PROXIAPAY_ENV'>,
    private readonly settings: SettingsService,
    private readonly rateLimiter: RateLimiter,
    private readonly alerts: AlertService,
  ) {}

  /** Origin is judged for the project the key belongs to. In sandbox a project with no declared origin passes. */
  async checkOrigin(projectId: string, credentialKey: string, address: string): Promise<void> {
    const origins = await this.db.selectFrom('project_origin').select('cidr').where('project_id', '=', projectId).where('active', '=', true).execute();
    if (origins.length === 0) {
      if (this.config.PROXIAPAY_ENV === 'sandbox') return;
    } else if (origins.some((o) => addressInCidr(address, o.cidr))) {
      return;
    }
    await this.db.insertInto('origin_refusal').values({ project_id: projectId, credential_key: credentialKey, origin_address: address }).execute();
    await this.alerts.raise({
      category: 'security', severity: 'warning', subjectType: 'project', subjectReference: projectId, projectId,
      fingerprint: `origin_refused:${projectId}`, title: 'Calls refused on origin', detail: { credential_key: credentialKey, address }, actionReference: `/projects/${projectId}#origins`,
    }).catch(() => undefined);
    throw new PlatformError('ORIGIN_NOT_ALLOWED', 'The call came from an address the project has not declared.');
  }

  async exchange(clientKey: string, clientSecret: string, address: string): Promise<{ access_token: string; token_type: 'Bearer'; expires_in: number }> {
    const cred = await this.db
      .selectFrom('project_credential as c')
      .innerJoin('project as p', 'p.id', 'c.project_id')
      .select(['c.id', 'c.project_id', 'c.secret_hash', 'c.status', 'c.key', 'p.status as project_status'])
      .where('c.key', '=', clientKey)
      .executeTakeFirst();
    // Origin first (API reference 3.3), against the project the key names; an unknown key is judged after a dummy verify.
    if (cred) await this.checkOrigin(cred.project_id, cred.key, address);
    const ok = cred ? await CryptoService.verifySecret(cred.secret_hash, clientSecret) : await CryptoService.verifySecret(DUMMY, clientSecret).then(() => false);
    if (!cred || !ok) throw new PlatformError('CREDENTIALS_INVALID', 'The key or secret is unrecognised.');
    if (cred.status === 'revoked') throw new PlatformError('CREDENTIALS_REVOKED', 'The credential has been revoked.');
    if (cred.status !== 'active' || cred.project_status !== 'active') throw new PlatformError('CREDENTIALS_INVALID', 'The key or secret is unrecognised.');

    const perMinute = await this.settings.number('token.exchange_limit_per_minute');
    const rl = await this.rateLimiter.hit(`exchange:${cred.id}`, perMinute);
    if (rl.exceeded) {
      await this.alerts.raise({
        category: 'security', severity: 'warning', subjectType: 'project_credential', subjectReference: cred.key, projectId: cred.project_id,
        fingerprint: `exchange_rate:${cred.id}`, title: 'Credential exchanging tokens too often', detail: { key: cred.key, per_minute: perMinute }, actionReference: `/projects/${cred.project_id}#credentials`,
      }).catch(() => undefined);
      throw new PlatformError('RATE_LIMITED', 'Token exchanges are limited; hold the token you have.', { headers: { 'Retry-After': String(Math.max(1, Math.ceil((rl.resetAt.getTime() - Date.now()) / 1000))) } });
    }

    const lifetime = await this.settings.number('token.lifetime_seconds');
    const token = `pt_${CryptoService.randomToken(32)}`;
    await this.db
      .insertInto('project_token')
      .values({ credential_id: cred.id, token_hash: CryptoService.tokenHash(token), expires_at: sql`now() + make_interval(secs => ${lifetime})`, origin_address: address })
      .execute();

    const threshold = await this.settings.number('token.live_alert_threshold');
    const { rows } = await sql<{ n: number }>`select count(*)::int as n from project_token where credential_id = ${cred.id} and revoked_at is null and expires_at > now()`.execute(this.db);
    if (rows[0]!.n > threshold) {
      await this.alerts.raise({
        category: 'security', severity: 'warning', subjectType: 'project_credential', subjectReference: cred.key, projectId: cred.project_id,
        fingerprint: `live_tokens:${cred.id}`, title: 'Unusual number of live tokens on one credential', detail: { key: cred.key, live: rows[0]!.n }, actionReference: `/projects/${cred.project_id}#credentials`,
      }).catch(() => undefined);
    }
    return { access_token: token, token_type: 'Bearer', expires_in: lifetime };
  }

  async resolveToken(token: string, address: string): Promise<ProjectPrincipal> {
    const row = await this.db
      .selectFrom('project_token as t')
      .innerJoin('project_credential as c', 'c.id', 't.credential_id')
      .innerJoin('project as p', 'p.id', 'c.project_id')
      .select(['t.id as token_id', 't.expires_at', 't.revoked_at', 'c.id as credential_id', 'c.key', 'c.scopes', 'c.status', 'p.id as project_id', 'p.code', 'p.status as project_status'])
      .where('t.token_hash', '=', CryptoService.tokenHash(token))
      .executeTakeFirst();
    if (!row) throw new PlatformError('TOKEN_INVALID', 'The token is unrecognised.');
    await this.checkOrigin(row.project_id, row.key, address);
    if (row.revoked_at || row.status !== 'active') throw new PlatformError('TOKEN_INVALID', 'The token was revoked with its credential.');
    if (row.project_status !== 'active') throw new PlatformError('TOKEN_INVALID', 'The project is suspended.');
    if (row.expires_at.getTime() <= Date.now()) throw new PlatformError('TOKEN_EXPIRED', "The token's period elapsed; exchange again.");
    return { projectId: row.project_id, projectCode: row.code, credentialId: row.credential_id, credentialKey: row.key, scopes: row.scopes as CredentialScope[], tokenId: row.token_id };
  }

  async requestRateLimit(principal: ProjectPrincipal): Promise<RateLimitState> {
    const limit = await this.settings.number('api.request_rate_limit_per_minute');
    return this.rateLimiter.hit(`request:${principal.credentialId}`, limit);
  }
}

const DUMMY = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$Uv6yGt0d2hcCzc0h3Y8f2Y3nQmC7l3l3Y9m3bS6y4Ck';
