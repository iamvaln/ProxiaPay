import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..', '..', '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const workflows = readdirSync(resolve(ROOT, '.github/workflows')).filter((f) => f.endsWith('.yml'));

describe('the release and deploy configuration', () => {
  it('pins every third-party action to a full commit SHA', () => {
    const loose: string[] = [];
    for (const f of workflows) {
      for (const m of read(`.github/workflows/${f}`).matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
        const ref = m[1]!;
        if (ref.startsWith('./')) continue;
        if (!/@[0-9a-f]{40}$/.test(ref)) loose.push(`${f}: ${ref}`);
      }
    }
    expect(loose).toEqual([]);
  });

  it('gives release, sandbox and ci a read-only default token', () => {
    for (const f of ['ci.yml', 'release.yml', 'sandbox.yml']) {
      expect(read(`.github/workflows/${f}`), f).toMatch(/^permissions: \{ contents: read \}$/m);
    }
  });

  it('runs the release-script tests in the verification workflow', () => {
    expect(read('.github/workflows/verification.yml')).toContain('bash ops/release/test-release-scripts.sh');
  });

  it('deploys the sandbox in the sandbox environment, with a read-only token', () => {
    const deploy = read('.github/workflows/sandbox.yml').split(/^  deploy:/m)[1]!;
    expect(deploy).toMatch(/environment: sandbox/);
    expect(deploy).toMatch(/permissions: \{ contents: read, packages: read \}/);
  });

  it('checks the api status in the body, not just a 200', () => {
    expect(read('.github/workflows/sandbox.yml')).toContain('"status":"ok"');
    expect(read('ops/release/deploy.sh')).toContain('"status":"ok"');
  });

  it('accepts only strict semver release tags', () => {
    expect(read('.github/workflows/release.yml')).toContain('^v[0-9]+\\.[0-9]+\\.[0-9]+(-rc\\.[0-9]+)?$');
  });

  it('routes /healthz to the api and never lets nginx answer an api path with the SPA', () => {
    expect(read('docker-compose.deploy.yml')).toMatch(/-api\.rule=.*Path\(`\/healthz`\)/);
    const nginx = read('apps/console/nginx.conf');
    expect(nginx).toMatch(/\^\/\(v1\|console\|providers\|docs\|healthz\)\(\/\|\$\)/);
    expect(nginx).toContain('return 503');
  });

  it('refuses to start production without an IMAGE_TAG, and stores none', () => {
    const prod = read('docker-compose.production.yml');
    for (const svc of ['db', 'backup', 'migrate', 'api', 'worker', 'console']) {
      expect(prod, svc).toMatch(new RegExp(`^  ${svc}:\\n(?:    .*\\n)*?    image: .*\\$\\{IMAGE_TAG:\\?`, 'm'));
    }
    expect(read('deploy/production.env.example')).not.toMatch(/^IMAGE_TAG=/m);
    expect(read('deploy/sandbox.env.example')).toMatch(/^IMAGE_TAG=develop$/m);
  });

  it('pins a Postgres 16 minor in the db image and the sandbox compose', () => {
    expect(read('ops/db/Dockerfile')).toMatch(/^FROM postgres:16\.\d+-alpine/m);
    expect(read('docker-compose.deploy.yml')).toMatch(/image: postgres:16\.\d+-alpine/);
  });
});
