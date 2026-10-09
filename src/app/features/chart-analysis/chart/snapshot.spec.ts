import { describe, expect, it } from 'vitest';
import type { TableLayout } from '@shared/pine-chart/render/render-model';
import { placeTable, toCsv } from './snapshot';

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
