// The engine's watch checklist (WatchChecklistBuilder): every step a monitor needs before it fires, met steps ticked.
// Sent on the recommendation detail (per monitor) and on the monitor detail.

export type RecWatchStepStatus = 'done' | 'current' | 'pending' | 'failed' | 'stopped';
export type RecWatchLane = 'candle' | 'live' | 'file' | 'time';

export interface RecWatchStepDto {
  number: number;
  title: string;
  /** The exact condition, when the title is a name for it. */
  detail: string | null;
  lane: RecWatchLane;
  status: RecWatchStepStatus;
  /** Open time of the candle that met the step (fire time for a live/engine step). */
  doneAtUtc: string | null;
  doneClose: number | null;
  rules: string[];
}

export interface RecWatchGuardDto {
  text: string;
  /** "from arming" | "after step 1" | "while waiting for step 2". */
  scope: string;
  lane: RecWatchLane;
  /** Applies at the watch's current step. */
  active: boolean;
}

export interface RecWatchChecklistDto {
  kind: string;
  title: string;
  judgedOn: string;
  state: 'waiting' | 'fired' | 'broken' | 'expired' | 'cancelled' | 'paused' | 'error' | string;
  stateNote: string;
  done: number;
  total: number;
  steps: RecWatchStepDto[];
  guards: RecWatchGuardDto[];
}
