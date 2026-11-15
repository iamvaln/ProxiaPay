import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deliveryTransport, pinnedLookup } from './delivery-transport';

// A server on loopback stands for the project's: the transport itself does not vet, so loopback is where it can be watched.
let server: Server;
let port: number;
let seen: { host: string | undefined; path: string | undefined; body: string }[] = [];
let answer: { status: number; headers?: Record<string, string> } = { status: 200 };

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    // A server that never finishes: one byte every 100 ms (each resets an idle timer), or as much as the socket takes.
    if (req.url === '/drip' || req.url === '/endless') {
      res.writeHead(200);
      const timer = req.url === '/drip' ? setInterval(() => res.write('x'), 100) : setInterval(() => res.write('x'.repeat(16_384)), 5);
      res.on('close', () => clearInterval(timer));
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { seen.push({ host: req.headers.host, path: req.url, body }); res.writeHead(answer.status, answer.headers ?? {}); res.end('ok'); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
beforeEach(() => { seen = []; answer = { status: 200 }; });

const loopback = [{ address: '127.0.0.1', family: 4 as const }];

describe('the delivery transport', () => {
  it('connects to the vetted address only, whatever the name would resolve to now, and keeps the name as Host', async () => {
    // `.invalid` never resolves: the request arriving proves no second lookup was made.
    const res = await deliveryTransport.post(`http://hooks.rebind.invalid:${port}/pp?x=1`, { 'content-type': 'application/json' }, '{"a":1}', loopback, 5_000);
    expect(res).toEqual({ status: 200, body: 'ok' });
    expect(seen).toEqual([{ host: `hooks.rebind.invalid:${port}`, path: '/pp?x=1', body: '{"a":1}' }]);
  });

  it('does not follow a redirect: a 3xx comes back as it is', async () => {
    answer = { status: 302, headers: { location: `http://127.0.0.1:${port}/elsewhere` } };
    const res = await deliveryTransport.post(`http://hooks.example.invalid:${port}/pp`, {}, '{}', loopback, 5_000);
    expect(res.status).toBe(302);
    expect(seen.map((s) => s.path)).toEqual(['/pp']);
  });

  it('gives up after the whole deadline, however steadily a response drips', async () => {
    const started = Date.now();
    await expect(deliveryTransport.post(`http://hooks.example.invalid:${port}/drip`, {}, '{}', loopback, 1_000)).rejects.toMatchObject({ name: 'TimeoutError', message: 'timeout' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect(Date.now() - started).toBeLessThan(1_800);
  });

  it('stops reading an endless response after the 1000 characters it keeps', async () => {
    const started = Date.now();
    const res = await deliveryTransport.post(`http://hooks.example.invalid:${port}/endless`, {}, '{}', loopback, 5_000);
    expect(res).toEqual({ status: 200, body: 'x'.repeat(1000) });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('answers every lookup with the vetted addresses, by family when one is asked for', () => {
    const lookup = pinnedLookup([{ address: '93.184.215.14', family: 4 }, { address: '2606:2800:220:1::', family: 6 }]) as unknown as (h: string, o: object, cb: (...a: unknown[]) => void) => void;
    const call = (o: object) => new Promise<unknown[]>((r) => lookup('evil.example', o, (...a) => r(a)));
    return Promise.all([
      expect(call({})).resolves.toEqual([null, '93.184.215.14', 4]),
      expect(call({ family: 6 })).resolves.toEqual([null, '2606:2800:220:1::', 6]),
      expect(call({ all: true })).resolves.toEqual([null, [{ address: '93.184.215.14', family: 4 }, { address: '2606:2800:220:1::', family: 6 }]]),
    ]);
  });
});
