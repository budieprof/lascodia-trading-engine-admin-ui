import type { ScriptInputValues } from '@core/api/scripting.types';
import type { PineRunRequest } from '@shared/pine-chart/model/pine-outputs.types';
import type { ChartScriptItem } from '../../scripts/chart-script.service';
import { runTimeframeFor } from '../../scripts/chart-script.model';
import { barCloseMs, type LiveRerunScheduler } from '../../scripts/live-bar';
import type { ChartScriptRun } from './chart-analysis-page.component';
import { MAX_SCRIPT_BARS } from './chart-page.config';
import type { RunOutcome, ScriptEngineHost } from './chart-script-engine';

/** What Bar Replay's script runs read on the chart page (a part of the engine's host, by the page's names). */
export type ReplayRunsHost = Pick<
  ScriptEngineHost,
  'scriptRuns' | 'bars' | 'replay' | 'replayClosedHead' | 'replayHead' | 'serverClock' | 'replayScripts'
>;

/** What it needs of the script engine: its scheduler (tickets) and a full run when a step cannot be taken. */
export interface ReplayRunner {
  scheduler: () => Pick<LiveRerunScheduler, 'isCurrent' | 'settle' | 'request'>;
  runScript: (
    item: ChartScriptItem,
    values: ScriptInputValues,
    replace: boolean,
    done: ((r: RunOutcome) => void) | undefined,
    quiet: number,
  ) => void;
}

/**
 * U13 (fu-ui) — Bar Replay's script runs (CC-I4), moved out of the script engine unchanged: an indicator on the chart
 * follows the head through its engine replay session (only the bars the head moved over are executed) instead of a full
 * run to the new head; the sessions are stopped with their script or when replay ends. The sessions themselves are the
 * page's `ReplayScriptSessions` (read through the host, so a spec can hand its own).
 */
export class ChartReplayRuns {
  constructor(
    private readonly host: ReplayRunsHost,
    private readonly runner: ReplayRunner,
  ) {}

  /**
   * Bar Replay moved forward (CC-I4): an indicator's run on the chart follows through its engine replay session —
   * only the bars the head moved over are executed — instead of a full run to the new head. False (the caller runs
   * it in full) for a strategy (its tester result is not in a frame), a basis other than the standard bars, a run
   * that is not at an earlier head, or a move the step endpoint does not take; a step that fails also ends in a full
   * run.
   */
  step(run: ChartScriptRun, ticket: number): boolean {
    const head = this.host.replayClosedHead();
    const until = run.until ?? null;
    const runBars = run.result.run?.bars ?? [];
    if (
      run.result.kind === 'strategy' ||
      (run.chartType ?? 'standard') !== 'standard' ||
      until === null ||
      !head ||
      head.time <= until ||
      !runBars.length
    )
      return false;
    const bars = this.host.bars();
    const untilIdx = bars.findIndex((b) => b.time === until);
    const headIdx = this.host.replay.cursor().index - 1;
    const steps = headIdx - untilIdx;
    // The session's window reaches the last closed bar loaded, so later steps need no new session.
    const now = this.host.serverClock.now();
    let lastClosed = bars.length - 1;
    while (lastClosed > headIdx && barCloseMs(bars[lastClosed], run.resolution) > now) lastClosed--;
    const lastBars = runBars.length + (lastClosed - untilIdx);
    const signature = JSON.stringify([
      run.item.strategyId ?? run.item.pineSource ?? '',
      run.values,
      run.symbol,
      run.resolution,
    ]);
    if (untilIdx < 0 || lastBars > MAX_SCRIPT_BARS || !this.host.replayScripts.usable(signature, steps))
      return false;
    const request: PineRunRequest = {
      symbol: run.symbol,
      timeframe: runTimeframeFor(run.resolution),
      lastBars,
      mode: 'preview',
      toUtc: new Date(barCloseMs(bars[lastClosed], run.resolution)).toISOString(),
      ...(run.item.strategyId !== undefined
        ? { strategyId: run.item.strategyId }
        : { source: run.item.pineSource ?? '' }),
      ...(Object.keys(run.values).length ? { inputs: run.values } : {}),
    };
    const key = run.item.key;
    void this.host.replayScripts
      .step(
        {
          key,
          signature,
          request,
          startBar: runBars.length - 1,
          firstTime: runBars[0].t,
          fromTime: until,
          toTime: head.time,
          steps,
        },
        run.result,
      )
      .then((result) => {
        if (!this.runner.scheduler().isCurrent(key, ticket)) {
          this.runner.scheduler().settle(key, ticket);
          return;
        }
        const held = this.host.scriptRuns().find((r) => r.item.key === key);
        if (!result || held !== run) {
          // The step failed, or the run changed meanwhile: in full, as before.
          this.runner.runScript(run.item, run.values, true, undefined, ticket);
          return;
        }
        this.host.scriptRuns.update((list) =>
          list.map((r) =>
            r === run ? { ...r, result, until: head.time, landedAt: Date.now() } : r,
          ),
        );
        this.runner.scheduler().settle(key, ticket);
        // The head moved on (or replay ended) while it stepped: once more, to where it is now.
        if (head.time !== this.host.replayHead()) this.runner.scheduler().request(key);
      });
    return true;
  }

  /** Its replay session follows the run on the chart; an explicit run, or removing it, ends it. */
  stop(key: string): void {
    this.host.replayScripts.stop(key);
  }

  /** Replay ended, the series changed, or the page goes: every replay session ends. */
  stopAll(): void {
    this.host.replayScripts.stopAll();
  }
}
