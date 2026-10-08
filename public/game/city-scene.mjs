// The city itself: ground, buildings, houses, citizens, cars, critters and the
// guard, plus the camera controls and the snapshot diff that drives them.

import { Scene } from 'phaser';

import { Citizen } from './citizen.mjs';
import { LABEL_DEPTH, createLabels } from './labels.mjs';
import { LAYOUT, buildingFor, parseLayout, walkGrid } from '../citymap.mjs';
import { burnRate, coinCount, contextRemaining, fmtTokens, fmtUsd, healthColor, modelFamily } from '../mapping.mjs';
import {
  assignLots, buildFrameIndex, citizenPlate, clamp, cwdTail, diffKeys, fitZoom, footprint,
  canEnter, isChopping, laneOffset, layerOriginX, layoutPlates, nearestIndex, pickCitizens, pickHouses,
  poseFor, roadLoops, sessionLabel, vehicleFacing, slotOffsets, spreadOrder, tileCenter, truncate, worldSize,
} from './util.mjs';

/**
 * The blurb under a building's name. A building with no entry still gets a
 * plate, titled from its own frame name, so a new sheet plus a denser city.json
 * is readable the moment it loads.
 */
const BUILDING_BLURB = {
  library: 'reads · greps',
  forge: 'file edits',
  server_hall: 'shell commands',
  radio_tower: 'web · MCP',
  town_hall: 'subagents',
  school: 'skills',
  bank: 'the cost pile',
  guard_post: 'hooks · other tools',
  water_tower: 'context',
  fountain: 'idle agents',
};

/** A contact shadow is this much of its sprite's width, and a third as tall. */
const SHADOW_W = 0.8;
const SHADOW_RATIO = 1 / 3;

const ACTOR_SCALE = 1.6;
const CAR_SCALE = 1.4;
const TREE_SCALE = 0.7;
const STEP_MS = 500;
const CAR_MS = 420;
const CAR_WAIT_MS = 250;   // how long a queued car waits before checking the tile again
const CAR_MAX_WAITS = 6;   // after this many waits it drives on, so traffic can never gridlock
const MIN_ZOOM = 0.45;
const MAX_ZOOM = 4;
const STUMP_MS = 20000;
const SIDE_BY_SIDE = 26;
/** Citizens one session may put on the streets at once. */
const MAX_CITIZENS = 8;
/**
 * How far either side of a doorstep a crowd may spread.
 *
 * Unbounded, a building that several sessions send agents to fans them out
 * across the whole map; this is what put two rows of citizens in the sea west
 * of the shore. Past about nine at one door they start to overlap, and the
 * stacked name plates are what tells them apart.
 */
const CROWD_SPAN = 120;
/** Distinct resting tiles the park offers, filled round-robin. */
const PARK_SPOTS = 6;
/** Tiles between two resting spots, so their name plates do not overlap. */
const PARK_GAP = 4;
const PLATE = { size: 11, subSize: 9 };
/** Pixels between two stacked name plates, and how many times one may stack. */
const PLATE_GAP = 2;
const PLATE_STACKS = 3;
/** One duration for "take the camera somewhere", per DESIGN.md. */
const PAN_MS = 200;
/** And the same for the auto-fit, which is a camera move like any other. */
const FIT_MS = 200;
/** Slack around the map when fitting: roofs and name plates live above it. */
const FIT_PAD = { x: 80, top: 300, bottom: 90 };

/**
 * The sheets were drawn at a single size, so a four-tile civic block covers
 * only about half its lot. Widening each building to eight tenths of its
 * footprint fills the block the way the moodboard does, and the clamp keeps the
 * small props (fountain, guard post) at the size they were drawn.
 */
function lotScale(lot, img) {
  return clamp(((lot.w + lot.h) * 32 * 0.8) / img.width, 1, 1.5);
}

/** `server_hall` reads as "Server hall" on the plate. */
function titleOf(frame) {
  const words = String(frame).replace(/[_-]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Building';
}

/**
 * A stable pseudo-random number in [0, 1) for a tile.
 *
 * Scenery variation has to survive a re-render and a texture swap, so it is
 * derived from the tile's own coordinates rather than drawn from Math.random.
 */
function jitter(tx, ty, salt = 0) {
  const n = Math.sin(tx * 127.1 + ty * 311.7 + salt * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

function propsOf(obj) {
  const out = {};
  for (const p of obj.properties || []) out[p.name] = p.value;
  return out;
}

function toPoints(flat) {
  const out = [];
  for (let i = 0; i < flat.length; i += 2) out.push({ x: flat[i], y: flat[i + 1] });
  return out;
}

export class CityScene extends Scene {
  constructor(opts) {
    super('city');
    this.opts = opts;
    this.tokens = { ...opts.tokens };
    this.reduced = Boolean(opts.reduced);

    this.houses = new Map();      // sessionId -> house view
    this.citizens = new Map();    // `${sessionId}/${agentId}` -> Citizen
    this.leaving = new Set();     // citizens walking home before they vanish
    this.cars = new Map();        // pid -> car view
    this.traffic = new Map();     // "x,y" -> Map(car id -> facing), the tiles cars hold
    this.lots = new Map();        // sessionId -> house lot index
    this.samples = new Map();     // sessionId -> token burn samples
    this.trees = [];
    this.critters = [];
    this.shadows = [];
    this.apronTiles = [];
    this.carSeq = 0;
    this.pendingPick = null;
    this.dragDist = 0;
    this.pinch = 0;
    this.pinched = false;
    this.parkSpots = [];
    this.parkSeq = 0;
    this.pending = null;
    this.ready = false;
    this.selectedId = null;       // session the panel is showing, or null
    this.selGfx = null;           // the ring that says which one that is
  }

  preload() {
    this.load.setPath('assets/');
    for (const key of this.atlasKeys()) this.load.atlas(key, `atlas/${key}.png`, `atlas/${key}.json`);
    this.load.image('ground_tiles', 'tiles.png');
    this.load.tilemapTiledJSON('city', 'city.json');
  }

  atlasKeys() {
    return this.opts.atlases && this.opts.atlases.length ? this.opts.atlases : ['tiles'];
  }

  create() {
    const map = this.make.tilemap({ key: 'city' });
    this.cityMap = map;
    this.ox = layerOriginX(map.height);
    this.world = worldSize(map.width, map.height);

    const tileset = map.addTilesetImage('tiles+roads', 'ground_tiles');
    this.ground = map.createLayer('ground', tileset, this.ox, 0);
    this.ground.setDepth(-1000);

    this.parsed = parseLayout(LAYOUT);
    this.grid = walkGrid(this.parsed);
    this.labels = createLabels(this, this.tokens);

    this.indexFrames();
    this.makeTextures();
    this.drawWater();
    this.plates = this.add.graphics().setDepth(-999);
    this.buildBuildings(map);
    this.buildProps(map);
    this.readHouseLots(map);
    this.drawDoorAprons();
    this.buildPathfinder();
    this.buildParkSpots();
    this.loops = roadLoops(this.parsed.tiles);
    this.buildCritters();
    this.setupCamera();
    this.setupInput();
    this.reportMissingArt();
    this.time.addEvent({ delay: 1000, loop: true, callback: () => this.assertOnMap() });

    this.ready = true;
    if (this.pending) { const snap = this.pending; this.pending = null; this.applySnapshot(snap); }
  }

  // ------------------------------------------------------------ art lookup

  /**
   * frame name → the sheet that carries it, across every atlas that loaded.
   *
   * This is what makes the map data-driven: nothing in this file knows the name
   * of a single building. Earlier sheets in the list win a duplicate name.
   */
  indexFrames() {
    const sheets = [];
    for (const key of this.atlasKeys()) {
      const tex = this.textures.get(key);
      if (!tex || tex.key === '__MISSING') continue;
      sheets.push({ key, frames: tex.getFrameNames() });
    }
    const { index, duplicates } = buildFrameIndex(sheets);
    this.frameIndex = index;
    this.shadowedFrames = duplicates;
    this.missingArt = new Set();
  }

  /** The sheet for a frame, or null once it has been noted as missing. */
  atlasOf(frame) {
    const key = this.frameIndex.get(frame);
    if (key) return key;
    this.missingArt.add(frame);
    return null;
  }

  /** One line, once, naming everything the map asked for and no sheet had. */
  reportMissingArt() {
    if (!this.missingArt.size) return;
    console.warn(`[city] no atlas frame for: ${Array.from(this.missingArt).sort().join(', ')}`);
  }

  // --------------------------------------------------------------- textures

  /** Three shapes the sheets do not carry: a smoke puff, a coin, a shadow. */
  makeTextures() {
    if (!this.textures.exists('puff')) {
      const g = this.make.graphics({ x: 0, y: 0, add: false });
      g.fillStyle(0xffffff, 1);
      g.fillRect(0, 0, 3, 3);
      g.generateTexture('puff', 3, 3);
      g.destroy();
    }
    if (!this.textures.exists('coin')) {
      const g = this.make.graphics({ x: 0, y: 0, add: false });
      g.fillStyle(0xffffff, 1);
      g.fillRect(1, 0, 6, 3);
      g.fillRect(0, 1, 8, 1);
      g.generateTexture('coin', 8, 3);
      g.destroy();
    }
    if (!this.textures.exists('contact')) {
      // A flat 2:1 ellipse. Tinted ink at low alpha it reads as the ground
      // contact that stops everything floating, with no gradient anywhere.
      const g = this.make.graphics({ x: 0, y: 0, add: false });
      g.fillStyle(0xffffff, 1);
      g.fillEllipse(32, 8, 62, 15);
      g.generateTexture('contact', 64, 16);
      g.destroy();
    }
  }

  /**
   * The contact shadow under a sprite: one generated ellipse texture, tinted
   * ink at 18 %, four fifths of the sprite's width and a third as tall, sitting
   * just under its owner's depth.
   */
  addShadow(x, y, spriteWidth, depth) {
    const w = Math.max(10, spriteWidth * SHADOW_W);
    const shade = this.add.image(x, y, 'contact').setOrigin(0.5, 0.5);
    shade.setDisplaySize(w, Math.max(4, w * SHADOW_RATIO));
    shade.setTint(this.hex(this.tokens.ink));
    shade.setAlpha(0.18);
    shade.setDepth(depth);
    this.shadows.push(shade);
    return shade;
  }

  // ---------------------------------------------------------------- helpers

  toWorld(tx, ty) {
    return tileCenter(tx, ty, this.ox, 0);
  }

  hex(css) {
    const n = Number.parseInt(String(css || '').replace('#', ''), 16);
    return Number.isFinite(n) ? n : 0;
  }

  familyColor(family) {
    const t = this.tokens;
    return { fable: t.roof, opus: t.wood, sonnet: '#3b6ea5', haiku: t.stone }[family] || t.ink;
  }

  /** The four corners of a lot, for the guard's ring. */
  lotPolygon(lot) {
    const n = this.toWorld(lot.tx, lot.ty);
    const e = this.toWorld(lot.tx + lot.w - 1, lot.ty);
    const s = this.toWorld(lot.tx + lot.w - 1, lot.ty + lot.h - 1);
    const w = this.toWorld(lot.tx, lot.ty + lot.h - 1);
    return [n.x, n.y - 16, e.x + 32, e.y, s.x, s.y + 16, w.x - 32, w.y];
  }

  // ------------------------------------------------------------------ world

  drawWater() {
    if (this.waterG) this.waterG.destroy();
    const g = this.add.graphics().setDepth(-1001);
    g.fillStyle(this.hex(this.tokens.water || '#1f4e6b'), 1);
    for (let ty = 0; ty < this.parsed.h; ty++) {
      for (let tx = 0; tx < this.parsed.w; tx++) {
        if (this.parsed.tiles[ty][tx] !== 'water') continue;
        const c = this.toWorld(tx, ty);
        g.fillPoints([
          { x: c.x, y: c.y - 16 }, { x: c.x + 32, y: c.y },
          { x: c.x, y: c.y + 16 }, { x: c.x - 32, y: c.y },
        ], true);
      }
    }
    this.waterG = g;
  }

  /**
   * A paved apron and a 1-px outline on a lot, so a building reads as standing
   * on a plot rather than pasted onto the lawn.
   */
  drawLotPlate(lot) {
    const pts = toPoints(this.lotPolygon(lot));
    this.plates.fillStyle(this.hex(this.tokens.stone), 0.28);
    this.plates.fillPoints(pts, true);
    this.plates.lineStyle(1, this.hex(this.tokens.ink), 0.35);
    this.plates.strokePoints(pts, true, true);
  }

  buildBuildings(map) {
    this.buildings = new Map();
    const layer = map.getObjectLayer('buildings');
    for (const obj of (layer ? layer.objects : [])) {
      const p = propsOf(obj);
      // A city places some buildings more than once, so the object's name is
      // unique (`apartment#2`) and the frame it draws is its `key` property.
      // Maps written before that carry no `key`, hence the fallback. The Map is
      // keyed by the unique name so every instance keeps its own plate through
      // a theme change or a zoom, while the first of each key keeps the bare
      // name that destination lookups ask for.
      const key = p.key || String(obj.name).replace(/#\d+$/, '');
      const atlas = this.atlasOf(key);
      if (!atlas) continue;
      const lot = { tx: p.tx, ty: p.ty, w: p.w, h: p.h };
      const anchor = footprint(lot, this.ox, 0);
      this.drawLotPlate(lot);
      const img = this.add.image(anchor.x, anchor.y, atlas, key)
        .setOrigin(0.5, 1)
        .setDepth(anchor.depth);
      img.setScale(lotScale(lot, img));
      this.addShadow(anchor.x, anchor.y - 3, img.displayWidth, anchor.depth - 0.5);
      const plate = this.labels.make([titleOf(key), BUILDING_BLURB[key] || ''], PLATE);
      plate.setPosition(Math.round(anchor.x), Math.round(anchor.y - img.displayHeight - 6));
      plate.setDepth(LABEL_DEPTH + anchor.depth);
      this.buildings.set(obj.name, { key, lot, img, plate, anchor, door: { tx: p.doorTx, ty: p.doorTy } });
      this.apronTiles.push({ tx: p.doorTx, ty: p.doorTy });
    }
    this.board = this.buildings.get('town_hall');
  }

  buildProps(map) {
    const layer = map.getObjectLayer('props');
    for (const obj of (layer ? layer.objects : [])) {
      const p = propsOf(obj);
      const atlas = this.atlasOf(p.frame);
      if (!atlas) continue;
      const c = this.toWorld(p.tx, p.ty);
      const img = this.add.image(c.x, c.y, atlas, p.frame).setOrigin(0.5, 1).setDepth(c.y);
      // Everything on the props layer is scenery, and a row of identical
      // sprites is what makes a map look flat. The variation is seeded from the
      // tile's own coordinates, so it is the same on every reload and survives
      // the tree-to-stump swap. The map's own `scale` property multiplies it.
      // Trees are drawn taller than a house, so they also come down a notch.
      const scale = (p.scale || 1)
        * (p.frame === 'tree' ? TREE_SCALE : 1)
        * (0.9 + jitter(p.tx, p.ty) * 0.2);
      img.setScale(scale).setFlipX(jitter(p.tx, p.ty, 1) > 0.5);
      this.addShadow(c.x, c.y - 2, img.displayWidth, c.y - 0.5);
      // Only full-size trees are choppable; a bush is the same sprite at half size.
      if (p.frame === 'tree' && !p.scale) this.trees.push({ tx: p.tx, ty: p.ty, img, scale, stumped: 0 });
    }
  }

  /**
   * Worn ground where feet land: a `path` tile laid over any grass door tile.
   *
   * These are plain sprites above the tile layer, so city.json stays the map
   * generator's output and a map that already paves its doors gets nothing.
   */
  drawDoorAprons() {
    const frame = this.frameIndex.get('path');
    if (!frame) return;
    const seen = new Set();
    for (const t of this.apronTiles) {
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1]]) {
        const tx = t.tx + dx;
        const ty = t.ty + dy;
        const key = `${tx},${ty}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const row = this.parsed.tiles[ty];
        if (!row || row[tx] !== 'grass') continue;
        const c = this.toWorld(tx, ty);
        this.add.image(c.x, c.y, frame, 'path').setOrigin(0.5, 0.5).setDepth(-999.5).setAlpha(0.9);
      }
    }
  }

  readHouseLots(map) {
    this.houseLots = [];
    const layer = map.getObjectLayer('houses');
    for (const obj of (layer ? layer.objects : [])) {
      const p = propsOf(obj);
      const lot = { tx: p.tx, ty: p.ty, w: p.w, h: p.h };
      this.houseLots[p.index] = {
        index: p.index, lot, door: { tx: p.doorTx, ty: p.doorTy }, anchor: footprint(lot, this.ox, 0),
      };
      this.drawLotPlate(lot);
      this.apronTiles.push({ tx: p.doorTx, ty: p.doorTy });
    }
    // Two sessions should not end up as next-door neighbours with their signs
    // on top of each other, so assignment order walks the street, not the list.
    this.lotOrder = spreadOrder(this.houseLots.length);
  }

  // ------------------------------------------------------------ pathfinding

  buildPathfinder() {
    const EasyStar = globalThis.EasyStar;
    // easystar 0.4.4 ships CommonJS, so dev.html loads the bin build as a
    // classic script; without it the city still draws, it just cannot walk.
    if (!EasyStar) { this.finder = null; return; }
    const finder = new EasyStar.js();
    finder.setGrid(this.grid);
    finder.setAcceptableTiles([0, 2]);
    finder.setTileCost(2, 3);
    finder.disableDiagonals();
    finder.setIterationsPerCalculation(4000);
    this.finder = finder;
  }

  walkable(tx, ty) {
    const cell = this.grid[ty] && this.grid[ty][tx];
    return cell === 0 || cell === 2;
  }

  findPath(from, to, done) {
    if (!this.finder || !this.walkable(from.tx, from.ty) || !this.walkable(to.tx, to.ty)) { done(null); return; }
    this.finder.findPath(from.tx, from.ty, to.tx, to.ty, (path) => done(path));
  }

  /** Is this tile on the map at all? */
  inBounds(tx, ty) {
    return ty >= 0 && ty < this.parsed.h && tx >= 0 && tx < this.parsed.w;
  }

  /** A tile you can stand on next to a blocked one, for trees. */
  openNeighbour(tile) {
    if (this.walkable(tile.tx, tile.ty)) return { tx: tile.tx, ty: tile.ty };
    for (const [dx, dy] of [[0, 1], [1, 0], [-1, 0], [0, -1]]) {
      if (this.walkable(tile.tx + dx, tile.ty + dy)) return { tx: tile.tx + dx, ty: tile.ty + dy };
    }
    return { tx: tile.tx, ty: tile.ty };
  }

  /**
   * The closest tile to `tile` a citizen can legally stand on.
   *
   * A spawn point comes from map data, so it is normally fine; this is the
   * backstop that keeps a citizen on the island when it is not, rather than
   * letting one start on a blocked tile and path from nowhere.
   */
  nearestWalkable(tile) {
    if (this.walkable(tile.tx, tile.ty)) return { tx: tile.tx, ty: tile.ty };
    for (let ring = 1; ring <= 8; ring++) {
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const tx = tile.tx + dx;
          const ty = tile.ty + dy;
          if (this.inBounds(tx, ty) && this.walkable(tx, ty)) return { tx, ty };
        }
      }
    }
    // Nothing walkable anywhere near: the middle of the map always beats a
    // coordinate that would draw the citizen off the edge of the world.
    return { tx: this.parsed.w >> 1, ty: this.parsed.h >> 1 };
  }

  /**
   * The tiles an idle agent can rest on, around the fountain.
   *
   * Idle agents used to wait on their own doorstep, which stacked a tower of
   * identical name plates over each house. The park is where a city puts people
   * with nothing to do, and a handful of distinct tiles spreads them out.
   * Wherever the map moves the fountain, this follows.
   */
  buildParkSpots() {
    this.parkSpots = [];
    const park = this.buildings.get('fountain');
    if (!park) return;
    const cx = park.lot.tx + (park.lot.w - 1) / 2;
    const cy = park.lot.ty + (park.lot.h - 1) / 2;
    // Neighbouring tiles are 32 px apart and a name plate is four times that
    // wide, so spots a tile apart would put every plate on top of the next.
    // Keep them PARK_GAP tiles apart, and only relax that if the park is too
    // small to offer six.
    for (const gap of [PARK_GAP, 1]) {
      for (let ring = 1; ring <= 6 && this.parkSpots.length < PARK_SPOTS; ring++) {
        for (let dy = -ring; dy <= ring && this.parkSpots.length < PARK_SPOTS; dy++) {
          for (let dx = -ring; dx <= ring && this.parkSpots.length < PARK_SPOTS; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
            const tx = Math.round(cx + dx);
            const ty = Math.round(cy + dy);
            if (!this.inBounds(tx, ty) || !this.walkable(tx, ty)) continue;
            const crowded = this.parkSpots.some((t) => Math.max(Math.abs(t.tx - tx), Math.abs(t.ty - ty)) < gap);
            if (crowded) continue;
            this.parkSpots.push({ tx, ty });
          }
        }
      }
      if (this.parkSpots.length >= PARK_SPOTS) break;
    }
  }

  /**
   * The bench a given idle citizen keeps.
   *
   * Sticky: re-deciding every snapshot would have the park shuffling itself
   * whenever any other agent changed state.
   */
  parkSpotFor(citizen) {
    if (!this.parkSpots.length) return null;
    if (!citizen.parkSpot) {
      citizen.parkSpot = this.parkSpots[this.parkSeq % this.parkSpots.length];
      this.parkSeq += 1;
    }
    return citizen.parkSpot;
  }

  /**
   * Dev guard, once a second rather than once a frame.
   *
   * Walking every citizen on every frame purely to maybe print one warning is
   * ten thousand iterations a second of debug work in the render loop, and the
   * thing it is looking for cannot appear and disappear between frames.
   */
  assertOnMap() {
    if (this.offMapWarned) return;
    for (const [key, c] of this.citizens) {
      if (this.inBounds(c.tile.tx, c.tile.ty)) continue;
      this.offMapWarned = true;
      console.warn(`[city] citizen ${key} is off the map at ${c.tile.tx},${c.tile.ty}`);
      return;
    }
  }

  // ------------------------------------------------------------------- cars

  addCar(proc) {
    if (!this.loops.length) return null;
    const seq = this.carSeq++;
    const loop = this.loops[seq % this.loops.length];
    const prefix = /node|pwsh|powershell/i.test(String(proc.name || proc.cmd || '')) ? 'truck' : 'car';
    const atlas = this.atlasOf(`${prefix}_se`);
    if (!atlas) return null;
    // Start on the first free stretch of the loop so two cars never spawn on
    // top of each other.
    let at = (seq * 9) % loop.length;
    for (let i = 0; i < loop.length; i++) {
      const j = (at + i * 3) % loop.length;
      if (!this.traffic.has(this.tileKey(loop[j]))) { at = j; break; }
    }
    const car = { id: seq, sprite: null, shade: null, atlas, loop, at, prefix, tween: null, waits: 0, dead: false };
    const next = loop[(at + 1) % loop.length];
    const facing = vehicleFacing(next.x - loop[at].x, next.y - loop[at].y);
    const start = this.carPoint(loop[at], next.x - loop[at].x, next.y - loop[at].y);
    car.sprite = this.add.sprite(start.x, start.y, atlas, `${prefix}_${facing}`)
      .setOrigin(0.5, 0.8)
      .setScale(CAR_SCALE)
      .setDepth(start.y + 1);
    car.shade = this.addShadow(start.x, start.y, car.sprite.displayWidth, start.y - 0.5);
    this.reserve(car, loop[at], facing);
    this.driveCar(car);
    return car;
  }

  tileKey(p) {
    return `${p.x},${p.y}`;
  }

  /** Where a car on tile `p`, stepping (dtx, dty), sits: its right-hand lane. */
  carPoint(p, dtx, dty) {
    const w = this.toWorld(p.x, p.y);
    const lane = laneOffset(dtx, dty);
    return { x: w.x + lane.x, y: w.y + lane.y };
  }

  reserve(car, p, facing) {
    const key = this.tileKey(p);
    if (!this.traffic.has(key)) this.traffic.set(key, new Map());
    this.traffic.get(key).set(car.id, facing);
  }

  release(car, p) {
    const key = this.tileKey(p);
    const holders = this.traffic.get(key);
    if (!holders) return;
    holders.delete(car.id);
    if (!holders.size) this.traffic.delete(key);
  }

  driveCar(car) {
    // A parked car under reduced motion, not one crawling a tile a frame on
    // zero-duration tweens. It picks the loop up again if the preference goes.
    if (car.dead || this.reduced) return;
    const from = car.loop[car.at];
    const nextAt = (car.at + 1) % car.loop.length;
    const to = car.loop[nextAt];
    const dtx = to.x - from.x;
    const dty = to.y - from.y;
    const facing = vehicleFacing(dtx, dty);
    // Queue behind a car in the same lane or let crossing traffic clear the
    // junction. The wait is capped so a ring of cars can never gridlock.
    if (!canEnter(this.traffic.get(this.tileKey(to)), car.id, facing) && car.waits < CAR_MAX_WAITS) {
      car.waits += 1;
      car.tween = this.time.delayedCall(CAR_WAIT_MS, () => { car.tween = null; this.driveCar(car); });
      return;
    }
    car.waits = 0;
    this.reserve(car, to, facing);
    car.sprite.setTexture(car.atlas, `${car.prefix}_${facing}`);
    const w = this.carPoint(to, dtx, dty);
    car.tween = this.tweens.add({
      targets: [car.sprite, car.shade],
      x: w.x,
      y: w.y,
      duration: CAR_MS,
      ease: 'Linear',
      onComplete: () => {
        car.tween = null;
        if (car.dead) return;
        this.release(car, from);
        car.at = nextAt;
        car.sprite.setDepth(car.sprite.y + 1);
        car.shade.setDepth(car.sprite.y - 0.5);
        this.driveCar(car);
      },
    });
  }

  killCar(car) {
    car.dead = true;
    if (car.tween) car.tween.remove();
    for (const [key, holders] of this.traffic) {
      holders.delete(car.id);
      if (!holders.size) this.traffic.delete(key);
    }
    car.sprite.destroy();
    if (car.shade) car.shade.destroy();
  }

  // --------------------------------------------------------------- critters

  /**
   * Five cats on the grass around the park.
   *
   * The park is wherever the map puts the fountain, so this follows a denser
   * layout without being told where the green space moved to.
   */
  buildCritters() {
    if (this.reduced) return;
    const atlas = this.atlasOf('critter1');
    if (!atlas) return;
    const park = this.buildings.get('fountain');
    const centre = park ? { tx: park.lot.tx + 1, ty: park.lot.ty + 1 } : { tx: this.parsed.w >> 1, ty: this.parsed.h >> 1 };
    const spots = [];
    for (let ring = 2; ring <= 8 && spots.length < 5; ring++) {
      for (const [dx, dy] of [[ring, 0], [-ring, 0], [0, ring], [0, -ring], [ring, ring], [-ring, -ring], [ring, -ring], [-ring, ring]]) {
        const tx = centre.tx + dx;
        const ty = centre.ty + dy;
        if (spots.length >= 5) break;
        if (this.grid[ty] && this.grid[ty][tx] === 2) spots.push({ tx, ty });
      }
    }
    for (const { tx, ty } of spots) {
      const c = this.toWorld(tx, ty);
      const sprite = this.add.sprite(c.x, c.y, atlas, 'critter1').setOrigin(0.5, 1).setDepth(c.y + 1);
      const critter = { sprite, atlas, tile: { tx, ty }, home: { tx, ty }, tween: null, timer: null };
      this.critters.push(critter);
      this.hopCritter(critter);
    }
  }

  hopCritter(critter) {
    if (this.reduced) return;
    if (!this.ready && !this.critters.length) return;
    const step = [[1, 0], [-1, 0], [0, 1], [0, -1]][Math.floor(Math.random() * 4)];
    const tx = clamp(critter.tile.tx + step[0], critter.home.tx - 3, critter.home.tx + 3);
    const ty = clamp(critter.tile.ty + step[1], critter.home.ty - 3, critter.home.ty + 3);
    if (this.walkable(tx, ty)) critter.tile = { tx, ty };
    const w = this.toWorld(critter.tile.tx, critter.tile.ty);
    critter.sprite.setFlipX(w.x < critter.sprite.x);
    critter.sprite.setFrame(critter.sprite.frame.name === 'critter1' ? 'critter2' : 'critter1');
    critter.tween = this.tweens.add({
      targets: critter.sprite,
      x: w.x,
      y: w.y,
      duration: 700,
      // A hop is ballistic: it leaves fast and lands. easeInOut glides.
      ease: 'Quad.easeOut',
      onComplete: () => {
        critter.sprite.setDepth(critter.sprite.y + 1);
        critter.timer = this.time.delayedCall(400 + Math.random() * 1600, () => this.hopCritter(critter));
      },
    });
  }

  // ----------------------------------------------------------------- camera

  setupCamera() {
    const cam = this.cameras.main;
    cam.setBackgroundColor(this.tokens.sky);
    // Half a screen of slack past the map on every side. Without it the camera
    // clamps before a corner building reaches the middle, so double-clicking
    // the westernmost house does nothing. At fit zoom the clamp still centres
    // the city, so the slack costs nothing there.
    const slack = 640;
    cam.setBounds(
      -FIT_PAD.x - slack,
      -FIT_PAD.top - slack,
      this.world.w + (FIT_PAD.x + slack) * 2,
      this.world.h + FIT_PAD.top + FIT_PAD.bottom + slack * 2,
    );
    this.fitCamera();
  }

  /**
   * Fit the whole city, allowing for the fact that buildings are drawn upwards
   * from their ground line: the box is taller above the map than below it, and
   * the camera centre shifts by half that difference so nothing clips.
   */
  fitCamera(animate = false) {
    const cam = this.cameras.main;
    const boxW = this.world.w + FIT_PAD.x * 2;
    const boxH = this.world.h + FIT_PAD.top + FIT_PAD.bottom;
    const zoom = fitZoom(cam.width, cam.height, boxW, boxH, MIN_ZOOM, MAX_ZOOM);
    const cx = this.world.w / 2;
    const cy = this.world.h / 2 + (FIT_PAD.bottom - FIT_PAD.top) / 2;
    if (this.fitTween) { this.fitTween.remove(); this.fitTween = null; }
    // The first fit is the city appearing, not the city moving, and a reader
    // who asked for less motion gets the cut either way.
    if (!animate || this.reduced) {
      this.setZoom(zoom);
      cam.centerOn(cx, cy);
      return;
    }
    // DESIGN.md: "auto-fit on layout change with 200 ms ease". Zoom and centre
    // move together, because doing one and then the other reads as two events.
    const from = { zoom: cam.zoom, x: cam.midPoint.x, y: cam.midPoint.y };
    // A plain object rather than a counter tween: reading the value back off
    // the target is the one form that means the same thing in every Phaser 3.
    const at = { t: 0 };
    const step = () => {
      this.setZoom(from.zoom + (zoom - from.zoom) * at.t);
      cam.centerOn(from.x + (cx - from.x) * at.t, from.y + (cy - from.y) * at.t);
    };
    this.fitTween = this.tweens.add({
      targets: at,
      t: 1,
      duration: FIT_MS,
      ease: 'Sine.easeOut',
      onUpdate: step,
      onComplete: () => { this.fitTween = null; step(); },
    });
  }

  setZoom(z) {
    const cam = this.cameras.main;
    const next = clamp(z, MIN_ZOOM, MAX_ZOOM);
    if (Math.abs(next - cam.zoom) < 1e-4) return;
    cam.setZoom(next);
    this.labels.applyZoom(next);
    this.replaceBuildingPlates();
  }

  /** Plates above a building hang from its roof, so a zoom change re-seats them. */
  replaceBuildingPlates() {
    if (!this.buildings) return;
    for (const [, b] of this.buildings) {
      b.plate.setPosition(Math.round(b.anchor.x), Math.round(b.anchor.y - b.img.displayHeight - 6));
    }
    for (const [, h] of this.houses) {
      h.plate.setPosition(Math.round(h.anchor.x), Math.round(h.roofTop - 14));
    }
  }

  setupInput() {
    const cam = this.cameras.main;
    this.input.addPointer(1);

    this.input.on('pointerdown', (p) => {
      this.dragDist = 0;
      // A gesture that starts with one pointer down is never the tail of a
      // pinch, so clearing the flag here means a missed pointerup cannot latch
      // it and swallow every click that follows.
      const second = this.input.pointer2;
      if (!(second && second.isDown)) this.pinched = false;
      // easeOut, not easeInOut: arriving is the moment the viewer is watching,
      // and a slow-in on a move they asked for only delays it.
      if (p.event && p.event.detail === 2) cam.pan(p.worldX, p.worldY, this.reduced ? 0 : PAN_MS, 'Sine.easeOut');
    });

    this.input.on('pointermove', (p) => {
      const p1 = this.input.pointer1;
      const p2 = this.input.pointer2;
      if (p1 && p2 && p1.isDown && p2.isDown) {
        const d = Math.hypot(p1.x - p2.x, p1.y - p2.y);
        if (this.pinch) this.setZoom(cam.zoom * (d / this.pinch));
        this.pinch = d;
        // The pinch branch never accumulates dragDist, so without this both
        // fingers lifting would look like a click on empty ground and clear
        // the panel the viewer was reading.
        this.pinched = true;
        return;
      }
      this.pinch = 0;
      if (!p.isDown) return;
      const dx = p.x - p.prevPosition.x;
      const dy = p.y - p.prevPosition.y;
      this.dragDist += Math.abs(dx) + Math.abs(dy);
      cam.scrollX -= dx / cam.zoom;
      cam.scrollY -= dy / cam.zoom;
    });

    this.input.on('pointerup', () => {
      this.pinch = 0;
      // A pan is not a click, and neither is either finger coming off a pinch.
      // A click on nothing clears the panel.
      const second = this.input.pointer2;
      const gesture = this.pinched || Boolean(second && second.isDown);
      if (!gesture && this.dragDist < 6) this.opts.onSelect(this.pendingPick);
      if (!this.input.pointer1.isDown && !(second && second.isDown)) this.pinched = false;
      this.pendingPick = null;
    });

    // Zoom toward the cursor, not the middle of the screen, so the wheel is
    // also how you get somewhere rather than only how you get closer.
    this.input.on('wheel', (p, over, dx, dy) => {
      const held = { x: p.worldX, y: p.worldY };
      this.setZoom(cam.zoom * (dy > 0 ? 0.88 : 1.14));
      const moved = cam.getWorldPoint(p.x, p.y);
      cam.scrollX += held.x - moved.x;
      cam.scrollY += held.y - moved.y;
    });
  }

  /** Actors record the click; pointerup decides whether it was a click at all. */
  pick(payload) {
    this.pendingPick = payload;
  }

  // ----------------------------------------------------------------- houses

  citizenCtx() {
    const scene = this;
    return {
      labels: this.labels,
      toWorld: (tx, ty) => this.toWorld(tx, ty),
      findPath: (from, to, cb) => this.findPath(from, to, cb),
      familyColor: (f) => this.familyColor(f),
      inkColor: this.hex(this.tokens.ink),
      onPick: (payload) => this.pick(payload),
      // A getter, not a copy. Citizens hold this object for their whole life,
      // so a copied flag meant switching reduced motion on mid-session left
      // every citizen already on the street walking.
      get reduced() { return scene.reduced; },
      actorScale: ACTOR_SCALE,
      stepMs: STEP_MS,
    };
  }

  /**
   * Answer a live `prefers-reduced-motion` change.
   *
   * Citizens read the flag through `citizenCtx`, so they need nothing here; the
   * ambient motion that runs on its own timers does. Turning the preference on
   * has to stop what is already moving, and turning it off again has to start
   * what was never built.
   */
  setReduced(on) {
    const next = Boolean(on);
    if (next === this.reduced) return;
    this.reduced = next;
    if (!this.ready) return;

    for (const [, house] of this.houses) {
      if (house.smoke && next) house.smoke.stop();
    }
    for (const critter of this.critters) {
      if (critter.tween) { critter.tween.remove(); critter.tween = null; }
      if (critter.timer) { critter.timer.remove(); critter.timer = null; }
    }
    for (const [, car] of this.cars) {
      if (car.tween) { car.tween.remove(); car.tween = null; }
    }
    if (!next) {
      if (!this.critters.length) this.buildCritters();
      else for (const critter of this.critters) this.hopCritter(critter);
      for (const [, car] of this.cars) this.driveCar(car);
    }
    // Smoke rates, and anything else a snapshot decides, are re-read from the
    // last snapshot rather than guessed at here.
    if (this.snapshot) this.applySnapshot(this.snapshot);
  }

  addHouse(session, slot) {
    const spot = this.houseLots[this.lotOrder[slot]];
    if (!spot) return null;
    const anchor = spot.anchor;
    const houseAtlas = this.atlasOf('house');
    if (!houseAtlas) return null;
    const img = this.add.image(anchor.x, anchor.y, houseAtlas, 'house').setOrigin(0.5, 1).setDepth(anchor.depth);
    img.setScale(lotScale(spot.lot, img));
    img.setInteractive({ useHandCursor: true });
    img.on('pointerdown', () => this.pick({ type: 'session', sessionId: session.id }));
    const shade = this.addShadow(anchor.x, anchor.y - 3, img.displayWidth, anchor.depth - 0.5);

    const roofTop = anchor.y - img.displayHeight;
    const plate = this.labels.make([sessionLabel(session)], PLATE);
    plate.setPosition(Math.round(anchor.x), Math.round(roofTop - 14));
    plate.setDepth(LABEL_DEPTH + anchor.depth);

    const bar = this.add.graphics().setDepth(LABEL_DEPTH + anchor.depth);
    const door = this.toWorld(spot.door.tx, spot.door.ty);
    const prop = (frame, dx, dy, depth) => {
      const atlas = this.atlasOf(frame);
      return atlas ? this.add.image(door.x + dx, door.y + dy, atlas, frame).setOrigin(0.5, 1).setDepth(depth) : null;
    };
    const sign = prop('signpost', -30, 6, door.y + 2);
    const flag = prop('flagpole', 34, 6, door.y + 2);
    const mat = prop('doormat', 0, 2, door.y - 1);

    // The chimney sits right of centre, a tenth of the way down the roof. The
    // emitter exists even under reduced motion, stopped: turning the
    // preference off mid-session has to reach a house built while it was on.
    //
    // DESIGN.md: 3x3 -> 5x5 px puffs of --stone at a flat 50 % alpha, drifting
    // up a pixel a frame with a pixel of sway. A ramp to zero alpha is the soft
    // fade the brief bans, so the puff simply stops existing at the end of its
    // life instead.
    const smoke = this.add.particles(anchor.x + img.displayWidth * 0.22, roofTop + img.displayHeight * 0.1, 'puff', {
      speedY: { min: -34, max: -26 },
      speedX: { min: -8, max: 8 },
      lifespan: 2000,
      scale: { start: 1, end: 1.7 },
      alpha: 0.5,
      tint: this.hex(this.tokens.stone),
      frequency: 700,
      quantity: 1,
    });
    smoke.setDepth(anchor.depth + 1);
    smoke.stop();

    return {
      id: session.id, slot, spot, img, shade, plate, bar, sign, flag, mat, smoke,
      coins: [], roofTop, anchor, door: spot.door, shown: {},
    };
  }

  killHouse(house) {
    for (const obj of [house.img, house.shade, house.plate, house.bar, house.sign, house.flag, house.mat, house.smoke]) {
      if (obj) obj.destroy();
    }
    if (house.shade) this.shadows = this.shadows.filter((s) => s !== house.shade);
    for (const c of house.coins) c.destroy();
  }

  paintHouse(house, session, now) {
    const alive = Boolean(session.alive);
    // A stopped session fades and greys rather than only going translucent:
    // half alpha alone washed the roof out into the grass.
    const dim = alive ? 1 : 0.62;
    house.img.setAlpha(dim);
    if (house.mat) house.mat.setAlpha(dim);
    if (house.sign) house.sign.setAlpha(dim);
    if (house.flag) house.flag.setAlpha(alive ? 1 : 0.4);
    if (alive) house.img.clearTint();
    else house.img.setTint(this.hex(this.tokens.stone));

    const main = (session.agents || [])[0];
    const family = modelFamily((main && main.model) || session.model);
    if (house.flag) house.flag.setTint(this.hex(alive ? this.familyColor(family) : this.tokens.stone));

    const ctx = session.contextPct;
    const cost = session.costUsd == null ? (session.tokens && session.tokens.costUsd) : session.costUsd;
    const total = (session.tokens && (session.tokens.input || 0) + (session.tokens.output || 0)) || 0;

    house.plate.setAccent(alive ? this.familyColor(family) : this.tokens.stone);
    // A finished session's context and cost are frozen numbers nobody can act
    // on, and a row of "stopped $0.00" plates is what buried the live city.
    house.plate.setLines(alive
      ? [
        truncate(sessionLabel(session), 22),
        truncate(cwdTail(session.cwd, 2), 26),
        `ctx ${ctx == null ? '–' : Math.round(ctx)}%  ${fmtUsd(cost)}  ${fmtTokens(total)}`,
      ]
      : [truncate(sessionLabel(session), 22), 'finished']);

    // The bar drains as the window fills, and an unknown context draws no bar
    // at all: an empty frame reads as "none used", the opposite of "unknown".
    const left = contextRemaining(ctx);
    const stamp = `${left == null ? '?' : Math.round(left)}|${alive}`;
    if (house.shown.bar !== stamp) {
      house.shown.bar = stamp;
      house.bar.clear();
      // No context bar on a finished house either: same reason as the plate.
      if (alive && left != null) {
        const w = 64;
        const h = 8;
        const x = Math.round(house.anchor.x - w / 2);
        const y = Math.round(house.roofTop - 10);
        house.bar.fillStyle(this.hex(this.tokens.paper), dim);
        house.bar.fillRect(x, y, w, h);
        house.bar.fillStyle(this.hex(this.tokens[healthColor(ctx)]), dim);
        house.bar.fillRect(x + 1, y + 1, Math.round((w - 2) * (left / 100)), h - 2);
        house.bar.lineStyle(1, this.hex(this.tokens.ink), dim);
        house.bar.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      }
    }

    const want = alive ? coinCount(cost) : 0;
    while (house.coins.length > want) house.coins.pop().destroy();
    // The pop marks a coin *arriving*. On the house's first paint nothing
    // arrived — a session that appears with cost already accrued would drop
    // twelve coins in one frame, all on the same 100 ms.
    const first = !house.shown.coins;
    house.shown.coins = true;
    let dropped = 0;
    while (house.coins.length < want) {
      const i = house.coins.length;
      const d = this.toWorld(house.door.tx, house.door.ty);
      // Out in front of the doorstep, clear of whoever is standing on it.
      const coin = this.add.image(d.x + 26, d.y + 14 - i * 3, 'coin')
        .setOrigin(0.5, 1)
        .setScale(2.4, 1.2)
        .setDepth(d.y + 6 + i * 0.01);
      coin.setTint(this.hex(this.tokens.coin));
      house.coins.push(coin);
      if (!this.reduced && !first) {
        coin.y -= 4;
        // DESIGN.md: 4 px over 3 frames at 30 fps. Staggered, so two coins in
        // one delta read as two coins rather than one thicker one.
        this.tweens.add({ targets: coin, y: coin.y + 4, duration: 100, delay: dropped * 40, ease: 'Quad.easeIn' });
        dropped++;
      }
    }

    if (house.smoke) {
      const rate = burnRate(this.samples.get(session.id) || [], now);
      if (!alive || rate <= 0 || this.reduced) house.smoke.stop();
      else {
        house.smoke.setFrequency(clamp(1400 - rate / 40, 120, 1400));
        house.smoke.start();
      }
    }
  }

  // --------------------------------------------------------------- snapshot

  /** The wall clock this frame reasons with: the store's if it sent one, else the browser's. */
  syncWallClock(snap) {
    const served = Number(snap && snap.now);
    this.wallNow = Number.isFinite(served) && served > 0 ? served : Date.now();
    return this.wallNow;
  }

  applySnapshot(snap) {
    if (!this.ready) { this.pending = snap; return; }
    this.snapshot = snap;
    const now = this.time.now;
    // Burn samples run on the scene clock; session and tool stamps are wall
    // clock. The store sends its own `now` on the snapshot and on every delta,
    // so replayed frames agree without the connect-time value freezing here and
    // holding the idle window open for ever.
    const wallNow = this.syncWallClock(snap);
    const sessions = (snap && snap.sessions) || [];

    this.trackBurn(sessions, now);
    const housed = pickHouses(sessions, wallNow, this.houseLots.length);
    this.lots = assignLots(housed, this.lots, this.houseLots.length);

    const placed = housed.filter((s) => this.lots.has(s.id));
    const houseDiff = diffKeys(this.houses, placed, (s) => s.id);
    for (const key of houseDiff.removed) { this.killHouse(this.houses.get(key)); this.houses.delete(key); }
    for (const s of houseDiff.added) {
      const view = this.addHouse(s, this.lots.get(s.id));
      if (view) this.houses.set(s.id, view);
    }
    for (const s of placed) {
      const view = this.houses.get(s.id);
      if (view) this.paintHouse(view, s, now);
    }

    // A stopped session shows a dimmed house and no citizens, per DESIGN.md,
    // and a live one puts out only the agents that are working or recently
    // were. Everything else stays in the panel.
    const wanted = [];
    for (const s of sessions) {
      if (!s.alive || !this.houses.has(s.id)) continue;
      for (const a of pickCitizens(s, wallNow, MAX_CITIZENS)) {
        wanted.push({ key: `${s.id}/${a.id}`, session: s, agent: a });
      }
    }
    const citDiff = diffKeys(this.citizens, wanted, (w) => w.key);
    for (const key of citDiff.removed) this.sendHome(key);
    for (const w of citDiff.added) this.citizens.set(w.key, this.spawn(w));

    // Plan first, so two agents heading for the same door can stand apart.
    // `occupancy` counts the citizens already heading to each building and is
    // filled as we go, so once one is full the rest of the batch spills into
    // its overflow building instead of stacking on the same doorstep.
    const occupancy = new Map();
    const crowd = new Map();
    for (const w of wanted) {
      const c = this.citizens.get(w.key);
      if (!c) continue;
      c.plan = this.planFor(w.session, w.agent, c, occupancy);
      if (c.plan.building) occupancy.set(c.plan.building, (occupancy.get(c.plan.building) || 0) + 1);
      const list = crowd.get(c.plan.spot) || [];
      list.push(c);
      crowd.set(c.plan.spot, list);
    }
    for (const [, list] of crowd) {
      // Bodies only. Stacking the plates used to happen here, by slot index,
      // which knew nothing about the building signs or about the agents from
      // other sessions standing at the same door; `layoutCitizenPlates` does it
      // against what is actually on screen instead.
      const offsets = slotOffsets(list.length, SIDE_BY_SIDE);
      list.forEach((c, i) => c.setSlot(clamp(offsets[i], -CROWD_SPAN, CROWD_SPAN), 0));
    }
    for (const w of wanted) {
      const c = this.citizens.get(w.key);
      if (c) this.steer(c, w.session, w.agent);
    }

    const procs = [];
    for (const s of sessions) {
      if (!s.alive) continue;
      for (const p of s.procs || []) procs.push(p);
    }
    const carDiff = diffKeys(this.cars, procs.slice(0, 12), (p) => String(p.pid));
    for (const key of carDiff.removed) { this.killCar(this.cars.get(key)); this.cars.delete(key); }
    for (const p of carDiff.added) {
      const car = this.addCar(p);
      if (car) this.cars.set(String(p.pid), car);
    }

    this.paintBoard(snap);
  }

  trackBurn(sessions, now) {
    for (const s of sessions) {
      const total = (s.tokens && (s.tokens.input || 0) + (s.tokens.output || 0)) || 0;
      const list = this.samples.get(s.id) || [];
      const last = list.length ? list[list.length - 1] : null;
      list.push({ ts: now, total, tokens: last ? Math.max(0, total - last.total) : 0 });
      while (list.length > 80) list.shift();
      this.samples.set(s.id, list);
    }
  }

  spawn(w) {
    const { session, agent } = w;
    const house = this.houses.get(session.id);
    const hall = this.buildings.get('town_hall');
    const main = (session.agents || [])[0];
    // Subagents arrive at the Town hall; a session's own agent leaves its house.
    const isMain = !main || main.id === agent.id;
    const door = isMain || !hall ? house.door : hall.door;
    return new Citizen(this, this.citizenCtx(), {
      key: w.key,
      tile: this.nearestWalkable(door),
      family: modelFamily(agent.model || session.model),
      pose: 'idle_front',
      state: agent.state,
      selected: session.id === this.selectedId,
      select: { type: 'agent', sessionId: session.id, agentId: agent.id },
      lines: [truncate(sessionLabel(session), 26)],
    });
  }

  /** A citizen whose agent is gone walks back to its front door, then fades. */
  sendHome(key) {
    const c = this.citizens.get(key);
    this.citizens.delete(key);
    if (!c) return;
    const house = this.houses.get(key.split('/')[0]);
    if (!house) { c.vanish(); return; }
    this.leaving.add(c);
    c.setSlot(0, 0);
    c.onArrive = () => { c.onArrive = null; this.leaving.delete(c); c.vanish(); };
    c.goTo(house.door, 'idle_front');
  }

  /** Where an agent should be standing, given what it is doing right now. */
  planFor(session, agent, citizen, occupancy) {
    const house = this.houses.get(session.id);
    const tool = agent.state === 'running' ? agent.tool : null;

    if (isChopping(tool)) {
      // One tree per command. Without the stamp the citizen would pick the
      // next nearest standing tree on every snapshot and clear-fell the park.
      const stamp = `${tool.name}|${tool.summary || ''}|${tool.since || ''}`;
      let tree = citizen.chopStamp === stamp ? citizen.chopTree : null;
      if (!tree) {
        const standing = this.trees.filter((t) => !t.stumped);
        const pool = standing.length ? standing : this.trees;
        tree = pool[nearestIndex(citizen.tile, pool)];
        citizen.chopStamp = stamp;
        citizen.chopTree = tree;
      }
      if (tree) return { spot: `tree:${tree.tx},${tree.ty}`, tile: this.openNeighbour(tree), pose: 'chop', tree };
    }
    if (!tool) {
      // Idle agents rest in the park rather than crowding their own doorstep.
      const bench = this.parkSpotFor(citizen);
      if (bench) return { spot: `park:${bench.tx},${bench.ty}`, tile: bench, pose: 'sit', idle: true };
      return { spot: `home:${session.id}`, tile: house.door, pose: 'idle_front', idle: true };
    }
    // Back to work: give up the bench so the next idle agent can have it.
    citizen.parkSpot = null;
    const key = buildingFor(tool.name, occupancy);
    const b = this.buildings.get(key);
    if (!b) return { spot: `home:${session.id}`, tile: house.door, pose: 'idle_front' };
    return { spot: key, building: key, tile: b.door, pose: poseFor(key) };
  }

  steer(c, session, agent) {
    const plan = c.plan;
    c.setLines(citizenPlate(session, agent), modelFamily(agent.model || session.model));
    c.setAgentState(agent.state);
    c.setOwnerSelected(session.id === this.selectedId);

    c.onArrive = plan.tree && !plan.tree.stumped ? () => { c.onArrive = null; this.fellTree(plan.tree); } : null;
    c.goTo(plan.tile, plan.pose);
  }

  fellTree(tree) {
    if (tree.stumped) return;
    tree.stumped = this.time.now;
    const stump = this.atlasOf('stump');
    if (stump) tree.img.setTexture(stump, 'stump');
    this.time.delayedCall(STUMP_MS, () => {
      tree.stumped = 0;
      const back = this.atlasOf('tree');
      if (back) tree.img.setTexture(back, 'tree');
    });
  }

  paintBoard(snap) {
    if (!this.board) return;
    const totals = (snap && snap.totals) || {};
    const tok = totals.tokens || {};
    const alive = totals.sessionsAlive == null ? this.houses.size : totals.sessionsAlive;
    const running = totals.agentsRunning == null ? this.citizens.size : totals.agentsRunning;
    this.board.plate.setLines([
      'Town hall',
      `${alive} sessions · ${running} agents working`,
      `${fmtUsd(tok.costUsd)} · ${fmtTokens((tok.input || 0) + (tok.output || 0))} tokens`,
    ]);
  }

  // ------------------------------------------------------------------ guard

  flashShield(sessionId, mode) {
    if (!this.ready) return;
    const bad = mode === 'block';
    const color = this.hex(bad ? this.tokens.bad : this.tokens.warn);
    const house = this.houses.get(sessionId);

    if (house) {
      const ring = this.add.graphics().setDepth(LABEL_DEPTH - 10);
      ring.lineStyle(2, color, 1);
      ring.strokePoints(toPoints(this.lotPolygon(house.spot.lot)), true);
      this.tweens.add({
        targets: ring,
        alpha: 0,
        duration: this.reduced ? 0 : (bad ? 600 : 300),
        // A linear fade sits near full brightness for half its life and then
        // vanishes. easeIn holds the alert bright, then drops it.
        ease: 'Quad.easeIn',
        onComplete: () => ring.destroy(),
      });
    }

    const target = this.mainCitizen(sessionId);
    if (target) {
      target.say(bad ? '! blocked' : '! warning', bad ? 6000 : 2600);
      if (target.bubble) target.bubble.setAccent(bad ? this.tokens.bad : this.tokens.warn);
    }

    const post = this.buildings.get('guard_post');
    if (!bad || !target || !post || this.guard) return;
    const guard = new Citizen(this, this.citizenCtx(), {
      key: 'guard', kind: 'guard', tile: post.door, pose: 'guard_idle', silent: true,
    });
    this.guard = guard;
    guard.onArrive = () => {
      guard.onArrive = null;
      guard.say('! blocked', 2400);
      if (guard.bubble) guard.bubble.setAccent(this.tokens.bad);
      this.time.delayedCall(2000, () => {
        if (guard.dead) return;
        guard.onArrive = () => { guard.onArrive = null; this.guard = null; guard.vanish(); };
        guard.goTo(post.door, 'guard_idle');
      });
    };
    guard.goTo(this.openNeighbour(target.tile), 'guard_idle');
  }

  mainCitizen(sessionId) {
    for (const [key, c] of this.citizens) if (key.startsWith(`${sessionId}/`)) return c;
    return null;
  }

  // -------------------------------------------------------------- selection

  /**
   * Mark one session as the one the panel is describing, or `null` for none.
   *
   * The ring is redrawn every frame rather than parented to anything, because
   * the agents it also marks are walking: a static graphic would sit where they
   * were when the row was clicked. Selection deliberately lives outside the
   * snapshot so nothing about it can be lost on the next store delta.
   */
  setSelected(sessionId) {
    const next = sessionId || null;
    const changed = next !== this.selectedId;
    this.selectedId = next;
    // Selecting a session is also how you read the names of its resting
    // agents, so their plates follow the panel immediately.
    if (changed) {
      for (const [key, c] of this.citizens) c.setOwnerSelected(next !== null && key.startsWith(`${next}/`));
    }
    if (!changed || !this.ready || !next) return;
    // A ring on a plot at the edge of a fitted city is easy to miss, so picking
    // a session in the panel also takes the camera to it.
    const house = this.houses.get(next);
    if (house) this.cameras.main.pan(house.anchor.x, house.anchor.y, this.reduced ? 0 : PAN_MS, 'Sine.easeOut');
  }

  drawSelection() {
    // Nothing selected is the common case, and clearing and refilling two
    // graphics objects every frame to draw nothing is work for nobody.
    const house = this.selectedId ? this.houses.get(this.selectedId) : null;
    if (!house && !this.selDrawn) return;
    // Two layers: the wash sits just above the ground so the buildings keep
    // their own colours, the ring and the foot markers sit above everything so
    // a citizen working on the far side of town is still marked.
    if (!this.selFill) this.selFill = this.add.graphics().setDepth(-998);
    if (!this.selGfx) this.selGfx = this.add.graphics().setDepth(LABEL_DEPTH - 12);
    const fill = this.selFill;
    const g = this.selGfx;
    fill.clear();
    g.clear();
    this.selDrawn = Boolean(house);
    if (!house) return;

    const accent = this.hex(this.tokens.roof);
    // The city is fitted to the viewport at well under 1×, so a line authored in
    // world pixels lands at under two screen pixels and disappears. Widths are
    // divided by the zoom to stay the thickness they were drawn to be.
    const z = this.cameras.main.zoom || 1;
    const pts = toPoints(this.lotPolygon(house.spot.lot));
    fill.fillStyle(accent, 0.3);
    fill.fillPoints(pts, true);
    g.lineStyle(Math.max(3, 4 / z), accent, 1);
    g.strokePoints(pts, true);

    // Every citizen of that session, wherever its tool has sent it.
    g.lineStyle(Math.max(2, 3 / z), accent, 1);
    for (const [key, c] of this.citizens) {
      if (key.slice(0, key.indexOf('/')) !== this.selectedId) continue;
      g.strokeEllipse(c.x + (c.offsetX || 0), c.y, 30, 14);
    }
  }

  // ------------------------------------------------------------------ theme

  setTheme(tokens) {
    this.tokens = { ...this.tokens, ...tokens };
    if (!this.ready) return;
    this.cameras.main.setBackgroundColor(this.tokens.sky);
    this.labels.setTokens(this.tokens);
    this.drawWater();
    const ink = this.hex(this.tokens.ink);
    for (const shade of this.shadows) shade.setTint(ink);
    for (const [, c] of this.citizens) if (c.shade) c.shade.setTint(ink);
    this.plates.clear();
    for (const [, b] of this.buildings) this.drawLotPlate(b.lot);
    for (const spot of this.houseLots) if (spot) this.drawLotPlate(spot.lot);
    for (const [, house] of this.houses) {
      house.shown.bar = null;
      for (const coin of house.coins) coin.setTint(this.hex(this.tokens.coin));
      if (house.smoke) house.smoke.setParticleTint(this.hex(this.tokens.stone));
    }
    for (const [, c] of this.citizens) c.plate && c.plate.setAccent(this.familyColor(c.family));
    if (this.snapshot) this.applySnapshot(this.snapshot);
  }

  handleResize() {
    if (!this.ready) return;
    // The camera does not always have the new size yet when this fires, and a
    // camera smaller than its canvas draws the whole city into one corner.
    const cam = this.cameras.main;
    if (this.scale.width && this.scale.height) cam.setSize(this.scale.width, this.scale.height);
    this.fitCamera(true);
  }

  // ------------------------------------------------------------------ frame

  /**
   * Keep the name plates off each other.
   *
   * Eight agents round one door, a house sign behind them and a building plate
   * behind that is four or five plates in the same 300x120 px of screen, which
   * is the state the review found: unreadable, and unreadable is the one thing
   * the city cannot afford, because reading it is the whole point.
   *
   * Building and house signs are fixed obstacles — they name the map, they do
   * not move for anyone. Everything else stacks above them or, past three
   * stacks, steps aside, lowest priority first.
   */
  layoutCitizenPlates() {
    const s = this.labels.scale;
    const boxes = [];
    const fixedBox = (plate) => ({
      key: null,
      fixed: true,
      x: plate.x,
      y: plate.y,
      w: (plate.plateW || 0) * s,
      h: (plate.plateH || 0) * s,
    });
    for (const [, b] of this.buildings) if (b.plate && b.plate.visible) boxes.push(fixedBox(b.plate));
    for (const [, h] of this.houses) if (h.plate && h.plate.visible) boxes.push(fixedBox(h.plate));

    const movers = [];
    for (const [key, c] of this.citizens) {
      if (!c.plateShown || !c.plate) continue;
      const box = c.plateBox(key);
      if (!box) continue;
      boxes.push(box);
      movers.push(c);
    }
    if (!movers.length) return;

    const out = layoutPlates(boxes, { gap: PLATE_GAP, maxStacks: PLATE_STACKS });
    // The movers are the tail of `boxes`, in order, so the two line up.
    const from = out.length - movers.length;
    for (let i = 0; i < movers.length; i++) {
      const r = out[from + i];
      movers[i].applyPlateLayout(r.lift, r.visible);
      movers[i].place();
    }
  }

  update(time) {
    if (!this.ready) return;
    // Frames keep coming between deltas, so the wall clock advances here too.
    this.wallNow = Date.now();
    if (this.finder) this.finder.calculate();
    for (const [, c] of this.citizens) c.tick(time);
    for (const c of this.leaving) c.tick(time);
    if (this.guard && !this.guard.dead) this.guard.tick(time);
    this.layoutCitizenPlates();
    this.drawSelection();
  }
}
