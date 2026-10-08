import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePs, runPs } from '../lib/procs-posix.mjs';
import { listProcesses, startProcPoller } from '../lib/procs.mjs';

// Real `ps -axo pid=,ppid=,lstart=,comm=,args=` output: pid, ppid, a five-field lstart, then comm
// and args run together. Line 2 is the macOS shape, where comm is the full executable path and so
// can contain spaces; line 4 is junk that no ps ever prints but a broken shim might.
const fixture = [
  '    1     0 Mon Sep 15 09:12:03 2026 systemd /sbin/init splash',
  '  914     1 Tue Sep  1 08:04:59 2026 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=renderer --lang=en-US',
  ' 1021   914 Wed Sep 16 23:59:01 2026 node /home/u/.local/bin/node server.mjs --host 0.0.0.0',
  'ps: unknown option -- lstart',
  '',
].join('\n');

test('parsePs reads pid, ppid, lstart and splits comm from args', () => {
  const ps = parsePs(fixture);
  assert.equal(ps.length, 3);

  assert.deepEqual(ps[0], {
    pid: 1, ppid: 0, name: 'systemd', cmd: '/sbin/init splash',
    startedAt: Date.parse('Mon Sep 15 09:12:03 2026'),
  });

  // The comm contains two spaces; splitting on whitespace would have called it "/Applications/Google".
  assert.equal(ps[1].pid, 914);
  assert.equal(ps[1].ppid, 1);
  assert.equal(ps[1].name, 'Google Chrome');
  assert.equal(ps[1].cmd, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=renderer --lang=en-US');
  assert.equal(ps[1].startedAt, Date.parse('Tue Sep 1 08:04:59 2026'));

  assert.equal(ps[2].pid, 1021);
  assert.equal(ps[2].ppid, 914);
  assert.equal(ps[2].name, 'node');
  assert.equal(ps[2].cmd, '/home/u/.local/bin/node server.mjs --host 0.0.0.0');
});

test('parsePs keeps a process whose lstart is unparsable and drops non-process lines', () => {
  const ps = parsePs('  7   1 not a real date here bash bash -c "npm test"\nUSER PID %CPU\n');
  assert.equal(ps.length, 1);
  assert.equal(ps[0].startedAt, null);
  assert.equal(ps[0].name, 'bash');
  assert.equal(ps[0].cmd, 'bash -c "npm test"');
  assert.deepEqual(parsePs(''), []);
  assert.deepEqual(parsePs(null), []);
});

test('parsePs handles a kernel thread with no real argv', () => {
  const ps = parsePs('    2     0 Mon Sep 15 09:12:03 2026 kthreadd [kthreadd]');
  assert.equal(ps.length, 1);
  assert.equal(ps[0].name, 'kthreadd');
  assert.equal(ps[0].cmd, '[kthreadd]');
});

test('listProcesses parses ps output when the platform is posix', async () => {
  assert.equal((await listProcesses({ platform: 'linux', run: async () => fixture })).length, 3);
  assert.equal((await listProcesses({ platform: 'darwin', run: async () => fixture })).length, 3);
  // Same runner, Windows parser: pwsh JSON is what it expects, so ps text yields nothing.
  assert.deepEqual(await listProcesses({ platform: 'win32', run: async () => fixture }), []);
  assert.deepEqual(await listProcesses({ platform: 'linux', run: async () => { throw new Error('no ps'); } }), []);
});

test('listProcesses keeps the positional runner form, with platform in a second arg', async () => {
  assert.equal((await listProcesses(async () => fixture, { platform: 'linux' })).length, 3);
});

test('the poller passes its platform down to the parser', async () => {
  const results = [];
  const p = startProcPoller({
    platform: 'linux', run: async () => fixture, rootPidsFn: () => [914],
    onResult: (m) => results.push(m), intervalMs: 20,
  });
  await new Promise((r) => setTimeout(r, 40));
  p.stop();
  assert.ok(results.length >= 1, 'poller produced no result');
  assert.deepEqual(results[0].get(914).map((x) => x.pid), [1021]);
});

test('runPs is exported and rejects rather than throwing synchronously', async () => {
  assert.equal(typeof runPs, 'function');
  await runPs().then(
    (out) => assert.equal(typeof out, 'string'),
    (err) => assert.ok(err instanceof Error),   // no `ps` on this box (Windows): a rejection, which listProcesses turns into []
  );
});
