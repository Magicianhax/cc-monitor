// The city itself: an ASCII drawing, the helpers that read it, and the Tiled
// map the Phaser scene loads.
//
// Keep this file free of imports. `npm run map:build` copies it byte for byte
// to public/citymap.mjs so the browser can use the same helpers, and a test
// fails if the two ever drift apart.

/**
 * Terrain glyphs. Anything else in the drawing is a building letter.
 *
 * The four ground glyphs are `.` `#` `=` `~`; the rest are scenery that stands
 * on grass, listed in PROPS. A scenery tile blocks walking, so props stay off
 * the pavement: a street lamp sits on the block corner beside a crossing, not
 * on the sidewalk itself.
 */
export const GLYPHS = {
  '.': 'grass',
  '#': 'road',
  '=': 'sidewalk',
  '~': 'water',
  T: 'tree',
  b: 'bush',
  o: 'oak',
  p: 'pine',
  e: 'hedge',
  x: 'flowers',
  k: 'rocks',
  l: 'lamp',
  m: 'mailbox',
  w: 'well',
  c: 'cart',
  r: 'barrels',
  f: 'fence_x',
  F: 'fence_y',
};

/** Glyph terrains that are scenery on the props layer rather than ground. */
const PROPS = new Set([
  'tree', 'bush', 'oak', 'pine', 'hedge', 'flowers', 'rocks',
  'lamp', 'mailbox', 'well', 'cart', 'barrels', 'fence_x', 'fence_y',
]);

/**
 * Building letters and their lots. `door` is the lot-local tile a visitor
 * walks in through: column floor(w/2), row h, i.e. the tile immediately south
 * (+ty) of the footprint. `for` lists the tool families the building stands
 * for and `overflow` the families it takes in once that building is full; see
 * buildingFor.
 *
 * The forge is `J` because `F` now draws a fence.
 */
export const BUILDINGS = {
  L: { key: 'library', w: 4, h: 4, door: [2, 4], for: ['read'] },
  J: { key: 'forge', w: 4, h: 4, door: [2, 4], for: ['file'] },
  S: { key: 'server_hall', w: 4, h: 4, door: [2, 4], for: ['shell'] },
  R: { key: 'radio_tower', w: 3, h: 3, door: [1, 3], for: ['web'] },
  H: { key: 'town_hall', w: 5, h: 4, door: [2, 4], for: ['agent'] },
  K: { key: 'school', w: 4, h: 4, door: [2, 4], for: ['skill'] },
  G: { key: 'guard_post', w: 2, h: 2, door: [1, 2], for: [] },
  B: { key: 'bank', w: 4, h: 4, door: [2, 4], for: [] },
  W: { key: 'water_tower', w: 2, h: 2, door: [1, 2], for: [] },
  P: { key: 'fountain', w: 2, h: 2, door: [1, 2], for: ['idle'] },
  h: { key: 'house', w: 3, h: 3, door: [1, 3], for: [] },
  // The density round. None of these is a destination of its own; the workshop
  // and the cafe only take the spill when the forge or the park is full.
  C: { key: 'cafe', w: 3, h: 3, door: [1, 3], for: [], overflow: ['idle'] },
  U: { key: 'workshop', w: 4, h: 4, door: [2, 4], for: [], overflow: ['file'] },
  Y: { key: 'bakery', w: 3, h: 3, door: [1, 3], for: [] },
  M: { key: 'market_stall', w: 2, h: 2, door: [1, 2], for: [] },
  V: { key: 'warehouse', w: 4, h: 4, door: [2, 4], for: [] },
  A: { key: 'apartment', w: 3, h: 4, door: [1, 4], for: [] },
  N: { key: 'clinic', w: 3, h: 3, door: [1, 3], for: [] },
  D: { key: 'windmill', w: 3, h: 3, door: [1, 3], for: [] },
  E: { key: 'greenhouse', w: 4, h: 3, door: [2, 3], for: [] },
  Q: { key: 'bell_tower', w: 2, h: 3, door: [1, 3], for: [] },
  I: { key: 'inn', w: 4, h: 3, door: [2, 3], for: [] },
  O: { key: 'observatory', w: 3, h: 4, door: [1, 4], for: [] },
};

/** The building a tool with no family lands in. */
const FALLBACK_KEY = BUILDINGS.G.key;

/** How many citizens a destination holds before its overflow opens. */
const CROWD = 4;

/**
 * 44 x 32. tx runs across a row, ty runs down the rows.
 *
 * The canvas is deliberately small: the sheets draw a building about four
 * tiles wide, so a wider map leaves them floating in lawn. Everything here is
 * within two tiles of a street.
 *
 * Streets run across at ty 6-7 (the boulevard, two lanes with sidewalk
 * outside), 19 and 30; avenues run down at tx 7, tx 20-21 (the second
 * boulevard) and tx 35. Rows 13 and 25 are pedestrian alleys, paved but with
 * no traffic, and they double as the door row for the band above. Five bands
 * of lots sit between them:
 *
 *   ty 1-4    windmill, observatory on its path hill, greenhouse, the
 *             warehouse and workshop district, an apartment, the guard post
 *   ty 9-12   the civic row: school, library, forge, server hall, town hall,
 *             bank, radio tower
 *   ty 14-17  bakery and water tower, the inn beside the park and its
 *             fountain, the market square with its stalls, bell tower and
 *             cafe, two clinics
 *   ty 21-24  houses either side of the apartment row
 *   ty 26-28  the rest of the twelve house lots
 *
 * Hedges, fences, lamps, mailboxes, flowers and trees fill what is left, so
 * no four-by-four square of the map is bare grass.
 */
export const LAYOUT = [
  'pw.r..=#======oow.o=##=eeeeeeeeeep=#=fffo.xo',
  'eeeee.=#=OOO==eeeee=##=VVVV.UUUU.o=#=AAAF..T',
  'cDDD.w=#=OOO==EEEE.=##=VVVV.UUUU..=#=AAAFeee',
  'oDDD..=#=OOO==EEEE.=##=VVVVeUUUUxb=#=AAAFGGw',
  '.DDD.l=#=OOO==EEEEl=##=VVVVpUUUUcl=#=AAAmGGe',
  '=======#============##=============#========',
  '############################################',
  '############################################',
  '=======#============##=============#========',
  'rKKKKl=#=LLLLoJJJJl=##=SSSSpHHHHHl=#=BBBBeee',
  'bKKKKl=#=LLLLxJJJJe=##=SSSS.HHHHHm=#=BBBBRRR',
  'xKKKKk=#=LLLLoJJJJk=##=SSSSrHHHHHc=#=BBBBRRR',
  '.KKKK.=#=LLLL.JJJJ.=##=SSSSoHHHHH.=#=BBBBRRR',
  '=======#============##=============#========',
  'eeeeep=#=eeeee======##=============#=exeeeee',
  'mYYY.p=#=IIII.======##======QQ=CCC=#=eeeNNNm',
  '.YYYo.=#=IIII.=PP===##=MM=MMQQ=CCC=#=WWpNNNc',
  '.YYYpl=#=IIIIb=PP===##=MM=MMQQ=CCC=#=WW.NNNo',
  '=======#============##=============#========',
  '############################################',
  '=======#============##=============#========',
  'bfff.l=#=lffofff..l=##=AAAFAAAFAAA=#=lff.fff',
  'FhhhF.=#=hhhFhhhFo.=##=AAAFAAAFAAA=#=hhhFhhh',
  'FhhhFo=#=hhhFhhhFor=##=AAAFAAAFAAA=#=hhhFhhh',
  'Fhhhm.=#=hhhmhhhmbo=##=AAAmAAAmAAA=#=hhhmhhh',
  '=======#============##=============#========',
  '......=#=hhhFhhhFxm=##=hhhFhhhFhhh=#=hhhFhhh',
  'r.w...=#=hhhFhhhFx.=##=hhhFhhhFhhh=#=hhhFhhh',
  '.lTb.l=#=hhhmhhhmel=##=hhhmhhhmhhh=#=hhhmhhh',
  '=======#============##=============#========',
  '############################################',
  '============================================',
];

/**
 * The one tileset the ground layer draws from. `npm run map:build` stitches
 * these frames out of the atlas sheets into public/assets/tiles.png as a
 * single row of 64x32 cells, because a Tiled tile layer needs a uniform grid.
 * A frame's index here is its tile id; its gid is that index plus firstgid.
 */
export const TILESET = {
  name: 'tiles+roads',
  image: 'tiles.png',
  tilewidth: 64,
  tileheight: 32,
  frames: [
    'grass', 'path',
    'road_ne', 'road_nw', 'road_x',
    'road_t_n', 'road_t_s', 'road_t_e', 'road_t_w',
    'road_c_ne', 'road_c_nw', 'road_c_se', 'road_c_sw',
    'sidewalk',
  ],
  /** Where each frame is cut from, for the stitcher. */
  sources: {
    grass: 'tiles', path: 'tiles',
    road_ne: 'city_roads', road_nw: 'city_roads', road_x: 'city_roads',
    road_t_n: 'city_roads', road_t_s: 'city_roads', road_t_e: 'city_roads', road_t_w: 'city_roads',
    road_c_ne: 'city_roads', road_c_nw: 'city_roads', road_c_se: 'city_roads', road_c_sw: 'city_roads',
    sidewalk: 'city_roads',
  },
};

/** Water leaves a hole in the ground layer and this shows through it. */
export const WATER_COLOR = '#1f4e6b';

/**
 * Props are objects, not tiles; this is the atlas frame each one draws. There
 * is no bush sprite, so a bush is the pine tree at half size.
 *
 * `fence_ne` is the rail that runs down-right on screen, which is the tx axis,
 * so a row of `f` in the drawing lines up with it; `fence_nw` runs up-right,
 * along ty, for a column of `F`.
 */
const PROP_FRAME = {
  tree: 'tree',
  bush: 'tree',
  bench: 'bench',
  oak: 'oak',
  pine: 'pine',
  hedge: 'hedge',
  flowers: 'flowers',
  rocks: 'rocks',
  lamp: 'lamp',
  mailbox: 'mailbox',
  well: 'well',
  cart: 'cart',
  barrels: 'barrels',
  fence_x: 'fence_ne',
  fence_y: 'fence_nw',
};

/**
 * How big a prop is drawn, as a multiple of the sprite's own size.
 *
 * The decor sheet is cut to a common 40px height, but a tile is 64 wide, so a
 * fence or a hedge at 1.0 reads as a toy beside the buildings. These bring
 * each one up to roughly the width of the tile it stands on. A bush is the
 * tree sprite at half size, which is what makes it a bush.
 */
const PROP_SCALE = {
  bush: 0.5,
  fence_x: 1.7,
  fence_y: 1.7,
  hedge: 1.8,
  flowers: 1.4,
  rocks: 1.3,
  barrels: 1.3,
  cart: 1.2,
  well: 1.4,
  lamp: 1.3,
  mailbox: 1.2,
  oak: 1.3,
  pine: 1.3,
};

/**
 * Read the drawing.
 *
 * `tiles[ty][tx]` is the terrain under a cell, so a building footprint reads
 * as the grass of its lot and the buildings come back separately. Houses are
 * split out in reading order so the scene can address lot 0..11.
 */
export function parseLayout(rows = LAYOUT) {
  const h = rows.length;
  const w = rows[0].length;
  for (const [ty, row] of rows.entries()) {
    if (row.length !== w) throw new Error(`every row must be the same length: row ${ty} is ${row.length}, expected ${w}`);
  }

  const tiles = [];
  for (let ty = 0; ty < h; ty++) {
    const out = [];
    for (let tx = 0; tx < w; tx++) {
      const c = rows[ty][tx];
      if (GLYPHS[c]) out.push(GLYPHS[c]);
      else if (BUILDINGS[c]) out.push('grass');
      else throw new Error(`unknown glyph ${c} at ${tx},${ty}`);
    }
    tiles.push(out);
  }

  const claimed = Array.from({ length: h }, () => new Array(w).fill(false));
  const buildings = [];
  const houses = [];
  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      const letter = rows[ty][tx];
      const spec = BUILDINGS[letter];
      if (!spec || claimed[ty][tx]) continue;
      const lot = measure(rows, tx, ty, letter);
      if (lot.w !== spec.w || lot.h !== spec.h) {
        throw new Error(`${spec.key} at ${tx},${ty} is ${lot.w}x${lot.h}, expected ${spec.w}x${spec.h}`);
      }
      for (let y = ty; y < ty + lot.h; y++) for (let x = tx; x < tx + lot.w; x++) claimed[y][x] = true;
      const entry = {
        letter,
        key: spec.key,
        tx,
        ty,
        w: spec.w,
        h: spec.h,
        door: [tx + spec.door[0], ty + spec.door[1]],
      };
      (letter === 'h' ? houses : buildings).push(entry);
    }
  }
  return { w, h, tiles, buildings, houses };
}

/** The largest rectangle of `letter` whose top-left corner is tx,ty. */
function measure(rows, tx, ty, letter) {
  let w = 0;
  while (tx + w < rows[ty].length && rows[ty][tx + w] === letter) w++;
  let h = 1;
  while (ty + h < rows.length && rows[ty + h].slice(tx, tx + w) === letter.repeat(w)) h++;
  return { w, h };
}

/**
 * Pick the road frame for tx,ty from its four road neighbours.
 *
 * On screen +tx leaves through the lower-right edge, +ty through the
 * lower-left, -tx upper-left and -ty upper-right. Reading the atlas pixels
 * back: road_nw's asphalt spans the -tx/+tx edges and road_ne's spans the
 * -ty/+ty edges, so those are the two straights.
 *
 * Every junction frame is synthesized from those two straights by
 * tools/prep-art.mjs, and named on the grid compass where n is -ty, s is +ty,
 * w is -tx and e is +tx. A T is named for its stub, the arm that joins the
 * street running through, and a corner for the two arms it keeps.
 */
export function roadTileFor(tiles, tx, ty) {
  const road = (x, y) => Boolean(tiles[y] && tiles[y][x] === 'road');
  const nTx = road(tx - 1, ty);
  const pTx = road(tx + 1, ty);
  const nTy = road(tx, ty - 1);
  const pTy = road(tx, ty + 1);
  const count = Number(nTx) + Number(pTx) + Number(nTy) + Number(pTy);

  if (count === 4) return 'road_x';
  // Three arms: one axis runs through, the other contributes the stub.
  if (count === 3) {
    if (nTx && pTx) return nTy ? 'road_t_n' : 'road_t_s';
    return nTx ? 'road_t_w' : 'road_t_e';
  }
  if (count === 2) {
    if (nTx && pTx) return 'road_nw';
    if (nTy && pTy) return 'road_ne';
    return `road_c_${nTy ? 'n' : 's'}${nTx ? 'w' : 'e'}`;
  }
  // A dead end, or a lone tile, shows the straight of the axis it points along.
  return nTy || pTy ? 'road_ne' : 'road_nw';
}

/**
 * Movement costs: 0 pavement, 2 grass, 1 blocked. Every door is forced open
 * so a citizen can always step out of the building it belongs to.
 */
export function walkGrid(parsed) {
  const grid = parsed.tiles.map((row) => row.map((name) => {
    if (name === 'road' || name === 'sidewalk') return 0;
    if (name === 'grass') return 2;
    return 1;
  }));
  for (const b of [...parsed.buildings, ...parsed.houses]) {
    for (let ty = b.ty; ty < b.ty + b.h; ty++) {
      for (let tx = b.tx; tx < b.tx + b.w; tx++) {
        if (grid[ty] && grid[ty][tx] !== undefined) grid[ty][tx] = 1;
      }
    }
    const [dx, dy] = b.door;
    if (grid[dy] && grid[dy][dx] !== undefined) grid[dy][dx] = 0;
  }
  return grid;
}

/**
 * The same split as public/mapping.mjs, plus the Skill family the city needs.
 * Copied rather than imported so this file stays import-free.
 */
function toolFamily(name = '') {
  if (/^(Edit|Write|NotebookEdit|MultiEdit)$/.test(name)) return 'file';
  if (/^(Read|Grep|Glob|LSP)$/.test(name)) return 'read';
  if (/^(Bash|PowerShell)$/.test(name)) return 'shell';
  if (/^(WebFetch|WebSearch)$/.test(name) || name.startsWith('mcp__')) return 'web';
  if (/^(Agent|Workflow|Task|SendMessage)$/.test(name)) return 'agent';
  if (name === 'Skill') return 'skill';
  return 'other';
}

/** The first building that lists `family` under `field`, or null. */
function destination(family, field) {
  for (const spec of Object.values(BUILDINGS)) if ((spec[field] || []).includes(family)) return spec.key;
  return null;
}

/** How many citizens `occupancy` reports at a building, from a Map or object. */
function headcount(occupancy, key) {
  if (!occupancy) return 0;
  const raw = typeof occupancy.get === 'function' ? occupancy.get(key) : occupancy[key];
  return Number(raw) || 0;
}

/**
 * Which building a session walks to for a given tool. No tool means idle.
 *
 * `occupancy` is optional: a Map or plain object of building key to how many
 * citizens are already there. Once a destination is holding CROWD of them, a
 * tool whose family has an overflow building goes there instead, so a burst of
 * file edits spills from the forge into the workshop rather than stacking name
 * plates on one door. Called with one argument it behaves exactly as before.
 */
export function buildingFor(toolName, occupancy) {
  const family = toolName && toolName !== 'idle' ? toolFamily(toolName) : 'idle';
  const home = destination(family, 'for');
  if (!home) return FALLBACK_KEY;
  if (headcount(occupancy, home) >= CROWD) {
    const spill = destination(family, 'overflow');
    if (spill) return spill;
  }
  return home;
}

/** Tiled draws isometric objects in tile units scaled by the tile height. */
function objectXY(tx, ty, tileheight) {
  return { x: tx * tileheight, y: ty * tileheight };
}

function intProp(name, value) {
  return { name, type: 'int', value };
}

function strProp(name, value) {
  return { name, type: 'string', value };
}

/**
 * Turn a parsed layout into a Tiled map Phaser can load: one ground tile
 * layer plus object layers for props, buildings and house lots.
 */
export function toTiled(parsed, atlasMeta = TILESET) {
  const { tilewidth, tileheight, frames } = atlasMeta;
  const gid = (frame) => frames.indexOf(frame) + 1;

  const data = [];
  for (let ty = 0; ty < parsed.h; ty++) {
    for (let tx = 0; tx < parsed.w; tx++) {
      data.push(gid(groundFrame(parsed.tiles, tx, ty)));
    }
  }

  let nextId = 1;
  const prop = (name, tx, ty) => {
    const scale = PROP_SCALE[name];
    return {
      id: nextId++,
      name,
      type: 'prop',
      ...objectXY(tx, ty, tileheight),
      width: tileheight,
      height: tileheight,
      rotation: 0,
      visible: true,
      properties: [
        strProp('frame', PROP_FRAME[name]),
        intProp('tx', tx),
        intProp('ty', ty),
        ...(scale === undefined ? [] : [{ name: 'scale', type: 'float', value: scale }]),
      ],
    };
  };

  const props = [];
  for (let ty = 0; ty < parsed.h; ty++) {
    for (let tx = 0; tx < parsed.w; tx++) {
      const name = parsed.tiles[ty][tx];
      if (PROPS.has(name)) props.push(prop(name, tx, ty));
    }
  }
  // Park furniture the drawing has no glyph for: a bench on either side of
  // every fountain, level with the top of its lot.
  for (const b of parsed.buildings) {
    if (b.key !== 'fountain') continue;
    for (const tx of [b.tx - 1, b.tx + b.w]) {
      if (tx >= 0 && tx < parsed.w) props.push(prop('bench', tx, b.ty));
    }
  }

  // A city places some buildings more than once, so an object's `name` is
  // unique (`apartment`, `apartment#2`, ...) and the frame it draws is the
  // `key` property. The first of each keeps the bare key, so anything that
  // looks a building up by name still finds it.
  const seen = new Map();
  const uniqueName = (key) => {
    const nth = (seen.get(key) || 0) + 1;
    seen.set(key, nth);
    return nth === 1 ? key : `${key}#${nth}`;
  };

  const lotObject = (b, extra = []) => ({
    id: nextId++,
    name: uniqueName(b.key),
    type: b.letter === 'h' ? 'house' : 'building',
    ...objectXY(b.tx, b.ty, tileheight),
    width: b.w * tileheight,
    height: b.h * tileheight,
    rotation: 0,
    visible: true,
    properties: [
      strProp('key', b.key),
      strProp('letter', b.letter),
      intProp('tx', b.tx),
      intProp('ty', b.ty),
      intProp('w', b.w),
      intProp('h', b.h),
      intProp('doorTx', b.door[0]),
      intProp('doorTy', b.door[1]),
      ...extra,
    ],
  });

  const buildings = parsed.buildings.map((b) => lotObject(b));
  const houses = parsed.houses.map((b, i) => lotObject(b, [intProp('index', i)]));

  const columns = frames.length;
  return {
    backgroundcolor: WATER_COLOR,
    compressionlevel: -1,
    height: parsed.h,
    infinite: false,
    nextlayerid: 5,
    nextobjectid: nextId,
    orientation: 'isometric',
    renderorder: 'right-down',
    tiledversion: '1.10.2',
    tileheight,
    tilewidth,
    type: 'map',
    version: '1.10',
    width: parsed.w,
    tilesets: [{
      columns,
      firstgid: 1,
      image: atlasMeta.image,
      imageheight: tileheight,
      imagewidth: columns * tilewidth,
      margin: 0,
      name: atlasMeta.name,
      spacing: 0,
      tilecount: frames.length,
      tileheight,
      tilewidth,
    }],
    layers: [
      { id: 1, name: 'ground', type: 'tilelayer', x: 0, y: 0, width: parsed.w, height: parsed.h, opacity: 1, visible: true, data },
      objectLayer(2, 'props', props),
      objectLayer(3, 'buildings', buildings),
      objectLayer(4, 'houses', houses),
    ],
  };
}

function objectLayer(id, name, objects) {
  return { id, name, type: 'objectgroup', draworder: 'topdown', x: 0, y: 0, opacity: 1, visible: true, objects };
}

/**
 * The tileset frame a ground cell draws. Roads auto-tile; a paved cell with
 * no road beside it is an open plaza rather than a kerbed sidewalk; water is
 * left empty so the map's background colour shows through.
 */
function groundFrame(tiles, tx, ty) {
  const name = tiles[ty][tx];
  if (name === 'road') return roadTileFor(tiles, tx, ty);
  if (name === 'water') return null;
  if (name !== 'sidewalk') return 'grass';
  const touchesRoad = [[tx + 1, ty], [tx - 1, ty], [tx, ty + 1], [tx, ty - 1]]
    .some(([x, y]) => tiles[y] && tiles[y][x] === 'road');
  return touchesRoad ? 'sidewalk' : 'path';
}
