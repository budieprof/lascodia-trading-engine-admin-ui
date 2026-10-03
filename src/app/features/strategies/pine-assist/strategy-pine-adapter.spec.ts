import { describe, it, expect, vi } from 'vitest';

import type { StrategyDto } from '@core/api/api.types';
import type {
  ScriptCompileResult,
  ScriptInputValues,
  ScriptRunResult,
} from '@core/api/scripting.types';
import { pineAssistCommands } from '@shared/pine-assist/pine-assist';
import {
  createStrategyPineAdapter,
  type PreviewLike,
  type ScriptPanelLike,
  type StrategyPineHost,
} from './strategy-pine-adapter';

const SAVED = 'strategy("S")\nplot(close)';

const COMPILE_OK: ScriptCompileResult = {
  success: true,
  diagnostics: [],
  declaration: { kind: 'strategy', title: 'S' } as ScriptCompileResult['declaration'],
  inputs: [
    {
      id: 'len',
      kind: 'int',
      title: 'Length',
      defaultValue: 14,
      minValue: 1,
      maxValue: 100,
    } as any,
  ],
};

const RUN: ScriptRunResult = {
  compile: COMPILE_OK,
  bars: [
    { t: 0, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
    { t: 3600000, o: 1.5, h: 2, l: 1, c: 1.8, v: 10 },
  ],
  report: {
    performance: {
      all: { netProfit: 120, profitFactor: 1.7, percentProfitable: 55, totalClosedTrades: 1 },
    },
    equity: { maxDrawdown: 30, maxDrawdownPercent: 2.5 },
    trades: [
      {
        number: 1,
        isOpen: false,
        direction: 'long',
        entrySignal: 'L',
        entryTime: 0,
        entryBarIndex: 0,
        entryPrice: 1,
        exitSignal: 'X',
        exitTime: 3600000,
        exitBarIndex: 1,
        exitPrice: 1.2,
        qty: 1,
        profit: 120,
        profitPercent: 1.2,
      },
    ],
  } as any,
};

/** A panel whose draft, like the real one, follows the editor; dirty = differs from SAVED. */
function makeHost(opts: { previewRuns?: boolean } = {}) {
  let source = SAVED;
  let inputs: ScriptInputValues = {};
  let last: ScriptRunResult | null = null;
  const preview: PreviewLike = {
    source: () => source,
    running: () => false,
    canRun: () => true,
    blockedReason: () => '',
    error: () => null,
    lastResult: () => last,
    chartRun: () => last,
    run: vi.fn(async () => {
      last = opts.previewRuns === false ? null : RUN;
    }),
    openReportTrade: vi.fn(),
  };
  const compileNow = vi.fn(async () => COMPILE_OK);
  const panel: ScriptPanelLike & { isDirty(): boolean } = {
    currentSource: () => source,
    replaceSource: vi.fn((s: string) => {
      source = s;
    }),
    draft: () => ({ source, inputs }),
    setInputs: vi.fn((v: ScriptInputValues) => {
      inputs = v;
    }),
    shown: () => COMPILE_OK,
    workbench: { compileNow },
    preview: () => preview,
    isDirty: () => source !== SAVED,
  };
  const host: StrategyPineHost = {
    strategy: () => ({ id: 1154, name: 'MeanRev v4' }) as StrategyDto,
    panel: () => panel,
    showScript: vi.fn(),
    save: vi.fn(async (reason: string) => ({ ok: true, message: `saved: ${reason}` })),
    readBuffer: vi.fn(async (name: string) => (name === 'b1' ? 'strategy("B")' : null)),
    settle: async () => undefined,
  };
  return { host, panel, preview, compileNow, adapter: createStrategyPineAdapter(host) };
}

describe('createStrategyPineAdapter', () => {
  it('labels the strategy', () => {
    expect(makeHost().adapter.label()).toBe('strategy #1154 "MeanRev v4"');
  });

  it('setSource goes through the editor and makes the script dirty', () => {
    const { adapter, panel } = makeHost();
    expect(panel.isDirty()).toBe(false);
    adapter.setSource('strategy("S2")');
    expect(panel.replaceSource).toHaveBeenCalledWith('strategy("S2")');
    expect(adapter.getSource()).toBe('strategy("S2")');
    expect(panel.isDirty()).toBe(true);
  });

  it('pine.edit patches the live text via the adapter', async () => {
    const { adapter, panel } = makeHost();
    const edit = pineAssistCommands(adapter).find((c) => c.id === 'pine.edit')!;
    const r = await edit.run({ find: 'plot(close)', replace: 'plot(open)' });
    expect(r.ok).toBe(true);
    expect(panel.currentSource()).toBe('strategy("S")\nplot(open)');
  });

  it('compile maps diagnostics with line and column', async () => {
    const { adapter, compileNow } = makeHost();
    compileNow.mockResolvedValueOnce({
      ...COMPILE_OK,
      success: false,
      diagnostics: [
        {
          code: 'PS1001',
          severity: 'error',
          message: 'bad',
          line: 2,
          column: 5,
          endLine: 2,
          endColumn: 6,
        },
      ],
    });
    const r = await adapter.compile();
    expect(r.ok).toBe(false);
    expect(r.diagnostics).toEqual([
      { line: 2, column: 5, severity: 'error', message: 'bad', code: 'PS1001' },
    ]);
  });

  it('run executes the preview and summarises the report', async () => {
    const { adapter, preview } = makeHost();
    const r = await adapter.run();
    expect(preview.run).toHaveBeenCalled();
    expect(r).toMatchObject({
      title: 'S',
      kind: 'strategy',
      tradeCount: 1,
      metrics: { netProfit: 120, profitFactor: 1.7, maxDrawdown: 30 },
    });
  });

  it('run refuses a script that does not compile', async () => {
    const { adapter, compileNow, preview } = makeHost();
    compileNow.mockResolvedValueOnce({
      ...COMPILE_OK,
      success: false,
      diagnostics: [
        {
          code: 'X',
          severity: 'error',
          message: 'oops',
          line: 3,
          column: 1,
          endLine: 3,
          endColumn: 2,
        },
      ],
    });
    const r = await adapter.run();
    expect(r).toEqual({ error: expect.stringContaining('line 3: oops') });
    expect(preview.run).not.toHaveBeenCalled();
  });

  it('results, tradeDetail and focusTrade read the preview run', async () => {
    const { adapter, preview } = makeHost();
    expect(adapter.results!()).toBeNull();
    await adapter.run();
    const res = adapter.results!()!;
    expect(res.trades[0]).toMatchObject({ number: 1, side: 'long', exitPrice: 1.2, profit: 120 });
    expect(res.trades[0].entryTime).toBe('1970-01-01T00:00:00.000Z');
    const d = adapter.tradeDetail!(1) as any;
    expect(d.exitBar).toMatchObject({ c: 1.8 });
    expect(adapter.tradeDetail!(9)).toBeNull();
    expect(adapter.focusTrade!(1)).toBe(true);
    expect(preview.openReportTrade).toHaveBeenCalled();
  });

  it('inputs / setInput update the draft and re-run', async () => {
    const { adapter, panel, preview } = makeHost();
    expect(adapter.inputs!()).toEqual([
      expect.objectContaining({ id: 'len', value: 14, defaultValue: 14, min: 1, max: 100 }),
    ]);
    const r = await adapter.setInput!('len', 20);
    expect(panel.setInputs).toHaveBeenCalledWith({ len: 20 });
    expect(preview.run).toHaveBeenCalled();
    expect('error' in r).toBe(false);
    expect(await adapter.setInput!('nope', 1)).toEqual({ error: 'No input "nope".' });
  });

  it('save passes the reason to the host', async () => {
    const { adapter, host } = makeHost();
    const save = pineAssistCommands(adapter).find((c) => c.id === 'strategy.save')!;
    expect(save.confirm).toBe(true);
    const r = await save.run({ reason: 'tighter stop' });
    expect(host.save).toHaveBeenCalledWith('tighter stop');
    expect(r).toEqual({ ok: true, message: 'saved: tighter stop' });
  });

  it('pine.fromBuffer loads a buffer into the editor', async () => {
    const { adapter, panel } = makeHost();
    const cmd = pineAssistCommands(adapter).find((c) => c.id === 'pine.fromBuffer')!;
    expect((await cmd.run({ name: 'b1' })).ok).toBe(true);
    expect(panel.currentSource()).toBe('strategy("B")');
    expect((await cmd.run({ name: 'missing' })).ok).toBe(false);
  });

  it('ensureVisible shows the script tab', () => {
    const { adapter, host } = makeHost();
    adapter.ensureVisible!();
    expect(host.showScript).toHaveBeenCalled();
  });
});
