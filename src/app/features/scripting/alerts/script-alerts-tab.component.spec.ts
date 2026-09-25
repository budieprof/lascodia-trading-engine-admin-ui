import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';

import { ScriptAlertsTabComponent } from './script-alerts-tab.component';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { BREAKOUT_SOURCE, RSI_INDICATOR_SOURCE } from '../testing/pine-sources';

declareSignalIo(ScriptAlertsTabComponent, { inputs: ['strategy'] });

const BASE = 'http://test/api/v1/lascodia-trading-engine';
const ALERTS_URL = `${BASE}/strategy/41/script/alerts`;
const COMPILE_URL = `${BASE}/scripting/compile`;

const ok = <T>(data: T) => ({ data, status: true, message: 'Successful', responseCode: '00' });

function compiled(kind: 'strategy' | 'indicator') {
  return ok({
    success: true,
    diagnostics: [],
    declaration: { kind, title: 'x' },
    inputs: [],
    plotSlots: 3,
  });
}

describe('ScriptAlertsTabComponent', () => {
  let fixture: ComponentFixture<ScriptAlertsTabComponent>;
  let http: HttpTestingController;
  let el: HTMLElement;

  function render(source = BREAKOUT_SOURCE): void {
    fixture = TestBed.createComponent(ScriptAlertsTabComponent);
    fixture.componentRef.setInput('strategy', {
      id: 41,
      name: 'Breakout',
      symbol: 'EURUSD',
      timeframe: 'H1',
      authoringMode: 'Script',
      scriptSource: source,
    });
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  }

  function load(saved: unknown[] = [], compile: unknown = compiled('strategy')): void {
    http.expectOne(ALERTS_URL).flush(ok(saved));
    const req = http.expectOne(COMPILE_URL);
    expect(req.request.body).toEqual({
      source: expect.any(String),
      symbol: 'EURUSD',
      timeframe: 'H1',
    });
    req.flush(compile);
    fixture.detectChanges();
  }

  const rows = () => [...el.querySelectorAll<HTMLElement>('section.row')];
  const titles = () => rows().map((r) => r.querySelector('.row-title')!.textContent!.trim());
  const saveBtn = () =>
    [...el.querySelectorAll<HTMLButtonElement>('.save-row .btn')].find((b) =>
      b.textContent!.includes('Save'),
    )!;

  function check(row: HTMLElement, channel: string, on = true): void {
    const box = [...row.querySelectorAll<HTMLInputElement>('.check input')].find(
      (i) => i.parentElement!.textContent!.trim() === channel,
    )!;
    box.checked = on;
    box.dispatchEvent(new Event('change'));
    fixture.detectChanges();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ScriptAlertsTabComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('has a row per alertcondition title, then alert() calls and order fills', () => {
    render();
    load([{ alertKey: 'Short breakout', enabled: true, channels: ['Telegram'] }]);
    expect(titles()).toEqual(['Long breakout', 'Short breakout', 'alert() calls', 'Order fills']);
    expect(rows()[1].querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true');
    expect(el.textContent).toContain('1 alertcondition() call has');
    // The default message shows through as the template's placeholder.
    const tpl = rows()[0].querySelector('textarea')!;
    expect(tpl.getAttribute('placeholder')).toContain('Price broke above {{plot_0}}');
  });

  it('offers order-fill placeholders only on the order-fills row', () => {
    render();
    load();
    const options = (row: HTMLElement) =>
      [...row.querySelectorAll('select.picker option')].map((o) => (o as HTMLOptionElement).value);
    expect(options(rows()[0])).toContain('{{plot("Lower")}}');
    expect(options(rows()[0])).not.toContain('{{strategy.order.price}}');
    expect(options(rows()[3])).toContain('{{strategy.order.price}}');
    expect(options(rows()[3])).toContain('{{strategy.prev_market_position_size}}');
  });

  it('inserts a placeholder at the caret', () => {
    render();
    load();
    const row = rows()[3];
    const tpl = row.querySelector('textarea')!;
    tpl.value = 'Filled  at x';
    tpl.dispatchEvent(new Event('input'));
    tpl.setSelectionRange(7, 7);
    const picker = row.querySelector<HTMLSelectElement>('select.picker')!;
    picker.value = '{{strategy.order.action}}';
    picker.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(fixture.componentInstance.rows()[3].messageTemplate).toBe(
      'Filled {{strategy.order.action}} at x',
    );
    expect(picker.value).toBe('');
  });

  it('needs a channel and a valid webhook before an enabled alert can be saved', () => {
    render();
    load();
    const row = rows()[0];
    row.querySelector<HTMLButtonElement>('[role="switch"]')!.click();
    fixture.detectChanges();
    expect(rows()[0].textContent).toContain('Choose at least one channel.');
    expect(saveBtn().disabled).toBe(true);

    check(rows()[0], 'Webhook');
    const url = rows()[0].querySelector<HTMLInputElement>('input[type="url"]')!;
    url.value = 'hooks.example.com';
    url.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(rows()[0].textContent).toContain('Enter a full URL');
    expect(url.getAttribute('aria-invalid')).toBe('true');
    expect(saveBtn().disabled).toBe(true);

    url.value = 'https://hooks.example.com/pine';
    url.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(saveBtn().disabled).toBe(false);

    saveBtn().click();
    const put = http.expectOne((r) => r.method === 'PUT' && r.url === ALERTS_URL);
    expect(put.request.body[0]).toEqual({
      alertKey: 'Long breakout',
      enabled: true,
      channels: ['Webhook'],
      messageTemplate: null,
      webhookUrl: 'https://hooks.example.com/pine',
    });
    expect(put.request.body.map((b: { alertKey: string }) => b.alertKey)).toEqual([
      'Long breakout',
      'Short breakout',
      'alert()',
      'order-fills',
    ]);
    put.flush(ok(true));
    // Re-read after saving.
    load([
      {
        alertKey: 'Long breakout',
        enabled: true,
        channels: ['Webhook'],
        webhookUrl: 'https://hooks.example.com/pine',
      },
    ]);
    expect(saveBtn().disabled).toBe(true);
  });

  it('warns about a mistyped placeholder without blocking the save', () => {
    render();
    load();
    check(rows()[1], 'Email');
    const tpl = rows()[1].querySelector('textarea')!;
    tpl.value = 'Short on {{tickr}}';
    tpl.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(rows()[1].querySelector('.row-warn')!.textContent).toContain('{{tickr}}');
    expect(saveBtn().disabled).toBe(false);
  });

  it('falls back to the source when the compile fails, and has no order fills for an indicator', () => {
    render(RSI_INDICATOR_SOURCE);
    http.expectOne(ALERTS_URL).flush(ok([]));
    http.expectOne(COMPILE_URL).flush('down', { status: 503, statusText: 'Unavailable' });
    fixture.detectChanges();
    expect(el.textContent).toContain('read from its source');
    expect(titles()).toEqual(['Overbought', 'alert() calls']);
  });

  it('keeps saved bindings whose alert left the script, flagged', () => {
    render();
    load(
      [{ alertKey: 'Removed condition', enabled: true, channels: ['Email'] }],
      compiled('strategy'),
    );
    expect(titles()).toContain('Removed condition');
    expect(el.querySelector('.orphan-tag')!.textContent).toContain('not in the script');
  });

  it('shows the engine’s refusal on save', () => {
    render();
    load();
    check(rows()[2], 'Telegram');
    rows()[2].querySelector<HTMLButtonElement>('[role="switch"]')!.click();
    fixture.detectChanges();
    saveBtn().click();
    http
      .expectOne((r) => r.method === 'PUT')
      .flush({
        data: null,
        status: false,
        message: 'Telegram is not configured',
        responseCode: '-11',
      });
    fixture.detectChanges();
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('Telegram is not configured');
  });
});
