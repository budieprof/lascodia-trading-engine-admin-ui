import { describe, expect, it, vi } from 'vitest';
import { pineAssistCommands } from '@shared/pine-assist/pine-assist';
import { chartPineAdapter, type ChartPineHost } from './chart-pine-adapter';
import type { ChartScriptResult, ChartTrade } from './chart-script.model';

const trade = (n: number): ChartTrade => ({
  number: n,
  side: 'long',
  isOpen: false,
  entryTime: 1_700_000_000 + n * 3600,
  entryPrice: 1.1,
  entrySignal: 'L',
  exitTime: 1_700_000_000 + n * 3600 + 7200,
  exitPrice: 1.101,
  exitSignal: 'TP',
  qty: 1,
  profit: 10,
  profitPercent: 0.1,
  cumulativeProfit: 10 * n,
});

const result = (): ChartScriptResult =>
  ({
    title: 'MeanRev',
    kind: 'strategy',
    overlay: true,
    compile: null,
    inputs: [{ id: 'len', kind: 'int', title: 'Length', defaultValue: 2 }],
    diagnostics: [],
    error: null,
    errorAt: null,
    strategy: { trades: [trade(1), trade(2)], metrics: { currency: 'USD', netProfit: 20 }, equity: [], report: {}, warnings: [] },
    run: null,
  }) as unknown as ChartScriptResult;

function host(): ChartPineHost & { text: string; values: Record<string, unknown> } {
  const h = {
    text: 'strategy("x")',
    values: {} as Record<string, unknown>,
    editorName: () => 'MeanRev',
    draft: () => h.text,
    writeDraft: (t: string) => {
      h.text = t;
    },
    openEditor: vi.fn(),
    compile: async () => ({ success: true, diagnostics: [], declaration: { kind: 'strategy', title: 'MeanRev' }, inputs: [] }) as never,
    runDraft: async () => result(),
    currentRun: () => ({ result: result(), values: h.values as never }),
    rerun: async (v: Record<string, unknown>) => {
      h.values = v;
      return result();
    },
    focusTrade: vi.fn(),
    pricePrecision: () => 5,
    readBuffer: async (n: string) => (n === 'live' ? 'indicator("b")' : null),
  };
  return h as never;
}

const cmd = (h: ChartPineHost, id: string) => pineAssistCommands(chartPineAdapter(h)).find((c) => c.id === id)!;

describe('chart Pine adapter', () => {
  it('runs and summarises the strategy', async () => {
    const r = await cmd(host(), 'pine.run').run({});
    expect(r.ok).toBe(true);
    expect((r.data as { tradeCount: number }).tradeCount).toBe(2);
  });

  it('pages the List of trades with ISO times', async () => {
    const r = await cmd(host(), 'strategy.results').run({ offset: 1, limit: 1 });
    const d = r.data as { trades: { number: number; entryTime: string }[]; nextOffset: number | null };
    expect(d.trades[0].number).toBe(2);
    expect(d.trades[0].entryTime).toMatch(/^2023-/);
    expect(d.nextOffset).toBeNull();
  });

  it('focuses a trade and refuses an unknown one', async () => {
    const h = host();
    expect((await cmd(h, 'strategy.focusTrade').run({ number: 2 })).ok).toBe(true);
    expect(h.focusTrade).toHaveBeenCalledOnce();
    expect((await cmd(h, 'strategy.focusTrade').run({ number: 9 })).ok).toBe(false);
  });

  it('sets a numeric input and re-runs', async () => {
    const h = host();
    expect((await cmd(h, 'strategy.setInput').run({ id: 'len', value: '5' })).ok).toBe(true);
    expect(h.values).toEqual({ len: 5 });
  });

  it('loads a buffer into the editor', async () => {
    const h = host();
    expect((await cmd(h, 'pine.fromBuffer').run({ name: 'live' })).ok).toBe(true);
    expect(h.text).toBe('indicator("b")');
    expect((await cmd(h, 'pine.fromBuffer').run({ name: 'nope' })).ok).toBe(false);
  });

  it('offers no save on the chart (the strategy page owns saving)', () => {
    expect(pineAssistCommands(chartPineAdapter(host())).some((c) => c.id === 'strategy.save')).toBe(false);
  });
});
