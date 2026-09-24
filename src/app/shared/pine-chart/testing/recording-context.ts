/**
 * A CanvasRenderingContext2D stand-in that records what the painters draw, so paint logic is tested
 * as data ("a red path from (0,10) to (10,20) was stroked") instead of pixels. Text width is
 * approximated as 0.6 × font size per character.
 */

export type PathCmd =
  | { c: 'M'; x: number; y: number }
  | { c: 'L'; x: number; y: number }
  | { c: 'Z' }
  | { c: 'A'; x: number; y: number; r: number }
  | { c: 'B'; x: number; y: number }
  | { c: 'R'; x: number; y: number; w: number; h: number };

export type DrawOp =
  | { op: 'stroke'; style: string; width: number; dash: number[]; path: PathCmd[] }
  | { op: 'fill'; style: string | object; path: PathCmd[] }
  | { op: 'fillRect'; style: string | object; x: number; y: number; w: number; h: number }
  | { op: 'strokeRect'; style: string; x: number; y: number; w: number; h: number }
  | { op: 'fillText'; style: string | object; text: string; x: number; y: number; font: string }
  | { op: 'strokeText'; style: string; text: string; x: number; y: number };

export class RecordingContext {
  ops: DrawOp[] = [];
  strokeStyle: string | object = '#000';
  fillStyle: string | object = '#000';
  lineWidth = 1;
  lineCap = 'butt';
  lineJoin = 'miter';
  lineDashOffset = 0;
  font = '10px sans-serif';
  textAlign = 'start';
  textBaseline = 'alphabetic';
  globalAlpha = 1;
  private path: PathCmd[] = [];
  private dash: number[] = [];
  private stack: Array<Record<string, unknown>> = [];

  save(): void {
    this.stack.push({
      strokeStyle: this.strokeStyle,
      fillStyle: this.fillStyle,
      lineWidth: this.lineWidth,
      lineCap: this.lineCap,
      lineJoin: this.lineJoin,
      font: this.font,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline,
      dash: [...this.dash],
    });
  }

  restore(): void {
    const s = this.stack.pop();
    if (!s) return;
    this.strokeStyle = s['strokeStyle'] as string;
    this.fillStyle = s['fillStyle'] as string;
    this.lineWidth = s['lineWidth'] as number;
    this.lineCap = s['lineCap'] as string;
    this.lineJoin = s['lineJoin'] as string;
    this.font = s['font'] as string;
    this.textAlign = s['textAlign'] as string;
    this.textBaseline = s['textBaseline'] as string;
    this.dash = s['dash'] as number[];
  }

  setLineDash(d: number[]): void {
    this.dash = [...d];
  }

  getLineDash(): number[] {
    return [...this.dash];
  }

  beginPath(): void {
    this.path = [];
  }

  moveTo(x: number, y: number): void {
    this.path.push({ c: 'M', x, y });
  }

  lineTo(x: number, y: number): void {
    this.path.push({ c: 'L', x, y });
  }

  closePath(): void {
    this.path.push({ c: 'Z' });
  }

  arc(x: number, y: number, r: number): void {
    this.path.push({ c: 'A', x, y, r });
  }

  arcTo(_x1: number, _y1: number, x2: number, y2: number): void {
    this.path.push({ c: 'L', x: x2, y: y2 });
  }

  bezierCurveTo(_a: number, _b: number, _c: number, _d: number, x: number, y: number): void {
    this.path.push({ c: 'B', x, y });
  }

  rect(x: number, y: number, w: number, h: number): void {
    this.path.push({ c: 'R', x, y, w, h });
  }

  clip(): void {
    /* not recorded */
  }

  stroke(): void {
    this.ops.push({ op: 'stroke', style: String(this.strokeStyle), width: this.lineWidth, dash: [...this.dash], path: [...this.path] });
  }

  fill(): void {
    this.ops.push({ op: 'fill', style: this.fillStyle, path: [...this.path] });
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    this.ops.push({ op: 'fillRect', style: this.fillStyle, x, y, w, h });
  }

  strokeRect(x: number, y: number, w: number, h: number): void {
    this.ops.push({ op: 'strokeRect', style: String(this.strokeStyle), x, y, w, h });
  }

  fillText(text: string, x: number, y: number): void {
    this.ops.push({ op: 'fillText', style: this.fillStyle, text, x, y, font: this.font });
  }

  strokeText(text: string, x: number, y: number): void {
    this.ops.push({ op: 'strokeText', style: String(this.strokeStyle), text, x, y });
  }

  measureText(text: string): { width: number } {
    const m = /(\d+(?:\.\d+)?)px/.exec(this.font);
    const size = m ? +m[1] : 10;
    return { width: text.length * size * 0.6 };
  }

  createLinearGradient(x0: number, y0: number, x1: number, y1: number) {
    const stops: Array<[number, string]> = [];
    return { kind: 'gradient', x0, y0, x1, y1, stops, addColorStop: (o: number, c: string) => stops.push([o, c]) };
  }

  /** Typed as the real context for the painters. */
  asCtx(): CanvasRenderingContext2D {
    return this as unknown as CanvasRenderingContext2D;
  }

  strokes(style?: string): Extract<DrawOp, { op: 'stroke' }>[] {
    return this.ops.filter((o): o is Extract<DrawOp, { op: 'stroke' }> => o.op === 'stroke' && (style === undefined || o.style === style));
  }

  fills(style?: string): Extract<DrawOp, { op: 'fill' }>[] {
    return this.ops.filter((o): o is Extract<DrawOp, { op: 'fill' }> => o.op === 'fill' && (style === undefined || o.style === style));
  }

  rects(style?: string): Extract<DrawOp, { op: 'fillRect' }>[] {
    return this.ops.filter((o): o is Extract<DrawOp, { op: 'fillRect' }> => o.op === 'fillRect' && (style === undefined || o.style === style));
  }

  texts(): Extract<DrawOp, { op: 'fillText' }>[] {
    return this.ops.filter((o): o is Extract<DrawOp, { op: 'fillText' }> => o.op === 'fillText');
  }
}

/** Points (M/L) of a recorded path, as [x, y] pairs. */
export function pathPoints(path: readonly PathCmd[]): Array<[number, number]> {
  return path.filter((p): p is Extract<PathCmd, { c: 'M' | 'L' }> => p.c === 'M' || p.c === 'L').map((p) => [p.x, p.y]);
}
