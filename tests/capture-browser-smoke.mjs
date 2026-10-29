import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createBrowserCapturer } from '../packages/capture/src/index.ts';
import { startServer } from '../apps/server/dist/server.js';

// No .env and no public targets. Exercises both tsx source execution and the built API.
const hits = [];
const forbidden = createServer((req, res) => { hits.push(`forbidden:${req.url}`); res.end('must not be reached'); });
await new Promise((resolve) => forbidden.listen(0, '127.0.0.1', resolve));
const forbiddenOrigin = `http://127.0.0.1:${forbidden.address().port}`;
const fixture = createServer((req, res) => {
  hits.push(`${req.method}:${req.url}:${req.headers.cookie ?? ''}`);
  if (req.url === '/redirect') { res.writeHead(302, { Location: forbiddenOrigin }); res.end(); return; }
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>Isolated capture fixture</title>
    <style>body{background:#102030;color:#f0f0f0;font-family:Arial;min-height:11000px}button{background:#7c5cff;color:white;padding:20px;border-radius:12px;transition:opacity .2s}</style>
    <h1>Isolated fixture</h1><button>Example</button><img src="${forbiddenOrigin}/private.png">
    <script>if(innerWidth>1000)document.cookie='desktop_only=yes';fetch('/write',{method:'POST',body:'blocked'}).catch(()=>{});fetch('${forbiddenOrigin}/secret').catch(()=>{});</script>`);
});
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${fixture.address().port}`;
const request = { url: origin, title: '', note: '', colorScheme: 'dark' };
await mkdir(join(tmpdir(), 'opencode'), { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'opencode', 'design-index-browser-capture-'));
let app;
try {
  const result = await createBrowserCapturer().capture(request, [origin], [4317, 5173], new AbortController().signal);
  assert.equal(result.title, 'Isolated capture fixture');
  const desktop = await sharp(result.viewport).metadata(); assert.deepEqual([desktop.width, desktop.height], [1440, 1000]);
  const full = await sharp(result.fullPage).metadata(); assert.equal(full.height, 10000);
  const mobile = await sharp(result.mobile).metadata(); assert.equal(mobile.width, 390);
  assert(result.facts.colors.some((color) => color.hex === '#102030'));
  assert(result.facts.fonts.some((font) => font.includes('Arial')));
  assert(result.facts.transitions.length > 0); assert(result.facts.truncated);
  assert(!hits.some((hit) => hit.startsWith('forbidden:') || hit.startsWith('POST:')));
  const rootRequests = hits.filter((hit) => hit.startsWith('GET:/:'));
  assert.equal(rootRequests.length, 2); assert(rootRequests.every((hit) => hit === 'GET:/:'));
  await assert.rejects(createBrowserCapturer().capture({ ...request, url: `${origin}/redirect` }, [origin], [4317, 5173], new AbortController().signal));
  await assert.rejects(createBrowserCapturer().capture(request, [origin], [], AbortSignal.abort()));
  assert(!hits.some((hit) => hit.startsWith('forbidden:')));

  app = await startServer({ libraryDir: directory, port: 15319, refreshModelsOnStart: false });
  const connection = JSON.parse(await (await import('node:fs/promises')).readFile(join(directory, 'connection.json'), 'utf8'));
  const headers = { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' };
  const approved = await fetch(`${app.url}/api/captures/settings`, { method: 'PUT', headers, body: JSON.stringify({ approvedLocalOrigins: [origin] }) }); assert.equal(approved.status, 200);
  const queued = await fetch(`${app.url}/api/captures`, { method: 'POST', headers, body: JSON.stringify(request) }); assert.equal(queued.status, 202);
  const id = (await queued.json()).id;
  let job;
  for (let count = 0; count < 60; count++) {
    const state = await (await fetch(`${app.url}/api/captures`, { headers })).json(); job = state.jobs.find((job) => job.id === id);
    if (['completed', 'failed'].includes(job?.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(job.status, 'completed', job.error);
  const item = await (await fetch(`${app.url}/api/items/${job.itemId}`, { headers })).json();
  assert.equal(item.type, 'url'); assert.equal(item.assets.length, 4); assert.equal(item.facts.truncated, true);
  const ai = await (await fetch(`${app.url}/api/ai`, { headers })).json(); assert.equal(ai.usage.calls, 0); assert.equal(ai.settings.allowImageSharing, false);
  console.log('Capture browser smoke passed: sandboxed Chrome, three views, CSS facts, isolated cookies, blocked writes/private redirects, source + bundled API; no AI calls.');
} finally {
  await app?.stopServer();
  for (const server of [fixture, forbidden]) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  await rm(directory, { recursive: true, force: true });
}
