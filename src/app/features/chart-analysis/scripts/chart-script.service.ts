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
  throwError,
  toArray,
} from 'rxjs';

import { NotificationService } from '@core/notifications/notification.service';
import { ThemeService } from '@core/theme/theme.service';

import { ScriptingApiError, ScriptingService } from '@core/services/scripting.service';
import { StrategiesService } from '@core/services/strategies.service';
import type {
  ChartIndicatorScriptDto,
  SaveChartIndicatorScriptRequest,
  ScriptCompileResult,
  ScriptInputValues,
  ScriptRunBar,
  ScriptRunRequest,
} from '@core/api/scripting.types';
import type { StrategyDto } from '@core/api/api.types';
import { parseSavedInputs } from '@features/scripting/pine/pine-saved-inputs';
import { pruneInputValues, sameInputValues } from '@features/scripting/pine/pine-inputs';
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
  /**
   * The engine id as a string; `local-…` for a script still only in this browser (not migrated
   * yet, retried), `draft-…` for one the engine refused to compile (kept in this browser to fix).
   */
  id: string;
  name: string;
  source: string;
  kind: 'indicator' | 'strategy';
  updatedAt: number;
  /** Set on an unsaved draft: why the engine refused it. */
  draftReason?: string;
  /**
   * Input values saved with the script ("Save as default" in its settings): what a copy added to a
   * chart starts with. Only scripts in the engine have them.
   */
  inputs?: ScriptInputValues;
}

/** Pre-engine storage of "My scripts"; read once to migrate, then cleared. */
export const LEGACY_STORAGE_KEY = 'lascodia.chart-analysis.scripts.v1';
/** Migrated scripts the engine refused to compile, kept so the operator can fix and re-save them. */
export const DRAFTS_STORAGE_KEY = 'lascodia.chart-analysis.scripts.drafts.v1';
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
  private readonly theme = inject(ThemeService);

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
        const list = [...remote.map(fromDto), ...leftovers, ...readDrafts().map(asDraftItem)];
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

  /**
   * Uploads localStorage scripts not already in the engine. A script the engine refuses for good
   * (`-11` compile error / `library()`, `-01` validation) becomes an unsaved draft under
   * {@link DRAFTS_STORAGE_KEY} — still openable, fixable and re-savable — and the main key is
   * cleared once every script has either uploaded or become a draft. Transient failures (network,
   * 5xx) keep the key so the next load retries them. Each outcome toasts once, here.
   */
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
            catchError((e: ScriptingApiError) =>
              of({
                ok: false as const,
                error: e?.message ?? '',
                permanent: isPermanentRefusal(e),
                local: l,
              }),
            ),
          ),
      ),
      toArray(),
      map((results) => {
        const uploaded = results.flatMap((r) => (r.ok ? [r.dto] : []));
        const refused = results.flatMap((r) => (!r.ok && r.permanent ? [r] : []));
        const transient = results.flatMap((r) => (!r.ok && !r.permanent ? [r] : []));

        if (refused.length) {
          const drafts = readDrafts();
          for (const r of refused)
            drafts.push({ ...r.local, id: `draft-${r.local.id}`, draftReason: r.error });
          writeDrafts(drafts);
        }
        // Everything either uploaded or became a draft: the legacy key has done its job.
        if (!transient.length) clearLegacy();
        else writeLegacy(transient.map((t) => t.local));

        if (uploaded.length)
          this.notify.success(
            `Moved ${uploaded.length} script(s) from this browser to the engine.`,
          );
        if (refused.length)
          this.notify.warning(
            `${refused.length} script(s) from this browser do not compile and were kept as unsaved drafts ` +
              `in My scripts (${refused[0].local.name}: ${refused[0].error || 'refused'}). Open one, fix it and Save.`,
          );
        if (transient.length) {
          const message =
            `${transient.length} script(s) saved in this browser could not be moved to the engine ` +
            `(${transient[0].local.name}: ${transient[0].error || 'failed'}). They stay in this browser and will be retried.`;
          this.savedScriptsError.set(message);
          this.notify.error(message);
        }
        return {
          remote: [...uploaded, ...remote],
          leftovers: transient.map((f) => ({ ...f.local, id: `local-${f.local.id}` })),
        };
      }),
    );
  }

  /**
   * Runs an item over the chart's symbol and resolution. Strategies run as `backtest`, indicators
   * as `preview`. A script that does not compile resolves (with `error` and `diagnostics` set);
   * only transport failures reject (`ScriptingApiError`). The chart follows the console's theme,
   * so the run is told the theme of the moment (Pine `chart.bg_color` / `chart.fg_color`).
   *
   * <p>Input overrides may have been made for an earlier version of the script — a restored layout,
   * a saved default, the editor's update of a script on the chart. An id the script no longer
   * declares is ignored by the engine, but a value that no longer fits its input (the type, range
   * or options changed) gets the whole run refused. So a refused run with overrides learns the
   * inputs from a run on the defaults and runs again with only the overrides that still fit; when
   * all of them still fit, the refusal was about something else and stands.</p>
   */
  runOnChart(
    item: ChartScriptItem,
    symbol: string,
    resolution: TvResolution,
    inputs?: ScriptInputValues,
    lastBars = DEFAULT_LAST_BARS,
    liveBar?: ScriptRunBar | null,
  ): Observable<ChartScriptResult> {
    const run = (overrides: ScriptInputValues | undefined): Observable<ChartScriptResult> => {
      const req: ScriptRunRequest = {
        symbol,
        timeframe: runTimeframeFor(resolution),
        lastBars: Math.max(1, Math.min(MAX_LAST_BARS, Math.round(lastBars))),
        mode: item.kind === 'strategy' ? 'backtest' : 'preview',
        theme: this.theme.theme(),
      };
      if (item.strategyId !== undefined) req.strategyId = item.strategyId;
      else req.source = item.pineSource ?? '';
      if (overrides && Object.keys(overrides).length) req.inputs = overrides;
      // Indicators run the chart's forming bar as the realtime bar; strategies backtest closed
      // bars.
      if (liveBar && req.mode === 'preview') req.liveBar = liveBar;
      return this.scripting.run(req).pipe(map((res) => toChartScriptResult(res)));
    };
    if (!inputs || !Object.keys(inputs).length) return run(undefined);
    return run(inputs).pipe(
      catchError((err: unknown) => {
        if (!isRefusal(err)) throw err;
        return run(undefined).pipe(
          switchMap((base) => {
            if (base.error || !base.compile) return of(base);
            const kept = pruneInputValues(base.inputs, inputs);
            if (sameInputValues(kept, inputs)) throw err;
            return Object.keys(kept).length ? run(kept) : of(base);
          }),
        );
      }),
    );
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
   * An overwrite keeps the inputs saved with the script — the engine replaces them on every
   * update — as the engine has them now, not as this page last read them.
   */
  saveScript(
    name: string,
    source: string,
    _kind?: 'indicator' | 'strategy',
  ): Observable<SavedChartScript> {
    const trimmed = name.trim() || 'Untitled script';
    const existing = this.savedScripts().find(
      (s) => s.name === trimmed && !s.id.startsWith('local-') && !s.id.startsWith('draft-'),
    );
    const req: SaveChartIndicatorScriptRequest = { name: trimmed, pineSource: source };
    const call$ = existing
      ? this.scripting.getChartScript(Number(existing.id)).pipe(
          map((latest) => parseSavedInputs(latest.inputs)),
          catchError(() => of(existing.inputs ?? {})),
          switchMap((inputs) =>
            this.scripting.updateChartScript(
              Number(existing.id),
              Object.keys(inputs).length ? { ...req, inputs } : req,
            ),
          ),
        )
      : this.scripting.createChartScript(req);
    return call$.pipe(
      map(fromDto),
      tap(() => {
        // Saving a draft's name for real retires the draft.
        const drafts = readDrafts();
        const rest = drafts.filter((d) => d.name.trim() !== trimmed);
        if (rest.length !== drafts.length) {
          writeDrafts(rest);
          this.savedScripts.update((list) =>
            list.filter((s) => !(s.id.startsWith('draft-') && s.name.trim() === trimmed)),
          );
        }
      }),
      tap((saved) =>
        this.savedScripts.update((list) => [saved, ...list.filter((s) => s.id !== saved.id)]),
      ),
    );
  }

  /**
   * "Save as default": stores `inputs` (overrides only; none clears them) with a script in "My
   * scripts" — what a copy added to a chart starts with. The update replaces name, source and
   * inputs, so it re-sends the name and source the engine has NOW: this page's copy may predate an
   * edit saved from another tab. Rejects with `ScriptingApiError`; only engine scripts have inputs.
   */
  saveDefaultInputs(id: string, inputs: ScriptInputValues): Observable<SavedChartScript> {
    if (!/^\d+$/.test(id)) {
      return throwError(
        () => new ScriptingApiError('Only a script saved in the engine can keep default inputs.'),
      );
    }
    return this.scripting.getChartScript(Number(id)).pipe(
      switchMap((latest) =>
        this.scripting.updateChartScript(Number(id), {
          name: latest.name,
          pineSource: latest.pineSource,
          inputs: Object.keys(inputs).length ? inputs : null,
        }),
      ),
      map(fromDto),
      tap((saved) =>
        this.savedScripts.update((list) => list.map((s) => (s.id === saved.id ? saved : s))),
      ),
    );
  }

  /** Deletes a saved script (engine, or a not-yet-migrated local one). */
  deleteScript(id: string): Observable<void> {
    const drop = () => this.savedScripts.update((list) => list.filter((s) => s.id !== id));
    if (id.startsWith('draft-')) {
      writeDrafts(readDrafts().filter((s) => s.id !== id));
      drop();
      return of(undefined);
    }
    if (id.startsWith('local-')) {
      const localId = id.slice('local-'.length);
      writeLegacy(readLegacy().filter((s) => s.id !== localId));
      drop();
      return of(undefined);
    }
    return this.scripting.deleteChartScript(Number(id)).pipe(tap(drop));
  }
}

/**
 * The engine id of a "My scripts" item (`mine:<id>`) — the only scripts that can keep default
 * inputs. Null for a draft or a script still only in this browser, and for anything not saved
 * there (an engine strategy, an example, the editor's).
 */
export function savedScriptId(item: Pick<ChartScriptItem, 'key' | 'source'>): string | null {
  const m = item.source === 'mine' ? /^mine:(\d+)$/.exec(item.key) : null;
  return m ? m[1] : null;
}

/** The inputs a script added to the chart starts with: a saved script's defaults, else none. */
export function startingValues(
  item: Pick<ChartScriptItem, 'key' | 'source'>,
  saved: readonly SavedChartScript[],
): ScriptInputValues {
  const id = savedScriptId(item);
  const inputs = id === null ? undefined : saved.find((s) => s.id === id)?.inputs;
  return inputs ? { ...inputs } : {};
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
    description: s.id.startsWith('draft-')
      ? 'Unsaved draft (compile error)'
      : s.kind === 'strategy'
        ? 'Strategy'
        : 'Indicator',
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
    inputs: parseSavedInputs(d.inputs),
  };
}

/** A refusal of the run itself (validation, `-11`) that carries no compile failure. */
function isRefusal(err: unknown): err is ScriptingApiError {
  return err instanceof ScriptingApiError && err.code === '-11' && !err.compile;
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

function asDraftItem(d: SavedChartScript): SavedChartScript {
  return d.id.startsWith('draft-') ? d : { ...d, id: `draft-${d.id}` };
}

/** A refusal retrying cannot fix: the script itself is wrong (compile error, library(), validation). */
function isPermanentRefusal(e: ScriptingApiError | null | undefined): boolean {
  if (!e) return false;
  if (e.code === '-11' || e.code === '-01') return true;
  return e.httpStatus === 400 || e.httpStatus === 422;
}

function readDrafts(): SavedChartScript[] {
  try {
    const raw = localStorage.getItem(DRAFTS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((s) => s && typeof s.id === 'string' && typeof s.source === 'string')
      : [];
  } catch {
    return [];
  }
}

function writeDrafts(list: SavedChartScript[]): void {
  try {
    if (list.length) localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(list));
    else localStorage.removeItem(DRAFTS_STORAGE_KEY);
  } catch {
    /* storage blocked */
  }
}
