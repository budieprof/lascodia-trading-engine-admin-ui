import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';

import type { TableLayout } from '../render/render-model';
import {
  PineTableOverlayComponent,
  placeCellTip,
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
    expect(groups.map((g) => g.getAttribute('data-position'))).toEqual([
      'top_right',
      'bottom_left',
    ]);
    expect(
      [...groups[0].querySelectorAll('.pine-table')].map((t) => t.getAttribute('data-key')),
    ).toEqual(['mine:1:1', 'mine:2:1']);
  });

  it('keeps the top-left corner clear for what sits there (a status line, the legend)', () => {
    const { host } = render([table(1, 'top_left')], 22);
    const g = host.querySelector('.pine-tables[data-position="top_left"]') as HTMLElement;
    expect(g.style.top).toBe('26px');
  });

  it('shows a cell tooltip on hover, keeps its table from fading, and closes it on leave', () => {
    const t = table(1, 'top_right', 'k1');
    t.cells[0] = { ...t.cells[0], tooltip: 'Line one\nLine two' };
    const { fixture, host, cmp } = render([t]);
    // The pointer is over the table: it would fade.
    cmp.faded.set(new Set(['k1']));
    const cell = host.querySelector('.cell.has-tip') as HTMLElement;
    expect(cell.getAttribute('title')).toBeNull(); // no second, native tooltip
    cell.dispatchEvent(new MouseEvent('mouseenter', { clientX: 20, clientY: 20 }));
    fixture.detectChanges();
    const tip = host.querySelector('.cell-tip') as HTMLElement;
    expect(tip.textContent?.trim()).toBe('Line one\nLine two');
    expect(host.querySelector('.pine-table')!.classList).not.toContain('faded');
    cell.dispatchEvent(new MouseEvent('mouseleave'));
    fixture.detectChanges();
    expect(host.querySelector('.cell-tip')).toBeNull();
    expect(host.querySelector('.pine-table')!.classList).toContain('faded');
  });

  it('opens a cell tooltip on a tap and keeps it until the same cell is tapped again', () => {
    const t = table(1, 'top_right', 'k1');
    t.cells[0] = { ...t.cells[0], tooltip: 'Tip' };
    const { fixture, host } = render([t]);
    const cell = host.querySelector('.cell.has-tip') as HTMLElement;
    cell.dispatchEvent(new MouseEvent('click', { clientX: 5, clientY: 5 }));
    cell.dispatchEvent(new MouseEvent('mouseleave'));
    fixture.detectChanges();
    expect(host.querySelector('.cell-tip')).not.toBeNull();
    cell.dispatchEvent(new MouseEvent('click', { clientX: 5, clientY: 5 }));
    fixture.detectChanges();
    expect(host.querySelector('.cell-tip')).toBeNull();
  });

  it('opens a cell tooltip on keyboard focus and closes it on Escape', () => {
    const t = table(1, 'top_right', 'k1');
    t.cells[0] = { ...t.cells[0], tooltip: 'Tip' };
    const { fixture, host } = render([t]);
    const cell = host.querySelector('.cell.has-tip') as HTMLElement;
    expect(cell.getAttribute('tabindex')).toBe('0');
    cell.dispatchEvent(new FocusEvent('focus'));
    fixture.detectChanges();
    expect(host.querySelector('.cell-tip')?.textContent?.trim()).toBe('Tip');
    cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(host.querySelector('.cell-tip')).toBeNull();
  });

  it('a cell without a tooltip opens nothing', () => {
    const { fixture, host } = render([table(1, 'top_right')]);
    const cell = host.querySelector('.cell') as HTMLElement;
    cell.dispatchEvent(new MouseEvent('click'));
    cell.dispatchEvent(new MouseEvent('mouseenter'));
    fixture.detectChanges();
    expect(host.querySelector('.cell-tip')).toBeNull();
  });
});

describe('placeCellTip', () => {
  it('opens toward the free side near the right and bottom edges', () => {
    expect(placeCellTip(100, 50, 1200, 800)).toEqual({
      left: 114,
      top: 64,
      flipX: false,
      flipY: false,
    });
    expect(placeCellTip(1150, 50, 1200, 800)).toEqual({
      left: 1136,
      top: 64,
      flipX: true,
      flipY: false,
    });
    expect(placeCellTip(1150, 790, 1200, 800)).toEqual({
      left: 1136,
      top: 776,
      flipX: true,
      flipY: true,
    });
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
