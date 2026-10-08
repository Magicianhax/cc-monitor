import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { createApp } from '../server.mjs';
import { portFrom } from '../hooks/port.mjs';

// The plugin hooks: Node scripts, no shell, the same on every OS.

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const runNode = (script, { input = '', env = {}, args = [] } = {}) => new Promise((resolve) => {
  const child = execFile(process.execPath, [script, ...args], { env: { ...process.env, ...env }, timeout: 8000 }, (err, stdout) => {
    resolve({ code: err ? err.code ?? 1 : 0, stdout: String(stdout) });
  });
  child.stdin.end(input);
});
const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

test('portFrom prefers CLAUDE_CITY_PORT, accepts the old name, and ignores junk', () => {
  assert.equal(portFrom({}), 4888);
  assert.equal(portFrom({ CC_MONITOR_PORT: '5001' }), 5001);
  assert.equal(portFrom({ CLAUDE_CITY_PORT: '5002', CC_MONITOR_PORT: '5001' }), 5002);
  assert.equal(portFrom({ CLAUDE_CITY_PORT: 'abc' }), 4888);
  assert.equal(portFrom({ CLAUDE_CITY_PORT: '70000', CC_MONITOR_PORT: '5003' }), 5003);
});

test('forward.mjs posts the payload, and in status mode echoes it back', async () => {
  const store = new Store();
  const server = createApp({ store, claudeDir: mkdtempSync(join(tmpdir(), 'cc-h-')), publicDir: mkdtempSync(join(tmpdir(), 'cc-p-')) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const env = { CLAUDE_CITY_PORT: String(server.address().port) };
  try {
    const hook = await runNode('hooks/forward.mjs', { env, input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'pf1', cwd: '/x' }) });
    assert.deepEqual(hook, { code: 0, stdout: '' });
    const status = JSON.stringify({ session_id: 'pf1', context_window: { used_percentage: 12 } });
    assert.deepEqual(await runNode('hooks/forward.mjs', { env, input: status, args: ['status'] }), { code: 0, stdout: status });
    await wait(50);
    assert.equal(store.session('pf1').hookLog[0].event, 'Stop');
    assert.equal(store.session('pf1').contextPct, 12);
  } finally { server.close(); }
});

test('forward.mjs exits 0 quickly when no server is listening', async () => {
  const t0 = Date.now();
  const r = await runNode('hooks/forward.mjs', { env: { CLAUDE_CITY_PORT: String(await freePort()) }, input: '{}' });
  assert.equal(r.code, 0);
  assert.ok(Date.now() - t0 < 3000);
});

test('start.mjs launches the server once, says where it is, and stays quiet when it is already up', async () => {
  const port = await freePort();
  const data = mkdtempSync(join(tmpdir(), 'cc-data-'));
  const env = { CLAUDE_CITY_PORT: String(port), CLAUDE_PLUGIN_DATA: data, CLAUDE_CITY_CLAUDE_DIR: mkdtempSync(join(tmpdir(), 'cc-claude-')) };
  let pid;
  try {
    const first = await runNode('hooks/start.mjs', { env });
    assert.equal(first.code, 0);
    assert.deepEqual(JSON.parse(first.stdout), { systemMessage: `claude-city: your sessions are live at http://127.0.0.1:${port}` });
    pid = Number(readFileSync(join(data, 'server.pid'), 'utf8'));
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    assert.equal(res.status, 200);
    const second = await runNode('hooks/start.mjs', { env });
    assert.deepEqual(second, { code: 0, stdout: '' });
  } finally {
    if (pid) { try { process.kill(pid); } catch { /* already gone */ } }
  }
});
