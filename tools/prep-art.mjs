#!/usr/bin/env node
/**
 * Turn the generated sprite sheets in public/assets/raw into Phaser atlases
 * in public/assets/atlas.
 *
 * Each sheet is a flat magenta background with a grid of sprites on it. The
 * pipeline keys the magenta out, erodes the blend ring it leaves behind,
 * finds the cells by their empty gutters, trims each sprite, and shrinks it
 * to the game's scale with nearest-neighbour sampling so the edges stay hard.
 *
 * Run with `npm run art:prep`. The atlases are committed, so this only needs
 * running when a raw sheet changes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import {
  chromaKey,
  crop,
  downscale,
  erodeAlpha,
  faceBox,
  gapCells,
  maskHalf,
  packAtlas,
  pixelPitch,
  plateBox,
  resample,
  splitAtWidestGap,
  tint,
  trimBox,
  unionRoad,
} from '../lib/art.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW_DIR = path.join(ROOT, 'public', 'assets', 'raw');
const OUT_DIR = path.join(ROOT, 'public', 'assets', 'atlas');

/** The background every sheet was generated on. */
const KEY = [255, 0, 255];
/**
 * Wide enough to take the blended ring the generator leaves around the art.
 * The nearest colour in the sheets that must survive is the fountain's blue
 * at 194 away, so 160 clears the halo with room to spare. At 120 two mauve
 * pixels made it into the atlases.
 */
const KEY_TOL = 160;
/** One more pixel off the silhouette, to be sure no fringe survives. */
const ERODE = 1;

/** The isometric floor grid. Tile sheets are forced to exactly this. */
const TILE = [64, 32];

/** The body colour the character sheet was drawn in. */
const BODY = [224, 105, 75];
/**
 * How far from `BODY` still counts as body. The palette's wood (#c98a4b)
 * sits only 40 away, so the 70 the signature defaults to also swallows the
 * anvil crate, the park bench and the tree trunk and recolours them with the
 * shirt. Measured per frame, the body clusters inside 25 and the wood starts
 * at 35, so 30 sits in the valley between them.
 */
const TINT_TOL = 30;
/** Per-family body colours, from DESIGN.md. fable keeps the original. */
const FAMILIES = {
  fable: [224, 105, 75], // #e0694b terracotta
  opus: [201, 138, 75], // #c98a4b wood
  sonnet: [59, 110, 165], // #3b6ea5 blue
  haiku: [185, 179, 168], // #b9b3a8 stone
  unknown: [43, 38, 32], // #2b2620 ink
};

/**
 * Grids were confirmed by measuring the gutters in every sheet and by eye.
 * Two deviations from the generation prompts are handled here: only
 * city_civic_a carries name plates, and city_civic_b draws the tree and the
 * stump in one cell.
 *
 *  - `tile: true`   crop to the isometric top face, resample to 64x32
 *  - `targetH/W`    one shared integer factor per sheet, from the median
 *                   trimmed size, so sprites keep their relative scale
 *  - `cropPlate`    drop the name plate under each building
 *  - `split`        cell index -> the two names to split it into
 *  - `tintFrames`   frames to emit a `<frame>_<family>` variant of, per family;
 *                   `true` means every frame that actually wears the body
 *                   colour, silently passing over the ones that do not
 *
 * A cell named `unused_*` is still cut and measured, so the names stay lined
 * up with the grid, but it is left out of the atlas.
 */

/** Poses on the character sheet. Every one gets a variant per family. */
const CHARACTER_FRAMES = [
  'idle_front',
  'idle_side',
  'walk1',
  'walk2',
  'walk3',
  'walk4',
  'work_hammer',
  'work_read',
];

const SHEETS = {
  tiles: {
    file: 'tiles.png',
    cols: 2,
    rows: 1,
    names: ['grass', 'path'],
    tile: true,
  },
  city_roads: {
    file: 'city_roads.png',
    cols: 4,
    rows: 2,
    // The generated junction cells are dropped and rebuilt from the two
    // straights; see roadJunctions.
    names: [
      'road_ne', 'road_nw',
      'unused_x', 'unused_t_a', 'unused_t_b', 'unused_c_a', 'unused_c_b',
      'sidewalk',
    ],
    tile: true,
    synthRoads: true,
  },
  house: {
    file: 'house.png',
    cols: 1,
    rows: 1,
    names: ['house'],
    targetW: 128,
  },
  stations: {
    file: 'stations.png',
    cols: 4,
    rows: 2,
    names: ['anvil', 'desk', 'terminal', 'dish', 'flagpole', 'doormat', 'crate', 'signpost'],
    targetH: 40,
  },
  city_civic_a: {
    file: 'city_civic_a.png',
    cols: 3,
    rows: 2,
    names: ['library', 'forge', 'server_hall', 'radio_tower', 'town_hall', 'guard_post'],
    targetW: 160,
    cropPlate: true,
  },
  city_civic_b: {
    file: 'city_civic_b.png',
    cols: 3,
    rows: 2,
    names: ['bank', 'school', 'water_tower', 'fountain', 'bench', 'tree_stump'],
    targetW: 160,
    split: { 5: ['tree', 'stump'] },
  },
  city_extra_a: {
    file: 'city_extra_a.png',
    cols: 3,
    rows: 2,
    names: ['cafe', 'bakery', 'market_stall', 'warehouse', 'apartment', 'clinic'],
    targetW: 160,
  },
  city_extra_b: {
    file: 'city_extra_b.png',
    cols: 3,
    rows: 2,
    names: ['windmill', 'greenhouse', 'bell_tower', 'workshop', 'inn', 'observatory'],
    targetW: 160,
  },
  city_decor: {
    file: 'city_decor.png',
    cols: 4,
    rows: 3,
    // `fence_ne` is the rail that runs down-right on screen, along the tx axis;
    // `fence_nw` runs up-right, along ty. The names come from the sheet.
    names: [
      'lamp', 'fence_ne', 'fence_nw', 'mailbox',
      'well', 'cart', 'barrels', 'flowers',
      'hedge', 'oak', 'pine', 'rocks',
    ],
    // Street furniture shares a tile with the ground under it, so it is drawn
    // nearer the 32px tile height than the 28 the smaller props would take.
    targetH: 40,
  },
  city_vehicles: {
    // One frame per compass heading. The first sheet drew both "directions"
    // facing the same way, so cars flipped onto the wrong diagonal.
    file: 'city_vehicles_4dir.png',
    cols: 4,
    rows: 2,
    names: ['car_se', 'car_sw', 'car_ne', 'car_nw', 'truck_se', 'truck_sw', 'truck_ne', 'truck_nw'],
    targetH: 32,
  },
  character: {
    file: 'character.png',
    cols: 4,
    rows: 2,
    names: CHARACTER_FRAMES,
    targetH: 32,
    tintFrames: CHARACTER_FRAMES,
  },
  character_extra: {
    file: 'character_extra.png',
    cols: 4,
    rows: 2,
    names: ['sit', 'chop', 'guard_idle', 'guard_run', 'work_terminal', 'work_radio', 'work_flag', 'sleep'],
    targetH: 32,
    // The chop frame carries a whole pine tree, so it is much taller than the
    // character. The sheet factor comes from the 75th percentile, which leaves
    // it out, so chop is scaled by the character's height like everything else.
    tintFrames: true,
  },
  critter: {
    file: 'critter.png',
    cols: 2,
    rows: 1,
    names: ['critter1', 'critter2'],
    targetH: 12,
  },
};

function readSheet(file) {
  const png = PNG.sync.read(fs.readFileSync(path.join(RAW_DIR, file)));
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
}

function writePng(img, file) {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length);
  fs.writeFileSync(file, PNG.sync.write(png));
}

/**
 * Nearest-rank percentile. The sheet factor is taken from the 75th: the
 * target size describes the biggest sprite on the sheet, but the plain
 * maximum is dragged around by outliers (char_chop drags a whole tree into
 * frame, the split tree and stump are much smaller than the buildings).
 */
function percentile(values, p) {
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
  return sorted[rank - 1];
}

/** How many pixels differ between two images of the same size. */
function countChanged(a, b) {
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      a.data[i] !== b.data[i] ||
      a.data[i + 1] !== b.data[i + 1] ||
      a.data[i + 2] !== b.data[i + 2]
    ) {
      n++;
    }
  }
  return n;
}

/** The plain grass tile, kept aside to back the synthesized road junctions. */
let groundTile = null;

/**
 * Build every road junction out of the two straights instead of using the
 * generated ones.
 *
 * The generator drew its crossroad, T and corner cells with the asphalt
 * running to the diamond's four corners, a 45 degree turn away from the
 * straights, whose asphalt runs edge to edge. Laid next to each other the two
 * never met. Unioning the straights keeps one set of geometry, so a junction's
 * asphalt leaves through exactly the edges its neighbours arrive at.
 *
 * Names use the grid compass, where n is -ty, s is +ty, w is -tx and e is +tx.
 * `road_ne` is the straight along ty (the n-s street) and `road_nw` the
 * straight along tx (the w-e street); their halves are named for the screen
 * diagonal they occupy, which is what maskHalf takes.
 */
function roadJunctions(frames) {
  const find = (name) => {
    const frame = frames.find((f) => f.name === name);
    if (!frame) throw new Error(`cannot synthesize junctions without ${name}`);
    return frame.img;
  };
  const ns = find('road_ne');
  const we = find('road_nw');
  const half = (img, side) => maskHalf(img, side, groundTile);
  const stub = { n: half(ns, 'ne'), s: half(ns, 'sw'), w: half(we, 'nw'), e: half(we, 'se') };
  return [
    { name: 'road_x', img: unionRoad(ns, we) },
    // A T is the street that runs through plus the stub that joins it.
    { name: 'road_t_n', img: unionRoad(we, stub.n) },
    { name: 'road_t_s', img: unionRoad(we, stub.s) },
    { name: 'road_t_w', img: unionRoad(ns, stub.w) },
    { name: 'road_t_e', img: unionRoad(ns, stub.e) },
    // A corner is two stubs meeting at the tile centre.
    { name: 'road_c_ne', img: unionRoad(stub.n, stub.e) },
    { name: 'road_c_nw', img: unionRoad(stub.n, stub.w) },
    { name: 'road_c_se', img: unionRoad(stub.s, stub.e) },
    { name: 'road_c_sw', img: unionRoad(stub.s, stub.w) },
  ];
}

/** Cell boxes with their frame names, after plate cropping and splitting. */
function locate(img, sheet) {
  const cells = gapCells(img, sheet.cols, sheet.rows);
  const out = [];
  cells.forEach((cell, i) => {
    let box = trimBox(img, cell);
    if (!box) {
      console.warn(`  ! cell ${i} (${sheet.names[i]}) is empty, skipped`);
      return;
    }
    if (sheet.cropPlate) box = trimBox(img, plateBox(img, box)) ?? box;

    const splitNames = sheet.split?.[i];
    if (splitNames) {
      const parts = splitAtWidestGap(img, box);
      if (!parts) throw new Error(`cell ${i} of ${sheet.file} has no gap to split on`);
      parts.forEach((part, k) => out.push({ name: splitNames[k], box: part }));
      return;
    }
    out.push({ name: sheet.names[i], box });
  });
  return out;
}

function buildSheet(key, sheet) {
  const img = readSheet(sheet.file);
  chromaKey(img, KEY, KEY_TOL);
  erodeAlpha(img, ERODE);

  const located = locate(img, sheet);
  console.log(`${key} (${sheet.file} ${img.width}x${img.height}, ${located.length} frames)`);

  const frames = [];
  if (sheet.tile) {
    for (const { name, box } of located) {
      const face = faceBox(img, box);
      const frame = resample(crop(img, face), TILE[0], TILE[1]);
      frames.push({ name, img: frame });
      if (name === 'grass') groundTile = frame;
      console.log(
        `  ${name.padEnd(13)} ${String(frame.width).padStart(3)}x${String(frame.height).padStart(3)}` +
          `  face ${face.w}x${face.h} of ${box.w}x${box.h}  exact tile`,
      );
    }
    if (sheet.synthRoads) {
      if (!groundTile) throw new Error('the tiles sheet must be built before the roads');
      const built = roadJunctions(frames);
      frames.push(...built);
      console.log(`  ${'junctions'.padEnd(13)} + ${built.length} synthesized from the two straights`);
    }
  } else {
    const byHeight = sheet.targetH != null;
    const target = byHeight ? sheet.targetH : sheet.targetW;
    const sizes = located.map(({ box }) => (byHeight ? box.h : box.w));
    const factor = Math.max(1, Math.round(percentile(sizes, 0.75) / target));

    for (const { name, box } of located) {
      const pitch = pixelPitch(img, box);
      let frame = crop(img, box);
      if (pitch >= 2) frame = downscale(frame, pitch);
      const remaining = Math.max(1, Math.round(factor / pitch));
      frame = downscale(frame, remaining);
      frames.push({ name, img: frame });
      console.log(
        `  ${name.padEnd(13)} ${String(frame.width).padStart(3)}x${String(frame.height).padStart(3)}` +
          `  pitch ${pitch}  factor ${factor}${pitch >= 2 ? ` (${pitch} then ${remaining})` : ''}`,
      );
    }
  }

  // A sprite the city colours by model family carries one variant per family,
  // named `<frame>_<family>`. fable is the colour the sheet was drawn in, so
  // its variant is the original pixels.
  // `tintFrames: true` varies every frame that actually wears the body
  // colour, and passes over the rest in silence - the guard frames are grey,
  // so a family variant of them would be a byte-identical copy. A list names
  // the frames explicitly and is an error if one is missing.
  const auto = sheet.tintFrames === true;
  const wanted = auto ? frames.map((frame) => frame.name) : (sheet.tintFrames ?? []);
  for (const name of wanted) {
    const base = frames.find((frame) => frame.name === name);
    if (!base) throw new Error(`${key} has no frame ${name} to tint`);
    const variants = Object.entries(FAMILIES).map(([family, colour]) => ({
      name: `${name}_${family}`,
      img: family === 'fable' ? base.img : tint(base.img, BODY, colour, TINT_TOL),
    }));
    const recoloured = countChanged(
      base.img,
      variants.find((variant) => variant.name === `${name}_sonnet`).img,
    );
    if (recoloured === 0) {
      if (!auto) {
        console.warn(
          `  ! ${name} has no pixel within ${TINT_TOL} of the body colour, so its ` +
            `family variants would be identical copies - skipped`,
        );
      }
      continue;
    }
    frames.push(...variants);
    console.log(
      `  ${name.padEnd(13)} + ${variants.length} family variants, ${recoloured} px recoloured`,
    );
  }

  const kept = frames.filter((frame) => !frame.name.startsWith('unused_'));
  const { img: atlas, json } = packAtlas(kept);
  json.meta.image = `${key}.png`;
  writePng(atlas, path.join(OUT_DIR, `${key}.png`));
  fs.writeFileSync(path.join(OUT_DIR, `${key}.json`), `${JSON.stringify(json, null, 2)}\n`);
  console.log(`  -> ${key}.png ${atlas.width}x${atlas.height}, ${Object.keys(json.frames).length} frames\n`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [key, sheet] of Object.entries(SHEETS)) buildSheet(key, sheet);

// The scene loads whatever is listed here, so adding a sheet to SHEETS is the
// only step needed to put its art in the city. Written last, from the directory
// itself, so it can never claim a sheet that did not build.
const built = fs.readdirSync(OUT_DIR)
  .filter((f) => f.endsWith('.json') && f !== 'index.json')
  .map((f) => f.slice(0, -5))
  .sort();
fs.writeFileSync(path.join(OUT_DIR, 'index.json'), `${JSON.stringify(built, null, 2)}\n`);
console.log(`index.json lists ${built.length} atlases`);
