import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { browserEnvironment, createNetworkPolicy, isPublicAddress, normalizeLocalOrigin, parseCaptureUrl, startCaptureProxy } from '../packages/capture/src/index.js';

describe('capture destination policy', () => {
  it.each(['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '168.63.129.16', '0.0.0.0', '100.64.0.1', '198.18.0.1', '192.0.2.1', '224.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:168.63.129.16', '64:ff9b::a00:1', '2002:7f00:1::', '2001:db8::1'])('blocks non-public address %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
  it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])('permits public address %s', (address) => expect(isPublicAddress(address)).toBe(true));
  it.each(['file:///etc/passwd', 'ftp://example.com', 'data:text/html,test', 'https://user:password@example.com', 'not a URL'])('rejects unsafe URL %s', (value) => expect(() => parseCaptureUrl(value)).toThrow());
  it.each(['http://2130706433', 'http://0x7f000001', 'http://127.1', 'http://[::ffff:127.0.0.1]', 'http://localhost.', 'http://service.localhost'])('cannot bypass localhost blocking with %s', async (value) => {
    await expect(async () => createNetworkPolicy(value, [], undefined, async () => [{ address: '127.0.0.1', family: 4 }]).resolve(value)).rejects.toThrow();
  });
  it('scopes local permission to an exact initial origin, not public pages or other loopback hosts/ports', () => {
    const local = 'http://127.0.0.1:3000';
    expect(normalizeLocalOrigin(`${local}/`)).toBe(local);
    const policy = createNetworkPolicy(`${local}/example`, [local]);
    expect(policy.check(`${local}/image.png`).origin).toBe(local);
    for (const other of ['http://localhost:3000', 'http://127.0.0.1:3001', 'https://127.0.0.1:3000', 'http://192.168.1.1']) expect(() => policy.check(other)).toThrow();
    expect(() => createNetworkPolicy('https://example.com', [local]).check(local)).toThrow();
  });
  it.each(['http://localhost:4317', 'http://127.0.0.1:5173', 'http://[::1]:14317', 'http://localhost:3000/path', 'http://localhost:3000?x=1', 'http://localhost:3000#x', 'http://192.168.1.1:3000', 'http://*.localhost:3000'])('rejects unsafe approval %s', (value) => expect(() => normalizeLocalOrigin(value, [4317, 5173, 14317])).toThrow());
  it('revalidates every DNS result and rejects rebinding or mixed public/private records', async () => {
    let count = 0;
    const policy = createNetworkPolicy('https://example.com', [], undefined, async () => [{ address: ++count === 1 ? '1.1.1.1' : '10.0.0.1', family: 4 }]);
    expect((await policy.resolve('https://example.com')).address).toBe('1.1.1.1');
    await expect(policy.resolve('https://example.com/image')).rejects.toThrow(/private/);
    const mixed = createNetworkPolicy('https://example.com', [], undefined, async () => [{ address: '1.1.1.1', family: 4 }, { address: '::ffff:169.254.169.254', family: 6 }]);
    await expect(mixed.resolve('https://example.com')).rejects.toThrow();
  });
  it('requires approved localhost DNS to remain loopback and honors cancellation before resolving', async () => {
    const origin = 'http://localhost:3000';
    await expect(createNetworkPolicy(origin, [origin], undefined, async () => [{ address: '1.1.1.1', family: 4 }]).resolve(origin)).rejects.toThrow();
    await expect(createNetworkPolicy('https://example.com', []).resolve('https://example.com', AbortSignal.abort())).rejects.toThrow(/stopped/);
  });
  it('does not pass keys, node injection, proxy configuration, or arbitrary variables to Chrome', () => {
    expect(browserEnvironment({ Path: 'safe-path', SystemRoot: 'windows', TEMP: 'temp', OPENCODE_GO_API_KEY: 'secret', ZEN_API_KEY: 'secret', NODE_OPTIONS: '--require malware', HTTP_PROXY: 'bad', EXTRA_SECRET: 'secret' })).toEqual({ Path: 'safe-path', SystemRoot: 'windows', TEMP: 'temp' });
  });
});

describe('capture forward proxy', () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });
  async function fixture() {
    const seen: { method: string; auth?: string; host?: string }[] = [];
    const server = createServer((req, res) => { seen.push({ method: req.method!, auth: req.headers['proxy-authorization'], host: req.headers.host }); res.end('fixture'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port.');
    cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
    const origin = `http://127.0.0.1:${address.port}`;
    const abort = new AbortController();
    const proxy = await startCaptureProxy(createNetworkPolicy(origin, [origin]), abort.signal);
    cleanup.push(proxy.close);
    const auth = `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}`;
    function send(url: string, method = 'GET', authorization: string | undefined = auth) {
      return new Promise<number>((resolve, reject) => {
        const req = request(proxy.server, { method, path: url, headers: authorization ? { 'Proxy-Authorization': authorization } : {} }, (res) => { res.resume(); res.once('end', () => resolve(res.statusCode!)); });
        req.on('error', reject); req.end();
      });
    }
    return { seen, origin, proxy, send, abort, auth };
  }
  it('authenticates, strips proxy credentials, pins the checked destination, and only forwards GET/HEAD', async () => {
    const f = await fixture();
    expect(await f.send(f.origin, 'GET', '')).toBe(407);
    expect(await f.send(f.origin, 'GET', 'Basic wrong')).toBe(407);
    expect(await f.send(f.origin)).toBe(200);
    expect(await f.send(f.origin, 'HEAD')).toBe(200);
    expect(await f.send(f.origin, 'POST')).toBe(403);
    expect(await f.send('http://169.254.169.254/latest/meta-data')).toBe(403);
    expect(f.seen).toEqual([{ method: 'GET', auth: undefined, host: new URL(f.origin).host }, { method: 'HEAD', auth: undefined, host: new URL(f.origin).host }]);
  });
  it('blocks private CONNECT destinations and requires proxy authentication', async () => {
    const f = await fixture();
    async function tunnel(auth: string) {
      return new Promise<string>((resolve, reject) => {
        const address = new URL(f.proxy.server);
        const socket = connect(Number(address.port), address.hostname, () => socket.write(`CONNECT 169.254.169.254:443 HTTP/1.1\r\nHost: 169.254.169.254:443\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`));
        socket.once('data', (data) => { resolve(data.toString()); socket.destroy(); }); socket.on('error', reject);
      });
    }
    expect(await tunnel('')).toContain('407');
    expect(await tunnel(f.auth)).toContain('403');
    expect(f.seen).toHaveLength(0);
  });
  it('caps the number of forwarded requests', async () => {
    const f = await fixture();
    for (let index = 0; index < 240; index++) expect(await f.send(f.origin, 'HEAD')).toBe(200);
    expect(await f.send(f.origin)).toBe(403);
    expect(f.seen).toHaveLength(240);
  });
});
