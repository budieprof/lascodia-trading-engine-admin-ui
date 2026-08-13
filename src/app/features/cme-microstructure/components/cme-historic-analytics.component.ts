import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';

import { CmeMicrostructureService } from '@core/services/cme-microstructure.service';
import type {
  CmeHistoricAnalyticsDto,
  CmeSessionAnalyticsDto,
} from '@features/cme-microstructure/cme-microstructure.types';

/** One session cell in the coverage timeline. */
interface CoverageCell {
  key: string;
  x: number;
  width: number;
  contract: string;
  /** Book missing — rendered with a hatch so the state survives greyscale, print and CVD. */
  tradesOnly: boolean;
  tooltip: string;
}

/** A bar in one of the measure panels. */
interface AnalyticsBar {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  contract: string;
  /** Signed measures only — which side of the baseline this bar sits on. */
  polarity: 'up' | 'down' | 'neutral';
  tooltip: string;
}

interface AnalyticsPanel {
  key: string;
  title: string;
  caption: string;
  /** Baseline in SVG coords — a real zero/neutral reference, never a floating axis. */
  baselineY: number;
  baselineLabel: string;
  bars: AnalyticsBar[];
  /** Rendered as a dashed reference line when the panel has a meaningful threshold. */
  referenceY: number | null;
  referenceLabel: string | null;
  /** Diverging panels colour by polarity; magnitude panels colour by contract identity. */
  colourBy: 'contract' | 'polarity';
  yMaxLabel: string;
  yMinLabel: string;
}

/**
 * Analytics over the DOWNLOADED historic slice (ADR-0021 Phase 0).
 *
 * <p>The status panel above answers "is anything ingested?". This answers the question that
 * actually decides whether the purchase was worth anything: <b>what is in it, and is it usable?</b>
 * Those differ. A session can hold a million book records and be worthless if its tape lost the
 * aggressor tags — tagged flow is the entire reason CME data was bought over a retail feed. A
 * half-finished import looks fully ingested in a session count and then silently produces no fills
 * in a book-aware backtest. Both are invisible in a row total and obvious here.</p>
 *
 * <p><b>Chart discipline.</b> Every panel carries ONE measure on its own axis — no dual-axis
 * anywhere, because trade counts and percentages share no scale and overlaying them invents
 * correlations. Contract identity uses the page's existing validated categorical pair (CVD ΔE 24.7
 * light / 26.8 dark, normal-vision 33.6 / 31.8), so a contract keeps its colour across every panel.
 * Missing-book state is encoded by hatch rather than a third hue: it survives greyscale printing
 * and colour-blindness, and it does not spend a hue on what is really a status.</p>
 */
@Component({
  selector: 'app-cme-historic-analytics',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe],
  template: `
    <section class="hist" aria-labelledby="hist-h">
      <header class="hist-head">
        <div>
          <h3 id="hist-h">Downloaded historic slice</h3>
          <p class="muted small">
            What the purchased Databento slice actually holds, per session — tape volume, aggressor
            quality, and where the book is missing.
          </p>
        </div>
        <button type="button" class="btn" (click)="load()" [disabled]="loading()">
          {{ loading() ? 'Reading…' : data() ? 'Refresh' : 'Load analytics' }}
        </button>
      </header>

      @if (error(); as e) {
        <p class="err small" role="alert">{{ e }}</p>
      }

      @if (loading() && !data()) {
        <p class="muted small">
          Sweeping the warm tier. The first read of a cold cache takes ~20s; after that it is
          instant, because imported history never changes.
        </p>
      }

      @if (data(); as d) {
        @if (!d.configured) {
          <p class="muted small">Warm tier is not configured — no historic slice is reachable.</p>
        } @else if (d.sessions.length === 0) {
          <p class="muted small">Warm tier is configured but holds no imported sessions yet.</p>
        } @else {
          <!-- ── Headline metrics ─────────────────────────────────────────── -->
          <div class="tiles">
            <div class="tile">
              <span class="tile-k">Sessions</span>
              <span class="tile-v">{{ d.totals.sessions | number }}</span>
              <span class="tile-s muted">{{ d.totals.contracts }} contract(s)</span>
            </div>
            <div class="tile">
              <span class="tile-k">Trades</span>
              <span class="tile-v">{{ d.totals.tradeCount | number }}</span>
              <span class="tile-s muted">{{ d.totals.volume | number }} contracts traded</span>
            </div>
            <div class="tile" [attr.data-state]="coverageState(d.totals.aggressorCoveragePct)">
              <span class="tile-k">Aggressor coverage</span>
              <span class="tile-v">{{ d.totals.aggressorCoveragePct | number: '1.1-1' }}%</span>
              <span class="tile-s muted">tagged buy/sell — why CME was bought</span>
            </div>
            <div class="tile" [attr.data-state]="d.totals.sessionsTradesOnly > 0 ? 'warn' : 'good'">
              <span class="tile-k">Book coverage</span>
              <span class="tile-v">{{ d.totals.sessionsWithBook }}/{{ d.totals.sessions }}</span>
              <span class="tile-s muted">
                @if (d.totals.sessionsTradesOnly > 0) {
                  {{ d.totals.sessionsTradesOnly }} session(s) tape-only
                } @else {
                  every session has MBP-10
                }
              </span>
            </div>
            <div class="tile">
              <span class="tile-k">Span</span>
              <span class="tile-v">{{ d.totals.firstSession }} → {{ d.totals.lastSession }}</span>
              <span class="tile-s muted">
                {{ d.totals.calendarGapDays }} weekday(s) with no session
              </span>
            </div>
            <div class="tile">
              <span class="tile-k">On disk</span>
              <span class="tile-v">{{ gib(d.totals.tradeBytes + d.totals.bookBytes) }}</span>
              <span class="tile-s muted">
                book {{ gib(d.totals.bookBytes) }} · tape {{ mib(d.totals.tradeBytes) }}
              </span>
            </div>
          </div>

          <!-- ── Coverage timeline ────────────────────────────────────────── -->
          <figure class="panel">
            <figcaption>
              <strong>Session coverage</strong>
              <span class="muted small">
                One cell per imported session, in date order. Hatched = tape imported but book
                missing, the shape an interrupted import leaves behind.
              </span>
            </figcaption>
            <svg
              class="chart"
              [attr.viewBox]="'0 0 ' + chartWidth + ' 34'"
              preserveAspectRatio="none"
              role="img"
              [attr.aria-label]="coverageAria()"
            >
              <defs>
                <!-- One hatch per contract slot. currentColor cannot be used here: inside a
                     pattern it resolves against defs, not the referencing element, so a single
                     shared pattern renders black and the cell silently loses its contract identity
                     — exactly the information the strip exists to carry. -->
                <pattern
                  id="nobook-a"
                  patternUnits="userSpaceOnUse"
                  width="5"
                  height="5"
                  patternTransform="rotate(45)"
                >
                  <line x1="0" y1="0" x2="0" y2="5" stroke="var(--c-a)" stroke-width="2.5" />
                </pattern>
                <pattern
                  id="nobook-b"
                  patternUnits="userSpaceOnUse"
                  width="5"
                  height="5"
                  patternTransform="rotate(45)"
                >
                  <line x1="0" y1="0" x2="0" y2="5" stroke="var(--c-b)" stroke-width="2.5" />
                </pattern>
                <pattern
                  id="nobook-n"
                  patternUnits="userSpaceOnUse"
                  width="5"
                  height="5"
                  patternTransform="rotate(45)"
                >
                  <line x1="0" y1="0" x2="0" y2="5" stroke="var(--c-neutral)" stroke-width="2.5" />
                </pattern>
              </defs>
              @for (cell of coverageCells(); track cell.key) {
                <rect
                  [attr.x]="cell.x"
                  y="4"
                  [attr.width]="cell.width"
                  height="26"
                  [attr.fill]="
                    cell.tradesOnly ? hatchFor(cell.contract) : contractColour(cell.contract)
                  "
                  [attr.stroke]="cell.tradesOnly ? contractColour(cell.contract) : 'none'"
                  stroke-width="0.6"
                >
                  <title>{{ cell.tooltip }}</title>
                </rect>
              }
            </svg>
          </figure>

          <!-- ── Measure panels ───────────────────────────────────────────── -->
          <div class="panel-grid">
            @for (panel of panels(); track panel.key) {
              <figure class="panel">
                <figcaption>
                  <strong>{{ panel.title }}</strong>
                  <span class="muted small">{{ panel.caption }}</span>
                </figcaption>

                <div class="plot">
                  <span class="ytick top muted small">{{ panel.yMaxLabel }}</span>
                  <svg
                    class="chart"
                    [attr.viewBox]="'0 0 ' + chartWidth + ' ' + chartHeight"
                    preserveAspectRatio="none"
                    role="img"
                    [attr.aria-label]="panel.title + '. ' + panel.caption"
                  >
                    <line
                      class="axis-base"
                      x1="0"
                      [attr.x2]="chartWidth"
                      [attr.y1]="panel.baselineY"
                      [attr.y2]="panel.baselineY"
                    />
                    @if (panel.referenceY !== null) {
                      <line
                        class="axis-ref"
                        x1="0"
                        [attr.x2]="chartWidth"
                        [attr.y1]="panel.referenceY"
                        [attr.y2]="panel.referenceY"
                      />
                    }
                    @for (bar of panel.bars; track bar.key) {
                      <rect
                        [attr.x]="bar.x"
                        [attr.y]="bar.y"
                        [attr.width]="bar.width"
                        [attr.height]="bar.height"
                        rx="0.8"
                        [attr.fill]="
                          panel.colourBy === 'contract'
                            ? contractColour(bar.contract)
                            : polarityColour(bar.polarity)
                        "
                      >
                        <title>{{ bar.tooltip }}</title>
                      </rect>
                    }
                  </svg>
                  <span class="ytick bottom muted small">{{ panel.yMinLabel }}</span>
                </div>

                <p class="baseline-note muted small">
                  {{ panel.baselineLabel }}
                  @if (panel.referenceLabel) {
                    · <span class="ref-key">- - -</span> {{ panel.referenceLabel }}
                  }
                </p>
              </figure>
            }
          </div>

          <!-- Identity is never colour-alone: legend always present for >= 2 series. -->
          <div class="legend">
            @for (c of d.contracts; track c.contract) {
              <span class="legend-item">
                <span class="swatch" [style.background]="contractColour(c.contract)"></span>
                {{ c.contract }}
                <span class="muted small">
                  ({{ c.sessions }} sessions, {{ c.tradeCount | number }} trades)
                </span>
              </span>
            }
            <span class="legend-item">
              <span class="swatch hatched"></span>
              book missing
            </span>
          </div>

          <!-- Table view: the same data, readable without colour at all. -->
          <details class="table-details">
            <summary class="small">Per-contract table</summary>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Contract</th>
                    <th class="num">Sessions</th>
                    <th class="num">With book</th>
                    <th class="num">Tape-only</th>
                    <th class="num">Trades</th>
                    <th class="num">Volume</th>
                    <th class="num">Aggressor %</th>
                    <th>Span</th>
                  </tr>
                </thead>
                <tbody>
                  @for (c of d.contracts; track c.contract) {
                    <tr>
                      <td>{{ c.contract }}</td>
                      <td class="num">{{ c.sessions }}</td>
                      <td class="num">{{ c.sessionsWithBook }}</td>
                      <td class="num" [class.warn]="c.sessionsTradesOnly > 0">
                        {{ c.sessionsTradesOnly }}
                      </td>
                      <td class="num">{{ c.tradeCount | number }}</td>
                      <td class="num">{{ c.volume | number }}</td>
                      <td class="num">{{ c.aggressorCoveragePct | number: '1.1-1' }}</td>
                      <td class="small">{{ c.firstSession }} → {{ c.lastSession }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </details>
        }
      }
    </section>
  `,
  styles: [
    `
      /* Palette tokens. Light is defined on the bare selector so a viewer with no explicit theme
         choice still gets a complete palette; dark redefines ONLY what changes, guarded so an
         explicit light choice wins, and again under [data-theme='dark'] so the toggle wins both
         ways. Both pairs are validator-passed against their own surface. */
      .hist {
        --c-a: #2a78d6;
        --c-b: #eb6834;
        --c-neutral: #8e8e93;
        --axis: rgba(0, 0, 0, 0.22);
        --axis-ref: rgba(0, 0, 0, 0.34);
        --surface: #fcfcfb;
        display: grid;
        gap: 1rem;
        margin-top: 1.25rem;
      }
      @media (prefers-color-scheme: dark) {
        :root:not([data-theme='light']) .hist {
          --c-a: #3987e5;
          --c-b: #d95926;
          --c-neutral: #9a9aa0;
          --axis: rgba(255, 255, 255, 0.26);
          --axis-ref: rgba(255, 255, 255, 0.4);
          --surface: #1a1a19;
        }
      }
      :root[data-theme='dark'] .hist {
        --c-a: #3987e5;
        --c-b: #d95926;
        --c-neutral: #9a9aa0;
        --axis: rgba(255, 255, 255, 0.26);
        --axis-ref: rgba(255, 255, 255, 0.4);
        --surface: #1a1a19;
      }

      .hist-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 1rem;
        flex-wrap: wrap;
      }
      h3 {
        margin: 0 0 0.15rem;
        font-size: 1rem;
      }
      p {
        margin: 0;
      }
      .muted {
        opacity: 0.7;
      }
      .small {
        font-size: 0.8125rem;
      }
      .err {
        color: #d7263d;
      }
      .warn {
        color: #b26a00;
      }

      .tiles {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
        gap: 0.6rem;
      }
      .tile {
        display: grid;
        gap: 0.15rem;
        padding: 0.6rem 0.7rem;
        border: 1px solid var(--axis);
        border-radius: 8px;
        min-width: 0;
      }
      .tile[data-state='warn'] {
        border-color: rgba(255, 149, 0, 0.55);
      }
      .tile[data-state='good'] {
        border-color: rgba(52, 199, 89, 0.45);
      }
      .tile-k {
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        opacity: 0.7;
      }
      .tile-v {
        font-size: 1.15rem;
        font-variant-numeric: tabular-nums;
        overflow-wrap: anywhere;
      }
      .tile-s {
        font-size: 0.75rem;
      }

      .panel-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(19rem, 1fr));
        gap: 0.9rem;
      }
      .panel {
        margin: 0;
        display: grid;
        gap: 0.4rem;
        min-width: 0;
      }
      figcaption {
        display: grid;
        gap: 0.1rem;
      }
      .plot {
        display: grid;
        gap: 0.1rem;
      }
      .ytick {
        font-variant-numeric: tabular-nums;
      }
      .ytick.bottom {
        justify-self: start;
      }
      .chart {
        width: 100%;
        height: 132px;
        display: block;
        overflow: visible;
      }
      .axis-base {
        stroke: var(--axis);
        stroke-width: 1;
      }
      .axis-ref {
        stroke: var(--axis-ref);
        stroke-width: 1;
        stroke-dasharray: 4 3;
      }
      .baseline-note {
        margin: 0;
      }
      .ref-key {
        letter-spacing: -0.1em;
      }

      .legend {
        display: flex;
        flex-wrap: wrap;
        gap: 0.9rem;
        align-items: center;
      }
      .legend-item {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        font-size: 0.8125rem;
      }
      .swatch {
        width: 0.7rem;
        height: 0.7rem;
        border-radius: 2px;
        display: inline-block;
      }
      .swatch.hatched {
        border: 1px solid var(--c-neutral);
        background: repeating-linear-gradient(
          45deg,
          transparent,
          transparent 2px,
          var(--c-neutral) 2px,
          var(--c-neutral) 4px
        );
      }

      .table-details summary {
        cursor: pointer;
      }
      /* Wide content scrolls inside its own container so the page body never scrolls sideways. */
      .table-wrap {
        overflow-x: auto;
        margin-top: 0.5rem;
      }
      table {
        border-collapse: collapse;
        width: 100%;
        font-size: 0.8125rem;
      }
      th,
      td {
        text-align: left;
        padding: 0.3rem 0.55rem;
        border-bottom: 1px solid var(--axis);
        white-space: nowrap;
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .btn {
        padding: 0.4rem 0.8rem;
        border-radius: 7px;
        border: 1px solid var(--axis);
        background: transparent;
        color: inherit;
        cursor: pointer;
        font: inherit;
      }
      .btn[disabled] {
        opacity: 0.55;
        cursor: default;
      }
    `,
  ],
})
export class CmeHistoricAnalyticsComponent {
  private readonly service = inject(CmeMicrostructureService);

  protected readonly chartWidth = 320;
  protected readonly chartHeight = 132;

  protected readonly data = signal<CmeHistoricAnalyticsDto | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  /**
   * Contract → colour, assigned in fixed order from the sorted contract list rather than by array
   * position in whatever the last response happened to contain. A filter that drops one contract
   * must not repaint the survivor.
   */
  private readonly contractOrder = computed(() =>
    [...new Set((this.data()?.sessions ?? []).map((s) => s.contract))].sort(),
  );

  protected contractColour(contract: string): string {
    const i = this.contractOrder().indexOf(contract);
    // Two slots is the whole categorical need here (a root has a front and a back month in view).
    // A third contract folds into neutral rather than inventing a hue.
    return i === 0 ? 'var(--c-a)' : i === 1 ? 'var(--c-b)' : 'var(--c-neutral)';
  }

  /** Hatch fill matching the contract's own hue — see the <defs> comment for why not currentColor. */
  protected hatchFor(contract: string): string {
    const i = this.contractOrder().indexOf(contract);
    return i === 0 ? 'url(#nobook-a)' : i === 1 ? 'url(#nobook-b)' : 'url(#nobook-n)';
  }

  protected polarityColour(p: AnalyticsBar['polarity']): string {
    return p === 'up' ? 'var(--c-a)' : p === 'down' ? 'var(--c-b)' : 'var(--c-neutral)';
  }

  protected coverageState(pct: number): 'good' | 'warn' {
    return pct >= 95 ? 'good' : 'warn';
  }

  protected gib(bytes: number): string {
    return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  }

  protected mib(bytes: number): string {
    return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  }

  protected coverageAria(): string {
    const d = this.data();
    if (!d) return 'Session coverage';
    return (
      `Session coverage: ${d.totals.sessions} sessions, ` +
      `${d.totals.sessionsWithBook} with book, ${d.totals.sessionsTradesOnly} tape-only.`
    );
  }

  protected readonly coverageCells = computed<CoverageCell[]>(() => {
    const sessions = this.data()?.sessions ?? [];
    if (sessions.length === 0) return [];

    const cellWidth = this.chartWidth / sessions.length;
    // The SVG is stretched horizontally (preserveAspectRatio="none"), so a fixed pixel gap is
    // magnified by the same factor as the cell. Taking the gap as a FRACTION of the cell keeps the
    // strip reading as a dense timeline at any session count; a fixed 1px gap on a 4px cell became
    // 25% whitespace and turned it into a barcode.
    const gap = Math.min(1, cellWidth * 0.12);
    return sessions.map((s, i) => ({
      key: `${s.contract}-${s.sessionDate}`,
      x: i * cellWidth + gap / 2,
      width: Math.max(0.8, cellWidth - gap),
      contract: s.contract,
      tradesOnly: s.isTradesOnly,
      tooltip:
        `${s.contract} · ${s.sessionDate}\n` +
        `${s.tradeCount.toLocaleString()} trades · ${s.volume.toLocaleString()} volume\n` +
        `aggressor ${s.aggressorCoveragePct.toFixed(1)}%\n` +
        (s.hasBook ? 'book: present' : 'book: MISSING (tape-only import)'),
    }));
  });

  protected readonly panels = computed<AnalyticsPanel[]>(() => {
    const sessions = this.data()?.sessions ?? [];
    if (sessions.length === 0) return [];

    return [
      this.magnitudePanel(
        'trades',
        'Trades per session',
        'Tape depth over the slice. Contract colour carries identity.',
        sessions,
        (s) => s.tradeCount,
        (v) => `${v.toLocaleString()} trades`,
      ),
      this.divergingPanel(
        'imbalance',
        'Aggressor imbalance',
        'Buy share of directional volume, centred on balanced (0.50). Above = buyers lifted more.',
        sessions,
      ),
      this.coveragePanel(sessions),
      this.magnitudePanel(
        'range',
        'Session range',
        'High−low in ticks — the volatility character of each session.',
        sessions,
        (s) => Number(s.rangeTicks),
        (v) => `${v.toFixed(0)} ticks`,
      ),
    ];
  });

  /** Magnitude over time: bars from a true zero baseline. */
  private magnitudePanel(
    key: string,
    title: string,
    caption: string,
    sessions: readonly CmeSessionAnalyticsDto[],
    value: (s: CmeSessionAnalyticsDto) => number,
    format: (v: number) => string,
  ): AnalyticsPanel {
    const values = sessions.map(value);
    const max = Math.max(1, ...values);
    const pad = 6;
    const plot = this.chartHeight - pad * 2;
    const baselineY = pad + plot;
    const slot = this.chartWidth / sessions.length;
    const width = Math.max(1, slot - (slot > 3 ? 1 : 0));

    return {
      key,
      title,
      caption,
      baselineY,
      baselineLabel: 'Baseline is zero, not the data minimum.',
      referenceY: null,
      referenceLabel: null,
      colourBy: 'contract',
      yMaxLabel: format(max),
      yMinLabel: '0',
      bars: sessions.map((s, i) => {
        const h = (value(s) / max) * plot;
        return {
          key: `${key}-${s.contract}-${s.sessionDate}`,
          x: i * slot + (slot > 3 ? 0.5 : 0),
          y: baselineY - h,
          width,
          height: Math.max(1, h),
          contract: s.contract,
          polarity: 'neutral' as const,
          tooltip: `${s.contract} · ${s.sessionDate}\n${format(value(s))}`,
        };
      }),
    };
  }

  /**
   * Polarity around a neutral midpoint — a diverging form, so it gets two hues and a neutral
   * baseline rather than a sequential ramp. The midpoint is 0.50 (balanced flow), which is the only
   * value that means anything here; a zero baseline would put every bar at the top of the chart.
   */
  private divergingPanel(
    key: string,
    title: string,
    caption: string,
    sessions: readonly CmeSessionAnalyticsDto[],
  ): AnalyticsPanel {
    const deltas = sessions.map((s) => s.buyVolumeShare - 0.5);
    // Symmetric domain: an asymmetric one would make a 2% buy skew look bigger than an equal sell
    // skew purely because of where the extremes landed.
    const bound = Math.max(0.02, ...deltas.map(Math.abs));
    const pad = 6;
    const plot = this.chartHeight - pad * 2;
    const baselineY = pad + plot / 2;
    const slot = this.chartWidth / sessions.length;
    const width = Math.max(1, slot - (slot > 3 ? 1 : 0));

    return {
      key,
      title,
      caption,
      baselineY,
      baselineLabel: 'Baseline is balanced flow (0.50 buy share).',
      referenceY: null,
      referenceLabel: null,
      colourBy: 'polarity',
      yMaxLabel: `+${(bound * 100).toFixed(1)}pp buy`,
      yMinLabel: `−${(bound * 100).toFixed(1)}pp sell`,
      bars: sessions.map((s, i) => {
        const delta = s.buyVolumeShare - 0.5;
        const h = (Math.abs(delta) / bound) * (plot / 2);
        return {
          key: `${key}-${s.contract}-${s.sessionDate}`,
          x: i * slot + (slot > 3 ? 0.5 : 0),
          y: delta >= 0 ? baselineY - h : baselineY,
          width,
          height: Math.max(1, h),
          contract: s.contract,
          polarity: delta >= 0 ? ('up' as const) : ('down' as const),
          tooltip:
            `${s.contract} · ${s.sessionDate}\n` +
            `buy share ${(s.buyVolumeShare * 100).toFixed(1)}% ` +
            `(${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}pp vs balanced)\n` +
            `buy ${s.buyVolume.toLocaleString()} · sell ${s.sellVolume.toLocaleString()}`,
        };
      }),
    };
  }

  /**
   * Aggressor coverage with a 95% quality threshold. Plotted against a 90–100% domain rather than
   * 0–100: the interesting variation lives in the top few points, and a full-height axis flattens
   * every session into an identical full bar.
   */
  private coveragePanel(sessions: readonly CmeSessionAnalyticsDto[]): AnalyticsPanel {
    const floor = 90;
    const pad = 6;
    const plot = this.chartHeight - pad * 2;
    const baselineY = pad + plot;
    const yOf = (pct: number) => pad + ((100 - Math.max(floor, pct)) / (100 - floor)) * plot;
    const slot = this.chartWidth / sessions.length;
    const width = Math.max(1, slot - (slot > 3 ? 1 : 0));

    return {
      key: 'coverage',
      title: 'Aggressor tag coverage',
      caption:
        'Share of trades carrying a buy/sell tag. This is the quality metric — untagged flow is ' +
        'the retail feed we already had.',
      baselineY,
      baselineLabel: `Axis floor ${floor}%, not 0% — the variation lives in the top few points.`,
      referenceY: yOf(95),
      referenceLabel: '95% quality threshold',
      colourBy: 'contract',
      yMaxLabel: '100%',
      yMinLabel: `${floor}%`,
      bars: sessions.map((s, i) => {
        const y = yOf(s.aggressorCoveragePct);
        return {
          key: `coverage-${s.contract}-${s.sessionDate}`,
          x: i * slot + (slot > 3 ? 0.5 : 0),
          y,
          width,
          height: Math.max(1, baselineY - y),
          contract: s.contract,
          polarity: 'neutral' as const,
          tooltip:
            `${s.contract} · ${s.sessionDate}\n` +
            `${s.aggressorCoveragePct.toFixed(2)}% tagged\n` +
            `untagged volume ${s.untaggedVolume.toLocaleString()}`,
        };
      }),
    };
  }

  load(): void {
    if (this.loading()) return;
    this.loading.set(true);
    this.error.set(null);

    this.service.getHistoricAnalytics().subscribe({
      next: (res) => {
        if (res.status && res.data) {
          this.data.set(res.data);
          // A successful envelope can still carry an operator-relevant message (e.g. the warm tier
          // being unconfigured), so surface it rather than showing an empty panel with no reason.
          if (!res.data.configured && res.message) this.error.set(res.message);
        } else {
          this.error.set(res.message || 'Could not read historic analytics.');
        }
        this.loading.set(false);
      },
      error: (err: unknown) => {
        this.error.set(err instanceof Error ? err.message : 'Could not read historic analytics.');
        this.loading.set(false);
      },
    });
  }
}
