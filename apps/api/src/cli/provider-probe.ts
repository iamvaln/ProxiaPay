/**
 * Exercises a provider adapter against a live provider, reporting what came back, so the
 * adapter's assumptions (spec 12, 18) are checked before any transaction depends on them.
 * Credentials come from the environment and are never written anywhere.
 *
 *   EJARA_CLIENT_KEY=… EJARA_CLIENT_SECRET=… npm run provider:probe -w apps/api -- \
 *     --adapter ejara --base https://<host> [--status <paymentReference>] \
 *     [--initiate --msisdn 237677123456 --amount 100 --currency XAF --country CM --method MOMO --direction collection]
 *
 * Without --initiate the probe only authenticates, reads wallets and optionally reads one status:
 * nothing moves money. With --initiate it submits one payment to the provider's test environment.
 * In an environment whose outbound HTTPS goes through a proxy, run with NODE_USE_ENV_PROXY=1.
 */
import { ProviderRegistry } from '../providers/provider-registry';
import { ProviderUnavailableError, type AdapterContext } from '../providers/adapter';
import { newCorrelationId } from '../crypto/references';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]] : [])).filter((p) => p.length)) as Record<string, string>;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, /secret|token|password|authorization|client-key|client-secret/i.test(k) ? '[redacted]' : redact(v)]));
  }
  return value;
}

async function main() {
  const adapterKey = args.adapter ?? 'ejara';
  const base = (args.base ?? process.env.PROVIDER_BASE_URL ?? '').replace(/^﻿/, '').trim();
  if (!base) throw new Error('--base (or PROVIDER_BASE_URL) is required');
  const baseUrl = /^https?:\/\//.test(base) ? base : `https://${base}`;
  const credentials: Record<string, string> = {};
  if (adapterKey === 'ejara') {
    credentials.clientKey = process.env.EJARA_CLIENT_KEY ?? '';
    credentials.clientSecret = process.env.EJARA_CLIENT_SECRET ?? '';
    if (!credentials.clientKey || !credentials.clientSecret) throw new Error('EJARA_CLIENT_KEY and EJARA_CLIENT_SECRET are required');
  }
  const adapter = new ProviderRegistry().get(adapterKey);
  const exchanges: { flow: string; kind: string; body: unknown }[] = [];
  const ctx: AdapterContext = {
    account: { id: 'probe', baseUrl, credentials },
    correlationId: newCorrelationId(),
    async recordPayload(flow, kind, body) {
      exchanges.push({ flow, kind, body: redact(body) });
      return `probe-${exchanges.length}`;
    },
  };
  console.log(`adapter ${adapterKey} against ${baseUrl}`);
  console.log('capabilities', adapter.capabilities());

  const step = async (name: string, fn: () => Promise<unknown>) => {
    const started = Date.now();
    try {
      const result = await fn();
      console.log(`\n[ok] ${name} (${Date.now() - started} ms)`);
      console.log(JSON.stringify(redact(result), null, 2));
      return result;
    } catch (e) {
      console.log(`\n[failed] ${name} (${Date.now() - started} ms): ${e instanceof ProviderUnavailableError ? 'provider unavailable: ' : ''}${(e as Error).message}`);
      return null;
    }
  };

  await step('authenticate and read wallets', () => adapter.wallets(ctx));
  if (args.status && args.status !== 'true') await step(`status of ${args.status}`, () => adapter.status(ctx, args.status!));
  if (args.initiate === 'true') {
    const direction = (args.direction ?? 'collection') as 'collection' | 'disbursement';
    const amount = Number(args.amount ?? '100');
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('--amount must be a positive integer in minor units');
    const result = await step(`initiate ${direction} of ${amount} ${args.currency ?? 'XAF'}`, () => adapter.submit(ctx, {
      transactionReference: `probe_${Date.now()}`, direction, amount, currency: args.currency ?? 'XAF', currencyExponent: 0,
      country: args.country ?? 'CM', paymentMethod: args.method ?? 'MOMO', msisdn: args.msisdn ?? '', counterpartyName: 'Probe', counterpartyEmail: 'probe@example.com',
    }));
    const ref = result && typeof result === 'object' && 'providerReference' in result ? String((result as { providerReference: string }).providerReference) : null;
    if (ref) await step(`status of ${ref}`, () => adapter.status(ctx, ref));
  }
  console.log('\nraw exchanges (secrets and numbers redacted):');
  for (const x of exchanges) console.log(`- ${x.flow} ${x.kind}: ${JSON.stringify(x.body).slice(0, 1500)}`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
