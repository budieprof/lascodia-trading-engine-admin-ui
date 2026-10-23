import { DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  NgZone,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import { MarketDataApiService } from '@core/realtime/marketdata-api.service';
import { MarketDataStreamService, type MdWatch } from '@core/realtime/marketdata-stream.service';
import { CONSOLIDATED_SOURCE, type MdDispersionWire } from '@core/realtime/marketdata.types';
import { formatUnits } from '../panels/side/depth';
import {
  DispersionStrip,
  buildMultibook,
  formatAge,
  formatPoints,
  stateLabel,
  type MultibookView,
} from './multibook-model';

/** Minute history shown beside the live health (md/dispersion). */
const HISTORY_MINUTES = 60;
const HISTORY_REFRESH_MS = 60_000;

/** Per-source summary of the last hour's minute rows. */
interface HourStats {
  meanAbsDevPoints: number | null;
  stalePct: number | null;
  meanLagMs: number | null;
}

/**
 * The multibook (engine market-data program, multibook): the CONSOLIDATED book of every source the organisation may
 * see — broker DOMs, FX venues, CME (basis-adjusted) — as one ladder whose levels are split into per-source colour
 * segments, a dispersion strip (each source's mid against the cross-source median, live), and a source health panel
 * (state, age, arrival lag, deviation, spread, and the last hour from `md/dispersion`).
 * Data: ONE hub subscription to the computed source `consolidated` (frames ≤ 10 Hz on change, 1 Hz heartbeat); the
 * per-source toggles filter client-side (each level carries every source's share). Angular sees ≤ 4 Hz signals; the
 * strip is drawn on animation frames outside the zone.
 */
@Component({
  selector: 'app-multibook-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe],
  template: `
    <div class="mb" data-testid="multibook-panel">
      <div class="mb-note">
        Consolidated book · spot prices · sizes in base-currency units, summed across sources
        @if (view().sources.length) {
          · {{ liveCount() }} of {{ view().sources.length }} sources live
        }
      </div>
      @if (notEntitled(); as why) {
        <div class="mb-warn" role="status">{{ why }}</div>
      }
      @if (statusText(); as st) {
        <div class="mb-muted" role="status">{{ st }}</div>
      }

      @if (view().sources.length) {
        <div class="mb-legend" role="group" aria-label="Sources in the consolidated book">
          @for (s of view().sources; track s.sourceId) {
            <label class="mb-src" [class.off]="!s.enabled" [title]="s.sourceId + ' · ' + stateLabel(s.state)">
              <input type="checkbox" [checked]="s.enabled" (change)="toggle(s.sourceId)" [attr.aria-label]="'Show ' + s.name" />
              <span class="mb-swatch" [style.background]="s.colour"></span>
              {{ s.name }}@if (s.mode === 'quote') { <span class="mb-q" title="Top of book only — no sizes">◆</span> }
            </label>
          }
        </div>
      }

      @if (view().crossed || view().locked) {
        <div class="mb-cross" role="status" data-testid="multibook-crossed">
          {{ view().crossed ? 'Crossed' : 'Locked' }} across sources:
          @for (c of view().crosses.slice(0, 3); track c.bidSource + c.askSource) {
            <span>{{ nameOf(c.bidSource) }} bid {{ c.locked ? '=' : '>' }} {{ nameOf(c.askSource) }} ask</span>
          }
        </div>
      }

      <div class="mb-ladder" role="table" aria-label="Consolidated ladder">
        @for (r of view().rows; track r.side + r.price) {
          <div class="mb-row" role="row" [class.ask]="r.side === 'ask'" [class.bid]="r.side === 'bid'" [class.best]="r.best">
            <span class="mb-px" role="cell">{{ r.price | number: priceFormat() }}</span>
            <span class="mb-tot" role="cell" [title]="r.partial ? 'A source with no size unit conversion also quotes here' : ''">
              {{ units(r.total) }}{{ r.partial ? '+' : '' }}
            </span>
            <span class="mb-bar" role="cell">
              @for (g of r.segments; track g.sourceId) {
                @if (g.size === null) {
                  <span class="mb-unk" [style.border-color]="g.colour" [title]="nameOf(g.sourceId) + ': size unknown'"></span>
                } @else {
                  <span class="mb-seg" [style.width.%]="g.width * 100" [style.background]="g.colour"
                        [title]="nameOf(g.sourceId) + ': ' + units(g.size)"></span>
                }
              }
              @for (q of r.quotes; track q.sourceId) {
                <span class="mb-qm" [style.color]="q.colour" [title]="nameOf(q.sourceId) + ' quotes here (no size)'">◆</span>
              }
            </span>
          </div>
          @if (r.side === 'ask' && isLastAsk(r.price)) {
            <div class="mb-spread" role="row">
              <span role="cell">
                {{ view().bestBid !== null && view().bestAsk !== null ? 'spread ' + spreadPoints() + ' pts' : '' }}
                @if (view().midRangePoints !== null) { · mids spread {{ view().midRangePoints!.toFixed(1) }} pts }
              </span>
            </div>
          }
        }
        @if (!view().rows.length && view().sources.length) {
          <div class="mb-muted">No sized levels from the enabled sources (quote-only sources show in the health list).</div>
        }
      </div>

      <div class="mb-h">Dispersion — each source's mid vs the median of the live sources (points, last 5 min)</div>
      <canvas #strip class="mb-strip" width="320" height="70" aria-label="Mid deviation by source over time"></canvas>

      <div class="mb-h">Source health</div>
      <table class="mb-health" aria-label="Source health">
        <thead>
          <tr>
            <th scope="col">Source</th>
            <th scope="col">State</th>
            <th scope="col" title="Server now minus the source's newest stamp">Age</th>
            <th scope="col" title="Server receive time minus the source's own stamp of its newest row (includes clock offset)">Lag</th>
            <th scope="col" title="Mid minus the median mid of the live sources">Dev</th>
            <th scope="col">Spread</th>
            <th scope="col" title="Mean |deviation| over the last hour (per-minute rows)">1 h |dev|</th>
            <th scope="col" title="Share of the last hour's samples the source was stale">1 h stale</th>
          </tr>
        </thead>
        <tbody>
          @for (s of view().sources; track s.sourceId) {
            <tr [class.off]="!s.enabled">
              <td><span class="mb-swatch" [style.background]="s.colour"></span>{{ s.name }}
                <span class="mb-muted">{{ s.mode === 'quote' ? 'quotes' : s.levels + ' lvls' }}{{ s.sizeKnown ? '' : ', size n/a (' + s.sizeUnit + ')' }}{{ s.basis !== null ? ', basis ' + s.basis : '' }}</span></td>
              <td [class.bad]="s.state !== 'live'">{{ stateLabel(s.state) }}</td>
              <td>{{ formatAge(s.ageMs) }}</td>
              <td>{{ formatAge(s.lagMs) }}</td>
              <td>{{ formatPoints(s.devPoints) }}</td>
              <td>{{ s.spreadPoints === null ? '—' : s.spreadPoints.toFixed(1) }}</td>
              <td>{{ hourDev(s.sourceId) }}</td>
              <td>{{ hourStale(s.sourceId) }}</td>
            </tr>
          }
        </tbody>
      </table>
      @if (hourNote(); as n) {
        <div class="mb-muted">{{ n }}</div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        font-size: 12px;
      }
      .mb {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 0 10px 10px;
      }
      .mb-note,
      .mb-muted {
        color: var(--text-muted, #787b86);
      }
      .mb-warn {
        color: var(--warning, #c58a00);
      }
      .mb-legend {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 10px;
      }
      .mb-src {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        cursor: pointer;
      }
      .mb-src.off,
      tr.off {
        opacity: 0.45;
      }
      .mb-swatch {
        display: inline-block;
        width: 10px;
        height: 10px;
        border-radius: 2px;
        margin-right: 4px;
        vertical-align: -1px;
      }
      .mb-q,
      .mb-qm {
        font-size: 10px;
      }
      .mb-cross {
        color: var(--danger, #d0443a);
        display: flex;
        flex-wrap: wrap;
        gap: 4px 8px;
      }
      .mb-ladder {
        display: flex;
        flex-direction: column;
        font-variant-numeric: tabular-nums;
      }
      .mb-row {
        display: grid;
        grid-template-columns: 72px 56px 1fr;
        align-items: center;
        gap: 6px;
        height: 18px;
      }
      .mb-row.ask .mb-px {
        color: var(--sell, #d0443a);
      }
      .mb-row.bid .mb-px {
        color: var(--buy, #2e9d6b);
      }
      .mb-row.best {
        font-weight: 600;
        background: var(--surface-2, rgba(127, 127, 127, 0.08));
      }
      .mb-tot {
        text-align: right;
      }
      .mb-bar {
        display: flex;
        align-items: center;
        height: 12px;
        min-width: 0;
        overflow: hidden;
      }
      .mb-seg {
        display: inline-block;
        height: 100%;
        min-width: 1px;
      }
      .mb-unk {
        display: inline-block;
        width: 6px;
        height: 100%;
        border: 1px dashed;
        box-sizing: border-box;
      }
      .mb-spread {
        color: var(--text-muted, #787b86);
        text-align: center;
        border-top: 1px solid var(--border, rgba(127, 127, 127, 0.25));
        border-bottom: 1px solid var(--border, rgba(127, 127, 127, 0.25));
        padding: 1px 0;
      }
      .mb-h {
        margin-top: 4px;
        font-weight: 600;
        color: var(--text-muted, #787b86);
      }
      .mb-strip {
        width: 100%;
        height: 70px;
        border: 1px solid var(--border, rgba(127, 127, 127, 0.25));
      }
      .mb-health {
        width: 100%;
        border-collapse: collapse;
        font-variant-numeric: tabular-nums;
      }
      .mb-health th,
      .mb-health td {
        text-align: left;
        padding: 2px 4px;
        border-bottom: 1px solid var(--border, rgba(127, 127, 127, 0.15));
        vertical-align: top;
      }
      .mb-health td.bad {
        color: var(--warning, #c58a00);
      }
    `,
  ],
})
export class MultibookPanelComponent {
  private readonly stream = inject(MarketDataStreamService);
  private readonly api = inject(MarketDataApiService);
  private readonly zone = inject(NgZone);

  readonly symbol = input.required<string>();
  readonly digits = input<number>(5);

  private readonly md = signal<MdWatch | null>(null);
  readonly disabled = signal<ReadonlySet<string>>(new Set());
  /** Every source seen, in first-seen order: its index is its colour (stable while the panel is open). */
  private readonly order: string[] = [];
  private readonly strip = new DispersionStrip();
  private readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('strip');
  private raf: number | null = null;
  private disabledNow: ReadonlySet<string> = new Set();
  readonly hour = signal<Record<string, HourStats>>({});
  readonly hourNote = signal<string | null>(null);

  readonly formatAge = formatAge;
  readonly formatPoints = formatPoints;
  readonly stateLabel = stateLabel;

  readonly view = computed<MultibookView>(() => {
    const md = this.md();
    md?.version();
    const c = md?.stream(CONSOLIDATED_SOURCE)?.consolidated ?? null;
    if (c) for (const s of c.sources) if (!this.order.includes(s.sourceId)) this.order.push(s.sourceId);
    return buildMultibook(c, this.disabled(), this.order, 20);
  });

  readonly liveCount = computed(() => this.view().sources.filter((s) => s.enabled && s.state === 'live').length);
  readonly priceFormat = computed(() => `1.${this.digits()}-${this.digits()}`);
  readonly spreadPoints = computed(() => {
    const v = this.view();
    return v.bestBid !== null && v.bestAsk !== null && v.point ? ((v.bestAsk - v.bestBid) / v.point).toFixed(1) : '—';
  });

  readonly notEntitled = computed(() => this.md()?.status().notEntitled ?? null);
  readonly statusText = computed<string | null>(() => {
    const md = this.md();
    if (!md) return null;
    const st = md.status();
    if (st.state === 'connecting' || st.state === 'reconnecting') return 'Connecting to the market-data hub…';
    if (st.state === 'unavailable') return 'The market-data hub is unavailable; retrying.';
    if (st.unknown.includes(CONSOLIDATED_SOURCE)) return 'This engine does not serve a consolidated book (or it is switched off).';
    if (st.error && !this.view().sources.length) return st.error;
    if (!this.view().sources.length && st.state === 'connected') return 'Waiting for the consolidated book…';
    return null;
  });

  constructor() {
    effect((onCleanup) => {
      const symbol = this.symbol();
      const md = this.stream.watch({ symbol, sources: [CONSOLIDATED_SOURCE], kinds: ['book'] });
      untracked(() => {
        this.md.set(md);
        this.strip.clear();
        this.order.length = 0;
      });
      // Strip samples on every consolidated frame (outside the zone), drawn on the next animation frame.
      const off = md.onFrame((frame) => {
        if (frame.sourceId !== CONSOLIDATED_SOURCE || !frame.consolidated) return;
        this.strip.push(buildMultibook(frame.consolidated, this.disabledNow, this.order, 0));
        this.scheduleDraw();
      });
      const timer = setInterval(() => void this.loadHour(symbol), HISTORY_REFRESH_MS);
      void this.loadHour(symbol);
      onCleanup(() => {
        off();
        clearInterval(timer);
        md.release();
        if (this.raf !== null && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this.raf);
        this.raf = null;
      });
    });
    effect(() => {
      this.disabledNow = this.disabled();
      this.scheduleDraw();
    });
  }

  toggle(sourceId: string): void {
    this.disabled.update((d) => {
      const next = new Set(d);
      if (next.has(sourceId)) next.delete(sourceId);
      else next.add(sourceId);
      return next;
    });
  }

  nameOf(sourceId: string): string {
    return this.view().sources.find((s) => s.sourceId === sourceId)?.name ?? sourceId;
  }

  units(v: number): string {
    return formatUnits(v);
  }

  /** Last hour's mean |deviation| in points, or "—". */
  hourDev(sourceId: string): string {
    const v = this.hour()[sourceId]?.meanAbsDevPoints;
    return typeof v === 'number' ? v.toFixed(2) : '—';
  }

  /** Last hour's stale share, or "—". */
  hourStale(sourceId: string): string {
    const v = this.hour()[sourceId]?.stalePct;
    return typeof v === 'number' ? `${v.toFixed(0)}%` : '—';
  }

  isLastAsk(price: number): boolean {
    const asks = this.view().rows.filter((r) => r.side === 'ask');
    return asks.length > 0 && asks[asks.length - 1].price === price;
  }

  private async loadHour(symbol: string): Promise<void> {
    const to = Date.now();
    try {
      const d = await this.api.dispersion(symbol, to - HISTORY_MINUTES * 60_000, to);
      if (this.symbol() !== symbol) return;
      this.hour.set(hourStats(d));
      this.hourNote.set(
        d.minutes.length
          ? d.denied.length
            ? `Last hour: ${d.minutes.length} minutes; not entitled to ${d.denied.join(', ')} (left out).`
            : null
          : 'No dispersion minutes stored in the last hour (a minute is kept when ≥ 2 sources quoted).',
      );
    } catch {
      this.hourNote.set('Dispersion history unavailable.');
    }
  }

  private scheduleDraw(): void {
    if (this.raf !== null || typeof requestAnimationFrame === 'undefined') return;
    this.zone.runOutsideAngular(() => {
      this.raf = requestAnimationFrame(() => {
        this.raf = null;
        this.draw();
      });
    });
  }

  private draw(): void {
    const el = this.canvas()?.nativeElement;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    const w = Math.max(1, el.clientWidth || el.width);
    const h = Math.max(1, el.clientHeight || el.height);
    if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const samples = this.strip.all();
    ctx.strokeStyle = 'rgba(127,127,127,0.35)';
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
    if (samples.length < 2) return;
    const t1 = samples[samples.length - 1].t;
    const t0 = t1 - this.strip.windowMs;
    const scale = this.strip.maxAbs();
    const x = (t: number): number => ((t - t0) / (t1 - t0)) * w;
    const y = (v: number): number => h / 2 - (v / scale) * (h / 2 - 3);
    for (const id of this.order) {
      if (this.disabledNow.has(id)) continue;
      ctx.strokeStyle = this.view().sources.find((s) => s.sourceId === id)?.colour ?? '#888';
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      let pen = false;
      for (const s of samples) {
        const v = s.dev.get(id);
        if (v === undefined) {
          pen = false;
          continue;
        }
        if (pen) ctx.lineTo(x(s.t), y(v));
        else ctx.moveTo(x(s.t), y(v));
        pen = true;
      }
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(127,127,127,0.9)';
    ctx.font = '10px sans-serif';
    ctx.fillText(`±${scale.toFixed(1)} pts`, 4, 11);
  }
}

/** Per-source summary of minute rows: mean |deviation| (points) and the share of samples it was stale. */
export function hourStats(d: MdDispersionWire): Record<string, HourStats> {
  const acc: Record<string, { dev: number; devN: number; stale: number; samples: number; lag: number; lagN: number }> = {};
  for (const m of d.minutes) {
    const point = m.point > 0 ? m.point : 0;
    for (const s of m.sources) {
      const a = (acc[s.sourceId] ??= { dev: 0, devN: 0, stale: 0, samples: 0, lag: 0, lagN: 0 });
      a.samples += s.samples;
      a.stale += s.staleSamples;
      if (s.meanAbsDev != null && point) {
        a.dev += (s.meanAbsDev / point) * s.liveSamples;
        a.devN += s.liveSamples;
      }
      if (s.meanLagMs != null) {
        a.lag += s.meanLagMs;
        a.lagN++;
      }
    }
  }
  const out: Record<string, HourStats> = {};
  for (const [id, a] of Object.entries(acc))
    out[id] = {
      meanAbsDevPoints: a.devN ? a.dev / a.devN : null,
      stalePct: a.samples ? (a.stale / a.samples) * 100 : null,
      meanLagMs: a.lagN ? a.lag / a.lagN : null,
    };
  return out;
}
