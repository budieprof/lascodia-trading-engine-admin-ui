import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { By } from '@angular/platform-browser';
import { Router, provideRouter } from '@angular/router';
import { AgGridAngular } from 'ag-grid-angular';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

import { PineScreenerPageComponent } from './pine-screener-page.component';
import { SavedScreensPanelComponent } from './saved-screens-panel.component';
import { ScreenFiltersEditorComponent } from './screen-filters-editor.component';
import { ScreenHistoryComponent } from './screen-history.component';
import { ScreenSettingsComponent } from './screen-settings.component';
import { InputOverridesEditorComponent } from '../shared/input-overrides-editor.component';
import { PineEditorComponent } from '../components/pine-editor/pine-editor.component';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { AgGridStubComponent } from '../testing/stubs';
import { RSI_INDICATOR_SOURCE } from '../testing/pine-sources';

declareSignalIo(PageHeaderComponent, { inputs: ['title', 'subtitle'] });
declareSignalIo(InputOverridesEditorComponent, {
  inputs: ['inputs', 'baseline', 'disabled'],
  outputs: ['overridesChange', 'validityChange'],
});
declareSignalIo(SavedScreensPanelComponent, {
  inputs: ['activeId', 'refreshKey', 'canWrite', 'canRun'],
  outputs: ['opened', 'ran', 'removed', 'changed'],
});
declareSignalIo(ScreenSettingsComponent, {
  inputs: [
    'draft',
    'screen',
    'columns',
    'mainTimeframe',
    'extraTimeframes',
    'canWrite',
    'saving',
    'problem',
    'note',
  ],
  outputs: ['draftChange', 'save', 'saveAsNew', 'closeScreen', 'refreshSource'],
});
declareSignalIo(ScreenFiltersEditorComponent, {
  inputs: ['filters', 'columns', 'mainTimeframe', 'extraTimeframes', 'disabled'],
  outputs: ['filtersChange'],
});
declareSignalIo(ScreenHistoryComponent, {
  inputs: ['screenId', 'refreshKey'],
  outputs: ['runOpened'],
});

@Component({ selector: 'app-pine-editor', standalone: true, template: '' })
class PineEditorStubComponent {
  @Input() value = '';
  @Input() diagnostics: unknown = [];
  @Input() height = '';
  @Input() ariaLabel = '';
  @Input() placeholder: string | null = null;
  @Output() valueChange = new EventEmitter<string>();
}

const BASE = 'http://test/api/v1/lascodia-trading-engine';
const H = Date.UTC(2026, 9, 9, 12);
const ok = <T>(data: T, message = 'Successful') => ({
  data,
  status: true,
  message,
  responseCode: '00',
});
const paged = <T>(data: T[]) =>
  ok({
    pager: {
      totalItemCount: data.length,
      filter: null,
      currentPage: 1,
      itemCountPerPage: 500,
      pageNo: 1,
      pageSize: 500,
    },
    data,
  });
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const compiled = (kind = 'indicator') =>
  ok({
    success: true,
    diagnostics: [],
    declaration: { kind, title: 'RSI screener' },
    inputs: [{ id: 'in_len', kind: 'int', title: 'Length', defaultValue: 14, minValue: 1 }],
  });

function screenDto(over: Record<string, unknown> = {}) {
  return {
    id: 5,
    name: 'RSI hot',
    sourceKind: 'Strategy',
    sourceId: 43,
    sourceName: 'RSI screen',
    sourceHash: 'abc',
    sourceChanged: false,
    sourceMissing: false,
    pineSource: RSI_INDICATOR_SOURCE,
    inputs: { in_len: 21 },
    symbols: ['EURUSD', 'GBPUSD'],
    timeframe: '60',
    extraTimeframes: ['240'],
    lastBars: 200,
    formingBar: false,
    filters: [{ column: 'RSI', timeframe: null, op: 'gt', value: 70 }],
    scheduleEnabled: true,
    alertOnEnter: true,
    alertOnLeave: false,
    channels: ['InApp'],
    severity: 'Medium',
    statusReason: null,
    scheduleNote: null,
    matched: ['EURUSD'],
    lastScheduledBarMs: H,
    lastRunAt: '2026-10-09T12:00:05Z',
    lastRunId: 31,
    lastRunError: null,
    nextRunAtUtc: '2026-10-09T13:00:00Z',
    createdBy: 'ops',
    createdAt: '2026-10-08T09:00:00Z',
    updatedAt: '2026-10-09T09:00:00Z',
    ...over,
  };
}

function runDto(over: Record<string, unknown> = {}) {
  return {
    id: 31,
    screenId: 5,
    trigger: 'Scheduled',
    barTimeMs: H,
    startedAt: '2026-10-09T13:00:02Z',
    completedAt: '2026-10-09T13:00:04Z',
    durationMs: 1800,
    symbols: 2,
    matched: 1,
    errors: 0,
    entered: 1,
    left: 0,
    matchedSymbols: ['EURUSD'],
    enteredSymbols: ['EURUSD'],
    leftSymbols: [],
    hasRows: true,
    notes: [],
    error: null,
    alertsQueued: 1,
    rows: [
      {
        row: {
          symbol: 'EURUSD',
          lastBarTimeMs: H,
          values: { RSI: 72 },
          alerts: [],
          timeframes: [{ timeframe: '240', lastBarTimeMs: H, values: { RSI: 66 }, alerts: [] }],
        },
        status: 'matched',
        entered: true,
        left: false,
      },
      {
        row: {
          symbol: 'GBPUSD',
          lastBarTimeMs: H,
          values: { RSI: 41 },
          alerts: [],
          timeframes: [{ timeframe: '240', lastBarTimeMs: H, values: { RSI: 50 }, alerts: [] }],
        },
        status: 'unmatched',
        reason: 'RSI > 70',
      },
    ],
    ...over,
  };
}

describe('PineScreenerPageComponent', () => {
  let fixture: ComponentFixture<PineScreenerPageComponent>;
  let http: HttpTestingController;
  let el: HTMLElement;

  function render(screens: unknown[] = []): void {
    fixture = TestBed.createComponent(PineScreenerPageComponent);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
    const list = http.expectOne(`${BASE}/strategy/list`);
    expect(list.request.body.filter).toBeNull();
    list.flush(
      paged([
        {
          id: 41,
          name: 'Breakout',
          symbol: 'EURUSD',
          timeframe: 'H1',
          strategyType: 'RuleBased',
          authoringMode: 'Script',
        },
        {
          id: 42,
          name: 'DSL one',
          symbol: 'EURUSD',
          timeframe: 'H1',
          strategyType: 'RuleBased',
          authoringMode: 'Dsl',
        },
        {
          id: 43,
          name: 'RSI screen',
          symbol: 'GBPUSD',
          timeframe: 'H1',
          strategyType: 'RuleBased',
          authoringMode: 'Script',
        },
      ]),
    );
    http
      .expectOne(`${BASE}/scripting/libraries`)
      .flush(ok([{ id: 1, publisher: 'lascodia', name: 'std', version: 1, visibility: 'Shared' }]));
    http.expectOne(`${BASE}/currency-pair/list`).flush(
      paged([
        { id: 1, symbol: 'EURUSD', isActive: true },
        { id: 2, symbol: 'GBPUSD', isActive: true },
        { id: 3, symbol: 'USDJPY', isActive: true },
        { id: 4, symbol: 'XAUUSD', isActive: false },
      ]),
    );
    http.expectOne(`${BASE}/scripting/screens`).flush(ok(screens));
    fixture.detectChanges();
  }

  async function update(): Promise<void> {
    await settle();
    fixture.detectChanges();
  }

  function chooseScript(id: number): void {
    const select = el.querySelector<HTMLSelectElement>('.field select')!;
    select.value = String(id);
    select.dispatchEvent(new Event('change'));
    http.expectOne(`${BASE}/strategy/${id}`).flush(
      ok({
        id,
        name: 'RSI screen',
        symbol: 'GBPUSD',
        timeframe: 'H1',
        strategyType: 'RuleBased',
        authoringMode: 'Script',
        scriptSource: RSI_INDICATOR_SOURCE,
        scriptInputs: { in_len: 21 },
      }),
    );
    http.expectOne(`${BASE}/scripting/compile`).flush(compiled());
    fixture.detectChanges();
  }

  function chooseMode(mode: string): void {
    const radio = [...el.querySelectorAll<HTMLInputElement>('.mode input')].find(
      (r) => r.value === mode,
    )!;
    radio.checked = true;
    radio.dispatchEvent(new Event('change'));
    fixture.detectChanges();
  }

  function tick(symbol: string): void {
    const box = [...el.querySelectorAll<HTMLInputElement>('.symbol input')].find(
      (i) => i.parentElement!.textContent!.trim() === symbol,
    )!;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    fixture.detectChanges();
  }

  function check(selector: string, on = true): void {
    const box = el.querySelector<HTMLInputElement>(selector)!;
    box.checked = on;
    box.dispatchEvent(new Event('change'));
    fixture.detectChanges();
  }

  function type(selector: string, value: string, event = 'change'): void {
    const input = el.querySelector<HTMLInputElement>(selector)!;
    input.value = value;
    input.dispatchEvent(new Event(event));
    fixture.detectChanges();
  }

  const runBtn = () =>
    [...el.querySelectorAll<HTMLButtonElement>('.btn.primary')].find((b) =>
      b.textContent!.includes('Run screener'),
    )!;

  function run(): void {
    runBtn().click();
    fixture.detectChanges();
  }

  const click = (selector: string) => (el.querySelector(selector) as HTMLButtonElement).click();
  const headers = () => fixture.componentInstance.columnDefs().map((c) => c.headerName);

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [PineScreenerPageComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
      ],
    });
    TestBed.overrideComponent(PineScreenerPageComponent, {
      remove: { imports: [AgGridAngular, PineEditorComponent] },
      add: { imports: [AgGridStubComponent, PineEditorStubComponent] },
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.restoreAllMocks();
  });

  it('offers saved script strategies only, and active symbols only', async () => {
    render();
    await update();
    const labels = [...el.querySelector('.field select')!.querySelectorAll('option')].map((o) =>
      o.textContent!.trim(),
    );
    expect(labels).toEqual(['Choose a script…', 'Breakout — EURUSD H1', 'RSI screen — GBPUSD H1']);
    const symbols = [...el.querySelectorAll('.symbol')].map((s) => s.textContent!.trim());
    expect(symbols).toEqual(['EURUSD', 'GBPUSD', 'USDJPY']);
    expect(el.textContent).toContain('No saved screens yet');
  });

  it('runs a saved script over the chosen symbols with its inputs, and shows the results', () => {
    render();
    chooseScript(43);
    expect(
      el.querySelector<HTMLInputElement>('app-input-overrides-editor input[type="number"]')!.value,
    ).toBe('21');

    run();
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('at least one symbol');
    http.expectNone(`${BASE}/scripting/screener`);

    tick('EURUSD');
    tick('GBPUSD');
    expect(el.querySelector('.count')!.textContent).toContain('2 of max 200');
    run();
    const req = http.expectOne(`${BASE}/scripting/screener`);
    expect(req.request.body).toEqual({
      symbols: ['EURUSD', 'GBPUSD'],
      timeframe: 'H1',
      lastBars: 200,
      source: RSI_INDICATOR_SOURCE,
      inputs: { in_len: 21 },
    });
    req.flush(
      ok([
        {
          symbol: 'EURUSD',
          lastBarTimeMs: Date.UTC(2026, 8, 24, 12),
          values: { RSI: 71.2345 },
          alerts: [{ title: 'Overbought', message: 'RSI 71.2 on EURUSD', barIndex: 199 }],
        },
        {
          symbol: 'GBPUSD',
          lastBarTimeMs: null,
          values: { RSI: null },
          alerts: [],
          error: 'No candles for GBPUSD H1',
        },
      ]),
    );
    fixture.detectChanges();

    expect(el.querySelector('.grid-stub')!.getAttribute('data-rows')).toBe('2');
    expect(el.textContent).toContain('2 symbols · 1 with alerts · 1 error');
    expect(headers()).toEqual(['Symbol', 'Last bar (UTC)', 'RSI', 'Alerts', 'Error']);
  });

  it('exports the results as CSV', async () => {
    let blob: Blob | null = null;
    Object.assign(URL, {
      createObjectURL: vi.fn((b: Blob) => {
        blob = b;
        return 'blob:csv';
      }),
      revokeObjectURL: vi.fn(),
    });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render();
    chooseScript(43);
    tick('EURUSD');
    run();
    http
      .expectOne(`${BASE}/scripting/screener`)
      .flush(ok([{ symbol: 'EURUSD', lastBarTimeMs: null, values: { RSI: 55.5 }, alerts: [] }]));
    fixture.detectChanges();

    [...el.querySelectorAll<HTMLButtonElement>('.btn.small')]
      .find((b) => b.textContent!.includes('Export CSV'))!
      .click();
    expect(anchorClick).toHaveBeenCalled();
    const text = await blob!.text();
    expect(text).toContain('Symbol,Last bar (UTC),RSI,Alerts,Alert messages,Error');
    expect(text).toContain('EURUSD,,55.5,,,');
  });

  it('runs a library by id, without source or inputs', () => {
    render();
    chooseMode('library');
    const select = el.querySelector<HTMLSelectElement>('.field select')!;
    select.value = '1';
    select.dispatchEvent(new Event('change'));
    tick('USDJPY');
    run();
    expect(http.expectOne(`${BASE}/scripting/screener`).request.body).toEqual({
      symbols: ['USDJPY'],
      timeframe: 'H1',
      lastBars: 200,
      libraryId: 1,
    });
  });

  it('runs a written source from the Pine editor and refuses more than 500 bars', () => {
    render();
    chooseMode('source');
    const editor = fixture.debugElement.query(By.directive(PineEditorStubComponent))
      .componentInstance as PineEditorStubComponent;
    editor.valueChange.emit(RSI_INDICATOR_SOURCE);
    fixture.detectChanges();
    expect(editor.value).toBe(RSI_INDICATOR_SOURCE);
    tick('EURUSD');
    const bars = [...el.querySelectorAll<HTMLInputElement>('.field input[type="number"]')][0];
    bars.value = '600';
    bars.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    run();
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('1 to 500');
    http.expectNone(`${BASE}/scripting/screener`);

    bars.value = '300';
    bars.dispatchEvent(new Event('change'));
    run();
    expect(http.expectOne(`${BASE}/scripting/screener`).request.body).toEqual({
      symbols: ['EURUSD'],
      timeframe: 'H1',
      lastBars: 300,
      source: RSI_INDICATOR_SOURCE,
    });
  });

  it('shows the compile diagnostics in the editor', () => {
    render();
    chooseMode('source');
    const editor = fixture.debugElement.query(By.directive(PineEditorStubComponent))
      .componentInstance as PineEditorStubComponent;
    editor.valueChange.emit('indicator("x")\nplot(foo)');
    fixture.detectChanges();
    [...el.querySelectorAll<HTMLButtonElement>('.btn')]
      .find((b) => b.textContent!.includes('Check and read inputs'))!
      .click();
    const diag = { line: 2, column: 6, severity: 'error', message: 'Undeclared identifier foo' };
    http
      .expectOne(`${BASE}/scripting/compile`)
      .flush(ok({ success: false, diagnostics: [diag], declaration: null, inputs: [] }));
    fixture.detectChanges();
    expect(editor.diagnostics).toEqual([diag]);
    expect(el.textContent).toContain('Line 2: Undeclared identifier foo');
  });

  it('shows the engine’s refusal', () => {
    render();
    chooseScript(43);
    tick('EURUSD');
    run();
    http
      .expectOne(`${BASE}/scripting/screener`)
      .flush({ data: null, status: false, message: 'symbols: at most 200', responseCode: '-11' });
    fixture.detectChanges();
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('symbols: at most 200');
  });

  it('runs one of my scripts by id on more timeframes and the forming bar (PE-I11)', () => {
    render();
    chooseMode('chart');
    http.expectOne(`${BASE}/scripting/indicators`).flush(
      ok([
        {
          id: 10,
          name: 'Trend follower',
          kind: 'strategy',
          pineSource: 'strategy("t")',
          inputs: null,
          ownedByMe: false,
          createdAt: '',
          updatedAt: '',
        },
        {
          id: 9,
          name: 'RSI mine',
          kind: 'indicator',
          pineSource: RSI_INDICATOR_SOURCE,
          inputs: { in_len: 10 },
          ownedByMe: true,
          createdAt: '',
          updatedAt: '',
        },
      ]),
    );
    fixture.detectChanges();
    const select = el.querySelector<HTMLSelectElement>('[data-testid="chart-script-select"]')!;
    expect([...select.options].map((o) => o.textContent!.trim())).toEqual([
      'Choose a script…',
      'RSI mine',
      'Trend follower (strategy) — shared',
    ]);
    select.value = '9';
    select.dispatchEvent(new Event('change'));
    const compile = http.expectOne(`${BASE}/scripting/compile`);
    expect(compile.request.body.source).toBe(RSI_INDICATOR_SOURCE);
    compile.flush(compiled());
    fixture.detectChanges();
    expect(
      el.querySelector<HTMLInputElement>('app-input-overrides-editor input[type="number"]')!.value,
    ).toBe('10');

    tick('EURUSD');
    check('[data-extra="H4"]');
    check('[data-extra="D1"]');
    check('[data-testid="forming-bar"]');
    run();
    const req = http.expectOne(`${BASE}/scripting/screener`);
    expect(req.request.body).toEqual({
      symbols: ['EURUSD'],
      timeframe: 'H1',
      lastBars: 200,
      timeframes: ['H4', 'D1'],
      formingBar: true,
      chartScriptId: 9,
    });
    req.flush(
      ok([
        {
          symbol: 'EURUSD',
          lastBarTimeMs: H,
          lastBarForming: true,
          values: { RSI: 61 },
          alerts: [],
          metrics: { netProfit: 12.5, closedTrades: 3 },
          timeframes: [
            { timeframe: '240', lastBarTimeMs: H, values: { RSI: 55 }, alerts: [] },
            {
              timeframe: '1D',
              lastBarTimeMs: null,
              values: {},
              alerts: [],
              error: 'No candles for EURUSD D1',
            },
          ],
        },
      ]),
    );
    fixture.detectChanges();
    expect(headers()).toEqual([
      'Symbol',
      'Last bar (UTC)',
      'RSI',
      'Net profit',
      'Closed trades',
      'RSI · H4',
      'Alerts',
      'Error',
    ]);
    // A fourth extra timeframe cannot be chosen.
    check('[data-extra="M15"]');
    expect(el.querySelector<HTMLInputElement>('[data-extra="M5"]')!.disabled).toBe(true);
  });

  it('saves the screener as a screen with filters, a schedule and alerts (SS-I6)', async () => {
    render();
    chooseScript(43);
    tick('EURUSD');
    tick('GBPUSD');
    check('[data-extra="H4"]');

    click('[data-testid="save-screen"]');
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="screen-problem"]')!.textContent).toContain(
      'Give the screen a name',
    );
    http.expectNone(`${BASE}/scripting/screens`);

    type('[data-testid="screen-name"]', 'RSI hot', 'input');
    click('[data-testid="add-filter"]');
    fixture.detectChanges();
    type('[data-filter="0"] input[type="text"]', 'RSI');
    type('[data-filter="0"] input[type="number"]', '70');
    check('[data-testid="screen-scheduled"]');
    check('[data-channel="Telegram"]');
    click('[data-testid="save-screen"]');
    fixture.detectChanges();

    const save = http.expectOne(
      (r) => r.method === 'POST' && r.url === `${BASE}/scripting/screens`,
    );
    expect(save.request.body).toEqual({
      name: 'RSI hot',
      strategyId: 43,
      inputs: { in_len: 21 },
      symbols: ['EURUSD', 'GBPUSD'],
      timeframe: 'H1',
      timeframes: ['H4'],
      lastBars: 200,
      formingBar: false,
      filters: [{ column: 'RSI', timeframe: null, op: 'gt', value: 70 }],
      scheduleEnabled: true,
      alertOnEnter: true,
      alertOnLeave: false,
      channels: ['InApp', 'Telegram'],
      severity: 'Medium',
    });
    save.flush(
      ok(
        screenDto({
          sourceChanged: null,
          lastRunId: null,
          lastRunAt: null,
          channels: ['InApp', 'Telegram'],
        }),
      ),
    );
    await update();

    // The list reads again, the screen's history opens, and the page now edits the saved screen.
    http
      .expectOne((r) => r.method === 'GET' && r.url === `${BASE}/scripting/screens`)
      .flush(ok([screenDto()]));
    http.expectOne(`${BASE}/scripting/screens/5/runs?limit=30`).flush(ok([]));
    await update();
    expect(el.querySelector('[data-testid="screen-note"]')!.textContent).toContain('Screen saved');
    expect(el.querySelector('[data-testid="save-screen"]')!.textContent).toContain('Update screen');
    expect(el.querySelector('[data-testid="screen-schedule"]')!.textContent).toContain(
      'next run 2026-10-09 13:00 UTC',
    );
    expect(el.querySelector('tr[data-screen="5"]')!.classList).toContain('active');
  });

  it('opens a screen from ?screen=, shows its newest run, and takes the strategy’s new script on update', async () => {
    await TestBed.inject(Router).navigateByUrl('/?screen=5');
    render([screenDto({ sourceChanged: null })]);
    http.expectOne(`${BASE}/scripting/screens/5`).flush(ok(screenDto({ sourceChanged: true })));
    await update();

    // The screen's own copy of the script is compiled — not the strategy's current one.
    const compile = http.expectOne(`${BASE}/scripting/compile`);
    expect(compile.request.body.source).toBe(RSI_INDICATOR_SOURCE);
    compile.flush(compiled());
    http.expectOne(`${BASE}/scripting/screens/5/runs/31`).flush(ok(runDto()));
    http
      .expectOne(`${BASE}/scripting/screens/5/runs?limit=30`)
      .flush(ok([{ ...runDto(), rows: null }]));
    await update();

    expect(el.querySelector('[data-testid="copy-note"]')!.textContent).toContain(
      "Runs this screen's copy of RSI screen; the strategy has changed",
    );
    expect(el.querySelector('[data-testid="source-changed"]')).not.toBeNull();
    expect(
      [...el.querySelectorAll<HTMLInputElement>('.symbol input')].filter((b) => b.checked).length,
    ).toBe(2);
    expect(el.querySelector<HTMLInputElement>('[data-extra="H4"]')!.checked).toBe(true);
    expect(headers()).toEqual([
      'Symbol',
      'Status',
      'Change',
      'Last bar (UTC)',
      'RSI',
      'RSI · H4',
      'Alerts',
      'Error',
    ]);
    expect(el.querySelector('[data-testid="run-label"]')!.textContent).toContain(
      'Scheduled run #31',
    );
    expect(el.textContent).toContain('2 symbols · 1 matched');
    expect(el.querySelector('tr[data-run="31"]')!.textContent).toContain('1 of 2 matched');

    // An ad-hoc run previews the screen's copy, with its saved inputs.
    run();
    const preview = http.expectOne(`${BASE}/scripting/screener`);
    expect(preview.request.body).toMatchObject({
      source: RSI_INDICATOR_SOURCE,
      inputs: { in_len: 21 },
      timeframe: 'H1',
      timeframes: ['H4'],
    });
    preview.flush(ok([]));
    fixture.detectChanges();

    // "Use the current script": the strategy's script now, copied on update.
    const newSource = RSI_INDICATOR_SOURCE.replace('14', '9');
    click('[data-testid="refresh-source"]');
    http.expectOne(`${BASE}/strategy/43`).flush(
      ok({
        id: 43,
        name: 'RSI screen',
        strategyType: 'RuleBased',
        authoringMode: 'Script',
        scriptSource: newSource,
        scriptInputs: { in_len: 9 },
      }),
    );
    http.expectOne(`${BASE}/scripting/compile`).flush(compiled());
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="copy-note"]')).toBeNull();

    click('[data-testid="save-screen"]');
    const put = http.expectOne(
      (r) => r.method === 'PUT' && r.url === `${BASE}/scripting/screens/5`,
    );
    expect(put.request.body).toMatchObject({
      name: 'RSI hot',
      strategyId: 43,
      refreshSource: true,
      inputs: { in_len: 9 },
      symbols: ['EURUSD', 'GBPUSD'],
      timeframe: 'H1',
      timeframes: ['H4'],
    });
    put.flush(
      ok(
        screenDto({ pineSource: newSource, inputs: { in_len: 9 }, sourceChanged: null }),
        'Saved — the next run starts a new baseline (no alert on it).',
      ),
    );
    await update();
    http
      .expectOne((r) => r.method === 'GET' && r.url === `${BASE}/scripting/screens`)
      .flush(ok([screenDto()]));
    http.expectOne(`${BASE}/scripting/screens/5/runs?limit=30`).flush(ok([]));
    await update();
    expect(el.querySelector('[data-testid="screen-note"]')!.textContent).toContain(
      'the next run starts a new baseline',
    );
    expect(el.querySelector('[data-testid="source-changed"]')).toBeNull();
  });

  it('runs a saved screen from the list and shows the run with its verdicts', async () => {
    render([screenDto({ lastRunId: null })]);
    await update();
    const runNow = [...el.querySelectorAll<HTMLButtonElement>('tr[data-screen="5"] button')].find(
      (b) => b.textContent!.includes('Run now'),
    )!;
    runNow.click();
    http
      .expectOne((r) => r.method === 'POST' && r.url === `${BASE}/scripting/screens/5/run`)
      .flush(ok(runDto({ id: 32, trigger: 'Manual', alertsQueued: 0 })));
    await update();
    // The list re-reads after the run; the page opens the screen to show the run beside it.
    http
      .expectOne((r) => r.method === 'GET' && r.url === `${BASE}/scripting/screens`)
      .flush(ok([screenDto({ lastRunId: 32 })]));
    http.expectOne(`${BASE}/scripting/screens/5`).flush(ok(screenDto({ lastRunId: 32 })));
    await update();
    http.expectOne(`${BASE}/scripting/compile`).flush(compiled());
    http.expectOne(`${BASE}/scripting/screens/5/runs?limit=30`).flush(ok([]));
    await update();

    expect(el.querySelector('[data-testid="run-label"]')!.textContent).toContain('Run #32');
    expect(headers().slice(0, 3)).toEqual(['Symbol', 'Status', 'Change']);
    const verdicts = fixture.componentInstance.verdicts()!;
    expect(verdicts.get('EURUSD')!.status).toBe('matched');
    expect(verdicts.get('GBPUSD')!.reason).toBe('RSI > 70');
  });
});
