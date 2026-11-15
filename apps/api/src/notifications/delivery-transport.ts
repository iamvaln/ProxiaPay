import { request as httpRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import type { VettedAddress } from './public-address';

/**
 * A lookup that answers with the vetted addresses whatever it is asked: the connection goes where the check looked,
 * never where a second resolution would point. The request keeps the URL's hostname for TLS (SNI, certificate) and Host.
 */
export function pinnedLookup(addresses: VettedAddress[]): LookupFunction {
  return ((_host: string, options: { all?: boolean; family?: number | string }, callback: (...a: unknown[]) => void) => {
    const wanted = options.family === 4 || options.family === 'IPv4' ? 4 : options.family === 6 || options.family === 'IPv6' ? 6 : 0;
    const usable = wanted ? addresses.filter((a) => a.family === wanted) : addresses;
    if (!usable.length) return callback(Object.assign(new Error('no vetted address of that family'), { code: 'ENOTFOUND' }));
    if (options.all) return callback(null, usable.map((a) => ({ address: a.address, family: a.family })));
    callback(null, usable[0]!.address, usable[0]!.family);
  }) as unknown as LookupFunction;
}

export interface DeliveryResponse { status: number; body: string }

/**
 * The one network call of a notification: a POST to `url`, connected only to `addresses`, never following a redirect
 * (a 3xx comes back as it is), and given up after `timeoutMs` in all, with an error named `timeout`. An object so tests replace it.
 */
export const deliveryTransport = {
  post(url: string, headers: Record<string, string>, body: string, addresses: VettedAddress[], timeoutMs: number): Promise<DeliveryResponse> {
    const target = new URL(url);
    const options: RequestOptions = {
      method: 'POST', headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) }, lookup: pinnedLookup(addresses), agent: false,
      protocol: target.protocol, hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port || undefined, path: `${target.pathname}${target.search}`,
    };
    return new Promise<DeliveryResponse>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(deadline); fn(); } };
      // `hostname` stays the URL's: Node takes SNI and the Host header from it, and only the lookup is pinned.
      const req = (target.protocol === 'https:' ? httpsRequest : httpRequest)(options, (res) => {
        let text = '';
        const done = () => settle(() => resolve({ status: res.statusCode ?? 0, body: text.slice(0, 1000) }));
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
          // What is kept is read: a response that goes on is cut here rather than holding the worker.
          if (text.length >= 1000) { done(); req.destroy(); }
        });
        res.on('end', done);
        res.on('error', (e) => settle(() => reject(e)));
      });
      // A deadline on the whole exchange, body included: a socket timeout would restart with every byte of a dripping answer.
      const deadline = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), timeoutMs);
      req.on('error', (e) => settle(() => reject(e)));
      req.end(body);
    });
  },
};
