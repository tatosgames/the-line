// Keyboard and touch input. On touch screens the left part is a floating stick that
// moves Wavell: sideways to walk, towards the line to go through it, away from it to
// float. The right part attacks: swipe sideways to pull, up or down to wipe.
// Walking and moving through the line now share a thumb, so going up or down takes a
// longer push than walking, and has to be mostly vertical. That stops a walking thumb
// that drifts from flipping him by accident. The base keeps close behind the thumb, so
// that push is the same however long he has been walking.
// Presses are latched so a gesture shorter than one frame is never lost.
// A joypad does the same as the keys, and which keys and buttons do what is in `binds`.

import { ACTIONS, defaultBindings, type Action, type Bindings } from './controls';

export interface Controls {
  left: boolean; right: boolean; up: boolean; down: boolean;
  /** dragPressed is the wipe (a crest on his side), pullPressed the pull (a trough on his side). */
  upPressed: boolean; downPressed: boolean; dragPressed: boolean; pullPressed: boolean;
}

interface Stick { id: number; ox: number; oy: number; x: number; y: number }
interface Swipe { id: number; ox: number; oy: number; fired: boolean }

/** A key or a joypad button, when one is being waited for. */
export type Captured = { key: string } | { button: number };

/** Is this someone on a phone or a tablet? */
export const usesTouch = (inp: { touchUsed: boolean }) => inp.touchUsed || matchMedia('(pointer: coarse)').matches;

/** How far a joypad's stick has to go to count. */
const PAD_STICK = 0.5;
/** The standard layout: the buttons that work in menus whatever the bindings are. */
const PAD_CONFIRM = [0, 9], PAD_BACK = 1, PAD_MENU = 8, PAD_UP = 12, PAD_DOWN = 13, PAD_LEFT = 14, PAD_RIGHT = 15;

const DIRECTIONS = ['left', 'right', 'up', 'down'] as const;
type Direction = typeof DIRECTIONS[number];
type Held = Record<Direction, boolean>;
type TouchAction = 'up' | 'down' | 'drag' | 'pull';
const noDirections = (): Held => ({ left: false, right: false, up: false, down: false });

/** The part of the screen, from the left, where a touch becomes the stick. */
const STICK_ZONE = 0.45;
/** How much further than walking the stick must go up or down, as a multiple of the threshold. */
const STICK_VERTICAL = 1.4;
/** How far sideways the thumb can get from the base, as a multiple of the threshold, before the base follows. */
const STICK_FOLLOW_X = 2;
/** The same up and down. More than sideways, or a push could never beat a long walk at being mostly vertical. */
const STICK_FOLLOW_Y = 2.5;
/** How far back it can come before up or down lets go, so steering the bubble doesn't flicker. */
const STICK_RELEASE = 0.6;
/** How far a swipe must travel, as a multiple of the threshold: attacks should feel instant. */
const SWIPE_TRAVEL = 0.8;

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export class Input implements Controls {
  /** Changes when queued gameplay presses must be discarded. */
  resetEpoch = 0;
  left = false; right = false; up = false; down = false;
  upPressed = false; downPressed = false; dragPressed = false; pullPressed = false;
  /** Any key or touch this frame (for menus). */
  anyPressed = false;
  /** Asked to pause, this frame. */
  pausePressed = false;
  /** For menus, this frame: one line up, down, left, right; go ahead; go back. */
  menuUp = false; menuDown = false; menuLeft = false; menuRight = false;
  confirm = false; backPressed = false;
  /** For menus, this frame: a finger or a click that lifted where it landed, on the canvas. */
  tap: [number, number] | null = null;
  /** For menus, this frame: a swipe up (-1) or down (1). */
  swipeV = 0;
  /** Which keys and buttons do what. Call setBindings() after changing it. */
  binds: Bindings = defaultBindings();
  /** Waiting for a key or a button: the next one goes here and nowhere else. */
  capture: ((e: Captured) => void) | null = null;
  /** A joypad has turned up: browsers only report one after a button is pressed on it. */
  padFound = false;
  /** Where the mouse is on the canvas (for hovering over on-screen buttons). */
  mouseX = -1;
  mouseY = -1;
  /** Set once a finger has touched the screen: show the on-screen controls. */
  touchUsed = false;
  /** Positions are in CSS pixels from the canvas's top left corner. */
  stick: Stick | null = null;
  swipe: Swipe | null = null;
  /** For a moment after a wipe (a vertical swipe). */
  dragFlash = 0;
  /** For a moment after a pull (a sideways swipe). */
  pullFlash = 0;
  /** -1 or 1 for a moment after the stick goes up or down. */
  stickFlash = 0;

  private keys = new Set<string>();
  private keyMap = new Map<string, Action>();
  private latch = {
    up: false, down: false, drag: false, pull: false, any: false, pause: false,
    menuUp: false, menuDown: false, menuLeft: false, menuRight: false, confirm: false, back: false,
  };
  private tapAt: [number, number] | null = null;
  private swipeAt = 0;
  private downs = new Map<number, [number, number]>();
  private stickHeld = noDirections();
  private touchPressed = new Map<number, Set<TouchAction>>();
  private padHeld = noDirections();
  private padPrev: boolean[] = [];
  private padIndex: number | undefined;
  private padNeedsNeutral = false;
  private focused = true;
  private surfaceEvents: AbortController | null = null;
  private ui = new Map<number, () => void>();
  readonly onKey = new Map<string, () => void>();
  /**
   * On-screen buttons get first refusal on a touch: this returns what the button does, or null.
   * It runs when the finger lifts: browsers only allow fullscreen, installing and sound
   * from there, not from the moment a finger lands.
   */
  uiTap: ((x: number, y: number) => (() => void) | null) | null = null;
  /** CSS y coordinate where play gestures can start. Menu and HUD taps still use the whole view. */
  gestureTop: (() => number) | null = null;
  /** Every lifted finger or pressed key, the moments a browser lets a page start sound. */
  onGesture: (() => void) | null = null;

  constructor(private el: HTMLElement) {
    this.setBindings(this.binds);
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.onGesture?.();
      if (this.capture) { e.preventDefault(); this.capture({ key: e.code }); return; }
      const own = this.onKey.get(e.code);
      own?.();
      const k = this.keyMap.get(e.code);
      // A key with a job of its own (mute, pause) doesn't count as "press any key".
      if (!own && k !== 'pause') this.latch.any = true;
      // The arrows and Enter always work in menus, so no one can get lost whatever they bind.
      const l = this.latch;
      if (k === 'up' || e.code === 'ArrowUp') l.menuUp = true;
      if (k === 'down' || e.code === 'ArrowDown') l.menuDown = true;
      if (k === 'left' || e.code === 'ArrowLeft') l.menuLeft = true;
      if (k === 'right' || e.code === 'ArrowRight') l.menuRight = true;
      if (k === 'drag' || k === 'pull' || e.code === 'Enter' || e.code === 'NumpadEnter') { l.confirm = true; e.preventDefault(); }
      if (!k) return;
      e.preventDefault();
      if (k === 'pause') { l.pause = true; return; }
      this.keys.add(e.code);
      if (k === 'up' || k === 'down' || k === 'drag' || k === 'pull') l[k] = true;
    });
    window.addEventListener('mousemove', (e) => { [this.mouseX, this.mouseY] = this.pos(e); });
    window.addEventListener('keyup', (e) => { this.keys.delete(e.code); });
    window.addEventListener('blur', () => {
      this.focused = false;
      this.keys.clear();
      this.clearPointers();
      this.padHeld = noDirections();
      this.padPrev = [];
      this.padNeedsNeutral = true;
      this.clearPresses();
    });
    window.addEventListener('focus', () => { this.focused = true; });
    window.addEventListener('resize', () => { this.clearPointers(); });
    this.setSurface(el);
  }

  /** Pixi can start pointers through its event system. Native capture still handles moves and releases. */
  setSurface(el: HTMLElement, { pointerDown = 'native' }: { pointerDown?: 'native' | 'pixi' } = {}) {
    this.surfaceEvents?.abort();
    this.clearPointers();
    this.el = el;
    const controller = new AbortController();
    this.surfaceEvents = controller;
    const options = { signal: controller.signal };
    if (pointerDown === 'native') el.addEventListener('pointerdown', (e) => this.pointerDown(e), options);
    el.addEventListener('pointermove', (e) => {
      const [x, y] = this.pos(e), s = this.stick;
      if (s && s.id === e.pointerId) {
        this.moveStick(x, y);
        return;
      }
      if (this.swipe?.id === e.pointerId) this.readSwipe(x, y);
    }, options);
    const end = (e: PointerEvent) => {
      if (e.type === 'pointerup') this.onGesture?.();
      const down = this.downs.get(e.pointerId);
      this.downs.delete(e.pointerId);
      if (down && e.type !== 'pointerup') {
        this.touchPressed.delete(e.pointerId);
        this.resetEpoch++;
      }
      if (down && e.type === 'pointerup') {
        const [x, y] = this.pos(e), dx = x - down[0], dy = y - down[1], far = Math.hypot(dx, dy) > this.threshold * SWIPE_TRAVEL;
        if (!far) this.tapAt = [x, y];
        else if (Math.abs(dy) > Math.abs(dx)) this.swipeAt = Math.sign(dy);
      }
      const run = this.ui.get(e.pointerId);
      if (run) {
        this.ui.delete(e.pointerId);
        if (e.type === 'pointerup') run();
        return;
      }
      if (this.stick?.id === e.pointerId) {
        // A flick up or down can lift before a move event reports it, as on the right.
        if (e.type === 'pointerup') this.moveStick(...this.pos(e));
        this.stick = null;
        this.readStick();
      }
      if (this.swipe?.id === e.pointerId) {
        // A flick can lift before a move event reports how far it went.
        if (e.type === 'pointerup') this.readSwipe(...this.pos(e));
        this.swipe = null;
      }
    };
    el.addEventListener('pointerup', end, options);
    el.addEventListener('pointercancel', end, options);
    el.addEventListener('lostpointercapture', end, options);
  }

  pointerDown(e: Pick<PointerEvent, 'pointerId' | 'pointerType' | 'clientX' | 'clientY' | 'preventDefault'>, target?: (() => void) | null) {
    e.preventDefault();
    if (e.pointerType !== 'mouse') this.touchUsed = true;
    const [x, y] = this.pos(e);
    const run = target === undefined ? this.uiTap?.(x, y) : target;
    if (!run && this.gestureTop && y < this.gestureTop()) return;
    try { this.el.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    if (run) { this.ui.set(e.pointerId, run); return; }
    this.latch.any = true;
    this.downs.set(e.pointerId, [x, y]);
    if (x < this.el.getBoundingClientRect().width * STICK_ZONE && !this.stick) {
      this.stick = { id: e.pointerId, ox: x, oy: y, x, y };
    } else {
      // The latest finger on the right is the one that counts, so attacks can overlap.
      this.swipe = { id: e.pointerId, ox: x, oy: y, fired: false };
    }
  }

  private clearPointers() {
    this.resetEpoch++;
    for (const id of [...this.downs.keys(), ...this.ui.keys()]) {
      try { this.el.releasePointerCapture(id); } catch { /* no longer captured */ }
    }
    this.downs.clear();
    this.ui.clear();
    this.stick = this.swipe = null;
    this.stickHeld = noDirections();
    this.tapAt = null;
    this.swipeAt = 0;
    this.touchPressed.clear();
  }

  private clearPresses() {
    for (const key of Object.keys(this.latch) as (keyof typeof this.latch)[]) this.latch[key] = false;
  }

  private latchTouch(id: number, action: TouchAction) {
    let presses = this.touchPressed.get(id);
    if (!presses) { presses = new Set(); this.touchPressed.set(id, presses); }
    presses.add(action);
  }

  get threshold() { return Math.min(window.innerWidth, window.innerHeight) * 0.045; }

  /** An event's position on the canvas. */
  private pos(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.el.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  /** One attack per swipe, as soon as it has gone far enough to tell which way. */
  private readSwipe(x: number, y: number) {
    const w = this.swipe;
    if (!w || w.fired) return;
    const dx = x - w.ox, dy = y - w.oy;
    if (Math.hypot(dx, dy) <= this.threshold * SWIPE_TRAVEL) return;
    w.fired = true;
    if (Math.abs(dx) > Math.abs(dy)) { this.latchTouch(w.id, 'pull'); this.pullFlash = 1; }
    else { this.latchTouch(w.id, 'drag'); this.dragFlash = 1; }
  }

  /**
   * The thumb is here. The base follows a thumb that wanders too far, sideways and up or
   * down apart: a long walk then never makes going up or down take a longer push, and a
   * thumb that pushed far up has only the usual way to come back down.
   */
  private moveStick(x: number, y: number) {
    const s = this.stick;
    if (!s) return;
    s.x = x; s.y = y;
    const th = this.threshold, maxX = th * STICK_FOLLOW_X, maxY = th * STICK_FOLLOW_Y;
    s.ox = clamp(s.ox, x - maxX, x + maxX);
    s.oy = clamp(s.oy, y - maxY, y + maxY);
    this.readStick();
  }

  private readStick() {
    const s = this.stick, h = this.stickHeld;
    if (!s) { h.left = h.right = h.up = h.down = false; return; }
    const th = this.threshold, dx = s.x - s.ox, dy = s.y - s.oy;
    h.left = dx < -th; h.right = dx > th;
    const go = th * STICK_VERTICAL, keep = go * STICK_RELEASE;
    const up = h.up ? dy < -keep : dy < -go && -dy > Math.abs(dx);
    const down = h.down ? dy > keep : dy > go && dy > Math.abs(dx);
    if (up && !h.up) { this.latchTouch(s.id, 'up'); this.stickFlash = -1; }
    if (down && !h.down) { this.latchTouch(s.id, 'down'); this.stickFlash = 1; }
    h.up = up; h.down = down;
  }

  /** These keys and buttons from now on. */
  setBindings(b: Bindings) {
    this.binds = b;
    this.keyMap.clear();
    for (const { action } of ACTIONS) for (const code of b.keys[action]) this.keyMap.set(code, action);
    this.keys.clear();
    this.resetEpoch++;
  }

  /** What the joypad has done since the last frame, as if it were keys. */
  private pollPad() {
    if (!this.focused) return;
    let pad: Gamepad | null = null;
    try { pad = [...(navigator.getGamepads?.() ?? [])].find((p) => p?.connected) ?? null; } catch { /* not allowed in this page */ }
    const h = this.padHeld, l = this.latch;
    if (!pad) {
      if (this.padIndex !== undefined) this.resetEpoch++;
      this.padHeld = noDirections();
      this.padPrev = [];
      this.padIndex = undefined;
      this.padNeedsNeutral = false;
      return;
    }
    this.padFound = true;
    const now = pad.buttons.map((b) => b.pressed);
    const x = pad.axes[0] ?? 0, y = pad.axes[1] ?? 0;
    if (this.padNeedsNeutral) {
      this.padNeedsNeutral = now.some(Boolean) || Math.abs(x) > PAD_STICK || Math.abs(y) > PAD_STICK;
      if (this.padNeedsNeutral) return;
    }
    if (pad.index !== this.padIndex) {
      if (this.padIndex !== undefined) this.resetEpoch++;
      Object.assign(h, noDirections());
      this.padPrev = [];
      this.padIndex = pad.index;
    }
    const before = this.padPrev;
    this.padPrev = now;
    const isDown = (a: Action) => this.binds.pad[a].some((b) => now[b]);
    const held = { left: isDown('left') || x < -PAD_STICK, right: isDown('right') || x > PAD_STICK, up: isDown('up') || y < -PAD_STICK, down: isDown('down') || y > PAD_STICK };
    const stick = { left: x < -PAD_STICK, right: x > PAD_STICK, up: y < -PAD_STICK, down: y > PAD_STICK };
    for (let i = 0; i < now.length; i++) {
      if (!now[i] || before[i]) continue;
      this.onGesture?.();
      if (this.capture) { this.capture({ button: i }); continue; }
      l.any = true;
      if (PAD_CONFIRM.includes(i)) l.confirm = true;
      if (i === PAD_BACK) l.back = true;
      if (i === PAD_MENU) this.onKey.get('Escape')?.();
      if (i === PAD_UP) l.menuUp = true;
      if (i === PAD_DOWN) l.menuDown = true;
      if (i === PAD_LEFT) l.menuLeft = true;
      if (i === PAD_RIGHT) l.menuRight = true;
      for (const { action } of ACTIONS) {
        if (!this.binds.pad[action].includes(i)) continue;
        if (action === 'pause') l.pause = true;
        if (action === 'drag' || action === 'pull') { l[action] = true; l.confirm = true; }
      }
    }
    // Up and down on the stick or on buttons bound to them: each push once, for the moves that take a press.
    if (held.up && !h.up) { l.up = true; if (!this.capture) l.menuUp = true; }
    if (held.down && !h.down) { l.down = true; if (!this.capture) l.menuDown = true; }
    if (stick.left && !h.left && !this.capture) l.menuLeft = true;
    if (stick.right && !h.right && !this.capture) l.menuRight = true;
    Object.assign(h, held);
  }

  /** Call once per frame before reading the controls. */
  poll() {
    this.pollPad();
    const s = this.stickHeld, p = this.padHeld, l = this.latch;
    for (const action of DIRECTIONS) {
      this[action] = s[action] || p[action] || this.binds.keys[action].some((code) => this.keys.has(code));
    }
    for (const presses of this.touchPressed.values()) {
      for (const action of presses) l[action] = true;
    }
    this.touchPressed.clear();
    this.upPressed = l.up;
    this.downPressed = l.down;
    this.dragPressed = l.drag;
    this.pullPressed = l.pull;
    this.anyPressed = l.any;
    this.pausePressed = l.pause;
    this.menuUp = l.menuUp;
    this.menuDown = l.menuDown;
    this.menuLeft = l.menuLeft;
    this.menuRight = l.menuRight;
    this.confirm = l.confirm;
    this.backPressed = l.back;
    this.tap = this.tapAt;
    this.swipeV = this.swipeAt;
    this.tapAt = null;
    this.swipeAt = 0;
    this.clearPresses();
  }

  /** Read the merged gameplay actions without copying UI state or event handlers. */
  controls(): Controls {
    return {
      left: this.left, right: this.right, up: this.up, down: this.down,
      upPressed: this.upPressed, downPressed: this.downPressed,
      dragPressed: this.dragPressed, pullPressed: this.pullPressed,
    };
  }
}
