// The touch gestures, fed to the real Input as pointer events on a 800x400 screen.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Input } from '../src/core/input';
import { bindGameInputLayout, fitGameArea } from '../src/core/input-layout';
import { VIEW_H, VIEW_W, fitArea } from '../src/core/neon';
import type { Game } from '../src/game/game';

const LEFT = { x: 100, y: 200 }, RIGHT = { x: 600, y: 200 };

function touchScreen(width = 800, height = 400, top = 0) {
  const el = Object.assign(new EventTarget(), {
    getBoundingClientRect: () => ({ left: 0, top, width, height }),
    setPointerCapture() {},
  }) as unknown as HTMLElement;
  const send = (type: string, id: number, x: number, y: number) =>
    el.dispatchEvent(Object.assign(new Event(type), { pointerId: id, pointerType: 'touch', clientX: x, clientY: y }));
  return { input: new Input(el), send, el };
}

beforeEach(() => { vi.stubGlobal('window', Object.assign(new EventTarget(), { innerWidth: 800, innerHeight: 400 })); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('the left thumb moves him', () => {
  it('walks sideways, without going up or down', () => {
    const { input, send } = touchScreen();
    send('pointerdown', 1, LEFT.x, LEFT.y);
    send('pointermove', 1, LEFT.x + 30, LEFT.y + 10);
    input.poll();
    expect(input.right).toBe(true);
    expect(input.left).toBe(false);
    expect(input.upPressed || input.downPressed || input.up || input.down).toBe(false);
  });

  it('pushed up floats, once, and keeps steering while held', () => {
    const { input, send } = touchScreen();
    send('pointerdown', 1, LEFT.x, LEFT.y);
    send('pointermove', 1, LEFT.x, LEFT.y - 40);
    input.poll();
    expect(input.upPressed).toBe(true);
    expect(input.up).toBe(true);
    send('pointermove', 1, LEFT.x, LEFT.y - 45);
    input.poll();
    expect(input.upPressed).toBe(false);
    expect(input.up).toBe(true);
    send('pointerup', 1, LEFT.x, LEFT.y - 45);
    input.poll();
    expect(input.up).toBe(false);
  });

  it('pushed down goes through the line, and again after coming back', () => {
    const { input, send } = touchScreen();
    send('pointerdown', 1, LEFT.x, LEFT.y);
    send('pointermove', 1, LEFT.x, LEFT.y + 40);
    input.poll();
    expect(input.downPressed).toBe(true);
    send('pointermove', 1, LEFT.x, LEFT.y);
    send('pointermove', 1, LEFT.x, LEFT.y + 40);
    input.poll();
    expect(input.downPressed).toBe(true);
  });

  it('a walking thumb that drifts does not flip him', () => {
    const { input, send } = touchScreen();
    send('pointerdown', 1, LEFT.x, LEFT.y);
    send('pointermove', 1, LEFT.x + 50, LEFT.y + 20);
    send('pointermove', 1, LEFT.x + 55, LEFT.y + 35);
    input.poll();
    expect(input.right).toBe(true);
    expect(input.downPressed).toBe(false);
  });

  it('after a long walk, the usual push still goes up', () => {
    const { input, send } = touchScreen();
    send('pointerdown', 1, LEFT.x, LEFT.y);
    for (let dx = 10; dx <= 120; dx += 10) send('pointermove', 1, LEFT.x + dx, LEFT.y);
    input.poll();
    expect(input.right).toBe(true);
    send('pointermove', 1, LEFT.x + 120, LEFT.y - 40);
    input.poll();
    expect(input.upPressed).toBe(true);
  });

  it('a thumb pushed far up comes back down the usual way', () => {
    const { input, send } = touchScreen();
    send('pointerdown', 1, LEFT.x, LEFT.y);
    for (let dy = 10; dy <= 120; dy += 10) send('pointermove', 1, LEFT.x, LEFT.y - dy);
    input.poll();
    expect(input.upPressed).toBe(true);
    // Back by the length of one push past where it started from, not the whole way.
    send('pointermove', 1, LEFT.x, LEFT.y - 120 + 75);
    input.poll();
    expect(input.downPressed).toBe(true);
  });

  it('a flick that lifts before any move still counts', () => {
    const { input, send } = touchScreen();
    send('pointerdown', 1, LEFT.x, LEFT.y);
    send('pointerup', 1, LEFT.x, LEFT.y + 40);
    input.poll();
    expect(input.downPressed).toBe(true);
    expect(input.down).toBe(false);
  });
});

describe('the right thumb attacks', () => {
  it('sideways is a pull, either way', () => {
    for (const d of [-1, 1]) {
      const { input, send } = touchScreen();
      send('pointerdown', 2, RIGHT.x, RIGHT.y);
      send('pointermove', 2, RIGHT.x + d * 30, RIGHT.y + 5);
      input.poll();
      expect(input.pullPressed).toBe(true);
      expect(input.dragPressed).toBe(false);
    }
  });

  it('up or down is a wipe, and never moves him', () => {
    for (const d of [-1, 1]) {
      const { input, send } = touchScreen();
      send('pointerdown', 2, RIGHT.x, RIGHT.y);
      send('pointermove', 2, RIGHT.x + 5, RIGHT.y + d * 30);
      input.poll();
      expect(input.dragPressed).toBe(true);
      expect(input.pullPressed).toBe(false);
      expect(input.upPressed || input.downPressed || input.up || input.down).toBe(false);
    }
  });

  it('a tap is not an attack', () => {
    const { input, send } = touchScreen();
    send('pointerdown', 2, RIGHT.x, RIGHT.y);
    send('pointerup', 2, RIGHT.x + 1, RIGHT.y);
    input.poll();
    expect(input.anyPressed).toBe(true);
    expect(input.dragPressed || input.pullPressed).toBe(false);
  });

  it('a swipe attacks only once', () => {
    const { input, send } = touchScreen();
    send('pointerdown', 2, RIGHT.x, RIGHT.y);
    send('pointermove', 2, RIGHT.x + 30, RIGHT.y);
    input.poll();
    send('pointermove', 2, RIGHT.x - 30, RIGHT.y);
    input.poll();
    expect(input.pullPressed).toBe(false);
  });

  it('a flick that lifts before any move still counts', () => {
    const { input, send } = touchScreen();
    send('pointerdown', 2, RIGHT.x, RIGHT.y);
    send('pointerup', 2, RIGHT.x, RIGHT.y - 40);
    input.poll();
    expect(input.dragPressed).toBe(true);
  });

  it('both thumbs work at once', () => {
    const { input, send } = touchScreen();
    send('pointerdown', 1, LEFT.x, LEFT.y);
    send('pointermove', 1, LEFT.x + 30, LEFT.y);
    send('pointerdown', 2, RIGHT.x, RIGHT.y);
    send('pointermove', 2, RIGHT.x + 30, RIGHT.y);
    input.poll();
    expect(input.right).toBe(true);
    expect(input.pullPressed).toBe(true);
  });
});

describe('on-screen buttons', () => {
  it('run when the finger lifts, and take the touch for themselves', () => {
    const { input, send } = touchScreen();
    const run = vi.fn();
    input.uiTap = () => run;
    send('pointerdown', 3, RIGHT.x, RIGHT.y);
    expect(run).not.toHaveBeenCalled();
    send('pointerup', 3, RIGHT.x, RIGHT.y);
    expect(run).toHaveBeenCalledOnce();
    input.poll();
    expect(input.anyPressed).toBe(false);
  });
});

describe('in menus', () => {
  it('a finger that lifts where it landed is a tap, and one that travels is not', () => {
    const { input, send } = touchScreen();
    send('pointerdown', 1, RIGHT.x, RIGHT.y);
    send('pointerup', 1, RIGHT.x + 1, RIGHT.y);
    input.poll();
    expect(input.tap).toEqual([RIGHT.x + 1, RIGHT.y]);
    input.poll();
    expect(input.tap).toBeNull();
    send('pointerdown', 2, LEFT.x, LEFT.y);
    send('pointerup', 2, LEFT.x, LEFT.y + 60);
    input.poll();
    expect(input.tap).toBeNull();
    expect(input.swipeV).toBe(1);
  });

  it('keys go where the bindings say, and the next one can be captured instead', () => {
    const { input } = touchScreen();
    const press = (code: string) => window.dispatchEvent(Object.assign(new Event('keydown'), { code, repeat: false }));
    press('KeyZ');
    input.poll();
    expect(input.dragPressed).toBe(true);
    expect(input.confirm).toBe(true);
    const got: unknown[] = [];
    input.capture = (e) => got.push(e);
    press('KeyZ');
    input.poll();
    expect(got).toEqual([{ key: 'KeyZ' }]);
    expect(input.dragPressed).toBe(false);
  });

  it('a joypad presses and holds like the keys, once per press', () => {
    const { input } = touchScreen();
    const buttons = Array.from({ length: 16 }, () => ({ pressed: false }));
    const pad = { connected: true, buttons, axes: [0, 0] };
    vi.stubGlobal('navigator', { getGamepads: () => [null, pad] });
    buttons[0].pressed = true;
    input.poll();
    expect(input.padFound).toBe(true);
    expect(input.dragPressed && input.confirm && input.anyPressed).toBe(true);
    input.poll();
    expect(input.dragPressed).toBe(false);
    pad.axes[1] = -1;
    pad.axes[0] = 1;
    input.poll();
    expect(input.upPressed && input.up && input.right && input.menuUp).toBe(true);
    input.poll();
    expect(input.upPressed).toBe(false);
    expect(input.up).toBe(true);
    buttons[9].pressed = true;
    input.poll();
    expect(input.pausePressed).toBe(true);
  });
});

describe('the play area', () => {
  const RATIO = VIEW_W / VIEW_H;

  it('has the same shape on every screen, and shows the same world', () => {
    for (const [W, H] of [[1920, 1080], [844, 390], [1024, 768], [390, 844], [2560, 1080], [320, 200]]) {
      const a = fitArea(W, H);
      expect(a.w / a.h).toBeCloseTo(RATIO, 6);
      expect(a.x).toBeGreaterThanOrEqual(0);
      expect(a.y).toBeGreaterThanOrEqual(0);
      expect(a.x * 2 + a.w).toBeCloseTo(W, -0.5);
      expect(a.y * 2 + a.h).toBeCloseTo(H, -0.5);
    }
  });

  it('fills a 16:9 screen exactly', () => {
    expect(fitArea(1920, 1080)).toEqual({ w: 1920, h: 1080, x: 0, y: 0 });
  });

  it('reserves the area below the fixed view for portrait play gestures', () => {
    const inset = 45;
    const { input, send } = touchScreen(390, 844, inset);
    const area = fitGameArea(390, 844);
    const cutoff = area.y + area.h + inset;
    expect(area.w / area.h).toBeCloseTo(RATIO);
    expect(area.y + area.h).toBeLessThan(300);
    bindGameInputLayout({ mode: 'play', input, neon: { fullW: 390, fullH: 844, oy: area.y, h: area.h } } as unknown as Game);
    send('pointerdown', 1, 85, cutoff - 1);
    send('pointermove', 1, 115, cutoff - 1);
    input.poll();
    expect(input.controls().right).toBe(false);
    send('pointerdown', 2, 85, cutoff + 1);
    send('pointermove', 2, 115, cutoff + 1);
    input.poll();
    expect(input.controls().right).toBe(true);
    send('pointerdown', 3, 340, cutoff + 1);
    send('pointermove', 3, 340, cutoff + 31);
    input.poll();
    expect(input.controls()).toMatchObject({ right: true, dragPressed: true });
  });
});

describe('input resets', () => {
  it('cancels a touch edge and releases the movement stick', () => {
    const { input, send } = touchScreen();
    send('pointerdown', 1, LEFT.x, LEFT.y);
    send('pointermove', 1, LEFT.x, LEFT.y + 40);
    send('pointercancel', 1, LEFT.x, LEFT.y + 40);
    input.poll();
    expect(input.controls().down).toBe(false);
    expect(input.controls().downPressed).toBe(false);
  });

  it('cancelling one touch keeps a different attack gesture', () => {
    const { input, send } = touchScreen();
    send('pointerdown', 1, RIGHT.x, RIGHT.y);
    send('pointermove', 1, RIGHT.x + 30, RIGHT.y);
    send('pointerdown', 2, RIGHT.x, RIGHT.y);
    send('pointermove', 2, RIGHT.x, RIGHT.y + 30);
    send('pointercancel', 2, RIGHT.x, RIGHT.y + 30);
    input.poll();
    expect(input.controls()).toMatchObject({ dragPressed: false, pullPressed: true });
  });

  it('clears held input on blur and waits for a gamepad to return to neutral', () => {
    const { input, send } = touchScreen();
    const pad = { index: 0, connected: true, buttons: [], axes: [1, 0] };
    vi.stubGlobal('navigator', { getGamepads: () => [pad] });
    send('pointerdown', 1, LEFT.x, LEFT.y);
    send('pointermove', 1, LEFT.x - 30, LEFT.y);
    input.poll();
    expect(input.controls()).toMatchObject({ left: true, right: true });
    window.dispatchEvent(new Event('blur'));
    input.poll();
    expect(input.controls()).toMatchObject({ left: false, right: false });
    window.dispatchEvent(new Event('focus'));
    input.poll();
    expect(input.controls().right).toBe(false);
    pad.axes[0] = 0;
    input.poll();
    pad.axes[0] = 1;
    input.poll();
    expect(input.controls().right).toBe(true);
    pad.connected = false;
    input.poll();
    expect(input.controls().right).toBe(false);
    pad.connected = true;
    pad.axes = [0, -1];
    input.poll();
    expect(input.controls()).toMatchObject({ right: false, up: true, upPressed: true });
    input.poll();
    expect(input.controls().upPressed).toBe(false);
  });

  it('keeps a direction held when one of two bound keys is released', () => {
    const { input } = touchScreen();
    const key = (type: string, code: string) => window.dispatchEvent(Object.assign(new Event(type), { code, repeat: false }));
    key('keydown', 'ArrowRight');
    key('keydown', 'KeyD');
    key('keyup', 'ArrowRight');
    input.poll();
    expect(input.controls().right).toBe(true);
    key('keyup', 'KeyD');
    input.poll();
    expect(input.controls().right).toBe(false);
  });

  it('receives a renderer pointer start and still owns native capture through release', () => {
    const { input, el, send } = touchScreen();
    const run = vi.fn();
    input.setSurface(el, { pointerDown: 'pixi' });
    send('pointerdown', 1, RIGHT.x, RIGHT.y);
    input.poll();
    expect(input.anyPressed).toBe(false);
    input.pointerDown({ pointerId: 1, pointerType: 'touch', clientX: RIGHT.x, clientY: RIGHT.y, preventDefault() {} }, run);
    send('pointerup', 1, RIGHT.x, RIGHT.y);
    expect(run).toHaveBeenCalledOnce();
  });
});
