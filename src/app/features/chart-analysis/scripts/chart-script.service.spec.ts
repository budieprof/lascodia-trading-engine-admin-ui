import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Injector } from '@angular/core';
import { firstValueFrom, of, throwError } from 'rxjs';

import { ScriptingApiError, ScriptingService } from '@core/services/scripting.service';
import { StrategiesService } from '@core/services/strategies.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { ChartIndicatorScriptDto } from '@core/api/scripting.types';
import { ChartScriptService, DRAFTS_STORAGE_KEY, LEGACY_STORAGE_KEY } from './chart-script.service';

function dto(
  id: number,
  name: string,
  pineSource = `//@version=6\nindicator("${name}")`,
): ChartIndicatorScriptDto {
  return {
    id,
    name,
    kind: 'indicator',
    pineSource,
    createdAt: '2026-10-06T00:00:00Z',
    updatedAt: '2026-10-06T00:00:00Z',
  };
}

function legacy(id: string, name: string, source = `//@version=6\nindicator("${name}")`) {
  return { id, name, source, kind: 'indicator', updatedAt: 1 };
}

function make(scripting: Partial<Record<keyof ScriptingService, unknown>>) {
  const notify = { error: vi.fn(), success: vi.fn(), warning: vi.fn() };
  const injector = Injector.create({
    providers: [
      { provide: ScriptingService, useValue: { listChartScripts: () => of([]), ...scripting } },
      {
        provide: StrategiesService,
        useValue: { list: () => of({ status: true, data: { data: [] } }) },
      },
      { provide: NotificationService, useValue: notify },
      { provide: ChartScriptService, useClass: ChartScriptService },
    ],
  });
  return { svc: injector.get(ChartScriptService), notify };
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
});
