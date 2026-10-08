// Every piece of text in the city.
//
// A label is a paper plate with an ink hairline and one to three lines of
// Pixelify Sans, anchored by its bottom centre so it hangs above whatever it
// names. Labels live in the world (they scroll with the camera) but are held at
// a constant *screen* size: the city fits on screen at about 0.6 zoom, and text
// that shrank with it would be the "no text" the design brief rejects.

const FONT = '"Pixelify Sans", "Courier New", monospace';

/** Labels sit above every sprite; among themselves they keep world order. */
export const LABEL_DEPTH = 500000;

function hex(css) {
  const n = Number.parseInt(String(css || '').replace('#', ''), 16);
  return Number.isFinite(n) ? n : 0x000000;
}

/**
 * One label factory per scene. It owns the live labels so a theme change or a
 * zoom change is a single pass.
 */
export function createLabels(scene, tokens) {
  const live = new Set();
  let palette = { ...tokens };
  let zoom = 1;

  function styleFor(size, color) {
    return { fontFamily: FONT, fontSize: `${size}px`, color, resolution: 2, align: 'center' };
  }

  /**
   * `lines` is an array of strings; the first is the headline and the rest are
   * the smaller detail lines. Empty and null entries are dropped, so a caller
   * can pass an optional second line without branching.
   */
  function make(lines, opts = {}) {
    const size = opts.size || 12;
    const subSize = opts.subSize || 10;
    const pad = opts.pad === undefined ? 3 : opts.pad;
    const tail = Boolean(opts.tail);

    const box = scene.add.container(0, 0);
    box.setDepth(opts.depth === undefined ? LABEL_DEPTH : opts.depth);

    const bg = scene.add.rectangle(0, 0, 8, 8, hex(palette.paper), opts.bgAlpha === undefined ? 1 : opts.bgAlpha);
    bg.setOrigin(0.5, 1);
    bg.setStrokeStyle(1, hex(palette.ink), 1);
    box.add(bg);

    const point = tail ? scene.add.triangle(0, 0, -4, 0, 4, 0, 0, 5, hex(palette.paper)) : null;
    if (point) {
      point.setOrigin(0.5, 0);
      box.add(point);
    }

    const texts = [];
    let accent = null;

    function ensure(count) {
      while (texts.length < count) {
        const i = texts.length;
        const t = scene.add.text(0, 0, '', styleFor(i === 0 ? size : subSize, palette.ink));
        t.setOrigin(0.5, 0);
        texts.push(t);
        box.add(t);
      }
      for (let i = 0; i < texts.length; i++) texts[i].setVisible(i < count);
    }

    function layout() {
      const shown = texts.filter((t) => t.visible);
      let h = 0;
      let w = 0;
      for (const t of shown) {
        h += t.height;
        if (t.width > w) w = t.width;
      }
      const boxW = Math.max(12, Math.round(w) + pad * 2);
      const boxH = Math.max(10, Math.round(h) + pad * 2);
      bg.setSize(boxW, boxH);
      let y = -boxH + pad;
      for (const t of shown) {
        t.setPosition(0, Math.round(y));
        y += t.height;
      }
      if (point) point.setPosition(0, 0);
      // Prefixed so nothing here collides with a Phaser Container property.
      box.plateW = boxW;
      box.plateH = boxH;
    }

    function setLines(next) {
      const kept = (next || []).map((s) => (s == null ? '' : String(s))).filter((s) => s !== '');
      if (box.lines && kept.length === box.lines.length && kept.every((s, i) => s === box.lines[i])) return box;
      box.lines = kept;
      ensure(kept.length);
      for (let i = 0; i < kept.length; i++) texts[i].setText(kept[i]);
      layout();
      return box;
    }

    /** A model-family colour on the headline; everything else stays ink. */
    function setAccent(color) {
      accent = color || null;
      if (texts[0]) texts[0].setColor(accent || palette.ink);
      return box;
    }

    function retone() {
      bg.setFillStyle(hex(palette.paper), opts.bgAlpha === undefined ? 1 : opts.bgAlpha);
      bg.setStrokeStyle(1, hex(palette.ink), 1);
      if (point) point.setFillStyle(hex(palette.paper), 1);
      for (let i = 0; i < texts.length; i++) texts[i].setColor(i === 0 && accent ? accent : palette.ink);
    }

    box.setLines = setLines;
    box.setAccent = setAccent;
    box.retone = retone;
    box.setScale(zoom < 1 ? 1 / zoom : 1);

    const kill = box.destroy.bind(box);
    box.destroy = (fromScene) => { live.delete(box); kill(fromScene); };

    live.add(box);
    setLines(lines);
    return box;
  }

  /**
   * Below 1 the camera is shrinking the world to fit the city on screen, and a
   * label that shrank with it would be unreadable, so it is scaled back up to
   * its authored pixel size. At 1 and above it rides the zoom like everything
   * else, which is what makes a close-up look like a close-up.
   */
  function applyZoom(nextZoom) {
    if (!(nextZoom > 0) || nextZoom === zoom) return;
    zoom = nextZoom;
    const s = zoom < 1 ? 1 / zoom : 1;
    for (const box of live) box.setScale(s);
  }

  function setTokens(next) {
    palette = { ...palette, ...next };
    for (const box of live) box.retone();
  }

  // No `destroy()`: `game.destroy(true)` sweeps the scene's display list, which
  // is where every label lives, so a second teardown path would only be one
  // more thing to keep in step.
  return { make, applyZoom, setTokens, get scale() { return zoom < 1 ? 1 / zoom : 1; } };
}
