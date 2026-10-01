import { Injectable, inject, signal } from '@angular/core';
import { Observable, catchError, map, of } from 'rxjs';

import { ScriptingService } from '@core/services/scripting.service';
import { StrategiesService } from '@core/services/strategies.service';
import type {
  ScriptCompileResult,
  ScriptInputValues,
  ScriptRunRequest,
} from '@core/api/scripting.types';
import type { StrategyDto } from '@core/api/api.types';
import type { TvResolution } from '../datafeed/resolution';
import { EXAMPLE_STRATEGIES } from './example-strategies';
import { runTimeframeFor, toChartScriptResult, type ChartScriptResult } from './chart-script.model';

export { detectScriptKind } from './chart-script.model';

export type ChartScriptSource = 'mine' | 'strategy' | 'example';

/** One runnable entry of the chart's script dialog. */
export interface ChartScriptItem {
  /** Unique across sources: `mine:<id>`, `strategy:<id>`, `example:<id>`. */
  key: string;
  source: ChartScriptSource;
  name: string;
  description: string;
  kind: 'indicator' | 'strategy';
  /** Pine source (my scripts, examples, editor). Strategies run by `strategyId` instead. */
  pineSource?: string;
  strategyId?: number;
  /** A saved strategy's own symbol / timeframe (informational; the chart's are used to run). */
  symbol?: string | null;
  timeframe?: string | null;
}

export interface ChartScriptCatalog {
  mine: ChartScriptItem[];
  strategies: ChartScriptItem[];
  examples: ChartScriptItem[];
  /** Set when the strategies list could not be loaded (the other groups still are). */
  strategiesError: string | null;
}

/** A script the operator saved from the chart's Pine editor. */
export interface SavedChartScript {
  id: string;
  name: string;
  source: string;
  kind: 'indicator' | 'strategy';
  updatedAt: number;
}

const STORAGE_KEY = 'lascodia.chart-analysis.scripts.v1';
const DEFAULT_LAST_BARS = 2000;
/** The engine caps a preview at 20,000 bars. */
const MAX_LAST_BARS = 20_000;

/**
 * Lists and runs Pine scripts for the chart-analysis page.
 *
 * <p>Engine calls: `POST strategy/list` (Pine strategies = `authoringMode === 'Script'`; the list
 * DTO omits `scriptSource`, so they run by `strategyId`), `POST scripting/run`, `POST
 * scripting/compile`. The engine has no store for stand-alone indicator scripts, so "My scripts"
 * live in this browser's localStorage — saving one is a per-browser convenience, not shared.</p>
 */
@Injectable({ providedIn: 'root' })
export class ChartScriptService {
  private readonly scripting = inject(ScriptingService);
  private readonly strategies = inject(StrategiesService);

  /** The operator's saved scripts (localStorage-backed). */
  readonly savedScripts = signal<SavedChartScript[]>(readSaved());

  /** Everything the dialog can list, grouped. Never errors: a failed group is reported, not thrown. */
  listItems(): Observable<ChartScriptCatalog> {
    const strategies$ = this.strategies
      .list({ currentPage: 1, itemCountPerPage: 500, sortBy: 'name', sortDirection: 'asc' })
      .pipe(
        map((res) => ({
          items: (res?.data?.data ?? []).filter(isPineStrategy).map(strategyItem),
          error: res?.status === false ? res.message || 'Strategies could not be loaded.' : null,
        })),
        catchError(() => of({ items: [] as ChartScriptItem[], error: 'Strategies could not be loaded.' })),
      );
    return strategies$.pipe(
      map((s) => ({
        mine: this.savedScripts().map(savedItem),
        strategies: s.items,
        examples: EXAMPLE_STRATEGIES.map((e) => ({
          key: `example:${e.id}`,
          source: 'example' as const,
          name: e.name,
          description: e.description,
          kind: 'strategy' as const,
          pineSource: e.source,
        })),
        strategiesError: s.error,
      })),
    );
  }

  /**
   * Runs an item over the chart's symbol and resolution. Strategies run as `backtest`, indicators
   * as `preview`. A script that does not compile resolves (with `error` and `diagnostics` set);
   * only transport failures reject (`ScriptingApiError`).
   */
  runOnChart(
    item: ChartScriptItem,
    symbol: string,
    resolution: TvResolution,
    inputs?: ScriptInputValues,
    lastBars = DEFAULT_LAST_BARS,
  ): Observable<ChartScriptResult> {
    const req: ScriptRunRequest = {
      symbol,
      timeframe: runTimeframeFor(resolution),
      lastBars: Math.max(1, Math.min(MAX_LAST_BARS, Math.round(lastBars))),
      mode: item.kind === 'strategy' ? 'backtest' : 'preview',
    };
    if (item.strategyId !== undefined) req.strategyId = item.strategyId;
    else req.source = item.pineSource ?? '';
    if (inputs && Object.keys(inputs).length) req.inputs = inputs;
    return this.scripting.run(req).pipe(map((res) => toChartScriptResult(res)));
  }

  /** `POST scripting/compile` — diagnostics, declaration and inputs for the editor. */
  compile(source: string, symbol?: string, resolution?: TvResolution): Observable<ScriptCompileResult> {
    return this.scripting.compile({
      source,
      symbol: symbol ?? null,
      timeframe: resolution ? runTimeframeFor(resolution) : null,
    });
  }

  /** An ad-hoc item for source typed in the editor. */
  itemForSource(source: string, kind: 'indicator' | 'strategy', name = 'Untitled script'): ChartScriptItem {
    return { key: 'editor:current', source: 'mine', name, description: '', kind, pineSource: source };
  }

  /** Saves (or overwrites by name) a script in "My scripts". */
  saveScript(name: string, source: string, kind: 'indicator' | 'strategy'): SavedChartScript {
    const trimmed = name.trim() || 'Untitled script';
    const existing = this.savedScripts().find((s) => s.name === trimmed);
    const saved: SavedChartScript = {
      id: existing?.id ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: trimmed,
      source,
      kind,
      updatedAt: Date.now(),
    };
    const next = [saved, ...this.savedScripts().filter((s) => s.id !== saved.id)];
    this.savedScripts.set(next);
    writeSaved(next);
    return saved;
  }

  deleteScript(id: string): void {
    const next = this.savedScripts().filter((s) => s.id !== id);
    this.savedScripts.set(next);
    writeSaved(next);
  }
}

function isPineStrategy(s: StrategyDto): boolean {
  return s.strategyType === 'RuleBased' && s.authoringMode === 'Script';
}

function strategyItem(s: StrategyDto): ChartScriptItem {
  return {
    key: `strategy:${s.id}`,
    source: 'strategy',
    name: s.name || `Strategy #${s.id}`,
    description: [s.symbol, s.timeframe, s.status].filter(Boolean).join(' · '),
    kind: 'strategy',
    strategyId: s.id,
    symbol: s.symbol,
    timeframe: s.timeframe,
  };
}

function savedItem(s: SavedChartScript): ChartScriptItem {
  return {
    key: `mine:${s.id}`,
    source: 'mine',
    name: s.name,
    description: s.kind === 'strategy' ? 'Strategy' : 'Indicator',
    kind: s.kind,
    pineSource: s.source,
  };
}

function readSaved(): SavedChartScript[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((s) => s && typeof s.id === 'string' && typeof s.source === 'string')
      : [];
  } catch {
    return [];
  }
}

function writeSaved(list: SavedChartScript[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* storage full / blocked: the in-memory list still works this session */
  }
}
