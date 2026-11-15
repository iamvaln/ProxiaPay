import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Text-parsing tests, like the rest of this folder: the routing lives in a compose file and an
// nginx config nobody runs in CI, so a quiet edit is caught here or on the day a payer is
// shown the console.
const ROOT = resolve(__dirname, '..', '..', '..', '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const compose = read('docker-compose.deploy.yml');
const nginx = read('apps/console/nginx.conf');

const label = (router: string, key: string) =>
  compose.split('\n').find((l) => l.includes(`routers.\${STACK:-proxiapay}-${router}.${key}=`));

// The nginx config is two server blocks: the console, then the paylink one.
const blocks = nginx.split(/^server \{/m).slice(1);
const consoleBlock = blocks.find((b) => !b.includes('X-Content-Type-Options') && !b.includes('pay.html')) ?? '';
const paylinkBlock = blocks.find((b) => b.includes('pay.html')) ?? '';

describe('payment link routing', () => {
  it('the api router on APP_DOMAIN has no /pay-api', () => {
    const rule = label('api', 'rule')!;
    expect(rule).toContain('Host(`${APP_DOMAIN}`)');
    expect(rule).not.toContain('pay-api');
    expect(label('console', 'rule')).toContain('Host(`${APP_DOMAIN}`)');
    expect(label('console', 'rule')).not.toContain('PAYLINK');
  });

  it('the payapi router is Host(PAYLINK_DOMAIN) && PathPrefix(/pay-api)', () => {
    expect(label('payapi', 'rule')).toContain('Host(`${PAYLINK_DOMAIN}`) && PathPrefix(`/pay-api`)');
    expect(label('payapi', 'service')).toContain('-api');
    expect(label('payapi', 'priority')).toMatch(/=100$/);
  });

  it('the paylink router serves the page at a lower priority and never reaches the api', () => {
    const rule = label('paylink', 'rule')!;
    expect(rule).toMatch(/=Host\(`\$\{PAYLINK_DOMAIN\}`\)$/);
    expect(Number(label('paylink', 'priority')!.split('=').pop())).toBeLessThan(100);
    // Its own service on the paylink listener (port 8080): the console listener never sees it.
    expect(label('paylink', 'service')).toContain('-paylink');
    expect(compose).toMatch(/services\.\$\{STACK:-proxiapay\}-paylink\.loadbalancer\.server\.port=8080/);
  });

  it('the paylink nginx block refuses /v1 and /console and sends the CSP', () => {
    expect(paylinkBlock).toMatch(/listen 8080/);
    expect(paylinkBlock).toMatch(/location ~ \^\/\(v1\|console\|providers\|docs\|healthz\|pay-api\)/);
    expect(paylinkBlock).toMatch(/return 404/);
    const csp =
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
    expect(paylinkBlock).toContain(`add_header Content-Security-Policy "${csp}" always;`);
    expect(paylinkBlock).toContain('add_header Referrer-Policy "no-referrer" always;');
    expect(paylinkBlock).toContain('add_header X-Content-Type-Options "nosniff" always;');
  });

  it('every location of the paylink block that adds a header repeats the security headers', () => {
    // nginx drops inherited add_header the moment a location adds one of its own.
    for (const loc of paylinkBlock.split(/^  location /m).slice(1)) {
      if (!/add_header/.test(loc)) continue;
      expect(loc).toContain('Content-Security-Policy');
      expect(loc).toContain('X-Content-Type-Options');
    }
  });

  it('the paylink block keeps payer tokens out of the logs and serves only pay.html', () => {
    expect(paylinkBlock).toMatch(/^  access_log off;$/m);
    expect(paylinkBlock).toContain('try_files /pay.html =404');
    expect(paylinkBlock).not.toContain('index.html');
  });

  it('the console block never serves pay.html', () => {
    expect(consoleBlock).toContain('/index.html');
    expect(consoleBlock).not.toContain('pay.html');
    expect(consoleBlock).toMatch(/listen 80;/);
  });

  it('both env examples define PAYLINK_DOMAIN and PAYLINK_BASE_URL', () => {
    for (const [file, host] of [
      ['deploy/production.env.example', 'paylink.proxia-digital.com'],
      ['deploy/sandbox.env.example', 'sandbox-paylink.proxia-digital.com'],
    ] as const) {
      const env = read(file);
      expect(env, file).toMatch(new RegExp(`^PAYLINK_DOMAIN=${host}$`, 'm'));
      expect(env, file).toMatch(new RegExp(`^PAYLINK_BASE_URL=https://${host}$`, 'm'));
    }
  });
});
