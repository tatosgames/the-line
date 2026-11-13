import { initApp } from './core/app';
import { DIFF } from './data/difficulty';
import { Game } from './game/game';
import { Input } from './core/input';
import { bindGameInputLayout, fitGameArea } from './core/input-layout';
import { Neon } from './core/neon';
import type { createPixiRenderer } from './game/pixiRenderer';

initApp();

// ?level=10 starts every game at that level (the boss, for trying him out), without saving it.
const params = new URLSearchParams(location.search);
const startAt = Number(params.get('level'));
if (startAt >= 1) DIFF.startLevel = Math.floor(startAt);

let canvas = document.querySelector<HTMLCanvasElement>('#view')!;
canvas.dataset.renderer = 'canvas';
const game = new Game(new Neon(canvas, fitGameArea), new Input(canvas));
bindGameInputLayout(game);
game.loadNostalgia();
game.loadControls();

let pixi: Awaited<ReturnType<typeof createPixiRenderer>> | undefined;

function copyViewport(from: Neon, to: Neon) {
  to.camX = from.camX;
  to.shake = from.shake;
  to.retro = from.retro;
  to.resize();
}

function fallback() {
  if (!pixi) return;
  const replacement = canvas.cloneNode(false) as HTMLCanvasElement;
  replacement.dataset.renderer = 'canvas';
  const lost = pixi;
  pixi = undefined;
  canvas.replaceWith(replacement);
  canvas = replacement;
  const neon = new Neon(canvas, fitGameArea);
  copyViewport(game.neon, neon);
  game.neon = neon;
  game.input.setSurface(canvas);
  try { lost.destroy(); } catch (error) { console.warn('Could not dispose the lost WebGL context.', error); }
}

async function startPixi() {
  const candidate = canvas.cloneNode(false) as HTMLCanvasElement;
  candidate.dataset.renderer = 'pixi';
  try {
    const { createPixiRenderer } = await import('./game/pixiRenderer');
    const renderer = await createPixiRenderer(candidate, game.neon);
    copyViewport(game.neon, renderer.neon);
    canvas.replaceWith(candidate);
    canvas = candidate;
    pixi = renderer;
    game.neon = renderer.neon;
    game.neon.resize();
    game.input.setSurface(canvas, { pointerDown: 'pixi' });
    canvas.addEventListener('webglcontextlost', fallback, { once: true });
  } catch (error) {
    fallback();
    console.warn('Pixi WebGL could not start. Using Canvas 2D.', error);
  }
}

// Keep Canvas as the default until the physical-device performance gates pass.
if (params.get('renderer') === 'pixi') void startPixi();

let last = performance.now();
function loop(now: number) {
  game.frame((now - last) / 1000, draw);
  last = now;
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

function draw(game: Game, dt: number) {
  if (pixi) {
    try { pixi.draw(game, dt); return; } catch (error) {
      console.warn('Pixi WebGL rendering failed. Using Canvas 2D.', error);
      fallback();
    }
  }
  game.draw(dt);
}

if (import.meta.env.DEV) (window as unknown as { game: Game }).game = game;
