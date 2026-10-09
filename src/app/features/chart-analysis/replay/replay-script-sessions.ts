import { firstValueFrom } from 'rxjs';
import type { ReplayApi } from '@shared/pine-chart/replay/replay-session';
import type { PineReplayFrame, PineRunRequest } from '@shared/pine-chart/model/pine-outputs.types';
import { mergeOutputs } from '@shared/pine-chart/model/merge-outputs';
import type { ChartScriptResult } from '../scripts/chart-script.model';
import { mergeBars } from '../scripts/warm-sessions';

/**
 * Bar Replay's cheap steps for the chart's indicators (CC-I4, scripting API §5): instead of a full run to every new
 * head, the engine's replay session executes only the bars the head moved over and answers with a frame, which is
 * folded into the run on the chart.
 *
 * A session is opened at the head of the run on the chart — the same request, over a window that reaches past the
 * head — and is used only when the engine's bars line up with that run's (same first bar, same count, same last bar);
 * otherwise, or on any failure, the caller runs the script in full as before. One session per script; a different
 * script, inputs or series, or a head that moved back, ends it.
 */
export interface ReplayStepPlan {
  /** The chart script (`ChartScriptItem.key`). */
  key: string;
  /** What the run is: source / strategy id, inputs, symbol, timeframe, basis. Another signature ends the session. */
  signature: string;
  /** The run request over the session's window (its `toUtc` past the head, `lastBars` covering it). */
  request: PineRunRequest;
  /** bar_index of the run's last bar (its head) in that window. */
  startBar: number;
  /** The run on the chart: its first bar's and last bar's open (Unix ms). */
  firstTime: number;
  fromTime: number;
  /** The new head's open, and how many bars from the run's head to it. */
  toTime: number;
  steps: number;
}

interface Held {
  sessionId: string;
  signature: string;
  /** The open of the bar the session stands on. */
  atTime: number;
}

/** Most bars one step request may move (the endpoint's limit). */
export const MAX_REPLAY_STEP = 500;

export class ReplayScriptSessions {
  private readonly held = new Map<string, Held>();
  /** Signatures whose engine window did not line up with the chart's: full runs for them. */
  private readonly unaligned = new Set<string>();

  constructor(private readonly api: ReplayApi) {}

  /** Whether a step for this script is worth trying (not known to misalign, a forward move the endpoint takes). */
  usable(signature: string, steps: number): boolean {
    return !this.unaligned.has(signature) && steps >= 1 && steps <= MAX_REPLAY_STEP;
  }

  /**
   * The run on the chart moved forward to the plan's head through a replay session: the folded result, or null when
   * the caller must run the script in full (no session could be opened or aligned, the engine refused, the frame did
   * not end on the head).
   */
  async step(plan: ReplayStepPlan, result: ChartScriptResult): Promise<ChartScriptResult | null> {
    if (!this.usable(plan.signature, plan.steps) || !result.run?.outputs) return null;
    let held = this.held.get(plan.key);
    if (held && (held.signature !== plan.signature || held.atTime !== plan.fromTime)) {
      this.stop(plan.key);
      held = undefined;
    }
    try {
      if (!held) {
        const start = await firstValueFrom(this.api.startReplay({ ...plan.request, startBar: plan.startBar }));
        const bars = start.frame.bars;
        const aligned =
          bars.length === plan.startBar + 1 &&
          bars[0]?.t === plan.firstTime &&
          bars[bars.length - 1]?.t === plan.fromTime;
        if (!aligned) {
          this.unaligned.add(plan.signature);
          this.api.stopReplay(start.sessionId).subscribe({ error: () => undefined });
          return null;
        }
        held = { sessionId: start.sessionId, signature: plan.signature, atTime: plan.fromTime };
        this.held.set(plan.key, held);
      }
      const frame = await firstValueFrom(this.api.stepReplay(held.sessionId, { bars: plan.steps }));
      if (frame.bars.at(-1)?.t !== plan.toTime) {
        this.stop(plan.key);
        return null;
      }
      const folded = foldReplayFrame(result, frame);
      if (!folded) {
        this.stop(plan.key);
        return null;
      }
      held.atTime = plan.toTime;
      return folded;
    } catch {
      // Busy, refused, expired: the full run decides what to say.
      this.stop(plan.key);
      return null;
    }
  }

  /** End `key`'s session (the script left the chart, or the head moved back). */
  stop(key: string): void {
    const held = this.held.get(key);
    if (!held) return;
    this.held.delete(key);
    this.api.stopReplay(held.sessionId).subscribe({ error: () => undefined });
  }

  /** End every session (replay ended, the series changed). */
  stopAll(): void {
    for (const key of [...this.held.keys()]) this.stop(key);
    this.unaligned.clear();
  }

  /** Whether `key` has a session (tests). */
  has(key: string): boolean {
    return this.held.has(key);
  }
}

/**
 * Folds a replay frame into the run on the chart: bars after the frame's first are replaced, per-bar outputs spliced
 * by bar index, drawings / tables / logs taken whole (the replay merge). Indicators only: a strategy's tester result
 * is not in a frame. Null when the frame does not continue the run (a gap).
 */
export function foldReplayFrame(result: ChartScriptResult, frame: PineReplayFrame): ChartScriptResult | null {
  const run = result.run;
  const delta = frame.outputsDelta;
  if (!run?.outputs || !delta) return null;
  const end = run.outputs.bars.firstIndex + run.outputs.bars.times.length;
  if (delta.bars.times.length > 0 && delta.bars.firstIndex > end) return null;
  const outputs = mergeOutputs(run.outputs, delta);
  if (!outputs) return null;
  return {
    ...result,
    run: { ...run, bars: mergeBars(run.bars, frame.bars), outputs },
  };
}
