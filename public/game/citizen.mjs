// A person in the city: one agent, one guard, or one sleeper by a front door.
//
// The citizen owns its sprite and its two-line name plate. It walks a tile path
// found by the scene, strikes the work pose of whatever building it arrived at,
// and says what it is doing in a bubble whenever the tool changes.

import { GameObjects } from 'phaser';

import { PLATE_PRIORITY, plateVisible } from './util.mjs';

/** Which sheet each pose was drawn on. */
const POSE_ATLAS = {
  idle_front: 'character',
  idle_side: 'character',
  walk1: 'character',
  walk2: 'character',
  walk3: 'character',
  walk4: 'character',
  work_hammer: 'character',
  work_read: 'character',
  sit: 'character_extra',
  chop: 'character_extra',
  work_terminal: 'character_extra',
  work_radio: 'character_extra',
  work_flag: 'character_extra',
  sleep: 'character_extra',
  guard_idle: 'character_extra',
  guard_run: 'character_extra',
};

const WALK = ['walk1', 'walk2', 'walk3', 'walk4'];
const WALK_FPS = 8;
/** How long to wait before asking the pathfinder a second time. */
const RETRY_MS = 2000;

export class Citizen extends GameObjects.Container {
  /**
   * `ctx` is the scene's toolbox: tile-to-world conversion, the pathfinder,
   * the label factory, and the two motion settings the whole city shares.
   */
  constructor(scene, ctx, init) {
    const at = ctx.toWorld(init.tile.tx, init.tile.ty);
    super(scene, at.x, at.y);

    this.ctx = ctx;
    this.key = init.key;
    this.kind = init.kind || 'agent';
    this.family = init.family || 'unknown';
    this.tile = { tx: init.tile.tx, ty: init.tile.ty };
    this.homeTile = { ...this.tile };
    this.pose = init.pose || 'idle_front';
    this.restPose = this.pose;
    this.offsetX = init.offsetX || 0;
    this.plateLift = 0;
    /** Pixels the scene's de-collision pass has pushed this plate up by. */
    this.layoutLift = 0;
    /** False whenever anything that `place()` reads has changed. */
    this.settled = false;
    this.selectPayload = init.select || null;
    this.queue = [];
    this.moving = false;
    this.walking = false;
    this.target = null;
    this.servedTarget = null;
    this.pathPending = false;
    this.retried = false;
    this.retryTimer = null;
    this.dead = false;

    // Added first so it sits under the feet: a citizen with no contact shadow
    // reads as floating over the tile rather than standing on it.
    this.shade = scene.add.image(this.offsetX, 0, 'contact').setOrigin(0.5, 0.5);
    this.shade.setTint(ctx.inkColor);
    this.shade.setAlpha(0.18);
    this.add(this.shade);

    this.art = scene.add.sprite(this.offsetX, 0, this.atlasFor(this.pose), this.frameFor(this.pose));
    this.art.setOrigin(0.5, 1);
    this.art.setScale(ctx.actorScale);
    this.add(this.art);

    // Four fifths of the body's width, a third as tall, like every other shadow.
    const shadeW = this.art.displayWidth * 0.8;
    this.shade.setDisplaySize(shadeW, shadeW / 3);

    scene.add.existing(this);
    this.setDepth(at.y + 1);

    if (this.selectPayload) {
      this.art.setInteractive({ useHandCursor: true });
      this.art.on('pointerdown', () => ctx.onPick(this.selectPayload));
      // Pointing at a resting citizen is how you ask it who it is.
      this.art.on('pointerover', () => { this.hovered = true; this.refreshPlate(); });
      this.art.on('pointerout', () => { this.hovered = false; this.refreshPlate(); });
    }

    this.hovered = false;
    this.ownerSelected = Boolean(init.selected);
    this.agentState = init.state || 'running';
    this.plateShown = true;
    this.plate = init.silent ? null : ctx.labels.make(init.lines || [''], { size: 11, subSize: 9 });
    if (this.plate) this.plate.setAccent(ctx.familyColor(this.family));
    this.refreshPlate();
    this.bubble = null;
    this.bubbleUntil = 0;

    // DESIGN.md keeps the spawn grow under reduced motion: it marks a state
    // change rather than being ambient movement, and it is how you notice a new
    // agent at all.
    // Quad, not Back: an overshoot past 1.0 draws a pixel sprite at a
    // fractional scale taller than its own art, which is the one thing
    // "integer-scaled" rules out.
    this.art.setScale(ctx.actorScale, 0.05);
    scene.tweens.add({ targets: this.art, scaleY: ctx.actorScale, duration: 200, ease: 'Quad.easeOut' });
    this.place();
  }

  atlasFor(pose) {
    if (this.kind === 'guard') return 'character_extra';
    return POSE_ATLAS[pose] || 'character';
  }

  /** Model-family art when the sheet has it, the untinted pose when it does not. */
  frameFor(pose) {
    if (this.kind === 'guard') return WALK.includes(pose) ? 'guard_run' : 'guard_idle';
    const atlas = this.atlasFor(pose);
    const tinted = `${pose}_${this.family}`;
    const tex = this.scene.textures.get(atlas);
    return tex && tex.has(tinted) ? tinted : pose;
  }

  setPose(pose) {
    if (pose === this.shownPose) return;
    this.shownPose = pose;
    this.art.setTexture(this.atlasFor(pose), this.frameFor(pose));
  }

  /** Name plate lines and the family colour on the headline. */
  setLines(lines, family) {
    if (family && family !== this.family) {
      this.family = family;
      this.shownPose = null;
      this.setPose(this.pose);
      if (this.plate) this.plate.setAccent(this.ctx.familyColor(family));
    }
    if (this.plate) this.plate.setLines(lines);
  }

  /** A short shout above the head, held for `ms`. */
  say(text, ms = 2600) {
    if (!text) return;
    if (!this.bubble) this.bubble = this.ctx.labels.make([text], { size: 14, subSize: 12, pad: 4, tail: true });
    else { this.bubble.setLines([text]); this.bubble.setVisible(true); }
    this.bubbleUntil = this.scene.time.now + ms;
    this.settled = false;
  }

  /**
   * Walk to a tile and hold `pose` on arrival. Calling it again mid-walk is
   * fine: the citizen finishes the tile it is crossing, then re-paths from
   * there rather than sliding off the grid.
   */
  goTo(tile, pose) {
    this.restPose = pose || 'idle_side';
    if (this.target && this.target.tx === tile.tx && this.target.ty === tile.ty) return;
    this.target = { tx: tile.tx, ty: tile.ty };
    this.retried = false;
    if (!this.moving) this.requestPath();
  }

  requestPath() {
    if (this.dead || this.pathPending || !this.target) return;
    if (this.target.tx === this.tile.tx && this.target.ty === this.tile.ty) { this.arrive(); return; }
    this.pathPending = true;
    const want = this.target;
    this.ctx.findPath(this.tile, want, (path) => {
      this.pathPending = false;
      if (this.dead) return;
      if (!path || path.length < 2) {
        // Nowhere to walk: a door blocked by another actor's lot, or a grid
        // that changed under us. Try once more before settling, because
        // arriving here strikes the destination's work pose on the wrong tile.
        if (!this.retried) {
          this.retried = true;
          this.retryTimer = this.scene.time.delayedCall(RETRY_MS, () => {
            this.retryTimer = null;
            if (!this.dead) this.requestPath();
          });
          return;
        }
        this.arrive();
        return;
      }
      this.retried = false;
      this.servedTarget = want;
      this.queue = path.slice(1);
      if (!this.moving) this.stepNext();
    });
  }

  stepNext() {
    if (this.dead) return;
    if (!this.queue.length) { this.moving = false; this.walking = false; this.arrive(); return; }
    const next = this.queue.shift();
    const dtx = next.x - this.tile.tx;
    const dty = next.y - this.tile.ty;
    this.art.setFlipX(dtx < 0 || dty > 0);
    this.tile = { tx: next.x, ty: next.y };
    const to = this.ctx.toWorld(this.tile.tx, this.tile.ty);
    this.moving = true;
    this.walking = true;
    // DESIGN.md under reduced motion: teleport rather than walk. A
    // zero-duration tween is not the same thing — it still waits a frame for
    // its onComplete, so a forty-tile path crawled one tile per frame instead
    // of arriving at once.
    if (this.ctx.reduced) {
      this.setPosition(to.x, to.y);
      this.settled = false;
      this.walking = false;
      this.stepNext();
      return;
    }
    this.stepTween = this.scene.tweens.add({
      targets: this,
      x: to.x,
      y: to.y,
      duration: this.ctx.stepMs,
      ease: 'Linear',
      onComplete: () => {
        this.stepTween = null;
        if (this.dead) return;
        // A new destination arrived while we were crossing this tile.
        if (this.target && this.servedTarget
          && (this.target.tx !== this.servedTarget.tx || this.target.ty !== this.servedTarget.ty)) {
          this.queue = [];
          this.moving = false;
          this.requestPath();
          return;
        }
        this.stepNext();
      },
    });
  }

  arrive() {
    this.moving = false;
    this.walking = false;
    this.setPose(this.restPose);
    if (this.onArrive) this.onArrive();
  }

  /** Walk-cycle frames, the working bob, and keeping the plates overhead. */
  tick(now) {
    if (this.dead) return;
    if (this.walking) {
      this.setPose(WALK[Math.floor(now / (1000 / WALK_FPS)) % WALK.length]);
      this.art.y = 0;
    } else {
      this.setPose(this.restPose);
      const busy = this.restPose.startsWith('work') || this.restPose === 'chop';
      this.art.y = this.ctx.reduced || !busy ? 0 : (Math.floor(now / 160) % 2 ? -1 : 0);
    }
    if (this.bubble && now > this.bubbleUntil) this.bubble.setVisible(false);
    this.place();
  }

  /**
   * Take a place on a shared doorstep.
   *
   * The scene works out who stands where only once every citizen has been
   * planned, so the body, its shadow and its plate all move here rather than at
   * construction. Without this the offset reached the plate and never the
   * sprite, and two agents at one door stood exactly on top of each other.
   */
  /** What the agent is doing, which decides whether its plate is drawn. */
  setAgentState(state) {
    if (state === this.agentState) return;
    this.agentState = state;
    this.refreshPlate();
  }

  /**
   * This plate's box for the scene's de-collision pass, in world pixels at the
   * label's current scale, hanging from its bottom edge.
   *
   * The priority is what decides who keeps the head position when two plates
   * want the same air: whoever the pointer is on, then whoever is working.
   */
  plateBox(key) {
    if (!this.plate) return null;
    const s = this.ctx.labels.scale;
    return {
      key,
      x: Math.round(this.x + this.offsetX),
      y: Math.round(this.headY()),
      w: (this.plate.plateW || 0) * s,
      h: (this.plate.plateH || 0) * s,
      priority: this.hovered
        ? PLATE_PRIORITY.hovered
        : (this.agentState === 'running' ? PLATE_PRIORITY.running : PLATE_PRIORITY.asked),
    };
  }

  /** What the de-collision pass decided: how far up, and whether at all. */
  applyPlateLayout(lift, visible) {
    const next = Number(lift) || 0;
    if (next !== this.layoutLift) { this.layoutLift = next; this.settled = false; }
    const show = this.plateShown && visible !== false;
    if (this.plate && this.plate.visible !== show) { this.plate.setVisible(show); this.settled = false; }
  }

  /** True while the panel is showing this citizen's session. */
  setOwnerSelected(on) {
    const next = Boolean(on);
    if (next === this.ownerSelected) return;
    this.ownerSelected = next;
    this.refreshPlate();
  }

  /** The world y a plate hangs from: just above the head, under any lift. */
  headY() {
    const s = this.ctx.labels.scale;
    return this.y - this.art.displayHeight - 4 - this.plateLift * s;
  }

  /**
   * Show the plate if anyone is asking for it.
   *
   * The body and its shadow stay either way, so the park still looks populated
   * when nobody is pointing at it.
   */
  refreshPlate() {
    if (this.dead || !this.plate) return;
    this.plateShown = plateVisible({ state: this.agentState, hovered: this.hovered, selected: this.ownerSelected });
    // The de-collision pass may still take it away again this frame; asking is
    // not the same as getting the air above the head.
    this.plate.setVisible(this.plateShown);
    this.settled = false;
  }

  setSlot(offsetX, lift) {
    this.offsetX = offsetX || 0;
    this.plateLift = lift || 0;
    this.art.x = this.offsetX;
    this.shade.x = this.offsetX;
    this.settled = false;
    this.place();
  }

  /**
   * Plates hang above the head. `plateLift` is in screen pixels, converted here,
   * so citizens sharing a doorstep stack their plates instead of covering each
   * other whatever the camera zoom is.
   */
  place() {
    const s = this.ctx.labels.scale;
    const overhead = Boolean((this.plate && this.plate.visible) || (this.bubble && this.bubble.visible));
    // A citizen standing still with nothing over its head has nothing to
    // recompute. The park holds well over a hundred of them, and re-seating
    // every one of those every frame is the whole render budget spent on
    // objects that did not move.
    if (this.settled && !this.moving && !overhead) return;
    // Sorting follows the body every frame, not just at the end of a tile.
    // Refreshed only on arrival, a walker kept the previous tile's order for
    // the whole 500 ms crossing and cut through a wall it should pass in front of.
    this.setDepth(this.y + 1);
    const head = this.headY() - this.layoutLift;
    if (this.plate) {
      this.plate.setPosition(Math.round(this.x + this.offsetX), Math.round(head));
      this.plate.setDepth(500000 + this.y);
    }
    if (this.bubble && this.bubble.visible) {
      const lift = this.plate && this.plate.visible ? this.plate.plateH * s + 3 : 0;
      this.bubble.setPosition(Math.round(this.x + this.offsetX), Math.round(head - lift));
      this.bubble.setDepth(500001 + this.y);
    }
    this.settled = !this.moving;
  }

  /** Shrink away, then destroy. `done` runs either way. */
  vanish(done) {
    if (this.dead) return;
    if (this.plate) this.plate.setVisible(false);
    if (this.bubble) this.bubble.setVisible(false);
    if (this.ctx.reduced) { this.destroy(); if (done) done(); return; }
    // DESIGN.md: "Despawn: shrinks over 4 frames" — 133 ms at the 30 fps cap.
    // A fade would render the 1 px ink outline semi-transparent, which is the
    // soft edge the brief bans; a shrink reads as the agent leaving.
    this.scene.tweens.add({
      targets: this.art,
      scaleY: 0,
      duration: 133,
      ease: 'Quad.easeIn',
      onComplete: () => { this.destroy(); if (done) done(); },
    });
  }

  destroy(fromScene) {
    if (this.dead) return;
    this.dead = true;
    if (this.stepTween) this.stepTween.remove();
    // A pending path retry outlives the citizen otherwise, and fires against a
    // destroyed sprite when the scene is torn down mid-wait.
    if (this.retryTimer) this.retryTimer.remove();
    this.retryTimer = null;
    if (this.plate) this.plate.destroy();
    if (this.bubble) this.bubble.destroy();
    this.plate = null;
    this.bubble = null;
    super.destroy(fromScene);
  }
}
