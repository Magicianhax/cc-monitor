import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { Store } from '../lib/store.mjs';
import { createApp, hostAllowed, originAllowed, safeEqual, makeToken, isLoopbackAddr } from '../server.mjs';

const JSONH = { 'content-type': 'application/json' };

// fetch() refuses to send a Host header of your choosing (it is a forbidden header name), and
// forging Host is the whole point of a rebinding test, so those requests go out through node:http
// with setHost disabled.
function raw(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers, setHost: false }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const post = (base, path, body, init = {}) => fetch(`${base}${path}`, { method: 'POST', headers: JSONH, body, ...init });

function boot(opts = {}) {
  const claudeDir = mkdtempSync(join(tmpdir(), 'cc-grd-'));
  mkdirSync(join(claudeDir, 'projects/F--x'), { recursive: true });
  const publicDir = mkdtempSync(join(tmpdir(), 'cc-grdpub-'));
  writeFileSync(join(publicDir, 'index.html'), '<!doctype html><title>cc</title>');
  const store = new Store();
  const server = createApp({ store, claudeDir, publicDir, ...opts });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ store, server, claudeDir, base: `http://127.0.0.1:${server.address().port}` })));
}

test('a Host header that is not this machine is refused', async () => {
  const { server, base } = await boot();
  const port = server.address().port;
  try {
    // DNS rebinding: the socket is loopback, but the browser believes it is talking to evil.com.
    const evil = await raw(port, '/api/sessions', { headers: { host: 'evil.com' } });
    assert.equal(evil.status, 403);
    assert.match(evil.body, /forbidden host/);
    const post403 = await raw(port, '/hook', { method: 'POST', headers: { host: `evil.com:${port}`, ...JSONH }, body: '{}' });
    assert.equal(post403.status, 403);
    const ok = await raw(port, '/api/sessions', { headers: { host: `127.0.0.1:${port}` } });
    assert.equal(ok.status, 200);
    const plain = await fetch(`${base}/api/sessions`);   // same request, undoctored Host
    await plain.text();
    assert.equal(plain.status, 200);
  } finally { server.close(); }
});

test('a cross-origin POST is refused even with the right Host', async () => {
  const { store, server, base } = await boot();
  try {
    const r = await post(base, '/hook', JSON.stringify({ hook_event_name: 'Stop', session_id: 'evil' }), { headers: { ...JSONH, origin: 'http://evil.com' } });
    await r.text();
    assert.equal(r.status, 403);
    assert.equal(store.session('evil'), undefined);
  } finally { server.close(); }
});

test('hook and status refuse anything but application/json', async () => {
  const { store, server, base } = await boot();
  try {
    // text/plain is a CORS-simple type: without this check any page could POST a fabricated hook.
    const r = await fetch(`${base}/hook`, { method: 'POST', body: JSON.stringify({ hook_event_name: 'Stop', session_id: 'plain', cwd: '/x' }) });
    await r.text();
    assert.equal(r.status, 415);
    assert.equal(store.session('plain'), undefined);
    const ok = await post(base, '/hook', JSON.stringify({ hook_event_name: 'Stop', session_id: 'plain', cwd: '/x' }), { headers: { 'content-type': 'application/json; charset=utf-8' } });
    assert.equal(ok.status, 204);
    assert.ok(store.session('plain'));
  } finally { server.close(); }
});

test('a replay id that is not a file name is 404 before any fs call', async () => {
  const { server, base } = await boot();
  try {
    for (const bad of ['%2F..%2F..%2Fetc', 'a%2Fb', encodeURIComponent('../../secrets'), 'x'.repeat(129), '%00']) {
      const r = await fetch(`${base}/api/session/${bad}/replay`);
      const body = await r.text();
      assert.equal(r.status, 404, bad);
      assert.match(body, /unknown session/, bad);
    }
    // A literal `..` never reaches the route at all: the client normalises it away first.
    const dots = await fetch(`${base}/api/session/../replay`);
    await dots.text();
    assert.equal(dots.status, 404);
  } finally { server.close(); }
});

test('responses carry nosniff, and HTML carries the CSP', async () => {
  const { server, base } = await boot();
  try {
    const page = await fetch(`${base}/`);
    await page.text();
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src [^;]*https:\/\/cdn\.jsdelivr\.net/);
    assert.match(csp, /frame-ancestors 'none'/);
    const api = await fetch(`${base}/api/sessions`);
    await api.text();
    assert.equal(api.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(api.headers.get('content-security-policy'), null);   // only HTML needs it
  } finally { server.close(); }
});

test('off loopback, the token gates every read and the cookie carries it', async () => {
  const token = makeToken();
  assert.match(token, /^[0-9a-f]{32}$/);
  // `host` is the LAN address this server would have been started on; the socket stays on loopback
  // so the test can reach it without touching a real network interface.
  const { server, base } = await boot({ host: '192.168.1.20', token });
  const port = server.address().port;
  try {
    const no = await fetch(`${base}/api/sessions`);
    await no.text();
    assert.equal(no.status, 401);

    const wrong = await fetch(`${base}/api/sessions?token=${'0'.repeat(32)}`);
    await wrong.text();
    assert.equal(wrong.status, 401);

    const first = await fetch(`${base}/?token=${token}`);
    await first.text();
    assert.equal(first.status, 200);
    const cookie = first.headers.get('set-cookie');
    assert.match(cookie, new RegExp(`^cc_token=${token};`));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);

    const withCookie = await fetch(`${base}/api/sessions`, { headers: { cookie: `cc_token=${token}` } });
    await withCookie.text();
    assert.equal(withCookie.status, 200);

    // The machine's own hooks POST from loopback with no cookie and must still get through.
    const hook = await post(base, '/hook', JSON.stringify({ hook_event_name: 'Stop', session_id: 'local', cwd: '/x' }));
    assert.equal(hook.status, 204);

    // The LAN address a phone would type is a legal Host for this bind.
    const asPhone = await raw(port, '/api/sessions', { headers: { cookie: `cc_token=${token}`, host: `192.168.1.20:${port}` } });
    assert.equal(asPhone.status, 200);
    // …and the token is still required over that same Host.
    const phoneNoToken = await raw(port, '/api/sessions', { headers: { host: `192.168.1.20:${port}` } });
    assert.equal(phoneNoToken.status, 401);
  } finally { server.close(); }
});

test('a loopback bind needs no token at all', async () => {
  const { server, base } = await boot();
  try {
    const r = await fetch(`${base}/api/sessions`);
    await r.text();
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('set-cookie'), null);
  } finally { server.close(); }
});

test('hostAllowed blocks names, allows this machine', () => {
  assert.equal(hostAllowed('127.0.0.1:4888', { host: '127.0.0.1', port: 4888 }), true);
  assert.equal(hostAllowed('localhost:4888', { host: '127.0.0.1', port: 4888 }), true);
  assert.equal(hostAllowed('[::1]:4888', { host: '127.0.0.1', port: 4888 }), true);
  assert.equal(hostAllowed('192.168.1.20:4888', { host: '0.0.0.0', port: 4888 }), true);
  assert.equal(hostAllowed('my-pc.local:4888', { host: 'my-pc.local', port: 4888 }), true);
  assert.equal(hostAllowed('evil.com:4888', { host: '0.0.0.0', port: 4888 }), false);
  assert.equal(hostAllowed('evil.com', { host: '127.0.0.1', port: 4888 }), false);
  assert.equal(hostAllowed('127.0.0.1:9999', { host: '127.0.0.1', port: 4888 }), false);
  assert.equal(hostAllowed('', { host: '127.0.0.1', port: 4888 }), true);   // no header, no rebinding
});

test('originAllowed matches the Host it arrived with', () => {
  assert.equal(originAllowed('http://127.0.0.1:4888', '127.0.0.1:4888'), true);
  assert.equal(originAllowed(undefined, '127.0.0.1:4888'), true);
  assert.equal(originAllowed('null', '127.0.0.1:4888'), true);
  assert.equal(originAllowed('http://evil.com', '127.0.0.1:4888'), false);
  assert.equal(originAllowed('http://127.0.0.1:9999', '127.0.0.1:4888'), false);
  assert.equal(originAllowed('file://x', '127.0.0.1:4888'), false);
});

test('safeEqual is exact and never throws on odd input', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), false);
  assert.equal(safeEqual(null, undefined), false);
});

test('isLoopbackAddr knows the shapes node reports', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.53']) assert.equal(isLoopbackAddr(a), true, a);
  for (const a of ['192.168.1.20', '10.0.0.1', '', undefined]) assert.equal(isLoopbackAddr(a), false, String(a));
});

test('a workflow run called __proto__ cannot reach Object.prototype', () => {
  const store = new Store();
  store.applyWorkflow({ sessionId: 's1', runId: 'run-7', name: 'real', phases: [{ title: 'build' }] });
  for (const runId of ['__proto__', 'constructor', 'prototype']) store.applyWorkflow({ sessionId: 's1', runId, name: 'evil' });
  assert.equal({}.name, undefined);
  assert.equal(Object.prototype.name, undefined);
  const s = store.session('s1');
  assert.equal(Object.getPrototypeOf(s.workflows), null);
  assert.deepEqual(Object.keys(s.workflows), ['run-7']);
  assert.deepEqual(s.workflows['run-7'], { name: 'real', phases: ['build'] });
});
