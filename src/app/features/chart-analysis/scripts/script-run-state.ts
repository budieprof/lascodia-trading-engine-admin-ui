import { ScriptingApiError } from '@core/services/scripting.service';
import type { PineCallFrame } from '@shared/pine-chart/model/pine-outputs.types';
import type { ChartScriptResult } from './chart-script.model';

/**
 * What the chart page knows about each script's runs besides the run it draws (PC-05, PC-13,
 * PC-I7): whether its latest run failed, and how — per script, never one line for all of them.
 * Pure.
 */

/** Why a script's latest run did not land on the chart. */
export interface ScriptFailure {
  /**
   * `error`: its explicit run failed — added from the dialog, new inputs, a restored layout; it is
   * not on the chart, or not with those inputs. `stale`: a quiet re-run failed (a tick, the minute
   * timer) — the chart still shows the run before it, which is getting old.
   */
  kind: 'error' | 'stale';
  message: string;
  /** Where in the source (1-based); null when the failure has no place (a refusal, the network). */
  where: { line: number; column: number } | null;
  /** The imported library the place is in (`publisher/name/version`); null: the script's own source. */
  unit: string | null;
  /** A runtime error's user-function calls, innermost first. */
  callStack: readonly PineCallFrame[];
  /** When it happened (client ms). */
  atMs: number;
}

/** A failed run result (a compile or runtime error) as the script's failure. */
export function failureOfResult(
  result: ChartScriptResult,
  kind: ScriptFailure['kind'],
  nowMs: number,
): ScriptFailure {
  // The chip names the line on its own: "Line 3: x" and "x (line 3)" read as "x" beside it.
  const message = (result.error ?? 'The run failed.')
    .replace(/^Line \d+: /, '')
    .replace(/ \(line \d+\)$/, '');
  return {
    kind,
    message,
    where: result.errorAt,
    unit: result.errorUnit,
    callStack: result.errorStack,
    atMs: nowMs,
  };
}

/** A failed request (a refusal, the network) as the script's failure. */
export function failureOfError(
  err: unknown,
  kind: ScriptFailure['kind'],
  nowMs: number,
): ScriptFailure {
  const message = err instanceof Error && err.message ? err.message : 'The run failed.';
  return { kind, message, where: null, unit: null, callStack: [], atMs: nowMs };
}

/** Whether a failure is the engine being busy (contract C5): never shown as a script error. */
export function isBusy(err: unknown): err is ScriptingApiError {
  return err instanceof ScriptingApiError && err.isBusy;
}

/** How many times an explicit run refused as busy is sent again before it is reported. */
export const MAX_BUSY_RETRIES = 6;

/**
 * How long to wait before running again after a busy refusal: what the engine asked
 * (`retryAfterMs`, else its `Retry-After`), else 2, 4, 8, 16 … 30 s by `attempt` (0-based).
 */
export function busyWaitMs(err: unknown, attempt: number): number {
  const asked = err instanceof ScriptingApiError ? err.retryAfterMs : null;
  if (asked !== null && asked >= 0) return Math.min(60_000, Math.max(250, asked));
  return Math.min(30_000, 2_000 * 2 ** Math.max(0, attempt));
}

/** "Line 12", with its column when past the first, or null when the failure has no place. */
export function lineLabel(f: Pick<ScriptFailure, 'where'>): string | null {
  return f.where ? `Line ${f.where.line}` : null;
}

/**
 * The failure's hover text: the message, where it is (a library's line is not this script's),
 * the call stack it happened in (innermost first), and for a stale run how old the chart's run is.
 */
export function failureTitle(f: ScriptFailure, lastGoodMs: number | null = null): string {
  const lines = [f.message];
  if (f.where && f.unit) lines.push(`In library ${f.unit}, line ${f.where.line}.`);
  for (const c of f.callStack) {
    const at = c.line ? ` at line ${c.line}` : '';
    lines.push(`  in ${c.function || 'a function'}()${at}${c.unit ? ` (${c.unit})` : ''}`);
  }
  if (f.kind === 'stale') {
    lines.push(
      lastGoodMs === null
        ? 'The chart shows the last run that worked.'
        : `The chart shows the run from ${timeLabel(lastGoodMs)}, the last that worked.`,
    );
  }
  return lines.join('\n');
}

function timeLabel(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19) + ' UTC';
}
