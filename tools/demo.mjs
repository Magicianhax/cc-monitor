// npm run demo — a city full of made-up Claude Code sessions, so you can see cc-monitor without
// running Claude Code, and so screenshots never show anyone's real prompts or paths.
//
// It builds a throwaway `.claude` folder in the OS temp directory, starts the real server against
// it, and keeps writing transcript lines, hook events and status updates the way Claude Code would.
// Ctrl+C stops everything and deletes the folder.
//
//   node tools/demo.mjs [--port 4890]
import { spawn } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argPort = process.argv.indexOf('--port');
const PORT = Number(argPort > -1 ? process.argv[argPort + 1] : process.env.CC_MONITOR_PORT) || 4890;
const BASE = `http://127.0.0.1:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'cc-monitor-demo-'));
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const between = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const iso = () => new Date().toISOString();

// ------------------------------------------------------------------ cast

const SESSIONS = [
  { name: 'shop-api', cwd: '/home/alex/code/shop-api', model: 'claude-opus-5', cars: 2,
    prompts: ['add rate limiting to the checkout endpoint', 'the refund test is flaky, find out why'] },
  { name: 'docs-site', cwd: '/home/alex/code/docs-site', model: 'claude-sonnet-5', cars: 1,
    prompts: ['rewrite the quick start for the new CLI', 'fix the broken links in the API reference'] },
  { name: 'ml-pipeline', cwd: '/home/alex/code/ml-pipeline', model: 'claude-fable-5-1', cars: 1,
    prompts: ['profile the feature extraction step', 'port the training loop to the new data loader'] },
];
const FINISHED = { name: 'infra-terraform', cwd: '/home/alex/code/infra', model: 'claude-opus-5' };
const SUBAGENTS = [
  ['Explore', 'claude-haiku-4-5'], ['general-purpose', 'claude-sonnet-5'], ['code-reviewer', 'claude-opus-5'],
  ['security-reviewer', 'claude-opus-5'], ['test-runner', 'claude-sonnet-5'],
];
const TOOLS = [
  ['Read', () => ({ file_path: pick(['src/checkout/handler.ts', 'src/lib/limits.ts', 'README.md', 'docs/api.md', 'package.json']) })],
  ['Grep', () => ({ pattern: pick(['rateLimit', 'TODO', 'refund', 'retry', 'export function']) })],
  ['Glob', () => ({ pattern: pick(['**/*.test.ts', 'docs/**/*.md', 'src/**/index.ts']) })],
  ['Edit', () => ({ file_path: pick(['src/checkout/handler.ts', 'src/lib/limits.ts', 'docs/quick-start.md', 'train/loop.py']) })],
  ['Write', () => ({ file_path: pick(['src/lib/limits.test.ts', 'docs/cli.md', 'CHANGELOG.md']) })],
  ['Bash', () => ({ command: pick(['npm test', 'git status --short', 'pnpm lint', 'pytest -q tests/unit', 'git diff --stat']) })],
  ['WebFetch', () => ({ url: pick(['https://docs.stripe.com/rate-limits', 'https://nodejs.org/api/test.html']) })],
  ['WebSearch', () => ({ query: pick(['token bucket vs sliding window', 'pytorch dataloader prefetch']) })],
  ['mcp__github__get_pull_request', () => ({ pull_number: between(100, 400) })],
  ['Skill', () => ({ skill: pick(['frontend-design', 'test-driven-development']) })],
];

// ----------------------------------------------------------- the stage

for (const sub of ['sessions', 'teams', 'hooks', 'projects']) mkdirSync(join(DIR, sub), { recursive: true });
writeFileSync(join(DIR, 'hooks', 'guard.log'), '');

// Each live session needs a real process id so the process poller can find "its" shells, which the
// city draws as cars. Every stand-in exits on its own as soon as its parent is gone.
const WATCH = (pid) => `setInterval(()=>{try{process.kill(${pid},0)}catch{process.exit()}},1500)`;
const standIns = [];
function standIn(cars) {
  const code = `const {spawn}=require('child_process');for(let i=0;i<${cars};i++)spawn(process.execPath,['-e',${JSON.stringify(WATCH('PID'))}.replace('PID',process.pid)],{stdio:'ignore'});${WATCH(process.pid)}`;
  const child = spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
  standIns.push(child);
  return child.pid;
}

const slug = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');
function transcriptPath(s, agentId) {
  const base = join(DIR, 'projects', slug(s.cwd));
  if (agentId === 'main') return join(base, `${s.id}.jsonl`);
  return join(base, s.id, 'subagents', `agent-${agentId}.jsonl`);
}
function write(s, agentId, record) {
  const file = transcriptPath(s, agentId);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify({ ...record, sessionId: s.id, cwd: s.cwd, timestamp: iso(), ...(agentId === 'main' ? {} : { agentId, isSidechain: true }) }) + '\n');
}
async function post(path, body) {
  try {
    await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch { /* server still starting; the next tick tries again */ }
}

function openTool(s, agent, forced) {
  const [name, input] = forced || pick(TOOLS);
  const id = `toolu_${randomBytes(10).toString('hex')}`;
  agent.open = id;
  write(s, agent.id, {
    type: 'assistant',
    message: {
      model: agent.model, role: 'assistant',
      content: [{ type: 'tool_use', id, name, input: typeof input === 'function' ? input() : input }],
      usage: {
        input_tokens: between(2, 40), output_tokens: between(150, 1600),
        cache_read_input_tokens: between(20_000, 90_000), cache_creation_input_tokens: between(0, 4_000),
      },
    },
  });
}
function closeTool(s, agent) {
  if (!agent.open) return;
  write(s, agent.id, {
    type: 'user', toolUseResult: { success: true },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: agent.open, content: 'ok' }] },
  });
  agent.open = null;
}
function prompt(s) {
  write(s, 'main', { type: 'user', message: { role: 'user', content: pick(s.prompts) } });
}

async function step(s) {
  const main = s.agents[0];
  const subs = s.agents.slice(1);
  const roll = Math.random();

  if (roll < 0.12 && subs.length < 3) {
    // Spawn a subagent: the main agent calls Agent, a new citizen leaves the Town hall.
    const [type, model] = pick(SUBAGENTS);
    const agent = { id: randomBytes(8).toString('hex'), model, open: null, left: between(4, 9) };
    closeTool(s, main);
    openTool(s, main, ['Agent', { description: `${type}: ${pick(['review the diff', 'find the flaky test', 'map the data flow', 'check auth paths'])}` }]);
    s.agents.push(agent);
    await post('/hook', { hook_event_name: 'SubagentStart', session_id: s.id, cwd: s.cwd, agent_id: agent.id, agent_type: type });
    openTool(s, agent);
    return;
  }
  if (roll < 0.16) {
    // A blocked command: the guard post sends someone running.
    closeTool(s, main);
    openTool(s, main, ['Bash', { command: 'rm -rf build/ node_modules/.cache' }]);
    appendFileSync(join(DIR, 'hooks', 'guard.log'), `${iso()} rule=destructive:recursive-delete mode=block tool=Bash session=${s.id}\n`);
    return;
  }
  if (roll < 0.20) {
    closeTool(s, main);
    prompt(s);
    return;
  }

  const agent = pick(s.agents);
  closeTool(s, agent);
  if (agent !== main && --agent.left <= 0) {
    s.agents.splice(s.agents.indexOf(agent), 1);
    await post('/hook', { hook_event_name: 'SubagentStop', session_id: s.id, cwd: s.cwd, agent_id: agent.id });
    if (s.agents.length === 1) closeTool(s, main);
    return;
  }
  if (agent === main && subs.length && main.open) return; // waiting on its subagents
  openTool(s, agent);
}

// ------------------------------------------------------------------ run

const live = SESSIONS.map((spec) => ({
  ...spec, id: randomUUID(), pid: standIn(spec.cars), ctx: between(12, 35),
  agents: [{ id: 'main', model: spec.model, open: null }],
}));
for (const s of live) {
  writeFileSync(join(DIR, 'sessions', `${s.pid}.json`), JSON.stringify({
    pid: s.pid, sessionId: s.id, cwd: s.cwd, name: s.name, status: 'busy', startedAt: Date.now() - between(5, 90) * 60_000, version: 'demo',
  }));
  prompt(s);
  openTool(s, s.agents[0]);
}
// A session that has already finished: its transcript appears once the server is watching, and no
// process stands behind it.
function finishedSession() {
  const done = { ...FINISHED, id: randomUUID(), prompts: ['plan the staging migration'] };
  const doneMain = { id: 'main', model: done.model, open: null };
  prompt(done);
  for (let i = 0; i < 6; i++) { openTool(done, doneMain); closeTool(done, doneMain); }
}

const server = spawn(process.execPath, [join(ROOT, 'server.mjs'), '--port', String(PORT)], {
  env: { ...process.env, CC_MONITOR_CLAUDE_DIR: DIR, CC_MONITOR_HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
server.stdout.on('data', () => {});
server.on('exit', (code) => { if (!stopping) { console.error(`[demo] server exited (${code})`); stop(1); } });

let stopping = false;
const timers = [];
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const t of timers) clearInterval(t);
  server.kill();
  for (const c of standIns) c.kill();
  setTimeout(() => {
    try { rmSync(DIR, { recursive: true, force: true }); } catch { /* a stand-in still holds a handle; temp is cleaned eventually */ }
    process.exit(code);
  }, 300);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

timers.push(setInterval(() => { step(pick(live)); }, 900));
timers.push(setInterval(() => {
  for (const s of live) {
    s.ctx = Math.min(96, s.ctx + Math.random() * 1.5);
    post('/status', { session_id: s.id, model: { id: s.model }, context_window: { used_percentage: Math.round(s.ctx) }, workspace: { current_dir: s.cwd } });
  }
}, 2000));

setTimeout(finishedSession, 2500);
console.log(`[demo] fictional sessions in ${DIR}`);
console.log(`[demo] open ${BASE}  (Ctrl+C to stop)`);
