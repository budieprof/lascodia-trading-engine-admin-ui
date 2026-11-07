import { afterEach, describe, expect, it } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { provideAuthWithPermissions } from '@core/testing/auth-test-double';
import { declareSignalIo } from '@shared/testing/jit-signal-io';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { ConfigHashBadgeComponent } from '@features/strategies/components/config-hash-badge/config-hash-badge.component';
import { RunManifestCardComponent, type ManifestRun } from './run-manifest-card.component';

declareSignalIo(RunManifestCardComponent, { inputs: ['run'] });
declareSignalIo(ConfigHashBadgeComponent, { inputs: ['hash', 'currentHash'] });
declareSignalIo(ConfirmDialogComponent, {
  inputs: ['open', 'title', 'message', 'confirmLabel', 'confirmVariant', 'loading'],
  outputs: ['confirm', 'cancelled'],
});

const BASE = 'http://test/api/v1/lascodia-trading-engine';
const ok = <T>(data: T) => ({ data, status: true, message: 'Successful', responseCode: '00' });
const settle = () => new Promise((r) => setTimeout(r, 0));

function run(extra: Partial<ManifestRun> = {}): ManifestRun {
  return {
    id: 900,
    strategyId: 9,
    status: 'Completed',
    fromDate: '2024-01-01T00:00:00',
    toDate: '2025-01-01T00:00:00',
    resultJson: JSON.stringify({
      AmbiguousBars: 12,
      MagnifierCoverage: { Tick: 0, M1: 0.98, Lower: 0, Ohlc: 0.02, Bars: 6000 },
    }),
    ...extra,
  } as ManifestRun;
}

describe('RunManifestCardComponent (U11 / U12 — C9, C3)', () => {
  let fixture: ComponentFixture<RunManifestCardComponent>;
  let http: HttpTestingController;
  let el: HTMLElement;

  function setup(r: ManifestRun, ...permissions: string[]): void {
    TestBed.configureTestingModule({
      imports: [RunManifestCardComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideAuthWithPermissions(...permissions),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(RunManifestCardComponent);
    fixture.componentRef.setInput('run', r);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
    http.expectOne(`${BASE}/backtest/list`).flush(
      ok({
        pager: {},
        data: [
          { id: 900, fromDate: 'x', toDate: 'y' },
          { id: 812, fromDate: '2024-01-01', toDate: '2025-01-01', queueSource: 'Manual' },
        ],
      }),
    );
  }

  afterEach(() => http.verify());

  it('says when there is no manifest, and shows the intrabar evidence of the result', async () => {
    setup(run(), 'strategies.read');
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="rm-no-manifest"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="rm-intrabar"]')!.textContent).toContain('12 bar(s)');
    expect(el.querySelector('[data-testid="rm-intrabar"]')!.textContent).toContain('M1 98.0%');
    // A reader cannot queue a re-run.
    expect(el.querySelector('[data-testid="rm-rerun"]')).toBeNull();
    // The other runs of the strategy are offered for a diff (not itself).
    expect([...el.querySelectorAll('option')].map((o) => o.value)).toEqual(['', '812']);
  });

  it('diffs against another run and queues a re-run only after the confirm', async () => {
    setup(
      run({
        manifestJson: JSON.stringify({
          engine: { informationalVersion: 'b1' },
          strategy: { strategyConfigHash: 'a'.repeat(64) },
        }),
      }),
      'access.analyst',
    );
    await settle();
    fixture.detectChanges();
    expect(el.textContent).toContain('b1');
    expect(el.querySelector('[data-testid="config-hash"]')!.textContent).toContain('aaaaaaaa');

    fixture.componentInstance.otherId.set(812);
    const diffDone = fixture.componentInstance.loadDiff();
    http.expectOne(`${BASE}/backtest/900/diff/812?maxTrades=50`).flush(
      ok({
        leftId: 900,
        rightId: 812,
        sameDataFingerprint: true,
        sameManifestInputs: false,
        verdict: 'inputs differ',
        manifest: [
          {
            path: 'config.keys.Backtest:Evidence:IntrabarResolution',
            left: 'Pessimistic',
            right: null,
          },
        ],
        metrics: [{ metric: 'WinRate', left: 0.5, right: 0.55, delta: -0.05 }],
        trades: {
          leftTrades: 10,
          rightTrades: 11,
          identical: 9,
          changed: 1,
          onlyLeft: 0,
          onlyRight: 1,
          firstDivergenceUtc: null,
          differences: [],
        },
        notes: [],
      }),
    );
    await diffDone;
    fixture.detectChanges();
    const diff = el.querySelector('[data-testid="rm-diff-result"]')!.textContent!;
    expect(diff).toContain('inputs differ');
    expect(diff).toContain('55.0%'); // WinRate is a fraction
    expect(diff).toContain('9 identical');

    (el.querySelector('[data-testid="rm-rerun"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    http.expectNone(`${BASE}/backtest/900/rerun`);
    const rerunDone = fixture.componentInstance.rerun();
    http.expectOne(`${BASE}/backtest/900/rerun`).flush(ok(901));
    await rerunDone;
    fixture.detectChanges();
    expect(el.textContent).toContain('Re-run queued as #901');
  });
});
