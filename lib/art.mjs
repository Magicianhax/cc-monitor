/**
 * Pure sprite-sheet maths for the art pipeline. No imports, no I/O.
 *
 * An image is a plain object `{ width, height, data }` where `data` is an
 * RGBA byte array of `width * height * 4` bytes, row-major, top-left origin.
 * A box is `{ x, y, w, h }` in image pixels.
 *
 * `tools/prep-art.mjs` is the only caller that touches PNG files; everything
 * here works on raw bytes so it can be unit-tested with synthetic images.
 */

/** A new, fully transparent image. */
export function makeImage(width, height) {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

function index(img, x, y) {
  return (y * img.width + x) * 4;
}

/** True when the pixel at byte offset `i` is fully transparent. */
function isClear(data, i) {
  return data[i + 3] === 0;
}

/**
 * Knock out the flat background colour the sheets were generated on.
 * Every pixel within euclidean RGB distance `tol` of `key` is set to
 * transparent black, so no keyed colour can bleed back in under filtering.
 * Mutates and returns `img`.
 */
export function chromaKey(img, key = [255, 0, 255], tol = 60) {
  const { data } = img;
  const [kr, kg, kb] = key;
  const limit = tol * tol;
  for (let i = 0; i < data.length; i += 4) {
    const dr = data[i] - kr;
    const dg = data[i + 1] - kg;
    const db = data[i + 2] - kb;
    if (dr * dr + dg * dg + db * db <= limit) {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = 0;
    }
  }
  return img;
}

/**
 * Peel `passes` pixels off the silhouette. The generated sheets blend the
 * background into the art over a couple of pixels, which `chromaKey` cannot
 * catch without eating real colour; eroding afterwards removes that ring.
 * Pixels outside the image count as transparent. Mutates and returns `img`.
 */
export function erodeAlpha(img, passes = 1) {
  const { width, height, data } = img;
  for (let pass = 0; pass < passes; pass++) {
    const doomed = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = index(img, x, y);
        if (isClear(data, i)) continue;
        const exposed =
          x === 0 ||
          y === 0 ||
          x === width - 1 ||
          y === height - 1 ||
          isClear(data, i - 4) ||
          isClear(data, i + 4) ||
          isClear(data, i - width * 4) ||
          isClear(data, i + width * 4);
        if (exposed) doomed.push(i);
      }
    }
    for (const i of doomed) {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = 0;
    }
  }
  return img;
}

/** Equal `cols` x `rows` cells over the whole image, row-major. */
export function gridCells(img, cols, rows) {
  const xs = [];
  const ys = [];
  for (let c = 0; c <= cols; c++) xs.push(Math.round((c * img.width) / cols));
  for (let r = 0; r <= rows; r++) ys.push(Math.round((r * img.height) / rows));
  const out = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out.push({ x: xs[c], y: ys[r], w: xs[c + 1] - xs[c], h: ys[r + 1] - ys[r] });
    }
  }
  return out;
}

/** Per-column and per-row counts of non-transparent pixels inside `box`. */
function occupancy(img, box) {
  const { width, data } = img;
  const cols = new Array(box.w).fill(0);
  const rows = new Array(box.h).fill(0);
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      if (!isClear(data, index(img, box.x + x, box.y + y))) {
        cols[x]++;
        rows[y]++;
      }
    }
  }
  return { cols, rows };
}

/** Interior runs of zeroes in `counts`, as `[start, end]` inclusive. */
function interiorGaps(counts) {
  const out = [];
  let start = -1;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] === 0) {
      if (start < 0) start = i;
    } else {
      if (start > 0) out.push([start, i - 1]);
      start = -1;
    }
  }
  return out;
}

/** Midpoints of the `n - 1` widest interior gaps, ascending, or null. */
function gapSplits(counts, n) {
  if (n <= 1) return [];
  const gaps = interiorGaps(counts);
  if (gaps.length < n - 1) return null;
  return gaps
    .slice()
    .sort((a, b) => b[1] - b[0] - (a[1] - a[0]))
    .slice(0, n - 1)
    .map(([a, b]) => Math.floor((a + b) / 2))
    .sort((a, b) => a - b);
}

/** Boundaries for an equal split of `total` into `n` parts. */
function evenBounds(total, n) {
  return Array.from({ length: n + 1 }, (_, i) => Math.round((i * total) / n));
}

/** Turn split positions into boundaries, or fall back to the equal split. */
function bounds(splits, total, n) {
  return splits ? [0, ...splits.map((v) => v + 1), total] : evenBounds(total, n);
}

/**
 * Like `gridCells`, but each boundary is moved into the background gutter
 * that actually separates the art. The sheets are not laid out on an exact
 * grid - a tall sprite happily crosses the arithmetic midline and an equal
 * split would slice it - so cutting on the empty columns and rows is the
 * only way to get whole sprites.
 *
 * Rows are split first, then **each row gets its own column split**, because
 * a sheet can have no column gutter at all when read top to bottom: one row's
 * wide sprite can overlap the gap in the row below it. The result is a ragged
 * grid, which does not matter because every cell is trimmed afterwards.
 * Falls back to the whole-sheet columns, then to the equal split. Assumes
 * `chromaKey` has already run.
 */
export function gapCells(img, cols, rows) {
  const sheet = { x: 0, y: 0, w: img.width, h: img.height };
  const whole = occupancy(img, sheet);
  const ys = bounds(gapSplits(whole.rows, rows), img.height, rows);
  const sheetX = gapSplits(whole.cols, cols);

  const out = [];
  for (let r = 0; r < rows; r++) {
    const strip = { x: 0, y: ys[r], w: img.width, h: ys[r + 1] - ys[r] };
    const rowX = gapSplits(occupancy(img, strip).cols, cols) ?? sheetX;
    const xs = bounds(rowX, img.width, cols);
    for (let c = 0; c < cols; c++) {
      out.push({ x: xs[c], y: strip.y, w: xs[c + 1] - xs[c], h: strip.h });
    }
  }
  return out;
}

/** Tightest box around the non-transparent pixels of `cell`, or null. */
export function trimBox(img, cell) {
  const { data } = img;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (let y = cell.y; y < cell.y + cell.h; y++) {
    for (let x = cell.x; x < cell.x + cell.w; x++) {
      if (isClear(data, index(img, x, y))) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Width of the drawn span on each row of `box`; 0 for empty rows. */
function rowExtents(img, box) {
  const { data } = img;
  const out = new Array(box.h).fill(0);
  for (let y = 0; y < box.h; y++) {
    let lo = -1;
    let hi = -1;
    for (let x = 0; x < box.w; x++) {
      if (isClear(data, index(img, box.x + x, box.y + y))) continue;
      if (lo < 0) lo = x;
      hi = x;
    }
    out[y] = lo < 0 ? 0 : hi - lo + 1;
  }
  return out;
}

/**
 * The top face of an isometric tile, dropping the extruded slab below it.
 * A tile silhouette widens to its left and right vertices and then narrows
 * again; the slab keeps the full width for a few rows and pushes the bottom
 * vertex down. The face therefore ends `firstWidestRow` rows below that row,
 * so the face is `2 * firstWidestRow + 1` tall. Returns `box` unchanged when
 * there is no taper to measure.
 */
export function faceBox(img, box) {
  const ext = rowExtents(img, box);
  let max = 0;
  for (const w of ext) if (w > max) max = w;
  if (max === 0) return box;
  const first = ext.indexOf(max);
  const h = 2 * first + 1;
  if (first === 0 || h >= box.h) return box;
  return { x: box.x, y: box.y, w: box.w, h };
}

/**
 * Drop the name plate the generator drew under each building.
 * The plate is the bottom run of rows whose drawn width barely changes, sat
 * under a sharply narrower row. When that shape is not there - no plate, or
 * a sprite that is a constant-width block all the way down - fall back to
 * cutting `fallback` of the box height.
 */
export function plateBox(img, box, fallback = 0.18) {
  const ext = rowExtents(img, box);
  let last = ext.length - 1;
  while (last >= 0 && ext[last] === 0) last--;
  if (last < 1) return box;

  const base = ext[last];
  let top = last;
  while (top - 1 >= 0 && ext[top - 1] > 0 && Math.abs(ext[top - 1] - base) <= 0.2 * base) top--;

  const runHeight = last - top + 1;
  const above = top > 0 ? ext[top - 1] : 0;
  const looksLikePlate =
    top > 0 &&
    runHeight >= 2 &&
    runHeight <= box.h * 0.45 &&
    above < base * 0.7 &&
    base >= box.w * 0.25;

  const h = looksLikePlate ? top : box.h - Math.round(box.h * fallback);
  return { x: box.x, y: box.y, w: box.w, h: Math.max(1, h) };
}

/**
 * Split a cell that holds two sprites at its widest empty column run.
 * Both halves come back trimmed. Returns null when the box has no interior
 * gap to split on.
 */
export function splitAtWidestGap(img, box) {
  const { cols } = occupancy(img, box);
  const gaps = interiorGaps(cols);
  if (gaps.length === 0) return null;
  let widest = gaps[0];
  for (const gap of gaps) if (gap[1] - gap[0] > widest[1] - widest[0]) widest = gap;
  const cut = box.x + Math.floor((widest[0] + widest[1]) / 2) + 1;
  const left = trimBox(img, { x: box.x, y: box.y, w: cut - box.x, h: box.h });
  const right = trimBox(img, { x: cut, y: box.y, w: box.x + box.w - cut, h: box.h });
  if (!left || !right) return null;
  return [left, right];
}

/** Copy `box` out of `img` into a new image. Reads outside `img` are clear. */
export function crop(img, box) {
  const out = makeImage(box.w, box.h);
  for (let y = 0; y < box.h; y++) {
    const sy = box.y + y;
    if (sy < 0 || sy >= img.height) continue;
    for (let x = 0; x < box.w; x++) {
      const sx = box.x + x;
      if (sx < 0 || sx >= img.width) continue;
      const si = index(img, sx, sy);
      const di = (y * box.w + x) * 4;
      out.data[di] = img.data[si];
      out.data[di + 1] = img.data[si + 1];
      out.data[di + 2] = img.data[si + 2];
      out.data[di + 3] = img.data[si + 3];
    }
  }
  return out;
}

/**
 * Size of the art's "big pixels": the mode of the horizontal runs of
 * identical colour inside `box`, clamped to 1..16. Transparent runs are
 * ignored so the background cannot dominate the vote. A sheet drawn at a
 * true 1:1 pixel scale, or one with per-pixel noise, reports 1.
 */
export function pixelPitch(img, box) {
  const { data } = img;
  const counts = new Array(17).fill(0);
  const tally = (run, alpha) => {
    if (run > 0 && alpha !== 0) counts[Math.min(run, 16)]++;
  };
  for (let y = 0; y < box.h; y++) {
    let run = 0;
    let pr = -1;
    let pg = -1;
    let pb = -1;
    let pa = -1;
    for (let x = 0; x < box.w; x++) {
      const i = index(img, box.x + x, box.y + y);
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (r === pr && g === pg && b === pb && a === pa) {
        run++;
      } else {
        tally(run, pa);
        run = 1;
        pr = r;
        pg = g;
        pb = b;
        pa = a;
      }
    }
    tally(run, pa);
  }
  let best = 1;
  let bestCount = 0;
  for (let k = 1; k <= 16; k++) {
    if (counts[k] > bestCount) {
      bestCount = counts[k];
      best = k;
    }
  }
  return best;
}

/** Nearest-neighbour resize to an exact size. Never blends two colours. */
export function resample(img, width, height) {
  const out = makeImage(width, height);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(img.height - 1, Math.floor(((y + 0.5) * img.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(img.width - 1, Math.floor(((x + 0.5) * img.width) / width));
      const si = index(img, sx, sy);
      const di = (y * width + x) * 4;
      out.data[di] = img.data[si];
      out.data[di + 1] = img.data[si + 1];
      out.data[di + 2] = img.data[si + 2];
      out.data[di + 3] = img.data[si + 3];
    }
  }
  return out;
}

/**
 * Nearest-neighbour downscale by an integer factor, sampling the centre of
 * each source block. `factor <= 1` returns the image untouched.
 */
export function downscale(img, factor) {
  if (!Number.isFinite(factor) || factor <= 1) return img;
  const f = Math.round(factor);
  if (f <= 1) return img;
  return resample(img, Math.max(1, Math.ceil(img.width / f)), Math.max(1, Math.ceil(img.height / f)));
}

/**
 * Recolour the character's body. Every pixel within `tol` of `from` is
 * shifted by the same per-channel delta, so an exact match lands on `to` and
 * the shading around it keeps its relative darkness. Transparent pixels and
 * anything outside the tolerance are copied through. Returns a new image.
 */
export function tint(img, from = [224, 105, 75], to, tol = 70) {
  const out = makeImage(img.width, img.height);
  out.data.set(img.data);
  if (!to) return out;
  const [fr, fg, fb] = from;
  const [tr, tg, tb] = to;
  const dr = tr - fr;
  const dg = tg - fg;
  const db = tb - fb;
  const limit = tol * tol;
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  const { data } = out;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const er = data[i] - fr;
    const eg = data[i + 1] - fg;
    const eb = data[i + 2] - fb;
    if (er * er + eg * eg + eb * eb > limit) continue;
    data[i] = clamp(data[i] + dr);
    data[i + 1] = clamp(data[i + 1] + dg);
    data[i + 2] = clamp(data[i + 2] + db);
  }
  return out;
}

/**
 * True for the green of a road tile's verge. The generated road tiles are
 * asphalt, pale kerb stone and grass, and only the grass is green-dominant,
 * so this is enough to tell "road surface" from "not road".
 */
export function isGrassLike(rgba) {
  const [r, g, b] = rgba;
  return g > r + 20 && g > b + 20;
}

/**
 * Lay road `b` over road `a`: a pixel of `b` wins wherever it is opaque road
 * surface, and `a` shows through everywhere else. Union two straights that
 * cross and you get a crossroad whose asphalt reaches every tile edge the
 * straights reached. Both images must be the same size. Returns a new image.
 */
export function unionRoad(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`unionRoad needs matching sizes, got ${a.width}x${a.height} and ${b.width}x${b.height}`);
  }
  const out = makeImage(a.width, a.height);
  out.data.set(a.data);
  for (let i = 0; i < b.data.length; i += 4) {
    if (b.data[i + 3] === 0) continue;
    if (isGrassLike([b.data[i], b.data[i + 1], b.data[i + 2]])) continue;
    out.data[i] = b.data[i];
    out.data[i + 1] = b.data[i + 1];
    out.data[i + 2] = b.data[i + 2];
    out.data[i + 3] = b.data[i + 3];
  }
  return out;
}

/**
 * Keep half of a road tile and put the plain ground back on the other half,
 * so a straight becomes a stub that runs from the tile centre to one edge.
 *
 * An isometric tile has two axes. The line through the centre toward the
 * upper-left and lower-right edge midpoints is the tx axis; the line toward
 * the upper-right and lower-left midpoints is the ty axis. Each line cuts the
 * diamond in two, and `side` names the half to keep by the edge it contains:
 * 'ne' and 'sw' are the halves of the tx line, 'nw' and 'se' the halves of
 * the ty line. The discarded half is copied pixel for pixel out of `ground`
 * (the grass tile), which is why the seam never shows. Returns a new image.
 */
export function maskHalf(img, side, ground) {
  if (img.width !== ground.width || img.height !== ground.height) {
    throw new Error(`maskHalf needs a ground tile of ${img.width}x${img.height}`);
  }
  const keep = HALF_TESTS[side];
  if (!keep) throw new Error(`unknown side ${side}, expected one of ${Object.keys(HALF_TESTS).join(', ')}`);
  const out = makeImage(img.width, img.height);
  out.data.set(img.data);
  // The tests are written for the 2:1 diamond, so scale x into height units.
  const ratio = img.width / img.height;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (keep(x / ratio, y, img.height)) continue;
      const i = index(img, x, y);
      out.data[i] = ground.data[i];
      out.data[i + 1] = ground.data[i + 1];
      out.data[i + 2] = ground.data[i + 2];
      out.data[i + 3] = ground.data[i + 3];
    }
  }
  return out;
}

/**
 * Which pixels a `side` keeps, in a square whose diagonals are the tile's two
 * axes: `u` is the column scaled into row units and `h` the tile height.
 */
const HALF_TESTS = {
  ne: (u, y) => y < u,
  sw: (u, y) => y >= u,
  nw: (u, y, h) => y < h - u,
  se: (u, y, h) => y >= h - u,
};

/**
 * Shelf-pack `[{ name, img }]` into one texture with 1px of transparent
 * padding around every frame, and describe it in Phaser's "JSONHash" atlas
 * format. Frames are placed tallest first into the narrowest power-of-two
 * width that keeps the result roughly square; `json.frames` keeps the input
 * order. `json.meta.image` is left blank for the caller to fill in.
 */
export function packAtlas(frames) {
  const empty = {
    frames: {},
    meta: { image: '', size: { w: 1, h: 1 }, scale: 1 },
  };
  if (frames.length === 0) return { img: makeImage(1, 1), json: empty };

  const order = frames
    .map((frame, i) => ({ frame, i }))
    .sort((a, b) => b.frame.img.height - a.frame.img.height || a.i - b.i);

  let widest = 0;
  let area = 0;
  for (const { frame } of order) {
    widest = Math.max(widest, frame.img.width + 2);
    area += (frame.img.width + 1) * (frame.img.height + 1);
  }

  let width = 8;
  while (width < widest) width *= 2;
  let placed = null;
  let height = 0;
  for (; width <= 8192; width *= 2) {
    placed = new Map();
    let cursorX = 1;
    let shelfY = 1;
    let shelfH = 0;
    for (const { frame } of order) {
      const { width: fw, height: fh } = frame.img;
      if (cursorX + fw + 1 > width && shelfH > 0) {
        shelfY += shelfH + 1;
        cursorX = 1;
        shelfH = 0;
      }
      placed.set(frame.name, { x: cursorX, y: shelfY, w: fw, h: fh });
      cursorX += fw + 1;
      shelfH = Math.max(shelfH, fh);
    }
    height = shelfY + shelfH + 1;
    if (height <= width || width * 2 > 8192) break;
  }

  const img = makeImage(width, height);
  for (const { frame } of order) {
    const box = placed.get(frame.name);
    for (let y = 0; y < box.h; y++) {
      const di = ((box.y + y) * width + box.x) * 4;
      const si = y * box.w * 4;
      img.data.set(frame.img.data.subarray(si, si + box.w * 4), di);
    }
  }

  const json = { frames: {}, meta: { image: '', size: { w: width, h: height }, scale: 1 } };
  for (const frame of frames) {
    const box = placed.get(frame.name);
    json.frames[frame.name] = {
      frame: { x: box.x, y: box.y, w: box.w, h: box.h },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: box.w, h: box.h },
      sourceSize: { w: box.w, h: box.h },
    };
  }
  return { img, json };
}
