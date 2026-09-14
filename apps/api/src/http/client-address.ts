import type { Request } from 'express';
import * as ipaddr from 'ipaddr.js';

/**
 * The address a call is judged by comes from the hop the platform trusts (spec 7.1). With N
 * trusted proxy hops, the client address is the Nth from the right in X-Forwarded-For; with
 * none, it is the socket address and any forwarded header is ignored.
 */
export function clientAddress(req: Request, trustedHops: number): string {
  const socket = normalise(req.socket.remoteAddress ?? '0.0.0.0');
  if (trustedHops === 0) return socket;
  const header = req.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header.join(',') : header ?? '';
  const chain = raw.split(',').map((s) => s.trim()).filter(Boolean);
  // The chain plus the socket address forms the path; take the address `trustedHops` from the end.
  const path = [...chain, socket];
  const idx = path.length - 1 - trustedHops;
  return normalise(path[Math.max(0, idx)] ?? socket);
}

export function normalise(address: string): string {
  try {
    let addr = ipaddr.parse(address.replace(/^\[|\]$/g, ''));
    if (addr.kind() === 'ipv6' && (addr as ipaddr.IPv6).isIPv4MappedAddress()) addr = (addr as ipaddr.IPv6).toIPv4Address();
    return addr.toString();
  } catch {
    return '0.0.0.0';
  }
}

export function addressInCidr(address: string, cidr: string): boolean {
  try {
    const addr = ipaddr.process(address);
    const [range, bitsRaw] = cidr.split('/');
    const rangeAddr = ipaddr.process(range!);
    const bits = bitsRaw === undefined ? (rangeAddr.kind() === 'ipv4' ? 32 : 128) : Number(bitsRaw);
    if (addr.kind() !== rangeAddr.kind()) return false;
    return addr.match(rangeAddr as never, bits);
  } catch {
    return false;
  }
}
