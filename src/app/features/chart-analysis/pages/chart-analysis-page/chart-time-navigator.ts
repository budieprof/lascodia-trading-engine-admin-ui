import type { NotificationService } from '@core/notifications/notification.service';
import type { ChartHostComponent } from '../../chart/chart-host.component';
import type { Bar } from '../../datafeed/candle-feed.service';
import { resolutionMs, type TvResolution } from '../../datafeed/resolution';
import type { ReplayController } from '../../replay/replay-controller';
import { midnightOnClock, timezoneOffsetMinutes } from '../../workspace/layout-store.service';
import { DAY, GO_TO_DATE_PAGES, RANGE_PRESETS } from './chart-page.config';

/** What the time navigation reads and drives on the chart page. */
export interface ChartTimeNavigatorDeps {
  bars: () => Bar[];
  historyComplete: () => boolean;
  resolution: () => string;
  timezone: () => string;
  host: () =>
    | Pick<ChartHostComponent, 'fitContent' | 'setVisibleRange' | 'pickPoint' | 'cancelPick'>
    | undefined;
  /** One page of scroll-back history. */
  loadOlder: () => Promise<void>;
  selectResolution: (r: TvResolution) => void;
  replay: ReplayController;
  /** The engine's replay sessions of the chart's scripts. */
  stopReplayRuns: () => void;
  barTimeLabel: (bar: Bar) => string;
  formatTime: (ms: number | null) => string;
  notify: Pick<NotificationService, 'warning'>;
}

/**
 * b9-maint — where the chart looks in time: the range presets and go-to-date (each loading history back as needed and
 * applied once the bars are in), and Bar Replay's controls (CC-I4: select the start bar, start at a date, step, play,
 * re-anchor on a series change, exit). Moved out of ChartAnalysisPageComponent behaviour for behaviour; the template,
 * the assistant's commands and the page's effects call it as `timeNav`.
 */
export class ChartTimeNavigator {
  constructor(private readonly deps: ChartTimeNavigatorDeps) {}

  readonly rangePresets = RANGE_PRESETS;
  /** A preset waiting for its interval's bars to load before the window is applied. */
  private pendingRange: { fromMs: number; toMs: number } | 'all' | null = null;

  applyRangePreset(id: string): void {
    const d = this.deps;
    const p = RANGE_PRESETS.find((r) => r.id === id);
    if (!p) return;
    const now = Date.now();
    this.pendingRange =
      p.spanMs === 'all'
        ? 'all'
        : {
            fromMs:
              p.spanMs === 'ytd'
                ? midnightOnClock(new Date(now).getUTCFullYear(), 0, 1, d.timezone())
                : now - p.spanMs,
            toMs: now,
          };
    if (d.resolution() !== p.resolution) d.selectResolution(p.resolution);
    else this.flushPendingRange();
  }

  /**
   * Centre the chart on a day (`yyyy-mm-dd`) — midnight on the CHART's clock, not UTC's (CC-15) —
   * loading history back to it first: a date before the loaded bars did nothing. At most
   * {@link GO_TO_DATE_PAGES} pages of history; past that the oldest loaded bars show, and the
   * operator is told.
   */
  async goToDate(value: string): Promise<void> {
    const d = this.deps;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!m) return;
    const t = midnightOnClock(Number(m[1]), Number(m[2]) - 1, Number(m[3]), d.timezone());
    // Centre the day: a window the width of what is on screen, around the date.
    const span = Math.max((resolutionMs(d.resolution()) ?? DAY) * 120, DAY);
    const from = t - span / 2;
    for (let page = 0; page < GO_TO_DATE_PAGES; page++) {
      const held = d.bars();
      if (!held.length || held[0].time <= from || d.historyComplete()) break;
      await d.loadOlder();
      if (d.bars()[0]?.time === held[0].time) break; // nothing older came back
    }
    const oldest = d.bars()[0]?.time;
    if (oldest !== undefined && oldest > t && !d.historyComplete())
      d.notify.warning(
        `History before ${d.barTimeLabel(d.bars()[0])} is not loaded: showing the oldest bars.`,
      );
    this.pendingRange = { fromMs: from, toMs: t + span / 2 };
    this.flushPendingRange();
  }

  /** Apply a waiting preset / date window once the chart has bars (the page calls this as they arrive). */
  flushPendingRange(): void {
    const host = this.deps.host();
    const r = this.pendingRange;
    if (!host || !r || !this.deps.bars().length) return;
    if (r === 'all') host.fitContent();
    else host.setVisibleRange(r.fromMs, r.toMs);
    this.pendingRange = null;
  }

  // ── Replay controls ──────────────────────────────────────────────────────

  /**
   * Bar Replay on: the whole chart shows and the next click on it picks the bar replay starts at
   * (TradingView's "Select bar"); the replay bar also takes a date and time.
   */
  startReplay(): void {
    const total = this.deps.bars().length;
    if (total === 0) return;
    this.deps.replay.start(total);
    void this.pickReplayStart();
  }

  /** The next click on the chart picks the bar replay starts at; Esc keeps where it is. */
  async pickReplayStart(): Promise<void> {
    const { replay } = this.deps;
    const host = this.deps.host();
    if (!host || !replay.active()) return;
    replay.pause();
    replay.selecting.set(true);
    const pick = await host.pickPoint('time');
    replay.selecting.set(false);
    if (pick && replay.active()) replay.startAt(pick.time);
  }

  /**
   * Start replay at a date and time on the chart's clock (`yyyy-mm-ddThh:mm`), loading history back to
   * it first — as go-to-date does, at most {@link GO_TO_DATE_PAGES} pages — and showing it.
   */
  async startReplayAt(value: string): Promise<void> {
    const d = this.deps;
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(value);
    if (!m) return;
    const t =
      midnightOnClock(Number(m[1]), Number(m[2]) - 1, Number(m[3]), d.timezone()) +
      Number(m[4] ?? 0) * 3_600_000 +
      Number(m[5] ?? 0) * 60_000;
    d.host()?.cancelPick();
    await this.loadBackTo(t);
    const oldest = d.bars()[0];
    if (!oldest) return;
    if (oldest.time > t && !d.historyComplete())
      d.notify.warning(
        `History before ${d.barTimeLabel(oldest)} is not loaded: replay starts at the oldest bar.`,
      );
    if (!d.replay.active()) d.replay.start(d.bars().length);
    d.replay.startAt(t);
    const span = Math.max((resolutionMs(d.resolution()) ?? DAY) * 120, DAY);
    this.pendingRange = { fromMs: t - span * 0.8, toMs: t + span * 0.2 };
    this.flushPendingRange();
  }

  /** Load history pages until the bars reach back to `t` (at most {@link GO_TO_DATE_PAGES} pages). */
  private async loadBackTo(t: number): Promise<void> {
    const d = this.deps;
    for (let page = 0; page < GO_TO_DATE_PAGES; page++) {
      const held = d.bars();
      if (!held.length || held[0].time <= t || d.historyComplete()) break;
      await d.loadOlder();
      if (d.bars()[0]?.time === held[0].time) break; // nothing older came back
    }
  }

  /** The series changed in replay: history back to the head's instant, and the head on its bar there. */
  async reanchorReplay(anchor: number): Promise<void> {
    const d = this.deps;
    d.stopReplayRuns();
    d.replay.reanchor(anchor);
    if ((d.bars()[0]?.time ?? anchor) > anchor) {
      await this.loadBackTo(anchor);
      if (d.replay.active()) d.replay.reanchor(anchor);
    }
  }

  exitReplay(): void {
    this.deps.host()?.cancelPick();
    this.deps.replay.exit();
    this.deps.stopReplayRuns();
  }

  stepReplay(delta: number): void {
    const { replay } = this.deps;
    const dir = delta < 0 ? -1 : 1;
    const n = Math.max(1, Math.abs(Math.trunc(delta)) || 1);
    if (n === 1) {
      void replay.step(dir);
      return;
    }
    // Many at once (the assistant): whole bars.
    const c = replay.cursor();
    replay.moveTo({ index: c.index + dir * n, sub: null });
  }

  toggleReplayPlay(): void {
    this.deps.replay.togglePlay();
  }

  setReplaySpeed(raw: string): void {
    this.deps.replay.setSpeed(Number(raw));
  }

  setReplayIndex(raw: string): void {
    this.deps.replay.setIndex(Number(raw));
  }

  /**
   * The time at the replay head, for the replay bar: the bar's, or — while a bar forms from intrabar
   * steps — the last intrabar bar's open on the chart's clock.
   */
  replayTime(): string {
    const d = this.deps;
    const head = d.replay.headBar();
    if (!head) return '';
    if (d.replay.cursor().sub === null) return d.barTimeLabel(head);
    const zone = d.timezone();
    return d.formatTime(
      head.time + (zone === 'UTC' ? 0 : timezoneOffsetMinutes(zone, head.time) * 60_000),
    );
  }
}
