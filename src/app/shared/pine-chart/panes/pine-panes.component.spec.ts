import { afterEach, describe, expect, it } from 'vitest';
import type { Type } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { PineLogOutput, PineTraceBar } from '../model/pine-outputs.types';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { PineLogsPaneComponent, type PineLineJump } from './pine-logs-pane.component';
import { PineProfilerPaneComponent } from './pine-profiler-pane.component';
import { PineTracePaneComponent } from './pine-trace-pane.component';

declareSignalIo(PineLogsPaneComponent, {
  inputs: ['logs', 'droppedLogs', 'runtimeError', 'timezone'],
  outputs: ['barJump', 'lineJump'],
});
declareSignalIo(PineTracePaneComponent, {
  inputs: ['trace', 'bar', 'timezone', 'windowSize'],
  outputs: ['barChange', 'lineJump', 'requestTrace'],
});
declareSignalIo(PineProfilerPaneComponent, {
  inputs: ['profile', 'source', 'elapsedMs'],
  outputs: ['lineJump'],
});

afterEach(() => TestBed.resetTestingModule());

function create<T>(type: Type<T>, inputs: Record<string, unknown>): ComponentFixture<T> {
  TestBed.configureTestingModule({ imports: [type] });
  const f = TestBed.createComponent(type);
  for (const [k, v] of Object.entries(inputs)) f.componentRef.setInput(k, v);
  f.detectChanges();
  return f;
}

const $ = (f: ComponentFixture<unknown>, sel: string) =>
  f.nativeElement.querySelector(sel) as HTMLElement | null;
const $$ = (f: ComponentFixture<unknown>, sel: string) =>
  [...f.nativeElement.querySelectorAll(sel)] as HTMLElement[];

const T = Date.UTC(2026, 8, 1);
const logs: PineLogOutput[] = [
  {
    level: 'info',
    message: 'close=1.1 fast=1.09',
    barIndex: 3,
    time: T,
    isRealtime: false,
    line: 20,
  },
  {
    level: 'warning',
    message: 'Wide bar\nrange 0.004',
    barIndex: 7,
    time: T + 3_600_000,
    isRealtime: false,
  },
  {
    level: 'error',
    message: 'Order rejected',
    barIndex: 9,
    time: T + 7_200_000,
    isRealtime: false,
  },
];

describe('PineLogsPaneComponent', () => {
  it('lists every log with its level, ISO time and first line', () => {
    const f = create(PineLogsPaneComponent, { logs });
    const rows = $$(f, '.row');
    expect(rows.map((r) => r.className.match(/info|warning|error/)?.[0])).toEqual([
      'info',
      'warning',
      'error',
    ]);
    expect(rows[0].querySelector('.time')?.textContent).toBe('2026-09-01T00:00:00.000+00:00');
    expect(rows[1].querySelector('.message')?.textContent).toContain('Wide bar');
    expect(rows[1].querySelector('.more')).not.toBeNull();
    expect($(f, '.summary')?.textContent).toContain('3 of 3');
  });

  it('filters by level and highlights search matches', () => {
    const f = create(PineLogsPaneComponent, { logs });
    ($$(f, '.level input')[0] as HTMLInputElement).dispatchEvent(new Event('change'));
    f.detectChanges();
    expect($$(f, '.row')).toHaveLength(2);
    const search = $(f, 'input[type=search]') as HTMLInputElement;
    search.value = 'order';
    search.dispatchEvent(new Event('input'));
    f.detectChanges();
    expect($$(f, '.row')).toHaveLength(1);
    expect($(f, '.row mark')?.textContent).toBe('Order');
  });

  it('jumps to the bar and to the source line of a log', () => {
    const f = create(PineLogsPaneComponent, { logs });
    const bars: number[] = [];
    const lines: PineLineJump[] = [];
    f.componentInstance.barJump.subscribe((b) => bars.push(b));
    f.componentInstance.lineJump.subscribe((l) => lines.push(l));
    const first = $$(f, '.row')[0];
    const [barBtn, lineBtn] = [...first.querySelectorAll('.actions button')] as HTMLButtonElement[];
    barBtn.click();
    lineBtn.click();
    expect(bars).toEqual([3]);
    expect(lines).toEqual([{ line: 20 }]);
    // No line reported → no "source code" action.
    expect($$(f, '.row')[1].querySelectorAll('.actions button')).toHaveLength(1);
  });

  it('shows a runtime error banner with its line and bar', () => {
    const f = create(PineLogsPaneComponent, {
      logs: [],
      runtimeError: {
        code: 'PS5003',
        message: 'Division by zero',
        line: 12,
        column: 5,
        barIndex: 400,
      },
    });
    const lines: PineLineJump[] = [];
    const bars: number[] = [];
    f.componentInstance.lineJump.subscribe((l) => lines.push(l));
    f.componentInstance.barJump.subscribe((b) => bars.push(b));
    const banner = $(f, '.runtime-error')!;
    expect(banner.textContent).toContain('PS5003');
    const [lineBtn, barBtn] = [...banner.querySelectorAll('button')] as HTMLButtonElement[];
    lineBtn.click();
    barBtn.click();
    expect(lines).toEqual([{ line: 12, column: 5 }]);
    expect(bars).toEqual([400]);
    expect($(f, '.empty')?.textContent).toContain('No logs');
  });
});

describe('PineTracePaneComponent', () => {
  const trace: PineTraceBar[] = [100, 101, 102].map((bar) => ({
    bar,
    timeMs: T + bar * 3_600_000,
    items: [
      {
        line: 9,
        column: 6,
        endLine: 9,
        endColumn: 30,
        text: 'ta.crossover(fast, slow)',
        value: bar === 101 ? 'true' : 'false',
      },
    ],
  }));

  it('shows the picked bar and steps to the next traced bar', () => {
    const f = create(PineTracePaneComponent, { trace, bar: 101 });
    expect($(f, '.val')?.textContent).toBe('true');
    expect($(f, '.val')?.className).toContain('true');
    expect($(f, '.prev')?.textContent).toBe('false');
    const changes: number[] = [];
    f.componentInstance.barChange.subscribe((b) => changes.push(b));
    ($(f, 'button[title^="Next"]') as HTMLButtonElement).click();
    f.detectChanges();
    expect(changes).toEqual([102]);
    expect($(f, '.val')?.className).toContain('false');
  });

  it('jumps the editor to an expression', () => {
    const f = create(PineTracePaneComponent, { trace, bar: 101 });
    const lines: PineLineJump[] = [];
    f.componentInstance.lineJump.subscribe((l) => lines.push(l));
    ($(f, '.tr') as HTMLElement).click();
    expect(lines).toEqual([{ line: 9, column: 6 }]);
  });

  it('asks for a trace window around a bar outside the traced bars', () => {
    const g = create(PineTracePaneComponent, { trace, bar: 500, windowSize: 50 });
    const windows: Array<{ fromBar: number; toBar: number }> = [];
    g.componentInstance.requestTrace.subscribe((w) => windows.push(w));
    expect($(g, '.note')?.textContent).toContain('outside the traced window');
    ($(g, '.note button') as HTMLButtonElement).click();
    expect(windows).toEqual([{ fromBar: 475, toBar: 524 }]);
  });
});

describe('PineProfilerPaneComponent', () => {
  const profile = [
    { line: 3, executions: 500, totalMicros: 2100 },
    { line: 4, executions: 500, totalMicros: 760 },
    { line: 5, executions: 500, totalMicros: 1400 },
    { line: 6, executions: 20, totalMicros: 520 },
  ];

  it('lists lines by time with heat bars and flames on the top three', () => {
    const f = create(PineProfilerPaneComponent, {
      profile,
      source: 'a\nb\nr = ta.rsi(close, 14)\nd\ne\nf',
    });
    const rows = $$(f, '.tr');
    expect(rows.map((r) => r.querySelector('.num')?.textContent?.trim())).toEqual([
      '3',
      '5',
      '4',
      '6',
    ]);
    expect($$(f, '.flame')).toHaveLength(3);
    expect(rows[0].querySelector('.code')?.textContent).toBe('r = ta.rsi(close, 14)');
    expect(rows[0].querySelector('.pct-text')?.textContent).toBe('43.9%');
  });

  it('sorts by a column and jumps to a line', () => {
    const f = create(PineProfilerPaneComponent, { profile });
    const lineHeader = $$(f, '.head button').find((b) => b.textContent?.includes('Line'))!;
    lineHeader.click();
    f.detectChanges();
    expect($$(f, '.tr').map((r) => r.querySelector('.num')?.textContent?.trim())).toEqual([
      '3',
      '4',
      '5',
      '6',
    ]);
    const lines: PineLineJump[] = [];
    f.componentInstance.lineJump.subscribe((l) => lines.push(l));
    $$(f, '.tr')[3].click();
    expect(lines).toEqual([{ line: 6 }]);
  });
});
