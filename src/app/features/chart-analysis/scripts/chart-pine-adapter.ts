import type { ScriptCompileResult, ScriptInputValues } from '@core/api/scripting.types';
import type { PineEditorAdapter, PineRunSummary, PineTradeRow } from '@shared/pine-assist/pine-assist';
import type { ChartScriptResult, ChartTrade } from './chart-script.model';
import { tradeDetail } from './trade-detail';

/**
 * The chart page's Pine Editor, as the assistant's `pine.*` / `strategy.*` commands see it.
 *
 * The page owns the state (the editor draft, the runs on the chart); this only translates. Kept
 * free of Angular so it is testable without a TestBed.
 */
export interface ChartPineHost {
  editorName(): string | null;
  draft(): string;
  writeDraft(text: string): void;
  openEditor(): void;
  compile(source: string): Promise<ScriptCompileResult>;
  /** Add the draft to the chart, or update the script the editor shows. Resolves with the run. */
  runDraft(source: string): Promise<ChartScriptResult | { error: string }>;
  /** The run the editor's script produced (else the chart's strategy), with its input values. */
  currentRun(): { result: ChartScriptResult; values: ScriptInputValues } | null;
  rerun(values: ScriptInputValues): Promise<ChartScriptResult | { error: string }>;
  focusTrade(t: ChartTrade): void;
  pricePrecision(): number;
  readBuffer(name: string): Promise<string | null>;
}

const iso = (sec: number | null): string | null => (sec === null ? null : new Date(sec * 1000).toISOString());

export function summarize(r: ChartScriptResult): PineRunSummary {
  const m = r.strategy?.metrics;
  return {
    title: r.title,
    kind: r.kind,
    metrics: m ? { ...m } : {},
    tradeCount: r.strategy?.trades.length ?? 0,
    warnings: [...(r.strategy?.warnings ?? []), ...r.diagnostics.filter((d) => d.severity !== 'error').map((d) => `L${d.line}: ${d.message}`)].slice(0, 20),
  };
}

export function tradeRow(t: ChartTrade): PineTradeRow {
  return {
    number: t.number,
    side: t.side,
    entryTime: iso(t.entryTime)!,
    entryPrice: t.entryPrice,
    entrySignal: t.entrySignal,
    exitTime: iso(t.exitTime),
    exitPrice: t.exitPrice,
    exitSignal: t.exitSignal,
    qty: t.qty,
    profit: t.profit,
    profitPercent: t.profitPercent,
  };
}

const settle = (r: ChartScriptResult | { error: string }): PineRunSummary | { error: string } =>
  'error' in r && !('title' in r) ? r : (r as ChartScriptResult).error ? { error: (r as ChartScriptResult).error! } : summarize(r as ChartScriptResult);

export function chartPineAdapter(h: ChartPineHost): PineEditorAdapter {
  const tradeOf = (n: number) => h.currentRun()?.result.strategy?.trades.find((t) => t.number === n) ?? null;
  return {
    label: () => `the chart's Pine Editor${h.editorName() ? ` ("${h.editorName()}")` : ''}`,
    getSource: () => h.draft(),
    setSource: (s) => h.writeDraft(s),
    ensureVisible: () => h.openEditor(),
    compile: async () => {
      const r = await h.compile(h.draft());
      return {
        ok: !r.diagnostics.some((d) => d.severity === 'error'),
        diagnostics: r.diagnostics.map((d) => ({ line: d.line, column: d.column, severity: d.severity, message: d.message, code: d.code })),
        title: r.declaration?.title ?? null,
        kind: r.declaration?.kind ?? null,
      };
    },
    run: async () => settle(await h.runDraft(h.draft())),
    results: () => {
      const run = h.currentRun();
      return run ? { summary: summarize(run.result), trades: (run.result.strategy?.trades ?? []).map(tradeRow) } : null;
    },
    tradeDetail: (n) => {
      const run = h.currentRun();
      const t = tradeOf(n);
      return run && t ? tradeDetail(run.result, t, run.values, h.pricePrecision()) : null;
    },
    focusTrade: (n) => {
      const t = tradeOf(n);
      if (t) h.focusTrade(t);
      return !!t;
    },
    inputs: () => {
      const run = h.currentRun();
      if (!run) return [];
      return run.result.inputs.map((i) => ({
        id: i.id,
        title: i.title,
        kind: i.kind,
        value: run.values[i.id] ?? i.defaultValue,
        defaultValue: i.defaultValue,
        options: i.options ?? null,
        min: i.minValue ?? null,
        max: i.maxValue ?? null,
      }));
    },
    setInput: async (id, value) => {
      const run = h.currentRun();
      if (!run) return { error: 'Nothing is running on the chart.' };
      return settle(await h.rerun({ ...run.values, [id]: value as ScriptInputValues[string] }));
    },
    readBuffer: (name) => h.readBuffer(name),
  };
}
