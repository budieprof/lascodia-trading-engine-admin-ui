import { heatColor } from '../heatmap-grid';
import type { HeatFolder } from './heat-texture';

/**
 * The GPU side of the event-level heatmap, behind an interface so the chart code (and its tests) never touch WebGL:
 * {@link HeatSurface} owns an OFFSCREEN WebGL2 canvas holding the folded grid as an R32F texture plus a 256-entry
 * colour LUT, and paints quads (one per linear run of the time axis × price slab) at the chart's size. The chart's
 * primitive then `drawImage`s that canvas inside `drawBackground`, so the heatmap stays BEHIND the candles exactly like
 * the canvas-2D layer it replaces. Colour = LUT(log1p(size) / log1p(robustMax)) in the fragment shader.
 */

/** One quad: screen x span ↔ texture column span, and screen y span ↔ texture row span. */
export interface HeatQuad {
  x0: number;
  x1: number;
  /** Texture column coordinates (0..cols) at x0 and x1. */
  c0: number;
  c1: number;
  /** Screen y of row coordinate r0 and r1 (rows 0..rows, row r centred at r + 0.5). */
  y0: number;
  y1: number;
  r0: number;
  r1: number;
}

export interface HeatDrawParams {
  /** Media (CSS) px of the pane and the device pixel ratio. */
  width: number;
  height: number;
  dpr: number;
  quads: readonly HeatQuad[];
  robustMax: number;
  opacity: number;
}

export interface HeatSurface {
  /** The canvas to `drawImage` from (media size × dpr). */
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  /** Upload the folder's grid: all of it when it is a new folder, else only the dirty columns. */
  sync(folder: HeatFolder): void;
  draw(p: HeatDrawParams): void;
  dispose(): void;
}

const VS = `#version 300 es
in vec2 aPos;
in vec2 aTex;
uniform vec2 uSize;
out vec2 vTex;
void main() {
  vTex = aTex;
  vec2 clip = vec2(aPos.x / uSize.x * 2.0 - 1.0, 1.0 - aPos.y / uSize.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
uniform sampler2D uGrid;
uniform sampler2D uLut;
uniform vec2 uGridSize;
uniform float uLogMax;
uniform float uOpacity;
in vec2 vTex;
out vec4 outColor;
void main() {
  // vTex.x = row coordinate (price), vTex.y = column coordinate (time); the grid texture is rows wide, cols high.
  ivec2 cell = ivec2(floor(vTex.x), floor(vTex.y));
  if (cell.x < 0 || cell.y < 0 || cell.x >= int(uGridSize.x) || cell.y >= int(uGridSize.y)) discard;
  float v = texelFetch(uGrid, cell, 0).r;
  if (v <= 0.0) discard;
  float i = clamp(log(1.0 + v) / uLogMax, 0.0, 1.0);
  vec4 c = texture(uLut, vec2(i * (255.0 / 256.0) + 0.5 / 256.0, 0.5));
  float a = c.a * uOpacity;
  outColor = vec4(c.rgb * a, a);
}`;

/** The LUT as RGBA bytes (the canvas-2D layer's ramp, so both paths look the same). */
export function heatLutBytes(): Uint8Array {
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const m = /rgba\((\d+),(\d+),(\d+),([\d.]+)\)/.exec(heatColor(i / 255));
    if (!m) continue;
    out[i * 4] = Number(m[1]);
    out[i * 4 + 1] = Number(m[2]);
    out[i * 4 + 2] = Number(m[3]);
    out[i * 4 + 3] = Math.round(Number(m[4]) * 255);
  }
  return out;
}

/** Vertex data for quads: per vertex (x, y, row, col), two triangles each. */
export function quadVertices(quads: readonly HeatQuad[]): Float32Array {
  const out = new Float32Array(quads.length * 6 * 4);
  let o = 0;
  const put = (x: number, y: number, r: number, c: number) => {
    out[o++] = x;
    out[o++] = y;
    out[o++] = r;
    out[o++] = c;
  };
  for (const q of quads) {
    put(q.x0, q.y0, q.r0, q.c0);
    put(q.x1, q.y0, q.r0, q.c1);
    put(q.x0, q.y1, q.r1, q.c0);
    put(q.x1, q.y0, q.r0, q.c1);
    put(q.x1, q.y1, q.r1, q.c1);
    put(q.x0, q.y1, q.r1, q.c0);
  }
  return out;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    gl.deleteShader(s);
    return null;
  }
  return s;
}

/**
 * A WebGL2 surface, or null where WebGL2 is not available (jsdom, old GPUs, a lost context) — the caller then keeps
 * the canvas-2D bucket heatmap.
 */
export function createWebGlHeatSurface(doc: Document | null = typeof document !== 'undefined' ? document : null): HeatSurface | null {
  if (!doc) return null;
  let canvas: HTMLCanvasElement;
  let gl: WebGL2RenderingContext | null = null;
  try {
    canvas = doc.createElement('canvas');
    gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: true });
  } catch {
    return null;
  }
  if (!gl) return null;
  const vs = compile(gl, gl.VERTEX_SHADER, VS);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FS);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  return new WebGlHeatSurface(canvas, gl, prog);
}

class WebGlHeatSurface implements HeatSurface {
  private readonly grid: WebGLTexture;
  private readonly lut: WebGLTexture;
  private readonly vbo: WebGLBuffer;
  private readonly vao: WebGLVertexArrayObject;
  private readonly loc: {
    size: WebGLUniformLocation | null;
    gridSize: WebGLUniformLocation | null;
    logMax: WebGLUniformLocation | null;
    opacity: WebGLUniformLocation | null;
    grid: WebGLUniformLocation | null;
    lut: WebGLUniformLocation | null;
  };
  private folder: HeatFolder | null = null;
  private gridDims = { rows: 0, cols: 0 };
  private lost = false;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGL2RenderingContext,
    private readonly prog: WebGLProgram,
  ) {
    this.grid = gl.createTexture()!;
    this.lut = gl.createTexture()!;
    this.vbo = gl.createBuffer()!;
    this.vao = gl.createVertexArray()!;
    canvas.addEventListener('webglcontextlost', () => (this.lost = true));
    this.loc = {
      size: gl.getUniformLocation(prog, 'uSize'),
      gridSize: gl.getUniformLocation(prog, 'uGridSize'),
      logMax: gl.getUniformLocation(prog, 'uLogMax'),
      opacity: gl.getUniformLocation(prog, 'uOpacity'),
      grid: gl.getUniformLocation(prog, 'uGrid'),
      lut: gl.getUniformLocation(prog, 'uLut'),
    };
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    const aTex = gl.getAttribLocation(prog, 'aTex');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(aTex);
    gl.vertexAttribPointer(aTex, 2, gl.FLOAT, false, 16, 8);
    gl.bindVertexArray(null);

    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, heatLutBytes());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  sync(folder: HeatFolder): void {
    if (this.lost) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.grid);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const { rows, cols } = folder.spec;
    if (folder !== this.folder || this.gridDims.rows !== rows || this.gridDims.cols !== cols) {
      this.folder = folder;
      this.gridDims = { rows, cols };
      folder.takeDirty();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, rows, cols, 0, gl.RED, gl.FLOAT, folder.data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return;
    }
    const d = folder.takeDirty();
    if (!d) return;
    const n = d.to - d.from + 1;
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, d.from, rows, n, gl.RED, gl.FLOAT, folder.data.subarray(d.from * rows, (d.to + 1) * rows));
  }

  draw(p: HeatDrawParams): void {
    if (this.lost) return;
    const gl = this.gl;
    const w = Math.max(1, Math.round(p.width * p.dpr));
    const h = Math.max(1, Math.round(p.height * p.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.folder || p.quads.length === 0 || !(p.robustMax > 0)) return;
    gl.useProgram(this.prog);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform2f(this.loc.size, p.width, p.height);
    gl.uniform2f(this.loc.gridSize, this.gridDims.rows, this.gridDims.cols);
    gl.uniform1f(this.loc.logMax, Math.log1p(p.robustMax));
    gl.uniform1f(this.loc.opacity, p.opacity);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.grid);
    gl.uniform1i(this.loc.grid, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.uniform1i(this.loc.lut, 1);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, quadVertices(p.quads), gl.STREAM_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, p.quads.length * 6);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteTexture(this.grid);
    gl.deleteTexture(this.lut);
    gl.deleteBuffer(this.vbo);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.prog);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

/** A surface that records what it was asked to do (tests and environments without WebGL that still want the model). */
export class FakeHeatSurface implements HeatSurface {
  readonly canvas = { width: 0, height: 0 } as unknown as HTMLCanvasElement;
  uploads: { full: boolean; from: number; to: number }[] = [];
  draws: HeatDrawParams[] = [];
  private folder: HeatFolder | null = null;
  disposed = false;

  sync(folder: HeatFolder): void {
    if (folder !== this.folder) {
      this.folder = folder;
      folder.takeDirty();
      this.uploads.push({ full: true, from: 0, to: folder.spec.cols - 1 });
      return;
    }
    const d = folder.takeDirty();
    if (d) this.uploads.push({ full: false, ...d });
  }
  draw(p: HeatDrawParams): void {
    this.draws.push(p);
  }
  dispose(): void {
    this.disposed = true;
  }
}
