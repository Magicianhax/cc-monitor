import { readdirSync, readFileSync, statSync, watch, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Tailer } from './tail.mjs';
import { contextFromPath, parseLine } from './transcript.mjs';
import { startProcPoller } from './procs.mjs';

const norm = (p) => p.replace(/\\/g, '/');
function readJson(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }
function listDir(p) { try { return readdirSync(p, { withFileTypes: true }); } catch { return []; } }
function walk(dir, out = []) {
  for (const e of listDir(dir)) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

export function readRegistry(claudeDir) {
  const out = [];
  for (const e of listDir(join(claudeDir, 'sessions'))) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const j = readJson(join(claudeDir, 'sessions', e.name));
    if (j && j.sessionId) out.push({ pid: j.pid ?? null, sessionId: j.sessionId, cwd: j.cwd ?? null, name: j.name ?? null, status: j.status ?? null, startedAt: j.startedAt ?? null, version: j.version ?? null });
  }
  return out;
}

export function readTeams(claudeDir) {
  const out = [];
  for (const e of listDir(join(claudeDir, 'teams'))) {
    if (!e.isDirectory()) continue;
    const j = readJson(join(claudeDir, 'teams', e.name, 'config.json'));
    if (j) out.push(j);
  }
  return out;
}

function sessionDirs(claudeDir, sessionId) {
  const out = [];
  for (const slug of listDir(join(claudeDir, 'projects'))) {
    if (!slug.isDirectory()) continue;
    const d = join(claudeDir, 'projects', slug.name, sessionId);
    if (existsSync(d)) out.push(d);
  }
  return out;
}

export function readWorkflows(claudeDir, sessionId) {
  const out = [];
  for (const d of sessionDirs(claudeDir, sessionId)) {
    for (const e of listDir(join(d, 'workflows'))) {
      if (!e.isFile() || !/^wf_.*\.json$/.test(e.name)) continue;
      const j = readJson(join(d, 'workflows', e.name));
      if (!j) continue;
      const script = String(j.script || '');
      const name = (/name:\s*['"]([^'"]+)['"]/.exec(script) || [])[1] || j.runId || e.name;
      const phases = [...script.matchAll(/title:\s*['"]([^'"]+)['"]/g)].map((m) => ({ title: m[1] }));
      out.push({ sessionId, runId: j.runId || e.name.replace(/\.json$/, ''), name, phases });
    }
  }
  return out;
}

export function transcriptFiles(claudeDir, sessionId) {
  const out = [];
  for (const slug of listDir(join(claudeDir, 'projects'))) {
    if (!slug.isDirectory()) continue;
    const main = join(claudeDir, 'projects', slug.name, `${sessionId}.jsonl`);
    if (existsSync(main)) out.push(main);
    const sub = join(claudeDir, 'projects', slug.name, sessionId, 'subagents');
    if (existsSync(sub)) for (const f of walk(sub)) if (f.endsWith('.jsonl')) out.push(f);
  }
  return out;
}

export function startIngest({ store, claudeDir, tailer = new Tailer(), procPoller = startProcPoller, log = console.error }) {
  const tracked = new Set();
  const trackedSessions = new Set();
  const watchers = [];
  const projectsRoot = norm(join(claudeDir, 'projects')) + '/';
  let registry = [];
  let stopped = false;
  // A throw from a watcher callback or a debounce timer is an uncaught exception, so every
  // filesystem-driven entry point goes through here.
  const guard = (fn, label) => (...args) => { if (stopped) return; try { return fn(...args); } catch (e) { log('[ingest]', label, e.message); } };
  // Debounce timers outlive their watcher, so stop() has to be able to cancel them: a pending
  // refresh firing after tailer.close() would add a fresh fs.watch into a closed tailer and
  // pin the event loop forever.
  const timers = new Set();
  const debounce = (fn, ms) => {
    let t = null;
    return () => {
      if (stopped) return;
      if (t) { clearTimeout(t); timers.delete(t); }
      t = setTimeout(() => { timers.delete(t); t = null; fn(); }, ms);
      timers.add(t);
      if (t.unref) t.unref();
    };
  };

  const track = (path, fromStart) => {
    if (stopped) return;
    const p = norm(path);
    if (tracked.has(p)) return;
    tracked.add(p);
    tailer.add(path, { fromStart });
  };
  const trackSession = (sid) => {
    if (trackedSessions.has(sid)) return;   // new transcripts and workflows for a known session arrive via the projects/ watcher
    trackedSessions.add(sid);
    for (const f of transcriptFiles(claudeDir, sid)) track(f, true);
    for (const w of readWorkflows(claudeDir, sid)) store.applyWorkflow(w);
  };
  const refreshRegistry = () => {
    registry = readRegistry(claudeDir);
    store.setRegistry(registry);
    for (const r of registry) trackSession(r.sessionId);
  };
  const refreshTeams = () => { for (const t of readTeams(claudeDir)) store.applyTeam(t); };

  tailer.on('line', (path, line) => {
    try {
      if (norm(path).endsWith('/hooks/guard.log')) { store.applyGuardLine(line); return; }
      const ctx = contextFromPath(path, claudeDir);
      if (!ctx) return;
      const ev = parseLine(line, ctx);
      if (ev) { if (ctx.workflowId) ev.workflowId = ctx.workflowId; store.applyEvent(ev); }
    } catch (e) { store.parseErrors += 1; log('[ingest] parse error', path, e.message); }
  });
  tailer.on('error', (path, err) => log('[ingest] tail error', path, err.code || err.message));

  const safeWatch = (dir, opts, fn) => {
    try { const w = watch(dir, opts, guard(fn, `watch handler ${dir}`)); w.on('error', (e) => log('[ingest] watch error', dir, e.message)); watchers.push(w); }
    catch (e) { log('[ingest] cannot watch', dir, e.message); }
  };

  refreshRegistry();
  refreshTeams();
  track(join(claudeDir, 'hooks', 'guard.log'), false);

  safeWatch(join(claudeDir, 'sessions'), {}, debounce(guard(refreshRegistry, 'registry'), 200));
  safeWatch(join(claudeDir, 'teams'), { recursive: true }, debounce(guard(refreshTeams, 'teams'), 200));
  safeWatch(join(claudeDir, 'projects'), { recursive: true }, (evt, file) => {
    if (!file) return;
    const full = join(claudeDir, 'projects', String(file));
    if (/[\\/]workflows[\\/]wf_.*\.json$/.test(full)) {
      const rel = norm(full).slice(projectsRoot.length).split('/');   // [slug, sessionId, 'workflows', ...]
      if (rel[1]) for (const w of readWorkflows(claudeDir, rel[1])) store.applyWorkflow(w);
      return;
    }
    if (!contextFromPath(full, claudeDir)) return;
    try { statSync(full); } catch { return; }   // a delete event has no file to tail
    // From the start, always: a subagent transcript created after ingest starts is already
    // several lines long by the time the watch event arrives, and tailing from EOF would drop
    // them. The tracked set makes the replay one-time, and it matches what the registry pass
    // does for an alive session's transcripts.
    track(full, true);
  });

  const poller = procPoller({
    rootPidsFn: () => registry.filter((r) => r.pid).map((r) => r.pid),
    onResult: (byPid) => {
      const bySid = new Map();
      for (const r of registry) if (r.pid && byPid.has(r.pid)) bySid.set(r.sessionId, byPid.get(r.pid));
      store.setProcs(bySid);
    },
  });

  return {
    // The debounced registry path deliberately skips sessions it has already walked, so rescan()
    // is the way to force a full re-walk, e.g. if the recursive projects/ watch failed to start.
    rescan() { trackedSessions.clear(); refreshRegistry(); },
    stop() {
      if (stopped) return;
      stopped = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      poller.stop();
      for (const w of watchers) w.close();
      tailer.close();
    },
  };
}
