import { CREATABLE_STRATEGY_TYPES } from '../../../../core/api/api.types';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { SimpleChange, signal } from '@angular/core';
import { of } from 'rxjs';

import { StrategyFormComponent } from './strategy-form.component';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { StrategiesService } from '@core/services/strategies.service';
import { RiskProfilesService } from '@core/services/risk-profiles.service';
import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { StrategyDto } from '@core/api/api.types';

// The component is large (≈2400 lines, ≈40 dependencies). Template-level tests
// would require fully rendering a recursive form + script panel + several
// shared components, which is more setup than value. The substantive logic
// worth testing is the pure-function helpers (`equitySparklinePoints`,
// `equityBaselineY`, the diff-row computation), so those are exercised here
// against a constructed instance.

describe('StrategyFormComponent (logic)', () => {
  let cmp: StrategyFormComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [StrategyFormComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
      ],
    });
    const fixture = TestBed.createComponent(StrategyFormComponent);
    cmp = fixture.componentInstance;
  });

  describe('equitySparklinePoints', () => {
    it('returns empty for empty curve', () => {
      expect(cmp.equitySparklinePoints([], 100, 50)).toBe('');
    });

    it('maps a flat curve to a flat baseline near the bottom', () => {
      const pts = cmp.equitySparklinePoints([100, 100, 100], 100, 50).split(' ');
      // All y coords identical (range=0 → division by 1 → y = height - 0 = height)
      const ys = pts.map((p) => p.split(',')[1]);
      expect(new Set(ys).size).toBe(1);
    });

    it('maps a monotonic-up curve to monotonically-decreasing y values (svg origin top-left)', () => {
      const pts = cmp.equitySparklinePoints([1, 2, 3, 4, 5], 100, 50);
      const ys = pts.split(' ').map((p) => parseFloat(p.split(',')[1]));
      for (let i = 1; i < ys.length; i++) {
        expect(ys[i]).toBeLessThanOrEqual(ys[i - 1]);
      }
    });

    it('places the first point at x=0 and the last at x=width', () => {
      const pts = cmp.equitySparklinePoints([1, 2, 3], 100, 50).split(' ');
      const firstX = parseFloat(pts[0].split(',')[0]);
      const lastX = parseFloat(pts[pts.length - 1].split(',')[0]);
      expect(firstX).toBe(0);
      expect(lastX).toBe(100);
    });
  });

  describe('equityBaselineY', () => {
    it('returns the full height for an empty curve', () => {
      expect(cmp.equityBaselineY([], 1000, 80)).toBe(80);
    });

    it('places the baseline at the top when initial equals max', () => {
      // initial = max → (max - min)/range = 1 → y = height - height = 0
      expect(cmp.equityBaselineY([100, 200], 200, 80)).toBe(0);
    });

    it('places the baseline at the bottom when initial equals min', () => {
      // initial = min → 0/range = 0 → y = height
      expect(cmp.equityBaselineY([100, 200], 100, 80)).toBe(80);
    });
  });

  describe('overlayCurves / overlayBounds (computed signals)', () => {
    it('produces no curves when there is nothing to plot', () => {
      expect(cmp.overlayCurves().length).toBe(0);
      expect(cmp.overlayBounds()).toBeNull();
    });
  });

  describe('snapshot scope toggle', () => {
    it('starts in "mine" scope', () => {
      expect(cmp.snapshotScope()).toBe('mine');
    });

    it('toggles between mine and all', () => {
      cmp.toggleSnapshotScope();
      expect(cmp.snapshotScope()).toBe('all');
      cmp.toggleSnapshotScope();
      expect(cmp.snapshotScope()).toBe('mine');
    });
  });

  describe('hidden curves', () => {
    it('starts empty', () => {
      expect(cmp.hiddenCurves().size).toBe(0);
    });

    it('toggleCurveVisibility flips membership', () => {
      cmp.toggleCurveVisibility('s1');
      expect(cmp.hiddenCurves().has('s1')).toBe(true);
      cmp.toggleCurveVisibility('s1');
      expect(cmp.hiddenCurves().has('s1')).toBe(false);
    });
  });
});

// ── Legacy JSON rules, parameters and edit-mode behaviour ─────────────────
//
// Services are stubbed so each test controls the engine's answers. The
// `strategy` signal input cannot be set under the JIT harness, so edit-mode
// tests swap in a writable signal before running ngOnInit.

const LEGACY_RULE = JSON.stringify({
  Name: 'EURUSD H1 Rule',
  Symbol: 'EURUSD',
  Timeframe: 'H1',
  EntryConditionsRoot: { Leaf: { Type: 'Spread' } },
});

const LEGACY: StrategyDto = {
  id: 42,
  name: 'EURUSD H1 Rule',
  description: 'desc',
  strategyType: 'RuleBased',
  symbol: 'EURUSD',
  timeframe: 'H1',
  parametersJson: LEGACY_RULE,
  status: 'Paused',
  pauseReason: null,
  riskProfileId: 5,
  lifecycleStage: 'Draft',
  lifecycleStageEnteredAt: null,
  rolloutPct: null,
  lastSignalAt: null,
  createdAt: '2026-09-01T00:00:00Z',
  riskOverridesJson: null,
  sizingConfigJson: '{"mode":"FixedLot","value":0.1}',
  sessionFilterJson: null,
  regimeGateJson: null,
  multiTimeframeGateJson: null,
  authoringMode: 'Dsl',
} as StrategyDto;

const COMPOSITE: StrategyDto = {
  ...LEGACY,
  id: 43,
  name: 'EURUSD H1 CompML',
  strategyType: 'CompositeML',
  parametersJson: '{"period":14}',
  authoringMode: null,
} as StrategyDto;

describe('StrategyFormComponent (legacy rules, parameters, edit mode)', () => {
  let cmp: StrategyFormComponent;
  let svc: Record<string, ReturnType<typeof vi.fn>>;
  let submitted: any[];

  function create(strategy: StrategyDto | null): void {
    const fixture = TestBed.createComponent(StrategyFormComponent);
    cmp = fixture.componentInstance;
    (cmp as any).strategy = signal<StrategyDto | null>(strategy);
    submitted = [];
    cmp.submitted.subscribe((v) => submitted.push(v));
    cmp.ngOnInit();
  }

  beforeEach(() => {
    vi.useRealTimers();
    svc = {
      listTemplates: vi.fn().mockReturnValue(
        of({
          status: true,
          data: [
            { id: 1, name: 'legacy', strategyType: 'RuleBased' },
            { id: 2, name: 'ml', strategyType: 'CompositeML' },
          ],
        }),
      ),
      listPreviewSnapshots: vi.fn().mockReturnValue(of({ status: true, data: [] })),
      getParameterSchema: vi.fn().mockReturnValue(of({ status: true, data: null })),
      createTemplate: vi.fn(),
      getVersions: vi.fn().mockReturnValue(of({ status: true, data: [] })),
    };
    TestBed.configureTestingModule({
      imports: [StrategyFormComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
        { provide: StrategiesService, useValue: svc },
        {
          provide: RiskProfilesService,
          useValue: { list: () => of({ status: true, data: { data: [] } }) },
        },
        {
          provide: CurrencyPairsService,
          useValue: { list: () => of({ status: true, data: { data: [] } }) },
        },
        {
          provide: NotificationService,
          useValue: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
        },
      ],
    });
  });

  describe('create mode', () => {
    beforeEach(() => create(null));

    it('offers only engine StrategyType values an operator can create', () => {
      // "LlmDsl" is not an engine type, the CME type is CmeDeepBookOrderflow, and
      // LlmProposal is engine-promoted (as RuleBased Pine), never hand-created.
      expect(CREATABLE_STRATEGY_TYPES).not.toContain('LlmDsl' as never);
      expect(CREATABLE_STRATEGY_TYPES).not.toContain('CmeOrderflow' as never);
      expect(CREATABLE_STRATEGY_TYPES).not.toContain('LlmProposal');
      expect(CREATABLE_STRATEGY_TYPES).toContain('CmeDeepBookOrderflow');
    });

    it('authors RuleBased and LlmProposal as Pine scripts — there is no rules mode', () => {
      expect(cmp.authoringMode()).toBe('script');
      expect(cmp.isScriptAuthoring()).toBe(true);
      cmp.form.patchValue({ strategyType: 'LlmProposal' });
      expect(cmp.isScriptAuthoring()).toBe(true);
      expect(cmp.isLegacyRules()).toBe(false);
    });

    it('never offers a legacy JSON-rules template to load', () => {
      expect(cmp.availableTemplates().map((t) => t.id)).toEqual([2]);
    });

    it('submits Parameters JSON for a non-Pine type', () => {
      cmp.form.patchValue({
        strategyType: 'CompositeML',
        symbol: 'EURUSD',
        name: 'ml',
        parametersJson: '{"period":14}',
      });
      expect(cmp.isScriptAuthoring()).toBe(false);
      cmp.onSubmit();
      expect(submitted).toHaveLength(1);
      expect(submitted[0].parametersJson).toBe('{"period":14}');
      // The engine requires a description; the name stands in.
      expect(submitted[0].description).toBe('ml');
    });
  });

  describe('a legacy JSON-rules strategy', () => {
    beforeEach(() => create(LEGACY));

    it('is read-only: flagged legacy, Save blocked, nothing submitted', () => {
      expect(cmp.isLegacyRules()).toBe(true);
      expect(cmp.isScriptAuthoring()).toBe(false);
      expect(cmp.saveBlocked()).toBe(true);
      expect(cmp.saveBlockedReason()).toMatch(/rewrite the strategy in Pine/);
      cmp.onSubmit();
      expect(submitted).toHaveLength(0);
    });

    it('treats a RuleBased row with no script and no authoring mode as legacy too', () => {
      (cmp as any).strategy.set({ ...LEGACY, authoringMode: null, scriptSource: null });
      expect(cmp.isLegacyRules()).toBe(true);
    });
  });

  describe('edit mode', () => {
    beforeEach(() => create(COMPOSITE));

    it('never sends symbol, timeframe or type, and clears what the operator cleared', () => {
      cmp.form.patchValue({ riskProfileId: null, sizingConfigJson: '' });
      cmp.updateChangeReason.set('tighten stop');
      cmp.onSubmit();
      expect(submitted).toHaveLength(1);
      const body = submitted[0];
      expect('symbol' in body).toBe(false);
      expect('timeframe' in body).toBe(false);
      expect('strategyType' in body).toBe(false);
      expect(body.riskProfileId).toBe(0); // the engine's "detach" sentinel
      expect(body.sizingConfigJson).toBe(''); // '' clears; null would mean "unchanged"
      expect(body.changeReason).toBe('tighten stop');
      expect(body.parametersJson).toBe('{"period":14}');
    });

    it('does not reset the edits when only the parent’s saving/error inputs change', () => {
      cmp.form.patchValue({ name: 'edited' });
      cmp.ngOnChanges({ saving: new SimpleChange(false, true, false) });
      cmp.ngOnChanges({ submitError: new SimpleChange(null, 'refused', false) });
      expect(cmp.form.value.name).toBe('edited');
      cmp.ngOnChanges({ strategy: new SimpleChange(null, COMPOSITE, false) });
      expect(cmp.form.value.name).toBe('EURUSD H1 CompML');
    });

    it('exposes the current values to the version diff', () => {
      cmp.form.patchValue({ description: 'new description' });
      expect(cmp.currentVersionFields()).toMatchObject({
        name: 'EURUSD H1 CompML',
        description: 'new description',
        riskProfileId: 5,
        sizingConfigJson: '{"mode":"FixedLot","value":0.1}',
      });
    });

    it('closes itself after a clone so the copy can open', () => {
      let cancelled = 0;
      cmp.cancelled.subscribe(() => cancelled++);
      cmp.openClone();
      expect(cmp.cloneOpen()).toBe(true);
      cmp.onCloned();
      expect(cmp.cloneOpen()).toBe(false);
      expect(cancelled).toBe(1);
    });
  });
});
