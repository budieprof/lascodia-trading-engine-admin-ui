import type { ScriptRunSession, ScriptSessionFrame } from '@core/api/scripting.types';
import { mergeOutputs } from '@shared/pine-chart/model/merge-outputs';
import { normalizeBars, normalizeOutputs, normalizeRuntimeError } from '@shared/pine-chart/model/normalize';
import type { PineBar } from '@shared/pine-chart/model/pine-outputs.types';
import type { ChartScriptResult } from './chart-script.model';

/**
 * Warm chart sessions on the client (PC-I1, scripting API §3c): an indicator's run on the live chart is kept warm on the
 * engine (`keepWarm`), which then executes only what is new — a closed candle, the latest quote — and pushes what
 * changed (`scriptFrame`, at most one a second). The chart folds each frame into the run it holds instead of asking for
 * the whole run again.
 */

/** Where one script's warm session stands on the client. */
export interface WarmSession {
  /** The chart script (`ChartScriptItem.key`). */
  key: string;
  sessionId: string;
  /** The last frame folded in (consecutive per session). */
  seq: number;
  /** bar_index of the run's last bar, and whether it is the forming one. */
  barIndex: number;
  lastBarForming: boolean;
  /** When the last frame (or the run) landed, client ms. */
  lastFrameAt: number;
}

/** What to do with a frame. */
export type FrameDecision =
  | { kind: 'apply'; key: string }
  /** Frames were missed: ask for everything since `sinceSeq` (`GET scripting/sessions/{id}/frame`). */
  | { kind: 'resync'; key: string; sessionId: string; sinceSeq: number }
  /** The session ended (its frame says why): the script runs again in full. */
  | { kind: 'ended'; key: string; note: string }
  /** Not ours, or an old copy: nothing. */
  | { kind: 'ignore' };

/**
 * The warm sessions of the chart's scripts, by key: which session a frame belongs to, whether it follows the last one,
 * and which scripts the chart may stop re-running on every tick (their session keeps them current). Pure bookkeeping —
 * the page subscribes and applies.
 */
export class WarmSessionBook {
  private readonly byKey = new Map<string, WarmSession>();
  private readonly keyBySession = new Map<string, string>();

  /** A run landed with a warm session: frames of it are this script's from here on. Returns the session it replaced. */
  attach(key: string, session: ScriptRunSession | null | undefined, nowMs: number): WarmSession | null {
    const previous = this.byKey.get(key) ?? null;
    if (!session?.warm || !session.id) {
      if (previous) this.detach(key);
      return previous;
    }
    if (previous && previous.sessionId !== session.id) this.keyBySession.delete(previous.sessionId);
    const next: WarmSession = {
      key,
      sessionId: session.id,
      seq: session.seq,
      barIndex: session.barIndex,
      lastBarForming: session.lastBarForming,
      lastFrameAt: nowMs,
    };
    this.byKey.set(key, next);
    this.keyBySession.set(session.id, key);
    return previous && previous.sessionId !== session.id ? previous : null;
  }

  /** The script left the chart (or its session ended): forget it. Returns its session, if any. */
  detach(key: string): WarmSession | null {
    const s = this.byKey.get(key) ?? null;
    if (!s) return null;
    this.byKey.delete(key);
    this.keyBySession.delete(s.sessionId);
    return s;
  }

  get(key: string): WarmSession | null {
    return this.byKey.get(key) ?? null;
  }

  /** The key a session belongs to. */
  keyOf(sessionId: string): string | null {
    return this.keyBySession.get(sessionId) ?? null;
  }

  /** Every session held. */
  all(): WarmSession[] {
    return [...this.byKey.values()];
  }

  /**
   * Whether the chart may leave `key`'s tick re-runs to its session: a session is attached and has been heard from
   * within `staleMs` (frames come at most every second while something changes — and every bar close at least; a
   * session quiet for longer than that is not trusted to be alive, and the tick re-runs resume).
   */
  isLive(key: string, nowMs: number, staleMs: number): boolean {
    const s = this.byKey.get(key);
    return !!s && nowMs - s.lastFrameAt <= staleMs;
  }

  /** What to do with `frame` (see {@link FrameDecision}). Does not change anything: {@link applied} does. */
  decide(frame: ScriptSessionFrame): FrameDecision {
    const key = this.keyBySession.get(frame.sessionId);
    const s = key ? this.byKey.get(key) : undefined;
    if (!key || !s) return { kind: 'ignore' };
    if (frame.reset) return { kind: 'ended', key, note: frame.note || 'The warm session ended.' };
    if (frame.seq <= s.seq) return { kind: 'ignore' };
    if (frame.seq !== s.seq + 1) return { kind: 'resync', key, sessionId: s.sessionId, sinceSeq: s.seq };
    return { kind: 'apply', key };
  }

  /** A frame of `key` was folded in (or a resync covering up to its `seq`). */
  applied(key: string, frame: Pick<ScriptSessionFrame, 'seq' | 'barIndex' | 'lastBarForming'>, nowMs: number): void {
    const s = this.byKey.get(key);
    if (!s) return;
    s.seq = Math.max(s.seq, frame.seq);
    s.barIndex = frame.barIndex;
    s.lastBarForming = frame.lastBarForming;
    s.lastFrameAt = nowMs;
  }

  /** A sign of life without changes (a resync that found nothing new). */
  touch(key: string, nowMs: number): void {
    const s = this.byKey.get(key);
    if (s) s.lastFrameAt = nowMs;
  }

  clear(): WarmSession[] {
    const all = this.all();
    this.byKey.clear();
    this.keyBySession.clear();
    return all;
  }
}

/**
 * Folds a frame into the run the chart holds (PC-I1): bars before the frame's first are kept, the frame's replace the
 * rest; per-bar outputs are spliced by bar index and drawings, tables, alerts and logs taken whole (the replay merge,
 * `mergeOutputs`). Null when the frame cannot be folded (no run held, or it does not reach the run's bars) — the
 * caller then resyncs or runs again.
 */
export function applyFrame(result: ChartScriptResult, frame: ScriptSessionFrame): ChartScriptResult | null {
  const run = result.run;
  if (!run?.outputs) return null;
  const bars = normalizeBars(frame.bars);
  const delta = normalizeOutputs(frame.outputsDelta ?? null);
  if (!delta) return null;
  const base = run.outputs;
  const baseEnd = base.bars.firstIndex + base.bars.times.length;
  // A frame that starts past the run's end (a frame was skipped) cannot be spliced without a hole.
  if (delta.bars.times.length > 0 && delta.bars.firstIndex > baseEnd) return null;
  const outputs = mergeOutputs(base, delta);
  const runtimeError = frame.runtimeError ? normalizeRuntimeError(frame.runtimeError) : run.runtimeError;
  return {
    ...result,
    run: { ...run, bars: mergeBars(run.bars, bars), outputs, runtimeError },
  };
}

/** Bars by open time: `base`'s before `delta`'s first, then `delta`'s (a re-sent forming bar replaces the old one). */
export function mergeBars(base: readonly PineBar[], delta: readonly PineBar[]): PineBar[] {
  if (!delta.length) return [...base];
  const first = delta[0].t;
  let cut = base.length;
  while (cut > 0 && base[cut - 1].t >= first) cut--;
  return [...base.slice(0, cut), ...delta];
}

/** The bar_index of the forming bar of a run that has one (its last bar), else null. */
export function formingIndexOf(result: ChartScriptResult, lastBarForming: boolean): number | null {
  const out = result.run?.outputs;
  if (!lastBarForming || !out || !out.bars.times.length) return null;
  return out.bars.firstIndex + out.bars.times.length - 1;
}
