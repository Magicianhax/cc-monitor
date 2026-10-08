# claude-city design

## Overview
An isometric pixel-art town of every running Claude Code session, drawn on a 2D canvas at integer scale, with a persistent information panel on the right. Tone: warm, toy-like, calm. References: Animal Crossing, Overcooked, Untitled Goose Game. Not: neon, glass, gradients, HUD sci-fi.

## Colors (CSS tokens on :root; three.js reads the same hex)
| token | light | dark | use |
|---|---|---|---|
| --sky      | #cfe8f3 | #1b2430 | scene background |
| --grass    | #8fcf6b | #4f8a3f | ground tiles |
| --grass-2  | #7bbd5a | #3f7333 | checker alternate |
| --wood     | #c98a4b | #9a6a3a | walls, benches |
| --roof     | #e0694b | #b5533a | roofs (accent) |
| --stone    | #b9b3a8 | #6f6a62 | paths, chimney |
| --ink      | #2b2620 | #f2ede4 | outlines, overlay text |
| --paper    | #fbf7ef | #262d38 | overlay cards |
| --coin     | #f2c14e | #d9a93a | cost pile |
| --ok       | #58b368 | #58b368 | health bar full, allowed |
| --warn     | #e8a838 | #e8a838 | health bar mid, guard warn |
| --bad      | #d9534f | #d9534f | health bar low, guard block |
One accent: `--roof`. Everything else is neutral or literal (grass is green because it is grass).

## Typography
- Pixel: "Pixelify Sans" (Google Fonts), fallback monospace. Used inside the canvas only, at 11 px headline and 9 px detail, held at a constant screen size as the camera zooms. Session signs, agent labels, ctx/cost text, guard bubbles. In-canvas text is rendered at `resolution: 2` and is anti-aliased: the labels are read at a fitted zoom well under 1×, where a 1× bitmap grid is illegible, and legibility wins.
- Display: "Fredoka", fallback "Nunito", fallback system-ui. Panel headings and big numbers. Weights 600/700.
- Data: "JetBrains Mono", fallback ui-monospace, tabular numbers, in three steps and no others: 13 px for a data row, 12 px for the metadata line under it, 11 px for uppercase micro-labels and chips. The tokens are `--t-data`, `--t-meta`, `--t-micro`.
- Fonts from Google Fonts only. No Inter.

## Layout
- Canvas fills what the panel leaves. The side card is persistent, not slide-in (a monitor is read continuously), 380 px wide on the right, with the strip of totals at its foot (34 px). Replay bar sits over the canvas above the strip when a finished session is selected; banner across the top only when disconnected.
- Phone width (≤ 640 px): side card becomes a bottom sheet at 50 % height; strip stays. The sheet reorders rather than scrolls: header, then "Happening now", then sessions, activity and detail, so the live answer is above the fold at 400×800. Above 640 px the document order stands.
- 16 px gutters everywhere, including the strip. Cards: 2 px `--ink` outline, 12 px radius, `--paper` fill, no shadow.
- Fixed elements keep clear of `env(safe-area-inset-*)`.

## Scene components (logical pixels; 1 logical px = s screen px, s ∈ 1..6)
- Tiles: 32×16 isometric diamonds. Grass checker (`--grass` / `--grass-2`), `--stone` path tiles along plot edges. Every plot is 7×7 tiles; plots sit on a spiral with a 1-tile gap.
- House (one per session; the shipped map labels a different, shared building "Workshop", so a session's own building is a house and the empty state says so): pixel house occupying the back 3×3 tiles: `--wood` walls, `--roof` roof with 2-px `--ink` outline, a door, two windows, a `--stone` chimney. Sign post in front with the session name (11 px pixel font) and the cwd tail (9 px) on a `--paper` board. Dead session: house dimmed and greyed, sign reads "finished", no context bar, no coins, no characters.
- Stations inside the plot: anvil + hammer (file edits, tile 1,5), desk with open book (read/search, 5,5), terminal crate with blinking screen (shell, 1,1), radio dish (web/MCP, 5,1), flagpole (agent/workflow, 3,6), doormat (idle, 3,4), crate (other, 3,5).
- Character: ≈32 px tall sprite (scaled to the 64×32 tile grid), body colour by model family (Fable `--roof`, Opus `--wood`, Sonnet #3b6ea5, Haiku `--stone`, unknown `--ink`), `--paper` face, 2 eye pixels, 1-px `--ink` outline. Main agent is drawn at 1×, other agents at 1× but 4 px shorter. Facing left/right by horizontal flip. Flat `--ink` contact ellipse at 18 % under the feet, four fifths of the body's width and a third as tall.
- Name plate above the head: line 1 agent label, line 2 current tool + summary (9 px), each truncated to 28 chars with "…". A working agent always asks for its plate; an idle one shows it only on hover or while its session is selected. Plates de-collide every frame against each other and against the building and house signs: a plate that would land on one already placed stacks a plate height plus 2 px above it, at most three times, and past that the least interesting plate of the pile (idle before working, working before hovered) steps aside.
- Critter: 8×8 px, `--stone`, two ear pixels, 2-frame scurry. Five of them in the park, as decor: they are the one thing in the city that carries no state, and they stop entirely under reduced motion.
- Health bar: 40×5 px above the roof, `--ink` frame, fill = 1 − ctx % coloured ok/warn/bad at 50/80 %, with "ctx NN%" text to its right. An unknown context draws no bar at all, because an empty frame reads as "none used".
- Coin stack: 6×2 px coins in `--coin` stacked by the door, count = coinCount(cost), "$N.NN" 8 px text beside it.
- Smoke: 0–8 puffs (3×3 → 5×5 px, `--stone` at 50 % alpha) rising from the chimney, count ∝ tokens/min over the last 60 s.
- Shield: `--bad` (block) or `--warn` (warn) 2-px ring around the plot, fading over 600 / 300 ms.
- Speech bubble: `--paper` box with `--ink` border and a tail, above the character. Guard verdicts only — "! blocked" for 6 s, "! warning" for 2.6 s. A bubble on every tool change was dropped: the plate already carries the tool, and a bubble per change is motion that says nothing new.

## Motion (all at 30 fps cap)
- Spawn: character grows from 0 to full height over 6 frames, easing out with no overshoot. Despawn: shrinks over 4 frames (133 ms), never fades — a fade makes the 1-px outline translucent.
- Walk: 4-frame cycle at 8 fps along the straight line between tiles, 1 tile per 0.5 s. Idle: 2-frame breathe at 1 fps. Working: station-specific loop (hammer 2 frames, page flip 2 frames, screen blink, dish blink, flag wave). Not built yet: the sheets carry one frame per work pose, so a working citizen bobs 1 px and an idle one is still.
- Coin pop: new coin drops 4 px over 3 frames (100 ms), staggered 40 ms apart, and not at all on a house's first paint — nothing arrived. Smoke drifts up ≈1 px per frame with ±1 px sway, at a flat 50 % alpha.
- Guard shield: `--bad` block ring fades over 600 ms, `--warn` over 300 ms, easing in so the alert holds bright and then drops.
- `prefers-reduced-motion`: teleport instead of walk, no bob, no smoke, no cats, parked cars, no camera easing; keep spawn. The preference is live — turning it on reaches every citizen, emitter, critter and car already on screen, and turning it off starts them again.
- Camera: drag to pan; double-click a plot to centre it; any camera move the viewer asked for takes 200 ms easing out. Wheel and pinch zoom are continuous rather than integer-stepped: the city is read at a fitted zoom well under 1×, where integer steps would offer one usable stop. Auto-fit on a layout change eases over 200 ms instead of cutting.

## Do / Don't
- Do draw everything on the offscreen logical canvas with integer coordinates; blit once per frame with smoothing off.
- Do keep every colour a palette token; sprites reference tokens, never literal hex (except the four model-family colours listed above).
- Do keep the panel to what the scene cannot show; the scene carries names, tools and numbers itself.
- Do keep one accent, `--roof`. The feed's tool families are an ink ramp, not six hues; saturated colour is reserved for selection, `--bad` and `--warn`.
- Don't use gradients, glass, glow, blur, emoji, a second accent, or drop shadows — except the flat `--ink` contact ellipse at 18 %, which is what stops every sprite floating above its tile.
- Don't animate anything that did not change state. The park cats are the single, named exception.
