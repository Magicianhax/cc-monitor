import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePwshJson, descendants, listProcesses, startProcPoller } from '../lib/procs.mjs';

const sample = JSON.stringify([
  { ProcessId: 1, ParentProcessId: 0, Name: 'wininit.exe', CommandLine: null, CreationDate: '2026-09-16T10:00:00.000Z' },
  { ProcessId: 10, ParentProcessId: 1, Name: 'claude.exe', CommandLine: 'claude', CreationDate: '/Date(1789574550091)/' },
  { ProcessId: 11, ParentProcessId: 10, Name: 'bash.exe', CommandLine: 'bash -c "npm test"', CreationDate: 'garbage' },
  { ProcessId: 12, ParentProcessId: 11, Name: 'node.exe', CommandLine: 'node x.js', CreationDate: null },
  { ProcessId: 20, ParentProcessId: 1, Name: 'other.exe', CommandLine: '', CreationDate: null },
]);

test('parsePwshJson handles dates, nulls, single object', () => {
  const ps = parsePwshJson(sample);
  assert.equal(ps.length, 5);
  assert.equal(ps[0].startedAt, Date.parse('2026-09-16T10:00:00.000Z'));
  assert.equal(ps[1].startedAt, 1789574550091);
  assert.equal(ps[2].startedAt, null);
  assert.equal(ps[3].cmd, 'node x.js');
  assert.equal(parsePwshJson(JSON.stringify({ ProcessId: 5, ParentProcessId: 1, Name: 'x' })).length, 1);
  assert.deepEqual(parsePwshJson('nope'), []);
});

test('descendants walks the tree', () => {
  const ps = parsePwshJson(sample);
  const d = descendants(ps, [10, 20, 999]);
  assert.deepEqual(d.get(10).map((p) => p.pid), [11, 12]);
  assert.deepEqual(d.get(20), []);
  assert.deepEqual(d.get(999), []);
});

test('descendants never returns the root itself when the tree has a cycle', () => {
  const d = descendants([{ pid: 5, ppid: 1 }, { pid: 6, ppid: 5 }, { pid: 5, ppid: 6 }], [5]);
  assert.deepEqual(d.get(5).map((p) => p.pid), [6]);
});

test('listProcesses swallows runner failure', async () => {
  assert.deepEqual(await listProcesses(async () => { throw new Error('no pwsh'); }), []);
  // The parser follows the platform, so a pwsh-JSON fixture has to say it is pwsh JSON; on a POSIX
  // host the same call would otherwise be handed to the ps parser.
  assert.equal((await listProcesses(async () => sample, { platform: 'win32' })).length, 5);
});

test('poller delivers descendants and backs off when slow', async () => {
  const results = [];
  let calls = 0;
  const run = async () => { calls++; if (calls === 2) await new Promise((r) => setTimeout(r, 60)); return sample; };
  const p = startProcPoller({ rootPidsFn: () => [10], onResult: (m) => results.push(m), run, platform: 'win32', intervalMs: 20, slowMs: 40, backoffMs: 200 });
  await new Promise((r) => setTimeout(r, 150));
  p.stop();
  assert.ok(results.length >= 2 && results.length <= 3, `got ${results.length}`);
  assert.deepEqual(results[0].get(10).map((x) => x.pid), [11, 12]);
});
