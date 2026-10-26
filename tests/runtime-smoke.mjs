import assert from 'node:assert/strict';

// Vitest transforms imports. Exercise the exact native ESM graph used by the built Node server too.
const { startServer } = await import('../apps/server/dist/server.js');
assert.equal(typeof startServer, 'function');
console.log('Built server and native dependencies import successfully in Node.');
