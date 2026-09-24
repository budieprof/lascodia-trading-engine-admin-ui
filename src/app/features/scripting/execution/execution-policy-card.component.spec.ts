import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';

import { ExecutionPolicyCardComponent } from './execution-policy-card.component';
import { TypedConfirmDialogComponent } from './typed-confirm-dialog.component';
import type { ExecutionPolicy } from '../api/scripting-api.types';
import { declareSignalIo } from '../testing/jit-signal-io';

declareSignalIo(ExecutionPolicyCardComponent, {
  inputs: ['strategyId', 'policy', 'isScript'],
  outputs: ['policyChanged'],
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

const POLICY_URL = 'http://test/api/v1/lascodia-trading-engine/strategy/41/execution-policy';

describe('ExecutionPolicyCardComponent', () => {
  let fixture: ComponentFixture<ExecutionPolicyCardComponent>;
  let http: HttpTestingController;
  let el: HTMLElement;

  function render(policy: ExecutionPolicy | null, isScript = true): void {
    fixture = TestBed.createComponent(ExecutionPolicyCardComponent);
    fixture.componentRef.setInput('strategyId', 41);
    fixture.componentRef.setInput('policy', policy);
    fixture.componentRef.setInput('isScript', isScript);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  }

  const current = () => el.querySelector('.option.current')?.getAttribute('data-policy') ?? null;
  const switchBtn = () => el.querySelector<HTMLButtonElement>('.option .btn')!;
  const dialog = () => el.querySelector<HTMLElement>('[role="alertdialog"]');

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ExecutionPolicyCardComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('marks the current policy and explains what Direct skips and keeps', () => {
    render('Direct');
    expect(current()).toBe('Direct');
    expect(switchBtn().textContent).toContain('Switch to Standard');
    expect(el.textContent).toContain('Direct skips');
    expect(el.textContent).toContain('Hawkes');
    expect(el.textContent).toContain('Kill switches');
    expect(el.textContent).toContain('never blocked by entry gates');
  });

  it('asks before changing, and a cancel changes nothing', () => {
    render('Direct');
    switchBtn().click();
    fixture.detectChanges();
    expect(dialog()!.textContent).toContain('Switch to Standard?');
    expect(dialog()!.textContent).toContain('diverge from the backtest');
    dialog()!.querySelector<HTMLButtonElement>('.btn.secondary')!.click();
    fixture.detectChanges();
    expect(dialog()).toBeNull();
    expect(current()).toBe('Direct');
    http.expectNone(POLICY_URL);
  });

  it('switches only after the engine accepts', () => {
    render('Standard', false);
    const changed = vi.fn();
    fixture.componentInstance.policyChanged.subscribe(changed);
    switchBtn().click();
    fixture.detectChanges();
    expect(dialog()!.textContent).toContain('Still enforced');
    dialog()!.querySelector<HTMLButtonElement>('.btn.confirm')!.click();
    fixture.detectChanges();

    const req = http.expectOne(POLICY_URL);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ policy: 'Direct' });
    expect(current()).toBe('Standard');
    req.flush({ data: true, status: true, message: 'Successful', responseCode: '00' });
    fixture.detectChanges();

    expect(current()).toBe('Direct');
    expect(changed).toHaveBeenCalledWith('Direct');
    expect(dialog()).toBeNull();
  });

  it('keeps the old policy and shows why when the engine refuses', () => {
    render('Direct');
    switchBtn().click();
    fixture.detectChanges();
    dialog()!.querySelector<HTMLButtonElement>('.btn.confirm')!.click();
    http
      .expectOne(POLICY_URL)
      .flush({
        data: false,
        status: false,
        message: "Policy must be 'Standard' or 'Direct'",
        responseCode: '-11',
      });
    fixture.detectChanges();
    expect(current()).toBe('Direct');
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('Policy must be');
  });

  it('says so when the engine did not report a policy', () => {
    render(null);
    expect(current()).toBeNull();
    expect(el.textContent).toContain('did not report');
    const labels = [...el.querySelectorAll('.option .btn')].map((b) => b.textContent!.trim());
    expect(labels).toEqual(['Set Standard…', 'Set Direct…']);
  });
});
