import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  makeImage,
  chromaKey,
  erodeAlpha,
  gridCells,
  gapCells,
  trimBox,
  faceBox,
  plateBox,
  splitAtWidestGap,
  crop,
  pixelPitch,
  downscale,
  resample,
  tint,
  packAtlas,
  isGrassLike,
  unionRoad,
  maskHalf,
} from '../lib/art.mjs';

const MAGENTA = [255, 0, 255];
const TERRACOTTA = [224, 105, 75];
const BLACK = [43, 38, 32];
const SONNET = [59, 110, 165];

/** Build an image from an ASCII map plus a legend of `char -> [r,g,b,a]`. */
function fromAscii(rowStrings, legend) {
  const height = rowStrings.length;
  const width = rowStrings[0].length;
  const img = makeImage(width, height);
  for (let y = 0; y < height; y++) {
    assert.equal(rowStrings[y].length, width, 'ascii rows must be equal length');
    for (let x = 0; x < width; x++) {
      const [r, g, b, a = 255] = legend[rowStrings[y][x]];
      const i = (y * width + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = a;
    }
  }
  return img;
}

function px(img, x, y) {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

function alphaAt(img, x, y) {
  return img.data[(y * img.width + x) * 4 + 3];
}

// 8x4: magenta background with a 2x2 terracotta block at (2,1).
const SHEET = () =>
  fromAscii(
    [
      'MMMMMMMM',
      'MMTTMMMM',
      'MMTTMMMM',
      'MMMMMMMM',
    ],
    { M: [...MAGENTA, 255], T: [...TERRACOTTA, 255] },
  );

test('chromaKey zeroes alpha for magenta-ish pixels only', () => {
  const img = SHEET();
  // nudge one background pixel off pure magenta: still within tolerance.
  const i = (0 * 8 + 0) * 4;
  img.data[i] = 240;
  img.data[i + 1] = 14;
  img.data[i + 2] = 241;

  const out = chromaKey(img, MAGENTA, 60);
  assert.equal(out, img, 'chromaKey mutates and returns the same image');

  assert.equal(alphaAt(img, 0, 0), 0, 'near-magenta is keyed out');
  assert.equal(alphaAt(img, 7, 3), 0, 'pure magenta is keyed out');
  assert.equal(alphaAt(img, 2, 1), 255, 'terracotta survives');
  assert.equal(alphaAt(img, 3, 2), 255, 'terracotta survives');
  assert.deepEqual(px(img, 2, 1), [...TERRACOTTA, 255], 'kept pixels are untouched');
  assert.deepEqual(px(img, 0, 0), [0, 0, 0, 0], 'keyed pixels lose their colour too');
});

test('chromaKey leaves palette colours alone at a wide tolerance', () => {
  const img = fromAscii(['TPGIM'], {
    T: [...TERRACOTTA, 255],
    P: [251, 247, 239, 255], // paper
    G: [143, 207, 107, 255], // grass
    I: [...BLACK, 255], // ink
    M: [...MAGENTA, 255],
  });
  chromaKey(img, MAGENTA, 120);
  assert.deepEqual(
    [0, 1, 2, 3].map((x) => alphaAt(img, x, 0)),
    [255, 255, 255, 255],
    'no palette colour is within 120 of magenta',
  );
  assert.equal(alphaAt(img, 4, 0), 0);
});

test('erodeAlpha peels one pixel off the silhouette per pass', () => {
  const img = fromAscii(
    [
      'OOOO',
      'OOOO',
      'OOOO',
      'OOOO',
    ],
    { O: [10, 20, 30, 255] },
  );
  erodeAlpha(img, 1);
  // Only the 2x2 core survives; the border touched the image edge.
  assert.equal(alphaAt(img, 0, 0), 0);
  assert.equal(alphaAt(img, 3, 3), 0);
  assert.equal(alphaAt(img, 1, 1), 255);
  assert.equal(alphaAt(img, 2, 2), 255);
});

test('gridCells returns equal row-major cells', () => {
  const img = SHEET();
  const cells = gridCells(img, 2, 1);
  assert.deepEqual(cells, [
    { x: 0, y: 0, w: 4, h: 4 },
    { x: 4, y: 0, w: 4, h: 4 },
  ]);

  const quad = gridCells(makeImage(8, 4), 2, 2);
  assert.equal(quad.length, 4);
  assert.deepEqual(quad[1], { x: 4, y: 0, w: 4, h: 2 }, 'row-major order');
  assert.deepEqual(quad[2], { x: 0, y: 2, w: 4, h: 2 });
});

test('gapCells splits on the background gutter, not the midpoint', () => {
  // Two blobs with the gutter at x=6..7, far from the 5px midpoint.
  const img = fromAscii(
    [
      'AAAAA..BBB',
      'AAAAA..BBB',
    ],
    { A: [1, 2, 3, 255], B: [4, 5, 6, 255], '.': [0, 0, 0, 0] },
  );
  const cells = gapCells(img, 2, 1);
  assert.equal(cells.length, 2);
  assert.equal(cells[0].x, 0);
  assert.equal(cells[0].w, 6, 'the boundary lands in the gutter, keeping blob A whole');
  assert.equal(cells[1].x, 6);
  assert.equal(cells[1].w, 4);
  assert.deepEqual(trimBox(img, cells[0]), { x: 0, y: 0, w: 5, h: 2 });
  assert.deepEqual(trimBox(img, cells[1]), { x: 7, y: 0, w: 3, h: 2 });
});

test('gapCells finds a column gutter that only exists inside one row', () => {
  // Row 0's right blob and row 1's right blob start at different columns, so
  // no column is empty over the whole sheet; each row still has its own gap.
  const img = fromAscii(
    [
      'AAAAAA..BB',
      'AAAAAA..BB',
      'CC....DDDD',
      'CC....DDDD',
    ],
    {
      A: [1, 2, 3, 255],
      B: [4, 5, 6, 255],
      C: [7, 8, 9, 255],
      D: [10, 11, 12, 255],
      '.': [0, 0, 0, 0],
    },
  );
  const cells = gapCells(img, 2, 2);
  assert.equal(cells.length, 4);
  // Each blob survives whole, which an equal split at x=5 would not manage.
  assert.deepEqual(trimBox(img, cells[0]), { x: 0, y: 0, w: 6, h: 2 });
  assert.deepEqual(trimBox(img, cells[1]), { x: 8, y: 0, w: 2, h: 2 });
  assert.deepEqual(trimBox(img, cells[2]), { x: 0, y: 2, w: 2, h: 2 });
  assert.deepEqual(trimBox(img, cells[3]), { x: 6, y: 2, w: 4, h: 2 });
});

test('gapCells falls back to equal cells when there is no gutter', () => {
  const img = fromAscii(['AAAAAAAA', 'AAAAAAAA'], { A: [1, 2, 3, 255] });
  assert.deepEqual(gapCells(img, 2, 1), gridCells(img, 2, 1));
});

test('trimBox finds the non-transparent block inside a cell', () => {
  const img = chromaKey(SHEET(), MAGENTA, 60);
  assert.deepEqual(trimBox(img, { x: 0, y: 0, w: 8, h: 4 }), { x: 2, y: 1, w: 2, h: 2 });
  assert.equal(trimBox(img, { x: 4, y: 0, w: 4, h: 4 }), null, 'an empty cell trims to null');
});

test('faceBox keeps the isometric top face and drops the slab', () => {
  // Silhouette widths 3,5,7,7,7,5,3 -> widest row first appears at index 2.
  const img = fromAscii(
    [
      '..OOO..',
      '.OOOOO.',
      'OOOOOOO',
      'OOOOOOO',
      'OOOOOOO',
      '.OOOOO.',
      '..OOO..',
    ],
    { O: [9, 9, 9, 255], '.': [0, 0, 0, 0] },
  );
  const box = trimBox(img, { x: 0, y: 0, w: 7, h: 7 });
  assert.deepEqual(faceBox(img, box), { x: 0, y: 0, w: 7, h: 5 });
});

test('faceBox returns the box unchanged when there is no taper', () => {
  const img = fromAscii(['OOO', 'OOO'], { O: [9, 9, 9, 255] });
  const box = { x: 0, y: 0, w: 3, h: 2 };
  assert.deepEqual(faceBox(img, box), box);
});

test('plateBox drops a bottom name plate', () => {
  // A tapering building over a wide, constant-width plate.
  const img = fromAscii(
    [
      '..OOOOOO..',
      '.OOOOOOOO.',
      '...OOOO...',
      '....OO....',
      'PPPPPPPPPP',
      'PPPPPPPPPP',
      'PPPPPPPPPP',
    ],
    { O: [9, 9, 9, 255], P: [200, 200, 200, 255], '.': [0, 0, 0, 0] },
  );
  const box = trimBox(img, { x: 0, y: 0, w: 10, h: 7 });
  assert.deepEqual(box, { x: 0, y: 0, w: 10, h: 7 });
  assert.deepEqual(plateBox(img, box), { x: 0, y: 0, w: 10, h: 4 });
});

test('plateBox falls back to a fixed fraction when no plate is detected', () => {
  const img = fromAscii(
    [
      'OOOOOOOOOO',
      'OOOOOOOOOO',
      'OOOOOOOOOO',
      'OOOOOOOOOO',
      'OOOOOOOOOO',
      'OOOOOOOOOO',
      'OOOOOOOOOO',
      'OOOOOOOOOO',
      'OOOOOOOOOO',
      'OOOOOOOOOO',
    ],
    { O: [9, 9, 9, 255] },
  );
  const box = { x: 0, y: 0, w: 10, h: 10 };
  assert.deepEqual(plateBox(img, box, 0.2), { x: 0, y: 0, w: 10, h: 8 });
});

test('splitAtWidestGap cuts one cell into two boxes', () => {
  const img = fromAscii(
    [
      'AA.A...BB.',
      'AA.A...BB.',
    ],
    { A: [1, 2, 3, 255], B: [4, 5, 6, 255], '.': [0, 0, 0, 0] },
  );
  const parts = splitAtWidestGap(img, { x: 0, y: 0, w: 10, h: 2 });
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0], { x: 0, y: 0, w: 4, h: 2 }, 'left part keeps both A runs');
  assert.deepEqual(parts[1], { x: 7, y: 0, w: 2, h: 2 });
});

test('splitAtWidestGap returns null when the box has no interior gap', () => {
  const img = fromAscii(['AAAA'], { A: [1, 2, 3, 255] });
  assert.equal(splitAtWidestGap(img, { x: 0, y: 0, w: 4, h: 1 }), null);
});

test('crop copies the box into a new image', () => {
  const img = chromaKey(SHEET(), MAGENTA, 60);
  const out = crop(img, { x: 2, y: 1, w: 2, h: 2 });
  assert.equal(out.width, 2);
  assert.equal(out.height, 2);
  assert.notEqual(out.data, img.data, 'crop does not alias the source buffer');
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 2; x++) assert.deepEqual(px(out, x, y), [...TERRACOTTA, 255]);
  }
});

test('pixelPitch reports the size of the art big pixels', () => {
  const blocks = fromAscii(
    [
      'AABB',
      'AABB',
      'CCDD',
      'CCDD',
    ],
    {
      A: [10, 0, 0, 255],
      B: [0, 10, 0, 255],
      C: [0, 0, 10, 255],
      D: [10, 10, 0, 255],
    },
  );
  assert.equal(pixelPitch(blocks, { x: 0, y: 0, w: 4, h: 4 }), 2);

  const fine = fromAscii(['ABAB', 'BABA'], { A: [10, 0, 0, 255], B: [0, 10, 0, 255] });
  assert.equal(pixelPitch(fine, { x: 0, y: 0, w: 4, h: 2 }), 1);
});

test('pixelPitch ignores transparent runs and clamps to 16', () => {
  const img = fromAscii(
    [
      '................AA',
      '................AA',
    ],
    { A: [10, 0, 0, 255], '.': [0, 0, 0, 0] },
  );
  assert.equal(pixelPitch(img, { x: 0, y: 0, w: 18, h: 2 }), 2);
});

test('downscale by an integer factor keeps the block colours', () => {
  const blocks = fromAscii(
    [
      'AABB',
      'AABB',
      'CCDD',
      'CCDD',
    ],
    {
      A: [10, 0, 0, 255],
      B: [0, 10, 0, 255],
      C: [0, 0, 10, 255],
      D: [10, 10, 0, 255],
    },
  );
  const out = downscale(blocks, 2);
  assert.equal(out.width, 2);
  assert.equal(out.height, 2);
  assert.deepEqual(px(out, 0, 0), [10, 0, 0, 255]);
  assert.deepEqual(px(out, 1, 0), [0, 10, 0, 255]);
  assert.deepEqual(px(out, 0, 1), [0, 0, 10, 255]);
  assert.deepEqual(px(out, 1, 1), [10, 10, 0, 255]);
  assert.equal(downscale(blocks, 1), blocks, 'factor 1 is a no-op');
});

test('resample hits an exact size without blending colours', () => {
  const img = fromAscii(
    [
      'AAAABBBB',
      'AAAABBBB',
      'AAAABBBB',
      'AAAABBBB',
    ],
    { A: [10, 0, 0, 255], B: [0, 10, 0, 255] },
  );
  const out = resample(img, 4, 2);
  assert.equal(out.width, 4);
  assert.equal(out.height, 2);
  const seen = new Set();
  for (let y = 0; y < 2; y++) for (let x = 0; x < 4; x++) seen.add(px(out, x, y).join(','));
  assert.deepEqual([...seen].sort(), ['0,10,0,255', '10,0,0,255'], 'only source colours appear');
  assert.deepEqual(px(out, 0, 0), [10, 0, 0, 255]);
  assert.deepEqual(px(out, 3, 1), [0, 10, 0, 255]);
});

test('tint recolours the body and leaves everything else alone', () => {
  const img = fromAscii(
    [
      'TTI',
      'TTP',
      '..T',
    ],
    {
      T: [...TERRACOTTA, 255],
      I: [...BLACK, 255],
      P: [251, 247, 239, 255],
      '.': [0, 0, 0, 0],
    },
  );
  const out = tint(img, TERRACOTTA, SONNET, 70);
  assert.notEqual(out, img, 'tint returns a new image');
  assert.deepEqual(px(img, 0, 0), [...TERRACOTTA, 255], 'source is not mutated');
  assert.deepEqual(px(out, 0, 0), [...SONNET, 255]);
  assert.deepEqual(px(out, 2, 2), [...SONNET, 255]);
  assert.deepEqual(px(out, 2, 0), [...BLACK, 255], 'ink outline untouched');
  assert.deepEqual(px(out, 2, 1), [251, 247, 239, 255], 'paper untouched');
  assert.deepEqual(px(out, 0, 2), [0, 0, 0, 0], 'transparent untouched');
});

test('tint keeps shading by shifting matched pixels by the same delta', () => {
  const img = fromAscii(['TS'], {
    T: [...TERRACOTTA, 255],
    S: [214, 95, 65, 255], // a slightly darker shade of the body
  });
  const out = tint(img, TERRACOTTA, SONNET, 70);
  assert.deepEqual(px(out, 0, 0), [...SONNET, 255]);
  assert.deepEqual(px(out, 1, 0), [49, 100, 155, 255], 'the darker shade stays 10 darker');
});

test('packAtlas lays frames out without overlap and emits Phaser JSONHash', () => {
  const mk = (rgb) => {
    const img = makeImage(3, 3);
    for (let i = 0; i < 9; i++) {
      img.data[i * 4] = rgb[0];
      img.data[i * 4 + 1] = rgb[1];
      img.data[i * 4 + 2] = rgb[2];
      img.data[i * 4 + 3] = 255;
    }
    return img;
  };
  const { img, json } = packAtlas([
    { name: 'one', img: mk([10, 0, 0]) },
    { name: 'two', img: mk([0, 10, 0]) },
  ]);

  assert.ok(img.width >= 7, `atlas is at least 7px wide, got ${img.width}`);
  assert.ok(img.height >= 3);

  const a = json.frames.one.frame;
  const b = json.frames.two.frame;
  const overlap =
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  assert.equal(overlap, false, 'frame boxes do not overlap');
  assert.deepEqual([a.w, a.h, b.w, b.h], [3, 3, 3, 3]);

  for (const name of ['one', 'two']) {
    const f = json.frames[name];
    assert.equal(f.rotated, false);
    assert.equal(f.trimmed, false);
    assert.deepEqual(f.spriteSourceSize, { x: 0, y: 0, w: 3, h: 3 });
    assert.deepEqual(f.sourceSize, { w: 3, h: 3 });
  }
  assert.deepEqual(json.meta.size, { w: img.width, h: img.height });
  assert.equal(json.meta.scale, 1);
  assert.equal(typeof json.meta.image, 'string');

  // pixels really landed where the json says they did
  const at = (x, y) => px(img, x, y);
  assert.deepEqual(at(a.x, a.y), [10, 0, 0, 255]);
  assert.deepEqual(at(b.x, b.y), [0, 10, 0, 255]);
});

test('packAtlas separates neighbouring frames by transparent padding', () => {
  const solid = (w, h) => {
    const img = makeImage(w, h);
    img.data.fill(255);
    return img;
  };
  const { img, json } = packAtlas([
    { name: 'a', img: solid(4, 4) },
    { name: 'b', img: solid(4, 4) },
    { name: 'c', img: solid(4, 4) },
  ]);
  const boxes = Object.values(json.frames).map((f) => f.frame);
  for (const box of boxes) {
    assert.ok(box.x >= 1 && box.y >= 1, 'frames are inset from the atlas edge');
    assert.ok(box.x + box.w <= img.width && box.y + box.h <= img.height);
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const gapX = a.x + a.w <= b.x - 1 || b.x + b.w <= a.x - 1;
      const gapY = a.y + a.h <= b.y - 1 || b.y + b.h <= a.y - 1;
      assert.ok(gapX || gapY, 'at least 1px of padding between every pair');
    }
  }
});

test('tint leaves the ink outline untouched on a character-shaped frame', () => {
  // A body of terracotta, outlined in ink, with a paper head and grey boots -
  // the same colours the character sheet is drawn in.
  const rows = [
    '..III..',
    '.IPPPI.',
    'ITTTTTI',
    'ITTTTTI',
    'I.GGG.I',
    '..III..',
  ];
  const img = fromAscii(rows, {
    I: [...BLACK, 255],
    P: [251, 247, 239, 255],
    T: [...TERRACOTTA, 255],
    G: [185, 179, 168, 255],
    '.': [0, 0, 0, 0],
  });
  const out = tint(img, TERRACOTTA, SONNET, 70);

  let inked = 0;
  let tinted = 0;
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[0].length; x++) {
      const before = px(img, x, y);
      const after = px(out, x, y);
      if (rows[y][x] === 'I') {
        assert.deepEqual(after, [...BLACK, 255], `ink at ${x},${y} must not move`);
        inked++;
      } else if (rows[y][x] === 'T') {
        assert.deepEqual(after, [...SONNET, 255]);
        tinted++;
      } else {
        assert.deepEqual(after, before, `non-body pixel at ${x},${y} must not move`);
      }
    }
  }
  assert.equal(inked, 14, 'the outline really is in the fixture');
  assert.equal(tinted, 10, 'the body really is in the fixture');
});

test('the character atlas ships a tinted variant of every pose', () => {
  const atlasDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'public',
    'assets',
    'atlas',
  );
  const json = JSON.parse(fs.readFileSync(path.join(atlasDir, 'character.json'), 'utf8'));
  const poses = [
    'idle_front',
    'idle_side',
    'walk1',
    'walk2',
    'walk3',
    'walk4',
    'work_hammer',
    'work_read',
  ];
  const families = ['fable', 'opus', 'sonnet', 'haiku', 'unknown'];

  assert.ok(json.frames.walk3_haiku, 'walk3_haiku is in the atlas');
  for (const pose of poses) {
    assert.ok(json.frames[pose], `${pose} keeps its untinted frame`);
    for (const family of families) {
      const frame = json.frames[`${pose}_${family}`];
      assert.ok(frame, `${pose}_${family} is in the atlas`);
      assert.deepEqual(
        [frame.frame.w, frame.frame.h],
        [json.frames[pose].frame.w, json.frames[pose].frame.h],
        `${pose}_${family} is the same size as ${pose}`,
      );
    }
  }
  assert.equal(Object.keys(json.frames).length, poses.length * (families.length + 1));

  const extra = JSON.parse(fs.readFileSync(path.join(atlasDir, 'character_extra.json'), 'utf8'));
  assert.ok(extra.frames.sit_opus, 'sit_opus is in the atlas');
  for (const pose of ['sit', 'chop', 'work_terminal', 'work_radio', 'work_flag', 'sleep']) {
    assert.ok(extra.frames[pose], `${pose} keeps its untinted frame`);
    for (const family of families) {
      assert.ok(extra.frames[`${pose}_${family}`], `${pose}_${family} is in the atlas`);
    }
  }
  // The guards wear grey, so they ship untinted and with no family variants.
  for (const guard of ['guard_idle', 'guard_run']) {
    assert.ok(extra.frames[guard], `${guard} is in the atlas`);
    for (const family of families) {
      assert.equal(
        extra.frames[`${guard}_${family}`],
        undefined,
        `${guard}_${family} must not be emitted`,
      );
    }
  }

  const vehicles = JSON.parse(fs.readFileSync(path.join(atlasDir, 'city_vehicles.json'), 'utf8'));
  assert.deepEqual(
    Object.keys(vehicles.frames).sort(),
    ['car_ne', 'car_nw', 'car_se', 'car_sw', 'truck_ne', 'truck_nw', 'truck_se', 'truck_sw'],
    'the vehicles atlas has one frame per heading and nothing else',
  );
  for (const gone of ['char_sit', 'char_chop', 'guard_idle', 'guard_run']) {
    assert.equal(vehicles.frames[gone], undefined, `${gone} is no longer in the vehicles atlas`);
  }
});

test('packAtlas of no frames returns a 1x1 image', () => {
  const { img, json } = packAtlas([]);
  assert.equal(img.width, 1);
  assert.equal(img.height, 1);
  assert.deepEqual(json.frames, {});
});

const ROAD_LEGEND = {
  g: [120, 200, 100],   // verge
  a: [60, 60, 60],      // asphalt
  k: [190, 180, 160],   // kerb
  '.': [0, 0, 0, 0],    // transparent
};

/** Read an image back as one character per pixel, using the same legend. */
function toAscii(img, legend) {
  const rows = [];
  for (let y = 0; y < img.height; y++) {
    let row = '';
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      const match = Object.entries(legend).find(([, [r, g, b, a = 255]]) => (
        a === 0 ? img.data[i + 3] === 0 : img.data[i] === r && img.data[i + 1] === g && img.data[i + 2] === b
      ));
      row += match ? match[0] : '?';
    }
    rows.push(row);
  }
  return rows;
}

test('isGrassLike only accepts a green-dominant pixel', () => {
  assert.equal(isGrassLike([120, 200, 100]), true);
  assert.equal(isGrassLike([60, 60, 60]), false);
  assert.equal(isGrassLike([190, 180, 160]), false);
  assert.equal(isGrassLike([100, 115, 100]), false, '15 apart is not dominant enough');
});

test('unionRoad lays the second tile road over the first and keeps its verge', () => {
  const a = fromAscii(['ggaa', 'ggaa'], ROAD_LEGEND);
  const b = fromAscii(['gkag', '..ag'], ROAD_LEGEND);
  //  b's kerb and asphalt win; its verge and its transparent pixels do not.
  assert.deepEqual(toAscii(unionRoad(a, b), ROAD_LEGEND), ['gkaa', 'ggaa']);
});

test('unionRoad refuses images of different sizes', () => {
  assert.throws(
    () => unionRoad(makeImage(4, 2), makeImage(4, 3)),
    /matching sizes/,
  );
});

/** A white 64x32 tile and a green one to back the half that is thrown away. */
function halfFixture() {
  const road = makeImage(64, 32);
  road.data.fill(255);
  const ground = makeImage(64, 32);
  for (let i = 0; i < ground.data.length; i += 4) {
    ground.data[i + 1] = 200;
    ground.data[i + 3] = 255;
  }
  return { road, ground };
}

/** How many pixels of a masked tile are still road, and how many are ground. */
function countHalf(out) {
  let kept = 0;
  let replaced = 0;
  for (let i = 0; i < out.data.length; i += 4) {
    if (out.data[i] === 255) kept++;
    else if (out.data[i + 1] === 200) replaced++;
  }
  return { kept, replaced };
}

test('maskHalf keeps half the tile and backs the rest with the ground', () => {
  const { road, ground } = halfFixture();
  for (const side of ['ne', 'nw', 'se', 'sw']) {
    const { kept, replaced } = countHalf(maskHalf(road, side, ground));
    assert.equal(kept + replaced, 64 * 32, `${side} left pixels that are neither`);
    const share = kept / (kept + replaced);
    assert.ok(share > 0.48 && share < 0.52, `${side} kept ${(share * 100).toFixed(1)}% of the tile`);
  }
});

test('opposite halves of a tile partition it exactly and rejoin into the whole', () => {
  const { road, ground } = halfFixture();
  for (const [a, b] of [['ne', 'sw'], ['nw', 'se']]) {
    const first = maskHalf(road, a, ground);
    const second = maskHalf(road, b, ground);
    for (let i = 0; i < road.data.length; i += 4) {
      const inFirst = first.data[i] === 255;
      const inSecond = second.data[i] === 255;
      assert.notEqual(inFirst, inSecond, `pixel ${i / 4} is in both or neither of ${a} and ${b}`);
    }
    const joined = unionRoad(first, second);
    for (let i = 0; i < joined.data.length; i += 4) {
      assert.equal(joined.data[i], 255, `pixel ${i / 4} lost its road rejoining ${a} and ${b}`);
    }
  }
});

test('maskHalf rejects an unknown side and a mismatched ground', () => {
  const tile = makeImage(64, 32);
  assert.throws(() => maskHalf(tile, 'up', makeImage(64, 32)), /unknown side up/);
  assert.throws(() => maskHalf(tile, 'ne', makeImage(32, 16)), /ground tile of 64x32/);
});
