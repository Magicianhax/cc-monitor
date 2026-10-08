// Pure helpers for the Phaser city: isometric geometry, camera fit, lot
// bookkeeping, road circuits and string trimming.
//
// No imports and no DOM, so test/game-util.test.mjs can run the same file in
// node. Anything that touches Phaser lives in city-scene.mjs instead.

export const TILE_W = 64;
export const TILE_H = 32;

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * The x a Phaser isometric layer must sit at for the westernmost tile (0, h-1)
 * to start at world x 0, so camera bounds can be a plain rectangle.
 */
export function layerOriginX(mapH, tileW = TILE_W) {
  return (mapH - 1) * (tileW / 2);
}

/** The whole map's bounding box in world pixels. */
export function worldSize(mapW, mapH, tileW = TILE_W, tileH = TILE_H) {
  return { w: (mapW + mapH) * (tileW / 2), h: (mapW + mapH) * (tileH / 2) };
}

/**
 * The centre of tile tx,ty in world pixels.
 *
 * Phaser's IsometricTileToWorldXY returns the top-left of the tile's 64x32
 * image; the diamond fills that image, so its centre is half a tile further
 * along both axes. Fractional tile coordinates are allowed, which is how a
 * multi-tile lot finds its middle.
 */
export function tileCenter(tx, ty, ox = 0, oy = 0, tileW = TILE_W, tileH = TILE_H) {
  return {
    x: ox + (tx - ty) * (tileW / 2) + tileW / 2,
    y: oy + (tx + ty) * (tileH / 2) + tileH / 2,
  };
}

/** The tile under a world point, as floats; floor them for a tile index. */
export function worldToTile(wx, wy, ox = 0, oy = 0, tileW = TILE_W, tileH = TILE_H) {
  const x = (wx - ox - tileW / 2) / (tileW / 2);
  const y = (wy - oy - tileH / 2) / (tileH / 2);
  return { tx: (y + x) / 2, ty: (y - x) / 2 };
}

/**
 * Where a building sprite stands.
 *
 * `x`/`y` anchor an origin-(0.5, 1) image on the south corner of the lot so the
 * building sits on its whole footprint. `depth` is the lot's *centre* row, not
 * that south corner: a citizen standing on the door tile shares the south
 * corner's screen row, and sorting on the centre is what puts them in front of
 * the wall rather than behind it.
 */
export function footprint(lot, ox = 0, oy = 0, tileW = TILE_W, tileH = TILE_H) {
  const mid = tileCenter(lot.tx + (lot.w - 1) / 2, lot.ty + (lot.h - 1) / 2, ox, oy, tileW, tileH);
  const south = tileCenter(lot.tx + lot.w - 1, lot.ty + lot.h - 1, ox, oy, tileW, tileH);
  return { x: mid.x, y: south.y + tileH / 2, depth: mid.y };
}

/** The zoom that fits worldW x worldH into viewW x viewH. */
export function fitZoom(viewW, viewH, worldW, worldH, min = 0.3, max = 4) {
  if (!(viewW > 0) || !(viewH > 0) || !(worldW > 0) || !(worldH > 0)) return 1;
  return clamp(Math.min(viewW / worldW, viewH / worldH), min, max);
}

/** "…" keeps a label one line; n counts the ellipsis. */
export function truncate(s, n) {
  const str = String(s == null ? '' : s);
  if (n <= 0) return '';
  return str.length <= n ? str : str.slice(0, n - 1) + '…';
}

/** The last `n` segments of a path, in the separator the caller reads best. */
export function cwdTail(cwd, n = 2) {
  const parts = String(cwd || '').split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return '';
  return parts.slice(-n).join('/');
}

/**
 * Which house lot each session lives in.
 *
 * An assignment sticks for as long as the session is in the snapshot, so a
 * citizen never teleports to another street. New sessions fill the lowest free
 * lot, alive ones first and older ones before younger.
 */
export function assignLots(sessions, prev = new Map(), lotCount = 12) {
  const next = new Map();
  const taken = new Set();
  for (const s of sessions) {
    const at = prev.get(s.id);
    if (at === undefined || at >= lotCount || taken.has(at)) continue;
    next.set(s.id, at);
    taken.add(at);
  }
  const waiting = sessions
    .filter((s) => !next.has(s.id))
    .sort((a, b) => (Number(Boolean(b.alive)) - Number(Boolean(a.alive)))
      || ((a.startedAt || 0) - (b.startedAt || 0))
      || String(a.id).localeCompare(String(b.id)));
  let free = 0;
  for (const s of waiting) {
    while (free < lotCount && taken.has(free)) free++;
    if (free >= lotCount) break;
    next.set(s.id, free);
    taken.add(free);
  }
  return next;
}

/** Characters a citizen's plate line holds, per DESIGN.md. */
export const PLATE_CHARS = 28;
/** At most this many finished sessions keep a house, as a memorial row. */
export const FINISHED_HOUSES = 2;
/** An idle agent stays in the city this long after its last tool ended. */
export const IDLE_WINDOW_MS = 10 * 60 * 1000;
/** Idle agents one session may rest in the park at once. */
export const IDLE_CITIZENS = 4;

/**
 * What to call a session on a sign.
 *
 * The real store has sessions with no name at all, and a raw uuid on a house
 * plate next to named neighbours reads like a bug. The working directory is
 * what the person actually recognises, so it comes first; the id is the last
 * resort and is cut short enough to fit the sign.
 */
export function sessionLabel(session) {
  const name = String((session && session.name) || '').trim();
  if (name) return name;
  const tail = cwdTail(session && session.cwd, 1);
  if (tail) return tail;
  const id = String((session && session.id) || '').trim();
  return id ? id.slice(0, 8) : 'session';
}

/**
 * Whether a citizen's name plate is *asked for*.
 *
 * A working citizen always says what it is running: that is the whole point of
 * the city. An idle one does not, because the park holds a dozen of them and a
 * dozen plates four tiles apart overlap into a wall of text. Point at one, or
 * select its session in the panel, and it speaks up.
 *
 * Saying yes here only puts the plate into `layoutPlates`, which is what
 * decides whether it can be drawn without landing on top of another one.
 */
export function plateVisible({ state, hovered, selected } = {}) {
  if (state === 'running') return true;
  return Boolean(hovered) || Boolean(selected);
}

/** Plate priorities: higher is placed first and is never the one hidden. */
export const PLATE_PRIORITY = { fixed: 4, hovered: 3, running: 2, asked: 1 };

/**
 * Stop name plates from landing on top of each other.
 *
 * Every plate wants to hang directly over its owner's head, and at the density
 * this actually runs at — eight agents round one door, a building plate right
 * behind them — that piles four or five plates into one unreadable block. This
 * is the de-collision pass, run once a frame over the plates that are currently
 * asked for.
 *
 * A box is `{ key, x, y, w, h, priority, fixed }`, where `x` is the plate's
 * centre and `y` its *bottom* edge (plates hang upwards, like the labels do),
 * all in world pixels at the label's current scale. `fixed` boxes — buildings
 * and house signs — are obstacles: they are placed first, never lifted and
 * never hidden.
 *
 * Boxes are placed highest priority first and, within one priority, nearest the
 * camera first, so a walking agent never loses its plate to a resting one. A
 * plate that intersects something already placed is pushed up a whole plate
 * height plus `gap`, up to `maxStacks` times; one that still does not fit is
 * hidden, and because of the ordering the hidden one is always the least
 * interesting plate in that pile.
 *
 * Returns one `{ key, lift, visible }` per input box, in input order.
 */
export function layoutPlates(boxes, { gap = 2, maxStacks = 3 } = {}) {
  const list = Array.isArray(boxes) ? boxes : [];
  const order = list.map((b, i) => ({ b, i }));
  order.sort((p, q) => (prioOf(q.b) - prioOf(p.b))
    || ((Number(q.b.y) || 0) - (Number(p.b.y) || 0))
    || (p.i - q.i));

  const placed = [];
  const out = new Array(list.length);
  for (const { b, i } of order) {
    const w = Math.max(0, Number(b.w) || 0);
    const h = Math.max(0, Number(b.h) || 0);
    const x = Number(b.x) || 0;
    const y = Number(b.y) || 0;
    const rect = { left: x - w / 2, right: x + w / 2, top: y - h, bottom: y };
    if (b.fixed) {
      placed.push(rect);
      out[i] = { key: b.key, lift: 0, visible: true };
      continue;
    }
    let lift = null;
    for (let stack = 0; stack <= maxStacks; stack++) {
      const up = stack * (h + gap);
      const at = { left: rect.left, right: rect.right, top: rect.top - up, bottom: rect.bottom - up };
      if (!placed.some((p) => overlaps(p, at))) { lift = up; placed.push(at); break; }
    }
    out[i] = lift === null
      ? { key: b.key, lift: 0, visible: false }
      : { key: b.key, lift, visible: true };
  }
  return out;
}

function prioOf(b) {
  if (b && b.fixed) return PLATE_PRIORITY.fixed;
  const p = Number(b && b.priority);
  return Number.isFinite(p) ? p : PLATE_PRIORITY.asked;
}

/** Two plate rectangles sharing any area. Touching edges do not count. */
function overlaps(a, b) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * The lines above a citizen's head.
 *
 * A working citizen says what it is running; an idle one says only who it is.
 * Idle agents gather in the park, and a second line reading "idle" on every one
 * of them was a wall of text that said nothing.
 */
export function citizenPlate(session, agent) {
  const who = (agent && agent.label) || (agent && agent.kind === 'main' ? 'main' : (agent && agent.id)) || 'agent';
  // 28 characters including the ellipsis, the width DESIGN.md gives a plate.
  const head = truncate(`${sessionLabel(session)} · ${who}`, PLATE_CHARS);
  const tool = agent && agent.state === 'running' ? agent.tool : null;
  if (!tool || !tool.name) return [head];
  const detail = `${tool.name}${tool.summary ? ` · ${truncate(tool.summary, 24)}` : ''}`;
  return [head, truncate(detail, PLATE_CHARS)];
}

/**
 * When an agent last did anything, in wall-clock ms.
 *
 * A running agent is doing something now, so its current tool's start is the
 * answer. Otherwise the newest tool call it closed, and failing that the moment
 * it was created, which is all a freshly spawned agent has.
 */
export function lastActiveAt(session, agent) {
  if (!agent) return 0;
  if (agent.state === 'running' && agent.tool && agent.tool.since) return Number(agent.tool.since) || 0;
  let newest = 0;
  for (const t of (session && session.tools) || []) {
    if (t.agentId !== agent.id) continue;
    const at = Number(t.endedAt || t.startedAt) || 0;
    if (at > newest) newest = at;
  }
  if (newest) return newest;
  return Number(agent.startedAt) || Number(session && session.startedAt) || 0;
}

/**
 * Which sessions get a house.
 *
 * Against a real ~/.claude this is the difference between a city and a
 * graveyard: 3 live sessions next to 88 finished ones filled every lot with
 * "stopped $0.00" plates. Live sessions come first, oldest first so that the
 * newest wait rather than evicting a neighbour mid-run, and at most
 * FINISHED_HOUSES recently finished sessions fill whatever is left.
 */
export function pickHouses(sessions, now, max = 12) {
  const all = Array.isArray(sessions) ? sessions : [];
  const byId = (a, b) => String(a.id).localeCompare(String(b.id));
  const live = all
    .filter((s) => s && s.alive)
    .sort((a, b) => (Number(a.startedAt) || 0) - (Number(b.startedAt) || 0) || byId(a, b));
  const housed = live.slice(0, Math.max(0, max));

  const room = Math.min(max - housed.length, FINISHED_HOUSES);
  if (room > 0) {
    const ended = (s) => Number(s.lastSeenAt || s.startedAt) || 0;
    const finished = all
      .filter((s) => s && !s.alive)
      .sort((a, b) => ended(b) - ended(a) || byId(a, b));
    housed.push(...finished.slice(0, room));
  }
  return housed;
}

/**
 * Which of a session's agents walk the streets.
 *
 * Every running agent up to `max`, then at most `idleMax` agents that have gone
 * quiet recently, newest first. The real store had 162 idle agents on one
 * session; work is what the city is for, so running agents take the room first
 * and the idle crowd gets a small share of what is left. A finished agent never
 * spawns, and the panel still lists everyone.
 */
export function pickCitizens(session, now, max = 8, window = IDLE_WINDOW_MS, idleMax = IDLE_CITIZENS) {
  const agents = (session && session.agents) || [];
  const running = [];
  const idle = [];
  for (const a of agents) {
    if (!a || a.state === 'done') continue;
    const at = lastActiveAt(session, a);
    if (a.state === 'running') running.push({ a, at });
    else if (now - at <= window) idle.push({ a, at });
  }
  const newestFirst = (x, y) => y.at - x.at || String(x.a.id).localeCompare(String(y.a.id));
  running.sort(newestFirst);
  idle.sort(newestFirst);

  const taken = running.slice(0, Math.max(0, max));
  const room = Math.min(Math.max(0, max) - taken.length, Math.max(0, idleMax));
  if (room > 0) taken.push(...idle.slice(0, room));
  return taken.map((e) => e.a);
}

/**
 * The order the twelve house lots fill up.
 *
 * Straight 0,1,2 would park three sessions shoulder to shoulder at one end of
 * the promenade with their signs on top of each other. Taking the ends first
 * and then halving what is left keeps any small number of sessions spread down
 * the street.
 */
export function spreadOrder(n) {
  const out = [];
  if (!(n > 0)) return out;
  const taken = new Array(n).fill(false);
  const pick = (v) => { if (v >= 0 && v < n && !taken[v]) { taken[v] = true; out.push(v); } };
  const split = (lo, hi) => {
    if (lo > hi) return;
    const mid = Math.floor((lo + hi) / 2);
    pick(mid);
    split(lo, mid - 1);
    split(mid + 1, hi);
  };
  pick(0);
  pick(n - 1);
  split(1, n - 2);
  for (let i = 0; i < n; i++) pick(i);
  return out;
}

/** The perimeter of a tile rectangle, clockwise, each corner listed once. */
export function rectLoop(x0, y0, x1, y1) {
  const out = [];
  for (let x = x0; x < x1; x++) out.push({ x, y: y0 });
  for (let y = y0; y < y1; y++) out.push({ x: x1, y });
  for (let x = x1; x > x0; x--) out.push({ x, y: y1 });
  for (let y = y1; y > y0; y--) out.push({ x: x0, y });
  return out;
}

/**
 * Closed circuits a car can drive for ever.
 *
 * The city is a grid of streets, so every block bounded by two through streets
 * and two through avenues is a loop. A row counts as a street when most of it
 * is road; a column counts as an avenue on a long unbroken run, which is what
 * separates the three avenues from the single road tile every kerb row holds.
 */
export function roadLoops(tiles, isRoad = (name) => name === 'road') {
  if (!tiles || !tiles.length) return [];
  const h = tiles.length;
  const w = tiles[0].length;
  const longestRun = (read) => {
    let run = 0;
    let best = 0;
    for (let i = 0; i < read.length; i++) {
      run = read[i] ? run + 1 : 0;
      if (run > best) best = run;
    }
    return best;
  };

  const rows = [];
  for (let ty = 0; ty < h; ty++) {
    const read = [];
    for (let tx = 0; tx < w; tx++) read.push(isRoad(tiles[ty][tx]));
    if (longestRun(read) >= w * 0.6) rows.push(ty);
  }
  const cols = [];
  for (let tx = 0; tx < w; tx++) {
    const read = [];
    for (let ty = 0; ty < h; ty++) read.push(isRoad(tiles[ty][tx]));
    if (longestRun(read) >= 8) cols.push(tx);
  }

  const loops = [];
  for (let r = 0; r + 1 < rows.length; r++) {
    for (let c = 0; c + 1 < cols.length; c++) {
      const loop = rectLoop(cols[c], rows[r], cols[c + 1], rows[r + 1]);
      // A block too small to drive round (two crossing boulevards leave a
      // 2x2 square of road) would spin a car on the spot.
      if (loop.length >= 8 && loop.every((p) => isRoad(tiles[p.y][p.x]))) loops.push(loop);
    }
  }
  return loops;
}

/**
 * Which way a vehicle or walker faces.
 *
 * On screen +tx leaves through the lower-right edge and +ty through the
 * lower-left, so the two sprite axes are `nw` (the tx axis) and `ne` (the ty
 * axis), each mirrored for the way back.
 */
/**
 * frame name -> the atlas key that carries it, across every sheet that loaded.
 *
 * This is what keeps the map data-driven: the scene draws a `buildings` or
 * `props` object by looking its own name up here, so new art needs no code.
 *
 * A sheet is `{ key, frames }`, where `frames` is either the Phaser JSONHash
 * atlas's own frames object or a plain list of names, or `{ key, json }` for
 * the whole atlas. Earlier sheets win a duplicate name, so the caller's order
 * is the lookup order; every collision is returned in `duplicates` so a sheet
 * that shadows another can be found without reading both JSONs.
 */
export function buildFrameIndex(sheets) {
  const index = new Map();
  const duplicates = [];
  for (const sheet of sheets || []) {
    if (!sheet || !sheet.key) continue;
    const from = sheet.frames || (sheet.json && sheet.json.frames);
    const names = Array.isArray(from) ? from : Object.keys(from || {});
    for (const name of names) {
      if (index.has(name)) duplicates.push({ name, kept: index.get(name), skipped: sheet.key });
      else index.set(name, sheet.key);
    }
  }
  return { index, duplicates };
}

/**
 * Where each of `count` citizens stands when they share a doorstep.
 *
 * Offsets are centred on the door, so one citizen stands on it and two stand
 * half a gap either side.
 */
export function slotOffsets(count, gap = 26) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(Math.round((i - (count - 1) / 2) * gap));
  return out;
}

/**
 * Compass heading of a one-tile step, which is also the vehicle frame suffix.
 *
 * On screen +tx leaves through the lower-right edge (south-east) and +ty
 * through the lower-left (south-west). A mirrored sprite would swap the
 * diagonal rather than reverse along it, so every heading has its own frame.
 */
export function vehicleFacing(dtx, dty) {
  if (dtx > 0) return 'se';
  if (dtx < 0) return 'nw';
  if (dty > 0) return 'sw';
  return 'ne';
}

const OPPOSITE = { se: 'nw', nw: 'se', sw: 'ne', ne: 'sw' };

/**
 * Screen offset that puts a vehicle in the right-hand lane of its street.
 *
 * The right-hand side of a step (dtx, dty) is the tile vector (-dty, dtx);
 * `share` is how far across the tile, as a fraction, the lane sits.
 */
export function laneOffset(dtx, dty, share = 0.22, tileW = TILE_W, tileH = TILE_H) {
  const a = -Math.sign(dty) * share;
  const b = Math.sign(dtx) * share;
  return { x: Math.round((a - b) * (tileW / 2)), y: Math.round((a + b) * (tileH / 2)) };
}

/**
 * Whether car `id` heading `facing` may drive onto a tile.
 *
 * `holders` is the tile's Map of car id -> facing. Oncoming traffic is in the
 * other lane, so only a car facing the same way or crossing blocks the tile.
 */
export function canEnter(holders, id, facing) {
  if (!holders) return true;
  for (const [other, f] of holders) {
    if (other === id) continue;
    if (f !== OPPOSITE[facing]) return false;
  }
  return true;
}

/** Index of the entry nearest `from` by tile distance, or -1 for an empty list. */
export function nearestIndex(from, list) {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < list.length; i++) {
    const d = Math.abs(list[i].tx - from.tx) + Math.abs(list[i].ty - from.ty);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** What `update()` has to create and destroy to catch a Map up with a list. */
export function diffKeys(prev, items, keyOf) {
  const keys = new Set(items.map(keyOf));
  const added = items.filter((it) => !prev.has(keyOf(it)));
  const removed = [];
  for (const k of prev.keys()) if (!keys.has(k)) removed.push(k);
  return { added, removed };
}

/** The pose a citizen strikes once it arrives at a building. */
const WORK_POSE = {
  forge: 'work_hammer',
  library: 'work_read',
  school: 'work_read',
  server_hall: 'work_terminal',
  radio_tower: 'work_radio',
  town_hall: 'work_flag',
  fountain: 'sit',
};

export function poseFor(buildingKey) {
  return WORK_POSE[buildingKey] || 'idle_side';
}

/** A destructive shell command sends its citizen to the nearest tree. */
export function isChopping(tool) {
  if (!tool || !/^(Bash|PowerShell)$/.test(tool.name || '')) return false;
  return /\b(rm|del|Remove-Item)\b/.test(String(tool.summary || ''));
}
