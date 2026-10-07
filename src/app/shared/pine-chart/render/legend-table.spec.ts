import { describe, expect, it } from 'vitest';
import { normalizeRunResult } from '../model/normalize';
import type { PineBar } from '../model/pine-outputs.types';
import {
  PINE,
  cell,
  emptyOutputs,
  marker,
  paneIndicatorFixture,
  plot,
} from '../testing/pine-fixtures';
import { buildRenderModel, buildTableLayout } from './build-render-model';
import { dataWindowAt, legendLogical, statusLines } from './legend';
import { tableView } from './table-view';

const bars: PineBar[] = Array.from({ length: 6 }, (_, i) => ({
  t: Date.UTC(2026, 0, 5, i),
  o: 1,
  h: 2,
  l: 0.5,
  c: 1 + i / 10,
  v: 1500,
}));
const times = bars.map((b) => b.t);

function model() {
  const out = emptyOutputs(times);
  out.plots.push(
    plot({
      id: 0,
      title: 'Fast',
      values: [1, 2, 3, null, 5, 6],
      colors: [PINE.red, PINE.red, PINE.blue, null, PINE.blue, PINE.blue],
      color: null,
      precision: 1,
    }),
    plot({ id: 1, title: 'Hidden', values: [1, 1, 1, 1, 1, 1], display: ['data_window'] }),
    plot({
      id: 3,
      title: 'Pct',
      values: [10, 20, 30, 40, 50, 60],
      format: 'percent',
      precision: 0,
    }),
  );
  out.markers.push(
    marker({
      id: 2,
      title: 'Sig',
      points: [{ barIndex: 4, time: times[4], value: 1, color: PINE.teal }],
    }),
  );
  return buildRenderModel(
    {
      bars,
      outputs: out,
      report: null,
      declaration: {
        kind: 'indicator',
        title: 'Test',
        overlay: true,
        format: null,
        precision: null,
      },
    },
    { pricePrecision: 5 },
  );
}

describe('status line', () => {
  it('shows each output with a status-line flag at the hovered bar, in its color, in id order', () => {
    const m = model();
    const [main] = statusLines(m, 2);
    // No marker is drawn on bar 2, so the marker stays out of the status line there.
    expect(main.values.map((v) => v.title)).toEqual(['Fast', 'Pct']);
    expect(main.values[0]).toMatchObject({ text: '3.0', color: 'rgb(41, 98, 255)' });
    expect(main.values[1].text).toBe('30%');
  });

  it('shows ∅ for na and the marker value where it is drawn', () => {
    const [main] = statusLines(model(), 3);
    expect(main.values[0].text).toBe('∅');
    const at4 = statusLines(model(), 4)[0].values;
    expect(at4.map((v) => v.title)).toEqual(['Fast', 'Sig', 'Pct']);
    expect(at4[1]).toMatchObject({ text: '1.00000', color: 'rgb(8, 153, 129)' });
  });

  it('rests on the last bar when nothing is hovered', () => {
    expect(legendLogical(model(), null)).toBe(5);
    expect(legendLogical(model(), 2.4)).toBe(2);
  });
});

describe('data window', () => {
  it('lists the bar, then every output shown in the data window', () => {
    const [bar, script] = dataWindowAt(model(), 1);
    expect(bar.rows.map((r) => r.label)).toEqual([
      'Date',
      'Time',
      'Open',
      'High',
      'Low',
      'Close',
      'Change',
      'Volume',
    ]);
    expect(bar.rows.find((r) => r.label === 'Close')?.value).toBe('1.10000');
    expect(bar.rows.find((r) => r.label === 'Change')?.value).toBe('10.00%');
    expect(bar.rows.find((r) => r.label === 'Volume')?.value).toBe('1.5K');
    expect(script.title).toBe('Test');
    expect(script.rows.map((r) => r.label)).toEqual(['Fast', 'Hidden', 'Sig', 'Pct']);
  });

  it('shows plotbar/plotcandle as four rows', () => {
    const run = normalizeRunResult(paneIndicatorFixture(80))!;
    const m = buildRenderModel({
      bars: run.bars,
      outputs: run.outputs,
      report: null,
      declaration: run.compile!.declaration,
    });
    const script = dataWindowAt(m, 60)[1];
    expect(script.rows.map((r) => r.label)).toEqual(
      expect.arrayContaining([
        'RSI bars (open)',
        'RSI bars (high)',
        'RSI bars (low)',
        'RSI bars (close)',
      ]),
    );
    // display: ["status_line"] only → not in the data window.
    expect(script.rows.map((r) => r.label)).not.toContain('Status only');
  });
});

describe('tableView', () => {
  const layout = buildTableLayout(
    {
      id: 1,
      position: 'middle_right',
      columns: 3,
      rows: 2,
      bgColor: '#FFFFFFFF',
      frameColor: '#000000FF',
      frameWidth: 2,
      borderColor: '#888888FF',
      borderWidth: 1,
      forceOverlay: false,
      cells: [
        cell({
          column: 0,
          row: 0,
          columnSpan: 2,
          text: 'merged',
          bold: true,
          bgColor: '#FF0000FF',
          textHAlign: 'left',
          textVAlign: 'top',
        }),
        cell({
          column: 2,
          row: 1,
          text: 'w',
          width: 25,
          height: 10,
          tooltip: 'tip',
          italic: true,
          fontFamily: 'monospace',
        }),
      ],
    },
    'main',
  )!;

  it('lays out every uncovered grid position, merged cells spanning tracks', () => {
    const v = tableView(layout, 800, 400);
    expect(v.containerStyle['grid-template-columns']).toBe('repeat(3, auto)');
    expect(v.containerStyle['border']).toBe('2px solid rgb(0, 0, 0)');
    // 3×2 = 6 positions, one covered by the merge → 5 cells (3 of them empty placeholders).
    expect(v.cells.length).toBe(5);
    const merged = v.cells[0];
    expect(merged.style).toMatchObject({
      'grid-column': '1 / span 2',
      'grid-row': '1 / span 1',
      'font-weight': '700',
      background: 'rgb(255, 0, 0)',
      'justify-content': 'flex-start',
      'align-items': 'flex-start',
    });
  });

  it('draws inner borders only, resolves % sizes against the pane, and keeps tooltips', () => {
    const v = tableView(layout, 800, 400);
    const last = v.cells.find((c) => c.text === 'w')!;
    expect(last.style['border-right']).toBeUndefined();
    expect(last.style['border-bottom']).toBeUndefined();
    expect(last.style).toMatchObject({ width: '200px', height: '40px', 'font-style': 'italic' });
    expect(last.style['font-family']).toContain('monospace');
    expect(last.tooltip).toBe('tip');
    expect(v.cells[0].style['border-right']).toBe('1px solid rgb(136, 136, 136)');
    expect(v.cells[0].style['border-bottom']).toBe('1px solid rgb(136, 136, 136)');
  });
});

describe('tableView — rows and columns with no cells collapse, as on TradingView', () => {
  /** A 2 × 14 dashboard (`table.new(pos, 2, 14)`) with `filled` rows of key/value cells. */
  function dashboard(filled: number) {
    return buildTableLayout(
      {
        id: 7,
        position: 'top_right',
        columns: 2,
        rows: 14,
        bgColor: '#0F172AEB',
        frameColor: '#1E293BFF',
        frameWidth: 1,
        borderColor: '#1E293BFF',
        borderWidth: 1,
        forceOverlay: false,
        cells: Array.from({ length: filled }, (_, row) => [
          cell({ column: 0, row, text: `key ${row}` }),
          cell({ column: 1, row, text: `value ${row}` }),
        ]).flat(),
      },
      'main',
    )!;
  }

  it('draws only the rows that hold cells — no blank bands for the rows it reserved', () => {
    const v = tableView(dashboard(8), 800, 400);
    expect(v.containerStyle['grid-template-rows']).toBe('repeat(8, auto)');
    expect(v.containerStyle['grid-template-columns']).toBe('repeat(2, auto)');
    expect(v.cells.length).toBe(16);
    expect(v.cells.map((c) => c.text).slice(-2)).toEqual(['key 7', 'value 7']);
    // The last row drawn is the bottom of the table: no border under it.
    const bottom = v.cells.slice(-2);
    expect(bottom.every((c) => c.style['border-bottom'] === undefined)).toBe(true);
    expect(v.cells[0].style['border-bottom']).toBe('1px solid rgb(30, 41, 59)');
  });

  it('closes up gaps, renumbering the grid tracks, and keeps empty cells inside used tracks', () => {
    const layout = buildTableLayout(
      {
        id: 3,
        position: 'bottom_left',
        columns: 4,
        rows: 6,
        bgColor: null,
        frameColor: null,
        frameWidth: 0,
        borderColor: '#888888FF',
        borderWidth: 1,
        forceOverlay: false,
        cells: [
          cell({ column: 0, row: 1, text: 'a' }),
          cell({ column: 3, row: 1, text: 'b' }),
          cell({ column: 3, row: 4, text: 'c' }),
        ],
      },
      'main',
    )!;
    const v = tableView(layout, 800, 400);
    // Rows 1 and 4, columns 0 and 3: a 2 × 2 grid, the (row 4, column 0) position an empty cell.
    expect(v.containerStyle['grid-template-rows']).toBe('repeat(2, auto)');
    expect(v.containerStyle['grid-template-columns']).toBe('repeat(2, auto)');
    expect(v.cells.map((c) => [c.text, c.style['grid-row'], c.style['grid-column']])).toEqual([
      ['a', '1 / span 1', '1 / span 1'],
      ['b', '1 / span 1', '2 / span 1'],
      ['', '2 / span 1', '1 / span 1'],
      ['c', '2 / span 1', '2 / span 1'],
    ]);
    const c = v.cells[3];
    expect(c.style['border-right']).toBeUndefined();
    expect(c.style['border-bottom']).toBeUndefined();
    expect(v.cells[0].style['border-right']).toBe('1px solid rgb(136, 136, 136)');
  });

  it('keeps every row and column a merged cell spans, counting only kept tracks', () => {
    const layout = buildTableLayout(
      {
        id: 4,
        position: 'top_left',
        columns: 3,
        rows: 5,
        bgColor: null,
        frameColor: null,
        frameWidth: 0,
        borderColor: null,
        borderWidth: 0,
        forceOverlay: false,
        cells: [
          // Rows 0–2 merged in column 0; column 2 has cells in rows 0 and 4 only.
          cell({ column: 0, row: 0, rowSpan: 3, text: 'merged' }),
          cell({ column: 2, row: 0, text: 'x' }),
          cell({ column: 2, row: 4, text: 'y' }),
        ],
      },
      'main',
    )!;
    const v = tableView(layout, 800, 400);
    // Rows 0, 1, 2 (the merge) and 4; row 3 collapses. Column 1 collapses.
    expect(v.containerStyle['grid-template-rows']).toBe('repeat(4, auto)');
    expect(v.containerStyle['grid-template-columns']).toBe('repeat(2, auto)');
    const merged = v.cells.find((c) => c.text === 'merged')!;
    expect(merged.style['grid-row']).toBe('1 / span 3');
    const y = v.cells.find((c) => c.text === 'y')!;
    expect(y.style['grid-row']).toBe('4 / span 1');
    expect(y.style['grid-column']).toBe('2 / span 1');
  });

  it('draws nothing for a table with no cells', () => {
    const v = tableView(dashboard(0), 800, 400);
    expect(v.cells).toEqual([]);
  });
});
