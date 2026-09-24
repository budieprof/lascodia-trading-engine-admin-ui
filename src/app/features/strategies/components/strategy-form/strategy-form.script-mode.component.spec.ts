import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { of } from 'rxjs';

import { StrategyFormComponent } from './strategy-form.component';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { StrategiesService } from '@core/services/strategies.service';
import { RiskProfilesService } from '@core/services/risk-profiles.service';
import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { StrategyDto } from '@core/api/api.types';
import { PINE_EDITOR_LOADER } from '@features/scripting/components/pine-editor/pine-editor.component';
import { PineCatalogService } from '@features/scripting/services/pine-catalog.service';
import {
  DEFAULT_STRATEGY_SCRIPT,
  type ScriptDraft,
} from '@features/scripting/components/script-authoring/authoring-mode';

// Script authoring inside the strategy form: the Rules | Script switch, what the form renders in
// each mode, and the payloads script mode submits. The script panel's own HTTP (compile, PUT
// script) is covered by script-authoring.component.spec.ts.
//
// Under the JIT test harness a child component's signal inputs are not bound from the parent
// template, so these specs set the form's own signals and stand in for the panel where the flow
// crosses into it.

const SCRIPT = `//@version=6
strategy("Saved", overlay = true)
len = input.int(14, "Length")
plot(ta.ema(close, len))
`;

const STRATEGY: StrategyDto = {
  id: 42,
  name: 'Pine EMA',
  description: 'desc',
  strategyType: 'RuleBased',
  symbol: 'EURUSD',
  timeframe: 'H1',
  parametersJson: null,
  status: 'Paused',
  pauseReason: null,
  riskProfileId: 5,
  lifecycleStage: 'Draft',
  lifecycleStageEnteredAt: null,
  rolloutPct: null,
  lastSignalAt: null,
  createdAt: '2026-09-01T00:00:00Z',
  riskOverridesJson: null,
  sizingConfigJson: null,
  sessionFilterJson: null,
  regimeGateJson: null,
  multiTimeframeGateJson: null,
  authoringMode: 'Script',
  scriptSource: SCRIPT,
  scriptInputs: { in_3_len: 20 },
  scriptLanguageVersion: 6,
  executionPolicy: 'Direct',
  accountBindingCount: 0,
};

interface PanelStub {
  prepareSubmit: ReturnType<typeof vi.fn>;
  isDirty: ReturnType<typeof vi.fn>;
  saveScript: ReturnType<typeof vi.fn>;
}

describe('StrategyFormComponent — Pine script authoring', () => {
  let fixture: ComponentFixture<StrategyFormComponent>;
  let cmp: StrategyFormComponent;
  let host: HTMLElement;
  let submitted: any[];
  let cancelled: number;
  let notify: Record<string, ReturnType<typeof vi.fn>>;

  function create(strategy: StrategyDto | null): void {
    fixture = TestBed.createComponent(StrategyFormComponent);
    cmp = fixture.componentInstance;
    // Signal inputs cannot be set under the JIT harness: swap in writable signals.
    (cmp as any).strategy = signal<StrategyDto | null>(strategy);
    (cmp as any).open = signal(true);
    submitted = [];
    cancelled = 0;
    cmp.submitted.subscribe((v) => submitted.push(v));
    cmp.cancelled.subscribe(() => cancelled++);
    fixture.detectChanges(); // runs ngOnInit (builds the form)
    // Seed the form from the strategy (a changes map, whichever ngOnChanges signature is in play).
    (cmp as any).ngOnChanges({ strategy: {}, open: {} });
    fixture.detectChanges();
    host = fixture.nativeElement;
  }

  /** Stands in for the script panel the form delegates to. */
  function panel(draft: ScriptDraft | null, dirty = false, saves = true): PanelStub {
    const stub: PanelStub = {
      prepareSubmit: vi.fn(async () => draft),
      isDirty: vi.fn(() => dirty),
      saveScript: vi.fn(async () => saves),
    };
    (cmp as any).scriptAuthoring = stub;
    return stub;
  }

  beforeEach(() => {
    notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
    TestBed.configureTestingModule({
      imports: [StrategyFormComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
        {
          provide: StrategiesService,
          useValue: {
            listTemplates: () => of({ status: true, data: [] }),
            listPreviewSnapshots: () => of({ status: true, data: [] }),
            getParameterSchema: () => of({ status: true, data: null }),
            summariseDsl: () => of({ status: true, data: 'summary' }),
            getVersions: () => of({ status: true, data: [] }),
          },
        },
        { provide: RiskProfilesService, useValue: { list: () => of({ status: true, data: { data: [] } }) } },
        { provide: CurrencyPairsService, useValue: { list: () => of({ status: true, data: { data: [] } }) } },
        { provide: NotificationService, useValue: notify },
        {
          provide: PineCatalogService,
          useValue: {
            catalog: signal(null),
            libraries: signal([]),
            status: signal('idle'),
            ensureLoaded: () => undefined,
            ensureLibraries: () => undefined,
            refreshLibraries: () => Promise.resolve(),
          },
        },
        // No CodeMirror in jsdom: the editor's chunk loader never resolves.
        { provide: PINE_EDITOR_LOADER, useValue: () => new Promise(() => undefined) },
      ],
    });
  });

  afterEach(() => fixture?.destroy());

  describe('the authoring switch', () => {
    beforeEach(() => create(null));

    it('appears only for RuleBased and defaults to rules, with the rules block and DSL preview', () => {
      fixture.detectChanges();
      expect(host.querySelector('app-authoring-mode-switch')).toBeNull();

      cmp.form.patchValue({ strategyType: 'RuleBased' });
      fixture.detectChanges();
      expect(cmp.isRuleBased()).toBe(true);
      expect(cmp.authoringMode()).toBe('rules');
      expect(host.querySelector('app-authoring-mode-switch')).toBeTruthy();
      expect(host.querySelector('app-script-authoring')).toBeNull();
      expect(host.querySelector('textarea[formcontrolname="parametersJson"]')).toBeTruthy();
      expect(host.querySelector('.preview-panel')).toBeTruthy();
      expect(host.querySelector('.dialog.dialog-wide')).toBeNull();
    });

    it('in script mode swaps the rules block and the DSL preview for the script panel', () => {
      cmp.form.patchValue({ strategyType: 'RuleBased' });
      cmp.authoringMode.set('script');
      fixture.detectChanges();
      expect(cmp.isScriptAuthoring()).toBe(true);
      expect(host.querySelector('app-script-authoring')).toBeTruthy();
      expect(host.querySelector('textarea[formcontrolname="parametersJson"]')).toBeNull();
      expect(host.querySelector('app-dsl-builder')).toBeNull();
      expect(host.querySelector('.preview-panel')).toBeNull();
      expect(host.querySelector('.dialog.dialog-wide')).toBeTruthy();
      expect(cmp.scriptDraft().source).toBe(DEFAULT_STRATEGY_SCRIPT);
    });

    it('never authors a script for another strategy type', () => {
      cmp.form.patchValue({ strategyType: 'RSIReversion' });
      cmp.authoringMode.set('script');
      fixture.detectChanges();
      expect(cmp.isScriptAuthoring()).toBe(false);
      expect(host.querySelector('app-script-authoring')).toBeNull();
    });

    it('passes the first typed symbol and the timeframe to the panel', () => {
      cmp.form.patchValue({ symbol: 'gbpusd, eurusd', timeframe: 'H4' });
      expect(cmp.scriptSymbol()).toBe('GBPUSD');
      expect(cmp.scriptTimeframe()).toBe('H4');
    });
  });

  describe('create', () => {
    beforeEach(() => {
      create(null);
      cmp.onNameTyped(); // an operator-typed name is never overwritten by the auto-name
      cmp.form.patchValue({
        name: 'Pine EMA',
        symbol: 'EURUSD, GBPUSD',
        timeframe: 'H1',
        strategyType: 'RuleBased',
        riskProfileId: 3,
      });
      cmp.authoringMode.set('script');
    });

    it('emits scriptSource / scriptInputs / executionPolicy instead of parametersJson', async () => {
      panel({ source: SCRIPT, inputs: { in_3_len: 30 }, executionPolicy: 'Standard' });
      await cmp.submitScript();
      expect(submitted).toHaveLength(1);
      expect(submitted[0]).toEqual({
        name: 'Pine EMA',
        description: '',
        riskProfileId: 3,
        riskOverridesJson: null,
        sizingConfigJson: null,
        sessionFilterJson: null,
        regimeGateJson: null,
        multiTimeframeGateJson: null,
        strategyType: 'RuleBased',
        symbol: 'EURUSD',
        symbols: ['EURUSD', 'GBPUSD'],
        timeframe: 'H1',
        scriptSource: SCRIPT,
        scriptInputs: { in_3_len: 30 },
        executionPolicy: 'Standard',
      });
    });

    it('submits nothing when the panel refuses (compile errors, not a strategy, engine down)', async () => {
      const stub = panel(null);
      await cmp.submitScript();
      expect(stub.prepareSubmit).toHaveBeenCalled();
      expect(submitted).toEqual([]);
      expect(cancelled).toBe(0);
    });

    it('routes the form submit through submitScript in script mode', async () => {
      fixture.detectChanges();
      // After rendering: the view query would otherwise replace the stand-in.
      const stub = panel({ source: SCRIPT, inputs: {}, executionPolicy: 'Direct' });
      const form = host.querySelector('form') as HTMLFormElement;
      form.dispatchEvent(new Event('submit'));
      await Promise.resolve();
      expect(stub.prepareSubmit).toHaveBeenCalled();
    });
  });

  describe('edit', () => {
    beforeEach(() => create(STRATEGY));

    it('opens a script strategy in script mode with its saved script, inputs and policy', () => {
      expect(cmp.isScriptAuthoring()).toBe(true);
      expect(cmp.scriptDraft()).toEqual({ source: SCRIPT, inputs: { in_3_len: 20 }, executionPolicy: 'Direct' });
    });

    it('saves a changed script through the panel and closes when the form is unchanged', async () => {
      const draft: ScriptDraft = { source: `${SCRIPT}// x\n`, inputs: { in_3_len: 20 }, executionPolicy: 'Direct' };
      const stub = panel(draft, true);
      await cmp.submitScript();
      expect(stub.saveScript).toHaveBeenCalledWith(42, draft);
      expect(submitted).toEqual([]);
      expect(cancelled).toBe(1);
      expect(notify['success']).toHaveBeenCalled();
    });

    it('then emits the metadata update — never the script, never parametersJson', async () => {
      const stub = panel({ source: SCRIPT, inputs: { in_3_len: 25 }, executionPolicy: 'Direct' }, true);
      cmp.form.patchValue({ name: 'Renamed' });
      cmp.form.markAsDirty();
      cmp.updateChangeReason.set('  tighter stop  ');
      await cmp.submitScript();
      expect(stub.saveScript).toHaveBeenCalled();
      expect(submitted).toHaveLength(1);
      expect(submitted[0]).toMatchObject({ name: 'Renamed', riskProfileId: 5, changeReason: 'tighter stop' });
      for (const key of ['parametersJson', 'scriptSource', 'scriptInputs', 'strategyType', 'symbol']) {
        expect(key in submitted[0]).toBe(false);
      }
    });

    it('skips the script endpoint when only the metadata changed', async () => {
      const stub = panel({ source: SCRIPT, inputs: { in_3_len: 20 }, executionPolicy: 'Direct' }, false);
      cmp.form.patchValue({ description: 'new description' });
      cmp.form.markAsDirty();
      await cmp.submitScript();
      expect(stub.saveScript).not.toHaveBeenCalled();
      expect(submitted[0]).toMatchObject({ description: 'new description' });
    });

    it('stays open when the engine refuses the script', async () => {
      panel({ source: SCRIPT, inputs: {}, executionPolicy: 'Direct' }, true, false);
      cmp.form.markAsDirty();
      await cmp.submitScript();
      expect(submitted).toEqual([]);
      expect(cancelled).toBe(0);
    });

    it('re-derives the mode and draft when the form is pointed at another strategy', () => {
      cmp.scriptDraft.update((d) => ({ ...d, source: 'edited' }));
      (cmp as any).strategy.set(null);
      expect(cmp.authoringMode()).toBe('rules');
      expect(cmp.scriptDraft().source).toBe(DEFAULT_STRATEGY_SCRIPT);
      (cmp as any).strategy.set({ ...STRATEGY, authoringMode: 'Dsl', scriptSource: null });
      expect(cmp.authoringMode()).toBe('rules');
    });
  });
});
