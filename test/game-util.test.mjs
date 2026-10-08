import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assignLots, buildFrameIndex, citizenPlate, clamp, cwdTail, diffKeys, fitZoom, footprint,
  canEnter, IDLE_CITIZENS, IDLE_WINDOW_MS, isChopping, laneOffset, lastActiveAt, layerOriginX, vehicleFacing,
  layoutPlates, nearestIndex, pickCitizens, pickHouses, PLATE_PRIORITY, plateVisible, poseFor,
  rectLoop, roadLoops, sessionLabel, slotOffsets, spreadOrder, tileCenter, truncate, worldSize,
  worldToTile,
} from '../public/game/util.mjs';
import { LAYOUT, parseLayout } from '../lib/citymap.mjs';

test('clamp keeps a value inside its range', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(99, 0, 10), 10);
});

test('tileCenter matches Phaser isometric placement plus half a tile', () => {
  // Phaser draws tile tx,ty with its image top-left at ((tx-ty)*32, (tx+ty)*16).
  assert.deepEqual(tileCenter(0, 0), { x: 32, y: 16 });
  assert.deepEqual(tileCenter(1, 0), { x: 64, y: 32 });
  assert.deepEqual(tileCenter(0, 1), { x: 0, y: 32 });
  // +tx and +ty both go down the screen, and a step along each is half a tile.
  assert.deepEqual(tileCenter(1, 1), { x: 32, y: 48 });
});

test('tileCenter honours the layer offset', () => {
  const ox = layerOriginX(40);
  assert.equal(ox, 1248);
  // The westernmost tile of a 56x40 map starts the world at x 0.
  assert.equal(tileCenter(0, 39, ox).x - 32, 0);
});

test('worldToTile inverts tileCenter', () => {
  const ox = layerOriginX(40);
  for (const [tx, ty] of [[0, 0], [12, 7], [55, 39]]) {
    const c = tileCenter(tx, ty, ox);
    const back = worldToTile(c.x, c.y, ox);
    assert.ok(Math.abs(back.tx - tx) < 1e-9, `tx ${back.tx} != ${tx}`);
    assert.ok(Math.abs(back.ty - ty) < 1e-9, `ty ${back.ty} != ${ty}`);
  }
});

test('worldSize covers the whole isometric diamond', () => {
  assert.deepEqual(worldSize(56, 40), { w: 3072, h: 1536 });
});

test('footprint anchors on the south corner and sorts on the centre', () => {
  const lot = { tx: 3, ty: 14, w: 4, h: 4 };
  const f = footprint(lot);
  // South corner of tile (6,17): centre y 384, plus half a tile.
  assert.equal(f.y, 400);
  // Centre of the lot, which is the row it sorts against.
  assert.equal(f.depth, 336);
  // A citizen on the door tile (5,18) is in front of the wall, not behind it.
  assert.ok(tileCenter(5, 18).y > f.depth);
});

test('fitZoom picks the tighter axis and respects its bounds', () => {
  assert.equal(fitZoom(1920, 1080, 3072, 1536), 0.625);
  assert.equal(fitZoom(100, 100, 10000, 10000, 0.5, 4), 0.5);
  assert.equal(fitZoom(4000, 4000, 100, 100, 0.5, 4), 4);
  assert.equal(fitZoom(0, 0, 3072, 1536), 1);
});

test('truncate adds one ellipsis and never exceeds n', () => {
  assert.equal(truncate('short', 10), 'short');
  assert.equal(truncate('abcdefghij', 5), 'abcd…');
  assert.equal(truncate('abc', 0), '');
  assert.equal(truncate(null, 4), '');
});

test('cwdTail reads the last segments of either separator', () => {
  assert.equal(cwdTail('C:\\work\\claude-city\\feat-city'), 'claude-city/feat-city');
  assert.equal(cwdTail('/home/me/projects/app', 1), 'app');
  assert.equal(cwdTail(''), '');
});

test('assignLots keeps a session in its lot and fills gaps alive-first', () => {
  const sessions = [
    { id: 'old', alive: false, startedAt: 1 },
    { id: 'a', alive: true, startedAt: 30 },
    { id: 'b', alive: true, startedAt: 20 },
  ];
  const first = assignLots(sessions, new Map(), 12);
  assert.equal(first.get('b'), 0);
  assert.equal(first.get('a'), 1);
  assert.equal(first.get('old'), 2);

  // 'a' stays put even once it dies and a newcomer arrives.
  const later = assignLots(
    [{ id: 'a', alive: false, startedAt: 30 }, { id: 'c', alive: true, startedAt: 99 }],
    first,
    12,
  );
  assert.equal(later.get('a'), 1);
  assert.equal(later.get('c'), 0);
});

test('assignLots drops sessions past the last lot', () => {
  const many = Array.from({ length: 15 }, (_, i) => ({ id: `s${i}`, alive: true, startedAt: i }));
  const lots = assignLots(many, new Map(), 12);
  assert.equal(lots.size, 12);
  assert.equal(new Set(lots.values()).size, 12);
});

const NOW = 1_700_000_000_000;
const min = (n) => n * 60_000;

test('pickHouses houses every live session and only two finished ones', () => {
  const sessions = [
    { id: 'live-old', alive: true, startedAt: NOW - min(300) },
    { id: 'live-new', alive: true, startedAt: NOW - min(5) },
    { id: 'done-a', alive: false, startedAt: NOW - min(900), lastSeenAt: NOW - min(30) },
    { id: 'done-b', alive: false, startedAt: NOW - min(800), lastSeenAt: NOW - min(10) },
    { id: 'done-c', alive: false, startedAt: NOW - min(700), lastSeenAt: NOW - min(600) },
    { id: 'done-d', alive: false, startedAt: NOW - min(600), lastSeenAt: NOW - min(700) },
  ];
  const housed = pickHouses(sessions, NOW, 12).map((s) => s.id);
  // Both live sessions, then the two most recently finished, newest first.
  assert.deepEqual(housed, ['live-old', 'live-new', 'done-b', 'done-a']);
});

test('pickHouses never exceeds the lot count and makes the newest live session wait', () => {
  const sessions = Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, alive: true, startedAt: NOW - min(100 - i) }));
  sessions.push({ id: 'ghost', alive: false, startedAt: NOW - min(999), lastSeenAt: NOW - min(1) });
  const housed = pickHouses(sessions, NOW, 12);
  assert.equal(housed.length, 12);
  // Oldest twelve keep their lots; the newest wait, and no finished session
  // displaces a live one.
  assert.deepEqual(housed.map((s) => s.id), Array.from({ length: 12 }, (_, i) => `s${i}`));
  assert.equal(housed.some((s) => s.id === 'ghost'), false);
});

test('pickHouses copes with an empty or junk list', () => {
  assert.deepEqual(pickHouses([], NOW, 12), []);
  assert.deepEqual(pickHouses(undefined, NOW, 12), []);
  assert.deepEqual(pickHouses([{ id: 'a', alive: false, startedAt: NOW }], NOW, 0), []);
});

test('lastActiveAt prefers the running tool, then the newest closed tool, then birth', () => {
  const session = {
    startedAt: NOW - min(60),
    tools: [
      { agentId: 'a1', startedAt: NOW - min(30), endedAt: NOW - min(29) },
      { agentId: 'a1', startedAt: NOW - min(9), endedAt: NOW - min(8) },
      { agentId: 'a2', startedAt: NOW - min(2), endedAt: NOW - min(1) },
    ],
  };
  assert.equal(
    lastActiveAt(session, { id: 'a1', state: 'running', tool: { since: NOW - min(1) } }),
    NOW - min(1),
  );
  assert.equal(lastActiveAt(session, { id: 'a1', state: 'idle' }), NOW - min(8));
  assert.equal(lastActiveAt(session, { id: 'fresh', state: 'idle', startedAt: NOW - min(3) }), NOW - min(3));
  assert.equal(lastActiveAt(session, { id: 'bare', state: 'idle' }), NOW - min(60));
  assert.equal(lastActiveAt(session, null), 0);
});

test('pickCitizens takes every running agent and only recently idle ones', () => {
  const session = {
    startedAt: NOW - min(120),
    tools: [
      { agentId: 'idle-recent', startedAt: NOW - min(4), endedAt: NOW - min(3) },
      { agentId: 'idle-stale', startedAt: NOW - min(90), endedAt: NOW - min(80) },
    ],
    agents: [
      { id: 'run-1', state: 'running', tool: { since: NOW - min(1) } },
      { id: 'idle-recent', state: 'idle' },
      { id: 'idle-stale', state: 'idle' },
      { id: 'finished', state: 'done', startedAt: NOW - min(2) },
    ],
  };
  const ids = pickCitizens(session, NOW, 8).map((a) => a.id);
  assert.deepEqual(ids, ['run-1', 'idle-recent']);
  // The window is ten minutes: the stale one is eighty minutes cold.
  assert.equal(IDLE_WINDOW_MS, 600000);
});

test('pickCitizens caps idle separately so work always gets the room', () => {
  const agents = [];
  const tools = [];
  for (let i = 0; i < 3; i++) agents.push({ id: `run-${i}`, state: 'running', tool: { since: NOW - min(i) } });
  for (let i = 0; i < 40; i++) {
    agents.push({ id: `idle-${i}`, state: 'idle' });
    tools.push({ agentId: `idle-${i}`, startedAt: NOW - min(9), endedAt: NOW - min(i % 9) });
  }
  const session = { startedAt: NOW - min(200), tools, agents };

  const picked = pickCitizens(session, NOW, 8);
  // Three running plus the idle cap of four, not eight bodies in the park.
  assert.equal(picked.length, 3 + IDLE_CITIZENS);
  assert.deepEqual(picked.slice(0, 3).map((a) => a.id), ['run-0', 'run-1', 'run-2']);
  assert.ok(picked.slice(3).every((a) => a.id.startsWith('idle-')));
  assert.equal(IDLE_CITIZENS, 4);
});

test('pickCitizens lets running agents fill the whole allowance', () => {
  const agents = [];
  for (let i = 0; i < 12; i++) agents.push({ id: `run-${i}`, state: 'running', tool: { since: NOW - min(i) } });
  agents.push({ id: 'idle-1', state: 'idle', startedAt: NOW });
  const picked = pickCitizens({ startedAt: NOW - min(9), tools: [], agents }, NOW, 8);
  assert.equal(picked.length, 8);
  // No room left, so no idle agent gets in even though it is fresh.
  assert.ok(picked.every((a) => a.id.startsWith('run-')));
});

test('pickCitizens never spawns a finished agent and tolerates an empty session', () => {
  const done = { agents: [{ id: 'a', state: 'done', startedAt: NOW }], tools: [] };
  assert.deepEqual(pickCitizens(done, NOW, 8), []);
  assert.deepEqual(pickCitizens({}, NOW, 8), []);
  assert.deepEqual(pickCitizens(undefined, NOW, 8), []);
});

test('sessionLabel falls back from name to cwd tail to a short id', () => {
  assert.equal(sessionLabel({ name: 'shop-api', cwd: 'C:/work/shop', id: 'abc123' }), 'shop-api');
  assert.equal(sessionLabel({ name: '   ', cwd: 'C:/work/claude-city/feat-city', id: 'abc' }), 'feat-city');
  assert.equal(sessionLabel({ name: null, cwd: '', id: '0ea8cc94-696b-48a7-9917' }), '0ea8cc94');
  assert.equal(sessionLabel({}), 'session');
  assert.equal(sessionLabel(undefined), 'session');
});

test('citizenPlate names the tool when working and only the agent when idle', () => {
  const session = { name: 'claude-city', id: 's1' };
  assert.deepEqual(
    citizenPlate(session, { id: 'main', kind: 'main', state: 'running', tool: { name: 'Edit', summary: 'public/game/util.mjs' } }),
    ['claude-city · main', 'Edit · public/game/util.mjs'],
  );
  // Idle is one line: a park full of second lines reading "idle" says nothing.
  assert.deepEqual(citizenPlate(session, { id: 'impl-task-3', state: 'idle' }), ['claude-city · impl-task-3']);
  // A running agent between tools has nothing to report either.
  assert.deepEqual(citizenPlate(session, { id: 'a', label: 'doc-writer', state: 'running', tool: null }), ['claude-city · doc-writer']);
  // A tool with no summary still names itself.
  assert.deepEqual(
    citizenPlate(session, { id: 'a', label: 'x', state: 'running', tool: { name: 'Bash' } }),
    ['claude-city · x', 'Bash'],
  );
  // And the label follows the same nameless-session fallback as the house sign.
  assert.deepEqual(citizenPlate({ id: 'deadbeef-1111', cwd: '' }, { id: 'main', kind: 'main', state: 'idle' }), ['deadbeef · main']);
});

test('plateVisible always labels working citizens and only asked-for idle ones', () => {
  // Working: the label is the point of the city, so nothing turns it off.
  assert.equal(plateVisible({ state: 'running', hovered: false, selected: false }), true);
  assert.equal(plateVisible({ state: 'running', hovered: true, selected: true }), true);
  // Idle: silent until someone asks.
  assert.equal(plateVisible({ state: 'idle', hovered: false, selected: false }), false);
  assert.equal(plateVisible({ state: 'idle', hovered: true, selected: false }), true);
  assert.equal(plateVisible({ state: 'idle', hovered: false, selected: true }), true);
  assert.equal(plateVisible({ state: 'idle', hovered: true, selected: true }), true);
  // An unknown state is treated as idle rather than shouting by default.
  assert.equal(plateVisible({ state: 'done', hovered: false, selected: false }), false);
  assert.equal(plateVisible({}), false);
  assert.equal(plateVisible(), false);
});

// A plate is 120 x 20 world px, hanging from its bottom edge, like the real ones.
const plate = (key, x, y, extra = {}) => ({ key, x, y, w: 120, h: 20, ...extra });
const byKey = (out) => Object.fromEntries(out.map((r) => [r.key, r]));

test('layoutPlates leaves plates that do not touch exactly where they are', () => {
  const out = layoutPlates([plate('a', 0, 100), plate('b', 400, 100), plate('c', 0, 300)]);
  assert.deepEqual(out.map((r) => r.lift), [0, 0, 0]);
  assert.ok(out.every((r) => r.visible));
  // One entry per input box, in input order.
  assert.deepEqual(out.map((r) => r.key), ['a', 'b', 'c']);
});

test('layoutPlates stacks a colliding plate by its own height plus the gap', () => {
  // Two agents on one doorstep: same spot, same priority, so the nearer one
  // keeps the head position and the one behind it stacks above.
  const out = byKey(layoutPlates([plate('back', 0, 100), plate('front', 0, 110)]));
  assert.deepEqual(out.front, { key: 'front', lift: 0, visible: true });
  assert.deepEqual(out.back, { key: 'back', lift: 22, visible: true });
});

test('layoutPlates keeps stacking up to the cap and then hides the rest', () => {
  const boxes = [];
  for (let i = 0; i < 6; i++) boxes.push(plate(`p${i}`, 0, 100 + i));
  const out = byKey(layoutPlates(boxes));
  // Nearest the camera first: p5 keeps the head position, p4 .. p2 stack.
  assert.deepEqual([out.p5.lift, out.p4.lift, out.p3.lift, out.p2.lift], [0, 22, 44, 66]);
  // Three pushes is the cap, so the two furthest back drop out rather than
  // adding a fifth line of text to a tower nobody can read.
  assert.equal(out.p1.visible, false);
  assert.equal(out.p0.visible, false);
  assert.equal(out.p1.lift, 0);
});

test('layoutPlates hides the idle plate before the working one', () => {
  const out = byKey(layoutPlates([
    plate('idle', 0, 101, { priority: PLATE_PRIORITY.asked }),
    plate('running', 0, 100, { priority: PLATE_PRIORITY.running }),
  ], { maxStacks: 0 }));
  // The idle plate is nearer the camera, but work wins the head position.
  assert.equal(out.running.visible, true);
  assert.equal(out.running.lift, 0);
  assert.equal(out.idle.visible, false);
});

test('layoutPlates hovering a citizen beats everything but a building', () => {
  const out = byKey(layoutPlates([
    plate('running', 0, 100, { priority: PLATE_PRIORITY.running }),
    plate('hovered', 0, 101, { priority: PLATE_PRIORITY.hovered }),
    plate('sign', 0, 102, { fixed: true }),
  ], { maxStacks: 1 }));
  assert.deepEqual(out.sign, { key: 'sign', lift: 0, visible: true });
  assert.equal(out.hovered.lift, 22);
  assert.equal(out.running.visible, false);
});

test('layoutPlates treats buildings as obstacles it can never move or hide', () => {
  const out = byKey(layoutPlates([
    plate('house', 0, 100, { fixed: true }),
    plate('agent', 0, 100, { priority: PLATE_PRIORITY.running }),
  ]));
  assert.deepEqual(out.house, { key: 'house', lift: 0, visible: true });
  assert.equal(out.agent.lift, 22);
});

test('layoutPlates ignores a sliver of overlap only when boxes merely touch', () => {
  // Exactly side by side: 120 wide centred 120 apart share one edge and no area.
  assert.deepEqual(layoutPlates([plate('a', 0, 100), plate('b', 120, 100)]).map((r) => r.lift), [0, 0]);
  // One pixel closer and they overlap.
  assert.deepEqual(layoutPlates([plate('a', 0, 100), plate('b', 119, 100)]).map((r) => r.lift), [0, 22]);
});

test('layoutPlates survives an empty list and junk boxes', () => {
  assert.deepEqual(layoutPlates([]), []);
  assert.deepEqual(layoutPlates(), []);
  assert.deepEqual(layoutPlates(undefined), []);
  const out = layoutPlates([{ key: 'junk' }, plate('real', 0, 0)]);
  assert.equal(out.length, 2);
  assert.ok(out.every((r) => r.visible));
});

test('layoutPlates is stable: the same input gives the same answer', () => {
  const boxes = [plate('a', 0, 100), plate('b', 10, 100), plate('c', 20, 100)];
  assert.deepEqual(layoutPlates(boxes), layoutPlates(boxes));
});

test('spreadOrder is a permutation that keeps the first few lots apart', () => {
  const order = spreadOrder(12);
  assert.equal(order.length, 12);
  assert.deepEqual([...order].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const first = order.slice(0, 4);
  for (let i = 0; i < first.length; i++) {
    for (let j = i + 1; j < first.length; j++) {
      assert.ok(Math.abs(first[i] - first[j]) >= 2, `lots ${first[i]} and ${first[j]} are neighbours`);
    }
  }
  assert.deepEqual(spreadOrder(1), [0]);
  assert.deepEqual(spreadOrder(0), []);
});

test('rectLoop walks a closed perimeter once', () => {
  const loop = rectLoop(0, 0, 2, 2);
  assert.equal(loop.length, 8);
  assert.equal(new Set(loop.map((p) => `${p.x},${p.y}`)).size, 8);
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    assert.equal(Math.abs(a.x - b.x) + Math.abs(a.y - b.y), 1, `step ${i} is not one tile`);
  }
});

test('roadLoops finds a circuit round every city block and drives only on road', () => {
  const parsed = parseLayout(LAYOUT);
  const loops = roadLoops(parsed.tiles);
  // Four road rows and four road columns make nine blocks; the 2x2 square where
  // the boulevards cross is too small to drive round and is dropped.
  assert.equal(loops.length, 8);
  for (const loop of loops) {
    for (const p of loop) assert.equal(parsed.tiles[p.y][p.x], 'road');
  }
  assert.equal(loops.filter((l) => l.length > 20).length, 8);
});

test('roadLoops returns nothing for a map with no streets', () => {
  const tiles = Array.from({ length: 6 }, () => new Array(6).fill('grass'));
  assert.deepEqual(roadLoops(tiles), []);
  assert.deepEqual(roadLoops([]), []);
});

test('buildFrameIndex maps every frame of two atlas JSONs to its sheet', () => {
  // The shape tools/prep-art.mjs writes: Phaser "JSONHash", frames keyed by name.
  const civic = { frames: { library: { frame: {} }, forge: { frame: {} }, tree: { frame: {} } }, meta: {} };
  const extra = { frames: { cafe: { frame: {} }, bakery: { frame: {} }, tree: { frame: {} } }, meta: {} };
  const { index, duplicates } = buildFrameIndex([
    { key: 'city_civic_a', frames: civic.frames },
    { key: 'city_extra_a', frames: extra.frames },
  ]);

  assert.equal(index.get('library'), 'city_civic_a');
  assert.equal(index.get('forge'), 'city_civic_a');
  assert.equal(index.get('cafe'), 'city_extra_a');
  assert.equal(index.get('bakery'), 'city_extra_a');
  // Earlier sheets win a duplicate name, so the caller's order is lookup order.
  assert.equal(index.get('tree'), 'city_civic_a');
  assert.deepEqual(duplicates, [{ name: 'tree', kept: 'city_civic_a', skipped: 'city_extra_a' }]);
  // An unknown name is absent, which is what makes the scene skip and warn.
  assert.equal(index.has('observatory'), false);
  assert.equal(index.size, 5);
});

test('buildFrameIndex takes a whole atlas, a name list, and survives junk', () => {
  const { index, duplicates } = buildFrameIndex([
    { key: 'tiles', frames: ['grass', 'path'] },
    { key: 'house', json: { frames: { house: { frame: {} } } } },
    null,
    { frames: ['orphan'] },
    { key: 'empty', json: {} },
  ]);
  assert.deepEqual([...index], [['grass', 'tiles'], ['path', 'tiles'], ['house', 'house']]);
  assert.deepEqual(duplicates, []);
  assert.deepEqual([...buildFrameIndex().index], []);
});

test('slotOffsets centres citizens sharing a doorstep', () => {
  assert.deepEqual(slotOffsets(1, 26), [0]);
  assert.deepEqual(slotOffsets(2, 26), [-13, 13]);
  assert.deepEqual(slotOffsets(3, 26), [-26, 0, 26]);
  assert.deepEqual(slotOffsets(0, 26), []);
  // Symmetric about the door whatever the count.
  for (const n of [2, 3, 4, 5]) {
    const offsets = slotOffsets(n, 26);
    assert.equal(offsets.length, n);
    assert.equal(offsets[0], -offsets[n - 1]);
  }
});

test('vehicleFacing names the compass heading of a step, one frame each', () => {
  assert.equal(vehicleFacing(1, 0), 'se');
  assert.equal(vehicleFacing(-1, 0), 'nw');
  assert.equal(vehicleFacing(0, 1), 'sw');
  assert.equal(vehicleFacing(0, -1), 'ne');
});

test('laneOffset keeps traffic on the right, so oncoming cars pass side by side', () => {
  // Heading south-east (+tx) the right hand points south-west, down and left.
  const se = laneOffset(1, 0);
  assert.ok(se.x < 0 && se.y > 0);
  // Oncoming traffic on the same street sits in the mirrored lane.
  const nw = laneOffset(-1, 0);
  assert.deepEqual({ x: -nw.x, y: -nw.y }, se);
  // Heading south-west (+ty) the right hand points north-west, up and left.
  const sw = laneOffset(0, 1);
  assert.ok(sw.x < 0 && sw.y < 0);
});

test('canEnter queues same-lane and crossing cars but lets oncoming traffic pass', () => {
  assert.equal(canEnter(undefined, 1, 'se'), true);
  assert.equal(canEnter(new Map([[1, 'se']]), 1, 'se'), true, 'its own reservation never blocks');
  assert.equal(canEnter(new Map([[2, 'se']]), 1, 'se'), false, 'car ahead in the same lane');
  assert.equal(canEnter(new Map([[2, 'nw']]), 1, 'se'), true, 'oncoming, other lane');
  assert.equal(canEnter(new Map([[2, 'sw']]), 1, 'se'), false, 'crossing at a junction');
  assert.equal(canEnter(new Map([[2, 'nw'], [3, 'ne']]), 1, 'se'), false);
});

test('roadLoops never returns a loop too small to drive round', () => {
  const parsed = parseLayout(LAYOUT);
  assert.ok(roadLoops(parsed.tiles).every((l) => l.length >= 8));
});

test('nearestIndex measures in tiles', () => {
  const list = [{ tx: 10, ty: 10 }, { tx: 2, ty: 3 }, { tx: 40, ty: 1 }];
  assert.equal(nearestIndex({ tx: 3, ty: 3 }, list), 1);
  assert.equal(nearestIndex({ tx: 0, ty: 0 }, []), -1);
});

test('diffKeys reports what to add and what to destroy', () => {
  const prev = new Map([['a', 1], ['b', 2]]);
  const { added, removed } = diffKeys(prev, [{ id: 'b' }, { id: 'c' }], (x) => x.id);
  assert.deepEqual(added, [{ id: 'c' }]);
  assert.deepEqual(removed, ['a']);
});

test('poseFor maps buildings to work frames and falls back to standing', () => {
  assert.equal(poseFor('forge'), 'work_hammer');
  assert.equal(poseFor('library'), 'work_read');
  assert.equal(poseFor('server_hall'), 'work_terminal');
  assert.equal(poseFor('town_hall'), 'work_flag');
  assert.equal(poseFor('fountain'), 'sit');
  assert.equal(poseFor('bank'), 'idle_side');
});

test('isChopping only fires on a destructive shell command', () => {
  assert.equal(isChopping({ name: 'Bash', summary: 'rm -rf .tmp' }), true);
  assert.equal(isChopping({ name: 'PowerShell', summary: 'Remove-Item x' }), true);
  assert.equal(isChopping({ name: 'Bash', summary: 'git status' }), false);
  assert.equal(isChopping({ name: 'Edit', summary: 'rm -rf .tmp' }), false);
  assert.equal(isChopping(null), false);
});
