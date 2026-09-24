import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal, type WritableSignal } from '@angular/core';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import type { StrategyDto } from '@core/api/api.types';
import type { ScriptCompileResult } from '@core/api/scripting.types';
import { ScriptingService } from '@core/services/scripting.service';
import { ScriptAuthoringComponent } from './script-authoring.component';
import { AuthoringModeSwitchComponent } from './authoring-mode-switch.component';
import { draftFor, type ScriptDraft } from './authoring-mode';

// The script panel's own behaviour: what it hands the strategy form to save, and the exact
// `PUT strategy/{id}/script` it sends (HTTP through the real ScriptingService against
// HttpTestingController). The editor workbench is stood in for — its compile loop is covered by
// the language specs — and signal inputs/models are swapped for writable signals, since the JIT
// test harness cannot bind them.

const BASE = 'http://test/api/v1/lascodia-trading-engine';
const SCRIPT = '//@version=6\nstrategy("S")\nlen = input.int(14, "Length")\n';

const compile = (partial: Partial<ScriptCompileResult> = {}): ScriptCompileResult => ({
  success: true,
  diagnostics: [],
  declaration: { kind: 'strategy', title: 'S' },
  inputs: [
    { id: 'len', kind: 'int', title: 'Length', defaultValue: 14, minValue: 1, maxValue: 50 },
  ],
  ...partial,
});

/**
 * Lets the awaiting code attach its handlers before a response is flushed. Under vitest the
 * specs' async/await is native (the CLI downlevels it for zone.js in real builds), so a promise
 * rejected in the same tick would otherwise be reported by zone.js as unhandled.
 */
const tick = async () => {
  for (let i = 0; i < 3; i++) await Promise.resolve();
};

const STRATEGY = {
  id: 7,
  name: 'My strategy',
  strategyType: 'RuleBased',
  scriptSource: SCRIPT,
  scriptInputs: { len: 20 },
  executionPolicy: 'Direct',
} as unknown as StrategyDto;

describe('ScriptAuthoringComponent', () => {
  let cmp: ScriptAuthoringComponent;
  let draft: WritableSignal<ScriptDraft>;
  let http: HttpTestingController;
  let workbench: {
    compileNow: ReturnType<typeof vi.fn>;
    reveal: ReturnType<typeof vi.fn>;
    showResult: ReturnType<typeof vi.fn>;
  };

  function setup(strategy: StrategyDto | null, result: ScriptCompileResult | null): void {
    const fixture = TestBed.createComponent(ScriptAuthoringComponent);
    cmp = fixture.componentInstance;
    draft = signal(draftFor(strategy));
    (cmp as any).draft = draft;
    (cmp as any).strategy = signal(strategy);
    workbench = { compileNow: vi.fn(async () => result), reveal: vi.fn(), showResult: vi.fn() };
    cmp.workbench = workbench as any;
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ScriptAuthoringComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  describe('prepareSubmit', () => {
    it('returns the draft with its inputs coerced to what the compiled script declares', async () => {
      setup(null, compile());
      draft.set({ source: SCRIPT, inputs: { len: 99, gone: 1 }, executionPolicy: 'Standard' });
      const out = await cmp.prepareSubmit();
      expect(out).toEqual({ source: SCRIPT, inputs: { len: 50 }, executionPolicy: 'Standard' });
      expect(cmp.message()).toBeNull();
    });

    it('refuses compile errors, jumps to the first one and says why', async () => {
      setup(
        null,
        compile({
          success: false,
          diagnostics: [
            {
              code: 'PS1001',
              severity: 'warning',
              message: 'w',
              line: 1,
              column: 1,
              endLine: 1,
              endColumn: 2,
            },
            {
              code: 'PS2002',
              severity: 'error',
              message: 'Undeclared x',
              line: 4,
              column: 3,
              endLine: 4,
              endColumn: 4,
            },
          ],
        }),
      );
      expect(await cmp.prepareSubmit()).toBeNull();
      expect(workbench.reveal).toHaveBeenCalledWith(4, 3);
      expect(cmp.message()).toContain('line 4: Undeclared x');
    });

    it('refuses a script that is not a strategy', async () => {
      setup(null, compile({ declaration: { kind: 'library', title: 'L' } }));
      expect(await cmp.prepareSubmit()).toBeNull();
      expect(cmp.message()).toContain('declares library()');
    });

    it('refuses when the engine could not compile at all', async () => {
      setup(null, null);
      expect(await cmp.prepareSubmit()).toBeNull();
      expect(cmp.message()).toContain('could not compile');
    });
  });

  describe('saveScript — PUT strategy/{id}/script', () => {
    it('sends the source and input overrides and resolves true', async () => {
      setup(STRATEGY, compile());
      const saved: number[] = [];
      TestBed.inject(ScriptingService).strategyScriptSaved$.subscribe((id) => saved.push(id));
      const done = cmp.saveScript(7, {
        source: SCRIPT,
        inputs: { len: 25 },
        executionPolicy: 'Direct',
      });
      await tick();
      const req = http.expectOne(`${BASE}/strategy/7/script`);
      expect(req.request.method).toBe('PUT');
      expect(req.request.body).toEqual({ source: SCRIPT, inputs: { len: 25 } });
      req.flush({ status: true, data: true, message: null, responseCode: '00' });
      expect(await done).toBe(true);
      expect(saved).toEqual([7]);
    });

    it('marks the diagnostics of a refused compile and resolves false', async () => {
      setup(STRATEGY, compile());
      const refused = compile({
        success: false,
        diagnostics: [
          {
            code: 'PS2003',
            severity: 'error',
            message: 'Bad',
            line: 2,
            column: 1,
            endLine: 2,
            endColumn: 3,
          },
        ],
      });
      const done = cmp.saveScript(7);
      await tick();
      http
        .expectOne(`${BASE}/strategy/7/script`)
        .flush({ status: false, data: refused, message: 'PS2003: Bad', responseCode: '-11' });
      expect(await done).toBe(false);
      expect(workbench.showResult).toHaveBeenCalledWith(refused);
      expect(cmp.message()).toBe('The engine refused the script: PS2003: Bad');
    });

    it('reports a transport failure', async () => {
      setup(STRATEGY, compile());
      const done = cmp.saveScript(7);
      await tick();
      http
        .expectOne(`${BASE}/strategy/7/script`)
        .flush(null, { status: 0, statusText: 'Unknown Error' });
      expect(await done).toBe(false);
      expect(cmp.message()).toContain('could not be reached');
    });
  });

  describe('draft bookkeeping', () => {
    it('knows when the script or its inputs differ from the saved strategy', () => {
      setup(STRATEGY, compile());
      expect(cmp.isDirty()).toBe(false);
      cmp.setInputs({ len: 21 });
      expect(cmp.isDirty()).toBe(true);
      cmp.setInputs({ len: 20 });
      cmp.setSource(`${SCRIPT}// x`);
      expect(cmp.isDirty()).toBe(true);
    });

    it('prunes overrides the compiled script no longer declares, but not on a failed compile', () => {
      setup(STRATEGY, compile());
      draft.set({ ...draft(), inputs: { len: 20, removed: 5 } });
      cmp.onCompiled(compile({ declaration: null, success: false }));
      expect(draft().inputs).toEqual({ len: 20, removed: 5 });
      cmp.onCompiled(compile());
      expect(draft().inputs).toEqual({ len: 20 });
      expect(cmp.shown()?.inputs).toHaveLength(1);
    });

    it('only allows the two execution policies', () => {
      setup(null, compile());
      cmp.setPolicy('Standard');
      expect(draft().executionPolicy).toBe('Standard');
      cmp.setPolicy('Nonsense' as any);
      expect(draft().executionPolicy).toBe('Direct');
    });
  });
});

describe('AuthoringModeSwitchComponent', () => {
  it('switches mode, and cannot when locked', () => {
    TestBed.configureTestingModule({ imports: [AuthoringModeSwitchComponent] });
    const fixture = TestBed.createComponent(AuthoringModeSwitchComponent);
    const cmp = fixture.componentInstance;
    const mode = signal<'rules' | 'script'>('rules');
    const locked = signal(false);
    (cmp as any).mode = mode;
    (cmp as any).locked = locked;
    fixture.detectChanges();
    const buttons = () => [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')];
    buttons()[1].click();
    expect(mode()).toBe('script');
    locked.set(true);
    fixture.detectChanges();
    expect(buttons()[0].disabled).toBe(true);
    cmp.choose('rules');
    expect(mode()).toBe('script');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'Fixed for an existing strategy',
    );
  });
});
