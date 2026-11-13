// Everything drawn over the world in screen space: score, lives, the lead gauge,
// title and game over screens, the on-screen buttons and the touch controls.

import { RenderPath } from '../core/renderPath';
import { canInstall } from '../core/app';
import { keyLabel } from '../core/controls';
import { COLORS, Neon, clamp } from '../core/neon';
import { DIFF } from '../data/difficulty';
import type { Game } from './game';
import { MORPH_TIME, drawFlatlined, drawMorph, drawTitle } from './title';

/** The HUD's base size: a share of the play area, so it lays out the same on every screen. */
export const hudSize = (n: Neon) => n.h * 0.045;

const BUTTON_Y = 1.1, SCORE_RIGHT = 2.9;

/** Nostalgia mode's pictures of the HUD, drawn pixel by pixel. */
const RETRO = {
  settings: ['.#.#.#.', '#######', '.#.#.#.', '.#.#.#.', '.#.#.#.', '#######', '.#.#.#.'],
  ring: ['..#####..', '.#.....#.', '#.......#', '#.......#', '#.......#', '#.......#', '#.......#', '.#.....#.', '..#####..'],
  face: ['..#####..', '.#.....#.', '#.#...#.#', '#..#.#..#', '#.......#', '#.......#', '#.......#', '.#.....#.', '..#####..'],
} as const;

/** One of those pictures, centred on a point given in the coordinates screen() draws in. */
export function retroSprite(n: Neon, rows: readonly string[], x: number, y: number, color: string, alpha = 1) {
  const [px, py] = n.toPixel(x, y);
  n.sprite(rows, px - (rows[0].length >> 1), py - (rows.length >> 1), color, alpha);
}

/** Part of the ring of a size being earned: its pixels round from the top, up to this share of the way. */
const ringPart = (share: number) => RETRO.ring.map((row, r) => [...row].map((ch, i) => {
  const turn = Math.atan2(i - 4, 4 - r) / (Math.PI * 2);
  return ch === '#' && (turn < 0 ? turn + 1 : turn) <= share ? '#' : '.';
}).join(''));

/** The hints the start screen takes turns showing. */
export const TITLE_HINTS = [
  'THE LINE IS CONSUMING: RUN FOR YOUR LIFE',
  'USE PULL OR WIPE',
  'OPPOSITE WAVES CANCEL EACH OTHER',
  'SAME-SIDE WAVES SUM UP AND DEFLECT',
  'SPARKLES GROW IN YOU',
  'BUBBLE IS FAST BUT NOT SAFE',
  'THE END OF THE LINE GETS CLOSER AND CLOSER',
  'BIGGER SIZE MEANS FASTER WALK',
  'RUN!',
];
/** Seconds each hint stays, and how long it takes to fade in and out. */
const HINT_TIME = 5, HINT_FADE = 0.3;

/** The start screen's box of links for developers, down to the left. */
const DEV_LINKS = [
  { label: 'settings', url: 'difficulty.html' },
  { label: 'editor', url: 'lab.html' },
];

/** The dev menu's box on screen, and the height of its heading and of each link. */
function devBox(n: Neon) {
  const s = hudSize(n), row = s, w = s * 5, h = row * (DEV_LINKS.length + 1) + s * 0.3, pad = s * 0.8;
  return { s, row, x: pad, y: n.h - pad - h, w, h };
}

/** Is this point in the dev menu's box? */
export function inDevMenu(n: Neon, x: number, y: number) {
  const b = devBox(n);
  return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
}

/** The page of the dev menu's link at this point, if any. */
export function devLinkAt(n: Neon, x: number, y: number): string | null {
  if (!inDevMenu(n, x, y)) return null;
  const b = devBox(n);
  return DEV_LINKS[Math.floor((y - b.y - b.row * 1.15) / b.row)]?.url ?? null;
}

function drawDevMenu(g: Game) {
  const n = g.neon, b = devBox(n), tx = b.x + b.s * 0.45;
  n.screen();
  const box = new RenderPath();
  box.rect(b.x, b.y, b.w, b.h);
  if (n.retro) n.pixelFrame(b.x, b.y, b.w, b.h, '#c9a640', 0.6);
  else n.glow(box, '#c9a640', 1, 0.35);
  n.text('DEV', tx, b.y + b.row * 0.65, b.s * 0.42, '#c9a640', 'left', 0.75);
  const hover = devLinkAt(n, g.input.mouseX - n.ox, g.input.mouseY - n.oy);
  DEV_LINKS.forEach((l, i) => n.text(l.label, tx, b.y + b.row * (1.65 + i), b.s * 0.5, hover === l.url ? COLORS.hud : '#c9a640', 'left', hover === l.url ? 1 : 0.8));
  n.cursor(hover ? 'pointer' : '');
}

/** Top-right settings button, with a larger hit target than its icon. */
export function settingsButton(n: Neon): [number, number, number] {
  const s = hudSize(n), radius = Math.max(22, s * 0.9);
  return [n.w - Math.max(radius, s * 1.4), Math.max(radius, BUTTON_Y * s), radius];
}

function drawSettings(n: Neon) {
  const [x, y] = settingsButton(n), s = hudSize(n);
  if (n.retro) { retroSprite(n, RETRO.settings, x, y, '#c9a640', 0.9); return; }
  const path = new RenderPath();
  for (const [dx, notch] of [[-0.33, -0.18], [0, 0.18], [0.33, -0.03]]) {
    const px = x + s * dx, py = y + s * notch;
    path.moveTo(px, y - s * 0.42); path.lineTo(px, y + s * 0.42);
    path.moveTo(px - s * 0.11, py); path.lineTo(px + s * 0.11, py);
  }
  n.glow(path, '#c9a640', 1.4, 0.85);
}

/** Which build this is, small, down in the right corner of the start screen. */
export const VERSION_TEXT = `v${__VERSION__} · ${__BUILD_DATE__}${import.meta.env.DEV ? ' dev' : ''}`;

function drawVersion(n: Neon) {
  const s = hudSize(n);
  n.text(VERSION_TEXT, n.w - s * 0.8, n.h - s * 0.45, s * 0.4, '#c9a640', 'right', 0.6);
}

/** The install button's box on screen, down to the right of the start screen. */
function installBox(n: Neon) {
  const s = hudSize(n), w = s * 5.6, h = s * 1.3, pad = s * 0.8;
  // It sits up a little, to leave the version room under it.
  return { s, x: n.w - pad - w, y: n.h - s * 1.3 - h, w, h };
}

export function inInstallButton(n: Neon, x: number, y: number) {
  const b = installBox(n);
  return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
}

function drawInstall(g: Game) {
  const n = g.neon, b = installBox(n);
  const hover = inInstallButton(n, g.input.mouseX - n.ox, g.input.mouseY - n.oy);
  const box = new RenderPath();
  box.rect(b.x, b.y, b.w, b.h);
  if (n.retro) n.pixelFrame(b.x, b.y, b.w, b.h, '#c9a640', hover ? 1 : 0.6);
  else n.glow(box, '#c9a640', 1, hover ? 0.7 : 0.35);
  n.screen();
  n.text('install app', b.x + b.w / 2, b.y + b.h / 2, b.s * 0.5, hover ? COLORS.hud : '#c9a640', 'center', hover ? 1 : 0.8);
  if (hover) n.cursor('pointer');
  if (g.time < g.installNote) n.text('Share menu, then Add to Home Screen', b.x + b.w, b.y - b.s * 0.6, b.s * 0.5, COLORS.hud, 'right');
}

/** A chevron at (x, y), pointing the way (dx, dy) says. */
export function chevron(n: Neon, x: number, y: number, dx: number, dy: number, size: number, color: string, alpha: number) {
  const p = new RenderPath();
  p.moveTo(x - dx * size * 0.5 - dy * size, y - dy * size * 0.5 - dx * size);
  p.lineTo(x + dx * size * 0.5, y + dy * size * 0.5);
  p.lineTo(x - dx * size * 0.5 + dy * size, y - dy * size * 0.5 + dx * size);
  n.glow(p, color, 1.5, alpha);
}

/** The thumbs' controls. They may use the empty space around the play area. */
function drawTouch(g: Game) {
  const n = g.neon, inp = g.input;
  n.overlay();
  const r = Math.min(n.fullW, n.fullH) * 0.11, gap = r * 1.2, size = r * 0.26;
  const portraitTop = inp.gestureTop?.() ?? 0;
  const leftY = portraitTop ? Math.max(portraitTop + r * 1.6, n.fullH - r * 2) : n.fullH - r * 1.6;
  const rightY = portraitTop ? leftY : n.fullH - r * 1.7;
  // Left thumb: a stick that walks, floats and goes through the line.
  const st = inp.stick;
  const ox = st ? st.ox : r * 1.6, oy = st ? st.oy : leftY;
  const base = new RenderPath();
  base.arc(ox, oy, r, 0, Math.PI * 2);
  n.glow(base, '#c9a640', 1.5, st ? 0.6 : 0.3);
  const kx = st ? clamp(st.x - ox, -r, r) + ox : ox, ky = st ? clamp(st.y - oy, -r, r) + oy : oy;
  const knob = new RenderPath();
  knob.arc(kx, ky, r * 0.38, 0, Math.PI * 2);
  n.glow(knob, COLORS.hud, 1.5, st ? 0.9 : 0.35);
  for (const d of [-1, 1]) chevron(n, ox, oy + d * gap, 0, d, size, '#c9a640', 0.3 + (Math.sign(inp.stickFlash) === d ? Math.abs(inp.stickFlash) * 0.7 : 0));
  inp.stickFlash *= 0.9;
  // Right thumb: the swipes. They follow the thumb.
  const sw = inp.swipe;
  const ax = sw ? sw.ox : n.fullW - r * 1.8, ay = sw ? sw.oy : rightY;
  const dot = new RenderPath();
  dot.arc(ax, ay, r * 0.3, 0, Math.PI * 2);
  n.glow(dot, COLORS.hud, 1.5, sw ? 0.7 : 0.3);
  for (const d of [-1, 1]) {
    chevron(n, ax, ay + d * gap, 0, d, size, COLORS.hud, 0.3 + inp.dragFlash * 0.7);
    chevron(n, ax + d * gap, ay, d, 0, size, '#9fe8ff', 0.3 + inp.pullFlash * 0.7);
  }
  inp.dragFlash *= 0.9;
  inp.pullFlash *= 0.9;
}

/** The edge of the play area, and on a phone held upright, a word about turning it. */
function drawSurround(g: Game) {
  const n = g.neon;
  n.overlay();
  if ((n.ox > 0 || n.oy > 0) && n.retro) n.pixelFrame(0, 0, n.w, n.h, '#5a4a20', 0.8);
  else if (n.ox > 0 || n.oy > 0) {
    const p = new RenderPath();
    p.rect(n.ox, n.oy, n.w, n.h);
    n.glow(p, '#5a4a20', 0.8, 0.5);
  }
  if (n.fullH > n.fullW && !g.input.gestureTop) n.text('turn the phone for a bigger view', n.w / 2, -n.oy / 2, Math.max(13, n.unit * 8), '#c9a640', 'center', 0.8);
}

/** The beats of the bar, as dots ending at x, with the current one lit. */
/** How much line is left behind Wavell before the break: the time you have. */
function drawLead(g: Game, x: number, y: number, s: number) {
  const n = g.neon, W = g.wavell;
  const lead = clamp((W.x - g.endX) / DIFF.endLead, 0, 1);
  const w = s * 6.5;
  const color = lead > 0.5 ? COLORS.hud : lead > 0.25 ? COLORS.danger : '#ff3b30';
  if (n.retro) {
    const [x0, py] = n.toPixel(x, y), [x1] = n.toPixel(x + w, y), lit = Math.round(x1 - (x1 - x0) * lead);
    const empty = new RenderPath(), full = new RenderPath(), frayed = new RenderPath();
    empty.rect(x0, py, x1 - x0, 1);
    full.rect(lit, py - 1, Math.max(1, x1 - lit), 3);
    // A little frayed end at the left of the bar.
    frayed.rect(lit - 2, py - 1, 1, 1);
    frayed.rect(lit - 4, py + 1, 1, 1);
    n.fillPixels(empty, '#79653d', 0.9);
    n.fillPixels(full, color);
    n.fillPixels(frayed, color, 0.8);
    return;
  }
  const back = new RenderPath();
  back.moveTo(x, y); back.lineTo(x + w, y);
  n.glow(back, '#79653d', 1.4, 0.75);
  const bar = new RenderPath();
  bar.moveTo(x + w - Math.max(1, w * lead), y); bar.lineTo(x + w, y);
  n.glow(bar, color, lead <= 0.25 ? 3.5 : 2.5, 1);
  // A little frayed end at the left of the bar.
  const fr = new RenderPath();
  const fx = x + w * (1 - lead);
  for (const o of [-3, -6]) { fr.moveTo(fx + o, y - 1); fr.lineTo(fx + o + 1.5, y + 1); }
  n.glow(fr, color, 1.2, 0.8);
}

/** The boss's remaining hits, centred at the top of the play area. */
function drawBoss(g: Game, cx: number, y: number, s: number) {
  const n = g.neon, hp = g.boss!.hp;
  for (let i = 0; i < DIFF.bossHits; i++) {
    const x = cx + (i - (DIFF.bossHits - 1) / 2) * s * 0.85, left = i < hp;
    if (n.retro) { retroSprite(n, RETRO.ring, x, y, COLORS.danger, left ? 1 : 0.3); continue; }
    const p = new RenderPath();
    p.arc(x, y, s * 0.28, 0, Math.PI * 2);
    if (left) { p.moveTo(x + s * 0.10, y); p.arc(x, y, s * 0.10, 0, Math.PI * 2); }
    n.glow(p, COLORS.danger, 1.5, left ? 1 : 0.3);
  }
}

function drawSizes(g: Game, x: number, y: number) {
  const n = g.neon, W = g.wavell, top = -Math.PI / 2;
  if (n.retro) {
    const [sx, sy] = n.toScreen(x, y);
    for (let i = 0; i < DIFF.growMax; i++) {
      const cx = sx + i * 11 * n.unit;
      retroSprite(n, i < W.size ? RETRO.face : RETRO.ring, cx, sy, COLORS.wavell, i < W.size ? 1 : 0.3);
      if (i === W.size && W.sparks > 0) retroSprite(n, ringPart(W.sparks / DIFF.sparksPerSize), cx, sy, COLORS.wavell);
    }
    n.world();
    return;
  }
  for (let i = 0; i < DIFF.growMax; i++) {
    const cx = x + i * 11, whole = i < W.size;
    const ring = new RenderPath();
    ring.arc(cx, y, 4, 0, Math.PI * 2);
    n.glow(ring, COLORS.wavell, 0.4, whole ? 0 : 0.22);
    if (whole) {
      const p = new RenderPath();
      p.arc(cx, y, 4, 0, Math.PI * 2);
      p.moveTo(cx - 2.2, y - 1.4); p.lineTo(cx - 0.8, y - 0.8);
      p.moveTo(cx + 2.2, y - 1.4); p.lineTo(cx + 0.8, y - 0.8);
      n.glow(p, COLORS.wavell, 0.6);
    } else if (i === W.size && W.sparks > 0) {
      const p = new RenderPath();
      p.arc(cx, y, 4, top, top + Math.PI * 2 * W.sparks / DIFF.sparksPerSize);
      n.glow(p, COLORS.wavell, 0.6);
    }
  }
}

export function drawHud(g: Game) {
  const n = g.neon, inp = g.input;
  const s = hudSize(n), pad = s * 0.9;
  const cx = n.w / 2, hudFade = g.titleDust?.hudFade ?? 1;
  if (g.mode === 'title' && g.morphT < MORPH_TIME) drawMorph(n, g.morphT, g.time);
  else if (g.mode === 'title') {
    drawTitle(n, g.time);
    g.menu.drawHud();
    n.cursor('');
    if (g.menu.page === 'main') {
      const inHint = g.time % HINT_TIME;
      const hintAlpha = clamp(Math.min(inHint, HINT_TIME - inHint) / HINT_FADE, 0, 1);
      n.text(TITLE_HINTS[Math.floor(g.time / HINT_TIME) % TITLE_HINTS.length], cx, n.lineY + s * 3.9, s * 0.55, '#c9a640', 'center', hintAlpha);
      drawDevMenu(g);
      if (canInstall()) drawInstall(g);
      drawVersion(n);
    }
  } else {
    n.cursor('');
    g.titleDust?.draw(n);
    n.fade = hudFade;
    if (g.mode === 'play') {
      const score = g.multiplier > 1 ? `×${g.multiplier}  ${g.score}` : String(g.score);
      const [buttonX, buttonY, buttonRadius] = settingsButton(n);
      n.text(score, Math.min(n.w - s * SCORE_RIGHT, buttonX - buttonRadius - s * 0.25), buttonY, s * 0.68, COLORS.hud, 'right', 0.78);
      if (g.boss) drawBoss(g, cx, pad, s);
      n.world();
      drawSizes(g, n.camX + (pad / n.unit) + 4, n.viewTop + pad / n.unit + 1);
      n.screen();
      drawLead(g, pad, pad + s * 1.4, s);
    }
    if (g.banner > 0) n.text(g.bannerText || g.levelLabel, cx, n.lineY - n.unit * 70, s * 1.65, COLORS.hud, 'center', Math.min(1, g.banner));
    if (g.hintT > 0 && g.mode === 'play') n.text(g.hint, cx, pad + s * 2.4, s * 0.62, '#ffd77a', 'center', Math.min(1, g.hintT));
    if (g.paused && !g.audio.open) {
      n.text('PAUSED', cx, n.lineY - n.unit * 75, s * 2.4, COLORS.hud);
      n.text(`${keyLabel(inp.binds.keys.pause[0])} to carry on   Esc for the menu`, cx, n.lineY - n.unit * 50, s * 0.7, '#c9a640');
    }
    if (g.mode === 'over') {
      drawFlatlined(n, g.time);
      n.text(`score ${g.score}    best ${g.best}`, cx, n.lineY - n.unit * 50, s);
      if (g.overT > 0.8) n.text(inp.touchUsed ? 'tap to continue' : 'press any key', cx, n.lineY + s * 3, s * 0.8, COLORS.hud, 'center', 0.55 + 0.45 * Math.sin(g.time * 4));
    }
  }
  n.fade = 1;
  n.screen();
  if (!g.audio.open) drawSettings(n);
  drawSurround(g);
  n.fade = hudFade;
  if (g.mode === 'play' && !g.audio.open && (inp.touchUsed || matchMedia('(pointer: coarse)').matches)) drawTouch(g);
  n.fade = 1;
  if (g.audio.open) g.audio.draw();
}
