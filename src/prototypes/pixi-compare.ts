import { Application, MeshGeometry, Mesh, Texture } from 'pixi.js';
import { COLORS, Neon, VIEW_W } from '../core/neon';
import { TUNE } from '../data/tune';
import { SpringLine } from '../game/line';

const STEP = 1 / 120;
const BACKGROUND = '#05030f';
const WIDTH = 0.9;
const line = new SpringLine();
line.cover(-70, VIEW_W + 70);

// The canvas clips the outer ends of the stroke in both renderers.
const first = Math.floor((0 - line.base) / line.spacing) - 2;
const count = Math.ceil(VIEW_W / line.spacing) + 6;
const heights = new Float32Array(count);
const indices = new Uint32Array((count - 1) * 6);
for (let i = 0; i < count - 1; i++) {
  const a = i * 2;
  indices.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6);
}

const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
const pixiCanvas = document.querySelector<HTMLCanvasElement>('#pixi')!;
const status = document.querySelector<HTMLParagraphElement>('#pixi-status')!;
const pause = document.querySelector<HTMLButtonElement>('#pause')!;
const neon = new Neon(canvas);
let drawPixi: (() => void) | undefined;

async function createPixi() {
  const app = new Application();
  await app.init({
    canvas: pixiCanvas,
    preference: ['webgl'],
    autoStart: false,
    background: BACKGROUND,
    antialias: true,
  });

  // Match the four additive strokes in Neon.glow, from outer halo to hot centre.
  const layers = [
    { scale: 8, color: COLORS.line, alpha: 0.06 },
    { scale: 3, color: COLORS.line, alpha: 0.18 },
    { scale: 1, color: COLORS.line, alpha: 1 },
    { scale: 0.35, color: '#ffffff', alpha: 0.55 },
  ].map(({ scale, color, alpha }) => {
    const positions = new Float32Array(count * 4);
    const geometry = new MeshGeometry({ positions, indices });
    const mesh = new Mesh({ geometry, texture: Texture.WHITE });
    mesh.tint = color;
    mesh.alpha = alpha;
    mesh.blendMode = 'add';
    app.stage.addChild(mesh);
    return { positions, geometry, halfWidth: WIDTH * scale / 2 };
  });

  drawPixi = () => {
    const { fullW, fullH, dpr, unit, ox, oy, lineY } = neon;
    if (app.screen.width !== fullW || app.screen.height !== fullH || app.renderer.resolution !== dpr) {
      app.renderer.resize(fullW, fullH, dpr);
    }
    app.stage.position.set(ox, oy + lineY);
    app.stage.scale.set(unit);

    for (let i = 0; i < count; i++) {
      const x = line.xAt(first + i);
      const y = heights[i];
      const before = Math.max(0, i - 1);
      const after = Math.min(count - 1, i + 1);
      const dx = (after - before) * line.spacing;
      const dy = heights[after] - heights[before];
      const length = Math.hypot(dx, dy);
      const nx = -dy / length;
      const ny = dx / length;
      const p = i * 4;
      for (const { positions, halfWidth } of layers) {
        positions[p] = x + nx * halfWidth;
        positions[p + 1] = y + ny * halfWidth;
        positions[p + 2] = x - nx * halfWidth;
        positions[p + 3] = y - ny * halfWidth;
      }
    }
    for (const { geometry } of layers) geometry.getBuffer('aPosition').update();
    app.render();
  };
  status.hidden = true;
}

function reset() {
  line.clear();
  line.pulse(VIEW_W * 0.28, -TUNE.waveAmp, TUNE.waveWidth, 1);
  line.pulse(VIEW_W * 0.72, TUNE.waveAmp, TUNE.waveWidth, -1);
}

let running = true;
let accumulator = 0;
let previous = performance.now();
reset();

function draw() {
  if (neon.fullW !== canvas.clientWidth || neon.fullH !== canvas.clientHeight) neon.resize();
  neon.overlay();
  const ctx = neon.ctx;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, neon.fullW, neon.fullH);
  neon.world();

  heights.set(line.y.subarray(first, first + count));
  const path = new Path2D();
  path.moveTo(line.xAt(first), heights[0]);
  for (let i = 1; i < count; i++) path.lineTo(line.xAt(first + i), heights[i]);
  neon.glow(path, COLORS.line, WIDTH);
  drawPixi?.();
}

function frame(now: number) {
  if (running) {
    accumulator += Math.min((now - previous) / 1000, 0.05);
    while (accumulator >= STEP) {
      line.step(STEP / 2);
      line.step(STEP / 2);
      accumulator -= STEP;
    }
    draw();
  }
  previous = now;
  requestAnimationFrame(frame);
}

function pulse(x: number) {
  const direction = x < VIEW_W / 2 ? 1 : -1;
  line.pulse(x, -TUNE.waveAmp, TUNE.waveWidth, direction);
  draw();
}

for (const panel of [canvas, pixiCanvas]) {
  panel.addEventListener('click', (event) => {
    const bounds = panel.getBoundingClientRect();
    pulse((event.clientX - bounds.left) / bounds.width * VIEW_W);
  });
}

document.querySelector<HTMLButtonElement>('#pulse')!.onclick = () => pulse(VIEW_W * 0.35);
document.querySelector<HTMLButtonElement>('#reset')!.onclick = () => {
  accumulator = 0;
  reset();
  draw();
};
pause.onclick = () => {
  running = !running;
  pause.textContent = running ? 'Pause' : 'Resume';
};

new ResizeObserver(draw).observe(canvas);
requestAnimationFrame(frame);
void createPixi().then(draw, (error: unknown) => {
  status.textContent = 'WebGL could not start. The Canvas 2D panel is still available.';
  console.error(error);
});
