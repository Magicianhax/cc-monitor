import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import {
  BUILDINGS,
  GLYPHS,
  LAYOUT,
  TILESET,
  buildingFor,
  parseLayout,
  roadTileFor,
  toTiled,
  walkGrid,
} from '../lib/citymap.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A 12x8 sketch that exercises every road neighbour pattern plus one building
// and one house. Read it with tx across and ty down.
const MINI = [
  '...#....GG.T',
  '...#..#.GG.b',
  '.#########..',
  'hhh#...#....',
  'hhh##.##....',
  'hhh#...##...',
  '====....#...',
  '~~~~~~~~~~~~',
];

// The mini layout has no north-west or south-east bend, so they get their own
// four-row sketches.
const BEND_NW_SE = ['..#.', '.##.', '.#..', '....'];

test('parseLayout reads size, terrain, buildings and houses', () => {
  const p = parseLayout(MINI);
  assert.equal(p.w, 12);
  assert.equal(p.h, 8);
  assert.equal(p.tiles.length, 8);
  assert.equal(p.tiles[0].length, 12);
  assert.equal(p.tiles[2][3], 'road');
  assert.equal(p.tiles[6][0], 'sidewalk');
  assert.equal(p.tiles[7][0], 'water');
  assert.equal(p.tiles[0][11], 'tree');
  assert.equal(p.tiles[1][11], 'bush');
  // A building footprint reports the ground under it, not the letter.
  assert.equal(p.tiles[0][8], 'grass');

  assert.equal(p.buildings.length, 1);
  assert.deepEqual(p.buildings[0], {
    letter: 'G', key: 'guard_post', tx: 8, ty: 0, w: 2, h: 2, door: [9, 2],
  });
  assert.equal(p.houses.length, 1);
  assert.deepEqual(p.houses[0], {
    letter: 'h', key: 'house', tx: 0, ty: 3, w: 3, h: 3, door: [1, 6],
  });
});

test('parseLayout rejects a footprint that is not the declared size', () => {
  assert.throws(() => parseLayout(['GGG.', 'GGG.', '....', '....']), /guard_post/);
});

test('parseLayout rejects ragged rows and unknown glyphs', () => {
  assert.throws(() => parseLayout(['....', '...']), /same length/);
  assert.throws(() => parseLayout(['..$.', '....']), /\$/);
});

// Frames are named on the grid compass: n is -ty, s is +ty, w is -tx, e is +tx.
test('roadTileFor picks the frame from the four road neighbours', () => {
  const { tiles } = parseLayout(MINI);
  assert.equal(roadTileFor(tiles, 3, 2), 'road_x');        // all four arms
  assert.equal(roadTileFor(tiles, 6, 2), 'road_t_n');      // w-e street, stub north
  assert.equal(roadTileFor(tiles, 7, 2), 'road_t_s');      // w-e street, stub south
  assert.equal(roadTileFor(tiles, 3, 4), 'road_t_e');      // n-s street, stub east
  assert.equal(roadTileFor(tiles, 7, 4), 'road_t_w');      // n-s street, stub west
  assert.equal(roadTileFor(tiles, 3, 1), 'road_ne');       // straight along ty
  assert.equal(roadTileFor(tiles, 4, 2), 'road_nw');       // straight along tx
  assert.equal(roadTileFor(tiles, 7, 5), 'road_c_ne');     // bend, arms north and east
  assert.equal(roadTileFor(tiles, 8, 5), 'road_c_sw');     // bend, arms south and west
  assert.equal(roadTileFor(tiles, 3, 0), 'road_ne');       // dead end along ty
  assert.equal(roadTileFor(tiles, 8, 6), 'road_ne');       // dead end along ty
  assert.equal(roadTileFor(tiles, 9, 2), 'road_nw');       // dead end along tx
});

test('roadTileFor names the other two bends', () => {
  const { tiles } = parseLayout(BEND_NW_SE);
  assert.equal(roadTileFor(tiles, 2, 1), 'road_c_nw');     // arms north and west
  assert.equal(roadTileFor(tiles, 1, 1), 'road_c_se');     // arms south and east
});

test('the two sketches exercise every road frame in the tileset', () => {
  const seen = new Set();
  for (const rows of [MINI, BEND_NW_SE]) {
    const { tiles, w, h } = parseLayout(rows);
    for (let ty = 0; ty < h; ty++) {
      for (let tx = 0; tx < w; tx++) if (tiles[ty][tx] === 'road') seen.add(roadTileFor(tiles, tx, ty));
    }
  }
  const roads = TILESET.frames.filter((f) => f.startsWith('road_'));
  assert.deepEqual([...seen].sort(), roads.slice().sort());
});

test('walkGrid opens streets and doors, blocks footprints, costs grass', () => {
  const p = parseLayout(MINI);
  const g = walkGrid(p);
  assert.equal(g[2][3], 0);   // road
  assert.equal(g[6][0], 0);   // sidewalk
  assert.equal(g[0][0], 2);   // grass costs more than pavement
  assert.equal(g[0][8], 1);   // guard post footprint
  assert.equal(g[1][9], 1);
  assert.equal(g[2][9], 0);   // its door stays open
  assert.equal(g[3][0], 1);   // house footprint
  assert.equal(g[6][1], 0);   // its door stays open
  assert.equal(g[0][11], 1);  // tree
  assert.equal(g[1][11], 1);  // bush
  assert.equal(g[7][0], 1);   // water
});

test('buildingFor maps a tool name to the building that represents it', () => {
  assert.equal(buildingFor('Grep'), 'library');
  assert.equal(buildingFor('Read'), 'library');
  assert.equal(buildingFor('Edit'), 'forge');
  assert.equal(buildingFor('Bash'), 'server_hall');
  assert.equal(buildingFor('WebFetch'), 'radio_tower');
  assert.equal(buildingFor('mcp__vercel__get_project'), 'radio_tower');
  assert.equal(buildingFor('Agent'), 'town_hall');
  assert.equal(buildingFor('Skill'), 'school');
  assert.equal(buildingFor('Wibble'), 'guard_post');
  assert.equal(buildingFor(null), 'fountain');
  assert.equal(buildingFor(''), 'fountain');
  assert.equal(buildingFor('idle'), 'fountain');
});

test('a full destination spills into its overflow building', () => {
  // Under the crowd limit nothing changes, whatever shape the map is.
  assert.equal(buildingFor('Edit', { forge: 3 }), 'forge');
  assert.equal(buildingFor('Edit', new Map([['forge', 3]])), 'forge');
  assert.equal(buildingFor('Edit', {}), 'forge');
  assert.equal(buildingFor('Edit', null), 'forge');

  assert.equal(buildingFor('Edit', { forge: 4 }), 'workshop');
  assert.equal(buildingFor('Write', new Map([['forge', 9]])), 'workshop');
  assert.equal(buildingFor(null, { fountain: 4 }), 'cafe');
  assert.equal(buildingFor('idle', { fountain: 7 }), 'cafe');

  // A family with no overflow stays put however busy its building is.
  assert.equal(buildingFor('Grep', { library: 40 }), 'library');
  assert.equal(buildingFor('Bash', { server_hall: 40 }), 'server_hall');
  // And a tool with no family ignores occupancy entirely.
  assert.equal(buildingFor('Wibble', { guard_post: 40 }), 'guard_post');
});

test('only the workshop and the cafe take overflow', () => {
  const spills = Object.values(BUILDINGS).filter((s) => s.overflow && s.overflow.length);
  assert.deepEqual(spills.map((s) => s.key).sort(), ['cafe', 'workshop']);
  // None of the density buildings is a destination of its own.
  const destinations = Object.values(BUILDINGS).filter((s) => s.for.length).map((s) => s.key).sort();
  assert.deepEqual(destinations, [
    'fountain', 'forge', 'library', 'radio_tower', 'school', 'server_hall', 'town_hall',
  ].sort());
});

test('toTiled emits an isometric Tiled map with the four layers', () => {
  const p = parseLayout(MINI);
  const m = toTiled(p);
  assert.equal(m.orientation, 'isometric');
  assert.equal(m.tilewidth, 64);
  assert.equal(m.tileheight, 32);
  assert.equal(m.infinite, false);
  assert.equal(m.width, 12);
  assert.equal(m.height, 8);
  assert.deepEqual(m.layers.map((l) => l.name), ['ground', 'props', 'buildings', 'houses']);
  assert.deepEqual(m.layers.map((l) => l.type), ['tilelayer', 'objectgroup', 'objectgroup', 'objectgroup']);

  const [ground, props, buildings, houses] = m.layers;
  assert.equal(ground.data.length, 96);
  // gids are 1-based; water is the only hole and the background shows through.
  assert.equal(ground.data[7 * 12 + 0], 0);
  assert.equal(ground.data[0 * 12 + 0], TILESET.frames.indexOf('grass') + 1);
  assert.equal(ground.data[2 * 12 + 3], TILESET.frames.indexOf('road_x') + 1);
  assert.equal(ground.data[6 * 12 + 3], TILESET.frames.indexOf('sidewalk') + 1);
  // a paved tile with no road neighbour is a plaza, not a kerbed sidewalk
  assert.equal(ground.data[6 * 12 + 0], TILESET.frames.indexOf('path') + 1);

  assert.equal(props.objects.length, 2);
  assert.deepEqual(props.objects.map((o) => o.name), ['tree', 'bush']);
  assert.equal(prop(props.objects[0], 'frame'), 'tree');
  assert.equal(prop(props.objects[0], 'scale'), undefined);
  // There is no bush sprite, so a bush is a half-size tree.
  assert.equal(prop(props.objects[1], 'frame'), 'tree');
  assert.equal(prop(props.objects[1], 'scale'), 0.5);

  assert.equal(buildings.objects.length, 1);
  const g = buildings.objects[0];
  assert.equal(g.name, 'guard_post');
  assert.equal(prop(g, 'key'), 'guard_post');
  assert.equal(g.x, 8 * 32);
  assert.equal(g.y, 0 * 32);
  assert.equal(prop(g, 'letter'), 'G');
  assert.equal(prop(g, 'doorTx'), 9);
  assert.equal(prop(g, 'doorTy'), 2);

  assert.equal(houses.objects.length, 1);
  assert.equal(houses.objects[0].name, 'house');
  assert.equal(prop(houses.objects[0], 'index'), 0);

  const ids = m.layers.flatMap((l) => l.objects || []).map((o) => o.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(m.nextobjectid, Math.max(...ids) + 1);
});

test('toTiled references one uniform-grid tileset covering every frame', () => {
  const m = toTiled(parseLayout(MINI));
  assert.equal(m.tilesets.length, 1);
  const ts = m.tilesets[0];
  assert.equal(ts.firstgid, 1);
  assert.equal(ts.tilecount, TILESET.frames.length);
  assert.equal(ts.columns, TILESET.frames.length);
  assert.equal(ts.imagewidth, TILESET.frames.length * 64);
  assert.equal(ts.imageheight, 32);
  const max = Math.max(...m.layers[0].data);
  assert.ok(max <= ts.firstgid + ts.tilecount - 1, `gid ${max} outside the tileset`);
});

function prop(obj, name) {
  const p = obj.properties.find((e) => e.name === name);
  return p && p.value;
}

// --- the real city -----------------------------------------------------------

test('LAYOUT is 44 wide by 32 tall and uses known glyphs only', () => {
  assert.equal(LAYOUT.length, 32);
  const known = new Set([...Object.keys(GLYPHS), ...Object.keys(BUILDINGS)]);
  for (const [ty, row] of LAYOUT.entries()) {
    assert.equal(row.length, 44, `row ${ty} is ${row.length} wide`);
    for (const c of row) assert.ok(known.has(c), `row ${ty} has unknown glyph ${c}`);
  }
});

test('LAYOUT places every building key at least once and twelve house lots', () => {
  const p = parseLayout(LAYOUT);
  const placed = new Set(p.buildings.map((b) => b.key));
  const expected = Object.values(BUILDINGS).map((s) => s.key).filter((k) => k !== 'house');
  for (const key of expected) assert.ok(placed.has(key), `${key} is not on the map`);
  assert.equal(placed.size, expected.length, `unexpected key: ${[...placed].filter((k) => !expected.includes(k))}`);
  assert.equal(p.houses.length, 12);
  for (const house of p.houses) {
    assert.equal(house.key, 'house');
    assert.equal(house.w, 3);
    assert.equal(house.h, 3);
  }
});

// The human's note on the first city was "lots of empty space, feels flat".
// A lot reads as grass in `tiles`, so the footprints are masked back in first.
test('no four-by-four square of the map is bare grass', () => {
  const p = parseLayout(LAYOUT);
  const bare = p.tiles.map((row) => row.map((name) => name === 'grass'));
  for (const b of [...p.buildings, ...p.houses]) {
    for (let ty = b.ty; ty < b.ty + b.h; ty++) {
      for (let tx = b.tx; tx < b.tx + b.w; tx++) bare[ty][tx] = false;
    }
  }
  for (let ty = 0; ty + 4 <= p.h; ty++) {
    for (let tx = 0; tx + 4 <= p.w; tx++) {
      let empty = true;
      for (let y = ty; y < ty + 4 && empty; y++) {
        for (let x = tx; x < tx + 4; x++) if (!bare[y][x]) { empty = false; break; }
      }
      assert.ok(!empty, `bare 4x4 grass block at ${tx},${ty}`);
    }
  }
});

test('every glyph in the legend appears in the drawing', () => {
  const p = parseLayout(LAYOUT);
  const seen = new Set();
  for (const row of p.tiles) for (const name of row) seen.add(name);
  for (const [glyph, name] of Object.entries(GLYPHS)) {
    if (name === 'water') continue; // the dense city has no shoreline
    assert.ok(seen.has(name), `${glyph} (${name}) is never drawn`);
  }
});

test('no two footprints overlap', () => {
  const p = parseLayout(LAYOUT);
  const owner = new Map();
  for (const b of [...p.buildings, ...p.houses]) {
    for (let ty = b.ty; ty < b.ty + b.h; ty++) {
      for (let tx = b.tx; tx < b.tx + b.w; tx++) {
        const cell = `${tx},${ty}`;
        assert.equal(owner.get(cell), undefined, `${b.key} overlaps ${owner.get(cell)} at ${cell}`);
        owner.set(cell, b.key);
      }
    }
  }
});

test('every door opens onto pavement and touches the street network', () => {
  const p = parseLayout(LAYOUT);
  for (const b of [...p.buildings, ...p.houses]) {
    const [dx, dy] = b.door;
    assert.ok(dy < p.h && dx < p.w, `${b.key} door ${dx},${dy} is off the map`);
    const on = p.tiles[dy][dx];
    assert.ok(on === 'sidewalk' || on === 'road', `${b.key} door stands on ${on}`);
    const near = [[dx + 1, dy], [dx - 1, dy], [dx, dy + 1], [dx, dy - 1]]
      .filter(([x, y]) => x >= 0 && y >= 0 && x < p.w && y < p.h)
      .map(([x, y]) => p.tiles[y][x]);
    assert.ok(near.some((n) => n === 'sidewalk' || n === 'road'), `${b.key} door is isolated`);
  }
});

test('every door reaches every other door over pavement alone', () => {
  const p = parseLayout(LAYOUT);
  const g = walkGrid(p);
  const doors = [...p.buildings, ...p.houses].map((b) => b.door);
  const seen = new Set();
  const queue = [doors[0]];
  seen.add(doors[0].join(','));
  while (queue.length) {
    const [x, y] = queue.pop();
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (nx < 0 || ny < 0 || nx >= p.w || ny >= p.h) continue;
      if (g[ny][nx] !== 0) continue;
      const k = `${nx},${ny}`;
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push([nx, ny]);
    }
  }
  for (const d of doors) assert.ok(seen.has(d.join(',')), `door ${d} is cut off`);
});

test('the real map renders without empty ground outside the water', () => {
  const p = parseLayout(LAYOUT);
  const m = toTiled(p);
  for (let ty = 0; ty < p.h; ty++) {
    for (let tx = 0; tx < p.w; tx++) {
      const gid = m.layers[0].data[ty * p.w + tx];
      const wet = p.tiles[ty][tx] === 'water';
      assert.equal(gid === 0, wet, `tile ${tx},${ty} is ${p.tiles[ty][tx]} with gid ${gid}`);
    }
  }
  assert.match(m.backgroundcolor, /^#[0-9a-f]{6}$/);
});

test('the park gets a bench on either side of the fountain', () => {
  const m = toTiled(parseLayout(LAYOUT));
  const p = parseLayout(LAYOUT);
  const fountain = p.buildings.find((b) => b.key === 'fountain');
  const benches = m.layers[1].objects.filter((o) => o.name === 'bench');
  assert.equal(benches.length, 2);
  assert.deepEqual(benches.map((o) => prop(o, 'tx')), [fountain.tx - 1, fountain.tx + fountain.w]);
  for (const bench of benches) {
    assert.equal(prop(bench, 'ty'), fountain.ty);
    assert.equal(prop(bench, 'frame'), 'bench');
    assert.equal(prop(bench, 'scale'), undefined);
    assert.equal(p.tiles[prop(bench, 'ty')][prop(bench, 'tx')], 'sidewalk');
  }
});

// The scene keys its building views by object name, so a repeated building has
// to arrive with a name of its own or the later ones lose their ground plate on
// a theme change and their name plate on a zoom.
test('every lot object has a unique name and carries its frame as `key`', () => {
  const p = parseLayout(LAYOUT);
  const m = toTiled(p);
  const lots = [...m.layers[2].objects, ...m.layers[3].objects];
  assert.equal(m.layers[2].objects.length, 26);
  assert.equal(m.layers[3].objects.length, 12);

  const names = lots.map((o) => o.name);
  assert.equal(new Set(names).size, names.length, `repeated name: ${names.find((n, i) => names.indexOf(n) !== i)}`);

  const keys = lots.map((o) => prop(o, 'key'));
  assert.equal(new Set(m.layers[2].objects.map((o) => prop(o, 'key'))).size, 22);
  assert.ok(keys.every((k) => typeof k === 'string' && k.length), 'every lot names the frame it draws');

  // The first of each key keeps the bare name, which is what the scene's
  // destination lookups ask for; the rest take a #n suffix.
  const first = new Map();
  for (const o of lots) {
    const key = prop(o, 'key');
    if (!first.has(key)) { first.set(key, o.name); assert.equal(o.name, key); } else assert.match(o.name, /#\d+$/);
    assert.equal(o.name.replace(/#\d+$/, ''), key);
  }
  for (const key of ['town_hall', 'fountain', 'guard_post', 'library', 'forge', 'apartment', 'market_stall']) {
    assert.equal(first.get(key), key, `${key} lost its bare name`);
  }
});

test('the real crossings resolve to the synthesized junction frames', () => {
  const p = parseLayout(LAYOUT);
  const m = toTiled(p);
  const at = (tx, ty) => TILESET.frames[m.layers[0].data[ty * p.w + tx] - 1];
  assert.equal(at(7, 19), 'road_x');     // the west avenue crosses the cross street
  assert.equal(at(7, 6), 'road_x');      // and the boulevard's north lane
  assert.equal(at(7, 0), 'road_ne');     // the avenue running off the north edge
  assert.equal(at(7, 30), 'road_t_n');   // it ends at the south street
  assert.equal(at(0, 6), 'road_c_se');   // the boulevard's north-west corner
});

// Reading the stitched sheet back is the only check that the junction art
// actually lines up with the straights it is drawn beside.
test('a junction tile carries asphalt across the same edges as its straights', () => {
  const sheet = PNG.sync.read(fs.readFileSync(path.join(ROOT, 'public', 'assets', 'tiles.png')));
  const profile = (frame, edge) => edgeProfile(sheet, TILESET.frames.indexOf(frame), edge);

  for (const edge of ['nw', 'se']) {
    assert.deepEqual(profile('road_x', edge), profile('road_nw', edge), `road_x differs on ${edge}`);
    assert.deepEqual(profile('road_t_n', edge), profile('road_nw', edge), `road_t_n differs on ${edge}`);
  }
  for (const edge of ['ne', 'sw']) {
    assert.deepEqual(profile('road_x', edge), profile('road_ne', edge), `road_x differs on ${edge}`);
  }
  // The T with a stub to the north opens that edge and keeps the other shut.
  assert.deepEqual(profile('road_t_n', 'ne'), profile('road_ne', 'ne'));
  assert.deepEqual(profile('road_t_n', 'sw'), new Array(13).fill('grass'));
  // Sanity: the straights really do open two edges and close the other two.
  assert.ok(profile('road_nw', 'se').includes('road'));
  assert.deepEqual(profile('road_nw', 'ne'), new Array(13).fill('grass'));
});

/**
 * Classify the pixels running just inside one edge of a cell in the stitched
 * strip, from the corner inwards. Two frames that meet along that edge must
 * agree, or the asphalt steps as the map is laid out.
 */
function edgeProfile(sheet, cell, edge) {
  const [cw, ch] = [TILESET.tilewidth, TILESET.tileheight];
  const [cx, cy] = [cell * cw, 0];
  const out = [];
  for (let k = 1; k <= 13; k++) {
    const dy = edge === 'nw' || edge === 'ne' ? -k : k;
    const span = 2 * (ch / 2 - k); // half-width of the diamond on that row
    const dx = edge === 'ne' || edge === 'se' ? span - 4 : 4 - span;
    const i = ((cy + ch / 2 + dy) * sheet.width + cx + cw / 2 + dx) * 4;
    const [r, g, b, a] = [sheet.data[i], sheet.data[i + 1], sheet.data[i + 2], sheet.data[i + 3]];
    out.push(a === 0 ? 'clear' : g > r + 20 && g > b + 20 ? 'grass' : 'road');
  }
  return out;
}

test('public/citymap.mjs is a byte-for-byte copy of lib/citymap.mjs', () => {
  const lib = fs.readFileSync(path.join(ROOT, 'lib', 'citymap.mjs'));
  const web = fs.readFileSync(path.join(ROOT, 'public', 'citymap.mjs'));
  assert.ok(lib.equals(web), 'run `npm run map:build` after editing lib/citymap.mjs');
});

test('lib/citymap.mjs imports nothing so the browser copy runs as is', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'citymap.mjs'), 'utf8');
  assert.doesNotMatch(src, /^\s*import\s/m);
  assert.doesNotMatch(src, /require\(/);
});

test('the committed public/assets/city.json matches the generator', () => {
  const built = toTiled(parseLayout(LAYOUT));
  const onDisk = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'assets', 'city.json'), 'utf8'));
  assert.deepEqual(onDisk, built);
});
