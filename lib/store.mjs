import { EventEmitter } from 'node:events';
import { costUsd } from './cost.mjs';
import { summarizeToolInput } from './transcript.mjs';
import { redact } from './redact.mjs';

const CAP = { tools: 500, hookLog: 200, prompts: 50 };
const zeroTokens = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0, costUsd: 0 });

function addTokens(dst, src) {
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'thinking']) dst[k] += Number(src[k]) || 0;
}
function sumCost(agents) {
  let c = null;
  for (const a of agents.values()) if (typeof a.tokens.costUsd === 'number') c = (c ?? 0) + a.tokens.costUsd;
  return c;   // null when no agent has a known model, so an unpriced session never reads as free
}
function agentKind(agentId, hint) {
  if (agentId === 'main') return 'main';
  if (hint === 'workflow') return 'workflow-agent';
  if (hint === 'team') return 'team-member';
  return 'subagent';
}

export class Store extends EventEmitter {
  constructor({ now = () => Date.now() } = {}) {
    super();
    this.now = now;
    this.sessions = new Map();
    this.parseErrors = 0;
    this._dirty = new Set();
    this._timer = null;
  }

  // ---------- internals ----------
  _session(id, cwd) {
    let s = this.sessions.get(id);
    if (!s) {
      s = { id, pid: null, cwd: cwd || null, name: null, status: null, model: null, version: null, gitBranch: null,
        contextPct: null, costUsd: null, startedAt: this.now(), lastSeenAt: this.now(), lastHookAt: null, alive: false,
        tokens: zeroTokens(), agents: new Map(), tools: [], prompts: [], procs: [], hookLog: [], workflows: Object.create(null) };
      this.sessions.set(id, s);
      this._agent(s, 'main');   // every session has a main agent, even before any transcript or hook input
    }
    if (cwd && !s.cwd) s.cwd = cwd;
    s.lastSeenAt = this.now();
    this._dirty.add(id);
    this._schedule();
    return s;
  }
  _agent(s, id, { label, kindHint, workflowId, model } = {}) {
    let a = s.agents.get(id);
    if (!a) {
      a = { id, kind: agentKind(id, kindHint), label: label || (id === 'main' ? 'main' : id), parentId: id === 'main' ? null : 'main',
        model: model || null, state: 'idle', startedAt: this.now(), endedAt: null, tokens: zeroTokens(), toolCount: 0, tool: null, workflowId: workflowId || null };
      s.agents.set(id, a);
    }
    if (label && a.label === a.id) a.label = label;
    if (model) a.model = model;
    if (workflowId) { a.workflowId = workflowId; a.kind = 'workflow-agent'; }
    return a;
  }
  _pushCapped(arr, item, cap) { arr.push(item); if (arr.length > cap) arr.splice(0, arr.length - cap); }
  // A tool row's owner, recomputed from the rows that are still open. Used whenever a row moves
  // between agents so the losing agent does not keep a stale `tool` or a stuck `running` state.
  _resettle(s, a) {
    const open = s.tools.filter((t) => t.agentId === a.id && t.endedAt === null);
    const last = open[open.length - 1];
    a.tool = last ? { name: last.name, summary: last.summary || '', since: last.startedAt } : null;
    if (!last && a.state === 'running') a.state = 'idle';
  }
  _openTool(s, a, { id, name, summary, ts }) {
    const existing = id && s.tools.find((t) => t.id === id);
    if (existing) {
      // Real PreToolUse/PostToolUse payloads carry `tool_use_id` but no `agent_id`, so the hook
      // opens every call on `main`. The transcript carries the true owner and arrives second, so
      // it re-homes the row rather than returning early and leaving the work on `main`.
      if (a.id !== 'main' && existing.agentId === 'main' && existing.agentId !== a.id) {
        const prev = s.agents.get(existing.agentId);
        existing.agentId = a.id;
        if (prev) { prev.toolCount = Math.max(0, prev.toolCount - 1); this._resettle(s, prev); }
        a.toolCount += 1;
        if (existing.endedAt === null) {
          a.tool = { name: existing.name, summary: existing.summary || '', since: existing.startedAt };
          a.state = 'running';
        }
      }
      return existing;
    }
    const tc = { id: id || `${a.id}:${ts}:${name}`, agentId: a.id, name, startedAt: ts, endedAt: null, ok: null, summary: summary || '' };
    this._pushCapped(s.tools, tc, CAP.tools);
    a.toolCount += 1;
    a.tool = { name, summary: summary || '', since: ts };
    a.state = 'running';
    return tc;
  }
  _closeTool(s, a, { id, name, ts, ok }) {
    // Match by id when we have one. Falling back to "most recent open call" for a known id would
    // stamp an unrelated row once the real call has been evicted by the tools cap.
    let tc;
    if (id) tc = s.tools.find((t) => t.id === id && t.endedAt === null);
    else tc = [...s.tools].reverse().find((t) => t.agentId === a.id && t.endedAt === null && (!name || t.name === name));
    if (tc) { tc.endedAt = ts; tc.ok = ok ?? null; }
    // PostToolUse has no `agent_id` either, so the caller is `main` while the row may already have
    // been re-homed to the subagent that owns it. Settle the row's owner, not the caller.
    const owner = (tc && s.agents.get(tc.agentId)) || a;
    this._resettle(s, owner);
    if (owner !== a) this._resettle(s, a);
  }
  _recost(s, a) {
    a.tokens.costUsd = costUsd(a.model, a.tokens);
    s.tokens.costUsd = sumCost(s.agents);
  }
  _schedule() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      for (const id of this._dirty) {
        const s = this.sessions.get(id);
        if (s) this.emit('change', { type: 'session', session: this._plain(s) });
      }
      this._dirty.clear();
    }, 100);
    if (this._timer.unref) this._timer.unref();
  }
  _plain(s) { return { ...s, agents: [...s.agents.values()] }; }

  // ---------- inputs ----------
  applyEvent(ev) {
    if (!ev || !ev.sessionId) return;
    const s = this._session(ev.sessionId, ev.cwd);
    const kindHint = ev.workflowId ? 'workflow' : undefined;
    const a = this._agent(s, ev.agentId || 'main', { kindHint, workflowId: ev.workflowId, model: ev.model });
    if (ev.kind === 'usage') {
      addTokens(a.tokens, ev.tokens); addTokens(s.tokens, ev.tokens);
      if (ev.model && a.id === 'main') s.model = ev.model;
      if (ev.version) s.version = ev.version;
      if (ev.gitBranch != null) s.gitBranch = ev.gitBranch;
      this._recost(s, a);
      for (const tu of ev.toolUses || []) this._openTool(s, a, { id: tu.toolUseId, name: tu.name, summary: tu.summary, ts: tu.ts });
    } else if (ev.kind === 'tool_use') {
      this._openTool(s, a, { id: ev.toolUseId, name: ev.name, summary: ev.summary, ts: ev.ts });
    } else if (ev.kind === 'tool_result') {
      this._closeTool(s, a, { id: ev.toolUseId, ts: ev.ts, ok: ev.ok });
    } else if (ev.kind === 'prompt') {
      // A prompt is free text that people paste keys into, and it is broadcast to every browser
      // exactly like a command line is. Both prompt paths mask before storing, never on the way out.
      if (a.id === 'main') this._pushCapped(s.prompts, { ts: ev.ts, text: redact(ev.text) }, CAP.prompts);
    }
  }

  applyHook(p) {
    if (!p || !p.session_id) return;
    const s = this._session(p.session_id, p.cwd);
    const ts = this.now();
    s.lastHookAt = ts;
    const ev = p.hook_event_name || 'unknown';
    const agentId = p.agent_id || 'main';
    this._pushCapped(s.hookLog, { ts, kind: 'hook', event: ev, tool: p.tool_name || null, agentId }, CAP.hookLog);
    switch (ev) {
      case 'PreToolUse': {
        const a = this._agent(s, agentId);
        this._openTool(s, a, { id: p.tool_use_id, name: p.tool_name, summary: summarizeToolInput(p.tool_name, p.tool_input), ts });
        break;
      }
      case 'PostToolUse': case 'PostToolUseFailure': {
        const a = this._agent(s, agentId);
        this._closeTool(s, a, { id: p.tool_use_id, name: p.tool_name, ts, ok: ev === 'PostToolUse' });
        break;
      }
      case 'SubagentStart': {
        const a = this._agent(s, p.agent_id || `agent-${ts}`, { label: p.agent_type || p.agent_name });
        a.state = 'running'; a.startedAt = ts;
        break;
      }
      case 'SubagentStop': {
        const a = this._agent(s, p.agent_id || 'main');
        a.state = 'done'; a.endedAt = ts; a.tool = null;
        break;
      }
      case 'Stop': {
        const a = this._agent(s, 'main');
        a.state = 'idle'; a.tool = null;
        break;
      }
      case 'UserPromptSubmit': {
        if (p.prompt) this._pushCapped(s.prompts, { ts, text: redact(String(p.prompt)).slice(0, 2000) }, CAP.prompts);
        this._agent(s, 'main').state = 'running';
        break;
      }
      case 'SessionEnd': { s.alive = false; break; }
      default: break;
    }
  }

  applyStatus(p) {
    if (!p || !p.session_id) return;
    const s = this._session(p.session_id, p.workspace && p.workspace.current_dir);
    if (p.model && p.model.id) s.model = p.model.id;
    if (p.cost && typeof p.cost.total_cost_usd === 'number') s.costUsd = p.cost.total_cost_usd;
    if (p.context_window && typeof p.context_window.used_percentage === 'number') s.contextPct = p.context_window.used_percentage;
  }

  setRegistry(list) {
    const seen = new Set();
    for (const r of list || []) {
      if (!r || !r.sessionId) continue;
      seen.add(r.sessionId);
      const s = this._session(r.sessionId, r.cwd);
      s.pid = r.pid ?? s.pid; s.name = r.name ?? s.name; s.status = r.status ?? s.status;
      if (r.startedAt) s.startedAt = r.startedAt;
      if (r.version) s.version = r.version;
      s.alive = true;
    }
    for (const s of this.sessions.values()) {
      if (!seen.has(s.id) && s.alive) {
        s.alive = false;
        for (const a of s.agents.values()) { a.state = 'done'; a.tool = null; if (!a.endedAt) a.endedAt = this.now(); }
        this._dirty.add(s.id); this._schedule();
      }
    }
  }

  setProcs(map) {
    for (const [sid, procs] of map) { const s = this.sessions.get(sid); if (s) { s.procs = procs; this._dirty.add(sid); this._schedule(); } }
  }

  applyGuardLine(line) {
    const m = /^(\S+) (.*)$/.exec(line || '');
    if (!m) return;
    const kv = Object.fromEntries(m[2].split(' ').map((p) => p.split('=')).filter((p) => p.length === 2));
    if (!kv.session) return;
    const s = this._session(kv.session);
    this._pushCapped(s.hookLog, { ts: Date.parse(m[1]) || this.now(), kind: 'guard', rule: kv.rule || null, mode: kv.mode || null, tool: kv.tool || null }, CAP.hookLog);
  }

  applyTeam(cfg) {
    if (!cfg || !cfg.leadSessionId) return;
    const s = this._session(cfg.leadSessionId);
    for (const m of cfg.members || []) {
      if (m.agentType === 'team-lead') continue;
      this._agent(s, m.agentId, { label: m.name, kindHint: 'team' });
    }
  }

  applyWorkflow(w) {
    if (!w || !w.sessionId || !w.runId) return;
    // runId is a directory name from disk, so it is attacker-shaped input: a run called `__proto__`
    // would otherwise reach Object.prototype. The map has a null prototype as well, so this is the
    // belt to that brace.
    const runId = String(w.runId);
    if (runId === '__proto__' || runId === 'constructor' || runId === 'prototype') return;
    const s = this._session(w.sessionId);
    s.workflows[runId] = { name: w.name || runId, phases: (w.phases || []).map((p) => p.title || String(p)) };
  }

  removeSession(id) { if (this.sessions.delete(id)) this.emit('change', { type: 'removed', id }); }

  // ---------- outputs ----------
  session(id) { return this.sessions.get(id); }
  snapshot() {
    const totals = { tokens: zeroTokens(), sessionsAlive: 0, agentsRunning: 0 };
    const sessions = [];
    for (const s of this.sessions.values()) {
      addTokens(totals.tokens, s.tokens);
      totals.tokens.costUsd += s.tokens.costUsd || 0;
      if (s.alive) totals.sessionsAlive += 1;
      for (const a of s.agents.values()) if (a.state === 'running') totals.agentsRunning += 1;
      sessions.push(this._plain(s));
    }
    return { sessions, totals, parseErrors: this.parseErrors, now: this.now() };
  }
}
