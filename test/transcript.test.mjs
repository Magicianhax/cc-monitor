import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contextFromPath, parseLine, summarizeToolInput } from '../lib/transcript.mjs';

const CD = 'C:/Users/alex/.claude';
const lines = readFileSync(new URL('./fixtures/main.jsonl', import.meta.url), 'utf8').trim().split('\n');
const ctx = { sessionId: 'sess-1', agentId: 'main', source: 'main', workflowId: null };

test('contextFromPath: main transcript', () => {
  assert.deepEqual(
    contextFromPath(`${CD}/projects/F--Tools-Claude/sess-1.jsonl`, CD),
    { sessionId: 'sess-1', agentId: 'main', source: 'main', workflowId: null });
});
test('contextFromPath: subagent', () => {
  assert.deepEqual(
    contextFromPath(`${CD}/projects/X/sess-1/subagents/agent-abc.jsonl`, CD),
    { sessionId: 'sess-1', agentId: 'abc', source: 'subagent', workflowId: null });
});
test('contextFromPath: workflow agent', () => {
  assert.deepEqual(
    contextFromPath(`${CD}/projects/X/sess-1/subagents/workflows/wf_68972fe1-f4d/agent-abc.jsonl`, CD),
    { sessionId: 'sess-1', agentId: 'abc', source: 'workflow', workflowId: 'wf_68972fe1-f4d' });
});
test('contextFromPath: backslashes and non-transcripts', () => {
  assert.equal(contextFromPath(`${CD}\\projects\\X\\sess-1\\tool-results\\r.json`, CD), null);
  assert.equal(contextFromPath(`${CD}\\projects\\X\\sess-1.jsonl`, CD).sessionId, 'sess-1');
});
test('usage record', () => {
  const ev = parseLine(lines[0], ctx);
  assert.equal(ev.kind, 'usage');
  assert.equal(ev.model, 'claude-fable-5-1');
  assert.equal(ev.effort, 'high');
  assert.equal(ev.ts, Date.parse('2026-09-16T16:00:00.000Z'));
  assert.deepEqual(ev.tokens, { input: 2, output: 1026, cacheRead: 0, cacheWrite: 49017, thinking: 946 });
});
test('tool_use record yields usage AND tool_use events', () => {
  const ev = parseLine(lines[1], ctx);
  assert.equal(ev.kind, 'usage');
  assert.equal(ev.toolUses.length, 1);
  assert.deepEqual(ev.toolUses[0], { kind: 'tool_use', sessionId: 'sess-1', agentId: 'main', ts: ev.ts, toolUseId: 'toolu_1', name: 'Bash', summary: 'ls -la /f/Tools' });
});
test('tool_result record', () => {
  const ev = parseLine(lines[2], ctx);
  assert.deepEqual(ev, { kind: 'tool_result', sessionId: 'sess-1', agentId: 'main', ts: Date.parse('2026-09-16T16:00:02.000Z'), toolUseId: 'toolu_1', ok: true });
});
test('prompt record', () => {
  const ev = parseLine(lines[3], ctx);
  assert.equal(ev.kind, 'prompt');
  assert.equal(ev.text, 'build the thing');
});
test('non-message and garbage return null', () => {
  assert.equal(parseLine(lines[4], ctx), null);
  assert.equal(parseLine('{not json', ctx), null);
  assert.equal(parseLine('', ctx), null);
});
test('subagent agentId from record beats ctx', () => {
  const l = readFileSync(new URL('./fixtures/subagent.jsonl', import.meta.url), 'utf8').trim();
  const ev = parseLine(l, { ...ctx, agentId: 'from-path' });
  assert.equal(ev.agentId, 'a1004b11b39a7aeb1');
  assert.equal(ev.model, 'claude-opus-5');
});
test('summarizeToolInput', () => {
  assert.equal(summarizeToolInput('Bash', { command: 'x y '.repeat(50) }).length, 80);
  // A 200-character run with no break in it is exactly the shape of a leaked key, so it is masked
  // rather than truncated; truncation would have published the first 80 characters of it.
  assert.equal(summarizeToolInput('Bash', { command: 'x'.repeat(200) }), '•••');
  assert.equal(summarizeToolInput('Read', { file_path: 'F:/a.txt' }), 'F:/a.txt');
  assert.equal(summarizeToolInput('Agent', { description: 'Fix tests', prompt: '...' }), 'Fix tests');
  assert.equal(summarizeToolInput('Weird', null), '');
});
