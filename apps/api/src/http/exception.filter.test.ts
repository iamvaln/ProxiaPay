import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Controller, Module, Post, type ArgumentsHost, type INestApplication } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DatabaseError } from 'pg';
import { configureBodyParsers } from './body-parsers';
import { PlatformExceptionFilter } from './exception.filter';
import { filtered } from '../test/filtered';

@Controller('probe')
class ProbeController {
  @Post() echo() { return { ok: true }; }
}

@Module({ controllers: [ProbeController], providers: [{ provide: APP_FILTER, useClass: PlatformExceptionFilter }] })
class ProbeModule {}

let app: INestApplication;
let base: string;
beforeAll(async () => {
  const nest = await NestFactory.create<NestExpressApplication>(ProbeModule, { rawBody: true, logger: false, abortOnError: false, bodyParser: true });
  configureBodyParsers(nest);
  await nest.listen(0, '127.0.0.1');
  app = nest;
  base = await nest.getUrl();
});
afterAll(async () => { await app?.close(); });

const post = (body: string) => fetch(`${base}/probe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

describe('errors raised before any handler runs', () => {
  it('a body past the limit answers 413 FIELD_INVALID, not a fault', async () => {
    const res = await post(JSON.stringify({ pad: 'x'.repeat(150 * 1024) }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: { code: 'FIELD_INVALID', message: 'The request body is too large.', retryable: false } });
  });

  it('malformed JSON answers 400 FIELD_INVALID, not a fault', async () => {
    const res = await post('{"amount": ');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'FIELD_INVALID', message: 'The request body could not be read.', retryable: false } });
  });

  it('a well-formed body still reaches the handler', async () => {
    expect((await post('{"a":1}')).status).toBe(201);
  });
});

describe('a malformed identifier', () => {
  it('a value the store cannot read as its type (22P02) is a missing resource, not a fault', () => {
    const e = new DatabaseError('invalid input syntax for type uuid: "nope"', 0, 'error');
    e.code = '22P02';
    expect(filtered(e)).toEqual({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'No such resource.', retryable: false } } });
  });

  it('logs at warn level without the value, which the caller supplied', () => {
    const warn = vi.fn();
    const filter = new PlatformExceptionFilter();
    (filter as unknown as { logger: { warn: typeof warn } }).logger = { warn };
    const e = new DatabaseError('invalid input syntax for type uuid: "secret-ish-value"', 0, 'error');
    e.code = '22P02';
    e.routine = 'string_to_uuid';
    const res = { status() { return res; }, json() { return res; }, setHeader() { return res; } };
    filter.catch(e, { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({ code: '22P02', routine: 'string_to_uuid' }, 'malformed identifier reached the store');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-ish-value');
  });

  it('any other store error stays a fault, and says nothing of itself', () => {
    const e = new DatabaseError('duplicate key value violates unique constraint "x"', 0, 'error');
    e.code = '23505';
    expect(filtered(e)).toEqual({ status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'A fault occurred in the platform.', retryable: true } } });
  });
});
