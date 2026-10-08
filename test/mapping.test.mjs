import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolFamily, modelFamily, spiralSlot, fmtTokens, fmtUsd, coinCount, burnRate, healthColor, contextRemaining, applyDelta, feedsHookRow, foldReplay, num, totalTokens, sessionCost } from '../public/mapping.mjs';

test('families', () => {
  assert.equal(toolFamily('Edit'), 'file'); assert.equal(toolFamily('Write'), 'file'); assert.equal(toolFamily('NotebookEdit'), 'file');
  assert.equal(toolFamily('Read'), 'read'); assert.equal(toolFamily('Grep'), 'read'); assert.equal(toolFamily('Glob'), 'read');
  assert.equal(toolFamily('Bash'), 'shell'); assert.equal(toolFamily('PowerShell'), 'shell');
  assert.equal(toolFamily('WebFetch'), 'web'); assert.equal(toolFamily('mcp__vercel__list_projects'), 'web');
  assert.equal(toolFamily('Agent'), 'agent'); assert.equal(toolFamily('Workflow'), 'agent'); assert.equal(toolFamily('Skill'), 'other');
  assert.equal(modelFamily('claude-fable-5-1[1m]'), 'fable'); assert.equal(modelFamily('claude-opus-5'), 'opus'); assert.equal(modelFamily(null), 'unknown');
});
test('spiral slots are unique and start at centre', () => {
  assert.deepEqual(spiralSlot(0), { x: 0, z: 0 });
  const seen = new Set();
  for (let i = 0; i < 50; i++) { const s = spiralSlot(i); seen.add(`${s.x},${s.z}`); }
  assert.equal(seen.size, 50);
  assert.ok(Math.abs(spiralSlot(49).x) <= 4 && Math.abs(spiralSlot(49).z) <= 4);
});
test('formatting', () => {
  assert.equal(fmtTokens(999), '999'); assert.equal(fmtTokens(1234), '1.2k'); assert.equal(fmtTokens(1234567), '1.23M'); assert.equal(fmtTokens(null), '–');
  assert.equal(fmtUsd(1.2345), '$1.23'); assert.equal(fmtUsd(0), '$0.00'); assert.equal(fmtUsd(null), '?');
  assert.equal(coinCount(0), 0); assert.equal(coinCount(0.01), 1); assert.equal(coinCount(10), 9); assert.equal(coinCount(1e9), 12);
  assert.equal(healthColor(10), 'ok'); assert.equal(healthColor(50), 'warn'); assert.equal(healthColor(80), 'bad'); assert.equal(healthColor(null), 'ok');
});
test('fmtTokens never spends more than six glyphs on the headline', () => {
  // 4.2 billion cache reads is a real reading off this machine; at 22 px in an
  // 80 px column "4785.93M" would silently ellipsis to "4785.…".
  assert.equal(fmtTokens(4785925117), '4.79G');
  assert.equal(fmtTokens(1e9), '1.00G');
  assert.equal(fmtTokens(999999999), '1000.00M');
  for (const v of [0, 999, 1234, 1234567, 4785925117]) assert.ok(fmtTokens(v).length <= 8);
});

test('contextRemaining drains as the window fills, and keeps unknown unknown', () => {
  // DESIGN.md: "fill = 1 − ctx %". A session at 90 % context shows a tenth of
  // a bar, not nine tenths of one.
  assert.equal(contextRemaining(0), 100);
  assert.equal(contextRemaining(90), 10);
  assert.equal(contextRemaining(42), 58);
  // Clamped, because the store has reported over 100 % after a compaction.
  assert.equal(contextRemaining(140), 0);
  assert.equal(contextRemaining(-10), 100);
  // Unknown is not zero: the caller draws no bar rather than an empty one.
  assert.equal(contextRemaining(null), null);
  assert.equal(contextRemaining(undefined), null);
  assert.equal(contextRemaining('nonsense'), null);
});

test('burnRate over last 60 s', () => {
  const now = 100_000;
  assert.equal(burnRate([{ ts: now - 70_000, tokens: 999 }, { ts: now - 30_000, tokens: 500 }, { ts: now - 1000, tokens: 500 }], now), 1000);
  assert.equal(burnRate([], now), 0);
});
test('applyDelta replaces, adds, removes without mutating', () => {
  const snap = { sessions: [{ id: 'a', x: 1 }], totals: {} };
  const s2 = applyDelta(snap, { type: 'session', session: { id: 'a', x: 2 } });
  assert.equal(snap.sessions[0].x, 1); assert.equal(s2.sessions[0].x, 2);
  const s3 = applyDelta(s2, { type: 'session', session: { id: 'b', x: 3 } });
  assert.equal(s3.sessions.length, 2);
  const s4 = applyDelta(s3, { type: 'removed', id: 'a' });
  assert.deepEqual(s4.sessions.map((s) => s.id), ['b']);
});

test('applyDelta carries parseErrors and the wall clock forward', () => {
  const snap = { sessions: [], totals: {}, parseErrors: 0, now: 1000 };
  const s2 = applyDelta(snap, { type: 'session', session: { id: 'a' }, parseErrors: 3, now: 2000 });
  assert.equal(s2.parseErrors, 3);
  assert.equal(s2.now, 2000);
  assert.equal(snap.parseErrors, 0, 'the previous snapshot is untouched');
  const s3 = applyDelta(s2, { type: 'session', session: { id: 'a' } });
  assert.equal(s3.parseErrors, 3, 'a delta without the field keeps the last value');
  assert.equal(s3.now, 2000);
});

test('the feed keeps guard and lifecycle hooks, not per-tool noise', () => {
  assert.equal(feedsHookRow({ kind: 'guard', rule: 'destructive:rm', mode: 'block' }), true);
  for (const event of ['SubagentStart', 'SubagentStop', 'PreCompact', 'Notification', 'SessionStart', 'SessionEnd']) {
    assert.equal(feedsHookRow({ kind: 'hook', event }), true, event);
  }
  for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'UserPromptSubmit']) {
    assert.equal(feedsHookRow({ kind: 'hook', event }), false, event);
  }
  assert.equal(feedsHookRow(null), false);
  assert.equal(feedsHookRow({ kind: 'hook' }), false);
});

test('foldReplay tracks tokens, open tools and state', () => {
  const evs = [
    { kind: 'usage', agentId: 'main', ts: 1, model: 'claude-opus-5', tokens: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 }, toolUses: [{ toolUseId: 't1', name: 'Bash', summary: 'ls', ts: 1 }] },
    { kind: 'tool_result', agentId: 'main', ts: 2, toolUseId: 't1', ok: true },
    { kind: 'usage', agentId: 'a1', ts: 3, model: 'claude-sonnet-5', tokens: { input: 7, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 }, toolUses: [] },
  ];
  let f = foldReplay(evs, 1);
  assert.equal(f.agents[0].state, 'running');
  assert.equal(f.agents[0].tool.name, 'Bash');
  assert.equal(f.tokens.input, 5);
  f = foldReplay(evs, 3);
  assert.equal(f.agents[0].state, 'idle');
  assert.equal(f.agents[0].tool, null);
  assert.equal(f.tokens.input, 12);
  assert.equal(f.agents[1].model, 'claude-sonnet-5');
  assert.equal(f.model, 'claude-opus-5');
  assert.equal(f.tools[0].endedAt, 2);
  assert.equal(f.tools[0].ok, true);
  assert.deepEqual(foldReplay(evs, 0).agents, []);
});

test('num keeps values past 2^31 and rejects junk', () => {
  assert.equal(num(5e9), 5e9);
  assert.equal(num('4785925117'), 4785925117);
  assert.equal(num(null), 0);
  assert.equal(num('abc'), 0);
  assert.equal(num(Infinity), 0);
  assert.equal(num(undefined), 0);
});

test('foldReplay does not truncate billion-token counters to int32', () => {
  const big = 5e9;
  const evs = [
    { kind: 'usage', agentId: 'main', ts: 1, model: 'claude-opus-5', tokens: { input: 10, output: 0, cacheRead: big, cacheWrite: big, thinking: 0 }, toolUses: [] },
    { kind: 'usage', agentId: 'main', ts: 2, tokens: { input: 10, output: 0, cacheRead: big, cacheWrite: 0, thinking: 0 }, toolUses: [] },
  ];
  const f = foldReplay(evs, 2);
  assert.equal(f.tokens.cacheRead, big * 2);
  assert.equal(f.tokens.cacheWrite, big);
  assert.ok(f.tokens.cacheRead > 0, 'cache read must not wrap negative');
  assert.equal(f.agents[0].tokens.cacheRead, big * 2);
});

test('foldReplay closes only the tool that reported, across agents', () => {
  const evs = [
    { kind: 'usage', agentId: 'main', ts: 1, tokens: {}, toolUses: [{ toolUseId: 'x1', name: 'Bash', summary: 'a', ts: 1 }] },
    { kind: 'usage', agentId: 'main', ts: 2, tokens: {}, toolUses: [{ toolUseId: 'x2', name: 'Read', summary: 'b', ts: 2 }] },
    { kind: 'tool_result', agentId: 'main', ts: 3, toolUseId: 'x1', ok: true },
  ];
  let f = foldReplay(evs, 3);
  // One of the two is still open, so main is still running.
  assert.equal(f.agents[0].state, 'running');
  assert.equal(f.tools.find((t) => t.id === 'x1').endedAt, 3);
  assert.equal(f.tools.find((t) => t.id === 'x2').endedAt, null);
  f = foldReplay(evs.concat([{ kind: 'tool_result', agentId: 'main', ts: 4, toolUseId: 'x2', ok: false }]), 4);
  assert.equal(f.agents[0].state, 'idle');
  assert.equal(f.agents[0].tool, null);
  assert.equal(f.tools.find((t) => t.id === 'x2').ok, false);
});

test('totalTokens and sessionCost survive real snapshot shapes', () => {
  assert.equal(totalTokens({ input: 1, output: 2, cacheRead: 4785925117, cacheWrite: 3 }), 4785925123);
  assert.equal(totalTokens(null), 0);
  assert.equal(totalTokens({}), 0);
  // thinking is not double counted: it is already inside output.
  assert.equal(totalTokens({ input: 1, output: 2, thinking: 99 }), 3);
  // The cost table wins over the status hook, and unknown stays null.
  assert.equal(sessionCost({ tokens: { costUsd: 12.5 }, costUsd: 3 }), 12.5);
  assert.equal(sessionCost({ tokens: { costUsd: null }, costUsd: 3 }), 3);
  assert.equal(sessionCost({ tokens: {}, costUsd: null }), null);
  assert.equal(sessionCost({}), null);
  assert.equal(sessionCost(null), null);
});
