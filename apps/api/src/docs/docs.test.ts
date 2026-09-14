import { describe, expect, it } from 'vitest';
import { buildOpenApi } from './openapi';
import { DocsController } from './docs.module';

describe('the interface specification', () => {
  it('describes the nine project operations against the environment\'s own server', () => {
    const sandbox = buildOpenApi('sandbox');
    const production = buildOpenApi('production');
    expect(Object.keys(sandbox.paths).sort()).toEqual(['/auth/tokens', '/balances', '/collections', '/disbursements', '/previews', '/settings', '/transactions', '/transactions/{reference}', '/transactions/{reference}/code']);
    expect(sandbox.servers[0]!.url).toBe('https://sandbox.pay.proxia-digital.com/v1');
    expect(production.servers[0]!.url).toBe('https://pay.proxia-digital.com/v1');
    expect(Object.keys(production.paths)).toEqual(Object.keys(sandbox.paths));
  });
});

describe('/docs', () => {
  const docs = new DocsController({ PROXIAPAY_ENV: 'sandbox' });

  it('serves the guide with the environment and server filled in, and every onboarding step present', () => {
    const html = docs.guide();
    for (const id of ['project', 'tokens', 'settings', 'payment', 'payer', 'notifications', 'errors', 'sandbox', 'golive', 'reference']) expect(html).toContain(`id="${id}"`);
    expect(html).toContain('https://sandbox.pay.proxia-digital.com/v1');
    expect(html).not.toContain('{{');
    // The renderer is this process's own copy, never a third-party host.
    expect(html).toContain('src="/docs/redoc.standalone.js"');
    expect(html).not.toMatch(/https?:\/\/cdn\./);
  });

  it('serves the specification it built and the renderer it ships', () => {
    const spec = JSON.parse(docs.openapi()) as { openapi: string; paths: Record<string, unknown> };
    expect(spec.openapi).toBe('3.0.3');
    expect(Object.keys(spec.paths)).toHaveLength(9);
    expect(docs.redoc().length).toBeGreaterThan(100_000);
  });
});
