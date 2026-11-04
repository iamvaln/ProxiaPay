/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomBytes } from 'node:crypto';
import { loadEnv } from './env';
import { createDb, createPool, type Db } from '../db/database';

/**
 * Dev-only bulk seeder: enough rows for every console list to have three pages at 25 rows, so the
 * shared table can be looked at in a browser. Usage (against a migrated, seeded preview database):
 *   node -r @swc-node/register src/cli/seed-lists.ts
 * Safe to run twice: each family tops up to its target, counting what an earlier run left.
 */
export function assertSafeTarget(env: string | undefined, databaseUrl: string | undefined, allowRemote?: string): void {
  if (env !== 'sandbox') throw new Error('seed-lists writes bulk fake rows and runs only with PROXIAPAY_ENV=sandbox set explicitly');
  if (!databaseUrl) throw new Error('seed-lists needs DATABASE_URL');
  const host = new URL(databaseUrl).hostname;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host) && allowRemote !== '1') throw new Error(`seed-lists refuses a database on ${host}; set SEED_LISTS_ALLOW_REMOTE=1 to force it`);
}

const TARGET = { transactions: 300, previews: 60, audit: 300, alerts: 80, discrepancies: 60, runs: 80, transfers: 80, cashouts: 80, entries: 80, deliveries: 80, refusals: 80, auth: 120, exports: 80 };

// Deterministic, so two runs build the same shapes.
let seedState = 20261103;
const rnd = () => ((seedState = (seedState * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const weighted = <T>(xs: readonly (readonly [T, number])[]): T => {
  let r = rnd() * xs.reduce((s, x) => s + x[1], 0);
  for (const [v, w] of xs) if ((r -= w) < 0) return v;
  return xs[0]![0];
};
const ago = (days: number) => new Date(Date.now() - days * 86_400_000);
const spread = (i: number, n: number, days: number) => new Date(Date.now() - ((i + rnd()) / n) * days * 86_400_000);
const ref = (prefix: string, i: number) => `${prefix}SEED${String(i).padStart(5, '0')}${randomBytes(6).toString('hex').toUpperCase()}`;
const ip = () => `10.${Math.floor(rnd() * 250)}.${Math.floor(rnd() * 250)}.${1 + Math.floor(rnd() * 250)}`;

export async function seedLists(db: Db): Promise<Record<string, number>> {
  const added: Record<string, number> = {};
  const top = async (name: keyof typeof TARGET, have: number, make: (i: number) => Promise<void> | void) => {
    const need = Math.max(0, TARGET[name] - have);
    for (let i = 0; i < need; i++) await make(have + i);
    added[name] = need;
  };
  const count = async (table: string, col: string, like: string) =>
    Number((await db.selectFrom(table as any).select((e: any) => e.fn.countAll().as('n')).where(col, 'like', like).executeTakeFirstOrThrow() as any).n);

  const admin = await db.selectFrom('administrator').select('id').orderBy('created_at').executeTakeFirstOrThrow();
  const second = (await db.selectFrom('administrator').select('id').where('email', '=', 'grace.seed@example.com').executeTakeFirst())
    ?? await db.insertInto('administrator').values({ name: 'Grace Seed', email: 'grace.seed@example.com', password_hash: '!seed-no-sign-in', status: 'active' }).returning('id').executeTakeFirstOrThrow();
  const admins = [admin.id, second.id];
  const pa = await db.selectFrom('provider_account').select('id').orderBy('created_at').executeTakeFirstOrThrow();

  // Projects: the existing ones plus three seeded, each entitled on the same routes.
  for (const [code, name] of [['seed-alpha', 'Seed Alpha'], ['seed-bravo', 'Seed Bravo'], ['seed-charlie', 'Seed Charlie']] as const) {
    const p = await db.selectFrom('project').select('id').where('code', '=', code).executeTakeFirst();
    if (!p) await db.insertInto('project').values({ code, name, created_by: admin.id }).execute();
  }
  const projects = await db.selectFrom('project').select(['id', 'code']).where('status', '=', 'active').execute();
  const routes = await db.selectFrom('route as r').innerJoin('route_version as v', (j) => j.onRef('v.route_id', '=', 'r.id').on('v.valid_to', 'is', null))
    .select(['r.id as route_id', 'v.id as route_version_id', 'r.direction', 'r.currency_code']).where('r.currency_code', 'in', ['XAF', 'XOF']).orderBy('r.country_code').orderBy('r.payment_method_code').execute();
  const chosen = [...routes.filter((r) => r.direction === 'collection').slice(0, 14), ...routes.filter((r) => r.direction === 'disbursement').slice(0, 4)];
  const bindings = new Map((await db.selectFrom('route_binding').select(['id', 'route_version_id']).where('provider_account_id', '=', pa.id).execute()).map((b) => [b.route_version_id, b.id]));
  const ents: { project_id: string; route: (typeof chosen)[number]; entitlement_version_id: string }[] = [];
  for (const pr of projects) {
    for (const route of chosen) {
      let e = await db.selectFrom('entitlement').select('id').where('project_id', '=', pr.id).where('route_id', '=', route.route_id).executeTakeFirst();
      if (!e) e = await db.insertInto('entitlement').values({ project_id: pr.id, route_id: route.route_id }).returning('id').executeTakeFirstOrThrow();
      let v = await db.selectFrom('entitlement_version').select('id').where('entitlement_id', '=', e.id).where('valid_to', 'is', null).executeTakeFirst();
      if (!v) v = await db.insertInto('entitlement_version').values({ entitlement_id: e.id, sequence: 1, count_24h: 1000, value_24h: 100_000_000, count_30d: 10000, value_30d: 1_000_000_000, note: 'seed-lists', created_by: admin.id }).returning('id').executeTakeFirstOrThrow();
      ents.push({ project_id: pr.id, route, entitlement_version_id: v.id });
    }
    for (const currency of ['XAF', 'XOF']) {
      const has = await db.selectFrom('ledger_account').select('id').where('type', '=', 'project_available').where('project_id', '=', pr.id).where('currency_code', '=', currency).executeTakeFirst();
      if (!has) await db.insertInto('ledger_account').values({ type: 'project_available', project_id: pr.id, currency_code: currency }).execute();
    }
    const ep = await db.selectFrom('project_notification_endpoint').select('id').where('project_id', '=', pr.id).where('active', '=', true).executeTakeFirst();
    if (!ep) await db.insertInto('project_notification_endpoint').values({ project_id: pr.id, url: `https://hooks.example.com/${pr.code}`, signing_secret_ciphertext: randomBytes(48), created_by: admin.id }).execute();
  }

  // Previews and transactions.
  const failures = ['provider_declined', 'insufficient_funds', 'payer_timeout', 'payer_cancelled', 'provider_unavailable'];
  const mkPreview = (i: number, e: (typeof ents)[number], over: Record<string, unknown>) => {
    const amount = pick([500, 1000, 2500, 5000, 10_000, 25_000, 50_000, 120_000]);
    const fee = Math.floor(amount * 0.025);
    const created = (over.created_at as Date | undefined) ?? spread(i, TARGET.transactions, 60);
    const digits = String(1000 + Math.floor(rnd() * 8999));
    return {
      id: undefined as string | undefined,
      values: {
        reference: ref('prv_', i), project_id: e.project_id, route_id: e.route.route_id, route_version_id: e.route.route_version_id, entitlement_version_id: e.entitlement_version_id,
        binding_id: bindings.get(e.route.route_version_id) ?? null, direction: e.route.direction, currency_code: e.route.currency_code, requested_amount: amount,
        processing_fee: fee, platform_fee: 0, processing_fee_bearer: 'counterparty', platform_fee_bearer: 'counterparty', charged_amount: amount + fee, settled_amount: amount,
        expected_provider_fee: Math.floor(amount * 0.02), msisdn_ciphertext: randomBytes(48), msisdn_index: randomBytes(32), msisdn_masked: `+237•••••${digits}`,
        counterparty_name: pick(['A. Mbarga', 'K. Diallo', 'F. Traoré', 'N. Ouédraogo', 'S. Kone', null]), project_reference: `seed-${i}-${randomBytes(3).toString('hex')}`,
        payer_action: pick(['none', 'code', 'browser'] as const), terms_snapshot: { seeded: true }, limits_snapshot: { seeded: true }, correlation_id: randomBytes(8).toString('hex'),
        expires_at: new Date(created.getTime() + 15 * 60_000), status: 'open', created_at: created, ...over,
      } as any,
    };
  };
  const have = await count('transaction', 'reference', 'txn_SEED%');
  await top('transactions', have, async (i) => {
    const e = pick(ents.filter((x) => x.route.direction === 'collection' || rnd() < 0.12));
    const state = weighted([['succeeded', 55], ['failed', 14], ['expired', 5], ['processing', 7], ['submitted', 4], ['action_required', 4], ['undetermined', 6], ['created', 5]] as const);
    const terminal = ['succeeded', 'failed', 'expired'].includes(state);
    const pv = mkPreview(i, e, { status: 'confirmed' });
    const prev = await db.insertInto('preview').values(pv.values).returning(['id', 'created_at', 'requested_amount', 'charged_amount', 'processing_fee', 'platform_fee', 'expected_provider_fee']).executeTakeFirstOrThrow();
    const created = new Date(prev.created_at as any);
    const tx = await db.insertInto('transaction').values({
      reference: ref('txn_', i), preview_id: prev.id, project_id: e.project_id, route_id: e.route.route_id, route_version_id: e.route.route_version_id, entitlement_version_id: e.entitlement_version_id,
      direction: e.route.direction, state, reconciliation_status: state === 'succeeded' ? weighted([['unreviewed', 40], ['matched', 45], ['disputed', 7], ['examined', 5], ['corrected', 3]] as const) : 'unreviewed',
      currency_code: e.route.currency_code, requested_amount: prev.requested_amount, charged_amount: prev.charged_amount, settled_amount: state === 'succeeded' ? prev.requested_amount : null,
      expected_settled_amount: prev.requested_amount, processing_fee: prev.processing_fee, platform_fee: prev.platform_fee, processing_fee_bearer: 'counterparty', platform_fee_bearer: 'counterparty',
      expected_provider_fee: prev.expected_provider_fee, actual_provider_fee: state === 'succeeded' ? prev.expected_provider_fee : null, msisdn_ciphertext: pv.values.msisdn_ciphertext, msisdn_index: pv.values.msisdn_index,
      msisdn_masked: pv.values.msisdn_masked, counterparty_name: pv.values.counterparty_name, project_reference: pv.values.project_reference, terms_snapshot: { seeded: true }, limits_snapshot: { seeded: true },
      payer_action: pv.values.payer_action, binding_id: pv.values.binding_id, selected_provider_account_id: pa.id, failure_reason: state === 'failed' ? pick(failures) : state === 'expired' ? 'payer_timeout' : null,
      terminal_at: terminal ? new Date(created.getTime() + 20_000 + rnd() * 120_000) : null, sweep_ceiling_at: new Date(created.getTime() + 2 * 3_600_000), correlation_id: pv.values.correlation_id, created_at: created, updated_at: created,
    } as any).returning('id').executeTakeFirstOrThrow();
    await db.updateTable('preview').set({ transaction_id: tx.id, confirmed_at: created }).where('id', '=', prev.id).execute();
  });
  // Every submitted transaction has a current attempt: the list reads the provider and its references from it.
  const bare = await db.selectFrom('transaction').select(['id', 'state', 'binding_id', 'failure_reason', 'created_at', 'terminal_at', 'expected_provider_fee']).where('reference', 'like', 'txn_SEED%').where('current_attempt_id', 'is', null).where('state', '<>', 'created').execute();
  for (const t of bare) {
    const a = await db.insertInto('transaction_attempt').values({
      transaction_id: t.id, sequence: 1, provider_account_id: pa.id, binding_id: t.binding_id, binding_snapshot: { seeded: true } as any, provider_reference: `SIMPR${randomBytes(5).toString('hex').toUpperCase()}`,
      operator_reference: t.state === 'succeeded' ? `OP${randomBytes(4).toString('hex').toUpperCase()}` : null, state: t.state === 'expired' ? 'failed' : t.state === 'submitted' ? 'submitting' : t.state,
      actual_provider_fee: t.state === 'succeeded' ? t.expected_provider_fee : null, started_at: t.created_at, ended_at: t.terminal_at, failure_reason: t.failure_reason,
    } as any).returning('id').executeTakeFirstOrThrow();
    await db.updateTable('transaction').set({ current_attempt_id: a.id }).where('id', '=', t.id).execute();
  }
  added.attempts = bare.length;
  // Previews that never became a transaction: the others are counted out.
  const loose = (await count('preview', 'reference', 'prv_SEED%')) - (await count('transaction', 'reference', 'txn_SEED%'));
  await top('previews', loose, async (i) => {
    const e = pick(ents.filter((x) => x.route.direction === 'collection'));
    const open = rnd() < 0.5;
    const created = open ? ago(rnd() * 0.01) : spread(i, 60, 30);
    await db.insertInto('preview').values(mkPreview(10_000 + i, e, { status: open ? 'open' : 'expired', created_at: created, expires_at: open ? new Date(Date.now() + 10 * 60_000) : new Date(created.getTime() + 15 * 60_000) }).values).execute();
  });

  // Audit, authentication history, origin refusals, exports.
  const actions = [['project.update', 'project'], ['route.open_version', 'route'], ['provider.suspend', 'provider_account'], ['alert.acknowledge', 'alert'], ['cashout.approve', 'cashout'], ['role.assign', 'administrator'], ['entitlement.set', 'entitlement']] as const;
  await top('audit', await count('audit_record', 'correlation_id', 'seed-%'), (i) => {
    const [action, subject] = pick(actions);
    return void db.insertInto('audit_record').values({ actor_id: pick(admins), action, subject_type: subject, subject_id: randomBytes(8).toString('hex'), prior_state: { active: false, n: i } as any, new_state: { active: true, n: i + 1 } as any, correlation_id: `seed-${i}`, occurred_at: spread(i, TARGET.audit, 90) }).execute();
  });
  await top('auth', await count('authentication_event', 'reason', 'seed%'), (i) => {
    const outcome = weighted([['success', 70], ['failure', 18], ['locked', 4], ['second_factor_failure', 8]] as const);
    const a = i % 3 === 0 ? second.id : admin.id;
    return void db.insertInto('authentication_event').values({ email_presented: a === admin.id ? 'ada@example.com' : 'grace.seed@example.com', administrator_id: a, outcome, reason: `seed ${outcome}`, origin_address: ip(), client_description: pick(['Chrome 130 on macOS', 'Firefox 132 on Linux', 'Safari 18 on iOS']), occurred_at: spread(i, TARGET.auth, 60) }).execute();
  });
  const shop = projects.find((p) => p.code === 'shop') ?? projects[0]!;
  await top('refusals', await count('origin_refusal', 'credential_key', 'seed-%'), (i) =>
    void db.insertInto('origin_refusal').values({ project_id: shop.id, credential_key: `seed-key-${i % 3}`, origin_address: ip(), occurred_at: spread(i, TARGET.refusals, 30) }).execute());
  await top('exports', await count('export_record', 'signature', 'seed-%'), (i) =>
    void db.insertInto('export_record').values({ administrator_id: pick(admins), subject: pick(['transactions', 'audit', 'discrepancies']), filters: { state: 'succeeded', n: i } as any, row_count: 10 + Math.floor(rnd() * 5000), environment: 'sandbox', signature: `seed-${randomBytes(16).toString('hex')}`, created_at: spread(i, TARGET.exports, 90) }).execute());

  // Alerts.
  await top('alerts', await count('alert', 'fingerprint', 'seed-%'), async (i) => {
    const status = weighted([['open', 50], ['acknowledged', 20], ['cleared', 30]] as const);
    const raised = spread(i, TARGET.alerts, 45);
    const category = pick(['treasury', 'service_health', 'reconciliation', 'security'] as const);
    const row = await db.insertInto('alert').values({
      category, severity: pick(['informational', 'warning', 'critical'] as const), subject_type: pick(['float_account', 'provider_account', 'project']), subject_reference: `SEED-${i}`, project_id: i % 4 === 0 ? shop.id : null,
      fingerprint: `seed-${i}`, title: `${category.replace('_', ' ')} check ${i} needs a look`, action_reference: pick(['/treasury', '/reconciliation', '/oversight']), raised_at: raised, last_seen_at: new Date(raised.getTime() + 3_600_000),
      occurrence_count: 1 + Math.floor(rnd() * 12), status, acknowledged_by: status === 'acknowledged' ? admin.id : null, acknowledged_at: status === 'acknowledged' ? raised : null, cleared_at: status === 'cleared' ? new Date(raised.getTime() + 7_200_000) : null,
    }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('alert_delivery').values({ alert_id: row.id, channel: 'email', address: 'ops@example.com', kind: 'raised', status: 'logged', sent_at: raised }).execute();
  });

  // Reconciliation runs and discrepancies.
  const runIds: string[] = (await db.selectFrom('reconciliation_run').select('id').where('error', 'like', 'seed%').execute()).map((r) => r.id);
  await top('runs', runIds.length, async (i) => {
    const start = spread(i, TARGET.runs, 80);
    const r = await db.insertInto('reconciliation_run').values({ provider_account_id: pa.id, mode: pick(['automated', 'manual'] as const), period_start: new Date(start.getTime() - 86_400_000), period_end: start, started_by: i % 2 ? admin.id : null, started_at: start, finished_at: new Date(start.getTime() + 60_000), status: weighted([['completed', 85], ['failed', 15]] as const), records_compared: 100 + Math.floor(rnd() * 900), discrepancies_raised: Math.floor(rnd() * 5), error: 'seed' }).returning('id').executeTakeFirstOrThrow();
    runIds.push(r.id);
  });
  const txs = await db.selectFrom('transaction').select(['id', 'reference', 'currency_code']).where('reference', 'like', 'txn_SEED%').limit(120).execute();
  await top('discrepancies', await count('discrepancy', 'fingerprint', 'seed-%'), async (i) => {
    const t = pick(txs);
    const first = spread(i, TARGET.discrepancies, 70);
    const status = weighted([['open', 55], ['under_review', 20], ['resolved', 25]] as const);
    await db.insertInto('discrepancy').values({
      run_id: pick(runIds), provider_account_id: pa.id, type: pick(['fee_variance', 'orphan_transaction', 'missing_transaction', 'state_divergence', 'stale_undetermined', 'float_drift'] as const), subject_type: 'transaction', subject_reference: t.reference,
      transaction_id: t.id, fingerprint: `seed-${i}`, expected: { amount: 1000 } as any, observed: { amount: 1000 - 20 * (1 + (i % 5)) } as any, difference: 20 * (1 + (i % 5)), currency_code: t.currency_code, status,
      assignee_id: i % 3 === 0 ? admin.id : null, first_detected_at: first, last_detected_at: new Date(first.getTime() + 86_400_000), runs_seen: 1 + (i % 4), recurrences_after_resolution: i % 7 === 0 ? 2 : 0,
      decision: status === 'resolved' ? 'accepted' : null, resolved_by: status === 'resolved' ? admin.id : null, approved_by: status === 'resolved' ? second.id : null, decided_at: status === 'resolved' ? new Date(first.getTime() + 172_800_000) : null,
    } as any).execute();
  });

  // Treasury: transfers, cashouts, float entries.
  const ensureAccount = async (v: any) => {
    const found = await db.selectFrom('ledger_account').select('id').where('type', '=', v.type).where('currency_code', '=', v.currency_code)
      .$call((q) => (v.provider_account_id ? q.where('provider_account_id', '=', v.provider_account_id).where('country_code', '=', v.country_code).where('direction', '=', v.direction) : v.settlement_destination ? q.where('settlement_destination', '=', v.settlement_destination) : q)).executeTakeFirst();
    return found ?? db.insertInto('ledger_account').values(v).returning('id').executeTakeFirstOrThrow();
  };
  const floatA = await ensureAccount({ type: 'float', currency_code: 'XAF', provider_account_id: pa.id, country_code: 'CM', direction: 'collection' });
  const floatB = await ensureAccount({ type: 'float', currency_code: 'XAF', provider_account_id: pa.id, country_code: 'CM', direction: 'disbursement' });
  await ensureAccount({ type: 'float', currency_code: 'XOF', provider_account_id: pa.id, country_code: 'SN', direction: 'collection' });
  const capital = await ensureAccount({ type: 'business_capital', currency_code: 'XAF' });
  const settle = await ensureAccount({ type: 'settlement', currency_code: 'XAF', settlement_destination: 'seed-bank' });
  const entry = async (type: string, a: string, b: string, amount: number, at: Date) => {
    const e = await db.insertInto('ledger_entry').values({ entry_type: type, occurred_at: at, author_id: admin.id, justification: 'seed-lists', reference: `seed-${randomBytes(4).toString('hex')}` } as any).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('ledger_posting').values([{ entry_id: e.id, account_id: a, side: 'debit', amount }, { entry_id: e.id, account_id: b, side: 'credit', amount }]).execute();
    return e.id;
  };
  await top('entries', (await count('ledger_entry', 'justification', 'seed-lists')) - 0, (i) => entry(pick(['float_funding', 'float_funding', 'adjustment']), floatA.id, capital.id, 10_000 * (1 + (i % 9)), spread(i, TARGET.entries, 60)).then(() => undefined));
  await top('transfers', await count('float_transfer', 'note', 'seed%'), async (i) => {
    const at = spread(i, TARGET.transfers, 60);
    const status = weighted([['confirmed', 70], ['pending', 15], ['failed', 15]] as const);
    await db.insertInto('float_transfer').values({ provider_account_id: pa.id, source_account_id: floatA.id, destination_account_id: floatB.id, currency_code: 'XAF', amount: 50_000 * (1 + (i % 6)), status, execution_path: pick(['platform', 'registered'] as const), provider_reference: `SEEDPR${i}`, initiated_by: pick(admins), confirmed_at: status === 'confirmed' ? at : null, note: `seed ${i}`, created_at: at } as any).execute();
  });
  await top('cashouts', await count('cashout', 'destination_reference', 'SEED%'), async (i) => {
    const at = spread(i, TARGET.cashouts, 60);
    const status = weighted([['confirmed', 45], ['pending_approval', 20], ['approved', 15], ['declined', 20]] as const);
    await db.insertInto('cashout').values({ float_account_id: floatA.id, settlement_account_id: settle.id, currency_code: 'XAF', amount: 100_000 * (1 + (i % 5)), status, destination_reference: `SEED-IBAN-${i}`, initiated_by: admin.id, approved_by: status === 'pending_approval' ? null : second.id, solvency_remainder: 0, liquidity_remainder: 0, confirmed_at: status === 'confirmed' ? at : null, created_at: at }).execute();
  });

  // Notification deliveries on the shop project.
  const ep = await db.selectFrom('project_notification_endpoint').select('id').where('project_id', '=', shop.id).where('active', '=', true).executeTakeFirstOrThrow();
  const shopTx = await db.selectFrom('transaction').select('id').where('project_id', '=', shop.id).limit(60).execute();
  await top('deliveries', await count('notification_delivery', 'event_id', 'seed-%'), async (i) => {
    const status = weighted([['delivered', 60], ['pending', 15], ['exhausted', 25]] as const);
    const at = spread(i, TARGET.deliveries, 30);
    await db.insertInto('notification_delivery').values({ event_id: `seed-${i}`, transaction_id: pick(shopTx).id, endpoint_id: ep.id, event_type: pick(['transaction.succeeded', 'transaction.failed', 'transaction.expired']), payload: { seeded: true } as any, attempt: status === 'exhausted' ? 8 : 1 + (i % 3), status, next_attempt_at: at, delivered_at: status === 'delivered' ? at : null, created_at: at }).execute();
  });
  return added;
}

async function main() {
  loadEnv();
  assertSafeTarget(process.env.PROXIAPAY_ENV, process.env.DATABASE_URL, process.env.SEED_LISTS_ALLOW_REMOTE);
  const pool = createPool(process.env.DATABASE_URL!, 2);
  const db = createDb(pool);
  try {
    console.log('added', await seedLists(db));
  } finally {
    await db.destroy();
  }
}
if (require.main === module) main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
