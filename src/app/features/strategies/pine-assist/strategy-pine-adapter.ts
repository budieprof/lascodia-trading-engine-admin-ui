import type { StrategyDto } from '@core/api/api.types';
import type {
  ScriptCompileResult,
  ScriptInputDto,
  ScriptInputValues,
  ScriptRunResult,
} from '@core/api/scripting.types';
import type {
  PineDiagnostic,
  PineEditorAdapter,
  PineInput,
  PineRunSummary,
  PineTradeRow,
} from '@shared/pine-assist/pine-assist';
import { inputOverrides, resolveInputValues } from '@features/scripting/pine/pine-inputs';
import {
  normalizeStrategyReport,
  type ReportTrade,
  type StrategyReport,
} from '@features/scripting/report/strategy-report.model';

/** The slice of the Preview the adapter drives (ScriptPreviewComponent). */
export interface PreviewLike {
  source(): string;
  running(): boolean;
  canRun(): boolean;
  blockedReason(): string;
  error(): string | null;
  lastResult(): ScriptRunResult | null;
  chartRun(): ScriptRunResult | null;
  run(): Promise<void>;
  openReportTrade(row: ReportTrade): void;
}

/** The slice of the script panel the adapter drives (ScriptAuthoringComponent). */
export interface ScriptPanelLike {
  currentSource(): string;
  replaceSource(source: string): void;
  draft(): { source: string; inputs: ScriptInputValues };
  setInputs(inputs: ScriptInputValues): void;
  shown(): ScriptCompileResult | null;
  workbench?: { compileNow(force?: boolean): Promise<ScriptCompileResult | null> } | undefined;
  preview(): PreviewLike | undefined;
}

/** What the strategy edit page gives the adapter. */
export interface StrategyPineHost {
  strategy(): StrategyDto | null;
  panel(): ScriptPanelLike | undefined;
  /** Bring the script panel into view (the form's tab that holds it). */
  showScript(): void;
  save(reason: string): Promise<{ ok: boolean; message: string }>;
  readBuffer(name: string): Promise<string | null>;
  /** Lets bindings (the preview's `source` input) catch up with an edit. Default: a macrotask. */
  settle?(): Promise<void>;
}

const nextTask = () => new Promise<void>((r) => setTimeout(r, 0));

function iso(ms: number | null | undefined): string | null {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function tradeRow(t: ReportTrade): PineTradeRow {
  return {
    number: t.number ?? 0,
    side: t.direction,
    entryTime: iso(t.entryTime) ?? '',
    entryPrice: t.entryPrice ?? 0,
    entrySignal: t.entrySignal,
    exitTime: t.isOpen ? null : iso(t.exitTime),
    exitPrice: t.isOpen ? null : t.exitPrice,
    exitSignal: t.isOpen ? null : t.exitSignal || null,
    qty: t.qty ?? 0,
    profit: t.profit ?? 0,
    profitPercent: t.profitPercent,
  };
}

/** Headline figures of a run, as the Strategy report shows them. */
export function summariseRun(run: ScriptRunResult): PineRunSummary {
  const decl = run.compile?.declaration ?? null;
  const report: StrategyReport | null = normalizeStrategyReport(run.report);
  const warnings: string[] = [...(report?.warnings ?? [])];
  if (run.runtimeError) {
    const e = run.runtimeError as { message?: string; line?: number };
    warnings.unshift(
      `Runtime error${e.line ? ` at line ${e.line}` : ''}: ${e.message ?? 'unknown'}`,
    );
  }
  const all = report?.performance.all;
  const metrics: Record<string, number | string | null> = report
    ? {
        netProfit: all?.netProfit ?? null,
        netProfitPercent: all?.netProfitPercent ?? null,
        grossProfit: all?.grossProfit ?? null,
        grossLoss: all?.grossLoss ?? null,
        profitFactor: all?.profitFactor ?? null,
        percentProfitable: all?.percentProfitable ?? null,
        totalClosedTrades: all?.totalClosedTrades ?? null,
        totalOpenTrades: all?.totalOpenTrades ?? null,
        avgTrade: all?.avgTrade ?? null,
        ratioAvgWinAvgLoss: all?.ratioAvgWinAvgLoss ?? null,
        maxDrawdown: report.equity.maxDrawdown,
        maxDrawdownPercent: report.equity.maxDrawdownPercent,
        sharpeRatio: report.returns.sharpeRatio,
        sortinoRatio: report.returns.sortinoRatio,
        bars: report.meta.bars,
        accountCurrency: report.meta.accountCurrency || null,
      }
    : { bars: run.bars?.length ?? null };
  return {
    title: decl?.title ?? 'script',
    kind: decl?.kind ?? 'indicator',
    metrics,
    tradeCount: report?.trades.length ?? 0,
    warnings,
  };
}

function toInput(def: ScriptInputDto, values: ScriptInputValues): PineInput {
  return {
    id: def.id,
    title: def.title,
    kind: def.kind,
    value: values[def.id] ?? def.defaultValue,
    defaultValue: def.defaultValue,
    options: def.options ?? null,
    min: def.minValue ?? null,
    max: def.maxValue ?? null,
  };
}

/**
 * The strategy edit page's Pine editor, as the assistant's `pine.*` / `strategy.*` commands see
 * it. Every write goes through the editor's own document (undoable, marks the script dirty);
 * runs, results and inputs come from the page's Preview.
 */
export function createStrategyPineAdapter(host: StrategyPineHost): PineEditorAdapter {
  const settle = () => (host.settle ? host.settle() : nextTask());
  const panelOrThrow = (): ScriptPanelLike => {
    const p = host.panel();
    if (!p) throw new Error('The script editor is not open.');
    return p;
  };

  const report = (): { run: ScriptRunResult; report: StrategyReport | null } | null => {
    const run = host.panel()?.preview()?.chartRun() ?? null;
    return run ? { run, report: normalizeStrategyReport(run.report) } : null;
  };

  const run = async (): Promise<PineRunSummary | { error: string }> => {
    const panel = host.panel();
    if (!panel) return { error: 'The script editor is not open.' };
    // Compile first: the preview runs a strategy() in backtest mode only once it knows the kind.
    const compiled = await panel.workbench?.compileNow();
    if (compiled && !compiled.success) {
      const e = compiled.diagnostics.find((d) => d.severity === 'error');
      return {
        error: `The script does not compile${e ? ` — line ${e.line}: ${e.message}` : ''}. Use pine.compile.`,
      };
    }
    await settle();
    const preview = panel.preview();
    if (!preview) return { error: 'The preview has not loaded yet; try again in a moment.' };
    if (preview.source() !== panel.currentSource()) {
      await settle();
      if (preview.source() !== panel.currentSource())
        return { error: 'The preview has not picked up the latest edit yet; try again.' };
    }
    if (preview.running()) return { error: 'A preview run is already in progress.' };
    if (!preview.canRun()) return { error: preview.blockedReason() };
    await preview.run();
    const err = preview.error();
    if (err) return { error: err };
    const result = preview.lastResult();
    if (!result) return { error: 'The preview returned no result.' };
    if (result.compile?.success === false) {
      const e = result.compile.diagnostics.find((d) => d.severity === 'error');
      return { error: `The script does not compile${e ? ` — line ${e.line}: ${e.message}` : ''}.` };
    }
    return summariseRun(result);
  };

  const inputs = (): PineInput[] => {
    const panel = host.panel();
    const defs = panel?.shown()?.inputs ?? [];
    if (!panel) return [];
    const values = resolveInputValues(defs, panel.draft().inputs);
    return defs.map((d) => toInput(d, values));
  };

  return {
    label: () => {
      const s = host.strategy();
      return s ? `strategy #${s.id} "${s.name}"` : 'strategy (new)';
    },
    getSource: () => panelOrThrow().currentSource(),
    setSource: (source) => panelOrThrow().replaceSource(source),
    ensureVisible: () => host.showScript(),
    compile: async () => {
      const wb = host.panel()?.workbench;
      const r = wb ? await wb.compileNow(true) : null;
      if (!r)
        return {
          ok: false,
          diagnostics: [
            {
              line: 0,
              column: 0,
              severity: 'error',
              message:
                'The engine could not compile the script (unreachable or the editor is not open).',
            },
          ],
        };
      const diagnostics: PineDiagnostic[] = r.diagnostics.map((d) => ({
        line: d.line,
        column: d.column,
        severity: d.severity,
        message: d.message,
        code: d.code,
      }));
      return {
        ok: r.success,
        diagnostics,
        title: r.declaration?.title ?? null,
        kind: r.declaration?.kind ?? null,
      };
    },
    run,
    results: () => {
      const r = report();
      if (!r) return null;
      return { summary: summariseRun(r.run), trades: (r.report?.trades ?? []).map(tradeRow) };
    },
    tradeDetail: (n) => {
      const r = report();
      const t = r?.report?.trades.find((x) => x.number === n);
      if (!r || !t) return null;
      const bars = r.run.bars ?? [];
      const at = (i: number | null) => (i !== null && i >= 0 && i < bars.length ? bars[i] : null);
      return {
        trade: { ...t, entryTimeIso: iso(t.entryTime), exitTimeIso: iso(t.exitTime) },
        entryBar: at(t.entryBarIndex),
        exitBar: at(t.exitBarIndex),
        inputs: Object.fromEntries(inputs().map((i) => [i.id, i.value])),
      };
    },
    focusTrade: (n) => {
      const preview = host.panel()?.preview();
      const t = report()?.report?.trades.find((x) => x.number === n);
      if (!preview || !t) return false;
      preview.openReportTrade(t);
      return true;
    },
    inputs,
    setInput: async (id, value) => {
      const panel = host.panel();
      if (!panel) return { error: 'The script editor is not open.' };
      const defs = panel.shown()?.inputs ?? [];
      if (!defs.some((d) => d.id === id)) return { error: `No input "${id}".` };
      const values = {
        ...resolveInputValues(defs, panel.draft().inputs),
        [id]: value as ScriptInputValues[string],
      };
      panel.setInputs(inputOverrides(defs, values));
      return run();
    },
    save: (reason) => host.save(reason),
    readBuffer: (name) => host.readBuffer(name),
  };
}
