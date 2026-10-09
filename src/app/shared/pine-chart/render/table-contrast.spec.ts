import { describe, expect, it } from 'vitest';
import type { TableCellLayout, TableLayout } from './render-model';
import { contrastRatio, over, readableTable, readableText } from './table-contrast';

const cell = (over: Partial<TableCellLayout>): TableCellLayout => ({
  key: 'k',
  row: 0,
  column: 0,
  rowSpan: 1,
  columnSpan: 1,
  text: 'SHORT',
  bgColor: null,
  textColor: 'rgb(255, 255, 255)',
  fontSize: 12,
  fontFamily: 'sans-serif',
  bold: false,
  italic: false,
  hAlign: 'center',
  vAlign: 'center',
  widthPct: 0,
  heightPct: 0,
  tooltip: null,
  ...over,
});

const table = (cells: TableCellLayout[], bgColor: string | null = null): TableLayout => ({
  id: 1,
  pane: 'main',
  position: 'top_right',
  columns: 1,
  rows: 1,
  bgColor,
  frameColor: null,
  frameWidth: 0,
  borderColor: null,
  borderWidth: 0,
  cells,
});

describe('readable tables (PC-I11, PC-02)', () => {
  it('white text on a translucent grey over a white chart (~1.3:1) turns dark', () => {
    const t = readableTable(
      table([cell({ bgColor: 'rgba(120, 123, 134, 0.3)' })]),
      '#FFFFFF',
    );
    expect(t.cells[0].textColor).toBe('rgb(19, 23, 34)');
  });

  it('keeps text that reads, and the same table object when nothing changed', () => {
    const t = table([cell({ bgColor: 'rgb(9, 13, 22)' })]);
    expect(readableTable(t, '#FFFFFF')).toBe(t);
  });

  it('reads the cell over the table over the chart: the same text is fine on a dark chart', () => {
    const translucent = table([cell({ bgColor: 'rgba(120, 123, 134, 0.3)' })]);
    expect(readableTable(translucent, '#0F0F0F').cells[0].textColor).toBe('rgb(255, 255, 255)');
    // A dark table background under a transparent cell keeps white text readable on a white chart.
    const onDarkTable = table([cell({})], 'rgb(9, 13, 22)');
    expect(readableTable(onDarkTable, '#FFFFFF')).toBe(onDarkTable);
  });

  it('leaves text the script made transparent hidden, and empty cells alone', () => {
    expect(readableText('transparent', { r: 255, g: 255, b: 255, a: 1 })).toBe('transparent');
    const t = table([cell({ text: '', bgColor: 'rgba(120,123,134,0.3)' })]);
    expect(readableTable(t, '#FFFFFF')).toBe(t);
  });

  it('measures contrast as WCAG does', () => {
    const white = { r: 255, g: 255, b: 255, a: 1 };
    const black = { r: 0, g: 0, b: 0, a: 1 };
    expect(contrastRatio(white, black)).toBeCloseTo(21, 0);
    expect(over({ r: 0, g: 0, b: 0, a: 0.5 }, white)).toMatchObject({ r: 127.5, a: 1 });
  });
});
