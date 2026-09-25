import { signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom, type Observable } from 'rxjs';
import { ApiError } from '@core/api/api.types';
import { formatUnits } from '../core/quantity';
import type { PineChartData } from '../model/chart-data';
import { mergeOutputs } from '../model/merge-outputs';
import type {
  PineBar,
  PineDeclaration,
  PineReplayFrame,
  PineReplayPosition,
  PineReplayStartRequest,
  PineReplayStartResponse,
  PineReplayStepRequest,
  PineRunRequest,
} from '../model/pine-outputs.types';

/** The §5 calls a replay needs (ScriptingRunService implements it). */
export interface ReplayApi {
  startReplay(request: PineReplayStartRequest): Observable<PineReplayStartResponse>;
  stepReplay(sessionId: string, request: PineReplayStepRequest): Observable<PineReplayFrame>;
  stopReplay(sessionId: string): Observable<unknown>;
}

export type ReplayStatus =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'stepping'
  | 'playing'
  | 'ended'
  | 'error';

/** Bars per second while playing. */
export const REPLAY_SPEEDS = [1, 2, 5, 10, 20] as const;

/**
 * The strategy position after a replay frame, as the controls print it: "long 100,000 units @
 * 1.17012 P/L +12.40", "flat", or null when the frame carries no size. The size is the emulator's,
 * in Pine units — never broker lots.
 */
export function replayPositionText(p: PineReplayPosition | null | undefined): string | null {
  if (!p) return null;
  const size = typeof p.size === 'number' && Number.isFinite(p.size) ? p.size : null;
  if (size === null) return null;
  if (size === 0) return 'flat';
  const parts = [`${size > 0 ? 'long' : 'short'} ${formatUnits(Math.abs(size))}`];
  if (typeof p.avgPrice === 'number') parts.push(`@ ${p.avgPrice}`);
  if (typeof p.openProfit === 'number')
    parts.push(`P/L ${p.openProfit >= 0 ? '+' : ''}${p.openProfit.toFixed(2)}`);
  return parts.join(' ');
}

export interface ReplayTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const browserTimers: ReplayTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * One Bar Replay session (§5): start at a bar, step 1/5/20 bars, play/pause at a speed, stop.
 *
 * The first frame is the snapshot up to the start bar; every step's frame is appended — new bars
 * concatenated (a bar the engine re-sends replaces the old copy), per-bar outputs spliced by bar
 * index, whole-exported state (drawings, tables, logs) replaced — so `data` is always a complete
 * chart input the chart can extend in place. Requests never overlap: playing schedules the next
 * step only after the previous frame lands.
 */
export class ReplaySession {
  readonly status = signal<ReplayStatus>('idle');
  readonly error = signal<string | null>(null);
  /** Accumulated chart input (null when no session). */
  readonly data = signal<PineChartData | null>(null);
  /** bar_index of the last replayed bar. */
  readonly barIndex = signal<number | null>(null);
  readonly startBar = signal<number | null>(null);
  readonly position = signal<PineReplayPosition | null>(null);
  /** Bars per second while playing. */
  readonly speed = signal<number>(2);

  private sessionId: string | null = null;
  private timer: unknown = null;
  private busy = false;
  /** Bumped by stop()/start() so late responses of an abandoned session are ignored. */
  private generation = 0;

  private readonly apiOf: () => ReplayApi;

  constructor(
    api: ReplayApi | (() => ReplayApi),
    private readonly timers: ReplayTimers = browserTimers,
  ) {
    this.apiOf = typeof api === 'function' ? api : () => api;
  }

  private get api(): ReplayApi {
    return this.apiOf();
  }

  get active(): boolean {
    return this.sessionId !== null;
  }

  async start(
    request: PineRunRequest,
    startBar: number,
    declaration: PineDeclaration | null,
  ): Promise<void> {
    this.stop();
    const gen = ++this.generation;
    this.status.set('starting');
    this.error.set(null);
    this.startBar.set(startBar);
    try {
      const res = await firstValueFrom(
        this.api.startReplay({ ...request, startBar: Math.max(0, Math.trunc(startBar)) }),
      );
      if (gen !== this.generation) {
        this.api.stopReplay(res.sessionId).subscribe({ error: () => undefined });
        return;
      }
      this.sessionId = res.sessionId;
      const f = res.frame;
      this.data.set({
        bars: f.bars,
        outputs: f.outputsDelta,
        report: f.report ?? null,
        declaration,
      });
      this.barIndex.set(f.barIndex >= 0 ? f.barIndex : startBar);
      this.position.set(f.position ?? null);
      this.status.set('ready');
    } catch (e) {
      if (gen !== this.generation) return;
      this.fail(e);
    }
  }

  /** Steps `bars` bars; resolves false when the replay reached the end or failed. */
  async step(bars: number): Promise<boolean> {
    if (!this.sessionId || this.busy) return false;
    const id = this.sessionId;
    const gen = this.generation;
    const playing = this.status() === 'playing';
    this.busy = true;
    if (!playing) this.status.set('stepping');
    try {
      const frame = await firstValueFrom(
        this.api.stepReplay(id, { bars: Math.max(1, Math.min(500, Math.trunc(bars))) }),
      );
      if (gen !== this.generation) return false;
      if (frame.bars.length === 0) {
        this.clearTimer();
        this.status.set('ended');
        return false;
      }
      const prev = this.data();
      this.data.set({
        bars: appendBars(prev?.bars ?? [], frame.bars),
        outputs: mergeOutputs(prev?.outputs ?? null, frame.outputsDelta),
        report: frame.report ?? prev?.report ?? null,
        declaration: prev?.declaration ?? null,
      });
      if (frame.barIndex >= 0) this.barIndex.set(frame.barIndex);
      this.position.set(frame.position ?? null);
      if (this.status() !== 'playing') this.status.set('ready');
      return true;
    } catch (e) {
      if (gen !== this.generation) return false;
      this.clearTimer();
      this.fail(e);
      return false;
    } finally {
      if (gen === this.generation) this.busy = false;
    }
  }

  play(): void {
    if (!this.sessionId || this.status() === 'playing') return;
    if (this.status() === 'ended' || this.status() === 'error') return;
    this.status.set('playing');
    this.schedule(0);
  }

  pause(): void {
    this.clearTimer();
    if (this.status() === 'playing') this.status.set('ready');
  }

  setSpeed(barsPerSecond: number): void {
    this.speed.set(Math.max(0.1, barsPerSecond));
  }

  /** Ends the session (DELETE) and clears the replayed data. */
  stop(): void {
    this.generation++;
    this.clearTimer();
    this.busy = false;
    const id = this.sessionId;
    this.sessionId = null;
    if (id) this.api.stopReplay(id).subscribe({ error: () => undefined });
    this.data.set(null);
    this.barIndex.set(null);
    this.position.set(null);
    this.startBar.set(null);
    this.error.set(null);
    this.status.set('idle');
  }

  private schedule(delay: number): void {
    this.clearTimer();
    this.timer = this.timers.setTimeout(async () => {
      this.timer = null;
      if (this.status() !== 'playing') return;
      const ok = await this.step(1);
      if (ok && this.status() === 'playing') this.schedule(1000 / this.speed());
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  private fail(e: unknown): void {
    this.status.set('error');
    this.error.set(replayErrorMessage(e));
    if (isExpired(e)) this.sessionId = null;
  }
}

/** New frame bars after the ones held; a re-sent bar (same or earlier time) replaces the tail. */
export function appendBars(held: readonly PineBar[], incoming: readonly PineBar[]): PineBar[] {
  if (!incoming.length) return [...held];
  if (!held.length) return [...incoming];
  const firstNew = incoming[0].t;
  let keep = held.length;
  while (keep > 0 && held[keep - 1].t >= firstNew) keep--;
  return [...held.slice(0, keep), ...incoming];
}

function isExpired(e: unknown): boolean {
  if (e instanceof HttpErrorResponse) return e.status === 404 || e.status === 410;
  if (e instanceof ApiError) return e.isNotFound;
  return false;
}

export function replayErrorMessage(e: unknown): string {
  if (isExpired(e))
    return 'The replay session expired (sessions end after 30 minutes idle). Start it again.';
  if (e instanceof ApiError) return e.message || 'The engine rejected the replay request.';
  if (e instanceof HttpErrorResponse) {
    if (e.status === 0) return 'The engine is unreachable.';
    return `Replay failed (HTTP ${e.status}).`;
  }
  return e instanceof Error ? e.message : 'Replay failed.';
}
