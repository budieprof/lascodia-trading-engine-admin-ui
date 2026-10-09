import type { PaintCtx } from '../paint-ctx';
import type { Pt } from '../geometry';
import type { Drawing } from '../model';
import type { ToolBehavior } from './types';
import { TV_BLUE, fillLines, fontOf, inRect, layoutText, measurerFor, num, str, type Rect, type TextLayout } from './text-layout';

/**
 * Table tool. Cells live in `drawing.options.cells` as `string[][]` (row-major,
 * row 0 = header). `rows`/`cols` options resize the grid; missing cells read as ''.
 */

type P = PaintCtx & { options: Record<string, unknown> };

export const TABLE_DEFAULT_ROWS = 3;
export const TABLE_DEFAULT_COLS = 3;
const MIN_CELL_W = 48;
const PAD_X = 8;
const PAD_Y = 5;

export function tableCells(options: Record<string, unknown>): string[][] {
  const rows = Math.max(1, Math.round(num(options['rows'], TABLE_DEFAULT_ROWS)));
  const cols = Math.max(1, Math.round(num(options['cols'], TABLE_DEFAULT_COLS)));
  const raw = Array.isArray(options['cells']) ? (options['cells'] as unknown[]) : [];
  const out: string[][] = [];
  for (let r = 0; r < rows; r++) {
    const row = Array.isArray(raw[r]) ? (raw[r] as unknown[]) : [];
    out.push(Array.from({ length: cols }, (_, c) => (typeof row[c] === 'string' ? (row[c] as string) : '')));
  }
  return out;
}

/** Immutable cell update for inline editing: returns the new options object. */
export function setTableCell(drawing: Drawing, row: number, col: number, value: string): Record<string, unknown> {
  const options = { ...(drawing.options ?? {}) };
  const cells = tableCells(options).map((r) => [...r]);
  if (cells[row] && col < cells[row].length) cells[row][col] = value;
  return { ...options, cells };
}

export interface TableLayout {
  cells: string[][];
  colX: number[];
  colW: number[];
  rowY: number[];
  rowH: number[];
  bounds: Rect;
  layouts: TextLayout[][];
}

export function layoutTable(p: P): TableLayout {
  const s = p.drawing.style;
  const at = p.pts[0];
  const cells = tableCells(p.options);
  const bodyFont = fontOf(s);
  const headFont = fontOf({ ...s, bold: true });
  const layouts = cells.map((row, r) =>
    row.map((t) => {
      const font = r === 0 ? headFont : bodyFont;
      return layoutText(measurerFor(p.ctx, font, s.fontSize), t, s.fontSize, font, { padX: PAD_X, padY: PAD_Y });
    }),
  );
  const cols = cells[0].length;
  const colW = Array.from({ length: cols }, (_, c) => Math.max(MIN_CELL_W, ...layouts.map((row) => row[c].width)));
  const rowH = layouts.map((row) => Math.max(...row.map((l) => l.height)));
  const colX: number[] = [];
  let x = at.x;
  for (const w of colW) {
    colX.push(x);
    x += w;
  }
  const rowY: number[] = [];
  let y = at.y;
  for (const h of rowH) {
    rowY.push(y);
    y += h;
  }
  return { cells, colX, colW, rowY, rowH, layouts, bounds: { x: at.x, y: at.y, w: x - at.x, h: y - at.y } };
}

/** Which cell a screen point lands in (for double-click-to-edit), or null. */
export function tableCellAt(t: TableLayout, at: Pt): { row: number; col: number; rect: Rect } | null {
  for (let r = 0; r < t.rowY.length; r++)
    for (let c = 0; c < t.colX.length; c++) {
      const rect = { x: t.colX[c], y: t.rowY[r], w: t.colW[c], h: t.rowH[r] };
      if (inRect(at, rect)) return { row: r, col: c, rect };
    }
  return null;
}

export const TABLE_BEHAVIOR: ToolBehavior = {
  points: 1,
  // Double-click a cell to edit it in place.
  editAt: (p, at) => {
    const cell = tableCellAt(layoutTable(p), at);
    if (!cell) return null;
    const value = tableCells(optionsOfTable(p))[cell.row]?.[cell.col] ?? '';
    return {
      rect: { x: cell.rect.x, y: cell.rect.y, w: cell.rect.w, h: cell.rect.h },
      value,
      commit: (v) => ({ options: setTableCell(p.drawing, cell.row, cell.col, v) }),
    };
  },
  defaultStyle: { fontSize: 14, color: '#434651', textColor: '#131722', text: '' },
  options: [
    { key: 'rows', label: 'Rows', type: 'number', default: TABLE_DEFAULT_ROWS, min: 1, max: 30, step: 1, tab: 'style' },
    { key: 'cols', label: 'Columns', type: 'number', default: TABLE_DEFAULT_COLS, min: 1, max: 20, step: 1, tab: 'style' },
    { key: 'backgroundColor', label: 'Background', type: 'color', default: '#FFFFFF', tab: 'style' },
    { key: 'headerColor', label: 'Header background', type: 'color', default: TV_BLUE, tab: 'style' },
    { key: 'headerTextColor', label: 'Header text', type: 'color', default: '#FFFFFF', tab: 'text' },
    { key: 'borderColor', label: 'Border', type: 'color', default: '#B2B5BE', tab: 'style' },
  ],
  paint: (p) => {
    if (!p.pts.length) return;
    const { ctx } = p;
    const t = layoutTable(p);
    const o = p.options;
    ctx.save();
    ctx.setLineDash([]);
    ctx.fillStyle = str(o['backgroundColor'], '#FFFFFF');
    ctx.fillRect(t.bounds.x, t.bounds.y, t.bounds.w, t.bounds.h);
    ctx.fillStyle = str(o['headerColor'], TV_BLUE);
    ctx.fillRect(t.bounds.x, t.rowY[0], t.bounds.w, t.rowH[0]);
    ctx.strokeStyle = str(o['borderColor'], '#B2B5BE');
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const y of [...t.rowY, t.bounds.y + t.bounds.h]) {
      ctx.moveTo(t.bounds.x, Math.round(y) + 0.5);
      ctx.lineTo(t.bounds.x + t.bounds.w, Math.round(y) + 0.5);
    }
    for (const x of [...t.colX, t.bounds.x + t.bounds.w]) {
      ctx.moveTo(Math.round(x) + 0.5, t.bounds.y);
      ctx.lineTo(Math.round(x) + 0.5, t.bounds.y + t.bounds.h);
    }
    ctx.stroke();
    const body = p.drawing.style.textColor ?? '#131722';
    const head = str(o['headerTextColor'], '#FFFFFF');
    t.layouts.forEach((row, r) =>
      row.forEach((l, c) =>
        fillLines(ctx, l, { x: t.colX[c], y: t.rowY[r], w: t.colW[c], h: t.rowH[r] }, r === 0 ? head : body, 'left'),
      ),
    );
    ctx.restore();
  },
  hitTest: (p, at, tol) => !!p.pts.length && inRect(at, layoutTable(p).bounds, tol),
};

function optionsOfTable(p: { options: Record<string, unknown> }): Record<string, unknown> {
  return p.options;
}
