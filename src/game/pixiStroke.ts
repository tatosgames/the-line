import { Buffer, BufferUsage, Geometry, GlProgram, Mesh, Shader } from 'pixi.js';
import type { RenderPath } from '../core/renderPath';

const vertex = `#version 300 es
in vec2 aPosition;
in vec2 aNormal;
in vec4 aStroke;
in vec4 aTint;
out vec4 vStroke;
out vec4 vTint;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
void main() {
  float reach = aStroke.y * 0.5 * max(8.0, 1.0 + aStroke.w) + 1.0;
  vec2 p = aPosition + aNormal * aStroke.x * reach;
  gl_Position = vec4((uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix * vec3(p, 1.0)).xy, 0.0, 1.0);
  vStroke = vec4(aStroke.x * reach, aStroke.y, aStroke.z, aStroke.w);
  vTint = aTint;
}`;

const fragment = `#version 300 es
in vec4 vStroke;
in vec4 vTint;
out vec4 finalColor;
uniform float uPixelWidth;
float band(float width) {
  float d = abs(vStroke.x);
  float pixel = uPixelWidth;
  // Area coverage keeps strokes thinner than a backing pixel visible between rows.
  return clamp(min(d + pixel * 0.5, width * 0.5) - max(d - pixel * 0.5, -width * 0.5), 0.0, pixel) / pixel;
}
void main() {
  float w = vStroke.y, strength = vStroke.z, blur = vStroke.w;
  vec3 light;
  if (blur > 0.0) {
    float share = 0.0, sum = 0.0;
    for (int i = 0; i < 6; i++) {
      float spread = 1.0 + blur * float(i) / 5.0;
      share += 1.0 / spread;
      sum += band(w * spread) / spread;
    }
    light = vTint.rgb * sum / share * 1.3 * strength;
  } else {
    float base = min(1.0, strength);
    light = vTint.rgb * (0.06 * strength * band(w * 8.0) + 0.18 * strength * band(w * 3.0) + base * band(w));
    light += vec3(0.55 * base * band(w * 0.35));
  }
  light *= vTint.a;
  finalColor = vec4(light, clamp(max(light.r, max(light.g, light.b)), 0.0, 1.0));
}`;

const FLOATS = 12;

/** A pooled triangle strip per subpath. The GPU expands and shades the neon stroke. */
export class PixiStroke {
  private data = new Float32Array(256 * FLOATS);
  private indices = new Uint32Array(768);
  private readonly vertices = new Buffer({ data: this.data, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
  private readonly indexBuffer = new Buffer({ data: this.indices, usage: BufferUsage.INDEX | BufferUsage.COPY_DST });
  private readonly geometry = new Geometry({
    attributes: {
      aPosition: { buffer: this.vertices, format: 'float32x2', stride: FLOATS * 4, offset: 0 },
      aNormal: { buffer: this.vertices, format: 'float32x2', stride: FLOATS * 4, offset: 8 },
      aStroke: { buffer: this.vertices, format: 'float32x4', stride: FLOATS * 4, offset: 16 },
      aTint: { buffer: this.vertices, format: 'float32x4', stride: FLOATS * 4, offset: 32 },
    },
    indexBuffer: this.indexBuffer,
  });
  readonly mesh: Mesh<Geometry, Shader>;
  private vertexCount = 0;
  private indexCount = 0;
  private readonly points: number[] = [];
  private left = Infinity;
  private top = Infinity;
  private right = -Infinity;
  private bottom = -Infinity;

  constructor(shader: Shader, private readonly trackBounds = false) {
    this.mesh = new Mesh({ geometry: this.geometry, shader });
    this.mesh.blendMode = 'add';
  }

  reset() {
    this.vertexCount = this.indexCount = 0;
    this.left = this.top = Infinity;
    this.right = this.bottom = -Infinity;
  }

  append(path: RenderPath, sx: number, sy: number, tx: number, ty: number, width: number,
    rgb: number[], fade: number, intensity: number, blur: number) {
    const points = this.points;
    const reach = this.trackBounds ? (width * Math.max(8, 1 + blur) / 2 + 1) * 1.35 + 2 : 0;
    let x = 0, y = 0;
    const flush = () => {
      if (points.length >= 4) this.strip(points, width, rgb, fade, intensity, blur);
      points.length = 0;
    };
    const point = (px: number, py: number) => {
      x = px; y = py;
      const xx = px * sx + tx, yy = py * sy + ty;
      if (reach) {
        this.left = Math.min(this.left, xx - reach);
        this.top = Math.min(this.top, yy - reach);
        this.right = Math.max(this.right, xx + reach);
        this.bottom = Math.max(this.bottom, yy + reach);
      }
      if (xx !== points[points.length - 2] || yy !== points[points.length - 1]) points.push(xx, yy);
    };
    for (const cmd of path.commands) {
      switch (cmd[0]) {
        case 'moveTo': flush(); point(cmd[1], cmd[2]); break;
        case 'lineTo': point(cmd[1], cmd[2]); break;
        case 'closePath':
          if (points.length >= 4) points.push(points[0], points[1]);
          flush();
          break;
        case 'rect': {
          const [, x, y, w, h] = cmd;
          flush();
          point(x, y); point(x + w, y); point(x + w, y + h); point(x, y + h); point(x, y);
          flush();
          break;
        }
        case 'quadraticCurveTo': {
          const [, cx, cy, ex, ey] = cmd;
          if (!points.length) point(cx, cy);
          const ax = x, ay = y;
          const n = Math.max(2, Math.min(16, Math.ceil(Math.sqrt(Math.hypot(ax - 2 * cx + ex, ay - 2 * cy + ey) * Math.abs(sx)))));
          for (let i = 1; i <= n; i++) {
            const t = i / n, s = 1 - t;
            point(s * s * ax + 2 * s * t * cx + t * t * ex, s * s * ay + 2 * s * t * cy + t * t * ey);
          }
          break;
        }
        case 'arc':
        case 'ellipse': {
          const [, cx, cy, rx] = cmd;
          const [ry, rotation, start, end, ccw] = cmd[0] === 'arc'
            ? [rx, 0, cmd[4], cmd[5], cmd[6]] : [cmd[4], cmd[5], cmd[6], cmd[7], cmd[8]];
          const turn = Math.PI * 2;
          let sweep = end - start;
          if (ccw) sweep = sweep <= -turn ? -turn : -(((-sweep % turn) + turn) % turn);
          else sweep = sweep >= turn ? turn : ((sweep % turn) + turn) % turn;
          const n = Math.max(2, Math.min(80, Math.ceil(Math.abs(sweep) * Math.sqrt(Math.max(rx, ry) * Math.abs(sx)))));
          const cos = Math.cos(rotation), sin = Math.sin(rotation);
          for (let i = 0; i <= n; i++) {
            const a = start + sweep * i / n, u = rx * Math.cos(a), v = ry * Math.sin(a);
            point(cx + u * cos - v * sin, cy + u * sin + v * cos);
          }
          break;
        }
      }
    }
    flush();
  }

  private strip(points: number[], width: number, rgb: number[], fade: number, intensity: number, blur: number) {
    const n = points.length / 2, base = this.vertexCount;
    this.vertexCount += n * 2;
    const end = this.indexCount + (n - 1) * 6;
    if (this.vertexCount * FLOATS > this.data.length) {
      const next = new Float32Array(Math.max(this.data.length * 2, this.vertexCount * FLOATS));
      next.set(this.data); this.data = next; this.vertices.data = next;
    }
    if (end > this.indices.length) {
      const next = new Uint32Array(Math.max(this.indices.length * 2, end));
      next.set(this.indices); this.indices = next; this.indexBuffer.data = next;
    }
    const closed = points[0] === points[points.length - 2] && points[1] === points[points.length - 1];
    let incomingX = 0, incomingY = 0;
    if (closed) {
      const dx = points[0] - points[points.length - 4], dy = points[1] - points[points.length - 3];
      const length = Math.hypot(dx, dy);
      if (length) { incomingX = dx / length; incomingY = dy / length; }
    }
    for (let i = 0; i < n; i++) {
      const p = i * 2, x = points[p], y = points[p + 1];
      const b = i + 1 < n ? p + 2 : closed ? 2 : p;
      const dx = points[b] - x, dy = points[b + 1] - y;
      const length = b === p ? 0 : Math.hypot(dx, dy);
      const outgoingX = length ? dx / length : 0, outgoingY = length ? dy / length : 0;
      const hasIncoming = incomingX !== 0 || incomingY !== 0;
      const ux = hasIncoming ? incomingX : outgoingX, uy = hasIncoming ? incomingY : outgoingY;
      const vx = length ? outgoingX : ux, vy = length ? outgoingY : uy;
      incomingX = outgoingX;
      incomingY = outgoingY;
      const bisector = Math.hypot(ux + vx, uy + vy);
      // Cap the miter on tight corners so the halo stays close to the contour.
      const scale = bisector > 0.1 ? Math.min(1.35, 2 / bisector) / bisector : 0;
      const nx = scale ? -(uy + vy) * scale : -vy;
      const ny = scale ? (ux + vx) * scale : vx;
      const k = base + i * 2;
      for (let side = 0; side < 2; side++) {
        const offset = (k + side) * FLOATS;
        const data = this.data;
        data[offset] = x; data[offset + 1] = y;
        data[offset + 2] = nx; data[offset + 3] = ny;
        data[offset + 4] = side ? 1 : -1; data[offset + 5] = width;
        data[offset + 6] = intensity; data[offset + 7] = blur;
        data[offset + 8] = rgb[0]; data[offset + 9] = rgb[1]; data[offset + 10] = rgb[2]; data[offset + 11] = fade;
      }
      if (i + 1 < n) {
        const j = this.indexCount, index = this.indices;
        index[j] = k; index[j + 1] = k + 1; index[j + 2] = k + 2;
        index[j + 3] = k + 1; index[j + 4] = k + 3; index[j + 5] = k + 2;
        this.indexCount += 6;
      }
    }
  }

  upload() {
    this.mesh.visible = this.indexCount > 0;
    if (!this.indexCount) return;
    this.geometry.indexCount = this.indexCount;
    this.vertices.update(this.vertexCount * FLOATS * 4);
    this.indexBuffer.update(this.indexCount * 4);
  }

  get bounds() {
    return { left: this.left, top: this.top, right: this.right, bottom: this.bottom };
  }

  destroy() { this.mesh.destroy(); this.geometry.destroy(true); }
}

export function strokeShader() {
  return new Shader({
    glProgram: GlProgram.from({ vertex, fragment, preferredFragmentPrecision: 'highp' }),
    resources: { strokeUniforms: { uPixelWidth: { value: 1, type: 'f32' } } },
  });
}
