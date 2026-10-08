// The page: one live connection, one city, one panel that says what is going on.
//
// This file owns state — the last snapshot, the selection, the replay cursor
// and the activity feed — and hands a plain model to the panel on every change.
// It never touches panel DOM itself, so a render can be repeated at any time
// and a reconnect has nothing to unwind.

import { createTown } from './game/index.mjs';
import { applyDelta, burnRate, feedsHookRow, fmtTokens, foldReplay, num, sessionCost, toolFamily, totalTokens } from './mapping.mjs';
import { agentLabel, createPanel, sessionName } from './panel.mjs';

const $ = (id) => document.getElementById(id);

const FEED_CAP = 200;
// One session can hold 500 tools, 200 hook entries and 50 prompts, so a single
// delta can derive ~750 keys. The cap has to sit far above that or a key could
// be evicted and then re-derived by the very next delta, showing twice.
const SEEN_CAP = 20000;
const AGENTS_SEEN_CAP = 5000;

// -------------------------------------------------------------------- state

let snapshot = { sessions: [], totals: { sessionsAlive: 0, agentsRunning: 0, tokens: {} }, parseErrors: 0 };
let selection = null;         // { type:'session'|'agent', sessionId, agentId? }
let replay = null;            // { sessionId, name, events, i, timer }
let connected = false;
let showEnded = false;        // the finished-session list is opt-in

let feed = [];                // newest first, capped at FEED_CAP

/**
 * An insertion-ordered key set with a bound.
 *
 * The previous version re-derived every row of every session whenever it
 * overflowed. With ninety-one sessions the derivable key count is far above any
 * sane cap, so the set re-saturated immediately and the full scan then ran on
 * every delta for the life of the tab. Dropping the oldest quarter in one pass
 * is amortised constant and never reads the snapshot at all.
 */
function createSeen(cap) {
  const m = new Map();
  return {
    has: (k) => m.has(k),
    add(k) {
      if (m.has(k)) return;
      m.set(k, 1);
      if (m.size <= cap) return;
      const drop = Math.ceil(cap / 4);
      let n = 0;
      for (const old of m.keys()) {
        m.delete(old);
        if (++n >= drop) break;
      }
    },
    get size() { return m.size; },
  };
}

const feedSeen = createSeen(SEEN_CAP);
const agentsSeen = createSeen(AGENTS_SEEN_CAP);

const lastGuardTs = new Map();
const rateSamples = [];
let lastTokenTotal = null;
let lastSampleAt = 0;

/**
 * Totals, recomputed rather than read off the snapshot.
 *
 * `applyDelta` replaces one session and carries `totals` across untouched,
 * because the server only ever puts totals in the opening `snapshot` frame.
 * Trusting that field would freeze every headline number, and the tokens/minute
 * rate — which is the difference between two readings — would sit at zero for
 * the life of the tab.
 */
function totalsOf(v) {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0, costUsd: null };
  let sessionsAlive = 0;
  let agentsRunning = 0;
  for (const s of v.sessions || []) {
    if (s.alive) sessionsAlive++;
    for (const a of s.agents || []) if (a.state === 'running') agentsRunning++;
    const t = s.tokens || {};
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'thinking']) tokens[k] += num(t[k]);
    // A session whose cost is unknown must not read as zero, so the total stays
    // null until at least one session can price itself.
    const cost = sessionCost(s);
    if (cost !== null) tokens.costUsd = num(tokens.costUsd) + cost;
  }
  return { sessionsAlive, agentsRunning, tokens };
}

// --------------------------------------------------------------------- city

function cssTokens() {
  const cs = getComputedStyle(document.documentElement);
  const g = (k) => cs.getPropertyValue(k).trim();
  return {
    sky: g('--sky'), grass: g('--grass'), grass2: g('--grass-2'), wood: g('--wood'),
    roof: g('--roof'), stone: g('--stone'), ink: g('--ink'), paper: g('--paper'),
    coin: g('--coin'), ok: g('--ok'), warn: g('--warn'), bad: g('--bad'), water: g('--water'),
  };
}

const town = createTown($('scene'), {
  tokens: cssTokens(),
  onSelect: (sel) => select(sel),
});

const darkQuery = matchMedia('(prefers-color-scheme: dark)');
darkQuery.addEventListener('change', () => {
  // The tokens the scene draws with are the same custom properties the panel
  // uses, so a theme flip is one read and one push.
  town.setTheme(cssTokens());
  town.update(viewSnapshot());
});

// The panel is a fixed column above 640 px and a half-height sheet below it, so
// crossing that line changes the canvas box and Phaser has to be told. Every
// other resize has to reach it too: Phaser's own parent-size polling does not
// always catch a viewport that changed without the parent's CSS changing, and a
// canvas left at the previous size draws the city into one corner.
let resizePending = false;
function resizeSoon() {
  if (resizePending) return;
  resizePending = true;
  requestAnimationFrame(() => { resizePending = false; town.resize(); });
}
const sheetQuery = matchMedia('(max-width: 640px)');
sheetQuery.addEventListener('change', resizeSoon);
addEventListener('resize', resizeSoon);

// ---------------------------------------------------------------- selection

function select(sel) {
  const next = sel && sel.sessionId ? { ...sel } : null;
  const same = Boolean(next) && Boolean(selection)
    && next.sessionId === selection.sessionId
    && (next.agentId || null) === (selection.agentId || null);
  const was = selection;
  // Closing the detail hides the button that was focused. Where the keyboard
  // came from is the row that opened it, so that is where it goes back to.
  const fromDetail = $('sec-detail').contains(document.activeElement);
  selection = same ? null : next;
  if (!selection && replay) exitReplay();
  town.setSelected(selection ? selection.sessionId : null);
  render();
  if (selection) { $('sec-detail').scrollIntoView({ block: 'nearest', behavior: 'auto' }); return; }
  if (!fromDetail || !was) return;
  const row = $('sessions').querySelector(`[data-id="${CSS.escape(String(was.sessionId))}"]`);
  if (row) row.focus();
}

/** A session that has gone must not leave the panel filtered to it forever. */
function dropSelection(sessionId) {
  if (replay && replay.sessionId === sessionId) exitReplay();
  if (!selection || selection.sessionId !== sessionId) return;
  selection = null;
  town.setSelected(null);
}

// -------------------------------------------------------------- feed source

/**
 * Every feed line one session currently justifies, new or not.
 *
 * Keys are the ones the spec names (`tool:<id>`, `hook:<ts>:<event>`,
 * `prompt:<ts>`, `agent:<id>:<state>`) prefixed with the session id, because a
 * timestamp alone collides across two sessions that acted in the same
 * millisecond and the second one would then never be shown.
 */
/**
 * A pasted prompt, cut to the length the detail view uses.
 *
 * A prompt row is the one feed line allowed to wrap, and four thousand pasted
 * characters became a sixty-line row that pushed every other event out of the
 * list. The CSS clamps what is drawn; this is what stops the text arriving.
 */
const PROMPT_CHARS = 160;
const clip = (v) => {
  const s = String(v || '');
  return s.length > PROMPT_CHARS ? `${s.slice(0, PROMPT_CHARS - 1)}…` : s;
};

function deriveRows(s, now) {
  const rows = [];
  const sn = sessionName(s);
  const byId = new Map((s.agents || []).map((a) => [a.id, a]));
  const who = (id) => agentLabel(byId.get(id)) || id || 'main';

  for (const t of s.tools || []) {
    if (!t || t.id == null) continue;
    rows.push({
      key: `${s.id}|tool:${t.id}`, ts: t.startedAt || now, sid: s.id,
      sn, ag: who(t.agentId), tool: t.name || 'tool', sm: t.summary || '', cls: toolFamily(t.name),
    });
  }

  for (const h of s.hookLog || []) {
    if (!feedsHookRow(h)) continue;
    // The key names the kind as well as the stamp: with the lifecycle rows gone, a guard decision
    // and a session event landing on the same millisecond are the only pair left that could collide.
    const key = h.kind === 'guard'
      ? `${s.id}|guard:${h.ts}:${h.rule || ''}:${h.tool || ''}`
      : `${s.id}|hook:${h.ts}:${h.event}`;
    if (h.kind === 'guard') {
      const mode = h.mode === 'block' ? 'block' : 'warn';
      rows.push({
        key, ts: h.ts || now, sid: s.id, sn, ag: who(h.agentId),
        tool: mode === 'block' ? 'BLOCKED' : 'WARN',
        sm: [h.rule, h.tool].filter(Boolean).join(' · ') || 'guard', cls: mode,
      });
    } else {
      rows.push({
        key, ts: h.ts || now, sid: s.id, sn, ag: who(h.agentId),
        tool: h.event || 'hook', sm: h.tool || '', cls: 'other',
      });
    }
  }

  for (const p of s.prompts || []) {
    if (!p) continue;
    rows.push({ key: `${s.id}|prompt:${p.ts}`, ts: p.ts || now, sid: s.id, sn, ag: '', tool: 'you:', sm: clip(p.text), cls: 'you' });
  }

  for (const a of s.agents || []) {
    if (!a) continue;
    const id = `${s.id}/${a.id}`;
    const first = !agentsSeen.has(id);
    agentsSeen.add(id);
    const key = `${s.id}|agent:${a.id}:${a.state}`;
    // The column these land in holds a tool name on every other row, so they
    // say "agent" rather than changing what the column means mid-list.
    if (a.state === 'done') {
      rows.push({ key, ts: a.endedAt || now, sid: s.id, sn, ag: agentLabel(a), tool: 'agent', sm: 'finished', cls: 'agent' });
    } else if (first) {
      rows.push({ key, ts: a.startedAt || now, sid: s.id, sn, ag: agentLabel(a), tool: 'agent', sm: 'started', cls: 'agent' });
    } else {
      // A running↔idle flip is not news; claim the key so it is never news later.
      feedSeen.add(key);
    }
  }
  return rows;
}

/** Newest first across the whole feed, not just within the incoming batch. */
function pushFeed(rows) {
  if (!rows.length) return;
  feed = rows.concat(feed).sort((a, b) => b.ts - a.ts).slice(0, FEED_CAP);
}

/** New lines from one session delta. */
function ingest(s, now) {
  const rows = deriveRows(s, now).filter((r) => !feedSeen.has(r.key));
  for (const r of rows) feedSeen.add(r.key);
  pushFeed(rows);
}

/**
 * Backfill on first connect, so the feed is never a blank box.
 *
 * Finished sessions are marked seen first and live ones last: the seen set is
 * an LRU, and the sessions that will send deltas are the ones whose keys must
 * not be evicted.
 */
function seedFeed(now) {
  const sessions = (snapshot.sessions || []).slice()
    .sort((a, b) => Number(Boolean(a.alive)) - Number(Boolean(b.alive)));
  const rows = [];
  for (const s of sessions) {
    for (const r of deriveRows(s, now)) {
      if (feedSeen.has(r.key)) continue;
      feedSeen.add(r.key);
      rows.push(r);
    }
  }
  rows.sort((a, b) => a.ts - b.ts);
  pushFeed(rows.slice(-FEED_CAP));
}

/** During replay the feed shows that session's transcript and nothing else. */
function replayRows() {
  const rows = [];
  for (const ev of replay.events.slice(0, replay.i)) {
    if (!ev) continue;
    if (ev.kind === 'usage') {
      for (const tu of ev.toolUses || []) {
        rows.push({ key: `r|${tu.toolUseId}`, ts: tu.ts, sn: replay.name, ag: ev.agentId || 'main', tool: tu.name, sm: tu.summary || '', cls: toolFamily(tu.name) });
      }
    } else if (ev.kind === 'prompt') {
      rows.push({ key: `r|p${ev.ts}`, ts: ev.ts, sn: replay.name, ag: '', tool: 'you:', sm: ev.text || '', cls: 'you' });
    }
  }
  return rows.sort((a, b) => b.ts - a.ts).slice(0, FEED_CAP);
}

// --------------------------------------------------------------- connection

let backoff = 1000;
let es = null;

function connect() {
  es = new EventSource('/events');

  es.addEventListener('snapshot', (e) => {
    let next;
    try { next = JSON.parse(e.data); } catch { return; }
    snapshot = next;
    backoff = 1000;
    setConnected(true);
    resetRate();
    seedFeed(Date.now());
    render();
  });

  es.addEventListener('delta', (e) => {
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    snapshot = applyDelta(snapshot, d);
    if (d.type === 'session' && d.session) {
      ingest(d.session, Date.now());
      flashGuard(d.session);
    } else if (d.type === 'removed') {
      dropSelection(d.id);
    }
    render();
  });

  es.onerror = () => {
    setConnected(false);
    es.close();
    setTimeout(connect, backoff);
    backoff = Math.min(8000, backoff * 2);
  };
}

/** A guard verdict rings the plot in the city, once per verdict. */
function flashGuard(s) {
  const g = (s.hookLog || []).filter((h) => h && h.kind === 'guard' && (h.mode === 'block' || h.mode === 'warn')).at(-1);
  if (!g || g.ts === lastGuardTs.get(s.id)) return;
  lastGuardTs.set(s.id, g.ts);
  town.flashShield(s.id, g.mode);
}

function setConnected(on) {
  connected = on;
  $('conn').classList.toggle('on', on);
  $('conn-txt').textContent = on ? 'live' : 'offline';
  $('banner').hidden = on;
  // Losing the server is the one event the page must announce, and several
  // screen readers never announce a live region that was `hidden` when its
  // text changed. #live is always rendered; the banner is the visual half.
  $('live').textContent = on ? '' : 'Lost the claude-city server. Reconnecting…';
}

// ------------------------------------------------------------------ replay

function viewSnapshot() {
  let base = snapshot;
  if (replay) {
    const src = (snapshot.sessions || []).find((s) => s.id === replay.sessionId)
      || { id: replay.sessionId, name: replay.name, cwd: '', startedAt: 0, contextPct: null, costUsd: null };
    const f = foldReplay(replay.events, replay.i);
    base = {
      ...snapshot,
      sessions: [{
        ...src, alive: true, model: f.model || src.model,
        agents: f.agents, tools: f.tools, tokens: f.tokens,
        procs: [], prompts: src.prompts || [], hookLog: [],
      }],
    };
  }
  return { ...base, totals: totalsOf(base) };
}

async function startReplay(sessionId) {
  let events;
  try {
    const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}/replay`);
    if (!res.ok) return;
    const body = await res.json();
    events = Array.isArray(body.events) ? body.events : [];
  } catch {
    // A dead server or a body that is not JSON: stay live rather than throwing.
    return;
  }
  const src = (snapshot.sessions || []).find((s) => s.id === sessionId) || { id: sessionId };
  replay = { sessionId, name: sessionName(src), events, i: events.length, timer: null };
  const range = $('rp-range');
  range.max = String(events.length);
  range.value = String(events.length);
  $('rp-name').textContent = replay.name;
  $('replay').hidden = false;
  selection = { type: 'session', sessionId };
  town.setSelected(sessionId);
  // The view is now one session's totals instead of ninety-one. Carrying the
  // old baseline across would bill the difference as a minute of burn.
  resetRate();
  render();
}

function exitReplay() {
  if (!replay) return;
  clearInterval(replay.timer);
  replay = null;
  $('replay').hidden = true;
  $('rp-play').textContent = 'Play';
  resetRate();
  render();
}

$('rp-close').onclick = () => exitReplay();
$('rp-range').oninput = (e) => {
  if (!replay) return;
  replay.i = Number(e.target.value) || 0;
  render();
};
$('rp-play').onclick = () => {
  if (!replay) return;
  if (replay.timer) {
    clearInterval(replay.timer);
    replay.timer = null;
    $('rp-play').textContent = 'Play';
    return;
  }
  if (replay.i >= replay.events.length) replay.i = 0;
  $('rp-play').textContent = 'Pause';
  replay.timer = setInterval(() => {
    if (!replay) return;
    if (replay.i >= replay.events.length) { $('rp-play').click(); return; }
    replay.i++;
    $('rp-range').value = String(replay.i);
    render();
  }, 120);
};

// ---------------------------------------------------------------- rendering

const panel = createPanel({
  selectSession: (id) => select({ type: 'session', sessionId: id }),
  clearSelection: () => select(null),
  toggleEnded: () => { showEnded = !showEnded; render(); },
  replay: (id) => startReplay(id),
});

/** Everything the panel needs, and nothing it could write back to. */
function model(now, v) {
  return {
    v,
    now,
    selection,
    replay,
    replayName: replay ? replay.name : '',
    connected,
    showEnded,
    parseErrors: snapshot.parseErrors ?? 0,
    rateText: rateSamples.length ? fmtTokens(burnRate(rateSamples, now)) : '–',
    feedRows: replay ? replayRows() : feed,
  };
}

function render() {
  const now = Date.now();
  const v = viewSnapshot();
  town.update(v);
  trackRate(now, v.totals);
  panel.render(model(now, v));
  if (replay) $('rp-pos').textContent = `${replay.i} / ${replay.events.length}`;
  const alive = (snapshot.sessions || []).filter((s) => s.alive).length;
  $('empty').hidden = Boolean(replay) || alive > 0 || !connected;
  document.title = alive ? `Claude city · ${alive} live` : 'Claude city';
}

/**
 * Drop the burn-rate window.
 *
 * Every sample is a difference between two readings of the same total, so any
 * time the thing being totalled changes — a fresh snapshot, entering replay,
 * leaving it — the next difference is meaningless and would be reported as a
 * minute's worth of tokens.
 */
function resetRate() {
  lastTokenTotal = null;
  lastSampleAt = 0;
  rateSamples.length = 0;
}

function trackRate(now, totals) {
  const total = totalTokens((totals || {}).tokens);
  if (lastTokenTotal === null) { lastTokenTotal = total; lastSampleAt = now; return; }
  if (now - lastSampleAt < 1000) return;
  rateSamples.push({ ts: now, tokens: Math.max(0, total - lastTokenTotal) });
  lastTokenTotal = total;
  lastSampleAt = now;
  while (rateSamples.length > 180) rateSamples.shift();
}

// Elapsed times and the tokens-per-minute window move on their own, so the
// panel ticks once a second even when the server has nothing to say.
setInterval(() => {
  const now = Date.now();
  const v = viewSnapshot();
  trackRate(now, v.totals);
  panel.renderTick(model(now, v));
}, 1000);

setConnected(false);
render();
connect();

// The city has no DOM of its own, so this is the only handle a test — or a
// person in the console — has on what the scene currently believes.
window.__town = town;
