import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import type { TradingAccountDto } from '@core/api/api.types';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';

import { AccountBindingsEditorComponent } from './account-bindings-editor.component';
import { TypedConfirmDialogComponent } from './typed-confirm-dialog.component';
import type { StrategyAccountBinding } from '../api/scripting-api.types';
import { declareSignalIo } from '@shared/testing/jit-signal-io';

declareSignalIo(AccountBindingsEditorComponent, {
  inputs: ['strategyId', 'isScript', 'symbol', 'strategyName'],
  outputs: ['saved'],
});
declareSignalIo(TypedConfirmDialogComponent, {
  inputs: [
    'open',
    'title',
    'message',
    'details',
    'expected',
    'promptLabel',
    'confirmLabel',
    'tone',
    'busy',
  ],
  outputs: ['confirmed', 'cancelled'],
});

const BASE = 'http://test/api/v1/lascodia-trading-engine';
const BINDINGS_URL = `${BASE}/strategy/41/account-bindings`;
const ACCOUNTS_URL = `${BASE}/trading-account/list`;

function account(over: Partial<TradingAccountDto>): TradingAccountDto {
  return {
    id: 0,
    accountId: null,
    accountName: null,
    brokerServer: null,
    brokerName: 'Exness',
    accountType: 'Demo',
    leverage: 100,
    marginMode: 'Hedging',
    currency: 'USD',
    balance: 1000,
    equity: 1000,
    marginUsed: 0,
    marginAvailable: 1000,
    marginLevel: 0,
    profit: 0,
    credit: 0,
    marginSoMode: null,
    marginSoCall: 0,
    marginSoStopOut: 0,
    maxAbsoluteDailyLoss: 0,
    isActive: true,
    isPaper: false,
    lastSyncedAt: '2026-09-24T00:00:00Z',
    riskProfileId: null,
    ...over,
  };
}

const ACCOUNTS: TradingAccountDto[] = [
  account({ id: 17, accountId: '81234567', accountName: 'Exness Demo 17', accountType: 'Demo' }),
  account({ id: 27, accountId: '99887766', accountName: 'Exness Real 27', accountType: 'Real' }),
  account({
    id: 30,
    accountId: 'P-30',
    accountName: 'Paper 30',
    accountType: 'Demo',
    isPaper: true,
  }),
];

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

describe('AccountBindingsEditorComponent', () => {
  let fixture: ComponentFixture<AccountBindingsEditorComponent>;
  let http: HttpTestingController;
  let el: HTMLElement;

  function render(bindings: StrategyAccountBinding[], opts: { isScript?: boolean } = {}): void {
    fixture = TestBed.createComponent(AccountBindingsEditorComponent);
    fixture.componentRef.setInput('strategyId', 41);
    fixture.componentRef.setInput('isScript', opts.isScript ?? true);
    fixture.componentRef.setInput('symbol', 'EURUSD');
    fixture.componentRef.setInput('strategyName', 'Pine breakout');
    fixture.detectChanges();
    flushLoad(bindings);
    el = fixture.nativeElement as HTMLElement;
  }

  function flushLoad(bindings: StrategyAccountBinding[], accounts = ACCOUNTS): void {
    http.expectOne(BINDINGS_URL).flush(ok(bindings));
    const list = http.expectOne(ACCOUNTS_URL);
    expect(list.request.method).toBe('POST');
    list.flush(paged(accounts));
    fixture.detectChanges();
  }

  const rows = () => [...el.querySelectorAll('tbody tr')];
  const dialog = () => el.querySelector<HTMLElement>('[role="alertdialog"]');
  const confirmBtn = () => dialog()!.querySelector<HTMLButtonElement>('.btn.confirm')!;
  const saveBtn = () =>
    [...el.querySelectorAll<HTMLButtonElement>('.save-row .btn')].find((b) =>
      b.textContent!.includes('Save'),
    )!;

  function chooseAccount(id: number): void {
    const select = el.querySelector<HTMLSelectElement>('.add select')!;
    select.value = String(id);
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
  }

  function clickAdd(): void {
    const button = el.querySelector<HTMLButtonElement>('.add button[type="submit"]')!;
    expect(button.disabled).toBe(false);
    // requestSubmit() runs the browser's constraint validation first — a step / min mismatch on
    // the multiplier once blocked this submit in Chromium without any visible error.
    el.querySelector<HTMLFormElement>('form.add')!.requestSubmit(button);
    fixture.detectChanges();
  }

  function type(text: string): void {
    const input = dialog()!.querySelector<HTMLInputElement>('input.phrase')!;
    input.value = text;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  function flushSave(): Record<string, unknown>[] {
    const put = http.expectOne((r) => r.method === 'PUT' && r.url === BINDINGS_URL);
    const body = put.request.body as Record<string, unknown>[];
    put.flush(ok(true));
    fixture.detectChanges();
    return body;
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [AccountBindingsEditorComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('lists the bound accounts labelled DEMO / REAL and groups the REAL ones in the picker', () => {
    render([
      { tradingAccountId: 17, accountName: 'Exness Demo 17', lotMultiplier: 1, isEnabled: true },
    ]);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].querySelector('.env')!.textContent!.trim()).toBe('DEMO');
    expect(rows()[0].textContent).toContain('#81234567');
    const groups = [...el.querySelectorAll('optgroup')].map((g) => g.getAttribute('label'));
    expect(groups).toEqual(['REAL accounts — real money', 'Demo, contest and paper accounts']);
    expect(el.querySelector('optgroup')!.textContent).toContain('REAL — Exness Real 27');
  });

  it('will not stage a REAL binding until the operator types the account number', () => {
    render([
      { tradingAccountId: 17, accountName: 'Exness Demo 17', lotMultiplier: 1, isEnabled: true },
    ]);
    const saved = vi.fn();
    fixture.componentInstance.saved.subscribe(saved);

    chooseAccount(27);
    expect(el.textContent).toContain('This is a real-money account');
    clickAdd();

    expect(dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain('Bind a REAL-money account');
    expect(dialog()!.textContent).toContain('Type the account number 99887766');
    // Nothing is staged while the dialog is open.
    expect(rows()).toHaveLength(1);
    expect(confirmBtn().disabled).toBe(true);

    type('9988776');
    expect(confirmBtn().disabled).toBe(true);
    type('99887766');
    expect(confirmBtn().disabled).toBe(false);
    confirmBtn().click();
    fixture.detectChanges();

    expect(dialog()).toBeNull();
    expect(rows()).toHaveLength(2);
    expect(rows()[1].querySelector('.env')!.textContent!.trim()).toBe('REAL');
    expect(el.querySelector('.effect')!.textContent).toContain('Exness Real 27 (REAL, lots ×1)');

    saveBtn().click();
    fixture.detectChanges();
    expect(flushSave()).toEqual([
      { tradingAccountId: 17, lotMultiplier: 1, isEnabled: true },
      { tradingAccountId: 27, lotMultiplier: 1, isEnabled: true },
    ]);
    expect(saved).toHaveBeenCalledTimes(1);
    // The engine is the source of truth: the set is re-read after saving.
    flushLoad([
      { tradingAccountId: 17, accountName: 'Exness Demo 17', lotMultiplier: 1, isEnabled: true },
      { tradingAccountId: 27, accountName: 'Exness Real 27', lotMultiplier: 1, isEnabled: true },
    ]);
    expect(rows()).toHaveLength(2);
  });

  it('stages nothing when the REAL confirmation is cancelled', () => {
    render([]);
    chooseAccount(27);
    clickAdd();
    type('99887766');
    dialog()!.querySelector<HTMLButtonElement>('.btn.secondary')!.click();
    fixture.detectChanges();
    expect(dialog()).toBeNull();
    expect(rows()).toHaveLength(0);
    expect(saveBtn().disabled).toBe(true);
  });

  it('asks again before enabling a paused REAL binding, and accepts the account name', () => {
    render([
      { tradingAccountId: 27, accountName: 'Exness Real 27', lotMultiplier: 2, isEnabled: false },
    ]);
    const toggle = rows()[0].querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    toggle.click();
    fixture.detectChanges();

    expect(dialog()!.textContent).toContain('Enable a REAL-money account');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    type('  exness real 27 ');
    confirmBtn().click();
    fixture.detectChanges();
    expect(rows()[0].querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true');

    saveBtn().click();
    fixture.detectChanges();
    expect(flushSave()).toEqual([{ tradingAccountId: 27, lotMultiplier: 2, isEnabled: true }]);
    flushLoad([
      { tradingAccountId: 27, accountName: 'Exness Real 27', lotMultiplier: 2, isEnabled: true },
    ]);
  });

  it('pausing a REAL binding needs no typed confirmation', () => {
    render([
      { tradingAccountId: 27, accountName: 'Exness Real 27', lotMultiplier: 1, isEnabled: true },
    ]);
    rows()[0].querySelector<HTMLButtonElement>('[role="switch"]')!.click();
    fixture.detectChanges();
    expect(dialog()).toBeNull();
    expect(rows()[0].querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('false');
    expect(el.querySelector('.effect')!.textContent).toContain('trades on no account');
  });

  it('binds a demo or paper account without the typed step', () => {
    render([]);
    chooseAccount(30);
    clickAdd();
    expect(dialog()).toBeNull();
    expect(rows()).toHaveLength(1);
    expect(rows()[0].querySelector('.env')!.textContent!.trim()).toBe('PAPER');
  });

  it('treats a bound account missing from the accounts list as REAL', () => {
    render([{ tradingAccountId: 55, accountName: 'Gone', lotMultiplier: 1, isEnabled: false }]);
    expect(rows()[0].querySelector('.env')!.textContent!.trim()).toBe('UNVERIFIED');
    rows()[0].querySelector<HTMLButtonElement>('[role="switch"]')!.click();
    fixture.detectChanges();
    expect(dialog()!.textContent).toContain('an account the console cannot verify');
    type('Gone');
    expect(confirmBtn().disabled).toBe(false);
  });

  it('asks before a non-script strategy loses its last binding (fleet-wide fan-out)', () => {
    render(
      [{ tradingAccountId: 17, accountName: 'Exness Demo 17', lotMultiplier: 1, isEnabled: true }],
      {
        isScript: false,
      },
    );
    rows()[0].querySelector<HTMLButtonElement>('.danger-text')!.click();
    fixture.detectChanges();
    expect(el.querySelector('.effect')!.textContent).toContain('including REAL accounts');
    saveBtn().click();
    fixture.detectChanges();

    expect(dialog()!.textContent).toContain('Let this strategy trade on every account?');
    http.expectNone((r) => r.method === 'PUT');
    type('UNRESTRICTED');
    confirmBtn().click();
    fixture.detectChanges();
    expect(flushSave()).toEqual([]);
    flushLoad([]);
  });

  it('saves an empty set for a script strategy without the fan-out warning', () => {
    render([
      { tradingAccountId: 17, accountName: 'Exness Demo 17', lotMultiplier: 1, isEnabled: true },
    ]);
    rows()[0].querySelector<HTMLButtonElement>('.danger-text')!.click();
    fixture.detectChanges();
    expect(el.querySelector('.effect')!.textContent).toContain('emulator / paper only');
    saveBtn().click();
    fixture.detectChanges();
    expect(dialog()).toBeNull();
    expect(flushSave()).toEqual([]);
    flushLoad([]);
  });

  it('never lets native validation block the add form', () => {
    render([]);
    const form = el.querySelector<HTMLFormElement>('form.add')!;
    expect(form.noValidate).toBe(true);
    const mult = form.querySelector<HTMLInputElement>('input[type="number"]')!;
    mult.value = '1';
    expect(mult.checkValidity()).toBe(true);
  });

  it('refuses a lot multiplier above 10', () => {
    render([
      { tradingAccountId: 17, accountName: 'Exness Demo 17', lotMultiplier: 1, isEnabled: true },
    ]);
    const input = rows()[0].querySelector<HTMLInputElement>('input.mult')!;
    input.value = '12';
    input.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(rows()[0].querySelector('.field-error')!.textContent).toContain('Cannot exceed 10');
    expect(saveBtn().disabled).toBe(true);
  });

  it('refuses to save a live-money binding that was never confirmed (backstop)', () => {
    render([]);
    const cmp = fixture.componentInstance;
    // Simulate a staging path that skipped the dialog.
    cmp.rows.set([
      {
        tradingAccountId: 27,
        accountName: 'Exness Real 27',
        accountNumber: '99887766',
        brokerName: 'Exness',
        currency: 'USD',
        environment: 'REAL',
        lotMultiplier: 1,
        isEnabled: true,
        saved: null,
      },
    ]);
    cmp.save();
    fixture.detectChanges();
    http.expectNone((r) => r.method === 'PUT');
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('Confirm Exness Real 27');
  });

  it('shows the engine’s refusal and keeps the edit', () => {
    render([]);
    chooseAccount(17);
    clickAdd();
    saveBtn().click();
    fixture.detectChanges();
    http
      .expectOne((r) => r.method === 'PUT')
      .flush({
        data: false,
        status: false,
        message: 'Trading account(s) not found: 17',
        responseCode: '-11',
      });
    fixture.detectChanges();
    expect(el.querySelector('[role="alert"]')!.textContent).toContain(
      'Trading account(s) not found: 17',
    );
    expect(rows()).toHaveLength(1);
  });

  it('shows a load failure with a retry', () => {
    fixture = TestBed.createComponent(AccountBindingsEditorComponent);
    fixture.componentRef.setInput('strategyId', 41);
    fixture.detectChanges();
    http
      .expectOne(BINDINGS_URL)
      .flush({ data: null, status: false, message: 'Strategy not found', responseCode: '-14' });
    http.expectOne(ACCOUNTS_URL).flush(paged(ACCOUNTS));
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('Strategy not found');
  });
});
