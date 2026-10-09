import { afterEach, describe, expect, it } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';

import { declareSignalIo } from '@shared/testing/jit-signal-io';
import type { PineDebugRequest, PineDebugResult } from '../model/pine-outputs.types';
import { PineDebuggerPaneComponent } from './pine-debugger-pane.component';

declareSignalIo(PineDebuggerPaneComponent, {
  inputs: ['result', 'running', 'error', 'canRun', 'timezone'],
  outputs: ['run', 'barJump', 'traceBar'],
});

afterEach(() => TestBed.resetTestingModule());

const T = Date.UTC(2026, 8, 1, 10);

const result: PineDebugResult = {
  watches: ['fast - slow', 'crosses'],
  condition: 'ta.crossover(fast, slow)',
  hits: [
    { barIndex: 12, time: T, watches: ['0.0004', '1'] },
    { barIndex: 40, time: T + 28 * 3_600_000, watches: ['0.0001', '2'] },
  ],
  hitsTotal: 5,
  fromBar: 0,
  toBar: 99,
  stateBar: 12,
  stateTime: T,
  state: [
    { scope: 'global', name: 'crosses', type: 'int', kind: 'var', value: '1' },
    { scope: 'global', name: 'fast', type: 'float', kind: 'value', value: '1.1' },
    { scope: 'f(), call 1', name: 'acc', type: 'float', kind: 'var', value: '13' },
  ],
  runtimeError: null,
};

function create(inputs: Record<string, unknown>): ComponentFixture<PineDebuggerPaneComponent> {
  TestBed.configureTestingModule({ imports: [PineDebuggerPaneComponent] });
  const f = TestBed.createComponent(PineDebuggerPaneComponent);
  for (const [k, v] of Object.entries(inputs)) f.componentRef.setInput(k, v);
  f.detectChanges();
  return f;
}

const $ = (f: ComponentFixture<unknown>, sel: string) =>
  f.nativeElement.querySelector(sel) as HTMLElement | null;
const $$ = (f: ComponentFixture<unknown>, sel: string) =>
  [...f.nativeElement.querySelectorAll(sel)] as HTMLElement[];

function type(f: ComponentFixture<unknown>, sel: string, value: string): void {
  const input = $(f, sel) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input'));
  f.detectChanges();
}

describe('PineDebuggerPaneComponent (PR-I11)', () => {
  it('sends the watches and condition, and refuses an empty run in words', () => {
    const f = create({ result: null });
    const runs: PineDebugRequest[] = [];
    f.componentInstance.run.subscribe((r) => runs.push(r));
    expect(($(f, '[data-testid="dbg-run"]') as HTMLButtonElement).disabled).toBe(true);

    type(f, '[data-testid="dbg-watch-0"]', 'fast - slow');
    type(f, '[data-testid="dbg-condition"]', 'ta.crossover(fast, slow)');
    ($(f, 'form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    expect(runs).toEqual([
      {
        watches: ['fast - slow'],
        condition: 'ta.crossover(fast, slow)',
        fromBar: 0,
        toBar: null,
        maxHits: 200,
        stateAtBar: null,
      },
    ]);
  });

  it('lists the hits with their watches and the variables of the state bar', () => {
    const f = create({ result });
    expect($(f, '[data-testid="dbg-summary"]')!.textContent).toContain(
      '5 bars between bar 0 and bar 99 where ta.crossover(fast, slow) was true. The first 2 are listed.',
    );
    const hits = $$(f, '[data-testid="dbg-hit"]');
    expect(hits).toHaveLength(2);
    expect(hits[0].textContent).toContain('0.0004');
    expect(hits[0].classList.contains('active')).toBe(true);
    expect($(f, '[data-testid="dbg-state-title"]')!.textContent).toContain(
      'Variables after bar 12',
    );
    const vars = $$(f, '[data-testid="dbg-var"]').map((v) => v.textContent ?? '');
    expect(vars).toHaveLength(3);
    expect(vars[0]).toContain('crosses');
    expect(vars[0]).toContain('var');
    expect(f.nativeElement.textContent).toContain('f(), call 1');
  });

  it('a hit row moves the chart and reads the variables there with the last run’s request; Trace asks for the trace', () => {
    const f = create({ result: null });
    const runs: PineDebugRequest[] = [];
    const jumps: number[] = [];
    const traces: number[] = [];
    f.componentInstance.run.subscribe((r) => runs.push(r));
    f.componentInstance.barJump.subscribe((b) => jumps.push(b));
    f.componentInstance.traceBar.subscribe((b) => traces.push(b));
    type(f, '[data-testid="dbg-watch-0"]', 'fast');
    ($(f, 'form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    f.componentRef.setInput('result', result);
    f.detectChanges();

    $$(f, '[data-testid="dbg-hit"]')[1].click();
    expect(jumps).toEqual([40]);
    expect(runs[1]).toMatchObject({ watches: ['fast'], stateAtBar: 40 });

    ($$(f, '[data-testid="dbg-hit"]')[0].querySelector('button') as HTMLButtonElement).click();
    expect(traces).toEqual([12]);
    expect(jumps).toEqual([40]); // Trace does not also pick the row
  });

  it('shows the engine’s refusal', () => {
    const f = create({ result: null, error: "Watch 2: Undeclared identifier 'nope'." });
    expect($(f, '[data-testid="dbg-error"]')!.textContent).toContain(
      'Watch 2: Undeclared identifier',
    );
  });
});
