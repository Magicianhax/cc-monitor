import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { Tailer } from '../lib/tail.mjs';
import { startIngest, readRegistry, readWorkflows, transcriptFiles } from '../lib/ingest.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function fakeClaudeDir() {
  const d = mkdtempSync(join(tmpdir(), 'cc-claude-'));
  for (const sub of ['sessions', 'teams', 'hooks', 'projects/F--x/sess-1/subagents', 'projects/F--x/sess-1/workflows']) mkdirSync(join(d, sub), { recursive: true });
  writeFileSync(join(d, 'hooks/guard.log'), '');
  return d;
}
// Every watcher must be closed before the directory goes, or Windows refuses the delete and a
// failed assertion leaves the test runner waiting on an open handle instead of reporting.
const cleanup = (d, h) => { if (h) h.stop(); rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); };
const noProcs = () => ({ stop() {} });
const usageLine = (sid, model, agentId) => JSON.stringify({ type: 'assistant', sessionId: sid, timestamp: '2026-09-16T16:00:00.000Z', ...(agentId ? { agentId, isSidechain: true } : {}),
  message: { model, role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) + '\n';

test('readRegistry / readWorkflows / transcriptFiles', () => {
  const d = fakeClaudeDir();
  try {
    writeFileSync(join(d, 'sessions/11.json'), JSON.stringify({ pid: 11, sessionId: 'sess-1', cwd: 'F:/x', name: 'farm', status: 'busy', startedAt: 1, version: '2.1.273' }));
    writeFileSync(join(d, 'sessions/garbage.json'), '{');
    assert.deepEqual(readRegistry(d), [{ pid: 11, sessionId: 'sess-1', cwd: 'F:/x', name: 'farm', status: 'busy', startedAt: 1, version: '2.1.273' }]);
    writeFileSync(join(d, 'projects/F--x/sess-1/workflows/wf_1.json'), JSON.stringify({ runId: 'wf_1', script: "export const meta = { name: 'osint', phases: [{ title: 'A' }, { title: 'B', detail: 'x' }] }" }));
    assert.deepEqual(readWorkflows(d, 'sess-1'), [{ sessionId: 'sess-1', runId: 'wf_1', name: 'osint', phases: [{ title: 'A' }, { title: 'B' }] }]);
    writeFileSync(join(d, 'projects/F--x/sess-1.jsonl'), '');
    writeFileSync(join(d, 'projects/F--x/sess-1/subagents/agent-a1.jsonl'), '');
    assert.equal(transcriptFiles(d, 'sess-1').length, 2);
  } finally { cleanup(d); }
});

test('startIngest populates store from registry, transcripts, subagents, guard log, and new sessions', async () => {
  const d = fakeClaudeDir();
  let h;
  try {
    writeFileSync(join(d, 'sessions/11.json'), JSON.stringify({ pid: 11, sessionId: 'sess-1', cwd: 'F:/x', name: 'farm', status: 'busy' }));
    writeFileSync(join(d, 'projects/F--x/sess-1.jsonl'), usageLine('sess-1', 'claude-opus-5'));
    const store = new Store();
    const procs = [];
    h = startIngest({ store, claudeDir: d, tailer: new Tailer({ pollMs: 50 }),
      procPoller: ({ rootPidsFn, onResult }) => { procs.push(rootPidsFn()); onResult(new Map([[11, [{ pid: 12, ppid: 11, name: 'node.exe', cmd: '', startedAt: null }]]])); return { stop() {} }; } });
    await wait(250);
    const s = store.session('sess-1');
    assert.equal(s.alive, true);
    assert.equal(s.tokens.input, 10);
    assert.deepEqual(procs[0], [11]);
    assert.equal(s.procs[0].pid, 12);

    appendFileSync(join(d, 'projects/F--x/sess-1/subagents/agent-a1.jsonl'), usageLine('sess-1', 'claude-sonnet-5', 'a1'));
    appendFileSync(join(d, 'hooks/guard.log'), '2026-09-16T16:23:13.527Z rule=x mode=block tool=Bash session=sess-1\n');
    await wait(300);
    assert.equal(store.session('sess-1').agents.get('a1').model, 'claude-sonnet-5');
    assert.equal(store.session('sess-1').hookLog.at(-1).kind, 'guard');

    mkdirSync(join(d, 'projects/F--y'), { recursive: true });
    writeFileSync(join(d, 'projects/F--y/sess-2.jsonl'), usageLine('sess-2', 'claude-opus-5'));
    writeFileSync(join(d, 'sessions/22.json'), JSON.stringify({ pid: 22, sessionId: 'sess-2', cwd: 'F:/y', name: 'two', status: 'idle' }));
    await wait(400);
    assert.equal(store.session('sess-2').alive, true);
    assert.equal(store.session('sess-2').tokens.input, 10);
  } finally { cleanup(d, h); }
});

test('stop() cancels a pending debounced refresh', async () => {
  const d = fakeClaudeDir();
  let h;
  try {
    writeFileSync(join(d, 'sessions/11.json'), JSON.stringify({ pid: 11, sessionId: 'sess-1', cwd: 'F:/x' }));
    writeFileSync(join(d, 'projects/F--x/sess-1.jsonl'), '');
    // sess-9's transcript exists up front but its session is not in the registry, so only a
    // registry refresh can reach it. Nothing under projects/ changes after start.
    mkdirSync(join(d, 'projects/F--z'), { recursive: true });
    writeFileSync(join(d, 'projects/F--z/sess-9.jsonl'), usageLine('sess-9', 'claude-opus-5'));
    const store = new Store();
    const tailer = new Tailer({ pollMs: 50 });
    h = startIngest({ store, claudeDir: d, tailer, procPoller: noProcs });
    await wait(150);
    assert.equal(tailer.files.size, 2);                          // guard.log + sess-1 main transcript
    assert.equal(store.session('sess-9'), undefined);

    writeFileSync(join(d, 'sessions/99.json'), JSON.stringify({ pid: 99, sessionId: 'sess-9', cwd: 'F:/z' }));
    await wait(100);                                             // let the watch event arm the 200 ms debounce
    h.stop();                                                    // ... then shut down while it is still pending
    await wait(300);
    assert.equal(tailer.files.size, 0);                          // close() emptied it and nothing was re-added afterwards
    assert.equal(store.session('sess-9'), undefined);
  } finally { cleanup(d, h); }
});

test('a registry refresh re-tracks nothing for a known session and still picks up a new one', async () => {
  const d = fakeClaudeDir();
  let h;
  try {
    writeFileSync(join(d, 'sessions/11.json'), JSON.stringify({ pid: 11, sessionId: 'sess-1', cwd: 'F:/x', status: 'busy' }));
    writeFileSync(join(d, 'projects/F--x/sess-1.jsonl'), usageLine('sess-1', 'claude-opus-5'));
    writeFileSync(join(d, 'projects/F--x/sess-1/workflows/wf_1.json'), JSON.stringify({ runId: 'wf_1', script: "export const meta = { name: 'osint', phases: [] }" }));
    const store = new Store();
    const applyWorkflow = store.applyWorkflow.bind(store);
    let workflowReads = 0;                                       // a re-walk of projects/ re-reads every wf_*.json
    store.applyWorkflow = (w) => { workflowReads += 1; applyWorkflow(w); };
    const tailer = new Tailer({ pollMs: 50 });
    h = startIngest({ store, claudeDir: d, tailer, procPoller: noProcs });
    await wait(150);
    const tailedBefore = tailer.files.size;
    assert.equal(workflowReads, 1);

    for (const status of ['idle', 'busy']) {                     // two more registry refreshes
      writeFileSync(join(d, 'sessions/11.json'), JSON.stringify({ pid: 11, sessionId: 'sess-1', cwd: 'F:/x', status }));
      await wait(300);
    }
    assert.equal(workflowReads, 1);                              // the refreshes did not re-scan the known session
    assert.equal(tailer.files.size, tailedBefore);
    assert.equal(store.session('sess-1').status, 'busy');
    assert.equal(store.session('sess-1').tokens.input, 10);      // the transcript was replayed once, not per refresh

    h.rescan();                                                  // an explicit rescan does force the walk again
    assert.equal(workflowReads, 2);

    mkdirSync(join(d, 'projects/F--y'), { recursive: true });
    writeFileSync(join(d, 'projects/F--y/sess-2.jsonl'), usageLine('sess-2', 'claude-opus-5'));
    writeFileSync(join(d, 'sessions/22.json'), JSON.stringify({ pid: 22, sessionId: 'sess-2', cwd: 'F:/y' }));
    await wait(400);
    assert.equal(tailer.files.size, tailedBefore + 1);
    assert.equal(store.session('sess-2').tokens.input, 10);
  } finally { cleanup(d, h); }
});

test('teams config and a workflow written after start reach the store', async () => {
  const d = fakeClaudeDir();
  let h;
  try {
    mkdirSync(join(d, 'teams/session-x'), { recursive: true });
    writeFileSync(join(d, 'sessions/11.json'), JSON.stringify({ pid: 11, sessionId: 'sess-1', cwd: 'F:/x' }));
    const store = new Store();
    h = startIngest({ store, claudeDir: d, tailer: new Tailer({ pollMs: 50 }), procPoller: noProcs });
    await wait(100);

    writeFileSync(join(d, 'teams/session-x/config.json'), JSON.stringify({ leadSessionId: 'sess-1',
      members: [{ agentId: 'lead-1', agentType: 'team-lead', name: 'lead' }, { agentId: 'impl-1', agentType: 'claude', name: 'impl-task-1' }] }));
    writeFileSync(join(d, 'projects/F--x/sess-1/workflows/wf_2.json'), JSON.stringify({ runId: 'wf_2', script: "export const meta = { name: 'osint', phases: [{ title: 'Recon' }] }" }));
    await wait(500);

    const s = store.session('sess-1');
    assert.equal(s.agents.get('impl-1').kind, 'team-member');
    assert.equal(s.agents.get('impl-1').label, 'impl-task-1');
    assert.equal(s.agents.has('lead-1'), false);                 // the lead is the session itself, not a member agent
    assert.equal(s.workflows.wf_2.name, 'osint');
    assert.deepEqual(s.workflows.wf_2.phases, ['Recon']);
  } finally { cleanup(d, h); }
});
