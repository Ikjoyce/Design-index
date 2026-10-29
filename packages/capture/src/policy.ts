import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

export class CapturePolicyError extends Error { constructor(message: string) { super(message); this.name = 'CapturePolicyError'; } }
export type Lookup = (host: string) => Promise<{ address: string; family: number }[]>;
export const systemLookup: Lookup = (host) => lookup(host, { all: true, verbatim: true });
const hostOf = (url: URL) => url.hostname.replace(/^\[|\]$/g, '');

export function isPublicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.process(address);
    if (parsed.range() !== 'unicast' || parsed.toString() === '168.63.129.16') return false;
    if (parsed.kind() === 'ipv6') {
      const ipv6 = parsed as ipaddr.IPv6;
      if (!ipv6.match(ipaddr.parseCIDR('2000::/3'))) return false;
      if (['2002::/16', '2001::/23', '2001:db8::/32', '3fff::/20'].some((cidr) => ipv6.match(ipaddr.parseCIDR(cidr)))) return false;
    }
    return true;
  } catch { return false; }
}
function isLoopback(address: string): boolean { try { return ipaddr.process(address).range() === 'loopback'; } catch { return false; } }

export function parseCaptureUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new CapturePolicyError('Enter an absolute HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || value.length > 2048) throw new CapturePolicyError('Only HTTP/HTTPS URLs without embedded credentials are accepted.');
  return url;
}
export function normalizeLocalOrigin(value: string, protectedPorts: readonly number[] = [4317, 5173]): string {
  const url = parseCaptureUrl(value);
  if (!['localhost', '127.0.0.1', '::1'].includes(hostOf(url)) || url.pathname !== '/' || url.search || url.hash) throw new CapturePolicyError('Approve an exact localhost, 127.0.0.1, or [::1] origin, without a path/query.');
  if (protectedPorts.includes(Number(url.port || (url.protocol === 'https:' ? 443 : 80)))) throw new CapturePolicyError('The library’s own API/UI ports cannot be approved for capture.');
  return url.origin;
}

export function createNetworkPolicy(initial: string, approvedLocalOrigins: readonly string[], protectedPorts: readonly number[] = [4317, 5173], resolver: Lookup = systemLookup) {
  const first = parseCaptureUrl(initial);
  const directLoopback = ['localhost', '127.0.0.1', '::1'].includes(hostOf(first));
  const localOrigin = directLoopback && approvedLocalOrigins.includes(first.origin) ? normalizeLocalOrigin(first.origin, protectedPorts) : null;

  function check(value: string): URL {
    const url = parseCaptureUrl(value);
    const host = hostOf(url);
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (localOrigin && url.origin === localOrigin) return url;
    if (host === 'localhost' || host.endsWith('.localhost') || isIP(host) && !isPublicAddress(host)) throw new CapturePolicyError('Private, loopback, and metadata addresses are blocked unless this capture targets an explicitly approved local origin.');
    if (url.port && port !== (url.protocol === 'https:' ? 443 : 80)) throw new CapturePolicyError('Public pages must use standard HTTP/HTTPS ports. Approve an exact local dev origin for other ports.');
    return url;
  }
  check(initial);
  return {
    localOrigin, check,
    async resolve(value: string, signal?: AbortSignal): Promise<{ url: URL; address: string; port: number }> {
      if (signal?.aborted) throw new CapturePolicyError('Capture was stopped.');
      const url = check(value);
      const host = hostOf(url);
      let timer: NodeJS.Timeout | undefined;
      const addresses = await (async () => {
        try { return isIP(host) ? [{ address: host, family: isIP(host) }] : await Promise.race([
          resolver(host),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CapturePolicyError('Capture DNS lookup timed out.')), 4000); timer.unref(); }),
        ]); }
        catch (error) { throw error instanceof CapturePolicyError ? error : new CapturePolicyError('Capture DNS lookup failed. Check the URL and network connection.'); }
        finally { if (timer) clearTimeout(timer); }
      })();
      if (signal?.aborted) throw new CapturePolicyError('Capture was stopped.');
      const local = localOrigin && url.origin === localOrigin;
      if (!addresses.length || addresses.some(({ address }) => local ? !isLoopback(address) : !isPublicAddress(address))) throw new CapturePolicyError('The destination resolves to a private, reserved, or metadata address.');
      const chosen = [...addresses].sort((a, b) => a.family - b.family)[0]!;
      return { url, address: chosen.address, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) };
    },
  };
}
export type NetworkPolicy = ReturnType<typeof createNetworkPolicy>;
