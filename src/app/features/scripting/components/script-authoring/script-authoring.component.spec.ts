import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal, type WritableSignal } from '@angular/core';

import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import type { StrategyDto } from '@core/api/api.types';
import type { ScriptCompileResult } from '@core/api/scripting.types';
import { ScriptingService } from '@core/services/scripting.service';
import { ScriptDialogService } from '../../shared/script-dialog.service';
import { ScriptAuthoringComponent } from './script-authoring.component';
import { DEFAULT_STRATEGY_SCRIPT, draftFor, type ScriptDraft } from './authoring-mode';
import { STRATEGY_EXAMPLES } from '../../onboarding/strategy-examples';

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

  /** The questions the panel asks (conflicts, PS9002), answered per test. */
  let dialogs: { ask: ReturnType<typeof vi.fn>; confirm: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    dialogs = {
      ask: vi.fn(async () => ({ choice: null, text: '' })),
      confirm: vi.fn(async () => false),
    };
    TestBed.configureTestingModule({
      imports: [ScriptAuthoringComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://test' } },
        { provide: ScriptDialogService, useValue: dialogs },
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

  describe('PE-01 — saves carry the revision they started from', () => {
    const REVISED = { ...STRATEGY, scriptRevision: 'r1' } as unknown as StrategyDto;
    const ok = (rev: string) => ({
      status: true,
      data: { success: true, diagnostics: [], scriptRevision: rev },
      message: 'Saved',
      responseCode: '00',
    });

    it('sends expectedScriptRevision, then the revision of its own last save', async () => {
      setup(REVISED, compile());
      const first = cmp.saveScript(7, {
        source: `${SCRIPT}// a`,
        inputs: {},
        executionPolicy: 'Direct',
      });
      await tick();
      const r1 = http.expectOne(`${BASE}/strategy/7/script`);
      expect(r1.request.body.expectedScriptRevision).toBe('r1');
      r1.flush(ok('r2'));
      expect(await first).toBe(true);
      expect(cmp.base().revision).toBe('r2');

      const second = cmp.saveScript(7, {
        source: `${SCRIPT}// b`,
        inputs: {},
        executionPolicy: 'Direct',
      });
      await tick();
      const r2 = http.expectOne(`${BASE}/strategy/7/script`);
      expect(r2.request.body.expectedScriptRevision).toBe('r2');
      r2.flush(ok('r3'));
      expect(await second).toBe(true);
    });

    async function conflictThen(choice: 'overwrite' | 'reload' | null) {
      const ask = dialogs.ask;
      ask.mockImplementation(async () => ({ choice, text: '' }));
      setup(REVISED, compile());
      (workbench as Record<string, unknown>)['currentSource'] = vi.fn(() => SCRIPT);
      (workbench as Record<string, unknown>)['replaceSource'] = vi.fn();
      const mine: ScriptDraft = {
        source: `${SCRIPT}// mine`,
        inputs: { len: 30 },
        executionPolicy: 'Direct',
      };
      const done = cmp.saveScript(7, mine);
      await tick();
      http.expectOne(`${BASE}/strategy/7/script`).flush({
        status: false,
        data: null,
        message: 'changed since it was loaded',
        responseCode: '-409',
      });
      await tick();
      http.expectOne(`${BASE}/strategy/7`).flush({
        status: true,
        data: {
          ...STRATEGY,
          scriptSource: `${SCRIPT}// theirs`,
          scriptInputs: {},
          scriptRevision: 'r9',
        },
        message: null,
        responseCode: '00',
      });
      await tick();
      return { ask, done };
    }

    it('a stale save compares mine with theirs; "save over it" resends on their revision', async () => {
      const { ask, done } = await conflictThen('overwrite');
      await tick();
      const opts = (
        ask.mock.calls[0] as unknown as [{ compare: { before: string; after: string } }]
      )[0];
      expect(opts.compare.before).toContain('// theirs');
      expect(opts.compare.after).toContain('// mine');
      const retry = http.expectOne(`${BASE}/strategy/7/script`);
      expect(retry.request.body.expectedScriptRevision).toBe('r9');
      retry.flush(ok('r10'));
      expect(await done).toBe(true);
    });

    it('"load the saved script" replaces the draft and does not save', async () => {
      const { done } = await conflictThen('reload');
      expect(await done).toBe(false);
      expect(draft().source).toContain('// theirs');
      expect(cmp.base().revision).toBe('r9');
      expect(cmp.message()).toContain('Loaded the saved script');
      http.verify();
    });

    it('keeping on editing saves nothing and says why', async () => {
      const { done } = await conflictThen(null);
      expect(await done).toBe(false);
      expect(cmp.message()).toContain('changed since you opened it');
      http.verify();
    });
  });

  describe('PE-09 — a script without a stop on live bindings', () => {
    const PS9002 = {
      code: 'PS9002',
      severity: 'warning' as const,
      message: 'Live accounts require a stop-loss',
      line: 3,
      column: 5,
      endLine: 3,
      endColumn: 9,
    };

    it('asks before saving, and saves nothing when declined', async () => {
      const confirm = dialogs.confirm;
      setup(STRATEGY, compile({ diagnostics: [PS9002] }));
      await cmp.prepareSubmit();
      const done = cmp.saveScript(7);
      await tick();
      http.expectOne(`${BASE}/strategy/7/account-bindings`).flush({
        status: true,
        data: [{ tradingAccountId: 3, accountName: 'Demo 1', lotMultiplier: 1, isEnabled: true }],
        message: null,
        responseCode: '00',
      });
      expect(await done).toBe(false);
      expect(confirm).toHaveBeenCalled();
      expect(cmp.message()).toContain('Add a protective stop');
      http.verify();
    });

    it('saves without asking when no account is bound', async () => {
      const confirm = dialogs.confirm;
      setup(STRATEGY, compile({ diagnostics: [PS9002] }));
      await cmp.prepareSubmit();
      const done = cmp.saveScript(7);
      await tick();
      http
        .expectOne(`${BASE}/strategy/7/account-bindings`)
        .flush({ status: true, data: [], message: null, responseCode: '00' });
      await tick();
      http.expectOne(`${BASE}/strategy/7/script`).flush({
        status: true,
        data: { scriptRevision: 'x' },
        message: 'Saved',
        responseCode: '00',
      });
      expect(await done).toBe(true);
      expect(confirm).not.toHaveBeenCalled();
    });
  });

  describe('PE-I3 — local draft of an unsaved edit', () => {
    const KEY = 'lascodia.pine.draft.v1:strategy:7';
    beforeEach(() => localStorage.clear());

    it('offers a kept draft that differs from the saved script, restores it, and a save clears it', async () => {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          source: `${SCRIPT}// kept`,
          inputs: { len: 33 },
          baseRevision: 'r0',
          savedAt: Date.now(),
        }),
      );
      setup({ ...STRATEGY, scriptRevision: 'r1' } as unknown as StrategyDto, compile());
      (workbench as Record<string, unknown>)['replaceSource'] = vi.fn((s: string) =>
        cmp.setSource(s),
      );
      (cmp as unknown as { offerLocalDraft(k: string): void }).offerLocalDraft(KEY);
      expect(cmp.restorable()?.source).toContain('// kept');
      expect(cmp.restoreOverNewer()).toBe(true);
      cmp.restoreLocalDraft();
      expect(draft().source).toContain('// kept');
      expect(draft().inputs).toEqual({ len: 33 });

      const done = cmp.saveScript(7);
      await tick();
      http.expectOne(`${BASE}/strategy/7/script`).flush({
        status: true,
        data: { scriptRevision: 'r2' },
        message: 'Saved',
        responseCode: '00',
      });
      expect(await done).toBe(true);
      expect(localStorage.getItem(KEY)).toBeNull();
    });

    it('a kept draft equal to the saved script is not offered and is removed', () => {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          source: SCRIPT,
          inputs: { len: 20 },
          baseRevision: null,
          savedAt: Date.now(),
        }),
      );
      setup(STRATEGY, compile());
      (cmp as unknown as { offerLocalDraft(k: string): void }).offerLocalDraft(KEY);
      expect(cmp.restorable()).toBeNull();
      expect(localStorage.getItem(KEY)).toBeNull();
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

    it('PE-04: a background compile never rewrites the overrides — they are cleaned only at save', async () => {
      setup(STRATEGY, compile());
      draft.set({ ...draft(), inputs: { len: 99, renamedGroup: 5 } });
      cmp.onCompiled(compile({ declaration: null, success: false }));
      cmp.onCompiled(compile());
      // A group renamed mid-typing changes the input ids: the tuned values must survive it.
      expect(draft().inputs).toEqual({ len: 99, renamedGroup: 5 });
      expect(cmp.shown()?.inputs).toHaveLength(1);
      // The preview runs with the values as they act on the script…
      expect(cmp.effectiveInputs()).toEqual({ len: 50, renamedGroup: 5 });
      // …and the save sends them cleaned.
      expect((await cmp.prepareSubmit())?.inputs).toEqual({ len: 50 });
    });

    it('PE-05: stored overrides equal to their defaults do not make the form look edited', () => {
      // An approved optimization stores every searched input, defaults included.
      setup({ ...STRATEGY, scriptInputs: { len: 14 } } as unknown as StrategyDto, compile());
      cmp.onCompiled(compile());
      expect(cmp.isDirty()).toBe(false);
      cmp.setInputs({});
      expect(cmp.isDirty()).toBe(false);
      cmp.setInputs({ len: 15 });
      expect(cmp.isDirty()).toBe(true);
    });

    it('only allows the two execution policies', () => {
      setup(null, compile());
      cmp.setPolicy('Standard');
      expect(draft().executionPolicy).toBe('Standard');
      cmp.setPolicy('Nonsense' as any);
      expect(draft().executionPolicy).toBe('Direct');
    });
  });
  describe('PE-I9: example gallery', () => {
    const example = STRATEGY_EXAMPLES.find((e) => e.id === 'rsi-reversion')!;

    function withEditor(text: string) {
      const editor = { replaceSource: vi.fn(), currentSource: vi.fn(() => text) };
      cmp.workbench = { ...workbench, ...editor } as any;
      return editor;
    }

    it('puts an example in a new strategy’s editor without asking', async () => {
      setup(null, compile());
      cmp.galleryOpen.set(true);
      const editor = withEditor(DEFAULT_STRATEGY_SCRIPT);
      await cmp.useExample(example);
      expect(dialogs.confirm).not.toHaveBeenCalled();
      expect(editor.replaceSource).toHaveBeenCalledWith(example.source);
      expect(cmp.galleryOpen()).toBe(false);
    });

    it('asks before replacing a script the operator wrote, and keeps it on No', async () => {
      setup(STRATEGY, compile());
      const editor = withEditor(SCRIPT);
      await cmp.useExample(example);
      expect(dialogs.confirm.mock.calls[0][0].title).toContain('RSI reversion');
      expect(editor.replaceSource).not.toHaveBeenCalled();
      dialogs.confirm.mockResolvedValueOnce(true);
      await cmp.useExample(example);
      expect(editor.replaceSource).toHaveBeenCalledWith(example.source);
    });
  });
});
