import { afterEach, describe, expect, it, vi } from 'vitest';
import { addressResolver, isInternalIp, vetTarget } from './public-address';

afterEach(() => vi.restoreAllMocks());

const resolvesTo = (...addresses: string[]) => vi.spyOn(addressResolver, 'lookup').mockResolvedValue(addresses);

describe('a notification address must be reachable from the internet', () => {
  it.each([
    'http://127.0.0.1:1/hook', 'http://127.1.2.3/', 'http://0.0.0.0/', 'http://0.1.2.3/', 'http://2130706433/',
    'https://10.0.0.5/', 'https://172.16.0.1/', 'https://172.31.255.255/', 'https://192.168.1.1/',
    'https://169.254.169.254/latest/meta-data', 'https://100.64.0.1/', 'https://100.127.255.255/',
    'https://198.18.0.1/', 'https://198.19.255.255/', 'https://224.0.0.1/', 'https://239.255.255.250/', 'https://240.0.0.1/', 'https://255.255.255.255/',
    'https://[::1]/', 'https://[::]/', 'https://[fd00::1]/', 'https://[fc00::1]/', 'https://[fe80::1]/', 'https://[ff02::1]/', 'https://[ff05::1:3]/',
    'https://[64:ff9b::a00:1]/', 'https://[64:ff9b::808:808]/', 'https://[2002:a00:1::]/', 'https://[2002:808:808::1]/',
    'https://[::ffff:127.0.0.1]/', 'https://[::ffff:10.0.0.1]/', 'https://[::ffff:198.18.0.1]/',
    'https://localhost/', 'https://LOCALHOST./', 'https://api.localhost/', 'https://intranet/', 'https://metadata.google.internal/', 'https://printer.local/',
  ])('refuses %s without resolving it', async (url) => {
    const lookup = resolvesTo('93.184.215.14');
    expect(await vetTarget(url)).toEqual({ verdict: 'internal' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each(['https://93.184.215.14/', 'https://172.32.0.1/', 'https://100.128.0.1/', 'https://198.20.0.1/', 'https://223.255.255.255/', 'https://[2606:2800:220:1::]/', 'https://[::ffff:8.8.8.8]/'])('accepts the public literal %s', async (url) => {
    expect((await vetTarget(url)).verdict).toBe('public');
  });

  it('judges a mapped address by the IPv4 list, in both spellings', () => {
    expect(isInternalIp('::ffff:10.0.0.1')).toBe(true);
    expect(isInternalIp('::ffff:a00:1')).toBe(true);
    expect(isInternalIp('::ffff:808:808')).toBe(false);
  });

  it.each([
    '0:0:0:0:0:ffff:7f00:1', '0000:0000:0000:0000:0000:FFFF:0A00:0001', '0:0:0:0:0:ffff:127.0.0.1', '0:0:0:0:0:0:0:1', '0:0:0:0:0:0:0:0',
    '::7f00:1', '::127.0.0.1', '::808:808', '::ffff:0:7f00:1', '::ffff:0:808:808', '0:0:0:0:ffff:0:a00:1',
  ])('judges %s internal, however it is spelled (mapped, IPv4-compatible, IPv4-translated)', async (ip) => {
    expect(isInternalIp(ip)).toBe(true);
    resolvesTo('93.184.215.14', ip);
    expect(await vetTarget('https://hooks.example.com/pp')).toEqual({ verdict: 'internal' });
    expect(await vetTarget(`https://[${ip}]/`)).toEqual({ verdict: 'internal' });
  });

  it('still accepts a public address mapped in full spelling', () => {
    expect(isInternalIp('0:0:0:0:0:ffff:808:808')).toBe(false);
    expect(isInternalIp('0:0:0:0:0:ffff:8.8.8.8')).toBe(false);
  });

  it('accepts a name whose every address is public, and hands back those addresses to connect to', async () => {
    const lookup = resolvesTo('93.184.215.14', '2606:2800:220:1:248:1893:25c8:1946');
    expect(await vetTarget('https://hooks.example.com/pp')).toEqual({ verdict: 'public', host: 'hooks.example.com', addresses: [{ address: '93.184.215.14', family: 4 }, { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }] });
    expect(lookup).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledWith('hooks.example.com');
  });

  it.each([['10.1.2.3'], ['224.0.0.251'], ['ff02::fb'], ['::ffff:127.0.0.1']])('refuses a name when one of its addresses is %s', async (bad) => {
    resolvesTo('93.184.215.14', bad);
    expect(await vetTarget('https://hooks.example.com/pp')).toEqual({ verdict: 'internal' });
  });

  it('says so when a name does not resolve, or resolves to nothing', async () => {
    vi.spyOn(addressResolver, 'lookup').mockRejectedValueOnce(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })).mockResolvedValueOnce([]);
    expect(await vetTarget('https://not-yet.example.com/pp')).toEqual({ verdict: 'unresolved', error: 'ENOTFOUND' });
    expect(await vetTarget('https://not-yet.example.com/pp')).toEqual({ verdict: 'unresolved', error: 'no address' });
  });
});
