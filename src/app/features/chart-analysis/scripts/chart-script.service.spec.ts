import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Injector } from '@angular/core';
import { firstValueFrom, of, throwError } from 'rxjs';

import { ScriptingApiError, ScriptingService } from '@core/services/scripting.service';
import { StrategiesService } from '@core/services/strategies.service';
import { NotificationService } from '@core/notifications/notification.service';
import { ThemeService, type Theme } from '@core/theme/theme.service';
import type {
  ChartIndicatorScriptDto,
  ScriptInputDto,
  ScriptInputValues,
  ScriptRunRequest,
} from '@core/api/scripting.types';
import {
  ChartScriptService,
  DRAFTS_STORAGE_KEY,
  LEGACY_STORAGE_KEY,
  savedScriptId,
  startingValues,
  type ChartScriptItem,
} from './chart-script.service';

function dto(
  id: number,
  name: string,
  pineSource = `//@version=6\nindicator("${name}")`,
  inputs: ScriptInputValues | null = null,
): ChartIndicatorScriptDto {
  return {
    id,
    name,
    kind: 'indicator',
    pineSource,
    inputs,
    createdAt: '2026-10-06T00:00:00Z',
    updatedAt: '2026-10-06T00:00:00Z',
  };
}

function legacy(id: string, name: string, source = `//@version=6\nindicator("${name}")`) {
  return { id, name, source, kind: 'indicator', updatedAt: 1 };
}

function make(scripting: Partial<Record<keyof ScriptingService, unknown>>) {
  const notify = { error: vi.fn(), success: vi.fn(), warning: vi.fn() };
  const theme = { current: 'light' as Theme };
  const injector = Injector.create({
    providers: [
      { provide: ScriptingService, useValue: { listChartScripts: () => of([]), ...scripting } },
      {
        provide: StrategiesService,
        useValue: { list: () => of({ status: true, data: { data: [] } }) },
      },
      { provide: NotificationService, useValue: notify },
      { provide: ThemeService, useValue: { theme: () => theme.current } },
      { provide: ChartScriptService, useClass: ChartScriptService },
    ],
  });
  return { svc: injector.get(ChartScriptService), notify, theme };
}

describe('ChartScriptService — engine-backed "My scripts"', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('loads the list from the engine on construction', () => {
    const { svc } = make({ listChartScripts: () => of([dto(7, 'EMA')]) });
    expect(svc.savedScripts().map((s) => [s.id, s.name])).toEqual([['7', 'EMA']]);
  });

  it('uploads localStorage scripts once and clears the key only when all succeed', () => {
    localStorage.setItem(
      LEGACY_STORAGE_KEY,
      JSON.stringify([legacy('a', 'One'), legacy('b', 'Two')]),
    );
    let next = 10;
    const createChartScript = vi.fn((req: { name: string; pineSource: string }) =>
      of(dto(next++, req.name, req.pineSource)),
    );
    const { svc, notify } = make({ createChartScript });
    expect(createChartScript).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
    expect(
      svc
        .savedScripts()
        .map((s) => s.name)
        .sort(),
    ).toEqual(['One', 'Two']);
    expect(notify.success).toHaveBeenCalled();
  });

  it('keeps the key and retries only transient failures; skips already-uploaded ones on retry', () => {
    localStorage.setItem(
      LEGACY_STORAGE_KEY,
      JSON.stringify([legacy('a', 'One'), legacy('b', 'Flaky')]),
    );
    const createChartScript = vi.fn((req: { name: string; pineSource: string }) =>
      req.name === 'Flaky'
        ? throwError(() => new ScriptingApiError('Engine unreachable', null, null, 0))
        : of(dto(1, req.name, req.pineSource)),
    );
    const { svc, notify } = make({ createChartScript });
    expect(
      JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY)!).map((s: { id: string }) => s.id),
    ).toEqual(['b']);
    expect(svc.savedScriptsError()).toContain('could not be moved');
    expect(notify.error).toHaveBeenCalledTimes(1);
    expect(svc.savedScripts().map((s) => s.id)).toEqual(['1', 'local-b']);

    createChartScript.mockClear();
    const scripting = (svc as unknown as { scripting: Record<string, unknown> }).scripting;
    scripting['listChartScripts'] = () => of([dto(1, 'One')]);
    svc.loadSaved().subscribe();
    expect(createChartScript.mock.calls.map((c) => c[0].name)).toEqual(['Flaky']);
  });

  it('a 5xx is transient too', () => {
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify([legacy('a', 'One')]));
    make({
      createChartScript: () =>
        throwError(() => new ScriptingApiError('Server error', null, null, 500)),
    });
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).not.toBeNull();
    expect(localStorage.getItem(DRAFTS_STORAGE_KEY)).toBeNull();
  });

  it('a compile refusal (-11) becomes an unsaved draft, clears the main key and toasts once', async () => {
    localStorage.setItem(
      LEGACY_STORAGE_KEY,
      JSON.stringify([legacy('a', 'One'), legacy('b', 'Bad', 'broken')]),
    );
    const createChartScript = vi.fn((req: { name: string; pineSource: string }) =>
      req.name === 'Bad'
        ? throwError(() => new ScriptingApiError('PS2001 at 3:6: nope', '-11'))
        : of(dto(1, req.name, req.pineSource)),
    );
    const { svc, notify } = make({ createChartScript });
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
    const drafts = JSON.parse(localStorage.getItem(DRAFTS_STORAGE_KEY)!);
    expect(drafts.map((d: { id: string; source: string }) => [d.id, d.source])).toEqual([
      ['draft-b', 'broken'],
    ]);
    expect(notify.warning).toHaveBeenCalledTimes(1);
    expect(notify.error).not.toHaveBeenCalled();
    expect(svc.savedScriptsError()).toBeNull();
    expect(svc.savedScripts().map((s) => s.id)).toEqual(['1', 'draft-b']);

    const cat = await firstValueFrom(svc.listItems());
    const draft = cat.mine.find((m) => m.key === 'mine:draft-b')!;
    expect(draft.description).toBe('Unsaved draft (compile error)');
    expect(draft.pineSource).toBe('broken');

    // Later loads: no upload attempt, no toast, draft still listed.
    createChartScript.mockClear();
    notify.warning.mockClear();
    const scripting = (svc as unknown as { scripting: Record<string, unknown> }).scripting;
    scripting['listChartScripts'] = () => of([dto(1, 'One')]);
    await firstValueFrom(svc.loadSaved());
    expect(createChartScript).not.toHaveBeenCalled();
    expect(notify.warning).not.toHaveBeenCalled();
    expect(svc.savedScripts().map((s) => s.id)).toEqual(['1', 'draft-b']);
  });

  it('saving a draft under its name retires it; deleting a draft removes it', async () => {
    localStorage.setItem(
      DRAFTS_STORAGE_KEY,
      JSON.stringify([
        { ...legacy('draft-x', 'Fixme', 'broken'), draftReason: 'nope' },
        { ...legacy('draft-y', 'Other', 'broken') },
      ]),
    );
    const createChartScript = vi.fn((req: { name: string; pineSource: string }) =>
      of(dto(9, req.name, req.pineSource)),
    );
    const { svc } = make({ createChartScript });
    await firstValueFrom(svc.saveScript('Fixme', 'fixed'));
    expect(createChartScript).toHaveBeenCalledWith({ name: 'Fixme', pineSource: 'fixed' });
    expect(svc.savedScripts().map((s) => s.id)).toEqual(['9', 'draft-y']);
    await firstValueFrom(svc.deleteScript('draft-y'));
    expect(localStorage.getItem(DRAFTS_STORAGE_KEY)).toBeNull();
    expect(svc.savedScripts().map((s) => s.id)).toEqual(['9']);
  });

  it('a failed list keeps the error state and toasts', async () => {
    const { svc, notify } = make({
      listChartScripts: () => throwError(() => new ScriptingApiError('Engine down')),
    });
    expect(svc.savedScriptsError()).toBe('Engine down');
    expect(notify.error).toHaveBeenCalledWith('Engine down');
    const cat = await firstValueFrom(svc.listItems());
    expect(cat.mine).toEqual([]);
    expect(cat.mineError).toBe('Engine down');
  });

  it('saves by name: POST for a new name, PUT for an existing one', async () => {
    const createChartScript = vi.fn((req: { name: string; pineSource: string }) =>
      of(dto(5, req.name, req.pineSource)),
    );
    const updateChartScript = vi.fn((id: number, req: { name: string; pineSource: string }) =>
      of(dto(id, req.name, req.pineSource)),
    );
    const { svc } = make({
      listChartScripts: () => of([dto(3, 'Existing')]),
      getChartScript: (id: number) => of(dto(id, 'Existing')),
      createChartScript,
      updateChartScript,
    });
    await firstValueFrom(svc.saveScript(' New ', 'src'));
    expect(createChartScript).toHaveBeenCalledWith({ name: 'New', pineSource: 'src' });
    await firstValueFrom(svc.saveScript('Existing', 'src2'));
    expect(updateChartScript).toHaveBeenCalledWith(3, { name: 'Existing', pineSource: 'src2' });
    expect(svc.savedScripts().map((s) => s.id)).toEqual(['3', '5']);
  });

  it('deletes through the engine and drops the row', async () => {
    const deleteChartScript = vi.fn(() => of(undefined));
    const { svc } = make({ listChartScripts: () => of([dto(3, 'X')]), deleteChartScript });
    await firstValueFrom(svc.deleteScript('3'));
    expect(deleteChartScript).toHaveBeenCalledWith(3);
    expect(svc.savedScripts()).toEqual([]);
  });

  it('sends the forming bar for an indicator preview but never for a strategy backtest', () => {
    const run = vi.fn(() => of({ compile: { success: true, diagnostics: [], inputs: [] } }));
    const { svc } = make({ run });
    const live = { t: 1, o: 1, h: 1, l: 1, c: 1, v: 0 };
    svc
      .runOnChart(
        {
          key: 'k',
          source: 'mine',
          name: 'i',
          description: '',
          kind: 'indicator',
          pineSource: 's',
        },
        'EURUSD',
        '60' as never,
        {},
        100,
        live,
      )
      .subscribe();
    svc
      .runOnChart(
        {
          key: 'k2',
          source: 'mine',
          name: 's',
          description: '',
          kind: 'strategy',
          pineSource: 's',
        },
        'EURUSD',
        '60' as never,
        {},
        100,
        live,
      )
      .subscribe();
    const calls = run.mock.calls as unknown as [{ mode: string; liveBar?: unknown }][];
    expect(calls[0][0]).toMatchObject({ mode: 'preview', liveBar: live });
    expect(calls[1][0].mode).toBe('backtest');
    expect(calls[1][0].liveBar).toBeUndefined();
  });

  it("sends the console's theme as it is when each run is requested (chart.bg_color)", () => {
    const run = vi.fn(() => of({ compile: { success: true, diagnostics: [], inputs: [] } }));
    const { svc, theme } = make({ run });
    const indicator: ChartScriptItem = {
      key: 'k',
      source: 'mine',
      name: 'i',
      description: '',
      kind: 'indicator',
      pineSource: 's',
    };
    const strategy: ChartScriptItem = { ...indicator, key: 'k2', kind: 'strategy' };
    theme.current = 'dark';
    svc.runOnChart(indicator, 'EURUSD', '60' as never).subscribe();
    svc.runOnChart(strategy, 'EURUSD', '60' as never).subscribe();
    theme.current = 'light';
    svc.runOnChart(indicator, 'EURUSD', '60' as never).subscribe();
    const calls = run.mock.calls as unknown as [{ theme?: string }][];
    expect(calls.map((c) => c[0].theme)).toEqual(['dark', 'dark', 'light']);
  });
});

describe('ChartScriptService — saved default inputs ("Save as default")', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  const COLOUR_OFF = { 'Display::Colour candles': false };

  it('reads the inputs saved with each script', () => {
    const { svc } = make({
      listChartScripts: () => of([dto(20, 'Smart Algo v2', 'src', COLOUR_OFF), dto(5, 'v1')]),
    });
    expect(svc.savedScripts().map((s) => [s.id, s.inputs])).toEqual([
      ['20', COLOUR_OFF],
      ['5', {}],
    ]);
  });

  it('stores the overrides with the name and source the engine has now; none clears them', async () => {
    const getChartScript = vi.fn((id: number) => of(dto(id, 'Renamed elsewhere', 'newer src')));
    const updateChartScript = vi.fn(
      (id: number, req: { name: string; pineSource: string; inputs?: ScriptInputValues | null }) =>
        of(dto(id, req.name, req.pineSource, req.inputs ?? null)),
    );
    const { svc } = make({
      listChartScripts: () => of([dto(20, 'Smart Algo v2', 'old src')]),
      getChartScript,
      updateChartScript,
    });

    const saved = await firstValueFrom(svc.saveDefaultInputs('20', COLOUR_OFF));
    expect(getChartScript).toHaveBeenCalledWith(20);
    expect(updateChartScript).toHaveBeenCalledWith(20, {
      name: 'Renamed elsewhere',
      pineSource: 'newer src',
      inputs: COLOUR_OFF,
    });
    expect(saved.inputs).toEqual(COLOUR_OFF);
    expect(svc.savedScripts()[0]).toMatchObject({ id: '20', inputs: COLOUR_OFF });

    await firstValueFrom(svc.saveDefaultInputs('20', {}));
    expect(updateChartScript.mock.calls[1][1].inputs).toBeNull();
    expect(svc.savedScripts()[0].inputs).toEqual({});
  });

  it('only a script in the engine keeps default inputs', async () => {
    const getChartScript = vi.fn();
    const { svc } = make({ getChartScript });
    await expect(firstValueFrom(svc.saveDefaultInputs('draft-x', COLOUR_OFF))).rejects.toThrow(
      'Only a script saved in the engine',
    );
    await expect(firstValueFrom(svc.saveDefaultInputs('local-y', COLOUR_OFF))).rejects.toThrow();
    expect(getChartScript).not.toHaveBeenCalled();
  });

  it('saving the source again keeps the inputs saved with it — as the engine has them now', async () => {
    const updateChartScript = vi.fn(
      (id: number, req: { name: string; pineSource: string; inputs?: ScriptInputValues | null }) =>
        of(dto(id, req.name, req.pineSource, req.inputs ?? null)),
    );
    const { svc } = make({
      listChartScripts: () => of([dto(20, 'Smart Algo v2', 'old src')]),
      // Saved as default from another tab after this page loaded its list.
      getChartScript: (id: number) => of(dto(id, 'Smart Algo v2', 'old src', COLOUR_OFF)),
      updateChartScript,
    });
    const saved = await firstValueFrom(svc.saveScript('Smart Algo v2', 'edited src'));
    expect(updateChartScript).toHaveBeenCalledWith(20, {
      name: 'Smart Algo v2',
      pineSource: 'edited src',
      inputs: COLOUR_OFF,
    });
    expect(saved.inputs).toEqual(COLOUR_OFF);
  });

  it('a script added to the chart starts with its saved inputs; anything else with none', () => {
    const { svc } = make({
      listChartScripts: () => of([dto(20, 'Smart Algo v2', 'src', COLOUR_OFF)]),
    });
    const mine = (key: string): ChartScriptItem => ({
      key,
      source: 'mine',
      name: 'x',
      description: '',
      kind: 'indicator',
    });
    expect(savedScriptId(mine('mine:20'))).toBe('20');
    expect(savedScriptId(mine('mine:draft-a'))).toBeNull();
    expect(savedScriptId(mine('editor:current'))).toBeNull();
    expect(savedScriptId({ key: 'example:ema', source: 'example' })).toBeNull();
    const start = startingValues(mine('mine:20'), svc.savedScripts());
    expect(start).toEqual(COLOUR_OFF);
    start['Display::Colour candles'] = true; // a copy: the saved script is untouched
    expect(svc.savedScripts()[0].inputs).toEqual(COLOUR_OFF);
    expect(startingValues(mine('mine:21'), svc.savedScripts())).toEqual({});
    expect(startingValues({ key: 'strategy:7', source: 'strategy' }, svc.savedScripts())).toEqual(
      {},
    );
  });
});

describe('ChartScriptService — overrides made for an earlier version of the script', () => {
  const ITEM: ChartScriptItem = {
    key: 'mine:20',
    source: 'mine',
    name: 'Smart Algo v2',
    description: '',
    kind: 'indicator',
    pineSource: 'edited src',
  };
  // The edited script: "Colour candles" became a string input; "Sensitivity" is unchanged.
  const EDITED: ScriptInputDto[] = [
    {
      id: 'Display::Colour candles',
      kind: 'string',
      title: 'Colour candles',
      defaultValue: 'On',
      options: ['On', 'Off'],
    },
    { id: 'Signals::Sensitivity', kind: 'float', title: 'Sensitivity', defaultValue: 1.3 },
  ];
  const result = (title: string) => ({
    compile: {
      success: true,
      diagnostics: [],
      declaration: { kind: 'indicator', title },
      inputs: EDITED,
    },
  });
  const refused = () =>
    throwError(
      () => new ScriptingApiError("Input 'Colour candles' must be a string.", '-11', null, 200),
    );
  const sent = (run: { mock: { calls: unknown[] } }) =>
    (run.mock.calls as [ScriptRunRequest][]).map((c) => c[0].inputs);

  it('a refused run learns the inputs and runs again with the overrides that still fit', async () => {
    const run = vi.fn((req: ScriptRunRequest) =>
      req.inputs?.['Display::Colour candles'] === false
        ? refused()
        : of(result(req.inputs ? 'with overrides' : 'defaults')),
    );
    const { svc } = make({ run });
    const r = await firstValueFrom(
      svc.runOnChart(ITEM, 'EURUSD', '60' as never, {
        'Display::Colour candles': false,
        'Signals::Sensitivity': 2,
      }),
    );
    expect(sent(run)).toEqual([
      { 'Display::Colour candles': false, 'Signals::Sensitivity': 2 },
      undefined,
      { 'Signals::Sensitivity': 2 },
    ]);
    expect(r.title).toBe('with overrides');
    expect(r.error).toBeNull();
  });

  it('with nothing left that fits, the run on the defaults is the result', async () => {
    const run = vi.fn((req: ScriptRunRequest) => (req.inputs ? refused() : of(result('defaults'))));
    const { svc } = make({ run });
    const r = await firstValueFrom(
      svc.runOnChart(ITEM, 'EURUSD', '60' as never, { 'Display::Colour candles': false }),
    );
    expect(sent(run)).toEqual([{ 'Display::Colour candles': false }, undefined]);
    expect(r.title).toBe('defaults');
  });

  it('when every override still fits, the refusal was about something else and stands', async () => {
    const run = vi.fn((req: ScriptRunRequest) => (req.inputs ? refused() : of(result('defaults'))));
    const { svc } = make({ run });
    await expect(
      firstValueFrom(svc.runOnChart(ITEM, 'EURUSD', '60' as never, { 'Signals::Sensitivity': 2 })),
    ).rejects.toThrow("Input 'Colour candles' must be a string.");
    expect(sent(run)).toHaveLength(2);
  });

  it('a transport failure is not a refusal: no second run', async () => {
    const run = vi.fn(() =>
      throwError(() => new ScriptingApiError('The engine could not be reached.', null, null, 0)),
    );
    const { svc } = make({ run });
    await expect(
      firstValueFrom(svc.runOnChart(ITEM, 'EURUSD', '60' as never, { 'Signals::Sensitivity': 2 })),
    ).rejects.toThrow('could not be reached');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a run without overrides is never retried', async () => {
    const run = vi.fn(() => refused());
    const { svc } = make({ run });
    await expect(firstValueFrom(svc.runOnChart(ITEM, 'EURUSD', '60' as never, {}))).rejects.toThrow(
      'must be a string',
    );
    expect(sent(run)).toEqual([undefined]);
  });
});
