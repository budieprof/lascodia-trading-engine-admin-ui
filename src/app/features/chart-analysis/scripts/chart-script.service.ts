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
  ChartIndicatorScriptDetailDto,
  ChartScriptVersionDetailDto,
  ChartScriptVersionDto,
  CreateChartScriptRequest,
  ScriptCompileResult,
  ScriptInputValues,
  ScriptLibraryVisibility,
  ScriptRunBar,
  ScriptRunRequest,
  ScriptStrategyPropertyOverrides,
  TradingViewScriptImportDto,
  UpdateChartScriptRequest,
} from '@core/api/scripting.types';
import type { StrategyDto } from '@core/api/api.types';
import { parseSavedInputs } from '@features/scripting/pine/pine-saved-inputs';
import { pruneInputValues, sameInputValues } from '@features/scripting/pine/pine-inputs';
import type { TvResolution } from '../datafeed/resolution';
import { EXAMPLE_STRATEGIES } from './example-strategies';
import {
  runTimeframeFor,
  toChartScriptResult,
  type ChartScriptResult,
  type ScriptBasis,
} from './chart-script.model';

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
  /**
   * PC-I5: a strategy's `strategy()` property overrides from the Strategy Tester's Properties, sent
   * with each of its runs (scripting API §3d). For this chart session; absent = the script's own.
   */
  strategyProperties?: ScriptStrategyPropertyOverrides;
}

/** How a run for the chart is made, beyond the script, series, inputs and window (`runOnChart`). */
export interface ChartRunOptions {
  /**
   * The chart's forming bar, run as the realtime bar so an indicator's last value sits on the bar
   * the chart is forming: indicators on the standard bars, in a run that ends now. Ignored otherwise.
   */
  liveBar?: ScriptRunBar | null;
  /** The bars to compute on (PC-09): the chart's Heikin-Ashi candles, else the standard bars. */
  chartType?: ScriptBasis;
  /**
   * Run on the bars that open before this instant (Unix ms) instead of up to now — Bar Replay sends
   * its head bar's close (PC-08, PC-I8), so the head is the run's last bar and nothing after it is
   * computed. Null or absent: up to now.
   */
  toMs?: number | null;
  /** Record every variable of these bars (`bar_index`, inclusive): the Pine Logs dock (PC-I6). */
  trace?: { fromBar: number; toBar: number };
  /** Time each source line: the Pine Logs dock's profiler (PC-I6). */
  profile?: boolean;
  /**
   * PC-I1 (scripting API §3c): keep the run warm on the engine — its `session` then streams the changes (frames) and
   * the chart stops asking for the whole run on every tick. Indicators on a live, standard chart.
   */
  keepWarm?: boolean;
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
  /** C4: the saved state's revision (send it back with the next save); null on an older engine. */
  revision?: string | null;
  /** `Private` (its owner only) or `Shared` (every operator can see and run it). */
  visibility?: ScriptLibraryVisibility;
  /** The caller owns it; another operator's shared script is read-only here (save a copy). */
  ownedByMe?: boolean;
  /** Who saved it. */
  createdBy?: string | null;
  /** Newest version number (0: saved before version history and not changed since). */
  latestVersion?: number;
  /** An import from TradingView: where it came from, its licence and author. */
  sourceUrl?: string | null;
  licence?: string | null;
  author?: string | null;
}

/** The saved script an editor buffer is bound to: what a save updates, and from which revision. */
export interface ChartScriptTarget {
  id: string;
  /** The revision the edit started from; a newer saved state is refused (`-409`). */
  revision: string | null;
  /** The inputs saved with the script — re-sent unchanged (a save replaces them). */
  inputs?: ScriptInputValues;
}

/** What {@link ChartScriptService.saveScript} saves. */
export interface ChartScriptSaveRequest {
  name: string;
  source: string;
  /** Update this saved script; absent creates a new one. */
  target?: ChartScriptTarget | null;
  /** Recorded on the version this save writes. */
  note?: string | null;
  /** A new script's visibility (Private when absent). */
  visibility?: ScriptLibraryVisibility | null;
  /** An import from TradingView being saved for the first time. */
  origin?: { sourceUrl: string; licence?: string | null; author?: string | null } | null;
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
    remote: ChartIndicatorScriptDetailDto[],
  ): Observable<{ remote: ChartIndicatorScriptDetailDto[]; leftovers: SavedChartScript[] }> {
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
    opts: ChartRunOptions = {},
  ): Observable<ChartScriptResult> {
    const chartType = opts.chartType ?? 'standard';
    const toMs = opts.toMs ?? null;
    const run = (overrides: ScriptInputValues | undefined): Observable<ChartScriptResult> => {
      const req: ScriptRunRequest = {
        symbol,
        timeframe: runTimeframeFor(resolution),
        lastBars: Math.max(1, Math.min(MAX_LAST_BARS, Math.round(lastBars))),
        mode: item.kind === 'strategy' ? 'backtest' : 'preview',
        theme: this.theme.theme(),
      };
      // The engine loads the `lastBars` confirmed bars opening before toUtc.
      if (toMs !== null) req.toUtc = new Date(toMs).toISOString();
      if (chartType !== 'standard') req.chartType = chartType;
      if (item.strategyId !== undefined) req.strategyId = item.strategyId;
      else req.source = item.pineSource ?? '';
      if (overrides && Object.keys(overrides).length) req.inputs = overrides;
      if (
        item.kind === 'strategy' &&
        item.strategyProperties &&
        Object.keys(item.strategyProperties).length
      )
        req.strategyProperties = { ...item.strategyProperties };
      // Indicators run the chart's forming bar as the realtime bar; strategies backtest closed
      // bars. The engine takes it on the standard chart only, for a run that ends now.
      const liveBar = opts.liveBar ?? null;
      if (liveBar && req.mode === 'preview' && chartType === 'standard' && toMs === null)
        req.liveBar = liveBar;
      if (opts.trace) req.trace = opts.trace;
      if (opts.profile) req.profile = true;
      if (
        opts.keepWarm &&
        req.mode === 'preview' &&
        chartType === 'standard' &&
        toMs === null &&
        !opts.trace &&
        !opts.profile
      )
        req.keepWarm = true;
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

  /**
   * An ad-hoc item for source typed in the editor, under `key` — its own (PC-07: every editor
   * script shared `editor:current`, so a second one replaced the first), or the key of the saved
   * script whose source it is (`mine:<id>`, which keeps its Settings' "Save as default").
   */
  itemForSource(
    source: string,
    kind: 'indicator' | 'strategy',
    name = 'Untitled script',
    key = newEditorKey(),
  ): ChartScriptItem {
    return {
      key,
      source: 'mine',
      name,
      description: '',
      kind,
      pineSource: source,
    };
  }

  /**
   * Saves a script to "My scripts" (PE-07, contract C4). With a `target` it updates that saved
   * script — sending the revision the edit started from, so a newer saved state is refused with
   * `-409` (`ScriptingApiError.isConflict`) instead of being overwritten — and re-sends the inputs
   * saved with it (an update replaces them). Without one it creates a new script: never an
   * overwrite of another script that happens to share the name (the editor asks about that first,
   * see {@link findOwnByName}). Rejects with `ScriptingApiError` (compile errors carry the compile
   * response) and leaves the list unchanged.
   */
  saveScript(req: ChartScriptSaveRequest): Observable<SavedChartScript> {
    const name = req.name.trim() || 'Untitled script';
    const note = req.note?.trim() || null;
    let call$: Observable<ChartIndicatorScriptDetailDto>;
    if (req.target) {
      if (!/^\d+$/.test(req.target.id)) {
        return throwError(
          () => new ScriptingApiError('Only a script saved in the engine can be updated.'),
        );
      }
      const inputs =
        req.target.inputs && Object.keys(req.target.inputs).length ? req.target.inputs : null;
      const body: UpdateChartScriptRequest = {
        name,
        pineSource: req.source,
        inputs,
        ...(req.target.revision ? { expectedRevision: req.target.revision } : {}),
        ...(note ? { note } : {}),
      };
      call$ = this.scripting.updateChartScript(Number(req.target.id), body);
    } else {
      const body: CreateChartScriptRequest = {
        name,
        pineSource: req.source,
        ...(req.visibility ? { visibility: req.visibility } : {}),
        ...(note ? { note } : {}),
        ...(req.origin
          ? {
              sourceUrl: req.origin.sourceUrl,
              licence: req.origin.licence ?? null,
              author: req.origin.author ?? null,
            }
          : {}),
      };
      call$ = this.scripting.createChartScript(body);
    }
    return call$.pipe(
      map(fromDto),
      tap(() => {
        // Saving a draft's name for real retires the draft.
        const drafts = readDrafts();
        const rest = drafts.filter((d) => d.name.trim() !== name);
        if (rest.length !== drafts.length) {
          writeDrafts(rest);
          this.savedScripts.update((list) =>
            list.filter((s) => !(s.id.startsWith('draft-') && s.name.trim() === name)),
          );
        }
      }),
      tap((saved) => this.remember(saved)),
    );
  }

  /** The operator's own engine script called `name` (trimmed), other than `exceptId`; else null. */
  findOwnByName(name: string, exceptId: string | null = null): SavedChartScript | null {
    const trimmed = name.trim();
    return (
      this.savedScripts().find(
        (s) =>
          s.name.trim() === trimmed &&
          s.id !== exceptId &&
          /^\d+$/.test(s.id) &&
          s.ownedByMe !== false,
      ) ?? null
    );
  }

  /** `name`, else the first free `name (2)`, `name (3)`… among the operator's own scripts. */
  freeName(name: string): string {
    const base = name.trim() || 'Untitled script';
    if (!this.findOwnByName(base)) return base;
    for (let n = 2; n < 1000; n++) {
      const candidate = `${base} (${n})`;
      if (!this.findOwnByName(candidate)) return candidate;
    }
    return `${base} (${Date.now()})`;
  }

  /** A saved script as the engine has it now (and remembered in the list). */
  latest(id: string): Observable<SavedChartScript> {
    return this.scripting.getChartScript(Number(id)).pipe(
      map(fromDto),
      tap((s) => this.remember(s)),
    );
  }

  /** A saved script's versions, newest first, without sources. */
  versions(id: string): Observable<ChartScriptVersionDto[]> {
    return this.scripting.listChartScriptVersions(Number(id));
  }

  /** One version with its source. */
  version(id: string, versionId: number): Observable<ChartScriptVersionDetailDto> {
    return this.scripting.getChartScriptVersion(Number(id), versionId);
  }

  /** Makes an older version current (saved as the next version). `-409` when stale. */
  restore(
    id: string,
    versionId: number,
    expectedRevision: string | null,
  ): Observable<SavedChartScript> {
    return this.scripting.restoreChartScriptVersion(Number(id), versionId, expectedRevision).pipe(
      map(fromDto),
      tap((s) => this.remember(s)),
    );
  }

  /** Shares a script with every operator, or makes it private again (owner only). */
  setVisibility(id: string, visibility: ScriptLibraryVisibility): Observable<SavedChartScript> {
    return this.scripting.setChartScriptVisibility(Number(id), visibility).pipe(
      map(fromDto),
      tap((s) => this.remember(s)),
    );
  }

  /** Fetches an open-source TradingView script to open as an unsaved draft (nothing is stored). */
  importFromTradingView(url: string): Observable<TradingViewScriptImportDto> {
    return this.scripting.importTradingViewScript(url.trim());
  }

  private remember(saved: SavedChartScript): void {
    this.savedScripts.update((list) => [saved, ...list.filter((s) => s.id !== saved.id)]);
  }

  /**
   * "Save as default": stores `inputs` (overrides only; none clears them) with a script in "My
   * scripts" — what a copy added to a chart starts with. The update replaces name, source and
   * inputs, so it re-sends the name and source the engine has NOW — with that state's revision, so
   * an edit saved from another tab in between is never overwritten (C4): a stale read is retried
   * once on a fresh one. Rejects with `ScriptingApiError`; only engine scripts have inputs.
   */
  saveDefaultInputs(id: string, inputs: ScriptInputValues): Observable<SavedChartScript> {
    if (!/^\d+$/.test(id)) {
      return throwError(
        () => new ScriptingApiError('Only a script saved in the engine can keep default inputs.'),
      );
    }
    const attempt = (retry: boolean): Observable<ChartIndicatorScriptDetailDto> =>
      this.scripting.getChartScript(Number(id)).pipe(
        switchMap((latest) =>
          this.scripting.updateChartScript(Number(id), {
            name: latest.name,
            pineSource: latest.pineSource,
            inputs: Object.keys(inputs).length ? inputs : null,
            ...(latest.revision ? { expectedRevision: latest.revision } : {}),
          }),
        ),
        catchError((err: unknown) =>
          retry && err instanceof ScriptingApiError && err.isConflict
            ? attempt(false)
            : throwError(() => err),
        ),
      );
    return attempt(true).pipe(
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

let editorSeq = 0;

/** A fresh key for a script run from the editor's text: each one its own (PC-07). */
export function newEditorKey(): string {
  return `editor:${Date.now().toString(36)}${(++editorSeq).toString(36)}`;
}

/**
 * The key "Update on chart" runs the editor's source under (PC-07): an editor script keeps its
 * own; a saved script ("My scripts") stays itself while the source is exactly what is saved — its
 * Settings keep "Save as default" and a layout reopens it as saved; anything else edited (an engine
 * strategy, an example, a saved script with unsaved edits) becomes an editor script of its own.
 * Null target (a new script): a new key.
 */
export function editorRunKey(
  target: { key: string } | null,
  source: string,
  saved: readonly SavedChartScript[],
): string {
  if (!target) return newEditorKey();
  if (target.key.startsWith('editor:')) return target.key;
  const m = /^mine:(.+)$/.exec(target.key);
  if (m && saved.some((s) => s.id === m[1] && s.source === source)) return target.key;
  return newEditorKey();
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
  const kind = s.kind === 'strategy' ? 'Strategy' : 'Indicator';
  return {
    key: `mine:${s.id}`,
    source: 'mine',
    name: s.name,
    description: s.id.startsWith('draft-')
      ? 'Unsaved draft (compile error)'
      : s.ownedByMe === false
        ? `${kind} · shared by ${s.createdBy || 'another operator'}`
        : s.visibility === 'Shared'
          ? `${kind} · shared`
          : kind,
    kind: s.kind,
    pineSource: s.source,
  };
}

function fromDto(d: ChartIndicatorScriptDetailDto): SavedChartScript {
  return {
    id: String(d.id),
    name: d.name,
    source: d.pineSource,
    kind: d.kind === 'strategy' ? 'strategy' : 'indicator',
    updatedAt: Date.parse(d.updatedAt) || Date.now(),
    inputs: parseSavedInputs(d.inputs),
    revision: d.revision ?? null,
    visibility: d.visibility === 'Shared' ? 'Shared' : 'Private',
    // An engine from before C4 lists only the caller's own scripts.
    ownedByMe: d.ownedByMe !== false,
    createdBy: d.createdBy ?? null,
    latestVersion: d.latestVersion ?? 0,
    sourceUrl: d.sourceUrl ?? null,
    licence: d.licence ?? null,
    author: d.author ?? null,
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
