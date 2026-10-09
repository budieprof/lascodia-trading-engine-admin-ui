import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { declareSignalIo } from '@shared/testing/jit-signal-io';

import { FirstStrategyChecklistComponent } from './first-strategy-checklist.component';
import type { ChecklistAction } from './first-strategy-checklist';
import { markPreviewed } from './previewed-scripts';
import { ExampleGalleryComponent } from './example-gallery.component';
import { STRATEGY_EXAMPLES, type StrategyExample } from './strategy-examples';

declareSignalIo(FirstStrategyChecklistComponent, {
  inputs: ['strategy', 'backtests', 'canOperate', 'canStartPaper'],
  outputs: ['actionRequested'],
});
declareSignalIo(ExampleGalleryComponent, {
  inputs: ['examples'],
  outputs: ['picked', 'closed'],
});

const BASE = 'http://test/api/v1/lascodia-trading-engine';
const SOURCE = '//@version=6\nstrategy("S")\n';
const ok = <T>(data: T) => ({ data, status: true, message: 'Successful', responseCode: '00' });

describe('FirstStrategyChecklistComponent (PE-I9)', () => {
  let fixture: ComponentFixture<FirstStrategyChecklistComponent>;
  let http: HttpTestingController;
  let el: HTMLElement;
  let actions: ChecklistAction[];

  function render(
    strategy: Record<string, unknown>,
    opts: { backtests?: number | null; canStartPaper?: boolean } = {},
  ): void {
    fixture = TestBed.createComponent(FirstStrategyChecklistComponent);
    fixture.componentRef.setInput('strategy', {
      id: 41,
      scriptSource: SOURCE,
      lifecycleStage: 'Draft',
      ...strategy,
    });
    fixture.componentRef.setInput('backtests', opts.backtests ?? 0);
    fixture.componentRef.setInput('canStartPaper', opts.canStartPaper ?? true);
    actions = [];
    fixture.componentInstance.actionRequested.subscribe((a) => actions.push(a));
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  }

  function flushBindings(bindings: unknown[], accounts: unknown[]): void {
    http.expectOne(`${BASE}/strategy/41/account-bindings`).flush(ok(bindings));
    http
      .expectOne((r) => r.url === `${BASE}/trading-account/list`)
      .flush(ok({ pager: { totalItemCount: accounts.length }, data: accounts }));
    fixture.detectChanges();
  }

  const state = (id: string) =>
    el.querySelector(`[data-step="${id}"]`)?.getAttribute('data-state') ?? null;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      imports: [FirstStrategyChecklistComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('ticks what the console can see and offers the next step', () => {
    markPreviewed(SOURCE);
    render({}, { backtests: 0 });
    expect(state('demo')).toBe('unknown');
    flushBindings(
      [{ tradingAccountId: 27, accountName: 'Real', lotMultiplier: 1, isEnabled: true }],
      [{ id: 27, accountType: 'Real', isPaper: false, accountName: 'Real' }],
    );
    expect(state('compile')).toBe('done');
    expect(state('preview')).toBe('done');
    expect(state('backtest')).toBe('todo');
    // A REAL binding is not the demo step.
    expect(state('demo')).toBe('todo');
    expect(el.textContent).toContain('2 of 5 done');
    const next = el.querySelector<HTMLButtonElement>('[data-step="backtest"] .btn')!;
    expect(next.textContent).toContain('Go to Backtests');
    next.click();
    expect(actions).toEqual(['backtests']);
  });

  it('counts an enabled demo binding', () => {
    render({ lifecycleStage: 'PaperTrading' }, { backtests: 3 });
    flushBindings(
      [{ tradingAccountId: 17, accountName: 'Demo', lotMultiplier: 1, isEnabled: true }],
      [{ id: 17, accountType: 'Demo', isPaper: false, accountName: 'Demo' }],
    );
    expect(state('paper')).toBe('done');
    expect(state('demo')).toBe('done');
  });

  it('offers paper trading only when it can be started', () => {
    markPreviewed(SOURCE);
    render({}, { backtests: 1, canStartPaper: false });
    flushBindings([], []);
    expect(el.querySelector('[data-step="paper"] .btn')).toBeNull();
  });

  it('hides once every step is done, past paper trading, or when hidden', () => {
    render({ lifecycleStage: 'Approved' });
    flushBindings([], []);
    expect(el.querySelector('[data-testid="first-strategy-checklist"]')).toBeNull();

    fixture.componentRef.setInput('strategy', {
      id: 41,
      scriptSource: SOURCE,
      lifecycleStage: 'Draft',
    });
    fixture.detectChanges();
    flushBindings([], []);
    el.querySelector<HTMLButtonElement>('.head .btn')!.click();
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="first-strategy-checklist"]')).toBeNull();
    // Remembered for this strategy.
    render({});
    flushBindings([], []);
    expect(el.querySelector('[data-testid="first-strategy-checklist"]')).toBeNull();
  });
});

describe('ExampleGalleryComponent (PE-I9)', () => {
  it('lists every example and hands the picked one over', () => {
    TestBed.configureTestingModule({ imports: [ExampleGalleryComponent] });
    const fixture = TestBed.createComponent(ExampleGalleryComponent);
    const picked: StrategyExample[] = [];
    fixture.componentInstance.picked.subscribe((e) => picked.push(e));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const cards = el.querySelectorAll('[data-example]');
    expect(cards).toHaveLength(STRATEGY_EXAMPLES.length);
    expect(el.querySelector('[data-example="rsi-reversion"]')!.textContent).toContain(
      'lascodia/classic',
    );
    el.querySelector<HTMLButtonElement>('[data-example="donchian-breakout"] .btn')!.click();
    expect(picked.map((e) => e.id)).toEqual(['donchian-breakout']);
  });
});
