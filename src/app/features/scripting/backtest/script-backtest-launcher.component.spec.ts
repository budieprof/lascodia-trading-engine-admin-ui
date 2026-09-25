import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';

import {
  ScriptBacktestLauncherComponent,
  validateBacktestForm,
} from './script-backtest-launcher.component';
import { InputOverridesEditorComponent } from '../shared/input-overrides-editor.component';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { BREAKOUT_SOURCE } from '../testing/pine-sources';

declareSignalIo(ScriptBacktestLauncherComponent, { inputs: ['strategy'], outputs: ['queued'] });
declareSignalIo(InputOverridesEditorComponent, {
  inputs: ['inputs', 'baseline', 'disabled'],
  outputs: ['overridesChange', 'validityChange'],
});

const BASE = 'http://test/api/v1/lascodia-trading-engine';
const CAPITAL_CONFIG_URL = `${BASE}/config/ScriptBacktest:InitialCapital`;
const ok = <T>(data: T) => ({ data, status: true, message: 'Successful', responseCode: '00' });

/** A compile whose `strategy()` carries the given properties. */
function compiledWith(strategy: Record<string, unknown>) {
  return ok({
    success: true,
    diagnostics: [],
    declaration: { kind: 'strategy', title: 'Breakout', strategy },
    inputs: [{ id: 'in_len', kind: 'int', title: 'Length', defaultValue: 20, minValue: 1 }],
  });
}

/** The script declares its capital (`strategy(initial_capital = 25000)`). */
const COMPILED = compiledWith({
  initialCapital: 25000,
  initialCapitalSpecified: true,
  useBarMagnifier: true,
});

/** The script declares no capital: Pine's 1,000,000 compiled, the engine default applies. */
const COMPILED_NO_CAPITAL = compiledWith({
  initialCapital: 1_000_000,
  initialCapitalSpecified: false,
  useBarMagnifier: false,
});

describe('ScriptBacktestLauncherComponent', () => {
  let fixture: ComponentFixture<ScriptBacktestLauncherComponent>;
  let http: HttpTestingController;
  let el: HTMLElement;
  let queued: number[];

  function render(): void {
    fixture = TestBed.createComponent(ScriptBacktestLauncherComponent);
    queued = [];
    fixture.componentInstance.queued.subscribe((id) => queued.push(id));
    fixture.componentRef.setInput('strategy', {
      id: 41,
      name: 'Breakout',
      symbol: 'EURUSD',
      timeframe: 'H1',
      authoringMode: 'Script',
      scriptSource: BREAKOUT_SOURCE,
      scriptInputs: { in_len: 30 },
    });
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  }

  function openForm(compile: object = COMPILED): void {
    el.querySelector<HTMLButtonElement>('.head .btn')!.click();
    fixture.detectChanges();
    const req = http.expectOne(`${BASE}/scripting/compile`);
    expect(req.request.body.source).toContain('strategy("Breakout"');
    req.flush(compile);
    fixture.detectChanges();
  }

  function field(label: string): HTMLInputElement | HTMLSelectElement {
    const l = [...el.querySelectorAll('.field')].find((f) =>
      f.querySelector('span')!.textContent!.trim().startsWith(label),
    )!;
    return l.querySelector('input, select') as HTMLInputElement | HTMLSelectElement;
  }

  function set(label: string, value: string, event = 'change'): void {
    const c = field(label);
    c.value = value;
    c.dispatchEvent(new Event(event));
    fixture.detectChanges();
  }

  function submit(): void {
    // requestSubmit() applies native constraint validation, as a click in a browser does.
    el.querySelector<HTMLFormElement>('form')!.requestSubmit();
    fixture.detectChanges();
  }

  const capitalText = () => el.querySelector('.capital-value')!.textContent!.trim();

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ScriptBacktestLauncherComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('stays collapsed until opened, then reads the script’s inputs and declaration', () => {
    render();
    expect(el.querySelector('form')).toBeNull();
    openForm();
    expect(capitalText()).toBe('25,000 · declared by the script');
    expect(field('Bar magnifier').textContent).toContain('Script setting (on)');
    // The saved override (30) is what the inputs editor shows as the value in effect.
    expect(
      el.querySelector<HTMLInputElement>('app-input-overrides-editor input[type="number"]')!.value,
    ).toBe('30');
  });

  it('queues a run with overrides, deep mode and the magnifier forced off', () => {
    render();
    openForm();
    set('Symbol override', 'gbpusd', 'input');
    set('Timeframe override', 'H4');
    set('Bar magnifier', 'off');
    const deep = el.querySelector<HTMLInputElement>('.check input')!;
    deep.checked = true;
    deep.dispatchEvent(new Event('change'));
    const len = el.querySelector<HTMLInputElement>(
      'app-input-overrides-editor input[type="number"]',
    )!;
    len.value = '40';
    len.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(el.textContent).toContain('never read as validation');

    submit();
    const req = http.expectOne(`${BASE}/backtest`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({
      strategyId: 41,
      symbol: 'EURUSD',
      timeframe: 'H1',
      fromDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      toDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      symbolOverride: 'GBPUSD',
      timeframeOverride: 'H4',
      inputs: { in_len: 40 },
      deep: true,
      barMagnifier: false,
    });
    req.flush(ok(812));
    fixture.detectChanges();

    expect(queued).toEqual([812]);
    const status = el.querySelector('.queued')!;
    expect(status.textContent).toContain('Backtest #812 queued');
    expect(status.querySelector('a')!.getAttribute('href')).toBe('/backtests/812');
  });

  it('does not let the browser’s step checks block the form', () => {
    render();
    openForm();
    expect(el.querySelector<HTMLFormElement>('form')!.noValidate).toBe(true);
  });

  it('sends a plain run without any override fields — and without a balance', () => {
    render();
    openForm();
    submit();
    const body = http.expectOne(`${BASE}/backtest`).request.body;
    expect(Object.keys(body).sort()).toEqual(
      ['fromDate', 'strategyId', 'symbol', 'timeframe', 'toDate'].sort(),
    );
  });

  it('shows the capital read-only: there is no balance to enter', () => {
    render();
    openForm();
    const labels = [...el.querySelectorAll('.field span')].map((s) => s.textContent!.trim());
    expect(labels).not.toContain('Initial balance');
    expect(el.querySelector('.capital input')).toBeNull();
    expect(el.querySelector('.capital-label')!.textContent!.trim()).toBe('Initial capital');
    expect(el.querySelector('.capital')!.textContent).toContain('One capital for every run');
  });

  it('a declared capital is the script’s, even when it equals Pine’s default', () => {
    render();
    openForm(
      compiledWith({ initialCapital: 1_000_000, initialCapitalSpecified: true, currency: 'JPY' }),
    );
    // Read from the compiler's flag, never the value: no engine default to look up.
    http.expectNone(CAPITAL_CONFIG_URL);
    expect(capitalText()).toBe('1,000,000 JPY · declared by the script');
  });

  it('a script without a capital shows the engine’s configured default', () => {
    render();
    openForm(COMPILED_NO_CAPITAL);
    http.expectOne(CAPITAL_CONFIG_URL).flush(
      ok({
        id: 7,
        key: 'ScriptBacktest:InitialCapital',
        value: '10000',
        description: 'Capital a script strategy’s account opens with…',
        dataType: 'Decimal',
        isHotReloadable: true,
        lastUpdatedAt: '2026-09-25T09:00:00Z',
      }),
    );
    fixture.detectChanges();
    expect(capitalText()).toBe('10,000 · engine default (ScriptBacktest:InitialCapital)');

    submit();
    const body = http.expectOne(`${BASE}/backtest`).request.body;
    expect(body).not.toHaveProperty('initialBalance');
  });

  it('names the engine default when its value cannot be read', () => {
    render();
    openForm(COMPILED_NO_CAPITAL);
    http.expectOne(CAPITAL_CONFIG_URL).flush({
      data: null,
      status: false,
      message: 'Config not found',
      responseCode: '-14',
    });
    fixture.detectChanges();
    expect(capitalText()).toBe('engine default (ScriptBacktest:InitialCapital)');
  });

  it('explains the rule when the compile cannot say where the capital comes from', () => {
    render();
    openForm({
      data: null,
      status: false,
      message: 'PS2003: undeclared identifier',
      responseCode: '-11',
    });
    expect(capitalText()).toBe(
      "the script's initial_capital when it declares one, else the engine default (ScriptBacktest:InitialCapital)",
    );
  });

  it('refuses an empty or inverted range before calling the engine', () => {
    render();
    openForm();
    set('From', '2026-02-01');
    set('To', '2026-01-01');
    submit();
    http.expectNone(`${BASE}/backtest`);
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('end date must be after');
  });

  it('shows the engine’s refusal', () => {
    render();
    openForm();
    submit();
    http.expectOne(`${BASE}/backtest`).flush({
      data: 0,
      status: false,
      message: 'TimeframeOverride must be one of: M1, M5, M15, H1, H4, D1',
      responseCode: '-11',
    });
    fixture.detectChanges();
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('TimeframeOverride must be');
    expect(queued).toEqual([]);
  });

  it('falls back to free-form overrides when the script does not compile', () => {
    render();
    openForm({
      data: null,
      status: false,
      message: 'PS2003: undeclared identifier',
      responseCode: '-11',
    });
    expect(el.textContent).toContain('PS2003: undeclared identifier');
    expect(el.querySelector('app-input-overrides-editor .add')).not.toBeNull();
  });
});

describe('validateBacktestForm', () => {
  const ok = {
    fromDate: '2025-01-01',
    toDate: '2026-01-01',
    symbolOverride: '',
  };

  it('accepts a sane form', () => {
    expect(validateBacktestForm(ok)).toBeNull();
  });

  it('rejects bad dates and symbols', () => {
    expect(validateBacktestForm({ ...ok, fromDate: '' })).toMatch(/start and an end/);
    expect(validateBacktestForm({ ...ok, toDate: '2024-12-31' })).toMatch(/after the start/);
    expect(validateBacktestForm({ ...ok, symbolOverride: 'EUR/USD' })).toMatch(/letters or digits/);
  });
});
