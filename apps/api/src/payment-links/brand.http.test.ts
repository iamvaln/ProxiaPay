import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Controller, Module, Post, type INestApplication } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createTestContext, type TestContext } from '../test/context';
import { AuditService } from '../audit/audit.service';
import { BrandController } from '../console-api/brand.controller';
import { SessionGuard } from '../console-api/session.guard';
import { AdminAuthService } from '../admin-auth/admin-auth.service';
import { CONFIG } from '../config/config';
import { DB_TOKEN } from '../db/database';
import { configureBodyParsers } from '../http/body-parsers';
import { PlatformExceptionFilter } from '../http/exception.filter';
import { AuthorisationService } from '../admin-auth/authorisation.service';
import { BrandService } from './brand.service';

/** The app's real body-parser setup (main.ts calls the same function) in front of the real brand controller. */
let t: TestContext;
let app: INestApplication;
let base: string;
let projectId: string;

@Controller('console/other')
class ProbeController {
  @Post() echo() { return { ok: true }; }
}

beforeAll(async () => { t = await createTestContext(); });
afterAll(async () => { await app?.close(); await t.close(); });
beforeEach(async () => {
  await app?.close();
  await t.reset();
  const client = await t.db.insertInto('client').values({ name: 'Acme' }).returning('id').executeTakeFirstOrThrow();
  projectId = (await t.db.insertInto('project').values({ code: 'acme-shop', name: 'Shop', client_id: client.id }).returning('id').executeTakeFirstOrThrow()).id;
  const owner = await t.admin();
  const auth = await new AuthorisationService(t.db).load(owner.id, null);
  // The session guard is not under test here: it lets the request in as a platform owner.
  const guard = { canActivate: (ctx: { switchToHttp(): { getRequest(): Record<string, unknown> } }) => { const r = ctx.switchToHttp().getRequest(); r.auth = auth; r.principal = { administratorId: owner.id }; return true; } };
  vi.spyOn(SessionGuard.prototype, 'canActivate').mockImplementation(guard.canActivate as never);
  @Module({
    controllers: [BrandController, ProbeController],
    providers: [{ provide: DB_TOKEN, useValue: t.db }, BrandService, AuditService, SessionGuard, { provide: AdminAuthService, useValue: {} }, { provide: AuthorisationService, useValue: {} }, { provide: CONFIG, useValue: {} }, { provide: APP_FILTER, useClass: PlatformExceptionFilter }],
  })
  class TestAppModule {}
  const nest = await NestFactory.create<NestExpressApplication>(TestAppModule, { rawBody: true, logger: ['error'], abortOnError: false, bodyParser: true });
  configureBodyParsers(nest);
  await nest.listen(0, '127.0.0.1');
  app = nest;
  base = await nest.getUrl();
});

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (kb: number) => Buffer.concat([PNG_HEAD, Buffer.alloc(kb * 1024 - PNG_HEAD.length)]);
const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('logo upload over HTTP', () => {
  it('takes a 199 KB PNG', async () => {
    const res = await post(`/console/projects/${projectId}/brand/logo`, { data_base64: png(199).toString('base64') });
    expect(res.status).toBe(201);
    expect(await t.db.selectFrom('brand_asset').select('id').execute()).toHaveLength(1);
  });

  it('answers a 201 KB PNG with the logo message, not a body-size error', async () => {
    const res = await post(`/console/projects/${projectId}/brand/logo`, { data_base64: png(201).toString('base64') });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'FIELD_INVALID', field: 'logo', message: 'Use a PNG, JPEG or WebP image of at most 200 KB.' } });
  });

  it('keeps the default 100 KB limit on every other route', async () => {
    const big = { pad: 'x'.repeat(150 * 1024) };
    // Express refuses it before any controller runs (the filter shapes the answer).
    expect((await post('/console/other', big)).status).toBeGreaterThanOrEqual(400);
    expect((await post('/console/other', { pad: 'x' })).status).toBe(201);
    // The raised limit is for the logo path only: a long body on another brand path is refused too.
    expect((await post(`/console/projects/${projectId}/brand`, big)).status).toBeGreaterThanOrEqual(400);
  });
});
