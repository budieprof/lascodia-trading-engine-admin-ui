import type { TableLayout } from '@shared/pine-chart/render/render-model';

/**
 * What a chart snapshot and a data export carry beyond the canvas (CC-22, CC-I7): the title, the
 * legend, the scripts' tables (HTML over the chart, so drawn here from their layout) — and the
 * chart's data as CSV. The geometry and the CSV are pure; the painting takes a 2D context.
 */

/** A table's cells placed in a box (px), from its layout. */
export interface PlacedCell {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  bg: string | null;
  color: string;
  font: string;
  align: 'left' | 'center' | 'right';
}

export interface PlacedTable {
  x: number;
  y: number;
  w: number;
  h: number;
  bg: string | null;
  frameColor: string | null;
  frameWidth: number;
  borderColor: string | null;
  borderWidth: number;
  cells: PlacedCell[];
}

const PAD_X = 4;
const PAD_Y = 2;
const MARGIN = 6;

/**
 * Lay a script's table out in a pane of `width` × `height` at its Pine position (top_left …
 * bottom_right): columns as wide as their widest single-column cell, rows as tall as their tallest,
 * spanned cells across their columns and rows. `measure` gives a text's width in a CSS font.
 */
export function placeTable(
  table: TableLayout,
  width: number,
  height: number,
  measure: (text: string, font: string) => number,
): PlacedTable {
  const colW = new Array(table.columns).fill(0);
  const rowH = new Array(table.rows).fill(0);
  const fontOf = (c: TableLayout['cells'][number]) =>
    `${c.italic ? 'italic ' : ''}${c.bold ? 'bold ' : ''}${c.fontSize}px ${c.fontFamily || 'sans-serif'}`;
  for (const c of table.cells) {
    const lines = c.text.split('\n');
    const w =
      c.widthPct > 0
        ? (c.widthPct / 100) * width
        : Math.max(...lines.map((l) => measure(l, fontOf(c)))) + 2 * PAD_X;
    const h =
      c.heightPct > 0 ? (c.heightPct / 100) * height : lines.length * c.fontSize * 1.25 + 2 * PAD_Y;
    if (c.columnSpan <= 1 && c.column < table.columns) colW[c.column] = Math.max(colW[c.column], w);
    if (c.rowSpan <= 1 && c.row < table.rows) rowH[c.row] = Math.max(rowH[c.row], h);
  }
  const total = (sizes: number[]) => sizes.reduce((a, b) => a + b, 0);
  const w = total(colW);
  const h = total(rowH);
  const pos = String(table.position);
  const x = pos.endsWith('right')
    ? width - w - MARGIN
    : pos.endsWith('center')
      ? (width - w) / 2
      : MARGIN;
  const y = pos.startsWith('bottom')
    ? height - h - MARGIN
    : pos.startsWith('middle')
      ? (height - h) / 2
      : MARGIN;
  const offset = (sizes: number[], i: number) => total(sizes.slice(0, i));
  const cells: PlacedCell[] = table.cells.map((c) => ({
    x: x + offset(colW, c.column),
    y: y + offset(rowH, c.row),
    w: total(colW.slice(c.column, c.column + Math.max(1, c.columnSpan))),
    h: total(rowH.slice(c.row, c.row + Math.max(1, c.rowSpan))),
    text: c.text,
    bg: c.bgColor,
    color: c.textColor,
    font: fontOf(c),
    align: String(c.hAlign).includes('left')
      ? 'left'
      : String(c.hAlign).includes('right')
        ? 'right'
        : 'center',
  }));
  return {
    x,
    y,
    w,
    h,
    bg: table.bgColor,
    frameColor: table.frameColor,
    frameWidth: table.frameWidth,
    borderColor: table.borderColor,
    borderWidth: table.borderWidth,
    cells,
  };
}

/** Paint a placed table at an offset (the pane's position on the snapshot). */
export function paintTable(
  ctx: CanvasRenderingContext2D,
  t: PlacedTable,
  dx: number,
  dy: number,
): void {
  ctx.save();
  ctx.translate(dx, dy);
  if (t.bg) {
    ctx.fillStyle = t.bg;
    ctx.fillRect(t.x, t.y, t.w, t.h);
  }
  ctx.textBaseline = 'middle';
  for (const c of t.cells) {
    if (c.bg) {
      ctx.fillStyle = c.bg;
      ctx.fillRect(c.x, c.y, c.w, c.h);
    }
    if (t.borderColor && t.borderWidth > 0) {
      ctx.strokeStyle = t.borderColor;
      ctx.lineWidth = t.borderWidth;
      ctx.strokeRect(c.x, c.y, c.w, c.h);
    }
    ctx.fillStyle = c.color;
    ctx.font = c.font;
    ctx.textAlign = c.align;
    const tx =
      c.align === 'left' ? c.x + PAD_X : c.align === 'right' ? c.x + c.w - PAD_X : c.x + c.w / 2;
    const lines = c.text.split('\n');
    const lineH = c.h / Math.max(1, lines.length);
    lines.forEach((line, i) => ctx.fillText(line, tx, c.y + lineH * (i + 0.5)));
  }
  if (t.frameColor && t.frameWidth > 0) {
    ctx.strokeStyle = t.frameColor;
    ctx.lineWidth = t.frameWidth;
    ctx.strokeRect(t.x, t.y, t.w, t.h);
  }
  ctx.restore();
}

/** One run of legend text in its colour. */
export interface LegendRun {
  text: string;
  color: string;
}

/** Paint legend lines (runs left to right) from (x, y), one line per entry. Returns the height used. */
export function paintLegend(
  ctx: CanvasRenderingContext2D,
  lines: readonly LegendRun[][],
  x: number,
  y: number,
  font: string,
  lineHeight: number,
): number {
  ctx.save();
  ctx.font = font;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  lines.forEach((runs, i) => {
    let cx = x;
    for (const run of runs) {
      ctx.fillStyle = run.color;
      ctx.fillText(run.text, cx, y + i * lineHeight);
      cx += ctx.measureText(run.text).width + 6;
    }
  });
  ctx.restore();
  return lines.length * lineHeight;
}

/** RFC 4180 CSV: fields with a comma, quote or line break are quoted, quotes doubled. */
export function toCsv(rows: readonly (readonly (string | number | null | undefined)[])[]): string {
  const field = (v: string | number | null | undefined) => {
    if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(field).join(',')).join('\r\n') + '\r\n';
}
