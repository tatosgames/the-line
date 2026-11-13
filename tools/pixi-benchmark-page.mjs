// Instrumented production entry built only by pixi-benchmark.mjs.
import { Input } from '@bench/core/input';
import { Neon } from '@bench/core/neon';
import { sfx } from '@bench/core/sfx';
import { DIFF } from '@bench/data/difficulty';
import { Game } from '@bench/game/game';
import { drawGame } from '@bench/game/render';
import { createPixiRenderer } from 'benchmark:pixi';

const IDLE = {
  left: false, right: false, up: false, down: false,
  upPressed: false, downPressed: false, dragPressed: false, pullPressed: false,
};
const scenes = { title: 1, normal: 1, dense: 8, boss: 10, nostalgia: 1 };
const frameMs = 1000 / 60;
const nativeRandom = Math.random;
const params = new URLSearchParams(location.search);
const rendererName = params.get('renderer') ?? 'canvas';
const canvas = document.querySelector('#view');
const canvasNeon = rendererName === 'canvas' ? new Neon(canvas) : new Neon(canvas, undefined, document.createElement('canvas'));
const input = new Input(canvas);
if (params.has('gl-diagnostics') && rendererName === 'pixi') {
  for (const context of [WebGLRenderingContext, WebGL2RenderingContext]) {
    const gl = context.prototype;
    const link = gl.linkProgram;
    gl.linkProgram = function (program) {
      link.call(this, program);
      if (!this.getProgramParameter(program, this.LINK_STATUS)) {
        console.error('WebGL link:', this.getProgramInfoLog(program));
        for (const shader of this.getAttachedShaders(program) ?? []) console.error('WebGL shader:', this.getShaderInfoLog(shader));
      }
    };
  }
}
const pixi = rendererName === 'pixi' ? await createPixiRenderer(canvas, canvasNeon) : null;
const neon = pixi?.neon ?? canvasNeon;

function seeded(seed) {
  return () => {
    let n = seed = (seed + 0x6d2b79f5) | 0;
    n = Math.imul(n ^ (n >>> 15), 1 | n);
    n ^= n + Math.imul(n ^ (n >>> 7), 61 | n);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}

// Silence the audio device and network so unlocking Web Audio cannot skew render samples.
sfx.unlock = () => {};

let game;
let step = 0;
let simulationRandom;
let renderRandom;
let keys;
let scene;
let maxThreats;

function reset(name) {
  if (!(name in scenes)) throw new Error('Unknown scene: ' + name);
  scene = name;
  step = 0;
  maxThreats = 0;
  simulationRandom = seeded(11);
  renderRandom = seeded(42);
  keys = seeded(12);
  DIFF.startLevel = scenes[name];
  // Keep action in view through missed attacks during the stress replay.
  DIFF.lives = 20;
  neon.retro = name === 'nostalgia';
  neon.resize();
  neon.camX = 0;
  neon.shake = 0;
  Math.random = simulationRandom;
  try {
    game = new Game(neon, input);
    if (name !== 'title') game.start();
    game.best = 0;
  } finally {
    Math.random = nativeRandom;
  }
}

function advance(target) {
  Math.random = simulationRandom;
  try {
    while (step < target) {
      const k = scene === 'title' ? IDLE : {
        ...IDLE, right: true,
        dragPressed: step % 72 === 0 && keys() < 0.75,
        pullPressed: step % 72 === 36 && keys() < 0.75,
        upPressed: step % 300 === 180 && keys() < 0.5,
        downPressed: step % 300 === 30 && keys() < 0.35,
      };
      game.tick(k);
      if (game.mode === 'over') game.start();
      maxThreats = Math.max(maxThreats, game.sinepedes.length + game.urchins.length + game.worms.length
        + game.bubbles.length + game.backwaves.length + game.refluxes.length + Number(game.boss !== null));
      step++;
    }
  } finally {
    Math.random = nativeRandom;
  }
}

function draw() {
  // The pinned build predates the separate visual RNG. Exercise the current build
  // with its simulation seed installed so drawing can never hide stray RNG calls.
  Math.random = __PINNED_CANVAS__ ? renderRandom : simulationRandom;
  const random = Math.random;
  let calls = 0;
  Math.random = () => { calls++; return random(); };
  try {
    if (pixi) pixi.draw(game, 1 / 60);
    else drawGame(game, 1 / 60);
    if (!__PINNED_CANVAS__ && calls) throw new Error('Drawing consumed simulation RNG');
  } finally {
    Math.random = nativeRandom;
  }
}

function state() {
  const { wavell, line, beat } = game;
  return {
    step, mode: game.mode, level: game.level, score: game.score, lives: game.lives,
    endX: game.endX, x: wavell.x, side: wavell.side, size: wavell.size, action: wavell.state,
    bpm: beat.bpm, beat: beat.beatOfBar, flash: beat.flash,
    maxThreats, lineBase: line.base, line: Array.from(line.y),
  };
}

function viewport() {
  return {
    width: innerWidth, height: innerHeight, devicePixelRatio,
    backingWidth: canvas.width, backingHeight: canvas.height,
  };
}

function capture(name, target) {
  reset(name);
  draw();
  for (let i = 0; i < target; i += 2) {
    advance(Math.min(target, i + 2));
    draw();
  }
  return { state: state(), viewport: viewport() };
}

function measure(name, seconds, warmup) {
  reset(name);
  const cpu = [];
  const intervals = [];
  let start;
  let lastSample;
  let previousSlot = -1;
  const cutoff = (seconds + warmup) * 1000;
  return new Promise((resolve, reject) => {
    let stopped = false;
    const expectedEnd = performance.now() + cutoff;
    const guard = setInterval(() => {
      if (document.visibilityState === 'hidden' || performance.now() > expectedEnd + 15000) {
        clearInterval(guard);
        stopped = true;
        reject(new Error('Animation frames stalled; keep the benchmark tab visible and avoid other browser work.'));
      }
    }, 1000);
    function frame(now) {
      if (stopped) return;
      try {
        start ??= now;
        const elapsed = now - start;
        if (elapsed >= cutoff) {
          advance(Math.ceil(cutoff / frameMs) * 2);
          clearInterval(guard);
          resolve({ cpu, intervals, elapsedMs: elapsed, state: state(), viewport: viewport() });
          return;
        }
        const slot = Math.floor((elapsed + 0.5) / frameMs);
        if (slot > previousSlot) {
          previousSlot = slot;
          advance(slot * 2);
          const before = performance.now();
          draw();
          const cpuMs = performance.now() - before;
          if (elapsed >= warmup * 1000) {
            cpu.push(cpuMs);
            if (lastSample !== undefined) intervals.push(now - lastSample);
            lastSample = now;
          }
        }
        requestAnimationFrame(frame);
      } catch (error) {
        clearInterval(guard);
        reject(error);
      }
    }
    requestAnimationFrame(frame);
  });
}

await document.fonts.ready;
window.benchmark = { capture, measure, renderer: rendererName };
