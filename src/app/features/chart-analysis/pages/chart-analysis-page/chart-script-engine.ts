import { signal, type DestroyRef, type WritableSignal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Subscription } from 'rxjs';

import type { ScriptInputValues, ScriptSessionFrame } from '@core/api/scripting.types';
import type { NotificationService } from '@core/notifications/notification.service';
import type { ScriptingRealtimeService } from '@core/realtime/scripting-realtime.service';
import type { ScriptingService } from '@core/services/scripting.service';
import type { ServerClock } from '@core/time/server-clock';
import { pruneInputValues } from '@features/scripting/pine/pine-inputs';
import type { Bar } from '../../datafeed/candle-feed.service';
import type { TvResolution } from '../../datafeed/resolution';
import type { ReplayController } from '../../replay/replay-controller';
import type { ReplayScriptSessions } from '../../replay/replay-script-sessions';
import type { ChartScriptItem, ChartScriptService } from '../../scripts/chart-script.service';
import { editorReport, type ChartScriptResult, type ScriptBasis } from '../../scripts/chart-script.model';
import {
  LiveRerunScheduler,
  barCloseMs,
  formingLiveBar,
  sameSeries,
  type SeriesId,
} from '../../scripts/live-bar';
import { detectRepaint, markUnconfirmed, repaintText } from '../../scripts/realtime-truth';
import { placeRun } from '../../scripts/run-on-host';
import { resolveDisplay } from '../../scripts/script-display';
import type { ScriptEditorPanelComponent } from '../../scripts/script-editor-panel.component';
import {
  MAX_BUSY_RETRIES,
  busyWaitMs,
  failureOfError,
  failureOfResult,
  isBusy,
  type ScriptFailure,
} from '../../scripts/script-run-state';
import type { ScriptSettings } from '../../scripts/script-settings';
import { WarmSessionBook, applyFrame, formingIndexOf } from '../../scripts/warm-sessions';
import type { WorkspaceScript } from '../../workspace/workspace-state';
import type { ChartScriptRun } from './chart-analysis-page.component';
import { ChartReplayRuns } from './chart-replay-runs';
import { MAX_SCRIPT_BARS, PAGE_BARS } from './chart-page.config';

/**
 * Quiet script re-runs (live ticks, the minute timer, a theme switch): at least this many ms between
 * two runs of a script — longer for a slow one, whose runs are spaced by 4× their round trip
 * (LiveRerunScheduler).
 */
export const LIVE_RERUN_MS = 2_000;
/** What a script run hands whoever waits on it: its result, or why there is none. */
export type RunOutcome = ChartScriptResult | { error: string };
/** Told to whoever waits on a run that a newer run of the same script replaced. */
export const SUPERSEDED = 'A newer run of this script replaced this one.';

/** "Update on chart" (PC-06): the run of the editor's text and the chart script it was edited from. */
export interface ScriptUpdate {
  /** The script on the chart it replaces once it lands; null for a new script. */
  replaces: string | null;
}

/** A script run in flight: a newer run, or removing the script, aborts its request (or the busy retry it waits for). */
export interface RunInFlight {
  ticket: number;
  sub: { unsubscribe(): void };
  done?: (r: RunOutcome) => void;
}

/** A script asked onto the chart whose first run has not landed (on its way, or failed). */
export interface PendingScript {
  item: ChartScriptItem;
  values: ScriptInputValues;
  symbol: string;
  resolution: TvResolution;
}

/**
 * What the script engine reads and drives on the chart page (U13 fu-ui). Every member has the page's own name: the
 * page hands an object of getters over its members, and the specs that build the page from its prototype hand the page.
 */
export interface ScriptEngineHost {
  /** The Pine runs on the chart — the engine lands, folds and retires runs here. */
  readonly scriptRuns: WritableSignal<ChartScriptRun[]>;
  readonly symbol: () => string;
  readonly resolution: () => TvResolution;
  /** The bars scripts compute on (null: not drawn on this chart type). */
  readonly chartBasis: () => ScriptBasis | null;
  readonly bars: () => Bar[];
  readonly barsFor: () => SeriesId | null;
  // Bar Replay (CC-I4)
  readonly replayActive: () => boolean;
  readonly replayClosedHead: () => Bar | null;
  readonly replayHead: () => number | null;
  readonly replay: Pick<ReplayController, 'cursor'>;
  readonly replayScripts: Pick<ReplayScriptSessions, 'usable' | 'step' | 'stop' | 'stopAll'>;
  readonly serverClock: Pick<ServerClock, 'now'>;
  readonly chartScripts: Pick<ChartScriptService, 'runOnChart'>;
  readonly scriptHub: Pick<
    ScriptingRealtimeService,
    'usable' | 'isConnected' | 'subscribe' | 'unsubscribe'
  >;
  readonly scriptingApi: Pick<ScriptingService, 'endSession' | 'sessionFrame'>;
  readonly destroyRef: DestroyRef;
  readonly scriptEditor: () => Pick<ScriptEditorPanelComponent, 'showCompile'> | undefined;
  readonly notify: Pick<NotificationService, 'error'>;
  /** A restored layout's scripts still on their way (their display is kept for the run that lands). */
  readonly restoringScripts: WritableSignal<WorkspaceScript[]>;
  readonly settings: Pick<ScriptSettings<ChartScriptRun>, 'open' | 'loadStoredInputs' | 'run' | 'close'>;
  // The Pine Editor and the dock (ChartEditorState / ChartDockState), followed when a script is replaced.
  readonly editorKey: WritableSignal<string | null>;
  readonly editorDraft: WritableSignal<{ key: string | null; text: string } | null>;
  readonly logsKey: WritableSignal<string | null>;
  readonly testerOpen: WritableSignal<boolean>;
  frontDock(which: 'editor' | 'tester'): void;
  /** Another strategy took this one's place: the "replaced … Undo" notice. */
  offerUndoReplace(previous: ChartScriptRun, replacement: ChartScriptRun): void;
}

/**
 * The engine's own state. Each piece can be handed in (the specs hand their own, e.g. a scheduler whose quiet re-runs
 * are a spy); what is not is created here. `makeScheduler` builds the scheduler around the engine's quiet re-run.
 */
export interface ScriptEngineState {
  runScheduler: LiveRerunScheduler;
  makeScheduler: (rerun: (key: string, ticket: number) => void) => LiveRerunScheduler;
  runsInFlight: Map<string, RunInFlight>;
  runningKeys: WritableSignal<ReadonlyMap<string, number>>;
  scriptFailures: WritableSignal<ReadonlyMap<string, ScriptFailure>>;
  pendingScripts: WritableSignal<ReadonlyMap<string, PendingScript>>;
  waitingScripts: WritableSignal<ReadonlyMap<string, number>>;
  scriptUpdates: WritableSignal<ReadonlyMap<string, string>>;
  warmSessions: WarmSessionBook;
  warmKeys: WritableSignal<ReadonlySet<string>>;
  scriptRepaints: WritableSignal<ReadonlyMap<string, string>>;
  formingByKey: Map<string, number | null>;
  resyncing: Set<string>;
}

/**
 * U13 (fu-ui) — the chart page's Pine script-run engine, moved out of the page unchanged: every run of the chart's
 * scripts (explicit runs, quiet re-runs through {@link LiveRerunScheduler}, Bar Replay steps through the engine's replay
 * sessions, busy back-off C5), landing a run on the chart, failures / pending / waiting / "Update on chart" state, warm
 * sessions (PC-I1) and realtime truthfulness (PC-I9). The page keeps every old member name as an alias of this state or
 * a one-line delegate, so its template and the rest of its code are unchanged.
 */
export class ChartScriptEngine {
  /**
   * Orders every run of the chart's scripts ({@link LiveRerunScheduler}): only a script's newest run
   * is drawn; an explicit run starts at once and supersedes the one in flight; quiet re-runs (the
   * forming bar ticking, the minute timer, a theme switch) go one at a time per script, spaced by
   * its round trip, and wait for an explicit run in flight.
   */
  readonly runScheduler: LiveRerunScheduler;
  /**
   * Each script's run in flight, so that a newer run, or removing the script, aborts its request —
   * or the retry it waits for after a busy refusal.
   */
  readonly runsInFlight: Map<string, RunInFlight>;
  /** Scripts with an explicit run in flight, by key, with its ticket ({@link runScript}). */
  readonly runningKeys: WritableSignal<ReadonlyMap<string, number>>;
  /** Each script's last failed run, by key (PC-05, PC-13): never one line for all of them. */
  readonly scriptFailures: WritableSignal<ReadonlyMap<string, ScriptFailure>>;
  /**
   * Scripts asked onto the chart whose first run has not landed — on its way, or failed (a dialog
   * pick, a restored layout): their chips show it, with the way to open or remove them.
   */
  readonly pendingScripts: WritableSignal<ReadonlyMap<string, PendingScript>>;
  /** Explicit runs the engine refused as busy (C5), by key: sent again at this time (client ms). */
  readonly waitingScripts: WritableSignal<ReadonlyMap<string, number>>;
  /** "Update on chart" in flight, by the chart script it replaces: its chip shows it updating. */
  readonly scriptUpdates: WritableSignal<ReadonlyMap<string, string>>;
  /** Each script's warm session on the engine (PC-I1). */
  readonly warmSessions: WarmSessionBook;
  /** The scripts their warm session keeps current — the chip's live mark. */
  readonly warmKeys: WritableSignal<ReadonlySet<string>>;
  /** PC-I9: per script, the first repaint seen — its chip says it until the script leaves the chart. */
  readonly scriptRepaints: WritableSignal<ReadonlyMap<string, string>>;
  /** PC-I9: per script, the bar_index of the forming bar of the run on the chart (null: none). */
  readonly formingByKey: Map<string, number | null>;
  /** Resyncs in flight, by script. */
  readonly resyncing: Set<string>;
  /** Bar Replay (CC-I4): runs that follow the head through the engine's replay sessions. */
  readonly replayRuns: ChartReplayRuns;

  constructor(
    private readonly host: ScriptEngineHost,
    state: Partial<ScriptEngineState> = {},
  ) {
    const rerun = (key: string, ticket: number): void => this.rerunQuietly(key, ticket);
    this.runScheduler =
      state.runScheduler ??
      state.makeScheduler?.(rerun) ??
      new LiveRerunScheduler(
        rerun,
        LIVE_RERUN_MS,
        () => Date.now(),
        () => document.hidden,
      );
    this.runsInFlight = state.runsInFlight ?? new Map();
    this.runningKeys = state.runningKeys ?? signal<ReadonlyMap<string, number>>(new Map());
    this.scriptFailures = state.scriptFailures ?? signal<ReadonlyMap<string, ScriptFailure>>(new Map());
    this.pendingScripts = state.pendingScripts ?? signal<ReadonlyMap<string, PendingScript>>(new Map());
    this.waitingScripts = state.waitingScripts ?? signal<ReadonlyMap<string, number>>(new Map());
    this.scriptUpdates = state.scriptUpdates ?? signal<ReadonlyMap<string, string>>(new Map());
    this.warmSessions = state.warmSessions ?? new WarmSessionBook();
    this.warmKeys = state.warmKeys ?? signal<ReadonlySet<string>>(new Set());
    this.scriptRepaints = state.scriptRepaints ?? signal<ReadonlyMap<string, string>>(new Map());
    this.formingByKey = state.formingByKey ?? new Map();
    this.resyncing = state.resyncing ?? new Set();
    this.replayRuns = new ChartReplayRuns(host, {
      scheduler: () => this.runScheduler,
      runScript: (item, values, replace, done, quiet) =>
        this.runScript(item, values, replace, done, quiet),
    });
  }

  /**
   * A quiet re-run the scheduler started: the script as it is on the chart, on the bar forming now
   * — or, in Bar Replay, to the head.
   */
  rerunQuietly(key: string, ticket: number): void {
    const run = this.host.scriptRuns().find((r) => r.item.key === key);
    const chart = { symbol: this.host.symbol(), resolution: this.host.resolution() };
    if (!run || !sameSeries(run, chart)) {
      this.runScheduler.settle(key, ticket);
      return;
    }
    if (this.host.replayActive() && this.stepReplayRun(run, ticket)) return;
    this.runScript(run.item, run.values, true, undefined, ticket);
  }

  /** Bar Replay moved forward (CC-I4): the run follows through its engine replay session ({@link ChartReplayRuns}). */
  stepReplayRun(run: ChartScriptRun, ticket: number): boolean {
    return this.replayRuns.step(run, ticket);
  }

  /**
   * Run a Pine script/strategy over the loaded window and paint it.
   *
   * <p>An explicit run (no `quiet` ticket: adding a script, "Update on chart", new inputs, a symbol
   * switch, a restored layout, more history) shows on its chip, and supersedes the script's run in
   * flight — that request is aborted, and its result would not be drawn: a slow live re-run of an
   * old source landing after "Update on chart" never puts the old source back.</p>
   *
   * <p>A failure is the script's own (PC-05, PC-13): an explicit run's marks its chip with the error
   * (the line to open the editor at, its library, the call stack); a quiet re-run's marks it stale —
   * the chart keeps the run before it, and says how old it is. "Update on chart" (`update`, PC-06)
   * runs the edited text first and puts it in the edited script's place only once it lands: when it
   * fails, the script on the chart stays as it was and the editor shows why. A busy engine (contract
   * C5, `-429`) is never a failure: a quiet re-run backs off for the wait it asks; an explicit run
   * waits on its chip and is sent again, at most {@link MAX_BUSY_RETRIES} times.</p>
   */
  runScript(
    item: ChartScriptItem,
    values: ScriptInputValues,
    replace = false,
    done?: (r: RunOutcome) => void,
    /** The scheduler's ticket for a quiet re-run: no spinner, and a failure keeps the last plots. */
    quiet?: number,
    /** "Update on chart": the editor's text, and the chart script it replaces once it lands. */
    update?: ScriptUpdate,
  ): void {
    const key = item.key;
    const explicit = quiet === undefined;
    const symbol = this.host.symbol();
    const resolution = this.host.resolution();
    // The bars it computes on: the chart's Heikin-Ashi candles, else the standard bars — also on
    // a price-based style, where it is not drawn but ready for the operator's way back (PC-09).
    const basis: ScriptBasis = this.host.chartBasis() ?? 'standard';
    if (explicit) {
      this.abortRun(key, SUPERSEDED);
      // A new attempt: what failed before is not what this run will say. An edit's failure goes to
      // the editor, so the chip it would update keeps its own state meanwhile.
      if (!update) this.dropFailure(key);
    }
    const ticket = quiet ?? this.runScheduler.begin(key);
    if (explicit) {
      this.runningKeys.update((m) => new Map(m).set(key, ticket));
      if (!this.host.scriptRuns().some((r) => r.item.key === key))
        this.pendingScripts.update((m) =>
          new Map(m).set(key, { item, values, symbol, resolution }),
        );
      const target = update?.replaces;
      if (target && target !== key) this.scriptUpdates.update((m) => new Map(m).set(target, key));
    }
    // Never less than a full page: a run started while the chart is still loading would
    // otherwise cover only a sliver of history and stop short when the operator pans back.
    const requestedBars = Math.min(Math.max(this.host.bars().length, PAGE_BARS), MAX_SCRIPT_BARS);
    let over = false;
    let busyRetries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let request: Subscription | null = null;
    /** The Bar Replay head the request in flight runs to (its open, Unix ms); null: to now. */
    let until: number | null = null;
    /** The run is over: off the spinner and out of flight. Whether its result may be drawn. */
    const finish = (): boolean => {
      over = true;
      clearTimeout(retryTimer);
      if (this.runsInFlight.get(key)?.ticket === ticket) this.runsInFlight.delete(key);
      this.clearRunning(key, ticket);
      this.clearWaiting(key);
      this.clearUpdatesBy(key);
      return this.runScheduler.isCurrent(key, ticket);
    };
    const send = (): void => {
      // In Bar Replay, up to the head (PC-08, PC-I8): the bars opening before its close, so the
      // head is the run's last bar and nothing past it is computed. Else up to now, with the
      // chart's forming bar — only once the bars on screen are this symbol's and timeframe's, on
      // the engine's clock (the session grid's periods open and close at the engine's instants).
      // Both taken again for a retry after a busy refusal: it runs to the head, or on the bar
      // forming, then.
      const head = this.host.replayActive() ? this.host.replayClosedHead() : null;
      until = head?.time ?? null;
      const liveBar = head
        ? null
        : formingLiveBar(
            this.host.bars(),
            this.host.barsFor(),
            { symbol, resolution },
            this.host.serverClock.now(),
          );
      request = this.host.chartScripts
        .runOnChart(item, symbol, resolution, values, requestedBars, {
          liveBar,
          chartType: basis,
          toMs: head ? barCloseMs(head, resolution) : null,
          // PC-I1: an indicator on the live chart stays warm on the engine, which then streams what changes.
          ...(!head && item.kind !== 'strategy' && basis === 'standard' && this.host.scriptHub.usable()
            ? { keepWarm: true }
            : {}),
        })
        .pipe(takeUntilDestroyed(this.host.destroyRef))
        .subscribe({
          next: (result) => {
            const current = finish();
            try {
              // A newer run of this script, or its removal, superseded this one.
              if (!current) {
                done?.({ error: SUPERSEDED });
                return;
              }
              // A run for a symbol the operator has since left is stale (the switch ran it again).
              if (symbol !== this.host.symbol() || resolution !== this.host.resolution()) {
                done?.({ error: 'The chart moved to another symbol or timeframe during the run.' });
                return;
              }
              if (result.error) {
                this.runFailed(key, explicit, update, failureOfResult(result, 'error', Date.now()));
                if (update) {
                  // PC-06: the editor marks the diagnostics (a runtime error at its line too).
                  const report = editorReport(result);
                  if (report) this.host.scriptEditor()?.showCompile(report);
                }
                done?.({ error: result.error });
                return;
              }
              this.landRun(
                item,
                result,
                values,
                { symbol, resolution, requestedBars, basis, until, forming: liveBar !== null },
                replace,
                update,
              );
              done?.(result);
            } finally {
              // After the result is in: a re-run waiting on this one reads the script as it is now.
              this.runScheduler.settle(key, ticket);
            }
          },
          error: (err: unknown) => {
            if (isBusy(err)) {
              const wait = busyWaitMs(err, busyRetries);
              if (!explicit) {
                // C5: a quiet re-run backs off for the wait the engine asked — never an error.
                const current = finish();
                if (current) this.runScheduler.backoff(key, wait);
                this.runScheduler.settle(key, ticket);
                done?.({ error: current ? err.message : SUPERSEDED });
                return;
              }
              if (busyRetries < MAX_BUSY_RETRIES && this.runScheduler.isCurrent(key, ticket)) {
                // An explicit run waits on its chip and goes again: the operator asked for it.
                busyRetries++;
                this.waitingScripts.update((m) => new Map(m).set(key, Date.now() + wait));
                retryTimer = setTimeout(send, wait);
                return;
              }
            }
            const current = finish();
            this.runScheduler.settle(key, ticket);
            const message = err instanceof Error ? err.message : 'run failed';
            done?.({ error: current ? message : SUPERSEDED });
            if (!current) return;
            this.runFailed(key, explicit, update, failureOfError(err, 'error', Date.now()));
            if (update) this.host.notify.error(`${item.name}: ${message}`);
          },
        });
    };
    send();
    if (!over)
      this.runsInFlight.set(key, {
        ticket,
        sub: {
          unsubscribe: () => {
            clearTimeout(retryTimer);
            request?.unsubscribe();
          },
        },
        done,
      });
  }

  /**
   * A run came back with its result: it goes on the chart — in its own place for a re-run, in the
   * edited script's for "Update on chart" (which leaves the chart then), last for a new script, and
   * in the place of the strategy on the chart for another strategy (one at a time).
   */
  landRun(
    item: ChartScriptItem,
    result: ChartScriptResult,
    values: ScriptInputValues,
    /** The series, window and bars it ran on, and the Bar Replay head it ran to (null: now). */
    on: {
      symbol: string;
      resolution: TvResolution;
      requestedBars: number;
      basis: ScriptBasis;
      until?: number | null;
      /** The run ended on the chart's forming bar (it was sent as `liveBar`): its last bar is unconfirmed (PC-I9). */
      forming?: boolean;
    },
    replace: boolean,
    update: ScriptUpdate | undefined,
  ): void {
    const { symbol, resolution, requestedBars, basis } = on;
    const until = on.until ?? null;
    const key = item.key;
    // PC-I9: what is on the forming bar shows as unconfirmed, and a closed bar whose value moved since the run on the
    // chart is a repaint. PC-I1: its warm session (if the engine kept one) streams its changes from here on.
    const before = this.host.scriptRuns().find((r) => r.item.key === key);
    const comparable =
      !!before &&
      !update &&
      before.symbol === symbol &&
      before.resolution === resolution &&
      (before.chartType ?? 'standard') === basis &&
      (before.until ?? null) === until &&
      before.item.pineSource === item.pineSource &&
      JSON.stringify(before.values) === JSON.stringify(values);
    result = this.truthful(
      key,
      result,
      result.session?.lastBarForming ?? on.forming === true,
      comparable ? 'run' : null,
    );
    this.attachWarm(key, result);
    // The overrides as they apply to the script that ran: one for an input its source no longer
    // declares, or declares with another type, range or options, is dropped — that input runs on
    // its default (the run fell back to that) and leaves the layout.
    const fitting = result.compile ? pruneInputValues(result.inputs, values) : values;
    const runs = this.host.scriptRuns();
    // How it was shown: its own run's, the edited script's for an edit, a restored layout's.
    const display =
      runs.find((r) => r.item.key === key)?.display ??
      (update?.replaces ? runs.find((r) => r.item.key === update.replaces)?.display : undefined) ??
      this.host.restoringScripts().find((w) => w.key === key)?.display;
    const entry: ChartScriptRun = {
      item,
      result,
      values: fitting,
      symbol,
      resolution,
      requestedBars,
      landedAt: Date.now(),
      chartType: basis,
      ...(until !== null ? { until } : {}),
      ...(display && Object.keys(display).length ? { display } : {}),
    };
    // Added just now — not a re-run, an edit of a script on the chart, or a restored layout: a
    // script with `confirm = true` inputs asks for them (PC-I12).
    const added =
      !replace &&
      !(update?.replaces ?? null) &&
      !runs.some((r) => r.item.key === key) &&
      !this.host.restoringScripts().some((w) => w.key === key);
    // One strategy at a time (its tester owns the bottom panel), in place for a re-run.
    const placed = placeRun(runs, entry, update?.replaces ?? null);
    this.host.scriptRuns.set(placed.runs);
    // A strategy this one replaced is off the chart: its run in flight and its quiet re-runs go
    // with it — one landing late would put it back in place of this one.
    for (const r of placed.replaced) {
      this.abortRun(r.item.key, 'Another strategy took its place on the chart.');
      this.runScheduler.cancel(r.item.key);
      this.dropFailure(r.item.key);
    }
    // An edit took the place of the script it was edited from: that one leaves the chart, and the
    // editor follows its text onto the new one.
    const edited = update?.replaces ?? null;
    if (edited !== null && edited !== key) this.retireScript(edited, key);
    else if (update && edited === null && this.host.editorKey() === null) this.host.editorKey.set(key);
    this.host.restoringScripts.update((l) => l.filter((w) => w.key !== key));
    this.dropPending(key);
    this.dropFailure(key);
    // Bar Replay's head moved, or replay ended, while it ran (PC-08): it runs again to where the
    // chart is now. The head effect judged the run on the chart, not this one in flight, so it
    // may not have asked. A hidden indicator waits until it is shown, as every quiet re-run does.
    if (
      until !== this.host.replayHead() &&
      this.host.chartBasis() !== null &&
      (result.kind === 'strategy' || resolveDisplay(entry.display).visible)
    )
      this.runScheduler.request(key);
    // TradingView asks for a script's `confirm = true` inputs as it is added; Cancel takes it off.
    if (added && result.inputs.some((i) => i.confirm)) this.host.settings.open(key, true);
    if (result.kind === 'strategy') {
      // The defaults its Strategy Tester inputs are measured against (engine strategies).
      this.host.settings.loadStoredInputs(item);
      if (!replace && edited === null) {
        this.host.testerOpen.set(true);
        this.host.frontDock('tester');
        // Added by the operator over another strategy: say so, with the way back.
        const previous = placed.replaced[0];
        if (previous) this.host.offerUndoReplace(previous, entry);
      }
    }
  }

  // ── PC-I1 warm sessions · PC-I9 realtime truthfulness ────────────

  /** Whether `key`'s warm session keeps it current: one is attached and the scripting hub is connected. */
  warmCovered(key: string): boolean {
    return this.warmSessions.get(key) !== null && this.host.scriptHub.isConnected();
  }

  /**
   * PC-I9: the run with what sits on its forming bar marked unconfirmed (faded; drawings made there provisional), and —
   * when `compareWith` says the run on the chart is the same script on the same window — a plot that changed its value
   * on a bar that was already closed recorded as a repaint (a full re-run's newest closed bar is left out: it can be a
   * candle the engine replaced with the stored one, not a repaint).
   */
  truthful(
    key: string,
    result: ChartScriptResult,
    lastBarForming: boolean,
    compareWith: 'run' | 'frame' | null,
  ): ChartScriptResult {
    const outputs = result.run?.outputs;
    if (!result.run || !outputs) {
      this.formingByKey.delete(key);
      return result;
    }
    const forming = formingIndexOf(result, lastBarForming);
    if (compareWith && !this.scriptRepaints().has(key)) {
      const previous =
        this.host.scriptRuns().find((r) => r.item.key === key)?.result.run?.outputs ?? null;
      const prevForming = this.formingByKey.get(key) ?? null;
      const prevEnd = previous ? previous.bars.firstIndex + previous.bars.times.length : null;
      const closedBefore = prevForming ?? prevEnd;
      const limit =
        closedBefore === null ? null : compareWith === 'run' ? closedBefore - 1 : closedBefore;
      const found = detectRepaint(previous, outputs, limit);
      if (found)
        this.scriptRepaints.update((m) =>
          new Map(m).set(
            key,
            repaintText(
              found,
              (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
            ),
          ),
        );
    }
    this.formingByKey.set(key, forming);
    return forming === null
      ? result
      : { ...result, run: { ...result.run, outputs: markUnconfirmed(outputs, forming) } };
  }

  forgetTruth(key: string): void {
    this.formingByKey.delete(key);
    if (!this.scriptRepaints().has(key)) return;
    this.scriptRepaints.update((m) => {
      const next = new Map(m);
      next.delete(key);
      return next;
    });
  }

  /**
   * PC-I1: a run landed — its warm session (if the engine kept one) streams the script's changes from now on, and the
   * session it replaces is let go. A session the hub cannot take is let go at once: the script is re-run per tick as
   * before.
   */
  attachWarm(key: string, result: ChartScriptResult): void {
    const replaced = this.warmSessions.attach(key, result.session, Date.now());
    if (replaced) this.letGo(replaced.sessionId);
    const now = this.warmSessions.get(key);
    this.setWarmKey(key, now !== null);
    if (!now) return;
    const id = now.sessionId;
    void this.host.scriptHub.subscribe(id).then((sub) => {
      if (this.warmSessions.get(key)?.sessionId !== id) return;
      if (!sub) {
        this.releaseWarm(key);
        return;
      }
      // Frames went out before the room was joined: catch up.
      if (sub.seq > now.seq) this.resyncWarm(key);
    });
  }

  /** Lets go of `key`'s warm session (the script left, was re-run without one, or its session cannot be followed). */
  releaseWarm(key: string): void {
    const s = this.warmSessions.detach(key);
    if (s) this.letGo(s.sessionId);
    this.setWarmKey(key, false);
  }

  letGo(sessionId: string): void {
    void this.host.scriptHub.unsubscribe(sessionId);
    this.host.scriptingApi.endSession(sessionId).subscribe();
  }

  setWarmKey(key: string, warm: boolean): void {
    if (this.warmKeys().has(key) === warm) return;
    this.warmKeys.update((set) => {
      const next = new Set(set);
      if (warm) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  /** A pushed frame: folded into its script's run, a resync after a gap, or a full re-run when its session ended. */
  onScriptFrame(frame: ScriptSessionFrame): void {
    const d = this.warmSessions.decide(frame);
    switch (d.kind) {
      case 'apply':
        if (!this.applyWarmFrame(d.key, frame)) this.resyncWarm(d.key);
        return;
      case 'resync':
        this.resyncWarm(d.key);
        return;
      case 'ended':
        this.endWarm(d.key);
        return;
    }
  }

  /** Folds a frame into the run on the chart; false when it cannot (the run is not there or the frame leaves a hole). */
  applyWarmFrame(key: string, frame: ScriptSessionFrame): boolean {
    const chart = { symbol: this.host.symbol(), resolution: this.host.resolution() };
    const run = this.host.scriptRuns().find((r) => r.item.key === key);
    if (!run || !sameSeries(run, chart)) return false;
    const merged = applyFrame(run.result, frame);
    if (!merged) return false;
    const next = this.truthful(key, merged, frame.lastBarForming, 'frame');
    this.host.scriptRuns.update((runs) =>
      runs.map((r) => (r.item.key === key ? { ...r, result: next, landedAt: Date.now() } : r)),
    );
    this.warmSessions.applied(key, frame, Date.now());
    return true;
  }

  /**
   * Asks the session for everything since the last frame folded in (`GET scripting/sessions/{id}/frame?sinceSeq=`): after
   * a gap, a reconnect, and once a minute (a quiet market pushes nothing; a session that ended is found this way).
   */
  resyncWarm(key: string): void {
    const s = this.warmSessions.get(key);
    if (!s || this.resyncing.has(key)) return;
    this.resyncing.add(key);
    const sessionId = s.sessionId;
    this.host.scriptingApi
      .sessionFrame(sessionId, s.seq)
      .pipe(takeUntilDestroyed(this.host.destroyRef))
      .subscribe({
        next: (frame) => {
          this.resyncing.delete(key);
          if (this.warmSessions.get(key)?.sessionId !== sessionId) return;
          if (frame.reset) {
            this.endWarm(key);
            return;
          }
          if (!this.applyWarmFrame(key, frame)) this.endWarm(key);
        },
        error: (err: unknown) => {
          this.resyncing.delete(key);
          if (this.warmSessions.get(key)?.sessionId !== sessionId) return;
          // Busy (C5): asked again at the next minute; anything else (-14: it ended) runs the script again.
          if (!isBusy(err)) this.endWarm(key);
        },
      });
  }

  /** The warm session ended (or cannot be followed): let it go and run the script again — a new session comes with it. */
  endWarm(key: string): void {
    this.releaseWarm(key);
    if (this.host.scriptRuns().some((r) => r.item.key === key)) this.runScheduler.request(key);
  }

  /**
   * A run failed. An edit's failure is the editor's (it shows the diagnostics; the script on the
   * chart stays as it was), and a new script from the editor leaves no chip behind; an explicit
   * run's marks the script's chip; a quiet re-run's marks it stale, unless it already shows an error.
   */
  runFailed(
    key: string,
    explicit: boolean,
    update: ScriptUpdate | undefined,
    failure: ScriptFailure,
  ): void {
    if (update) {
      if (update.replaces === null || update.replaces !== key) this.dropPending(key);
      return;
    }
    if (explicit) {
      this.setFailure(key, failure);
      return;
    }
    if (this.scriptFailures().get(key)?.kind === 'error') return;
    this.setFailure(key, { ...failure, kind: 'stale' });
  }

  /**
   * The script an edit replaced leaves the chart (PC-06): its run in flight, its re-runs and its
   * state go with it, its Settings close, and the editor showing it moves to the edit.
   */
  retireScript(oldKey: string, newKey: string): void {
    this.abortRun(oldKey, 'An edit of this script took its place on the chart.');
    this.runScheduler.cancel(oldKey);
    this.host.restoringScripts.update((l) => l.filter((w) => w.key !== oldKey));
    this.dropPending(oldKey);
    this.dropFailure(oldKey);
    this.clearWaiting(oldKey);
    if (this.host.settings.run()?.item.key === oldKey) this.host.settings.close();
    // Its Pine Logs follow it onto the edit, as the editor does.
    if (this.host.logsKey() === oldKey) this.host.logsKey.set(newKey);
    if (this.host.editorKey() === oldKey) {
      this.host.editorKey.set(newKey);
      const draft = this.host.editorDraft();
      if (draft?.key === oldKey) this.host.editorDraft.set({ key: newKey, text: draft.text });
    }
  }

  setFailure(key: string, failure: ScriptFailure): void {
    this.scriptFailures.update((m) => new Map(m).set(key, failure));
  }

  dropFailure(key: string): void {
    if (!this.scriptFailures().has(key)) return;
    this.scriptFailures.update((m) => {
      const next = new Map(m);
      next.delete(key);
      return next;
    });
  }

  dropPending(key: string): void {
    if (!this.pendingScripts().has(key)) return;
    this.pendingScripts.update((m) => {
      const next = new Map(m);
      next.delete(key);
      return next;
    });
  }

  clearWaiting(key: string): void {
    if (!this.waitingScripts().has(key)) return;
    this.waitingScripts.update((m) => {
      const next = new Map(m);
      next.delete(key);
      return next;
    });
  }

  /** Forget the "Update on chart" `key` is the run of (it ended), and any update OF `key`. */
  clearUpdatesBy(key: string): void {
    const m = this.scriptUpdates();
    if (![...m].some(([target, run]) => target === key || run === key)) return;
    this.scriptUpdates.set(
      new Map([...m].filter(([target, run]) => target !== key && run !== key)),
    );
  }

  /** Abort the run of `key` in flight, if any; whoever waits on it is told `why`. */
  abortRun(key: string, why: string): void {
    // Its replay session follows the run on the chart; an explicit run replaces that run.
    this.replayRuns.stop(key);
    const run = this.runsInFlight.get(key);
    if (!run) return;
    this.runsInFlight.delete(key);
    run.sub.unsubscribe();
    this.clearRunning(key, run.ticket);
    this.clearWaiting(key);
    this.clearUpdatesBy(key);
    run.done?.({ error: why });
  }

  /** Abort every run in flight and forget every script's sequence (a layout is being replaced). */
  abortAllRuns(why: string): void {
    for (const key of [...this.runsInFlight.keys()]) this.abortRun(key, why);
    this.runScheduler.cancelAll();
    for (const s of this.warmSessions.all()) this.releaseWarm(s.key);
    this.runningKeys.set(new Map());
    this.waitingScripts.set(new Map());
    this.scriptUpdates.set(new Map());
    this.pendingScripts.set(new Map());
    this.scriptFailures.set(new Map());
  }

  clearRunning(key: string, ticket: number): void {
    if (this.runningKeys().get(key) !== ticket) return;
    this.runningKeys.update((m) => {
      const next = new Map(m);
      next.delete(key);
      return next;
    });
  }
}
