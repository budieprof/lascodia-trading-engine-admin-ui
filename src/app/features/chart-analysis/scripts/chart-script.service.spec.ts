import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Injector } from '@angular/core';
import { firstValueFrom, of, throwError } from 'rxjs';

import { ScriptingApiError, ScriptingService } from '@core/services/scripting.service';
import { StrategiesService } from '@core/services/strategies.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { ChartIndicatorScriptDto } from '@core/api/scripting.types';
import { ChartScriptService, LEGACY_STORAGE_KEY } from './chart-script.service';

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
  const notify = { error: vi.fn(), success: vi.fn() };
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

  it('keeps the key, the failed script and an error when one upload fails; skips already-uploaded ones on retry', () => {
    localStorage.setItem(
      LEGACY_STORAGE_KEY,
      JSON.stringify([legacy('a', 'One'), legacy('b', 'Bad')]),
    );
    const createChartScript = vi.fn((req: { name: string; pineSource: string }) =>
      req.name === 'Bad'
        ? throwError(() => new ScriptingApiError('PS1 at 1:1: nope', '-11'))
        : of(dto(1, req.name, req.pineSource)),
    );
    const { svc, notify } = make({ createChartScript });
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).not.toBeNull();
    expect(svc.savedScriptsError()).toContain('could not be moved');
    expect(notify.error).toHaveBeenCalled();
    expect(svc.savedScripts().map((s) => s.id)).toEqual(['1', 'local-b']);

    // Next load: "One" is already in the engine (same name + source) — only "Bad" is retried.
    createChartScript.mockClear();
    const scripting = (svc as unknown as { scripting: Record<string, unknown> }).scripting;
    scripting['listChartScripts'] = () => of([dto(1, 'One')]);
    svc.loadSaved().subscribe();
    expect(createChartScript.mock.calls.map((c) => c[0].name)).toEqual(['Bad']);
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
});
