import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/** The refusal a notification address gets, when it is set and when a delivery would go to it. */
export const NOT_PUBLIC = 'That address is not reachable from the internet.';

/** Addresses a project's notifications never go to: the platform's own networks, and ranges that are not one host on the internet. */
const internalV4 = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) internalV4.addSubnet(net, bits, 'ipv4');
const internalV6 = new BlockList();
// ::/96 holds the unspecified and loopback addresses and the IPv4-compatible ones (::7f00:1); ::ffff:0:0:0/96 the IPv4-translated ones.
for (const [net, bits] of [['::', 96], ['::ffff:0:0:0', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2002::', 16]] as const) internalV6.addSubnet(net, bits, 'ipv6');

/** The eight 16-bit groups of a valid IPv6 address, whatever its spelling: `::` expanded, a trailing dotted IPv4 folded in. */
function groups(ip: string): number[] {
  let text = ip.toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.includes('::') ? (text.split('::') as [string, string]) : [text, null];
  const front = head ? head.split(':') : [];
  const back = tail ? tail.split(':') : [];
  const all = tail === null ? front : [...front, ...Array<string>(8 - front.length - back.length).fill('0'), ...back];
  return all.map((g) => parseInt(g, 16));
}

export function isInternalIp(ip: string): boolean {
  if (isIP(ip) === 4) return internalV4.check(ip, 'ipv4');
  // An IPv4-mapped address (::ffff:a.b.c.d, in any spelling) is judged by the IPv4 list: ::ffff:10.0.0.1 is internal, ::ffff:8.8.8.8 is not.
  const g = groups(ip);
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return internalV4.check([g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255].join('.'), 'ipv4');
  return internalV6.check(ip, 'ipv6');
}

/** Names that only mean something inside a network: `localhost`, one label alone, `.internal`, `.local`. */
const internalName = (host: string) => host === 'localhost' || host.endsWith('.localhost') || !host.includes('.') || host.endsWith('.internal') || host.endsWith('.local');

/** DNS resolution, an object so tests replace it: no test resolves a real name. */
export const addressResolver = {
  lookup: async (host: string): Promise<string[]> => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address),
};

export interface VettedAddress { address: string; family: 4 | 6 }
export type Target =
  | { verdict: 'public'; host: string; addresses: VettedAddress[] }
  | { verdict: 'internal' }
  | { verdict: 'unresolved'; error: string };

/**
 * Resolves `url`'s host once and judges it: internal if the literal host or any address it resolves to is, unresolved
 * if it does not resolve, else public with the addresses a delivery must connect to — and only to those, so a name that
 * answers differently on a second lookup (DNS rebinding) never reaches an address that was not vetted here.
 */
export async function vetTarget(url: string): Promise<Target> {
  // The URL parser has already turned `2130706433` or `0x7f.1` into dotted IPv4, as the request will.
  const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const literal = isIP(host);
  if (literal) return isInternalIp(host) ? { verdict: 'internal' } : { verdict: 'public', host, addresses: [{ address: host, family: literal as 4 | 6 }] };
  if (internalName(host)) return { verdict: 'internal' };
  let addresses: string[];
  try {
    addresses = await addressResolver.lookup(host);
  } catch (e) {
    return { verdict: 'unresolved', error: (e as { code?: string }).code ?? (e as Error).message };
  }
  if (!addresses.length) return { verdict: 'unresolved', error: 'no address' };
  if (addresses.some(isInternalIp)) return { verdict: 'internal' };
  return { verdict: 'public', host, addresses: addresses.map((address) => ({ address, family: isIP(address) as 4 | 6 })) };
}
