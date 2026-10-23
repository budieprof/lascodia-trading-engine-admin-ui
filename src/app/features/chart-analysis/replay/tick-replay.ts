import { signal } from '@angular/core';

import { BookTimeline, type BookState } from '@core/realtime/md-book';
import type { MdHistory, MdHistoryRequest } from '@core/realtime/marketdata.types';
import type { Bar } from '../datafeed/candle-feed.service';
import type { FootprintRowDto } from '../orderflow/orderflow.types';

/**
 * Tick + book replay — the unit BELOW Bar Replay's intrabar `sub`: the recorded market-data stream (C5 `md/history`:
 * ticks, book events and the book keyframe at the start) stepped event by event, or played at 1×–100× real time on
 * `requestAnimationFrame`. Windows are fetched ahead of the head ({@link CHUNK_MS} each, the next one once the head is
 * within {@link PREFETCH_MS} of the end); playing past what is loaded waits ("buffering") rather than skipping.
 *
 * Everything at the head comes from the recording: the forming bar is folded from ticks (bid), the book from the
 * keyframe + events ≤ the head, paper fills on ticks at their true bid / ask. Nothing is synthesized: a bar with no
 * tick yet is not drawn, and a head with no book says so.
 */

/** One fetch covers this much (C5 serves ≤ 2 h of book per call). */
export const CHUNK_MS = 15 * 60_000;
/** The next window is fetched when the head is this close to the loaded end. */
export const PREFETCH_MS = 3 * 60_000;
export const SPEEDS = [1, 2, 5, 10, 25, 50, 100] as const;
/** Angular-visible head updates at most this often while playing (renderers that pull read {@link TickReplay.clock}). */
export const HEAD_PUBLISH_MS = 66;

export interface TickReplayDeps {
  history(req: MdHistoryRequest): Promise<MdHistory>;
  symbol(): string;
  /** Source to replay (null: the one with the most book in the first window). */
  sourceId(): string | null;
  /** The newest instant replay may reach (now). */
  now(): number;
  /** Animation frames (tests drive them). */
  raf(cb: (t: number) => void): number;
  caf(id: number): void;
  /** Wall clock for frame deltas. */
  wall(): number;
  /** The head moved from `from` to `to` (forward: the paper broker fills on the ticks between). */
  moved(from: number, to: number): void;
}

/** The recorded tape held for the session: ticks (columns) + the book timeline, over [from, to). */
export class TickTape {
  readonly t: number[] = [];
  readonly b: number[] = [];
  readonly a: number[] = [];
  timeline: BookTimeline;
  from: number;
  to: number;
  sourceId: string | null = null;

  constructor(from: number, keyframe: BookTimeline | null = null) {
    this.from = from;
    this.to = from;
    this.timeline = keyframe ?? new BookTimeline();
  }

  /** Append one window's source data (ticks / book events at or after the current end). */
  append(src: { ticks?: { t: number[]; b: number[]; a: number[] } | null; book?: { t: number; k: 'S' | 'D'; b: [number, number][]; a: [number, number][] }[] | null }, to: number): void {
    const last = this.t.length ? this.t[this.t.length - 1] : -Infinity;
    const ticks = src.ticks;
    if (ticks)
      for (let i = 0; i < ticks.t.length; i++) {
        if (ticks.t[i] < last || ticks.t[i] < this.from) continue;
        this.t.push(ticks.t[i]);
        this.b.push(ticks.b[i]);
        this.a.push(ticks.a[i]);
      }
    for (const e of src.book ?? []) this.timeline.append(e);
    this.to = Math.max(this.to, to);
  }

  /** Ticks with time ≤ `t`. */
  ticksAtOrBefore(t: number): number {
    let lo = 0;
    let hi = this.t.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.t[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Ticks with time < `t` (strictly). */
  ticksBefore(t: number): number {
    let lo = 0;
    let hi = this.t.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.t[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** The first event (tick or book) strictly after `t`, within the tape; null past the end. */
  nextEventAfter(t: number): number | null {
    const i = this.ticksAtOrBefore(t);
    const tick = i < this.t.length ? this.t[i] : Infinity;
    const j = this.timeline.countAtOrBefore(t);
    const book = j < this.timeline.length ? this.timeline.times[j] : Infinity;
    const next = Math.min(tick, book);
    return Number.isFinite(next) ? next : null;
  }

  /** The last event (tick or book) strictly before `t`; null before the tape. */
  prevEventBefore(t: number): number | null {
    const i = this.ticksBefore(t);
    const tick = i > 0 ? this.t[i - 1] : -Infinity;
    const j = this.timeline.countBefore(t);
    const book = j > 0 ? this.timeline.times[j - 1] : -Infinity;
    const prev = Math.max(tick, book);
    return Number.isFinite(prev) && prev >= this.from ? prev : null;
  }

  /** The newest tick at or before `t`. */
  lastTick(t: number): { t: number; bid: number; ask: number } | null {
    const i = this.ticksAtOrBefore(t);
    return i > 0 ? { t: this.t[i - 1], bid: this.b[i - 1], ask: this.a[i - 1] } : null;
  }

  /** The ticks in (from, to]. */
  ticksIn(from: number, to: number): { t: number; bid: number; ask: number }[] {
    const out: { t: number; bid: number; ask: number }[] = [];
    for (let i = this.ticksAtOrBefore(from); i < this.t.length && this.t[i] <= to; i++)
      out.push({ t: this.t[i], bid: this.b[i], ask: this.a[i] });
    return out;
  }

  /** The book after every event ≤ `t` (read-only, valid until the next call). */
  bookAt(t: number): BookState {
    return this.timeline.at(t);
  }
}

/**
 * The bar forming at the head, folded from the tape's bid ticks in [bar open, head]: open = first tick, high / low,
 * close = last tick. Null when the tape has no tick in that span (the caller shows the stored bar's open only).
 */
export function formingBarFromTicks(bar: Bar, tape: TickTape, head: number): Bar | null {
  const i0 = tape.ticksBefore(bar.time);
  const i1 = tape.ticksAtOrBefore(head);
  if (i1 <= i0) return null;
  let high = -Infinity;
  let low = Infinity;
  for (let i = i0; i < i1; i++) {
    if (tape.b[i] > high) high = tape.b[i];
    if (tape.b[i] < low) low = tape.b[i];
  }
  const out: Bar = { time: bar.time, open: tape.b[i0], high, low, close: tape.b[i1 - 1], volume: i1 - i0 };
  if (bar.closeTime !== undefined) out.closeTime = bar.closeTime;
  return out;
}

/**
 * A footprint for [from, to] from the tape's ticks, by the engine's rules (C2 / `TickFlowMinuteBuilder`): the classic
 * tick rule over MID quotes (an unchanged mid carries the last direction; a stream's first quote has none), each tick
 * counted at its BID price. The direction carries in from the ticks before `from` held in the tape.
 */
export function footprintRowsFromTape(tape: TickTape, from: number, to: number): FootprintRowDto[] {
  const i0 = tape.ticksBefore(from);
  const i1 = tape.ticksAtOrBefore(to);
  if (i1 <= i0) return [];
  // The direction going into the window (from the tape's ticks before it).
  let lastMid: number | null = null;
  let dir = 0;
  for (let i = 0; i < i0; i++) {
    const mid = (tape.b[i] + tape.a[i]) / 2;
    if (lastMid !== null) {
      const sgn = mid > lastMid ? 1 : mid < lastMid ? -1 : 0;
      if (sgn !== 0) dir = sgn;
    }
    lastMid = mid;
  }
  const rows = new Map<number, FootprintRowDto>();
  for (let i = i0; i < i1; i++) {
    const mid = (tape.b[i] + tape.a[i]) / 2;
    let d = 0;
    if (lastMid !== null) {
      const sgn = mid > lastMid ? 1 : mid < lastMid ? -1 : 0;
      d = sgn !== 0 ? sgn : dir;
    }
    if (d !== 0) dir = d;
    lastMid = mid;
    if (d === 0) continue;
    const price = tape.b[i];
    const row = rows.get(price) ?? { price, up: 0, down: 0 };
    if (d > 0) row.up++;
    else row.down++;
    rows.set(price, row);
  }
  return [...rows.values()];
}

/**
 * The bars plotted at a tick-replay head: every bar that ENDED by the head, then the bar containing the head folded
 * from its ticks so far (left out until its first tick — even its open is not known before that).
 */
export function tickReplayView(bars: readonly Bar[], head: number, barEnd: (i: number) => number, tape: TickTape | null): Bar[] {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time <= head) lo = mid + 1;
    else hi = mid;
  }
  const containing = lo - 1;
  if (containing < 0) return bars.slice(0, 1);
  if (barEnd(containing) <= head) return bars.slice(0, containing + 1);
  const shown = bars.slice(0, containing);
  const bar = bars[containing];
  const forming = tape ? formingBarFromTicks(bar, tape, head) : null;
  // No tick yet in the bar: nothing of it is known at the head (even its open is the first tick's price).
  if (forming) shown.push(forming);
  return shown.length ? shown : bars.slice(0, 1);
}

export class TickReplay {
  /** The head (epoch ms), every frame; null when not replaying ticks. Renderers pull this. */
  clock: number | null = null;
  /** The head as Angular sees it (≤ 15 Hz while playing). */
  readonly head = signal<number | null>(null);
  readonly playing = signal(false);
  readonly speed = signal<number>(10);
  readonly loading = signal(false);
  /** Playing caught up with what is loaded. */
  readonly buffering = signal(false);
  readonly note = signal<string | null>(null);
  /** Bumped when a window loads. */
  readonly version = signal(0);
  tape: TickTape | null = null;
  private seq = 0;
  private raf: number | null = null;
  private lastWall = 0;
  private lastPublish = 0;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly deps: TickReplayDeps) {}

  get active(): boolean {
    return this.clock !== null;
  }

  /** Start at `t` (a fresh tape from there). */
  async start(t: number): Promise<void> {
    this.pause();
    this.seq++;
    this.clock = t;
    this.publish(true);
    this.tape = null;
    this.note.set(null);
    await this.load(t);
  }

  stop(): void {
    this.pause();
    this.seq++;
    this.clock = null;
    this.tape = null;
    this.head.set(null);
    this.note.set(null);
    this.loading.set(false);
    this.buffering.set(false);
  }

  /** Jump to `t`: inside the tape it moves, outside a new tape is read. */
  async seek(t: number): Promise<void> {
    if (this.clock === null) return this.start(t);
    const tape = this.tape;
    if (tape && t >= tape.from && t <= tape.to) {
      this.moveTo(t);
      this.ensureAhead();
      return;
    }
    const playing = this.playing();
    await this.start(t);
    if (playing) this.play();
  }

  /** One event forward / back (tick or book change). */
  step(dir: 1 | -1): void {
    const tape = this.tape;
    if (this.clock === null || !tape) return;
    this.pause();
    const next = dir > 0 ? tape.nextEventAfter(this.clock) : tape.prevEventBefore(this.clock);
    if (next === null) {
      if (dir > 0) {
        this.note.set(tape.to >= this.deps.now() ? 'At the end of the recording.' : null);
        this.ensureAhead(true);
      }
      return;
    }
    this.moveTo(next);
    this.ensureAhead();
  }

  setSpeed(x: number): void {
    if (Number.isFinite(x) && x > 0) this.speed.set(Math.min(100, Math.max(1, x)));
  }

  play(): void {
    if (this.clock === null || this.playing()) return;
    this.playing.set(true);
    this.lastWall = this.deps.wall();
    this.raf = this.deps.raf(() => this.frame());
  }

  pause(): void {
    if (this.raf !== null) this.deps.caf(this.raf);
    this.raf = null;
    if (this.playing()) this.playing.set(false);
    this.buffering.set(false);
    this.publish(true);
  }

  togglePlay(): void {
    if (this.playing()) this.pause();
    else this.play();
  }

  /** One animation frame of play: the head moves by wall time × speed, never past what is loaded or now. */
  frame(): void {
    this.raf = null;
    if (!this.playing() || this.clock === null) return;
    const wall = this.deps.wall();
    const dt = Math.max(0, Math.min(250, wall - this.lastWall));
    this.lastWall = wall;
    const tape = this.tape;
    const limit = Math.min(tape?.to ?? this.clock, this.deps.now());
    const want = this.clock + dt * this.speed();
    const to = Math.min(want, limit);
    this.buffering.set(want > limit && (tape?.to ?? 0) < this.deps.now());
    if (to > this.clock) this.moveTo(to, false);
    this.ensureAhead();
    if (this.clock >= this.deps.now()) {
      this.note.set('Replay reached the present.');
      this.pause();
      return;
    }
    this.raf = this.deps.raf(() => this.frame());
  }

  private moveTo(t: number, publishNow = true): void {
    const from = this.clock;
    this.clock = t;
    if (from !== null && from !== t) this.deps.moved(from, t);
    this.publish(publishNow);
  }

  private publish(force: boolean): void {
    const wall = this.deps.wall();
    if (!force && wall - this.lastPublish < HEAD_PUBLISH_MS) return;
    this.lastPublish = wall;
    this.head.set(this.clock);
  }

  /** Fetch the next window when the head nears the loaded end. */
  private ensureAhead(force = false): void {
    const tape = this.tape;
    if (!tape || this.clock === null || this.inFlight) return;
    if (tape.to >= this.deps.now()) return;
    if (force || tape.to - this.clock <= PREFETCH_MS) void this.load(tape.to);
  }

  private load(from: number): Promise<void> {
    const n = this.seq;
    const to = Math.min(from + CHUNK_MS, this.deps.now());
    if (!(to > from)) return Promise.resolve();
    this.loading.set(true);
    const sourceId = this.tape?.sourceId ?? this.deps.sourceId();
    const job = this.deps
      .history({
        symbol: this.deps.symbol(),
        sourceIds: sourceId ? [sourceId] : undefined,
        from,
        to,
        kinds: ['ticks', 'book'],
      })
      .then((h) => {
        if (n !== this.seq) return;
        const wanted = this.tape?.sourceId ?? sourceId;
        let src = wanted ? h.sources?.find((s) => s.sourceId === wanted) : undefined;
        if (!src && !wanted)
          src = [...(h.sources ?? [])].sort((x, y) => (y.book?.length ?? 0) + (y.ticks?.t.length ?? 0) - ((x.book?.length ?? 0) + (x.ticks?.t.length ?? 0)))[0];
        if (!this.tape) {
          this.tape = new TickTape(from, new BookTimeline(src?.keyframe ?? null));
          this.tape.sourceId = src?.sourceId ?? wanted ?? null;
          if (!src?.keyframe && src?.book?.length) this.note.set('No book snapshot within 2 h before the start: the book is unknown until the first snapshot in the tape.');
        }
        // A truncated answer ends at its last row; the next window starts there.
        const lastRow = Math.max(src?.ticks?.t.at(-1) ?? from, src?.book?.at(-1)?.t ?? from);
        this.tape.append(src ?? {}, h.truncated ? lastRow : to);
        if (!src) this.note.set(`No recorded ticks or book for ${this.deps.symbol()} from ${new Date(from).toISOString().slice(0, 16)}Z.`);
        this.version.update((v) => v + 1);
      })
      .catch((e: unknown) => {
        if (n !== this.seq) return;
        const m = (e as { message?: unknown })?.message;
        this.note.set(`The recording could not be read (${typeof m === 'string' && m ? m : 'md/history did not answer'}).`);
      })
      .finally(() => {
        if (this.inFlight === job) this.inFlight = null;
        if (n === this.seq) this.loading.set(false);
      });
    this.inFlight = job;
    return job;
  }
}
