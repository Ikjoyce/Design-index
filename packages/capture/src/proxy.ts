import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';
import type { NetworkPolicy } from './policy.js';

/** A bounded, per-capture authenticated forward proxy. DNS is validated and the connection uses
 * the approved IP directly: browser re-resolution cannot turn a public hostname into private SSRF. */
export async function startCaptureProxy(policy: NetworkPolicy, signal: AbortSignal) {
  const username = 'capture';
  const password = randomBytes(24).toString('hex');
  const expected = Buffer.from(`Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`);
  const sockets = new Set<Socket>();
  let bytes = 0, requests = 0, blocked = 0, stopped = false;
  const track = (socket: Socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {}); if (stopped || sockets.size > 32) { blocked++; socket.destroy(); } };
  const account = (size: number) => { bytes += size; if (bytes > 40 * 1024 * 1024) { stopped = true; for (const socket of sockets) socket.destroy(); } };
  function authorized(value: string | undefined) {
    const actual = Buffer.from(value ?? '');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  const cleanHeaders = (headers: IncomingHttpHeaders, request = false) => Object.fromEntries(Object.entries(headers).filter(([key]) => !['connection', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'upgrade', 'keep-alive', 'te', 'trailer', 'transfer-encoding', ...(request ? ['content-length'] : [])].includes(key)));
  const server = createServer(async (req, res) => {
    if (!authorized(req.headers['proxy-authorization'])) { res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="capture"' }).end(); return; }
    if (stopped || ++requests > 240 || !['GET', 'HEAD'].includes(req.method ?? '') || !req.url?.startsWith('http://')) { blocked++; res.writeHead(403).end(); return; }
    try {
      const target = await policy.resolve(req.url, signal);
      if (stopped || signal.aborted) { res.destroy(); return; }
      const upstream = httpRequest({ hostname: target.address, port: target.port, method: req.method, path: `${target.url.pathname}${target.url.search}`, headers: { ...cleanHeaders(req.headers, true), host: target.url.host }, agent: false }, (reply) => {
        res.writeHead(reply.statusCode ?? 502, cleanHeaders(reply.headers));
        reply.on('data', (chunk: Buffer) => account(chunk.length));
        reply.on('error', () => res.destroy());
        reply.pipe(res);
      });
      upstream.on('socket', track);
      upstream.setTimeout(8000, () => upstream.destroy());
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); });
      res.once('close', () => { if (!res.writableEnded) upstream.destroy(); });
      upstream.end();
    } catch { blocked++; res.writeHead(403).end(); }
  });
  server.on('connection', (socket) => { track(socket); socket.setTimeout(15000, () => socket.destroy()); });
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.on('connect', async (req, client, head) => {
    if (!authorized(req.headers['proxy-authorization'])) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="capture"\r\n\r\n'); return; }
    if (stopped || ++requests > 240) { client.destroy(); return; }
    try {
      const raw = `https://${req.url}`;
      const target = await policy.resolve(raw, signal);
      if (target.url.pathname !== '/' || target.url.search || target.url.hash || stopped || signal.aborted) throw new Error('Invalid CONNECT.');
      const upstream = connect({ host: target.address, port: target.port });
      track(upstream); upstream.setTimeout(10000, () => upstream.destroy());
      upstream.once('connect', () => {
        if (stopped || signal.aborted) { upstream.destroy(); return; }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) { account(head.length); upstream.write(head); }
        upstream.on('data', (chunk: Buffer) => account(chunk.length));
        client.on('data', (chunk: Buffer) => account(chunk.length));
        upstream.pipe(client); client.pipe(upstream);
      });
      upstream.on('error', () => client.destroy());
      client.once('close', () => upstream.destroy());
      upstream.once('close', () => client.destroy());
    } catch { blocked++; client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); }
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 15000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Proxy failed to bind.');
  function stopSockets() { stopped = true; for (const socket of sockets) socket.destroy(); }
  signal.addEventListener('abort', stopSockets, { once: true });
  if (signal.aborted) stopSockets();
  return {
    server: `http://127.0.0.1:${address.port}`, username, password,
    stats: () => ({ bytes, requests, blocked }),
    async close() {
      stopSockets(); signal.removeEventListener('abort', stopSockets);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
