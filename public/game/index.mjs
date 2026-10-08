// The one entry point the page uses.
//
//   createTown(container, { onSelect, tokens })
//     -> { update(snapshot), flashShield(sessionId, mode), setSelected(sessionId),
//          setTheme(tokens), resize(), dispose() }
//
// Everything is created lazily behind `document.fonts.ready`: Phaser measures a
// text object once, so booting before Pixelify Sans has arrived lays every
// label out for the monospace fallback and never corrects itself.

import { AUTO, Game, Scale } from 'phaser';

import { CityScene } from './city-scene.mjs';

/**
 * Every atlas the city may draw from, in lookup order.
 *
 * This is the only list of art in the codebase. The scene indexes every frame
 * in every sheet that is actually present and draws a `buildings` or `props`
 * object by looking its `name` up in that index, so a new sheet plus a denser
 * `city.json` needs one more line here and no other code change. Names are
 * probed rather than loaded blind: sheets the art pipeline has not produced yet
 * are dropped before Phaser's loader sees them, so a half-built set of atlases
 * still boots with a clean console. Earlier entries win a duplicate frame name.
 */
const ATLASES = [
  'tiles', 'city_roads',
  'house', 'stations',
  'city_civic_a', 'city_civic_b',
  'city_extra_a', 'city_extra_b', 'city_decor',
  'city_vehicles', 'character', 'character_extra', 'critter',
];

/**
 * The sheets that exist, in ATLASES order.
 *
 * `assets/atlas/index.json` is written by the art pipeline from the directory
 * it just filled, so it always tells the truth about what built. Anything in
 * ATLASES that is not in it has not been generated yet and is dropped here,
 * before Phaser's loader can log a 404 for it. Without the index (an older
 * checkout, say) every name is probed instead.
 */
async function presentAtlases(names) {
  let built = null;
  try {
    // GET, not HEAD: the server only routes GET, and the body lands in the
    // HTTP cache that Phaser's own load then reuses.
    const res = await fetch('assets/atlas/index.json');
    if (res.ok) {
      const list = await res.json();
      if (Array.isArray(list)) built = new Set(list);
    }
  } catch {
    built = null;
  }
  if (built) return names.filter((name) => built.has(name));

  const found = await Promise.all(names.map(async (name) => {
    try {
      const res = await fetch(`assets/atlas/${name}.json`);
      return res.ok ? name : null;
    } catch {
      return null;
    }
  }));
  return found.filter(Boolean);
}

/** DESIGN.md light palette, used for any token the page does not supply. */
const DEFAULT_TOKENS = {
  sky: '#cfe8f3',
  grass: '#8fcf6b',
  grass2: '#7bbd5a',
  wood: '#c98a4b',
  roof: '#e0694b',
  stone: '#b9b3a8',
  ink: '#2b2620',
  paper: '#fbf7ef',
  coin: '#f2c14e',
  ok: '#58b368',
  warn: '#e8a838',
  bad: '#d9534f',
  water: '#1f4e6b',
};

async function fontReady() {
  try {
    if (document.fonts && document.fonts.load) {
      await Promise.all([
        document.fonts.load('10px "Pixelify Sans"'),
        document.fonts.load('12px "Pixelify Sans"'),
      ]);
    }
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
  } catch {
    // No Font Loading API, or the stylesheet never arrived: the fallback
    // monospace still measures and still reads.
  }
}

export function createTown(container, options = {}) {
  const onSelect = typeof options.onSelect === 'function' ? options.onSelect : () => {};
  let tokens = { ...DEFAULT_TOKENS, ...(options.tokens || {}) };

  const motion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  let scene = null;
  let game = null;
  let disposed = false;
  let queued = null;
  let selected = null;

  const onScaleResize = () => { if (scene) scene.handleResize(); };
  // The scene does the work: citizens read the flag live, and the ambient
  // motion that runs on its own timers — smoke, cats, cars — is stopped and
  // restarted there. Assigning the field alone reached nothing already alive.
  const onMotion = () => { if (scene) scene.setReduced(Boolean(motion && motion.matches)); };

  Promise.all([fontReady(), presentAtlases(ATLASES)]).then(([, atlases]) => {
    if (disposed) return;
    scene = new CityScene({ onSelect, tokens, atlases, reduced: Boolean(motion && motion.matches) });
    game = new Game({
      type: AUTO,
      parent: container,
      pixelArt: true,
      roundPixels: true,
      backgroundColor: tokens.sky,
      banner: false,
      // DESIGN.md: the whole city runs at a 30 fps cap. Left to the display,
      // every tween interpolates at 144 Hz and a pixel sprite crosses a tile in
      // sub-pixel steps, which is the shimmer the art pipeline exists to avoid.
      // `limit`, not `forceSetTimeOut`: driving the loop off setTimeout also
      // takes the scale manager's parent-size polling with it, and the canvas
      // then never follows the viewport across the bottom-sheet breakpoint.
      fps: { limit: 30, target: 30, min: 20 },
      scale: { mode: Scale.RESIZE, width: '100%', height: '100%' },
      scene,
    });
    game.scale.on('resize', onScaleResize);
    if (motion && motion.addEventListener) motion.addEventListener('change', onMotion);
    if (selected) scene.setSelected(selected);
    if (queued) { scene.applySnapshot(queued); queued = null; }
  });

  return {
    update(snapshot) {
      if (disposed) return;
      if (scene) scene.applySnapshot(snapshot);
      else queued = snapshot;
    },
    flashShield(sessionId, mode) {
      if (!disposed && scene) scene.flashShield(sessionId, mode);
    },
    /** Ring the session the panel is describing; `null` clears it. */
    setSelected(sessionId) {
      if (disposed) return;
      selected = sessionId || null;
      if (scene) scene.setSelected(selected);
    },
    /** Test hook: what the scene currently believes it is highlighting. */
    debug() {
      if (!scene) return null;
      return {
        selected,
        houses: [...scene.houses.keys()],
        ring: Boolean(scene.selGfx),
        reduced: Boolean(scene.reduced),
        fps: game && game.loop ? Math.round(game.loop.actualFps) : null,
      };
    },
    setTheme(next) {
      tokens = { ...tokens, ...(next || {}) };
      if (!disposed && scene) scene.setTheme(tokens);
    },
    resize() {
      if (disposed || !game) return;
      game.scale.refresh();
      if (scene) scene.handleResize();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (motion && motion.removeEventListener) motion.removeEventListener('change', onMotion);
      if (game) {
        game.scale.off('resize', onScaleResize);
        game.destroy(true);
      }
      game = null;
      scene = null;
      queued = null;
    },
  };
}
