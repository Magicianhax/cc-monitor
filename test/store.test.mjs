import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.mjs';

const T0 = Date.parse('2026-09-16T16:00:00.000Z');
const usage = (over = {}) => ({ kind: 'usage', sessionId: 's1', agentId: 'main', ts: T0, model: 'claude-opus-5', effort: 'high',
  requestId: 'r', gitBranch: 'main', cwd: 'F:/x', version: '2.1.273',
  tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 }, toolUses: [], ...over });

test('usage rolls up agent → session → totals with cost', () => {
  const s = new Store();
  s.applyEvent(usage());
  s.applyEvent(usage({ agentId: 'sub1', model: 'claude-sonnet-5' }));
  const sess = s.session('s1');
  assert.equal(sess.tokens.input, 2_000_000);
  assert.equal(sess.agents.get('main').tokens.costUsd, 5);
  assert.equal(sess.agents.get('sub1').tokens.costUsd, 2);
  assert.equal(sess.tokens.costUsd, 7);
  assert.equal(s.snapshot().totals.tokens.input, 2_000_000);
  assert.equal(sess.model, 'claude-opus-5');
  assert.equal(sess.agents.get('sub1').kind, 'subagent');
});

test('unknown model cost is null and does not poison the sum', () => {
  const s = new Store();
  s.applyEvent(usage({ model: 'mystery' }));
  s.applyEvent(usage({ agentId: 'a2' }));
  assert.equal(s.session('s1').agents.get('main').tokens.costUsd, null);
  assert.equal(s.session('s1').tokens.costUsd, 5);
  s.applyEvent(usage({ sessionId: 's2', model: 'mystery' }));
  assert.equal(s.session('s2').tokens.costUsd, null, 'a session with no priced agent is null, not 0');
  const totals = s.snapshot().totals;
  assert.equal(totals.tokens.costUsd, 5, 'null session cost counts as 0 in totals');
  assert.equal(totals.tokens.input, 3_000_000);
});

test('tool_use opens a call, tool_result closes it, agent state follows', () => {
  const s = new Store();
  s.applyEvent(usage({ toolUses: [{ kind: 'tool_use', sessionId: 's1', agentId: 'main', ts: T0, toolUseId: 't1', name: 'Bash', summary: 'ls' }] }));
  let a = s.session('s1').agents.get('main');
  assert.equal(a.state, 'running');
  assert.deepEqual(a.tool, { name: 'Bash', summary: 'ls', since: T0 });
  s.applyEvent({ kind: 'tool_result', sessionId: 's1', agentId: 'main', ts: T0 + 500, toolUseId: 't1', ok: true });
  a = s.session('s1').agents.get('main');
  assert.equal(a.state, 'idle');
  assert.equal(a.tool, null);
  const tc = s.session('s1').tools[0];
  assert.equal(tc.endedAt, T0 + 500);
  assert.equal(tc.ok, true);
  assert.equal(a.toolCount, 1);
});

test('closing a call evicted by the cap does not stamp an unrelated row', () => {
  const s = new Store();
  for (let i = 0; i <= 500; i++) {
    s.applyEvent({ kind: 'tool_use', sessionId: 's1', agentId: 'main', ts: T0 + i, toolUseId: 't' + i, name: 'Read', summary: '' });
  }
  const sess = s.session('s1');
  assert.equal(sess.tools.length, 500);
  assert.equal(sess.tools.some((t) => t.id === 't0'), false, 't0 was evicted by the cap');
  s.applyEvent({ kind: 'tool_result', sessionId: 's1', agentId: 'main', ts: T0 + 9999, toolUseId: 't0', ok: true });
  assert.equal(sess.tools.every((t) => t.endedAt === null), true, 'no surviving row was closed');
  assert.equal(sess.agents.get('main').state, 'running');
});

test('a hook Post with no tool_use_id closes the open call by name', () => {
  const s = new Store();
  s.applyHook({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: 'F:/x', tool_name: 'Bash', tool_input: { command: 'ls -la' } });
  const sess = s.session('s1');
  assert.equal(sess.agents.get('main').state, 'running');
  assert.equal(sess.tools[0].summary, 'ls -la');
  s.applyHook({ hook_event_name: 'PostToolUse', session_id: 's1', cwd: 'F:/x', tool_name: 'Bash', tool_input: {}, tool_response: {} });
  assert.equal(sess.tools[0].ok, true);
  assert.notEqual(sess.tools[0].endedAt, null);
  assert.equal(sess.agents.get('main').state, 'idle');
});

test('hooks: Pre/Post timing by tool_use_id, SubagentStart/Stop, Stop', () => {
  let now = T0;
  const s = new Store({ now: () => now });
  s.applyHook({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: 'F:/x', tool_name: 'Edit', tool_input: { file_path: 'a.js' }, tool_use_id: 'h1' });
  assert.equal(s.session('s1').agents.get('main').state, 'running');
  now += 250;
  s.applyHook({ hook_event_name: 'PostToolUse', session_id: 's1', cwd: 'F:/x', tool_name: 'Edit', tool_input: {}, tool_use_id: 'h1', tool_response: {} });
  const tc = s.session('s1').tools.find((t) => t.id === 'h1');
  assert.equal(tc.endedAt - tc.startedAt, 250);
  s.applyHook({ hook_event_name: 'SubagentStart', session_id: 's1', cwd: 'F:/x', agent_id: 'ag9', agent_type: 'Explore' });
  assert.equal(s.session('s1').agents.get('ag9').state, 'running');
  assert.equal(s.session('s1').agents.get('ag9').label, 'Explore');
  s.applyHook({ hook_event_name: 'SubagentStop', session_id: 's1', cwd: 'F:/x', agent_id: 'ag9' });
  assert.equal(s.session('s1').agents.get('ag9').state, 'done');
  s.applyHook({ hook_event_name: 'Stop', session_id: 's1', cwd: 'F:/x' });
  assert.equal(s.session('s1').agents.get('main').state, 'idle');
  assert.equal(s.session('s1').hookLog.length, 5);
});

test('transcript tool_use and hook Pre for the same call do not double count', () => {
  const s = new Store();
  s.applyHook({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: 'F:/x', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't1' });
  s.applyEvent(usage({ toolUses: [{ kind: 'tool_use', sessionId: 's1', agentId: 'main', ts: T0, toolUseId: 't1', name: 'Bash', summary: 'ls' }] }));
  assert.equal(s.session('s1').tools.length, 1);
});

test('status, registry, procs, guard, team, workflow', () => {
  const s = new Store();
  s.applyStatus({ session_id: 's1', model: { id: 'claude-fable-5-1[1m]', display_name: 'Fable 5.1' }, cost: { total_cost_usd: 1.5 }, context_window: { used_percentage: 42 }, workspace: { current_dir: 'F:/x' } });
  assert.equal(s.session('s1').contextPct, 42);
  assert.equal(s.session('s1').costUsd, 1.5);
  s.setRegistry([{ pid: 11, sessionId: 's1', cwd: 'F:/x', name: 'farm', status: 'busy', startedAt: T0, version: '2.1.273' }]);
  assert.equal(s.session('s1').alive, true);
  assert.equal(s.session('s1').name, 'farm');
  s.setProcs(new Map([['s1', [{ pid: 12, ppid: 11, name: 'node.exe', cmd: 'node x', startedAt: T0 }]]]));
  assert.equal(s.session('s1').procs[0].pid, 12);
  s.applyGuardLine('2026-09-16T16:23:13.527Z rule=destructive:pipe-to-shell mode=block tool=Bash sha256=abc session=s1');
  assert.deepEqual(s.session('s1').hookLog.at(-1), { ts: Date.parse('2026-09-16T16:23:13.527Z'), kind: 'guard', rule: 'destructive:pipe-to-shell', mode: 'block', tool: 'Bash' });
  s.applyTeam({ leadSessionId: 's1', members: [{ agentId: 'team-lead@x', name: 'team-lead', agentType: 'team-lead' }, { agentId: 'w1@x', name: 'worker', agentType: 'general-purpose' }] });
  assert.equal(s.session('s1').agents.get('w1@x').kind, 'team-member');
  s.applyWorkflow({ sessionId: 's1', runId: 'wf_1', name: 'osint', phases: [{ title: 'A' }, { title: 'B' }] });
  assert.deepEqual(s.session('s1').workflows.wf_1, { name: 'osint', phases: ['A', 'B'] });
  s.setRegistry([]);
  assert.equal(s.session('s1').alive, false);
  assert.equal(s.session('s1').agents.get('main').state, 'done');
});

test('caps and change events', async () => {
  const s = new Store();
  const seen = [];
  s.on('change', (d) => seen.push(d));
  for (let i = 0; i < 600; i++) {
    s.applyEvent(usage({ toolUses: [{ kind: 'tool_use', sessionId: 's1', agentId: 'main', ts: T0 + i, toolUseId: 't' + i, name: 'Read', summary: '' }] }));
  }
  assert.equal(s.session('s1').tools.length, 500);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'session');
  assert.equal(seen[0].session.id, 's1');
});

test('snapshot is JSON-safe (agents as array)', () => {
  const s = new Store();
  s.applyEvent(usage());
  const snap = JSON.parse(JSON.stringify(s.snapshot()));
  assert.equal(snap.sessions[0].agents[0].id, 'main');
});

test('a hook-opened tool call is re-homed to the transcript agent', () => {
  const s = new Store();
  // Real Claude Code PreToolUse/PostToolUse payloads carry tool_use_id but no agent_id.
  s.applyHook({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: 'F:/x', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'tu1' });
  let sess = s.session('s1');
  assert.equal(sess.tools[0].agentId, 'main', 'the hook can only open it on main');
  assert.equal(sess.agents.get('main').state, 'running');

  // The transcript then names the real owner for the same tool_use_id.
  s.applyEvent(usage({ agentId: 'a1', toolUses: [{ kind: 'tool_use', sessionId: 's1', agentId: 'a1', ts: T0, toolUseId: 'tu1', name: 'Bash', summary: 'ls' }] }));
  sess = s.session('s1');
  assert.equal(sess.tools.length, 1, 'no duplicate row');
  assert.equal(sess.tools[0].agentId, 'a1');
  const main = sess.agents.get('main');
  const a1 = sess.agents.get('a1');
  assert.equal(main.toolCount, 0);
  assert.equal(main.tool, null);
  assert.equal(main.state, 'idle');
  assert.equal(a1.toolCount, 1);
  assert.equal(a1.state, 'running');
  assert.equal(a1.tool.name, 'Bash');

  // PostToolUse has no agent_id either, so it must close on a1, not on main.
  s.applyHook({ hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash', tool_use_id: 'tu1' });
  sess = s.session('s1');
  assert.equal(sess.tools[0].ok, true);
  assert.notEqual(sess.tools[0].endedAt, null);
  assert.equal(sess.agents.get('a1').state, 'idle');
  assert.equal(sess.agents.get('a1').tool, null);
  assert.equal(sess.agents.get('main').state, 'idle');
});
