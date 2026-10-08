import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { createApp } from '../server.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (script, input, port) => execFileSync('sh', [script], { input, env: { ...process.env, CC_MONITOR_PORT: String(port) }, timeout: 5000 }).toString();

test('hook.sh posts and exits 0; status-tee.sh passes stdin through', async () => {
  const store = new Store();
  const server = createApp({ store, claudeDir: mkdtempSync(join(tmpdir(), 'cc-h-')), publicDir: mkdtempSync(join(tmpdir(), 'cc-p-')) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const payload = JSON.stringify({ hook_event_name: 'Stop', session_id: 'hs1', cwd: 'F:/x' });
  assert.equal(sh('hooks/hook.sh', payload, port), '');
  const status = JSON.stringify({ session_id: 'hs1', context_window: { used_percentage: 33 } });
  assert.equal(sh('hooks/status-tee.sh', status, port), status);
  await wait(100);
  assert.equal(store.session('hs1').contextPct, 33);
  assert.equal(store.session('hs1').hookLog[0].event, 'Stop');
  server.close();
});

test('hook.sh exits 0 with no server listening', () => {
  const t0 = Date.now();
  assert.equal(sh('hooks/hook.sh', '{}', 1), '');
  assert.ok(Date.now() - t0 < 3000);
});
