// Generate reference art and sprite sources with OpenAI's newest image model.
// Usage: node tools/gen-art.mjs [name ...]   (no names = all)
// Reads OPENAI_API_KEY from env, else from ../.env.local, else ./.env (never prints it).
// Output: public/assets/raw/<name>.png (git-ignored) + public/assets/raw/manifest.json
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'assets', 'raw');

function loadKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  for (const f of [process.env.CC_ENV_FILE, join(ROOT, '..', '.env.local'), join(ROOT, '.env')]) {
    if (!f || !existsSync(f)) continue;
    const m = /^OPENAI_API_KEY=(.+)$/m.exec(readFileSync(f, 'utf8'));
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('OPENAI_API_KEY not found (env, ../.env.local, ./.env)');
}
const KEY = loadKey();
const H = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };

const PALETTE = 'strict palette: grass #8fcf6b and #7bbd5a, wood #c98a4b, terracotta roof #e0694b, stone #b9b3a8, ink outline #2b2620, paper #fbf7ef, coin gold #f2c14e';
const STYLE = `clean pixel art, 2:1 isometric projection, flat colours, no gradients, no anti-aliasing, thick 1-pixel dark outlines, ${PALETTE}, no text, no watermark`;

export const PROMPTS = {
  moodboard_town: { size: '1536x1024', background: 'opaque', prompt: `Isometric pixel art town of six small craftsman workshops on a grass tile grid with stone paths between plots, each plot with a wooden house with terracotta roof, a sign post, a chimney with smoke, small pixel characters working at an anvil, a desk with a book, a computer terminal crate, a radio dish, and a flagpole; tiny grey critters on the grass; cosy Stardew Valley meets Animal Crossing mood; ${STYLE}` },
  house: { size: '1024x1024', background: 'key', prompt: `One isometric pixel art workshop house, front-left 2:1 isometric view, wooden plank walls, terracotta tiled roof with dark outline, one door, two windows, a stone chimney, centred, nothing else in frame; ${STYLE}` },
  stations: { size: '1536x1024', background: 'key', prompt: `Sprite sheet, 4 columns by 2 rows, evenly spaced on transparent background, isometric pixel art props at the same scale: (1) anvil with a hammer, (2) wooden desk with an open book, (3) wooden crate with a glowing green computer screen, (4) small radio dish antenna on a post, (5) flagpole with a terracotta flag, (6) doormat, (7) closed wooden crate, (8) wooden sign post with a blank paper board; ${STYLE}` },
  character: { size: '1024x1024', background: 'key', prompt: `Sprite sheet of one chunky pixel art character, 4 columns by 2 rows: top row idle front, idle side, walk frame 1, walk frame 2; bottom row walk frame 3, walk frame 4, working with hammer, reading a book; round paper-white head with two dot eyes, capsule body in terracotta, short arms and legs, thick dark outline, same scale in every cell; ${STYLE}` },
  critter: { size: '1024x1024', background: 'key', prompt: `Sprite sheet of a tiny round grey pixel art critter with two ears, 2 frames side by side (standing, scurrying), thick dark outline; ${STYLE}` },
  tiles: { size: '1024x1024', background: 'key', prompt: `Two isometric 2:1 diamond floor tiles side by side on transparent background: left a grass tile with a subtle two-tone checker, right a grey stone path tile; sharp diamond edges, thick dark outline; ${STYLE}` },
  // --- city set (2026-09-17): one shared city instead of per-session plots ---
  city_civic_a: { size: '1536x1024', background: 'key', prompt: `Sprite sheet, 3 columns by 2 rows, evenly spaced, isometric pixel art public buildings at the same scale as a small wooden house, each with a small name plate: (1) LIBRARY with columns and tall windows, paper-white walls, terracotta roof, (2) FORGE workshop with an open front, anvil and a brick furnace glow, (3) SERVER HALL, a stone building with green screens visible and a cooling fan, (4) RADIO TOWER, a lattice mast with a dish on a small stone hut, (5) TOWN HALL with a clock tower and a notice board, (6) GUARD POST, a small stone booth with a shield sign; ${STYLE}` },
  city_civic_b: { size: '1536x1024', background: 'key', prompt: `Sprite sheet, 3 columns by 2 rows, evenly spaced, isometric pixel art buildings and props at the same scale as a small wooden house: (1) BANK with a vault door and a coin sign, (2) SCHOOL with a bell and a blackboard sign, (3) WATER TOWER on wooden legs, (4) PARK FOUNTAIN, round stone with blue water, (5) PARK BENCH, wooden, (6) pine TREE and a tree STUMP side by side; ${STYLE}` },
  city_roads: { size: '1536x1024', background: 'key', prompt: `Sprite sheet, 4 columns by 2 rows, evenly spaced, isometric 2:1 diamond road tiles of identical size: (1) straight road running north-east, (2) straight road running north-west, (3) four-way crossroad, (4) T junction, (5) T junction mirrored, (6) corner, (7) corner mirrored, (8) sidewalk paving tile; grey asphalt with a light centre dash, stone kerb, sharp diamond edges; ${STYLE}` },
  city_vehicles: { size: '1536x1024', background: 'key', prompt: `Sprite sheet, 4 columns by 2 rows, evenly spaced, isometric pixel art vehicles and people at the same scale as a chunky pixel character: (1) small terracotta car facing north-east, (2) same car facing north-west, (3) small wooden delivery truck facing north-east, (4) same truck facing north-west, (5) GUARD character in grey uniform holding a round shield, idle, (6) guard running frame, (7) character sitting on a bench, (8) character chopping a tree with an axe; ${STYLE}` },
  character_extra: { size: '1024x1024', background: 'key', ref: 'character.png', prompt: `Using the exact same character design, proportions, colours and pixel style as the reference sprite sheet, draw a new sprite sheet of 4 columns by 2 rows, evenly spaced, same scale as the reference: top row (1) the character sitting on a small wooden park bench, (2) the character swinging an axe at a pine tree trunk, (3) the same character wearing a grey guard uniform holding a round shield, idle, (4) the guard running; bottom row (5) the character typing at a small green-screen terminal, (6) the character talking into a radio handset, (7) the character waving a small terracotta flag, (8) the character sleeping in a chair with a zzz; ${STYLE}` },
  city_vehicles_4dir: { size: '1536x1024', background: 'key', ref: 'city_vehicles.png', prompt: `Same style, colours, scale and 2:1 isometric angle as the two terracotta cars and the wooden truck in the reference. Sprite sheet 4 columns by 2 rows, evenly spaced, nothing else: top row the small terracotta car in four driving directions: (1) driving toward the viewer and to the RIGHT (south-east): headlights and front bumper visible at the lower right, (2) driving toward the viewer and to the LEFT (south-west): headlights and front bumper visible at the lower left, (3) driving away from the viewer and to the RIGHT (north-east): rear bumper and tail lights visible at the lower left, front hidden at the upper right, (4) driving away from the viewer and to the LEFT (north-west): rear bumper and tail lights visible at the lower right, front hidden at the upper left; bottom row the same four directions for the small wooden delivery truck with a terracotta cab, in the same order; every vehicle's long axis lies exactly along a 2:1 isometric diagonal; ${STYLE}` },
  city_extra_a: { size: '1536x1024', background: 'key', ref: 'city_civic_a.png', prompt: `Same style, scale, palette and isometric angle as the reference sheet, without name plates: sprite sheet 3 columns by 2 rows, evenly spaced: (1) CAFE with awning and outdoor tables, (2) BAKERY with a bread sign, (3) MARKET STALL with fruit crates under a striped canopy, (4) WAREHOUSE with big double doors and barrels, (5) APARTMENT BLOCK three storeys with balconies, (6) CLINIC with a small cross sign; ${STYLE}` },
  city_extra_b: { size: '1536x1024', background: 'key', ref: 'city_civic_a.png', prompt: `Same style, scale, palette and isometric angle as the reference sheet, without name plates: sprite sheet 3 columns by 2 rows, evenly spaced: (1) WINDMILL, (2) GREENHOUSE with glass panes, (3) BELL TOWER, (4) WORKSHOP with a garage door, (5) INN with a hanging sign and chimney, (6) OBSERVATORY with a small dome; ${STYLE}` },
  city_decor: { size: '1536x1024', background: 'key', ref: 'stations.png', prompt: `Same style, scale, palette and isometric angle as the reference sheet: sprite sheet 4 columns by 3 rows, evenly spaced, small isometric pixel art street props: (1) street lamp post, (2) wooden fence segment along the north-east edge, (3) wooden fence segment along the north-west edge, (4) mailbox, (5) stone well, (6) wooden cart with sacks, (7) three stacked barrels, (8) flower bed with red and yellow flowers, (9) round hedge, (10) big oak tree, (11) small pine tree, (12) rock cluster; ${STYLE}` },
  city_moodboard: { size: '1536x1024', background: 'opaque', prompt: `Isometric pixel art small city seen from above: a main street crossroad with sidewalks, a library, a forge, a server hall with green screens, a radio tower, a town hall with a clock, a bank, a school, a guard post, a park with a fountain and benches and pine trees, a water tower, a residential row of six small wooden houses with terracotta roofs and chimneys, small cars on the road, chunky pixel characters walking on sidewalks and working, tiny grey critters; cosy Stardew Valley meets Animal Crossing mood; ${STYLE}` },
};

async function newestImageModel() {
  const r = await fetch('https://api.openai.com/v1/models', { headers: H });
  if (!r.ok) throw new Error(`models: ${r.status}`);
  const ids = (await r.json()).data.map((m) => m.id).filter((id) => /image/.test(id) && !/dall-e/.test(id));
  ids.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return ids[0] || 'gpt-image-1';
}

async function generate(model, name, spec) {
  const body = { model, prompt: spec.prompt, size: spec.size, n: 1, output_format: 'png', quality: 'high' };
  if (spec.background === 'transparent') body.background = 'transparent';
  if (spec.background === 'key') body.prompt += '; drawn on a completely flat solid magenta #ff00ff background with no glow, no shadow, no vignette';
  let r;
  if (spec.ref) {
    // image edit with a reference sheet so new poses match the existing character design
    const fd = new FormData();
    fd.append('model', model); fd.append('prompt', body.prompt); fd.append('size', spec.size); fd.append('quality', 'high'); fd.append('output_format', 'png');
    fd.append('image', new Blob([readFileSync(join(OUT, spec.ref))], { type: 'image/png' }), spec.ref);
    r = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { authorization: H.authorization }, body: fd });
  } else {
    r = await fetch('https://api.openai.com/v1/images/generations', { method: 'POST', headers: H, body: JSON.stringify(body) });
  }
  const j = await r.json();
  if (!r.ok) throw new Error(`${name}: ${r.status} ${JSON.stringify(j.error || j).slice(0, 300)}`);
  const b64 = j.data[0].b64_json;
  const file = join(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(b64, 'base64'));
  return { file: `${name}.png`, model, size: spec.size, usage: j.usage || null };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(PROMPTS);
  const model = process.env.CC_IMAGE_MODEL || (await newestImageModel());
  console.log(`[gen-art] model ${model}; generating ${names.join(', ')}`);
  const manifestPath = join(OUT, 'manifest.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
  for (const name of names) {
    if (!PROMPTS[name]) { console.error(`[gen-art] unknown ${name}`); continue; }
    const t0 = Date.now();
    try {
      const res = await generate(model, name, PROMPTS[name]);
      manifest[name] = { ...res, prompt: PROMPTS[name].prompt, at: new Date().toISOString() };
      console.log(`[gen-art] ${name} → ${res.file} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    } catch (e) { console.error(`[gen-art] ${name} failed: ${e.message}`); }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
