import { describe, expect, it } from 'vitest';
import type { TableLayout } from '@shared/pine-chart/render/render-model';
import { TABLE_EDGE, TABLE_GAP, placeTable, stackTables, toCsv } from './snapshot';

/** 7 px per character, whatever the font: geometry, not typography. */
const measure = (text: string) => text.length * 7;

const cell = (
  row: number,
  column: number,
  text: string,
  over: Partial<TableLayout['cells'][number]> = {},
) => ({
  key: `${row}:${column}`,
  row,
  column,
  rowSpan: 1,
  columnSpan: 1,
  text,
  bgColor: null,
  textColor: '#000',
  fontSize: 12,
  fontFamily: 'sans-serif',
  bold: false,
  italic: false,
  hAlign: 'center' as const,
  vAlign: 'center' as const,
  widthPct: 0,
  heightPct: 0,
  tooltip: null,
  ...over,
});

const table = (position: TableLayout['position'], cells: TableLayout['cells']): TableLayout => ({
  id: 1,
  pane: 'main',
  position,
  columns: 2,
  rows: 2,
  bgColor: '#fff',
  frameColor: null,
  frameWidth: 0,
  borderColor: '#ccc',
  borderWidth: 1,
  cells,
});

describe('snapshot — a script’s table drawn from its layout (CC-22)', () => {
  const cells = [cell(0, 0, 'Trend'), cell(0, 1, 'Up'), cell(1, 0, 'RSI'), cell(1, 1, '61.2')];

  it('sizes columns to their widest cell and rows to their tallest', () => {
    const t = placeTable(table('top_left', cells), 800, 400, measure);
    // "Trend" 35 px + 8 padding; "61.2" 28 + 8.
    expect(t.w).toBe(43 + 36);
    expect(t.cells.find((c) => c.text === '61.2')).toMatchObject({ x: 6 + 43, w: 36 });
    expect(t.cells.find((c) => c.text === 'RSI')!.y).toBeCloseTo(6 + 12 * 1.25 + 4, 9);
  });

  it('places the table at its Pine position in the pane', () => {
    const tr = placeTable(table('top_right', cells), 800, 400, measure);
    expect(tr.x + tr.w).toBe(800 - 6);
    expect(tr.y).toBe(6);
    const bc = placeTable(table('bottom_center', cells), 800, 400, measure);
    expect(bc.x).toBeCloseTo((800 - bc.w) / 2, 9);
    expect(bc.y + bc.h).toBeCloseTo(400 - 6, 9);
  });

  it('spans a merged cell across its columns', () => {
    const t = placeTable(
      table('top_left', [
        cell(0, 0, 'Header', { columnSpan: 2 }),
        cell(1, 0, 'a'),
        cell(1, 1, 'bbbbbbbbbb'),
      ]),
      800,
      400,
      measure,
    );
    const header = t.cells.find((c) => c.text === 'Header')!;
    expect(header.w).toBe(t.w);
  });
});

describe('snapshot — tables laid out as the chart shows them (pine-chart follow-up)', () => {
  const two = [cell(0, 0, 'Trend'), cell(0, 1, 'Up'), cell(1, 0, 'RSI'), cell(1, 1, '61.2')];
  const wide = [cell(0, 0, 'A much wider heading'), cell(0, 1, 'x')];

  it('stacks tables at one anchor one under the other instead of on top of each other', () => {
    const a = placeTable(table('top_right', two), 800, 400, measure);
    const b = placeTable(table('top_right', wide), 800, 400, measure);
    const [sa, sb] = stackTables([a, b], ['top_right', 'top_right'], 800, 400);
    expect(sa.y).toBe(TABLE_EDGE);
    expect(sb.y).toBe(TABLE_EDGE + a.h + TABLE_GAP);
    // Right-aligned in the stack, each against the pane's right edge.
    expect(sa.x + sa.w).toBe(800 - TABLE_EDGE);
    expect(sb.x + sb.w).toBe(800 - TABLE_EDGE);
    // The cells moved with their table.
    expect(sb.cells[0].y).toBe(sb.y);
  });

  it('starts the top-left stack below the legend and lifts a bottom stack off the edge', () => {
    const t = placeTable(table('top_left', two), 800, 400, measure);
    const [tl] = stackTables([t], ['top_left'], 800, 400, 30);
    expect(tl).toMatchObject({ x: TABLE_EDGE, y: TABLE_EDGE + 30 });
    const u = placeTable(table('bottom_center', two), 800, 400, measure);
    const v = placeTable(table('bottom_center', wide), 800, 400, measure);
    const [bu, bv] = stackTables([u, v], ['bottom_center', 'bottom_center'], 800, 400);
    expect(bv.y + bv.h).toBeCloseTo(400 - TABLE_EDGE, 9);
    expect(bu.y + bu.h + TABLE_GAP).toBeCloseTo(bv.y, 9);
    expect(bu.x + bu.w / 2).toBeCloseTo(400, 9);
  });
});

describe('toCsv (CC-I7)', () => {
  it('quotes what needs quoting and leaves empty fields for missing values', () => {
    expect(
      toCsv([
        ['time', 'open', 'note'],
        ['2026-10-09T00:00:00Z', 1.1, 'a, "b"'],
        ['x', null, NaN],
      ]),
    ).toBe('time,open,note\r\n2026-10-09T00:00:00Z,1.1,"a, ""b"""\r\nx,,\r\n');
  });
});
