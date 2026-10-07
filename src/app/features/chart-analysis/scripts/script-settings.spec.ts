import { describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { Subject, of, throwError } from 'rxjs';

import type { ScriptInputDto, ScriptInputValues } from '@core/api/scripting.types';
import { inputDefault } from '@features/scripting/pine/pine-inputs';
import type { ChartScriptItem, SavedChartScript } from './chart-script.service';
import { ScriptSettings, type ScriptSettingsHost, type SettingsRun } from './script-settings';

const COLOUR = 'Display::Colour candles';
const INPUTS: ScriptInputDto[] = [
  { id: COLOUR, kind: 'bool', title: 'Colour candles', defaultValue: true, group: 'Display' },
  { id: 'Signals::Sensitivity', kind: 'float', title: 'Sensitivity', defaultValue: 1.3 },
];

const item = (key: string, over: Partial<ChartScriptItem> = {}): ChartScriptItem => ({
  key,
  source: key.startsWith('strategy:') ? 'strategy' : 'mine',
  name: key,
  description: '',
  kind: 'indicator',
  pineSource: 'src',
  ...over,
});
const runOf = (it: ChartScriptItem, values: ScriptInputValues = {}): SettingsRun => ({
  item: it,
  result: { inputs: INPUTS.map((i) => ({ ...i })) },
  values,
});

function make(runs: SettingsRun[], host: Partial<ScriptSettingsHost> = {}) {
  const list = signal(runs);
  const h = {
    run: vi.fn(),
    storedInputs: vi.fn(() => of({})),
    saveDefault: vi.fn((id: string) => of({ id, name: 'Smart Algo v2' } as SavedChartScript)),
    notify: vi.fn(),
    ...host,
  };
  return { list, host: h, settings: new ScriptSettings(list, h) };
}

describe('ScriptSettings — a Pine chip’s Settings on the chart', () => {
  it('the gear opens that script’s dialog with its inputs', () => {
    const v2 = item('mine:20');
    const { settings } = make([runOf(item('mine:5')), runOf(v2, { [COLOUR]: false })]);
    expect(settings.run()).toBeNull();
    settings.open('mine:20');
    expect(settings.run()?.item).toBe(v2);
    expect(settings.run()?.values).toEqual({ [COLOUR]: false });
    expect(settings.inputs()?.map((i) => i.id)).toEqual([COLOUR, 'Signals::Sensitivity']);
    settings.close();
    expect(settings.run()).toBeNull();
  });

  it('a live re-run landing keeps it open on equal inputs, which do not re-render the form', () => {
    const v2 = item('mine:20');
    const { list, settings } = make([runOf(v2)]);
    settings.open('mine:20');
    const shown = settings.inputs();
    list.set([runOf(v2)]); // the next run: an equal copy of the inputs
    expect(settings.run()?.item).toBe(v2);
    expect(settings.inputs()).toBe(shown);
  });

  it('new values apply at once — the script’s values change and it runs with them', () => {
    const v1 = item('mine:5');
    const v2 = item('mine:20');
    const { list, host, settings } = make([runOf(v1, { x: 1 }), runOf(v2)]);
    settings.open('mine:20');
    settings.apply('mine:20', { [COLOUR]: false });
    expect(host.run).toHaveBeenCalledWith(v2, { [COLOUR]: false });
    // Before that run lands, every later run and the saved layout already read the new values…
    expect(list()[1].values).toEqual({ [COLOUR]: false });
    expect(settings.run()?.values).toEqual({ [COLOUR]: false });
    // …and no other script's.
    expect(list()[0].values).toEqual({ x: 1 });

    settings.apply('mine:20', {});
    expect(host.run).toHaveBeenLastCalledWith(v2, {});
    expect(list()[1].values).toEqual({});
  });

  it('values for a script that left the chart are dropped', () => {
    const { list, host, settings } = make([runOf(item('mine:20'))]);
    const before = list();
    settings.apply('mine:21', { [COLOUR]: false });
    expect(host.run).not.toHaveBeenCalled();
    expect(list()).toBe(before);
  });

  it('closes when its script leaves the chart or is replaced, and does not reopen when it returns', () => {
    const v2 = item('mine:20');
    const { list, settings } = make([runOf(v2)]);
    settings.open('mine:20');
    list.set([]);
    expect(settings.run()).toBeNull();
    list.set([runOf(v2)]); // the same script added back
    expect(settings.run()).toBeNull();

    settings.open('mine:20');
    // The editor's copy, or another layout's script, under the same key.
    list.set([runOf(item('mine:20'))]);
    expect(settings.run()).toBeNull();
  });

  it('an engine strategy shows its stored inputs as the defaults, once they are read', () => {
    const stored = new Subject<ScriptInputValues>();
    const strategy = item('strategy:1181', { strategyId: 1181, pineSource: undefined });
    const { host, settings } = make([runOf(strategy)], { storedInputs: vi.fn(() => stored) });
    settings.open('strategy:1181');
    expect(host.storedInputs).toHaveBeenCalledWith(1181);
    expect(settings.inputs()).toBeNull(); // the dialog waits rather than show the wrong values
    stored.next({ 'Signals::Sensitivity': 2.2 });
    const sensitivity = settings.inputs()!.find((i) => i.id === 'Signals::Sensitivity')!;
    expect(inputDefault(sensitivity)).toBe(2.2);
    settings.close();
    settings.open('strategy:1181');
    expect(host.storedInputs).toHaveBeenCalledTimes(1);
  });

  it('a strategy whose stored inputs cannot be read falls back to the source’s defaults', () => {
    const strategy = item('strategy:7', { strategyId: 7, pineSource: undefined });
    const { settings } = make([runOf(strategy)], {
      storedInputs: vi.fn(() => throwError(() => new Error('down'))),
    });
    settings.open('strategy:7');
    expect(settings.inputs()?.map((i) => inputDefault(i))).toEqual([true, 1.3]);
  });

  it('only a script saved in the engine can keep default inputs', () => {
    const { settings } = make([]);
    expect(settings.canSaveDefault(item('mine:20'))).toBe(true);
    expect(settings.canSaveDefault(item('mine:draft-1'))).toBe(false);
    expect(settings.canSaveDefault(item('editor:current'))).toBe(false);
    expect(settings.canSaveDefault(item('strategy:7', { strategyId: 7 }))).toBe(false);
    expect(settings.canSaveDefault(item('example:ema', { source: 'example' }))).toBe(false);
  });

  it('Save as default stores the values with the saved script and says so', () => {
    const saving = new Subject<SavedChartScript>();
    const { host, settings } = make([runOf(item('mine:20')), runOf(item('editor:current'))], {
      saveDefault: vi.fn(() => saving),
    });
    settings.saveDefault('mine:20', { [COLOUR]: false });
    expect(host.saveDefault).toHaveBeenCalledWith('20', { [COLOUR]: false });
    expect(settings.saving()).toBe(true);
    settings.saveDefault('mine:20', { [COLOUR]: false }); // one at a time
    expect(host.saveDefault).toHaveBeenCalledTimes(1);
    saving.next({ id: '20', name: 'Smart Algo v2' } as SavedChartScript);
    expect(settings.saving()).toBe(false);
    expect(host.notify).toHaveBeenCalledWith(
      'success',
      'Saved as the default inputs of “Smart Algo v2”.',
    );

    settings.saveDefault('editor:current', { [COLOUR]: false });
    expect(host.saveDefault).toHaveBeenCalledTimes(1);
  });

  it('a failed Save as default is reported', () => {
    const { host, settings } = make([runOf(item('mine:20'))], {
      saveDefault: vi.fn(() => throwError(() => new Error('Script 20 not found.'))),
    });
    settings.saveDefault('mine:20', {});
    expect(settings.saving()).toBe(false);
    expect(host.notify).toHaveBeenCalledWith('error', 'Script 20 not found.');
  });
});
