import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { declareSignalIo } from '@shared/testing/jit-signal-io';

import {
  PREVIEW_DEBOUNCE_MS,
  ParameterSpaceEditorComponent,
} from './parameter-space-editor.component';
import type { ParameterSpaceDto } from './research.types';

declareSignalIo(ParameterSpaceEditorComponent, {
  inputs: ['strategyId', 'canRun'],
  outputs: ['started'],
});

const BASE = 'http://test/api/v1/lascodia-trading-engine';
const ok = <T>(data: T, responseCode = '00', status = true) => ({
  data,
  status,
  message: status ? 'Successful' : 'Refused',
  responseCode,
});
const settle = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

function space(over: Partial<ParameterSpaceDto> = {}): ParameterSpaceDto {
  return {
    strategyId: 7,
    spaceId: 1,
    searched: [
      {
        id: 'Length',
        title: 'Length',
        group: null,
        tooltip: null,
        inputKind: 'int',
        kind: 'integer',
        min: 2,
        max: 50,
        step: 2,
        choices: null,
        options: null,
        current: 20,
        default: 14,
        rangeSource: 'declared',
        declaredMin: 2,
        declaredMax: 50,
        declaredStep: 2,
      },
    ],
    skipped: [],
    initialCandidates: 25,
    maxInitialCandidates: 64,
    objectives: ['HealthScore', 'ExpectancyR'],
    constraints: ['minTrades'],
    searchSpec: null,
    problems: [],
    ...over,
  };
}

describe('ParameterSpaceEditorComponent (PE-I4)', () => {
  let fixture: ComponentFixture<ParameterSpaceEditorComponent>;
  let http: HttpTestingController;
  let el: HTMLElement;

  beforeEach(async () => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      imports: [ParameterSpaceEditorComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ParameterSpaceEditorComponent);
    fixture.componentRef.setInput('strategyId', 7);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
    http.expectOne(`${BASE}/strategy/7/script/parameter-space`).flush(ok(space()));
    await settle();
    fixture.detectChanges();
  });

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  const input = (label: string) =>
    el.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const type = (label: string, value: string) => {
    const i = input(label);
    i.value = value;
    i.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };

  it('shows the script’s own space and starts an ordinary run without a spec', async () => {
    expect(el.querySelector('[data-testid="pse-grid"]')!.textContent).toContain(
      '25 starting candidates',
    );
    expect(el.textContent).toContain('No changes');
    let started: number | null = null;
    fixture.componentInstance.started.subscribe((id) => (started = id));

    (el.querySelector('[data-testid="pse-start"]') as HTMLButtonElement).click();
    const req = http.expectOne(`${BASE}/strategy-feedback/optimization/trigger`);
    expect(req.request.body).toEqual({ strategyId: 7, triggerType: 'Manual' });
    req.flush(ok(88));
    await settle();

    expect(started).toBe(88);
  });

  it('checks an edited range with the engine, then starts the run with that spec', async () => {
    type('Length: lowest value', '10');
    type('Length: highest value', '30');
    expect((el.querySelector('[data-testid="pse-start"]') as HTMLButtonElement).disabled).toBe(
      true,
    ); // checking

    await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS);
    const preview = http.expectOne(`${BASE}/strategy/7/script/parameter-space`);
    expect(preview.request.method).toBe('POST');
    expect(preview.request.body).toEqual({
      ranges: { Length: { min: 10, max: 30, step: 2 } },
      locked: {},
      objective: 'HealthScore',
    });
    preview.flush(
      ok(
        space({
          initialCandidates: 11,
          searched: [{ ...space().searched[0], min: 10, max: 30, rangeSource: 'spec' }],
        }),
      ),
    );
    await settle();
    fixture.detectChanges();

    expect(el.querySelector('[data-testid="pse-accepted"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="pse-grid"]')!.textContent).toContain(
      '11 starting candidates',
    );
    expect(el.querySelector('[data-testid="pse-summary"]')!.textContent).toContain(
      'Length: search 10 to 30 in steps of 2',
    );

    (el.querySelector('[data-testid="pse-start"]') as HTMLButtonElement).click();
    const trigger = http.expectOne(`${BASE}/strategy-feedback/optimization/trigger`);
    expect(trigger.request.body).toEqual({
      strategyId: 7,
      triggerType: 'Manual',
      searchSpec: {
        ranges: { Length: { min: 10, max: 30, step: 2 } },
        locked: {},
        objective: 'HealthScore',
      },
    });
    trigger.flush(ok(89));
    await settle();
  });

  it('shows the engine’s problems and blocks the start', async () => {
    type('Length: lowest value', '1');
    await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS);
    http
      .expectOne(`${BASE}/strategy/7/script/parameter-space`)
      .flush(ok(space({ problems: ["Length: 1 is below the input's minval 2"] })));
    await settle();
    fixture.detectChanges();

    expect(el.querySelector('[data-testid="pse-problems"]')!.textContent).toContain(
      'below the input',
    );
    expect((el.querySelector('[data-testid="pse-start"]') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('catches a reversed range before asking the engine', async () => {
    type('Length: lowest value', '40');
    type('Length: highest value', '10');
    await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS);
    http.expectNone(`${BASE}/strategy/7/script/parameter-space`);
    expect(el.querySelector('[data-testid="pse-problems"]')!.textContent).toContain(
      'must be below the highest',
    );
  });

  it('explains a run that is already going (-409)', async () => {
    (el.querySelector('[data-testid="pse-start"]') as HTMLButtonElement).click();
    http.expectOne(`${BASE}/strategy-feedback/optimization/trigger`).flush(ok(77, '-409', false));
    await settle();
    fixture.detectChanges();

    expect(el.querySelector('[data-testid="pse-start-error"]')!.textContent).toContain(
      'already queued or running for this strategy (#77)',
    );
  });
});
