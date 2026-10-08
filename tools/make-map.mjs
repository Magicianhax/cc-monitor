#!/usr/bin/env node
/**
 * Build the city map the Phaser scene loads.
 *
 * Three outputs, all committed:
 *   public/assets/tiles.png  the ground frames stitched into one uniform
 *                            64x32 grid, because a Tiled tile layer cannot
 *                            address a packed atlas
 *   public/assets/city.json  the Tiled map generated from lib/citymap.mjs
 *   public/citymap.mjs       a byte-for-byte copy of lib/citymap.mjs so the
 *                            browser gets the same helpers
 *
 * Run with `npm run map:build`. Only needed when the layout or the tile
 * atlases change.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import { LAYOUT, TILESET, parseLayout, toTiled } from '../lib/citymap.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ATLAS_DIR = path.join(ROOT, 'public', 'assets', 'atlas');
const OUT_DIR = path.join(ROOT, 'public', 'assets');

/** Load each atlas the tileset draws from, once. */
function loadAtlases(names) {
  const out = new Map();
  for (const name of names) {
    const meta = JSON.parse(fs.readFileSync(path.join(ATLAS_DIR, `${name}.json`), 'utf8'));
    const png = PNG.sync.read(fs.readFileSync(path.join(ATLAS_DIR, `${name}.png`)));
    out.set(name, { meta, png });
  }
  return out;
}

/** Copy one atlas frame into the strip at cell `index`. */
function blit(strip, src, frame, index, tilewidth, tileheight) {
  if (frame.w !== tilewidth || frame.h !== tileheight) {
    throw new Error(`frame is ${frame.w}x${frame.h}, the tileset grid is ${tilewidth}x${tileheight}`);
  }
  for (let y = 0; y < tileheight; y++) {
    for (let x = 0; x < tilewidth; x++) {
      const from = ((frame.y + y) * src.width + frame.x + x) * 4;
      const to = (y * strip.width + index * tilewidth + x) * 4;
      strip.data[to] = src.data[from];
      strip.data[to + 1] = src.data[from + 1];
      strip.data[to + 2] = src.data[from + 2];
      strip.data[to + 3] = src.data[from + 3];
    }
  }
}

function buildTileset() {
  const { frames, sources, tilewidth, tileheight } = TILESET;
  const atlases = loadAtlases(new Set(Object.values(sources)));
  const strip = new PNG({ width: frames.length * tilewidth, height: tileheight });
  strip.data.fill(0);
  frames.forEach((name, i) => {
    const atlas = atlases.get(sources[name]);
    if (!atlas) throw new Error(`no atlas declared for frame ${name}`);
    const entry = atlas.meta.frames[name];
    if (!entry) throw new Error(`frame ${name} is not in ${sources[name]}.json`);
    blit(strip, atlas.png, entry.frame, i, tilewidth, tileheight);
  });
  const file = path.join(OUT_DIR, TILESET.image);
  fs.writeFileSync(file, PNG.sync.write(strip));
  return { file, width: strip.width, height: strip.height };
}

const tiles = buildTileset();
console.log(`wrote ${path.relative(ROOT, tiles.file)} (${tiles.width}x${tiles.height}, ${TILESET.frames.length} cells)`);

const parsed = parseLayout(LAYOUT);
const mapFile = path.join(OUT_DIR, 'city.json');
fs.writeFileSync(mapFile, `${JSON.stringify(toTiled(parsed), null, 2)}\n`);
console.log(
  `wrote ${path.relative(ROOT, mapFile)} (${parsed.w}x${parsed.h}, `
  + `${parsed.buildings.length} buildings, ${parsed.houses.length} house lots)`,
);

const webCopy = path.join(ROOT, 'public', 'citymap.mjs');
fs.copyFileSync(path.join(ROOT, 'lib', 'citymap.mjs'), webCopy);
console.log(`wrote ${path.relative(ROOT, webCopy)}`);
