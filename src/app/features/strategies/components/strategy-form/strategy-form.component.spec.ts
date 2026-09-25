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
import { DSL_EXAMPLES } from '../../dsl/dsl-examples';

// The component is large (≈2400 lines, ≈40 dependencies). Template-level tests
// would require fully rendering a recursive form + dsl-builder + several
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

// ── Rule authoring, validation and edit-mode behaviour ────────────────────
//
// Services are stubbed so each test controls the engine's answers. The
// `strategy` signal input cannot be set under the JIT harness, so edit-mode
// tests swap in a writable signal before running ngOnInit.

const V1_RULE = JSON.stringify({
  Name: 'EURUSD H1 Rule',
  Symbol: 'EURUSD',
  Timeframe: 'H1',
  Direction: 'Buy',
  EntryConditionsRoot: {
    Leaf: { Type: 'Spread', Spread: { Operator: 'LessThan', Threshold: 1.5, Mode: 'Pips' } },
  },
  StopLossAtrMultiplier: 1.5,
  TakeProfitAtrMultiplier: 2.5,
});

const STRATEGY: StrategyDto = {
  id: 42,
  name: 'EURUSD H1 Rule',
  description: 'desc',
  strategyType: 'RuleBased',
  symbol: 'EURUSD',
  timeframe: 'H1',
  parametersJson: V1_RULE,
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
} as StrategyDto;

describe('StrategyFormComponent (rules, validation, edit mode)', () => {
  let cmp: StrategyFormComponent;
  let svc: Record<string, ReturnType<typeof vi.fn>>;
  let submitted: any[];
  let changed: number;

  /** Engine verdict: valid, with a summary. */
  const valid = (summary = 'This strategy buys…') =>
    of({
      status: true,
      responseCode: '00',
      message: null,
      data: { summary, isValid: true, errors: [], warnings: [] },
    });

  function create(strategy: StrategyDto | null): void {
    const fixture = TestBed.createComponent(StrategyFormComponent);
    cmp = fixture.componentInstance;
    (cmp as any).strategy = signal<StrategyDto | null>(strategy);
    submitted = [];
    changed = 0;
    cmp.submitted.subscribe((v) => submitted.push(v));
    cmp.strategyChanged.subscribe(() => changed++);
    cmp.ngOnInit();
  }

  beforeEach(() => {
    vi.useRealTimers();
    svc = {
      listTemplates: vi.fn().mockReturnValue(of({ status: true, data: [] })),
      listPreviewSnapshots: vi.fn().mockReturnValue(of({ status: true, data: [] })),
      getParameterSchema: vi.fn().mockReturnValue(of({ status: true, data: null })),
      summariseDsl: vi.fn().mockReturnValue(valid()),
      upgradeDsl: vi.fn(),
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

    it('loads an example as a RuleBased v2 rule stamped with the chosen symbol/timeframe', () => {
      cmp.form.patchValue({ symbol: 'GBPJPY', timeframe: 'H4' });
      cmp.loadDslExample(DSL_EXAMPLES[0].id);
      const json = JSON.parse(cmp.form.value.parametersJson);
      expect(cmp.form.value.strategyType).toBe('RuleBased');
      expect(json.dslVersion).toBe(2);
      expect(json.symbol).toBe('GBPJPY');
      expect(json.timeframe).toBe('H4');
      expect(cmp.isDslType()).toBe(true);
    });

    it('fills an empty Symbol from the example', () => {
      cmp.loadDslExample(DSL_EXAMPLES[3].id);
      expect(cmp.form.value.symbol).toBe('GBPUSD');
    });

    it('lists the fourteen condition types in the help text catalogue', () => {
      expect(cmp.conditionTypes).toHaveLength(14);
      expect(cmp.indicatorCatalogue.map((i) => i.kind)).toContain('RocPercent');
    });

    it('shows console-side errors at once and blocks Save while they stand', () => {
      cmp.form.patchValue({ strategyType: 'RuleBased', symbol: 'EURUSD', name: 'x' });
      cmp.form.patchValue({ parametersJson: '{ "name": ' });
      expect(cmp.dslErrorCount()).toBe(1);
      expect(cmp.dslIssues()[0].message).toMatch(/Invalid JSON/);
      expect(cmp.saveBlocked()).toBe(true);
      expect(cmp.saveBlockedReason()).toMatch(/Fix 1 rule error/);
    });

    it('prefers the engine verdict once it matches the JSON on screen', () => {
      svc['summariseDsl'].mockReturnValue(
        of({
          status: true,
          responseCode: '00',
          message: null,
          data: {
            summary: null,
            isValid: false,
            errors: [{ path: 'entryConditionsRoot.leaf', message: 'engine says no' }],
            warnings: [],
          },
        }),
      );
      cmp.form.patchValue({ strategyType: 'RuleBased', symbol: 'EURUSD', name: 'x' });
      cmp.loadDslExample(DSL_EXAMPLES[1].id);
      expect(cmp.dslIssueSource()).toBe('checked in this console');
      (cmp as any).runDslCheck();
      expect(cmp.dslIssueSource()).toBe('checked by the engine');
      expect(cmp.dslIssues()).toEqual([
        { path: 'entryConditionsRoot.leaf', message: 'engine says no', severity: 'error' },
      ]);
      expect(svc['summariseDsl']).toHaveBeenCalledWith(cmp.form.value.parametersJson, 'H1');
    });

    it('validates with the engine before creating, and creates new rules on v2', () => {
      cmp.form.patchValue({ strategyType: 'RuleBased', symbol: 'EURUSD', name: 'Spread rule' });
      cmp.form.patchValue({ parametersJson: V1_RULE });
      cmp.onSubmit();
      expect(svc['summariseDsl']).toHaveBeenCalled();
      expect(submitted).toHaveLength(1);
      const rules = JSON.parse(submitted[0].parametersJson);
      expect(rules.dslVersion).toBe(2);
      // v1 Spread measured the bar range — carried over as BarRange.
      expect(rules.entryConditionsRoot.leaf.type).toBe('BarRange');
      // The engine requires a description; the name stands in.
      expect(submitted[0].description).toBe('Spread rule');
    });

    it('does not submit when the engine rejects the rules', () => {
      svc['summariseDsl'].mockReturnValue(
        of({ status: false, responseCode: '-11', message: 'Name is empty', data: null }),
      );
      cmp.form.patchValue({ strategyType: 'RuleBased', symbol: 'EURUSD', name: 'x' });
      cmp.loadDslExample(DSL_EXAMPLES[0].id);
      cmp.onSubmit();
      expect(submitted).toHaveLength(0);
      expect(cmp.dslErrorCount()).toBe(1);
    });

    it('keeps the rules in step with the symbol and timeframe as they are picked', () => {
      cmp.form.patchValue({ strategyType: 'RuleBased' });
      cmp.loadDslExample(DSL_EXAMPLES[0].id);
      cmp.form.patchValue({ symbol: 'AUDUSD' });
      cmp.form.patchValue({ timeframe: 'M15' });
      const json = JSON.parse(cmp.form.value.parametersJson);
      expect(json.symbol).toBe('AUDUSD');
      expect(json.timeframe).toBe('M15');
    });
  });

  describe('edit mode', () => {
    beforeEach(() => create(STRATEGY));

    it('seeds the form from the strategy', () => {
      expect(cmp.form.value.name).toBe('EURUSD H1 Rule');
      expect(cmp.isDslType()).toBe(true);
      expect(cmp.canUpgradeDsl()).toBe(true);
    });

    it('never sends symbol, timeframe or type, and clears what the operator cleared', () => {
      cmp.form.patchValue({ riskProfileId: null, sizingConfigJson: '' });
      cmp.updateChangeReason.set('tighten stop');
      (cmp as any).dslServer.set({
        key: (cmp as any).dslKey(),
        result: { summary: 's', isValid: true, errors: [], warnings: [] },
      });
      cmp.onSubmit();
      expect(submitted).toHaveLength(1);
      const body = submitted[0];
      expect('symbol' in body).toBe(false);
      expect('timeframe' in body).toBe(false);
      expect('strategyType' in body).toBe(false);
      expect(body.riskProfileId).toBe(0); // the engine's "detach" sentinel
      expect(body.sizingConfigJson).toBe(''); // '' clears; null would mean "unchanged"
      expect(body.changeReason).toBe('tighten stop');
      // An existing v1 rule is not silently moved to v2 by a save.
      expect(JSON.parse(body.parametersJson).dslVersion).toBeUndefined();
    });

    it('does not reset the edits when only the parent’s saving/error inputs change', () => {
      cmp.form.patchValue({ name: 'edited' });
      cmp.ngOnChanges({ saving: new SimpleChange(false, true, false) });
      cmp.ngOnChanges({ submitError: new SimpleChange(null, 'refused', false) });
      expect(cmp.form.value.name).toBe('edited');
      cmp.ngOnChanges({ strategy: new SimpleChange(null, STRATEGY, false) });
      expect(cmp.form.value.name).toBe('EURUSD H1 Rule');
    });

    it('upgrades a v1 strategy through the engine and reloads it', () => {
      const upgraded = JSON.stringify({ ...JSON.parse(V1_RULE), DslVersion: 2 });
      svc['upgradeDsl'].mockReturnValue(of({ status: true, data: upgraded }));
      cmp.askUpgrade();
      expect(cmp.upgradeConfirmOpen()).toBe(true);
      cmp.confirmUpgrade();
      expect(svc['upgradeDsl']).toHaveBeenCalledWith(42, { silent: true });
      expect(cmp.form.value.parametersJson).toBe(upgraded);
      expect(cmp.upgradeConfirmOpen()).toBe(false);
      expect(changed).toBe(1);
    });

    it('keeps the upgrade dialog open with the engine’s reason when it refuses', () => {
      svc['upgradeDsl'].mockReturnValue(of({ status: false, message: 'Already v2' }));
      cmp.askUpgrade();
      cmp.confirmUpgrade();
      expect(cmp.upgradeConfirmOpen()).toBe(true);
      expect(cmp.upgradeError()).toBe('Already v2');
      expect(changed).toBe(0);
    });

    it('exposes the current values to the version diff', () => {
      cmp.form.patchValue({ description: 'new description' });
      expect(cmp.currentVersionFields()).toMatchObject({
        name: 'EURUSD H1 Rule',
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
