import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';

import type { TableLayout } from '../render/render-model';
import {
  PineTableOverlayComponent,
  tablesUnder,
  type KeyedTable,
} from './pine-table-overlay.component';

// Signal inputs cannot be set under the JIT harness before the first render: the spec swaps the
// component's input signals for writable ones before detectChanges (as the other component specs do).

const table = (id: number, position: TableLayout['position'], key?: string): KeyedTable => ({
  id,
  ...(key ? { key } : {}),
  pane: 'main',
  position,
  columns: 1,
  rows: 1,
  bgColor: null,
  frameColor: null,
  frameWidth: 0,
  borderColor: null,
  borderWidth: 0,
  cells: [
    {
      key: `${id}:0:0`,
      row: 0,
      column: 0,
      rowSpan: 1,
      columnSpan: 1,
      text: `T${id}`,
      bgColor: null,
      textColor: 'rgb(0, 0, 0)',
      fontSize: 12,
      fontFamily: 'sans-serif',
      bold: false,
      italic: false,
      hAlign: 'center',
      vAlign: 'center',
      widthPct: 0,
      heightPct: 0,
      tooltip: null,
    },
  ],
});

function render(tables: KeyedTable[], topLeftOffset = 0) {
  TestBed.configureTestingModule({ imports: [PineTableOverlayComponent] });
  const fixture = TestBed.createComponent(PineTableOverlayComponent);
  const cmp = fixture.componentInstance as any;
  cmp.tables = signal(tables);
  cmp.paneWidth = signal(600);
  cmp.paneHeight = signal(400);
  cmp.pointer = signal(null);
  cmp.topLeftOffset = signal(topLeftOffset);
  fixture.detectChanges();
  return { fixture, host: fixture.nativeElement as HTMLElement, cmp };
}

describe('PineTableOverlayComponent (PC-I11)', () => {
  it('stacks tables that share an anchor instead of drawing one over the other', () => {
    // Two scripts' dashboards, both top_right, both with table id 1.
    const { host } = render([
      table(1, 'top_right', 'mine:1:1'),
      table(1, 'top_right', 'mine:2:1'),
      table(2, 'bottom_left'),
    ]);
    const groups = [...host.querySelectorAll('.pine-tables')];
    expect(groups.map((g) => g.getAttribute('data-position'))).toEqual(['top_right', 'bottom_left']);
    expect(
      [...groups[0].querySelectorAll('.pine-table')].map((t) => t.getAttribute('data-key')),
    ).toEqual(['mine:1:1', 'mine:2:1']);
  });

  it('keeps the top-left corner clear for what sits there (a status line, the legend)', () => {
    const { host } = render([table(1, 'top_left')], 22);
    const g = host.querySelector('.pine-tables[data-position="top_left"]') as HTMLElement;
    expect(g.style.top).toBe('26px');
  });

});

describe('tablesUnder (the table to fade)', () => {
  const rect = (left: number, top: number, w: number, h: number) => ({
    left,
    top,
    right: left + w,
    bottom: top + h,
  });

  it('finds the tables the pointer is over, in the overlay’s own px', () => {
    const tables = [
      { key: 'a', rect: rect(510, 110, 80, 40) },
      { key: 'b', rect: rect(510, 154, 80, 40) },
    ];
    const origin = { left: 10, top: 100 };
    expect([...tablesUnder({ x: 520, y: 20 }, origin, tables)]).toEqual(['a']);
    expect([...tablesUnder({ x: 520, y: 60 }, origin, tables)]).toEqual(['b']);
    expect(tablesUnder({ x: 100, y: 20 }, origin, tables).size).toBe(0);
    expect(tablesUnder(null, origin, tables).size).toBe(0);
  });
});
