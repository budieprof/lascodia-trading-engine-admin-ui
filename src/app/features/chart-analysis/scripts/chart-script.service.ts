import { Injectable, inject, signal } from '@angular/core';
import {
  Observable,
  catchError,
  concatMap,
  finalize,
  forkJoin,
  from,
  map,
  of,
  shareReplay,
  switchMap,
  tap,
  toArray,
} from 'rxjs';

import { NotificationService } from '@core/notifications/notification.service';

import { ScriptingService } from '@core/services/scripting.service';
import { StrategiesService } from '@core/services/strategies.service';
import type {
  ChartIndicatorScriptDto,
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
  /** Set when "My scripts" could not be loaded or fully migrated from this browser. */
  mineError?: string | null;
}

/** A script the operator saved from the chart's Pine editor. */
export interface SavedChartScript {
  /** The engine id as a string; `local-…` for a script still only in this browser (not migrated). */
  id: string;
  name: string;
  source: string;
  kind: 'indicator' | 'strategy';
  updatedAt: number;
}

/** Pre-engine storage of "My scripts"; read once to migrate, then cleared. */
export const LEGACY_STORAGE_KEY = 'lascodia.chart-analysis.scripts.v1';
const DEFAULT_LAST_BARS = 2000;
/** The engine caps a preview at 20,000 bars. */
const MAX_LAST_BARS = 20_000;

/**
 * Lists and runs Pine scripts for the chart-analysis page.
 *
 * <p>Engine calls: `POST strategy/list` (Pine strategies = `authoringMode === 'Script'`; the list
 * DTO omits `scriptSource`, so they run by `strategyId`), `POST scripting/run`, `POST
 * scripting/compile`, and `scripting/indicators` for "My scripts" — saved in the engine, private
 * to the operator. Scripts saved by older builds in this browser's localStorage are uploaded once;
 * the key is cleared only after every one of them is in the engine.</p>
 */
@Injectable({ providedIn: 'root' })
export class ChartScriptService {
  private readonly scripting = inject(ScriptingService);
  private readonly strategies = inject(StrategiesService);
  private readonly notify = inject(NotificationService);

  /** The operator's saved scripts (engine-backed; local leftovers that failed to migrate included). */
  readonly savedScripts = signal<SavedChartScript[]>([]);
  /** Set when "My scripts" could not be loaded or migrated. */
  readonly savedScriptsError = signal<string | null>(null);

  /** Everything the dialog can list, grouped. Never errors: a failed group is reported, not thrown. */
  listItems(): Observable<ChartScriptCatalog> {
    const strategies$ = this.strategies
      .list({ currentPage: 1, itemCountPerPage: 500, sortBy: 'name', sortDirection: 'asc' })
      .pipe(
        map((res) => ({
          items: (res?.data?.data ?? []).filter(isPineStrategy).map(strategyItem),
          error: res?.status === false ? res.message || 'Strategies could not be loaded.' : null,
        })),
        catchError(() =>
          of({ items: [] as ChartScriptItem[], error: 'Strategies could not be loaded.' }),
        ),
      );
    return forkJoin({ s: strategies$, mine: this.loadSaved() }).pipe(
      map(({ s, mine }) => ({
        mine: mine.map(savedItem),
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
        mineError: this.savedScriptsError(),
      })),
    );
  }

  /**
   * Loads "My scripts" from the engine, first uploading any scripts an older build left in
   * localStorage. Never errors: a failure sets {@link savedScriptsError}, toasts once and keeps the
   * last known list (plus un-migrated local scripts, so nothing disappears from view).
   */
  loadSaved(): Observable<SavedChartScript[]> {
    // One load at a time: two overlapping loads would both upload the same localStorage scripts.
    this.inflight ??= this.fetchSaved().pipe(
      finalize(() => (this.inflight = null)),
      shareReplay({ bufferSize: 1, refCount: false }),
    );
    return this.inflight;
  }

  private inflight: Observable<SavedChartScript[]> | null = null;

  constructor() {
    // "My scripts" are ready (and any localStorage leftovers migrated) before the dialog opens.
    this.loadSaved().subscribe();
  }

  private fetchSaved(): Observable<SavedChartScript[]> {
    return this.scripting.listChartScripts().pipe(
      switchMap((remote) => this.migrateLegacy(remote)),
      map(({ remote, leftovers }) => {
        const list = [...remote.map(fromDto), ...leftovers];
        this.savedScripts.set(list);
        if (!leftovers.length) this.savedScriptsError.set(null);
        return list;
      }),
      catchError((err: Error) => {
        const message = err?.message || 'Your scripts could not be loaded.';
        this.savedScriptsError.set(message);
        this.notify.error(message);
        return of(this.savedScripts());
      }),
    );
  }

  /** Uploads localStorage scripts not already in the engine; clears the key only if all succeed. */
  private migrateLegacy(
    remote: ChartIndicatorScriptDto[],
  ): Observable<{ remote: ChartIndicatorScriptDto[]; leftovers: SavedChartScript[] }> {
    const legacy = readLegacy();
    if (!legacy.length) return of({ remote, leftovers: [] });
    // A previous partial migration already uploaded some: same name + source is the same script.
    const pending = legacy.filter(
      (l) => !remote.some((r) => r.name === l.name.trim() && r.pineSource === l.source),
    );
    if (!pending.length) {
      clearLegacy();
      return of({ remote, leftovers: [] });
    }
    return from(pending).pipe(
      concatMap((l) =>
        this.scripting
          .createChartScript({ name: l.name.trim() || 'Untitled script', pineSource: l.source })
          .pipe(
            map((dto) => ({ ok: true as const, dto, local: l })),
            catchError((e: Error) => of({ ok: false as const, error: e?.message ?? '', local: l })),
          ),
      ),
      toArray(),
      map((results) => {
        const uploaded = results.flatMap((r) => (r.ok ? [r.dto] : []));
        const failed = results.flatMap((r) => (r.ok ? [] : [r]));
        if (!failed.length) {
          clearLegacy();
          if (uploaded.length)
            this.notify.success(
              `Moved ${uploaded.length} script(s) from this browser to the engine.`,
            );
        } else {
          const message =
            `${failed.length} of ${pending.length} script(s) saved in this browser could not be moved to the engine ` +
            `(${failed[0].local.name}: ${failed[0].error || 'failed'}). They stay in this browser and will be retried.`;
          this.savedScriptsError.set(message);
          this.notify.error(message);
        }
        return {
          remote: [...uploaded, ...remote],
          leftovers: failed.map((f) => ({ ...f.local, id: `local-${f.local.id}` })),
        };
      }),
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
  compile(
    source: string,
    symbol?: string,
    resolution?: TvResolution,
  ): Observable<ScriptCompileResult> {
    return this.scripting.compile({
      source,
      symbol: symbol ?? null,
      timeframe: resolution ? runTimeframeFor(resolution) : null,
    });
  }

  /** An ad-hoc item for source typed in the editor. */
  itemForSource(
    source: string,
    kind: 'indicator' | 'strategy',
    name = 'Untitled script',
  ): ChartScriptItem {
    return {
      key: 'editor:current',
      source: 'mine',
      name,
      description: '',
      kind,
      pineSource: source,
    };
  }

  /**
   * Saves (or overwrites by name) a script in "My scripts" on the engine. Rejects with
   * `ScriptingApiError` (compile errors carry the compile response) and leaves the list unchanged.
   */
  saveScript(
    name: string,
    source: string,
    _kind?: 'indicator' | 'strategy',
  ): Observable<SavedChartScript> {
    const trimmed = name.trim() || 'Untitled script';
    const existing = this.savedScripts().find(
      (s) => s.name === trimmed && !s.id.startsWith('local-'),
    );
    const req = { name: trimmed, pineSource: source };
    const call$ = existing
      ? this.scripting.updateChartScript(Number(existing.id), req)
      : this.scripting.createChartScript(req);
    return call$.pipe(
      map(fromDto),
      tap((saved) =>
        this.savedScripts.update((list) => [saved, ...list.filter((s) => s.id !== saved.id)]),
      ),
    );
  }

  /** Deletes a saved script (engine, or a not-yet-migrated local one). */
  deleteScript(id: string): Observable<void> {
    const drop = () => this.savedScripts.update((list) => list.filter((s) => s.id !== id));
    if (id.startsWith('local-')) {
      const localId = id.slice('local-'.length);
      writeLegacy(readLegacy().filter((s) => s.id !== localId));
      drop();
      return of(undefined);
    }
    return this.scripting.deleteChartScript(Number(id)).pipe(tap(drop));
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

function fromDto(d: ChartIndicatorScriptDto): SavedChartScript {
  return {
    id: String(d.id),
    name: d.name,
    source: d.pineSource,
    kind: d.kind === 'strategy' ? 'strategy' : 'indicator',
    updatedAt: Date.parse(d.updatedAt) || Date.now(),
  };
}

function readLegacy(): SavedChartScript[] {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((s) => s && typeof s.id === 'string' && typeof s.source === 'string')
      : [];
  } catch {
    return [];
  }
}

function writeLegacy(list: SavedChartScript[]): void {
  try {
    if (list.length) localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(list));
    else localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    /* storage blocked */
  }
}

function clearLegacy(): void {
  writeLegacy([]);
}
