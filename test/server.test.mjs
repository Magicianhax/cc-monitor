import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { EventEmitter } from 'node:events';
import { connect } from 'node:net';
import { Store } from '../lib/store.mjs';
import { createApp, replayEvents, parseArgs, isLoopbackHost } from '../server.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const JSONH = { 'content-type': 'application/json' };
const post = (base, path, body, init = {}) => fetch(`${base}${path}`, { method: 'POST', headers: JSONH, body, ...init });
function boot() {
  const claudeDir = mkdtempSync(join(tmpdir(), 'cc-srv-'));
  mkdirSync(join(claudeDir, 'projects/F--x/sess-1/subagents'), { recursive: true });
  const publicDir = mkdtempSync(join(tmpdir(), 'cc-pub-'));
  writeFileSync(join(publicDir, 'index.html'), '<!doctype html><title>cc</title>');
  const store = new Store();
  const server = createApp({ store, claudeDir, publicDir });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ store, server, claudeDir, base: `http://127.0.0.1:${server.address().port}` })));
}

test('hook and status POSTs update store; bad json is 204', async () => {
  const { store, server, base } = await boot();
  let r = await post(base, '/hook', JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: 'F:/x', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't1' }));
  assert.equal(r.status, 204);
  r = await post(base, '/status', JSON.stringify({ session_id: 's1', context_window: { used_percentage: 7 } }));
  assert.equal(r.status, 204);
  r = await post(base, '/hook', '{nope');
  assert.equal(r.status, 204);
  assert.equal(store.session('s1').contextPct, 7);
  assert.equal(store.session('s1').agents.get('main').state, 'running');
  assert.equal(store.parseErrors, 1);
  const snap = await (await fetch(`${base}/api/sessions`)).json();
  assert.equal(snap.sessions[0].id, 's1');
  server.close();
});

test('SSE sends snapshot then deltas', async () => {
  const { server, base } = await boot();
  const res = await fetch(`${base}/events`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const read = async () => { const { value } = await reader.read(); buf += dec.decode(value); };
  await read();
  assert.match(buf, /^event: snapshot\ndata: \{/);
  await post(base, '/hook', JSON.stringify({ hook_event_name: 'Stop', session_id: 's9', cwd: 'F:/x' }));
  await wait(200);
  await read();
  assert.match(buf, /event: delta\ndata: \{"type":"session"/);
  reader.cancel();
  server.close();
});

test('a delta carries parseErrors so the strip keeps counting', async () => {
  const { server, base } = await boot();
  const res = await fetch(`${base}/events`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const read = async () => { const { value } = await reader.read(); buf += dec.decode(value); };
  await read();
  try {
    await post(base, '/hook', '{nope');
    await post(base, '/hook', JSON.stringify({ hook_event_name: 'Stop', session_id: 's7', cwd: 'F:/x' }));
    await wait(250);
    await read();
    const line = buf.split(/\r?\n/).filter((l) => l.startsWith('data: {"type":"session"')).pop();
    assert.ok(line, 'a delta arrived');
    const frame = JSON.parse(line.slice(6));
    assert.ok(frame.parseErrors >= 1, `parseErrors on the delta, got ${frame.parseErrors}`);
    assert.equal(typeof frame.now, 'number');
  } finally { reader.cancel(); server.close(); }
});

test('static: index, allowed ext, traversal blocked', async () => {
  const { server, base } = await boot();
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/nope.exe`)).status, 404);
  assert.equal((await fetch(`${base}/..%2F..%2Fetc`)).status, 404);
  server.close();
});

test('static: a sibling dir whose name starts with publicDir is not servable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cc-root-'));
  const publicDir = join(root, 'public');
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(join(publicDir, 'index.html'), '<!doctype html>');
  mkdirSync(join(root, 'public-secrets'), { recursive: true });
  writeFileSync(join(root, 'public-secrets', 'keys.json'), '{"secret":"LEAKED"}');
  const server = createApp({ store: new Store(), claudeDir: root, publicDir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // Bodies are always drained before asserting: an unread fetch body holds the socket open
    // and server.close() would then never complete, hanging the test runner instead of failing.
    const escape = await fetch(`${base}/..%2Fpublic-secrets%2Fkeys.json`);
    const body = await escape.text();
    assert.equal(escape.status, 404);
    assert.doesNotMatch(body, /LEAKED/);
    const index = await fetch(`${base}/`);
    await index.text();
    assert.equal(index.status, 200);
  } finally { server.close(); }
});

test('static: malformed percent-encoding is 404, not 500', async () => {
  const { server, base } = await boot();
  try {
    const r = await fetch(`${base}/%zz.css`);
    await r.text();
    assert.equal(r.status, 404);
  } finally { server.close(); }
});

test('replay rebuilds ordered events from files', async () => {
  const { server, base, claudeDir } = await boot();
  const line = (ts, extra) => JSON.stringify({ type: 'assistant', sessionId: 'sess-1', timestamp: ts, ...extra, message: { model: 'claude-opus-5', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 1 } } });
  writeFileSync(join(claudeDir, 'projects/F--x/sess-1.jsonl'), line('2026-09-16T16:00:02.000Z') + '\n' + line('2026-09-16T16:00:00.000Z') + '\n');
  writeFileSync(join(claudeDir, 'projects/F--x/sess-1/subagents/agent-a1.jsonl'), line('2026-09-16T16:00:01.000Z', { agentId: 'a1' }) + '\n');
  const evs = replayEvents(claudeDir, 'sess-1');
  assert.deepEqual(evs.map((e) => e.agentId), ['main', 'a1', 'main']);
  const r = await (await fetch(`${base}/api/session/sess-1/replay`)).json();
  assert.equal(r.events.length, 3);
  assert.equal((await fetch(`${base}/api/session/zzz/replay`)).status, 404);
  server.close();
});

test('the replay endpoint masks secrets in prompts', async () => {
  const { server, base, claudeDir } = await boot();
  const hex = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const rec = JSON.stringify({ type: 'user', sessionId: 'sess-1', timestamp: '2026-09-16T16:00:00.000Z',
    message: { role: 'user', content: `deploy with MY_API_KEY=${hex}` } });
  writeFileSync(join(claudeDir, 'projects/F--x/sess-1.jsonl'), `${rec}\n`);
  try {
    const r = await (await fetch(`${base}/api/session/sess-1/replay`)).json();
    const prompt = r.events.find((e) => e.kind === 'prompt');
    assert.ok(prompt, 'the prompt is replayed');
    assert.ok(prompt.text.includes('•••'), `masked, got ${prompt.text}`);
    assert.ok(!prompt.text.includes(hex), 'the raw key never leaves the server');
  } finally { server.close(); }
});

test('replay with a malformed percent-escape is 404, not 500', async () => {
  const { server, base } = await boot();
  try {
    const r = await fetch(`${base}/api/session/%zz/replay`);
    const body = await r.text();
    assert.equal(r.status, 404);
    assert.match(body, /unknown session/);
  } finally { server.close(); }
});

test('a body over the 2 MB limit gets a real 413', async () => {
  const { server, base } = await boot();
  try {
    // A reset socket would surface as a fetch TypeError, not a status, so asserting on the status
    // is what proves the 413 actually reached the client.
    const r = await post(base, '/hook', 'x'.repeat(3 * 1024 * 1024));
    const body = await r.text();
    assert.equal(r.status, 413);
    assert.match(body, /too large/);
  } finally { server.close(); }
});

test('the ping destroys a stalled SSE client while the store is idle', async (t) => {
  // The ping is the only thing that runs against an idle store, so it is the path that has to
  // enforce the slow-client rule; a delta never arrives to do it. Mocked timers fire the 15 s
  // interval immediately instead of making the suite wait for it.
  t.mock.timers.enable({ apis: ['setInterval'] });
  const store = new EventEmitter();
  store.snapshot = () => ({ sessions: [], totals: {}, parseErrors: 0, now: 0 });
  const dir = mkdtempSync(join(tmpdir(), 'cc-slow-'));
  const server = createApp({ store, claudeDir: dir, publicDir: dir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const sock = connect(server.address().port, '127.0.0.1');
    sock.on('error', () => {});
    sock.on('data', () => {});
    await new Promise((r) => sock.on('connect', r));
    sock.write('GET /events HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    await wait(150);   // let the server register this client
    const closed = new Promise((r) => sock.on('close', () => r('closed')));
    // Windows loopback swallows a whole multi-megabyte write and drains it inside a millisecond,
    // so a backed-up socket cannot be held across an await. Filling the buffer and firing the ping
    // in one synchronous turn reproduces the state the guard exists for, without depending on how
    // any particular kernel schedules its socket buffers.
    store.emit('change', { type: 'session', session: { id: 's1', blob: 'x'.repeat(8 * 1024 * 1024) } });
    t.mock.timers.tick(15000);
    assert.equal(await Promise.race([closed, wait(1000).then(() => 'still open')]), 'closed');
    sock.destroy();
  } finally { server.close(); server.closeAllConnections(); }
});

test('parseArgs defaults to loopback, port 4888 and ~/.claude', () => {
  const a = parseArgs([], {});
  assert.equal(a.host, '127.0.0.1');
  assert.equal(a.port, 4888);
  assert.equal(a.claudeDir, join(homedir(), '.claude'));
});

test('parseArgs reads the environment', () => {
  const a = parseArgs([], { CLAUDE_CITY_HOST: '0.0.0.0', CLAUDE_CITY_PORT: '5000', CLAUDE_CITY_CLAUDE_DIR: '/tmp/cc' });
  assert.deepEqual(a, { host: '0.0.0.0', port: 5000, claudeDir: '/tmp/cc' });
});

test('parseArgs flags beat the environment, in both spellings', () => {
  const env = { CLAUDE_CITY_HOST: '10.0.0.5', CLAUDE_CITY_PORT: '5000' };
  assert.deepEqual(
    parseArgs(['--host', '0.0.0.0', '--port', '4000', '--claude-dir', '/tmp/x'], env),
    { host: '0.0.0.0', port: 4000, claudeDir: '/tmp/x' },
  );
  assert.deepEqual(
    parseArgs(['--host=::', '--port=4001', '--claude-dir=/tmp/y'], env),
    { host: '::', port: 4001, claudeDir: '/tmp/y' },
  );
});

test('parseArgs ignores junk rather than dying on it', () => {
  const a = parseArgs(['--host', '', '--port', 'abc', '--wat'], {});
  assert.equal(a.host, '127.0.0.1');
  assert.equal(a.port, 4888);
  assert.equal(parseArgs([], { CLAUDE_CITY_PORT: 'nope' }, () => {}).port, 4888);
  assert.equal(parseArgs(['--host'], {}).host, '127.0.0.1');   // trailing flag, no value
});

test('isLoopbackHost decides when the LAN warning is printed', () => {
  for (const h of ['127.0.0.1', '127.7.7.7', 'localhost', '::1', '[::1]', 'LOCALHOST']) {
    assert.equal(isLoopbackHost(h), true, h);
  }
  for (const h of ['0.0.0.0', '::', '192.168.1.20', 'my-pc.local', '', null]) {
    assert.equal(isLoopbackHost(h), false, String(h));
  }
});

test('parseArgs rejects an out-of-range port from either source, with one warning', () => {
  const warned = [];
  const warn = (m) => warned.push(m);
  assert.equal(parseArgs([], { CLAUDE_CITY_PORT: '99999' }, warn).port, 4888);
  assert.equal(parseArgs([], { CLAUDE_CITY_PORT: 'abc' }, warn).port, 4888);
  assert.equal(parseArgs([], { CLAUDE_CITY_PORT: '-1' }, warn).port, 4888);
  assert.equal(parseArgs(['--port', '99999'], {}, warn).port, 4888);
  assert.equal(warned.length, 4);
  assert.match(warned[0], /99999/);
  // 0 means "any free port" and is legal from both sources.
  assert.equal(parseArgs([], { CLAUDE_CITY_PORT: '0' }, warn).port, 0);
  assert.equal(parseArgs(['--port', '0'], {}, warn).port, 0);
  assert.equal(parseArgs([], { CLAUDE_CITY_PORT: '4000' }, warn).port, 4000);
  assert.equal(warned.length, 4);   // nothing above warned
});

test('the old CC_MONITOR_* names still work, and CLAUDE_CITY_* wins when both are set', () => {
  const quiet = () => {};
  const legacy = parseArgs([], { CC_MONITOR_HOST: '10.0.0.7', CC_MONITOR_PORT: '5100', CC_MONITOR_CLAUDE_DIR: '/tmp/old' }, quiet);
  assert.deepEqual(legacy, { host: '10.0.0.7', port: 5100, claudeDir: '/tmp/old' });
  const both = parseArgs([], { CLAUDE_CITY_PORT: '5200', CC_MONITOR_PORT: '5100', CLAUDE_CITY_HOST: '', CC_MONITOR_HOST: '10.0.0.7' }, quiet);
  assert.equal(both.port, 5200);
  assert.equal(both.host, '10.0.0.7', 'an empty new name falls back to the old one');
});
