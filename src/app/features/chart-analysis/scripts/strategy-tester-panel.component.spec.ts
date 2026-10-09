import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Component, Input, signal, type WritableSignal } from '@angular/core';
import { provideRouter, RouterLink } from '@angular/router';
import { of } from 'rxjs';

import type { ScriptInputDto, ScriptInputValues } from '@core/api/scripting.types';
import { ScriptStrategyService } from '@features/scripting/api/script-strategy.service';
import { withSavedDefaults } from '@features/scripting/pine/pine-inputs';
import { StrategyTesterPanelComponent } from './strategy-tester-panel.component';

// Signal inputs cannot be set under the JIT harness before the first render, so the spec swaps the
// component's input signals for writable ones before detectChanges (as the settings-dialog spec does),
// and the children whose signal inputs JIT cannot bind (the icon, the strategy report) are stood in
// for by decorator-input stubs.

@Component({ selector: 'app-chart-icon', template: '' })
class ChartIconStubComponent {
  @Input() name = '';
  @Input() size = 0;
}

@Component({ selector: 'app-strategy-report', template: '' })
class StrategyReportStubComponent {
  @Input() report: unknown = null;
  @Input() heading: string | null = null;
  @Input() hideTabs: readonly string[] = [];
}

/** The engine's backtest queue, as the tester's "Deep backtest…" calls it. */
const queueBacktest = vi.fn((_req: unknown) => of({ status: true, responseCode: '00', data: 4321 }));

/** TestBed for the panel: its children stubbed, the backtest queue faked, a router for its links. */
function setup(): ComponentFixture<StrategyTesterPanelComponent> {
  TestBed.configureTestingModule({
    imports: [StrategyTesterPanelComponent],
    providers: [
      provideRouter([]),
      { provide: ScriptStrategyService, useValue: { queueBacktest } },
    ],
  });
  TestBed.overrideComponent(StrategyTesterPanelComponent, {
    set: { imports: [ChartIconStubComponent, StrategyReportStubComponent, RouterLink] },
  });
  return TestBed.createComponent(StrategyTesterPanelComponent);
}

// An engine strategy whose stored inputs differ from its source: Length 20 in the source and 30
// stored, "Use stop" on in the source and off stored. Every run applies the stored values beneath
// the chart's overrides, so they — not the source's — are what "no override" runs with.
const SOURCE: ScriptInputDto[] = [
  {
    id: 'Main::Length',
    kind: 'int',
    title: 'Length',
    defaultValue: 20,
    minValue: 1,
    maxValue: 500,
  },
  { id: 'Risk::Use stop', kind: 'bool', title: 'Use stop', defaultValue: true },
  { id: 'Display::Colour', kind: 'bool', title: 'Colour', defaultValue: true, display: 'none' },
];
const STORED: ScriptInputValues = { 'Main::Length': 30, 'Risk::Use stop': false };
/** The inputs as the page hands them over (`ScriptSettings.inputsOf`). */
const EFFECTIVE = withSavedDefaults(SOURCE, STORED);

describe('StrategyTesterPanelComponent — Inputs against the defaults the strategy runs on', () => {
  let fixture: ComponentFixture<StrategyTesterPanelComponent>;
  let host: HTMLElement;
  let inputs: WritableSignal<readonly ScriptInputDto[] | null>;
  let rerun: Mock<(values: ScriptInputValues) => void>;

  function render(list: readonly ScriptInputDto[] | null, values: ScriptInputValues = {}): void {
    fixture = setup();
    const cmp = fixture.componentInstance as any;
    inputs = signal(list);
    cmp.result = signal({ title: 'MeanRev v5', inputs: SOURCE, strategy: null, error: null });
    cmp.inputs = inputs;
    cmp.values = signal(values);
    cmp.running = signal(false);
    cmp.resolution = signal('60');
    rerun = vi.fn<(values: ScriptInputValues) => void>();
    cmp.rerun.subscribe(rerun);
    fixture.detectChanges();
    cmp.tab.set('inputs');
    fixture.detectChanges();
    host = fixture.nativeElement;
  }

  afterEach(() => TestBed.resetTestingModule());

  const field = (title: string): HTMLInputElement =>
    [...host.querySelectorAll('label.field')]
      .find((l) => l.querySelector('span')?.textContent?.trim() === title)!
      .querySelector('input')!;
  const edit = (title: string, value: string | boolean) => {
    const el = field(title);
    if (typeof value === 'boolean') el.checked = value;
    else el.value = value;
    el.dispatchEvent(new Event('change'));
    fixture.detectChanges();
  };
  const rerunNow = () => {
    host.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    fixture.detectChanges();
  };

  it('shows the values the strategy runs with: the stored inputs where the chart sets none', () => {
    render(EFFECTIVE);
    expect(field('Length').value).toBe('30');
    expect(field('Use stop').checked).toBe(false);
  });

  it('an input set back to its SOURCE default is sent: left out, the stored value would win', () => {
    render(EFFECTIVE);
    edit('Length', '20');
    edit('Use stop', true);
    rerunNow();
    expect(rerun).toHaveBeenCalledWith({ 'Main::Length': 20, 'Risk::Use stop': true });
  });

  it('a value equal to the stored input is no override — the engine applies it beneath anyway', () => {
    render(EFFECTIVE, { 'Main::Length': 25 });
    expect(field('Length').value).toBe('25');
    edit('Length', '30');
    rerunNow();
    expect(rerun).toHaveBeenCalledWith({});
  });

  it('keeps the override of an input the form does not show (display.none), set in Settings', () => {
    render(EFFECTIVE, { 'Display::Colour': false });
    edit('Length', '40');
    rerunNow();
    expect(rerun).toHaveBeenCalledWith({ 'Main::Length': 40, 'Display::Colour': false });
  });

  it('Defaults goes back to the strategy’s stored inputs: nothing to override', () => {
    render(EFFECTIVE, { 'Main::Length': 25 });
    [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Defaults')!.click();
    fixture.detectChanges();
    expect(field('Length').value).toBe('30');
    rerunNow();
    expect(rerun).toHaveBeenCalledWith({});
  });

  it('a script with no stored inputs measures against its source defaults, as before', () => {
    render(SOURCE);
    edit('Length', '20');
    rerunNow();
    expect(rerun).toHaveBeenLastCalledWith({});
    edit('Length', '25');
    rerunNow();
    expect(rerun).toHaveBeenLastCalledWith({ 'Main::Length': 25 });
  });

  it('waits for an engine strategy’s stored inputs before showing the form', () => {
    render(null);
    expect(host.querySelector('form')).toBeNull();
    expect(host.textContent).toContain('Loading the strategy');
    inputs.set(EFFECTIVE);
    fixture.detectChanges();
    expect(field('Length').value).toBe('30');
  });

  it('the browser’s own validation never blocks Re-run: a Pine step is no constraint', () => {
    // MeanRev v5's exhaustion input: input.float(1.0, minval = 0.05) comes with step 1, and 1 is
    // no whole number of steps above 0.05 — the browser refused the form and Re-run did nothing.
    render([
      ...EFFECTIVE,
      {
        id: 'Exits::Exhaustion',
        kind: 'float',
        title: 'Exhaustion',
        defaultValue: 1,
        minValue: 0.05,
        maxValue: 1,
        step: 1,
      },
    ]);
    edit('Length', '20');
    [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Re-run')!.click();
    expect(rerun).toHaveBeenCalledWith({ 'Main::Length': 20 });
  });
});


describe('StrategyTesterPanelComponent — Bar Replay (PC-08)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('holds the report back while its run reaches past the replay head; the inputs stay', () => {
    const fixture = setup();
    const cmp = fixture.componentInstance as any;
    const suspended = signal<string | null>('Running to the replay head…');
    cmp.result = signal({ title: 'MeanRev v5', inputs: SOURCE, strategy: null, error: null });
    cmp.inputs = signal(EFFECTIVE);
    cmp.values = signal({});
    cmp.running = signal(false);
    cmp.resolution = signal('60');
    cmp.suspended = suspended;
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const note = () => host.querySelector('[data-testid="tester-suspended"]');

    expect(note()?.textContent?.trim()).toBe('Running to the replay head…');
    expect(host.textContent).not.toContain('No strategy report');
    // The Inputs tab is the operator's, not the run's: it stays usable.
    cmp.tab.set('inputs');
    fixture.detectChanges();
    expect(note()).toBeNull();
    expect(host.querySelector('form')).not.toBeNull();
    // The run to the head landed.
    cmp.tab.set('report');
    suspended.set(null);
    fixture.detectChanges();
    expect(note()).toBeNull();
    expect(host.textContent).toContain('No strategy report');
  });
});

describe('StrategyTesterPanelComponent — report, List of trades, deep backtest (PC-I5, PC-12)', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    queueBacktest.mockClear();
  });

  const H = 3600;
  const T0 = Date.UTC(2026, 8, 1) / 1000;
  /** 300 closed trades of a USDJPY strategy (three decimals), one an hour. */
  const TRADES = Array.from({ length: 300 }, (_, i) => ({
    number: i + 1,
    side: i % 2 ? ('short' as const) : ('long' as const),
    isOpen: false,
    entryTime: T0 + i * H,
    entryPrice: 147.1234567,
    entrySignal: 'L',
    exitTime: T0 + i * H + H / 2,
    exitPrice: 147.2,
    exitSignal: 'TP',
    qty: 1000,
    profit: 76.5,
    profitPercent: 0.08,
    cumulativeProfit: 76.5 * (i + 1),
  }));
  const REPORT = { meta: { symbol: 'USDJPY' }, trades: [] };
  const RESULT = {
    title: 'MeanRev v5',
    kind: 'strategy',
    inputs: [],
    error: null,
    run: null,
    strategy: {
      trades: TRADES,
      metrics: { currency: 'USD' },
      equity: [],
      report: REPORT,
      warnings: ['A strategy.risk rule halted trading.'],
    },
  };

  function render(patch: Record<string, unknown> = {}) {
    const fixture = setup();
    const cmp = fixture.componentInstance as any;
    cmp.result = signal(RESULT);
    cmp.inputs = signal([]);
    cmp.values = signal({ 'Main::Length': 30 });
    cmp.running = signal(false);
    cmp.resolution = signal('60');
    cmp.precision = signal(3);
    for (const [k, v] of Object.entries(patch)) cmp[k] = v;
    const focus = vi.fn();
    cmp.tradeFocus.subscribe(focus);
    fixture.detectChanges();
    return { fixture, cmp, host: fixture.nativeElement as HTMLElement, focus };
  }

  it('opens on the report — the console’s strategy report, its own List of trades left out', () => {
    const { fixture } = render();
    const stub = fixture.debugElement.query((de) => de.name === 'app-strategy-report')
      ?.componentInstance as StrategyReportStubComponent;
    expect(stub.report).toBe(REPORT);
    expect(stub.hideTabs).toEqual(['trades']);
  });

  it('says the report has warnings, and takes the operator to them', () => {
    const { host, cmp, fixture } = render();
    cmp.tab.set('inputs');
    fixture.detectChanges();
    const warn = host.querySelector('[data-testid="tester-warnings"]') as HTMLButtonElement;
    expect(warn.textContent).toContain('1 warning');
    warn.click();
    expect(cmp.tab()).toBe('report');
  });

  it('lists the trades in a window, prices at the symbol’s precision (PC-12)', () => {
    const { host, cmp, fixture } = render();
    cmp.tab.set('trades');
    fixture.detectChanges();
    const rows = host.querySelectorAll('.tl__trade');
    // 300 trades, a few dozen rows.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(60);
    const cells = [...rows[0].querySelectorAll('[role="cell"]')].map((c) => c.textContent?.trim());
    expect(cells[0]).toBe('1');
    expect(cells[4]).toBe('147.123');
    expect(cells[6]).toBe('147.200');
    // Newest first.
    (host.querySelector('.tl__sort') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(host.querySelector('.tl__trade [role="cell"]')?.textContent?.trim()).toBe('300');
  });

  it('a click frames the trade on the chart; a right-click opens its detail at the symbol’s precision', () => {
    const { host, cmp, fixture, focus } = render();
    cmp.tab.set('trades');
    fixture.detectChanges();
    const row = host.querySelector('.tl__trade') as HTMLElement;
    row.dispatchEvent(new PointerEvent('pointerdown', { button: 0 }));
    row.dispatchEvent(new PointerEvent('pointerup', { button: 0 }));
    expect(focus).toHaveBeenCalledWith(TRADES[0]);
    expect(cmp.selected().has(1)).toBe(true);
    row.dispatchEvent(new MouseEvent('contextmenu', { cancelable: true }));
    fixture.detectChanges();
    const entry = cmp.detail().trade.find((r: { label: string }) => r.label === 'Entry');
    expect(entry.value.startsWith('147.123 ·')).toBe(true);
    // (The native <dialog> it opens in is a signal query, which JIT leaves unresolved.)
    expect(host.querySelector('dialog.td strong')?.textContent).toBe('Trade #1');
  });

  it('a fill arrow clicked on the chart selects its trades on the List of trades', () => {
    const reveal = signal<{ numbers: number[]; seq: number } | null>(null);
    const { cmp, fixture } = render({ reveal });
    expect(cmp.tab()).toBe('report');
    reveal.set({ numbers: [250], seq: 1 });
    fixture.detectChanges();
    expect(cmp.tab()).toBe('trades');
    expect([...cmp.selected()]).toEqual([250]);
  });

  it('queues a deep backtest of an engine strategy as the chart runs it, and links the run', () => {
    const deep = signal({
      strategyId: 1181,
      strategySymbol: 'EURUSD',
      strategyTimeframe: 'H1',
      chartSymbol: 'USDJPY',
      chartTimeframe: 'M15',
    });
    const { host, cmp, fixture } = render({ deep });
    cmp.deepOpen.set(true);
    cmp.deepFrom.set('2025-01-01');
    cmp.deepTo.set('2026-01-01');
    fixture.detectChanges();
    cmp.queueDeep();
    fixture.detectChanges();
    expect(queueBacktest).toHaveBeenCalledWith({
      strategyId: 1181,
      symbol: 'EURUSD',
      timeframe: 'H1',
      fromDate: '2025-01-01',
      toDate: '2026-01-01',
      deep: true,
      symbolOverride: 'USDJPY',
      timeframeOverride: 'M15',
      inputs: { 'Main::Length': 30 },
    });
    const done = host.querySelector('[data-testid="tester-deep-queued"]')!;
    expect(done.textContent).toContain('Backtest #4321 queued');
    expect(done.querySelector('a')?.getAttribute('href')).toBe('/backtests/4321');
  });

  it('offers no deep backtest for a script that is not an engine strategy, and checks the range', () => {
    const { host, cmp, fixture } = render();
    expect(host.querySelector('[data-testid="tester-deep"]')).toBeNull();
    cmp.deep = signal({
      strategyId: 1,
      strategySymbol: 'EURUSD',
      strategyTimeframe: 'H1',
      chartSymbol: 'EURUSD',
      chartTimeframe: 'H1',
    });
    cmp.deepFrom.set('2026-01-01');
    cmp.deepTo.set('2025-01-01');
    cmp.queueDeep();
    expect(cmp.deepError()).toBe('The end date must be after the start.');
    expect(queueBacktest).not.toHaveBeenCalled();
    fixture.detectChanges();
  });
});
