// Pure helpers shared by the 3D scene and the overlay. No imports, no DOM: also unit-tested in node.

/**
 * A finite number, or 0.
 *
 * Token counters are the reason this exists rather than `| 0`: cache reads on a
 * long-running machine pass 2^31, and the bitwise coercion silently wraps them
 * negative. A monitor that reports minus four billion tokens is worse than one
 * that reports nothing.
 */
export function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function toolFamily(name = '') {
  if (/^(Edit|Write|NotebookEdit|MultiEdit)$/.test(name)) return 'file';
  if (/^(Read|Grep|Glob|LSP)$/.test(name)) return 'read';
  if (/^(Bash|PowerShell)$/.test(name)) return 'shell';
  if (/^(WebFetch|WebSearch)$/.test(name) || name.startsWith('mcp__')) return 'web';
  if (/^(Agent|Workflow|Task|SendMessage)$/.test(name)) return 'agent';
  return 'other';
}

export function modelFamily(id) {
  const s = String(id || '');
  for (const f of ['fable', 'mythos', 'opus', 'sonnet', 'haiku']) if (s.includes(f)) return f === 'mythos' ? 'fable' : f;
  return 'unknown';
}

// Ulam-style square spiral: slot 0 is the centre, later slots ring outwards.
export function spiralSlot(i) {
  if (i === 0) return { x: 0, z: 0 };
  let x = 0, z = 0, dx = 1, dz = 0, len = 1, step = 0, turn = 0;
  for (let n = 0; n < i; n++) {
    x += dx; z += dz; step++;
    if (step === len) { step = 0; [dx, dz] = [-dz, dx]; turn++; if (turn % 2 === 0) len++; }
  }
  return { x, z };
}

/**
 * A token count in at most six glyphs.
 *
 * The headline cell is about 80 px of 22 px Fredoka, so the mantissa never gets
 * a fourth digit: a machine with billions of cache reads reads `4.79G`, not
 * `4785.93M` silently ellipsed to `4785.…`.
 */
export function fmtTokens(n) {
  if (n == null) return '–';
  const v = Number(n) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'G';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return String(v);
}

// Unknown cost is '?', never '$0.00'.
export function fmtUsd(v) { return typeof v === 'number' ? '$' + v.toFixed(2) : '?'; }

export function coinCount(usd) {
  const cents = Math.max(0, Math.round((Number(usd) || 0) * 100));
  return Math.min(12, Math.floor(Math.log2(cents + 1)));
}

export function burnRate(samples, now) {
  let sum = 0;
  for (const s of samples) if (now - s.ts <= 60_000) sum += Number(s.tokens) || 0;
  return sum;
}

/** Every token a session has spent, in one figure. */
export function totalTokens(t) {
  return num(t && t.input) + num(t && t.output) + num(t && t.cacheRead) + num(t && t.cacheWrite);
}

/**
 * What a session cost, or null when nothing can price it.
 *
 * There are two sources: `tokens.costUsd` is the cost table applied to the
 * transcript, `costUsd` comes from the optional status hook. The hook is
 * usually absent, so the priced total wins. Null is not zero — an unknown cost
 * has to read as `?`.
 */
export function sessionCost(s) {
  const priced = s && s.tokens && s.tokens.costUsd;
  if (typeof priced === 'number' && Number.isFinite(priced)) return priced;
  const hooked = s && s.costUsd;
  return typeof hooked === 'number' && Number.isFinite(hooked) ? hooked : null;
}

export function healthColor(pct) { if (pct == null || pct < 50) return 'ok'; if (pct < 80) return 'warn'; return 'bad'; }

/**
 * How much of the context window is left, as a percentage, or null when nobody
 * knows.
 *
 * DESIGN.md calls this a health bar and specifies `fill = 1 − ctx %`: it drains
 * as the window fills, the way a health bar drains. The panel and the canvas
 * both read it from here so the two can never disagree about which way it goes,
 * and null stays null — an empty bar reads as "0 % used", which is the opposite
 * of "unknown", so the caller draws no bar at all instead.
 */
export function contextRemaining(pct) {
  if (pct == null) return null;
  const n = Number(pct);
  if (!Number.isFinite(n)) return null;
  return 100 - Math.max(0, Math.min(100, n));
}

/**
 * Replay reducer: fold the first `upto` transcript events of one session into
 * just enough of a snapshot to drive the city — per agent tokens, the tool that
 * is still open, and a state. Hook-derived facts (processes, guard log) are not
 * in the transcript, so replay leaves them empty rather than inventing them.
 */
export function foldReplay(events, upto) {
  const agents = new Map();
  const tools = [];
  // Open tools by id, and how many each agent still holds. A linear scan of
  // `tools` per event made this O(n²), and a long session replays 50k events.
  const open = new Map();
  const openPerAgent = new Map();
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0, costUsd: null };
  const agent = (id, model) => {
    if (!agents.has(id)) {
      agents.set(id, {
        id, label: id, kind: id === 'main' ? 'main' : 'agent', model: model || null,
        state: 'idle', tool: null, toolCount: 0, startedAt: null, endedAt: null,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0, costUsd: null },
      });
    }
    const a = agents.get(id);
    if (model) a.model = model;
    return a;
  };
  let model = null;
  for (const ev of (events || []).slice(0, upto)) {
    const a = agent(ev.agentId || 'main', ev.model);
    if (a.startedAt == null) a.startedAt = ev.ts;
    if (ev.kind === 'usage') {
      const t = ev.tokens || {};
      // Not `| 0`: a long session's cache reads pass 2^31 and the bitwise
      // coercion wraps the running total negative.
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'thinking']) {
        const n = num(t[k]);
        a.tokens[k] += n;
        tokens[k] += n;
      }
      if (a.id === 'main' && ev.model) model = ev.model;
      for (const tu of ev.toolUses || []) {
        const rec = { id: tu.toolUseId, agentId: a.id, name: tu.name, startedAt: tu.ts, endedAt: null, ok: null, summary: tu.summary };
        tools.push(rec);
        if (!open.has(rec.id)) open.set(rec.id, rec);
        openPerAgent.set(a.id, (openPerAgent.get(a.id) || 0) + 1);
        a.tool = { name: tu.name, summary: tu.summary, since: tu.ts };
        a.state = 'running';
        a.toolCount++;
      }
    } else if (ev.kind === 'tool_result') {
      const t = open.get(ev.toolUseId);
      if (t) {
        t.endedAt = ev.ts;
        t.ok = ev.ok;
        open.delete(t.id);
        openPerAgent.set(t.agentId, Math.max(0, (openPerAgent.get(t.agentId) || 0) - 1));
      }
      if (!openPerAgent.get(a.id)) { a.tool = null; a.state = 'idle'; }
    }
  }
  return { agents: [...agents.values()], tools: tools.slice(-500), tokens, model };
}

/**
 * Lifecycle hooks the feed shows. Everything else in `hookLog` is already said by another row:
 * `PreToolUse` and `PostToolUse` by the tool row for the same call, `Stop` by the agent row, and
 * `UserPromptSubmit` by the prompt row. Without this filter one Bash call prints three lines and
 * the 200-row feed becomes a couple of minutes of lifecycle noise.
 */
const FEED_EVENTS = new Set(['SubagentStart', 'SubagentStop', 'PreCompact', 'Notification', 'SessionStart', 'SessionEnd']);

/** Whether a `hookLog` entry earns a feed row. Guard decisions always do. */
export function feedsHookRow(h) {
  if (!h) return false;
  if (h.kind === 'guard') return true;
  return FEED_EVENTS.has(h.event);
}

export function applyDelta(snapshot, delta) {
  const sessions = snapshot.sessions.slice();
  if (delta.type === 'session') {
    const i = sessions.findIndex((s) => s.id === delta.session.id);
    if (i >= 0) sessions[i] = delta.session; else sessions.push(delta.session);
  } else if (delta.type === 'removed') {
    const i = sessions.findIndex((s) => s.id === delta.id);
    if (i >= 0) sessions.splice(i, 1);
  }
  const next = { ...snapshot, sessions };
  // Session-wide fields ride along on every delta; without this they would keep the value they
  // had at connect time for the life of the connection.
  if (typeof delta.parseErrors === 'number') next.parseErrors = delta.parseErrors;
  if (typeof delta.now === 'number') next.now = delta.now;
  return next;
}
