import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { AgGridAngular } from 'ag-grid-angular';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

import { PineScreenerPageComponent } from './pine-screener-page.component';
import { InputOverridesEditorComponent } from '../shared/input-overrides-editor.component';
import { declareSignalIo } from '../testing/jit-signal-io';
import { AgGridStubComponent } from '../testing/stubs';
import { RSI_INDICATOR_SOURCE } from '../testing/pine-sources';

declareSignalIo(PageHeaderComponent, { inputs: ['title', 'subtitle'] });
declareSignalIo(InputOverridesEditorComponent, {
  inputs: ['inputs', 'baseline', 'disabled'],
  outputs: ['overridesChange', 'validityChange'],
});

const BASE = 'http://test/api/v1/lascodia-trading-engine';
const ok = <T>(data: T) => ({ data, status: true, message: 'Successful', responseCode: '00' });
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

describe('PineScreenerPageComponent', () => {
  let fixture: ComponentFixture<PineScreenerPageComponent>;
  let http: HttpTestingController;
  let el: HTMLElement;

  function render(): void {
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
    http.expectOne(`${BASE}/scripting/compile`).flush(
      ok({
        success: true,
        diagnostics: [],
        declaration: { kind: 'indicator', title: 'RSI screener' },
        inputs: [{ id: 'in_len', kind: 'int', title: 'Length', defaultValue: 14, minValue: 1 }],
      }),
    );
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

  const runBtn = () =>
    [...el.querySelectorAll<HTMLButtonElement>('.btn.primary')].find((b) =>
      b.textContent!.includes('Run screener'),
    )!;

  function run(): void {
    runBtn().click();
    fixture.detectChanges();
  }

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
      remove: { imports: [AgGridAngular] },
      add: { imports: [AgGridStubComponent] },
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.restoreAllMocks();
  });

  it('offers saved script strategies only, and active symbols only', () => {
    render();
    const labels = [...el.querySelector('.field select')!.querySelectorAll('option')].map((o) =>
      o.textContent!.trim(),
    );
    expect(labels).toEqual(['Choose a script…', 'Breakout — EURUSD H1', 'RSI screen — GBPUSD H1']);
    const symbols = [...el.querySelectorAll('.symbol')].map((s) => s.textContent!.trim());
    expect(symbols).toEqual(['EURUSD', 'GBPUSD', 'USDJPY']);
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
    const cols = fixture.componentInstance.columnDefs().map((c) => c.headerName);
    expect(cols).toEqual(['Symbol', 'Last bar (UTC)', 'RSI', 'Alerts', 'Error']);
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
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
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
    expect(click).toHaveBeenCalled();
    const text = await blob!.text();
    expect(text).toContain('Symbol,Last bar (UTC),RSI,Alerts,Alert messages,Error');
    expect(text).toContain('EURUSD,,55.5,,,');
  });

  it('runs a library by id, without source or inputs', () => {
    render();
    const radio = [...el.querySelectorAll<HTMLInputElement>('.mode input')].find(
      (r) => r.value === 'library',
    )!;
    radio.checked = true;
    radio.dispatchEvent(new Event('change'));
    fixture.detectChanges();
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

  it('runs pasted source and refuses more than 500 bars', () => {
    render();
    const radio = [...el.querySelectorAll<HTMLInputElement>('.mode input')].find(
      (r) => r.value === 'source',
    )!;
    radio.checked = true;
    radio.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    const ta = el.querySelector<HTMLTextAreaElement>('textarea')!;
    ta.value = RSI_INDICATOR_SOURCE;
    ta.dispatchEvent(new Event('input'));
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
});
