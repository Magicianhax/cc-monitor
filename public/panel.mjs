// The panel: everything on the right of the canvas.
//
// Rows are patched in place against a stable key, never rebuilt. A monitor is
// read, not just watched: rewriting innerHTML on every delta throws away the
// reader's text selection, the hover they are following and the keyboard focus
// they are navigating with, several times a second.
//
// Row text is written with textContent, so none of it can be HTML at all. Only
// the detail section still assembles markup, and every value in it is escaped.

import {
  contextRemaining, fmtTokens, fmtUsd, healthColor, modelFamily, sessionCost, totalTokens,
} from './mapping.mjs';

const $ = (id) => document.getElementById(id);

/** The detail section is the only place that still builds markup. */
export const esc = (v) => String(v == null ? '' : v)
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------- formatting

export const hhmmss = (ts) => {
  const d = new Date(Number(ts) || 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** Short, monotone durations: 9s, 4m12, 2h07. */
export function elapsed(since, now) {
  if (!since) return '';
  const s = Math.max(0, Math.round((now - since) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}

/** The last two path segments, which is the part of a cwd anyone recognises. */
export function cwdTail(cwd) {
  const parts = String(cwd || '').replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(-2).join('/') || String(cwd || '');
}

/**
 * `mcp__plugin_playwright_playwright__browser_take_screenshot` is 58 characters
 * of mostly server name. The last segment is the tool, so that is what shows.
 */
export function shortTool(name) {
  const s = String(name || '');
  if (!s.startsWith('mcp__')) return s;
  const parts = s.split('__').filter(Boolean);
  return `mcp:${parts[parts.length - 1]}`;
}

export const modelChip = (model) => {
  const f = modelFamily(model);
  return f === 'unknown' ? '?' : f;
};

export const sessionName = (s) => s.name || String(s.id || '').slice(0, 8) || 'session';
export const agentLabel = (a) => (a && (a.label || a.id)) || 'main';

/** The header column is 80 px wide, so four figures of dollars get shortened. */
export function fmtUsdShort(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '?';
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`;
  return `$${v.toFixed(2)}`;
}

// ------------------------------------------------------------- DOM patching

function el(tag, cls, parent) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
}

function setText(node, value) {
  const s = value == null ? '' : String(value);
  if (node.textContent !== s) node.textContent = s;
}

function setClass(node, cls) {
  if (node.className !== cls) node.className = cls;
}

function setAttr(node, name, value) {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

/**
 * Reconcile `box`'s children against `items`, matching on `keyOf`.
 *
 * Surviving rows keep their identity, so focus, hover and any selected text
 * inside them survive too. Anything without a `data-k` (an empty-state line) is
 * swept first, and rows whose key has gone are removed at the end.
 */
function syncRows(box, items, keyOf, create, update) {
  const alive = new Map();
  for (const child of Array.from(box.children)) {
    const k = child.dataset.k;
    if (k === undefined) child.remove();
    else alive.set(k, child);
  }
  let prev = null;
  for (const item of items) {
    const k = String(keyOf(item));
    let node = alive.get(k);
    if (node) alive.delete(k);
    else {
      node = create();
      node.dataset.k = k;
    }
    update(node, item);
    const at = prev ? prev.nextSibling : box.firstChild;
    if (node !== at) box.insertBefore(node, at);
    prev = node;
  }
  for (const node of alive.values()) {
    // A session that ends under the cursor takes its row away. Without this the
    // keyboard is returned to the top of the document mid-read.
    if (node.contains(document.activeElement)) {
      const to = node.nextElementSibling || node.previousElementSibling;
      if (to && to.tagName === 'BUTTON') to.focus();
    }
    node.remove();
  }
}

function emptyRow(box, text) {
  const n = el('div', 'empty-row');
  n.textContent = text;
  box.appendChild(n);
}

const NOW_RUNNING_CAP = 20;
const NOW_IDLE_CAP = 4;

/**
 * `handlers` is how the panel talks back: `selectSession(id)`, `toggleEnded()`,
 * `replay(id)`, `clearSelection()`, `feedPinnedChanged(bool)`.
 */
export function createPanel(handlers) {
  let feedPinned = true;
  let detailSig = null;

  $('feed').addEventListener('scroll', () => {
    const pinned = $('feed').scrollTop < 8;
    if (pinned === feedPinned) return;
    feedPinned = pinned;
    $('feed-pin').hidden = pinned;
  });
  $('feed-pin').onclick = () => {
    feedPinned = true;
    $('feed').scrollTop = 0;
    $('feed-pin').hidden = true;
  };
  $('detail-close').onclick = () => handlers.clearSelection();
  $('dead-toggle').onclick = () => handlers.toggleEnded();

  // ------------------------------------------------------------ session rows

  function createSessionRow() {
    const b = el('button', 'srow');
    b.type = 'button';
    const top = el('span', 'top', b);
    const f = {
      nm: el('span', 'nm', top),
      chip: el('span', 'chip', top),
      age: el('span', 'el', top),
      cwd: el('span', 'cwd', b),
    };
    const met = el('span', 'met', b);
    const bar = el('span', 'bar', met);
    f.fill = el('i', 'ok', bar);
    f.bar = bar;
    f.ctx = el('span', 'g', met);
    f.cost = el('span', 'g', met);
    f.tok = el('span', 'g', met);
    f.ag = el('span', 'g', met);
    b.fields = f;
    b.onclick = () => handlers.selectSession(b.dataset.id);
    return b;
  }

  function updateSessionRow(node, { s, now, selection }) {
    const f = node.fields;
    const agents = s.agents || [];
    const running = agents.filter((a) => a.state === 'running').length;
    const pct = s.contextPct == null ? null : Math.max(0, Math.min(100, Math.round(s.contextPct)));
    const on = Boolean(selection && selection.sessionId === s.id);
    node.dataset.id = s.id;
    setClass(node, `srow${on ? ' on' : ''}${s.alive ? '' : ' dead'}`);
    // Clicking a selected row clears the selection, so the row is a toggle and
    // has to say so: the 3 px accent border is not audible.
    setAttr(node, 'aria-pressed', on ? 'true' : 'false');
    setText(f.nm, sessionName(s));
    setText(f.chip, modelChip(s.model));
    setText(f.age, s.alive ? elapsed(s.startedAt, now) : 'ended');
    setText(f.cwd, cwdTail(s.cwd));
    // A health bar drains: the fill is what is left, not what is spent, and a
    // context nobody knows draws no bar rather than an empty one.
    const left = contextRemaining(pct);
    f.bar.title = `context ${pct == null ? 'unknown' : `${pct}% used`}`;
    f.bar.hidden = left == null;
    setClass(f.fill, healthColor(pct));
    const width = `${left == null ? 0 : left}%`;
    if (f.fill.style.width !== width) f.fill.style.width = width;
    setText(f.ctx, `ctx ${pct == null ? '–' : `${pct}%`}`);
    setText(f.cost, fmtUsd(sessionCost(s)));
    setText(f.tok, `${fmtTokens(totalTokens(s.tokens))} tok`);
    setText(f.ag, `${running}/${agents.length} agents`);
  }

  function renderSessions(model) {
    const { v, now, selection, showEnded, connected } = model;
    const byAge = (a, b) => (b.startedAt || 0) - (a.startedAt || 0);
    const all = v.sessions || [];
    const live = all.filter((s) => s.alive).sort(byAge);
    const ended = all.filter((s) => !s.alive).sort(byAge);

    // `~/.claude` keeps every transcript ever written, so this machine offers
    // ninety finished sessions against three live ones. Listing them all buries
    // the feed and the detail under a wall of ended rows; they stay one click
    // away instead, and the selected one is shown whichever list it is in.
    const openEnded = ended.filter((s) => showEnded || (selection && selection.sessionId === s.id));
    const sessions = live.concat(openEnded);

    setText($('c-sessions'), showEnded ? String(all.length) : `${live.length} live`);
    const toggle = $('dead-toggle');
    toggle.hidden = ended.length === 0;
    setAttr(toggle, 'aria-pressed', showEnded ? 'true' : 'false');
    setText(toggle, showEnded ? `Hide ${ended.length} finished` : `Show ${ended.length} finished`);

    const box = $('sessions');
    syncRows(
      box,
      sessions.map((s) => ({ s, now, selection })),
      (item) => item.s.id,
      createSessionRow,
      updateSessionRow,
    );
    if (!sessions.length) emptyRow(box, connected ? 'no sessions yet' : 'not connected');
  }

  // -------------------------------------------------------- happening now

  function createNowRow() {
    const d = el('div', 'nrow');
    const l1 = el('div', 'l1', d);
    const f = {
      // The dot says running or idle in colour; the row says it again in words
      // one column over, so there is nothing here for a screen reader to read.
      dot: el('span', 'dot', l1),
      who: el('span', 'who', l1),
      chip: el('span', 'chip', l1),
      sess: el('span', 'el', l1),
      age: el('span', 'el', l1),
    };
    f.dot.setAttribute('aria-hidden', 'true');
    const l2 = el('div', 'l2', d);
    f.tool = el('span', 't2', l2);
    f.sm = el('span', 's2', l2);
    d.fields = f;
    return d;
  }

  function updateNowRow(node, { s, a, now, scoped }) {
    const f = node.fields;
    const run = a.state === 'running';
    const tool = run ? a.tool : null;
    setClass(f.dot, `dot ${run ? 'run' : 'idle'}`);
    setText(f.who, agentLabel(a));
    setText(f.chip, modelChip(a.model || s.model));
    // With one session selected every row belongs to it, so naming it on every
    // line is noise; across all sessions it is the only way to tell them apart.
    f.sess.hidden = scoped;
    setText(f.sess, scoped ? '' : sessionName(s));
    setText(f.age, elapsed(tool ? tool.since || 0 : a.startedAt || 0, now));
    setClass(f.tool, tool ? 't2' : 't2 g');
    setText(f.tool, tool ? tool.name : (a.state || 'idle'));
    setText(f.sm, tool && tool.summary ? ` · ${tool.summary}` : '');
  }

  function renderNow(model) {
    const { v, now, selection, replay } = model;
    const scoped = Boolean(selection);
    const sessions = (v.sessions || []).filter((s) => !selection || s.id === selection.sessionId);
    const all = [];
    for (const s of sessions) {
      if (!s.alive && !replay) continue;
      for (const a of s.agents || []) {
        if (a.state === 'done') continue;
        all.push({ s, a, now, scoped });
      }
    }
    // A long session leaves scores of finished-but-not-reaped subagents sitting
    // idle. They are not "what is happening", so whoever is holding a tool sorts
    // to the top and the idle tail is counted rather than listed.
    const running = all.filter((r) => r.a.state === 'running')
      .sort((x, y) => ((y.a.tool && y.a.tool.since) || 0) - ((x.a.tool && x.a.tool.since) || 0));
    const idle = all.filter((r) => r.a.state !== 'running')
      .sort((x, y) => (y.a.startedAt || 0) - (x.a.startedAt || 0));
    const rows = running.slice(0, NOW_RUNNING_CAP).concat(idle.slice(0, NOW_IDLE_CAP));
    const hidden = all.length - rows.length;

    setText($('c-now'), `${running.length} running · ${idle.length} idle`);
    const box = $('now');
    syncRows(box, rows, (r) => `${r.s.id}/${r.a.id}`, createNowRow, updateNowRow);
    if (!rows.length) emptyRow(box, selection ? 'this session has no running agent' : 'nothing running');
    else if (hidden > 0) emptyRow(box, `+${hidden} more idle agent${hidden === 1 ? '' : 's'}`);
  }

  // ------------------------------------------------------------------- feed

  function createFeedRow() {
    const d = el('div', 'frow');
    const hd = el('div', 'hd', d);
    const f = {
      ts: el('span', 'ts', hd),
      sn: el('span', 'sn', hd),
      ag: el('span', 'ag', hd),
    };
    const bd = el('div', 'bd', d);
    f.tl = el('span', 'tl', bd);
    f.sm = el('span', 'sm', bd);
    d.fields = f;
    return d;
  }

  function updateFeedRow(node, r) {
    const f = node.fields;
    setClass(node, `frow ${r.cls}`);
    setText(f.ts, hhmmss(r.ts));
    setText(f.sn, r.sn);
    f.ag.hidden = !r.ag;
    setText(f.ag, r.ag || '');
    setText(f.tl, shortTool(r.tool));
    setText(f.sm, r.sm);
  }

  function renderFeed(model) {
    const rows = model.feedRows;
    setText($('c-feed'), String(rows.length));
    const box = $('feed');
    // Newest is on top, so "pinned" means scrolled to zero. When the reader has
    // scrolled down to something older, the view is held over that line instead
    // of letting the new rows above shove it away — which costs two layout
    // reads around the write. Pinned, the common case, needs neither, and
    // deltas arrive several times a second over two hundred rows.
    if (feedPinned) {
      syncRows(box, rows, (r) => r.key, createFeedRow, updateFeedRow);
      if (!rows.length) emptyRow(box, 'waiting for activity…');
      box.scrollTop = 0;
    } else {
      const at = box.scrollTop;
      const before = box.scrollHeight;
      syncRows(box, rows, (r) => r.key, createFeedRow, updateFeedRow);
      if (!rows.length) emptyRow(box, 'waiting for activity…');
      box.scrollTop = at + (box.scrollHeight - before);
    }
    $('feed-pin').hidden = feedPinned;
  }

  // ----------------------------------------------------------------- detail

  function tokenTable(t) {
    const rows = [['input', t.input], ['output', t.output], ['cache read', t.cacheRead], ['cache write', t.cacheWrite], ['thinking', t.thinking]];
    return `<table>${rows.map(([k, val]) => `<tr><td>${k}</td><td>${esc(fmtTokens(val))}</td></tr>`).join('')}
      <tr><td>cost</td><td class="big">${esc(fmtUsd(t.costUsd))}</td></tr></table>`;
  }

  function list(items, emptyText) {
    return `<ul>${items.length ? items.join('') : `<li class="g">${esc(emptyText)}</li>`}</ul>`;
  }

  function detailHtml(s, agent, now, replay) {
    if (agent) {
      const tools = (s.tools || []).filter((t) => t.agentId === agent.id).slice(-40).reverse();
      return `<h3>${esc(agentLabel(agent))}</h3>
        <div class="sub">${esc(sessionName(s))} · ${esc(agent.model || s.model || '?')} · ${esc(agent.state || 'idle')}${agent.tool ? ` · ${esc(agent.tool.name)}` : ''}</div>
        <div class="lbl">tokens</div>${tokenTable(agent.tokens || {})}
        <div class="lbl">tool log · ${tools.length}</div>
        ${list(tools.map((t) => `<li><span class="t">${esc(hhmmss(t.startedAt))}</span>${esc(t.name)} <span class="t">${esc(t.summary || '')}</span>${t.endedAt ? '' : ' …'}</li>`), 'no tools yet')}`;
    }
    const procs = (s.procs || []).slice(0, 20);
    const prompts = (s.prompts || []).slice(-8).reverse();
    const hooks = (s.hookLog || []).slice(-24).reverse();
    return `<h3>${esc(sessionName(s))}</h3>
      <div class="sub">${esc(s.cwd || '')}</div>
      <div class="sub">${esc(s.model || '?')} · ${s.alive ? 'alive' : 'finished'} · ctx ${s.contextPct == null ? '–' : `${esc(Math.round(s.contextPct))}%`} · up ${esc(elapsed(s.startedAt, now))}</div>
      <div class="lbl">tokens</div>${tokenTable(s.tokens || {})}
      <div class="lbl">agents · ${(s.agents || []).length}</div>
      ${list((s.agents || []).map((a) => `<li><b>${esc(agentLabel(a))}</b> <span class="t">${esc(modelChip(a.model || s.model))}</span> ${esc(a.state || 'idle')}${a.tool ? ` · ${esc(a.tool.name)} ${esc(a.tool.summary || '')}` : ''}</li>`), 'no agents')}
      <div class="lbl">processes · ${procs.length}</div>
      ${list(procs.map((p) => `<li><span class="t">${esc(p.pid)}</span>${esc(p.name)} <span class="t">${esc(String(p.cmd || '').slice(0, 90))}</span></li>`), 'none seen')}
      <div class="lbl">prompts · ${(s.prompts || []).length}</div>
      ${list(prompts.map((p) => `<li><span class="t">${esc(hhmmss(p.ts))}</span>${esc(String(p.text || '').slice(0, 160))}</li>`), 'none recorded')}
      <div class="lbl">guard &amp; hooks · ${(s.hookLog || []).length}</div>
      ${list(hooks.map((h) => (h.kind === 'guard'
        ? `<li class="${h.mode === 'block' ? 'block' : 'warn'}"><span class="t">${esc(hhmmss(h.ts))}</span>shield ${esc(h.mode || '')} ${esc(h.rule || '')} ${esc(h.tool || '')}</li>`
        : `<li><span class="t">${esc(hhmmss(h.ts))}</span>${esc(h.event || 'hook')} ${esc(h.tool || '')}</li>`)), 'no hooks installed')}
      ${!s.alive && !replay ? '<div class="act"><button id="do-replay" type="button">Replay session</button></div>' : ''}`;
  }

  function renderDetail(model) {
    const { v, now, selection, replay } = model;
    const sec = $('sec-detail');
    const s = selection ? (v.sessions || []).find((x) => x.id === selection.sessionId) : null;
    if (!s) {
      sec.hidden = true;
      if (detailSig !== null) { $('detail').textContent = ''; detailSig = null; }
      return;
    }
    sec.hidden = false;
    const agent = selection.type === 'agent' ? (s.agents || []).find((a) => a.id === selection.agentId) : null;
    const html = detailHtml(s, agent, now, replay);
    // The detail is the one block still built as markup, so it is rebuilt only
    // when it would actually differ. Without this every delta would drop the
    // reader's text selection inside the tool log.
    if (html === detailSig) return;
    detailSig = html;
    $('detail').innerHTML = html;
    const rb = $('do-replay');
    if (rb) rb.onclick = () => handlers.replay(s.id);
  }

  // -------------------------------------------------------- head and strip

  function renderHead(model) {
    const t = model.v.totals || {};
    setText($('n-sessions'), t.sessionsAlive ?? 0);
    setText($('n-agents'), t.agentsRunning ?? 0);
    setText($('n-rate'), model.rateText);
    setText($('n-cost'), fmtUsdShort((t.tokens || {}).costUsd));
    setText($('head-sub'), model.replay
      ? `replaying ${model.replayName}`
      : (model.connected ? 'live from ~/.claude' : 'reconnecting…'));
  }

  function renderStrip(model) {
    const t = (model.v.totals || {}).tokens || {};
    setText($('t-tokens'), fmtTokens(totalTokens(t)));
    setText($('t-cost'), fmtUsd(t.costUsd));
    const errs = model.parseErrors ?? 0;
    setText($('t-errs'), String(errs));
    $('t-errs-wrap').classList.toggle('hot', errs > 0);
  }

  return {
    render(model) {
      renderHead(model);
      renderSessions(model);
      renderNow(model);
      renderFeed(model);
      renderDetail(model);
      renderStrip(model);
    },
    /** The once-a-second tick only moves clocks and the burn rate. */
    renderTick(model) {
      renderHead(model);
      renderNow(model);
    },
  };
}
