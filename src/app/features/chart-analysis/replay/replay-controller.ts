import { computed, signal } from '@angular/core';
import type { Bar } from '../datafeed/candle-feed.service';
import type { TvResolution } from '../datafeed/resolution';
import type { ChartMarker } from '../chart/chart-host.component';
import {
  barEndMs,
  clampCursor,
  cursorBefore,
  indexAt,
  intrabarResolution,
  minutesIn,
  replayView,
  revealedUnits,
  stepCursor,
  type ReplayCursor,
} from './replay-cursor';
import {
  PaperBook,
  levelsProblem,
  markOf,
  pnlOf,
  unitOf,
  type PaperSide,
  type PaperSymbol,
  type PaperTally,
  type PaperTrade,
  type PaperUnit,
} from './paper-broker';

/** What the controller reads from the page. */
export interface ReplayDeps {
  /** The chart's loaded bars, ascending (the full series; replay shows a prefix of them). */
  bars: () => readonly Bar[];
  resolution: () => TvResolution;
  /** The symbol's price digits (MT5 points are 10^-digits). */
  digits: () => number;
  /** Pip size and contract size, for the paper P&L. */
  symbolFacts: () => PaperSymbol;
  /** Intrabar bars at `resolution` opening in [`fromMs`, `toMs`], at most `count` of them, ascending. */
  fetchIntrabar: (resolution: TvResolution, fromMs: number, toMs: number, count: number) => Promise<readonly Bar[]>;
}

/** Most intrabar bars one request asks for (the candle endpoint pages 5,000 at most). */
const INTRABAR_CHUNK = 3_000;
/** Most chart bars one intrabar request covers. */
const INTRABAR_BARS = 120;

/** An open paper trade as the replay panel lists it. */
export interface PaperRow {
  id: number;
  side: PaperSide;
  lots: number;
  entry: number;
  stop: number | null;
  target: number | null;
  pips: number;
  money: number;
  r: number | null;
}

/**
 * Bar Replay (CC-I4): where the replay stands, how it moves, the intrabar bars it reveals, and its paper account.
 *
 * Pure state on signals (the page owns the timers' lifetime through {@link pause} / {@link exit}). Everything here
 * stays in the browser: replay never sends anything to the engine's order paths.
 */
export class ReplayController {
  readonly active = signal(false);
  /** Whole bars shown (see {@link ReplayCursor}). */
  readonly index = signal(0);
  /** Intrabar bars of the next bar revealed; null: none. */
  readonly sub = signal<number | null>(null);
  readonly playing = signal(false);
  /** Steps per second while playing. */
  readonly speed = signal(4);
  /** Step through each bar's intrabar bars (1m below a day, 1h above). */
  readonly intrabar = signal(true);
  /** The chart is waiting for a click to choose where replay starts. */
  readonly selecting = signal(false);
  /** Intrabar bars on their way for the next step. */
  readonly loadingIntrabar = signal(false);
  /** Why intrabar steps are not available here, in plain words (null when they are). */
  readonly intrabarNote = signal<string | null>(null);

  /** Intrabar bars by their bar's open time; an empty list: loaded, there are none. */
  private readonly minutes = signal<ReadonlyMap<number, readonly Bar[]>>(new Map());
  /** Requests in flight, by the first bar time they cover. */
  private readonly inFlight = new Map<number, Promise<void>>();
  /** Bumped when the series changes: an intrabar answer for an older one is dropped. */
  private generation = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stepping = false;

  private readonly book = new PaperBook();
  /** Bumped by every paper change, so the computed views follow the book. */
  private readonly paperVersion = signal(0);

  readonly lookup = (barTime: number): readonly Bar[] | null => this.minutes().get(barTime) ?? null;

  readonly cursor = computed<ReplayCursor>(() => clampCursor({ index: this.index(), sub: this.sub() }, this.deps.bars().length));

  /** What the chart plots: the full series, or the replay's closed bars and the bar forming at its head. */
  readonly view = computed<Bar[]>(() => {
    const bars = this.deps.bars() as Bar[];
    if (!this.active()) return bars;
    return replayView(bars, this.cursor(), this.lookup);
  });

  /** The last CLOSED bar at the head (scripts run to it); null outside replay. */
  readonly closedHead = computed<Bar | null>(() => {
    if (!this.active()) return null;
    return this.deps.bars()[this.cursor().index - 1] ?? null;
  });

  /** The last price unit revealed: the newest intrabar bar of the forming bar, else the last closed bar. */
  readonly headBar = computed<Bar | null>(() => {
    if (!this.active()) return null;
    const bars = this.deps.bars();
    const c = this.cursor();
    if (c.sub !== null) {
      const m = this.lookup(bars[c.index]?.time ?? NaN);
      if (m && m.length >= c.sub) return m[c.sub - 1];
    }
    return bars[c.index - 1] ?? null;
  });

  readonly atEnd = computed(() => this.cursor().index >= this.deps.bars().length && this.cursor().sub === null);

  /** The intrabar resolution steps come from on this chart (null: a 1m chart). */
  readonly intrabarSource = computed(() => intrabarResolution(this.deps.resolution()));

  constructor(private readonly deps: ReplayDeps) {}

  // ── Moving ───────────────────────────────────────────────────────────────────────────────────────

  /** Start (or restart) replay with the bar at `index` (whole bars shown) at the head. */
  start(index: number): void {
    this.pause();
    this.selecting.set(false);
    this.book.clear();
    this.bumpPaper();
    this.index.set(Math.max(1, Math.min(Math.trunc(index), this.deps.bars().length)));
    this.sub.set(null);
    this.active.set(true);
    this.prefetch();
  }

  /** Start with the bar containing `timeMs` at the head. */
  startAt(timeMs: number): void {
    this.start(indexAt(this.deps.bars(), timeMs));
  }

  exit(): void {
    this.pause();
    this.selecting.set(false);
    this.active.set(false);
    this.sub.set(null);
    this.book.clear();
    this.bumpPaper();
  }

  /** Move to `to` — the paper trades see what it revealed (forward) or forget what it undid (back). */
  moveTo(to: ReplayCursor): void {
    const bars = this.deps.bars();
    const from = this.cursor();
    const next = clampCursor(to, bars.length);
    if (next.index === from.index && next.sub === from.sub) return;
    if (cursorBefore(from, next)) {
      const units = revealedUnits(bars, from, next, this.lookup);
      this.index.set(next.index);
      this.sub.set(next.sub);
      if (this.book.open().length && units.length) {
        let fallback = this.recordedSpreadBefore(units[0]);
        const priced = units.map((u) => {
          if (u.spreadPoints !== undefined) fallback = u.spreadPoints;
          return unitOf(u, this.deps.digits(), fallback);
        });
        if (this.book.advance(priced).length) this.bumpPaper();
      }
    } else {
      this.index.set(next.index);
      this.sub.set(next.sub);
      const head = this.headBar();
      if (head && this.book.trades().length) {
        this.book.rewind(head.time);
        this.bumpPaper();
      }
    }
    this.prefetch();
  }

  /** One step forward or back — with intrabar steps, after loading the next bar's intrabar bars when needed. */
  async step(dir: 1 | -1): Promise<void> {
    if (!this.active() || this.stepping) return;
    this.stepping = true;
    try {
      if (dir > 0 && this.intrabar() && this.cursor().sub === null) await this.ensureIntrabar(this.cursor().index);
      if (!this.active()) return;
      this.moveTo(stepCursor(this.cursor(), dir, this.deps.bars(), this.lookup, this.intrabar() && !!this.intrabarSource()));
    } finally {
      this.stepping = false;
    }
    if (this.atEnd()) this.pause();
  }

  /** Jump to `index` whole bars shown (the scrubber, the assistant). */
  setIndex(index: number): void {
    if (Number.isFinite(index)) this.moveTo({ index: Math.trunc(index), sub: null });
  }

  togglePlay(): void {
    if (this.playing()) this.pause();
    else this.play();
  }

  play(): void {
    if (!this.active() || this.atEnd()) return;
    this.clearTimer();
    this.playing.set(true);
    // Steps per second; a step still loading its intrabar bars holds the next ones back.
    this.timer = setInterval(() => {
      if (this.stepping) return;
      void this.step(1);
    }, 1000 / Math.max(1, this.speed()));
  }

  pause(): void {
    this.clearTimer();
    this.playing.set(false);
  }

  setSpeed(speed: number): void {
    if (!Number.isFinite(speed) || speed <= 0) return;
    this.speed.set(speed);
    if (this.playing()) this.play();
  }

  /** Intrabar steps on / off. Off folds a bar forming at the head back to the last closed bar. */
  setIntrabar(on: boolean): void {
    this.intrabar.set(on);
    if (!on && this.sub() !== null) this.moveTo({ index: this.cursor().index, sub: null });
    if (on) this.prefetch();
  }

  /** History was prepended: the head stays on its bar. */
  shift(added: number): void {
    if (this.active() && added > 0) this.index.update((i) => i + added);
  }

  /**
   * The chart's series changed (another symbol or timeframe) during replay: the head goes to the bar of the new
   * series containing `anchorMs` (the old head's instant), and the intrabar bars held are another series'.
   */
  reanchor(anchorMs: number): void {
    this.generation++;
    this.inFlight.clear();
    this.minutes.set(new Map());
    this.intrabarNote.set(null);
    this.sub.set(null);
    this.index.set(indexAt(this.deps.bars(), anchorMs));
    if (this.book.trades().length) {
      // The paper trades were priced on the old series.
      this.book.clear();
      this.bumpPaper();
    }
    this.prefetch();
  }

  private clearTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  // ── Intrabar bars ───────────────────────────────────────────────────────────────────────────────

  /** Load the intrabar bars of the bar at `i` (and the ones after it, one request) unless they are held. */
  async ensureIntrabar(i: number): Promise<void> {
    const source = this.intrabarSource();
    const bars = this.deps.bars();
    if (!source || i < 0 || i >= bars.length) return;
    if (this.minutes().has(bars[i].time)) return;
    const pending = this.inFlight.get(bars[i].time);
    if (pending) return pending;
    const resolution = this.deps.resolution();
    const sourceMs = source === '1' ? 60_000 : 3_600_000;
    // The bars this request covers: from bar i while the intrabar count stays inside a page.
    let j = i;
    while (
      j + 1 < bars.length &&
      j + 1 - i < INTRABAR_BARS &&
      !this.minutes().has(bars[j + 1].time) &&
      (barEndMs(bars, j + 1, resolution) - bars[i].time) / sourceMs <= INTRABAR_CHUNK
    )
      j++;
    const from = bars[i].time;
    const to = barEndMs(bars, j, resolution);
    const count = Math.min(5_000, Math.ceil((to - from) / sourceMs) + 2);
    const gen = this.generation;
    this.loadingIntrabar.set(true);
    const job = this.deps
      .fetchIntrabar(source, from, to - 1, count)
      .then((rows) => {
        if (gen !== this.generation) return;
        const sorted = [...rows].sort((a, b) => a.time - b.time);
        const held = new Map(this.minutes());
        for (let k = i; k <= j; k++) held.set(bars[k].time, minutesIn(sorted, bars[k].time, barEndMs(bars, k, resolution)));
        this.minutes.set(held);
        this.intrabarNote.set(sorted.length ? null : 'No intrabar bars are stored for these bars: replay steps whole bars here.');
      })
      .catch((e: unknown) => {
        if (gen !== this.generation) return;
        // Whole bars for this stretch, and the reason on the panel.
        const held = new Map(this.minutes());
        for (let k = i; k <= j; k++) held.set(bars[k].time, []);
        this.minutes.set(held);
        const why = e instanceof Error && e.message ? e.message : 'the engine could not be reached';
        this.intrabarNote.set(`Intrabar bars could not be loaded (${why}): replay steps whole bars here.`);
      })
      .finally(() => {
        this.inFlight.delete(from);
        if (gen === this.generation) this.loadingIntrabar.set(this.inFlight.size > 0);
      });
    this.inFlight.set(from, job);
    return job;
  }

  /** Ask for the next bars' intrabar bars ahead of the steps that need them. */
  private prefetch(): void {
    if (!this.active() || !this.intrabar() || !this.intrabarSource()) return;
    const c = this.cursor();
    for (const i of [c.index, c.index + 1]) {
      const bar = this.deps.bars()[i];
      if (bar && !this.minutes().has(bar.time)) {
        void this.ensureIntrabar(i);
        return;
      }
    }
  }

  // ── Paper trading (browser-only) ────────────────────────────────────────────────────────────────

  /** The price unit at the head, with the spread paid there; null outside replay. */
  readonly headUnit = computed<PaperUnit | null>(() => {
    const head = this.headBar();
    if (!head) return null;
    return unitOf(head, this.deps.digits(), this.recordedSpreadBefore(head));
  });

  /** The spread the head's unit carries in MT5 points, or the last one recorded before it; null: none recorded. */
  readonly headSpreadPoints = computed<number | null>(() => {
    const head = this.headBar();
    return head ? (head.spreadPoints ?? this.recordedSpreadBefore(head)) : null;
  });

  /**
   * Buy or sell at the head: `stopPips` / `targetPips` from the fill (null: none). Returns why it was refused, or
   * null once placed.
   */
  place(side: PaperSide, lots: number, stopPips: number | null, targetPips: number | null): string | null {
    const head = this.headUnit();
    if (!this.active() || !head) return 'Start Bar Replay first.';
    if (!Number.isFinite(lots) || lots <= 0) return 'Enter a size above 0 lots.';
    const pip = this.deps.symbolFacts().pipSize;
    const fill = side === 'buy' ? head.close + head.spread : head.close;
    const dir = side === 'buy' ? 1 : -1;
    const stop = stopPips !== null && stopPips > 0 ? fill - dir * stopPips * pip : null;
    const target = targetPips !== null && targetPips > 0 ? fill + dir * targetPips * pip : null;
    const problem = levelsProblem(side, head, stop, target);
    if (problem) return problem;
    this.book.place(side, lots, head, stop, target);
    this.bumpPaper();
    return null;
  }

  close(id: number): void {
    const head = this.headUnit();
    if (head && this.book.close(id, head)) this.bumpPaper();
  }

  closeAll(): void {
    const head = this.headUnit();
    if (!head) return;
    for (const t of this.book.open()) this.book.close(t.id, head);
    this.bumpPaper();
  }

  resetPaper(): void {
    this.book.clear();
    this.bumpPaper();
  }

  /** The open paper trades at the head. */
  readonly openRows = computed<PaperRow[]>(() => {
    this.paperVersion();
    const head = this.headUnit();
    const sym = this.deps.symbolFacts();
    return this.book.open().map((t) => {
      const p = head ? pnlOf(t, markOf(t, head), sym) : { pips: 0, money: 0, r: null };
      return { id: t.id, side: t.side, lots: t.lots, entry: t.entry, stop: t.stop, target: t.target, ...p };
    });
  });

  readonly tally = computed<PaperTally>(() => {
    this.paperVersion();
    return this.book.tally(this.deps.symbolFacts(), this.headUnit());
  });

  /** Every paper trade (for the markers and the tests). */
  readonly trades = computed<readonly PaperTrade[]>(() => {
    this.paperVersion();
    return this.book.trades();
  });

  /** The paper fills as chart markers: entries as arrows, exits with their result in pips. */
  readonly markers = computed<ChartMarker[]>(() => {
    if (!this.active()) return [];
    const sym = this.deps.symbolFacts();
    const out: ChartMarker[] = [];
    for (const t of this.trades()) {
      out.push({
        time: t.openedAt,
        position: t.side === 'buy' ? 'belowBar' : 'aboveBar',
        shape: t.side === 'buy' ? 'arrowUp' : 'arrowDown',
        color: PAPER_COLOUR,
        text: `Paper ${t.side} ${t.lots}`,
      });
      if (t.exit !== undefined && t.closedAt !== undefined) {
        const p = pnlOf(t, t.exit, sym);
        out.push({
          time: t.closedAt,
          position: t.side === 'buy' ? 'aboveBar' : 'belowBar',
          shape: 'circle',
          color: PAPER_COLOUR,
          text: `${t.reason === 'stop' ? 'Stop' : t.reason === 'target' ? 'Target' : 'Close'} ${p.pips >= 0 ? '+' : ''}${p.pips.toFixed(1)}p`,
        });
      }
    }
    return out.sort((a, b) => a.time - b.time);
  });

  private bumpPaper(): void {
    this.paperVersion.update((v) => v + 1);
  }

  /** The last spread recorded at or before `unit` (its own, else the closed bars before the head), MT5 points. */
  private recordedSpreadBefore(unit: Bar): number | null {
    if (unit.spreadPoints !== undefined) return unit.spreadPoints;
    const bars = this.deps.bars();
    const from = Math.min(this.cursor().index, bars.length) - 1;
    for (let k = from; k >= 0 && k > from - 500; k--) {
      const s = bars[k].spreadPoints;
      if (s !== undefined) return s;
      const m = this.lookup(bars[k].time);
      for (let q = (m?.length ?? 0) - 1; q >= 0; q--) if (m![q].spreadPoints !== undefined) return m![q].spreadPoints!;
    }
    return null;
  }
}

/** Paper trades' colour on the chart (the trade layer's paper purple). */
const PAPER_COLOUR = '#7E57C2';
