import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { CryptoService } from '../crypto/crypto.service';
import { DB_TOKEN, type Db, type Executor } from '../db/database';
import type { AdapterContext } from './adapter';
import { ProviderRegistry } from './provider-registry';
import { AuditService } from '../audit/audit.service';

/** Provider accounts: credentials sealed at rest, read at use, never returned (spec 3.3, 10). */
@Injectable()
export class ProviderAccountService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly crypto: CryptoService,
    private readonly registry: ProviderRegistry,
    private readonly audit: AuditService,
  ) {}

  async context(exec: Executor, providerAccountId: string, correlationId: string, transactionId?: string): Promise<{ ctx: AdapterContext; adapterKey: string }> {
    const account = await exec
      .selectFrom('provider_account as pa')
      .innerJoin('provider as p', 'p.code', 'pa.provider_code')
      .select(['pa.id', 'pa.base_url', 'pa.credential_ciphertext', 'p.adapter_key'])
      .where('pa.id', '=', providerAccountId)
      .executeTakeFirstOrThrow();
    const credentials = account.credential_ciphertext ? (JSON.parse(this.crypto.openString(account.credential_ciphertext, `provider_account:${account.id}`)) as Record<string, string>) : {};
    const db = this.db;
    const ctx: AdapterContext = {
      // A base address pasted with stray whitespace or a byte-order mark, or without a scheme, is normalised here.
      account: { id: account.id, baseUrl: normaliseBaseUrl(account.base_url), credentials },
      correlationId,
      transactionId,
      async recordPayload(flow, kind, body) {
        const row = await db
          .insertInto('provider_payload')
          .values({ provider_account_id: account.id, transaction_id: transactionId ?? null, flow, kind, body: JSON.stringify(body ?? null), correlation_id: correlationId })
          .returning('id')
          .executeTakeFirstOrThrow();
        return row.id;
      },
    };
    return { ctx, adapterKey: account.adapter_key };
  }

  adapter(key: string) {
    return this.registry.get(key);
  }

  async setCredentials(exec: Executor, providerAccountId: string, credentials: Record<string, string>, actorId: string, confirmationId?: string): Promise<void> {
    await exec.updateTable('provider_account').set({ credential_ciphertext: this.crypto.seal(JSON.stringify(credentials), `provider_account:${providerAccountId}`) }).where('id', '=', providerAccountId).execute();
    await this.audit.record(exec, { actorId, action: 'provider_account.credentials_replaced', subjectType: 'provider_account', subjectId: providerAccountId, next: { keys: Object.keys(credentials) }, confirmationId });
  }

  async setStatus(exec: Executor, providerAccountId: string, status: 'active' | 'suspended', actorId: string): Promise<void> {
    const prior = await exec.selectFrom('provider_account').select('status').where('id', '=', providerAccountId).executeTakeFirstOrThrow();
    await exec.updateTable('provider_account').set({ status, suspended_at: status === 'suspended' ? sql`now()` : null, suspended_by: status === 'suspended' ? actorId : null }).where('id', '=', providerAccountId).execute();
    await this.audit.record(exec, { actorId, action: status === 'suspended' ? 'provider_account.suspend' : 'provider_account.restore', subjectType: 'provider_account', subjectId: providerAccountId, prior: { status: prior.status }, next: { status } });
  }

  /** Retention of raw exchanges (spec 14.3): 90 days. */
  async pruneOldPayloads(days = 90): Promise<number> {
    const result = await sql`delete from provider_payload where created_at < now() - make_interval(days => ${days})
      and id not in (select request_payload_id from transaction_attempt where request_payload_id is not null union select response_payload_id from transaction_attempt where response_payload_id is not null)`.execute(this.db);
    return Number(result.numAffectedRows ?? 0);
  }
}

export function normaliseBaseUrl(raw: string): string {
  const cleaned = raw.replace(/^\uFEFF/, '').trim().replace(/\/+$/, '');
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;
}
