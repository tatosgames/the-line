import {
  AlphaFilter, Application, Color, Container, FillGradient, Filter, GlProgram, Graphics, Rectangle, Sprite, Text, Texture,
  WebGLRenderer, defaultFilterVert,
} from 'pixi.js';
import { AdvancedBloomFilter } from 'pixi-filters/advanced-bloom';
import { COLORS, Neon, clamp } from '../core/neon';
import { RenderPath } from '../core/renderPath';
import type { Game } from './game';
import { PixiStroke, strokeShader } from './pixiStroke';
import { drawGame } from './render';

const FONT = ['Audiowide', 'Arial Black', 'sans-serif'];
const QUANTIZE = `#version 300 es
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
void main() {
  vec4 c = texture(uTexture, vTextureCoord);
  finalColor = vec4(floor(c.rgb * 31.0 + 0.5) / 31.0, c.a);
}`;

const BLOOM_KEY = 'the-line-bloom';
function readBloom() {
  try { return localStorage.getItem(BLOOM_KEY) === '1'; } catch { return false; }
}

class PixiNeon extends Neon {
  private readonly composition = new Container();
  private readonly backdropLayer = new Container();
  private readonly worldLayer = new Container();
  private readonly hudLayer = new Container();
  private readonly titleLayer = new Container();
  private readonly modalLayer = new Container();
  private layer = this.worldLayer;
  private readonly viewport = new Graphics();
  private readonly background = new Graphics();
  private readonly starLayer = new Container();
  private readonly stars: Sprite[] = [];
  private starCount = 0;
  private readonly shader = strokeShader();
  private readonly backdropStrokes = new PixiStroke(this.shader);
  private readonly worldStrokes = new PixiStroke(this.shader);
  private readonly worldBatches = [this.worldStrokes];
  private worldBatch = 0;
  private readonly contours: { layer: Container; stroke: PixiStroke; area: Rectangle }[] = [];
  private contourCount = 0;
  private readonly hudStrokes = new PixiStroke(this.shader);
  private readonly titleStrokes = new PixiStroke(this.shader);
  private readonly titleComposite = new AlphaFilter({ alpha: 1, blendMode: 'add', resolution: 'inherit' });
  private readonly titleArea = new Rectangle();
  private readonly modalStrokes = new PixiStroke(this.shader);
  private strokes = this.worldStrokes;
  private readonly labels = new Map<string, Text[]>();
  private readonly labelCounts = new Map<string, number>();
  private readonly shapes: Graphics[] = [];
  private readonly titleHaze = new FillGradient({
    type: 'radial',
    colorStops: [
      { offset: 0, color: '#ffffff' },
      { offset: 0.7, color: '#ffffff99' },
      { offset: 1, color: '#ffffff00' },
    ],
  });
  private readonly sky = new FillGradient({
    start: { x: 0, y: 0 }, end: { x: 0, y: 1 },
    colorStops: [{ offset: 0, color: '#05030f' }, { offset: 0.62, color: '#0b0920' }, { offset: 1, color: '#020107' }],
  });
  private readonly lineHaze = new FillGradient({
    start: { x: 0, y: 0 }, end: { x: 0, y: 1 },
    colorStops: [{ offset: 0, color: '#ffbe2800' }, { offset: 0.62, color: '#ffbe2812' }, { offset: 1, color: '#ffbe2800' }],
  });
  private shapeCount = 0;
  private frameIndex = 0;
  private readonly labelSeen = new Map<string, number>();
  private readonly bloomFilter = new AdvancedBloomFilter({ threshold: 0.45, bloomScale: 0.65, brightness: 1, blur: 4, quality: 3 });
  private readonly palette = new Filter({
    glProgram: GlProgram.from({ vertex: defaultFilterVert, fragment: QUANTIZE, preferredFragmentPrecision: 'highp' }),
    resolution: 'inherit',
  });
  private readonly bloomArea = new Rectangle();
  private readonly retroArea = new Rectangle();
  private sx2 = 1;
  private sy2 = 1;
  private tx = 0;
  private ty = 0;
  private layoutKey = '';
  private readonly colors = new Map<string, number[]>();
  private bloomOn = readBloom();
  private activeBloom = false;
  private activeRetro = false;

  constructor(private readonly app: Application, canvas: HTMLCanvasElement, source: Neon) {
    super(canvas, (w, h) => source.fitViewport(w, h), document.createElement('canvas'));
    this.retro = source.retro;
    this.camX = source.camX;
    this.shake = source.shake;
    this.zoom = source.zoom;
    this.resize();
    this.worldLayer.mask = this.viewport;
    this.worldLayer.filterArea = this.bloomArea;
    this.composition.filterArea = this.retroArea;
    this.composition.addChild(this.backdropLayer, this.viewport, this.worldLayer, this.hudLayer, this.modalLayer);
    this.backdropLayer.addChild(this.background, this.starLayer, this.backdropStrokes.mesh);
    this.worldLayer.addChild(this.worldStrokes.mesh);
    // Retraced letters use one coverage layer so the turns cannot add their light twice.
    this.titleStrokes.mesh.blendMode = 'max';
    this.titleLayer.filters = [this.titleComposite];
    this.titleLayer.filterArea = this.titleArea;
    this.titleLayer.addChild(this.titleStrokes.mesh);
    this.hudLayer.addChild(this.titleLayer);
    this.hudLayer.addChild(this.hudStrokes.mesh);
    this.modalLayer.addChild(this.modalStrokes.mesh);
    app.stage.addChild(this.composition);
  }

  override get bloomAvailable() { return true; }
  override get bloom() { return this.bloomOn; }
  override toggleBloom() {
    this.bloomOn = !this.bloomOn;
    try { localStorage.setItem(BLOOM_KEY, this.bloomOn ? '1' : '0'); } catch { /* storage blocked */ }
  }

  override begin(dt: number, clip = true) {
    this.prepareFrame(dt);
    const key = [this.fullW, this.fullH, this.dpr, this.ox, this.oy, this.w, this.h].join('/');
    if (key !== this.layoutKey) {
      this.layoutKey = key;
      this.app.renderer.resize(this.fullW, this.fullH, this.dpr);
      this.shader.resources.strokeUniforms.uniforms.uPixelWidth = 1 / this.dpr;
      this.app.stage.hitArea = this.app.screen;
      this.viewport.clear().rect(this.ox, this.oy, this.w, this.h).fill(0xffffff);
      this.background.clear().rect(0, 0, this.fullW, this.fullH).fill(this.sky);
      this.background.rect(0, this.oy + this.lineY - 40 * this.unit, this.fullW, 65 * this.unit).fill(this.lineHaze);
      this.bloomArea.x = this.ox; this.bloomArea.y = this.oy;
      this.bloomArea.width = this.w; this.bloomArea.height = this.h;
      this.retroArea.width = this.fullW; this.retroArea.height = this.fullH;
      this.titleArea.x = this.ox; this.titleArea.y = this.oy;
      this.titleArea.width = this.w; this.titleArea.height = this.h;
    }
    const bloom = this.bloomOn && !this.retro;
    if (bloom !== this.activeBloom) {
      this.activeBloom = bloom;
      this.worldLayer.filters = bloom ? [this.bloomFilter] : null;
    }
    if (this.retro !== this.activeRetro) {
      this.activeRetro = this.retro;
      this.composition.filters = this.retro ? [this.palette] : null;
    }
    this.layer = this.backdropLayer;
    this.strokes = this.backdropStrokes;
    this.backdropStrokes.reset();
    this.worldBatch = 0;
    this.contourCount = 0;
    for (const contour of this.contours) contour.layer.visible = false;
    this.worldLayer.addChild(this.worldStrokes.mesh);
    for (const batch of this.worldBatches) batch.reset();
    this.hudStrokes.reset();
    this.titleStrokes.reset();
    this.titleLayer.visible = false;
    this.modalStrokes.reset();
    this.labelCounts.clear();
    this.shapeCount = this.starCount = 0;
    this.frameIndex++;
    if (clip) this.clipWorld();
  }

  override clipWorld() {
    this.layer = this.worldLayer;
    this.strokes = this.worldStrokes;
    this.screen();
  }

  override hud() {
    this.layer = this.hudLayer;
    this.strokes = this.hudStrokes;
  }

  override modal() {
    this.layer = this.modalLayer;
    this.strokes = this.modalStrokes;
  }

  override finish() {
    for (let i = this.shapeCount; i < this.shapes.length; i++) this.shapes[i].visible = false;
    for (let i = this.starCount; i < this.stars.length; i++) this.stars[i].visible = false;
    for (const [key, labels] of this.labels) {
      const used = this.labelCounts.get(key) ?? 0;
      if (this.frameIndex - (this.labelSeen.get(key) ?? 0) > 240) {
        for (const label of labels) label.destroy();
        this.labels.delete(key);
        this.labelSeen.delete(key);
        continue;
      }
      for (let i = used; i < labels.length; i++) labels[i].visible = false;
    }
    this.backdropStrokes.upload();
    for (const batch of this.worldBatches) batch.upload();
    for (let i = 0; i < this.contourCount; i++) this.contours[i].stroke.upload();
    this.hudStrokes.upload();
    this.titleStrokes.upload();
    this.modalStrokes.upload();
    this.app.render();
  }

  override world() {
    const [u, x, y] = this.worldTransform();
    this.sx2 = this.sy2 = u;
    this.tx = x; this.ty = y;
  }

  override screen() {
    this.sx2 = this.sy2 = 1;
    this.tx = this.ox; this.ty = this.oy;
  }

  override overlay() {
    this.sx2 = this.sy2 = 1;
    this.tx = this.ty = 0;
  }

  override transform(a: number, d: number, y = 0) {
    this.ty += y * this.sy2;
    this.sx2 *= a;
    this.sy2 *= d;
  }

  private shape(additive = false) {
    const i = this.shapeCount++;
    const shape = this.shapes[i] ?? (this.shapes[i] = new Graphics());
    shape.clear();
    shape.visible = true;
    shape.blendMode = additive ? 'add' : 'normal';
    shape.alpha = 1;
    shape.tint = 0xffffff;
    if (shape.parent !== this.layer) this.layer.addChild(shape);
    return shape;
  }

  override fillRect(x: number, y: number, w: number, h: number, color: string, alpha = 1, additive = false) {
    if (additive && this.layer === this.backdropLayer) {
      const i = this.starCount++;
      const star = this.stars[i] ?? (this.stars[i] = this.starLayer.addChild(new Sprite(Texture.WHITE)));
      star.tint = color;
      star.alpha = alpha;
      star.blendMode = 'add';
      star.visible = true;
      star.position.set(this.tx + x * this.sx2, this.ty + y * this.sy2);
      star.width = w * this.sx2;
      star.height = h * this.sy2;
      return;
    }
    const shape = this.shape(additive);
    shape.rect(this.tx + x * this.sx2, this.ty + y * this.sy2, w * this.sx2, h * this.sy2).fill({ color, alpha });
    if (this.layer === this.modalLayer) this.modalLayer.setChildIndex(shape, 0);
  }

  override fillCircle(x: number, y: number, radius: number, color: string) {
    const shape = this.shape();
    shape.circle(this.tx + x * this.sx2, this.ty + y * this.sy2, radius * Math.abs(this.sx2)).fill(color);
    if (this.layer === this.worldLayer) {
      this.worldLayer.addChild(shape);
      this.worldBatch++;
      this.strokes = this.worldBatches[this.worldBatch] ?? (this.worldBatches[this.worldBatch] = new PixiStroke(this.shader));
      this.worldLayer.addChild(this.strokes.mesh);
    }
  }

  override haze(x: number, y: number, rx: number, ry: number, color: number[], alpha: number) {
    const shape = this.shape(true);
    shape.alpha = alpha;
    shape.tint = (color[0] << 16) | (color[1] << 8) | color[2];
    shape.ellipse(this.tx + x, this.ty + y, rx, ry).fill(this.titleHaze);
  }

  override titleGlow(path: RenderPath, color: string, width: number, bloom: number) {
    this.titleLayer.visible = true;
    const previous = this.strokes;
    this.strokes = this.titleStrokes;
    this.stroke(path, color, width, 0.55, bloom);
    this.glow(path, color, width);
    this.strokes = previous;
  }

  override lineGlow(path: RenderPath, color: string, width: number, intensity = 1) {
    if (this.layer !== this.worldLayer || !this.fade || !intensity) {
      this.glow(path, color, width, intensity);
      return;
    }
    const i = this.contourCount++;
    let contour = this.contours[i];
    if (!contour) {
      const layer = new Container();
      const stroke = new PixiStroke(this.shader);
      stroke.mesh.blendMode = 'max';
      layer.addChild(stroke.mesh);
      layer.filters = [this.titleComposite];
      const area = new Rectangle();
      layer.filterArea = area;
      contour = this.contours[i] = { layer, stroke, area };
    }
    contour.layer.visible = true;
    contour.stroke.reset();
    this.worldLayer.addChild(contour.layer);
    this.strokes = contour.stroke;
    this.glow(path, color, width, intensity);
    const { left, top, right, bottom } = contour.stroke.bounds;
    const x = Math.max(this.ox, left), y = Math.max(this.oy, top);
    const w = Math.min(this.ox + this.w, right) - x, h = Math.min(this.oy + this.h, bottom) - y;
    if (w > 0 && h > 0) { contour.area.x = x; contour.area.y = y; contour.area.width = w; contour.area.height = h; }
    else contour.layer.visible = false;
    this.worldBatch++;
    this.strokes = this.worldBatches[this.worldBatch] ?? (this.worldBatches[this.worldBatch] = new PixiStroke(this.shader));
    this.worldLayer.addChild(this.strokes.mesh);
  }

  override glow(path: RenderPath | Path2D, color: string, width = 0.8, intensity = 1) {
    if (path instanceof RenderPath) this.stroke(path, color, width, intensity, this.blur);
  }

  private stroke(path: RenderPath, color: string, width: number, intensity: number, blur: number) {
    if (!this.fade || !intensity) return;
    let rgb = this.colors.get(color);
    if (!rgb) {
      rgb = Array.from(new Color(color).toArray());
      if (this.colors.size < 512) this.colors.set(color, rgb);
    }
    this.strokes.append(path, this.sx2, this.sy2, this.tx, this.ty, width * Math.abs(this.sx2), rgb, this.fade, intensity, blur);
  }

  override fillPixels(path: RenderPath | Path2D, color: string, alpha = 1) {
    if (!(path instanceof RenderPath)) return;
    const shape = this.shape(true);
    for (const command of path.commands) if (command[0] === 'rect') {
      shape.rect(command[1] / this.dpr, command[2] / this.dpr, command[3] / this.dpr, command[4] / this.dpr);
    }
    shape.fill({ color, alpha: alpha * this.fade });
    this.screen();
  }

  override text(text: string, x: number, y: number, size: number, color = COLORS.hud, align: CanvasTextAlign = 'center', alpha = 1) {
    if (this.retro) { this.retroText(text, x, y, size, color, align, alpha); return; }
    this.screen();
    this.label(text, x, y, size, color, align, alpha, false);
  }

  override wordOnLine(text: string, x: number, y: number, size: number, color = COLORS.line) {
    if (this.retro) { super.wordOnLine(text, x, y, size, color); return; }
    this.screen();
    this.label(text, x, y, size, color, 'center', 1, true);
  }

  private label(text: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign, alpha: number, outline: boolean) {
    if (!text || alpha * this.fade <= 0) return;
    const sizeKey = Math.max(1, Math.round(size * 4) / 4);
    const key = JSON.stringify([text, sizeKey, color, outline]);
    const n = this.labelCounts.get(key) ?? 0;
    this.labelCounts.set(key, n + 1);
    this.labelSeen.set(key, this.frameIndex);
    const labels = this.labels.get(key) ?? [];
    if (!this.labels.has(key)) this.labels.set(key, labels);
    const label = labels[n] ?? (labels[n] = new Text({
      text,
      style: {
        fontFamily: FONT, fontSize: sizeKey,
        fill: outline && size > 28 ? '#ffffff00' : '#fff9d3',
        stroke: outline ? { color, width: Math.max(1, sizeKey * 0.04) } : undefined,
        dropShadow: { color, blur: sizeKey * 0.32, distance: 0, alpha: clamp(alpha, 0, 1) },
        padding: Math.ceil(sizeKey * 0.4),
      },
    }));
    if (label.parent !== this.layer) this.layer.addChild(label);
    label.anchor.set(align === 'right' || align === 'end' ? 1 : align === 'left' || align === 'start' ? 0 : 0.5, outline ? 0.86 : 0.5);
    label.position.set(this.tx + x, this.ty + y);
    label.alpha = alpha * this.fade;
    label.blendMode = 'add';
    label.visible = true;
  }

  dispose() {
    this.worldLayer.filters = null;
    this.composition.filters = null;
    this.titleLayer.filters = null;
    for (const { layer, stroke } of this.contours) {
      layer.filters = null;
      stroke.destroy();
    }
    this.backdropStrokes.destroy();
    for (const batch of this.worldBatches) batch.destroy();
    this.hudStrokes.destroy();
    this.titleStrokes.destroy();
    this.titleComposite.destroy();
    this.modalStrokes.destroy();
    this.shader.destroy();
    this.bloomFilter.destroy();
    this.palette.destroy();
    this.sky.destroy();
    this.lineHaze.destroy();
    this.titleHaze.destroy();
  }
}

export async function createPixiRenderer(canvas: HTMLCanvasElement, source: Neon) {
  const app = new Application();
  await app.init({ canvas, preference: ['webgl'], autoStart: false, background: '#020107', antialias: true });
  if (!(app.renderer instanceof WebGLRenderer) || app.renderer.context.webGLVersion !== 2) {
    app.destroy({ removeView: false }, { children: true });
    throw new Error('The Pixi renderer requires WebGL 2.');
  }
  const neon = new PixiNeon(app, canvas, source);
  const ui = new Container();
  let game: Game | undefined;
  const hit = (x: number, y: number) => game?.input.uiTap?.(x, y) ?? null;
  ui.eventMode = 'static';
  ui.hitArea = { contains: (x, y) => Boolean(hit(x, y)) };
  ui.on('pointerdown', (e) => {
    e.stopPropagation();
    game?.input.pointerDown(e, hit(e.global.x, e.global.y));
  });
  app.stage.eventMode = 'static';
  app.stage.on('pointerdown', (e) => game?.input.pointerDown(e, null));
  app.stage.addChild(ui);

  return {
    neon,
    draw(next: Game, dt: number) {
      game = next;
      drawGame(next, dt);
    },
    destroy() {
      game = undefined;
      neon.dispose();
      app.destroy({ removeView: false }, { children: true });
    },
  };
}
