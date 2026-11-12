import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { DatePipe, DecimalPipe, PercentPipe } from '@angular/common';
import type { EChartsOption } from 'echarts';

import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { ThemeService } from '@core/theme/theme.service';
import type {
  MonitorInsights,
  MonitorSegmentInsight,
  MonitorSymbolInsight,
} from '@features/analysis-monitors/analysis-monitors.types';

/**
 * Chart colours. Outcome series take the validated categorical slots 1-4 IN ORDER (blue, orange,
 * aqua, yellow — checked for CVD separation against both surfaces); magnitude uses one blue ramp.
 * Never the status reds/greens: those failed the colour-vision check side by side, and a fire is
 * not "good" in itself.
 */
const PALETTE = {
  light: {
    series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'],
    ink: '#52514e',
    muted: '#898781',
    grid: '#e1e0d9',
    axis: '#c3c2b7',
    surface: '#fcfcfb',
    ramp: ['#f0efec', '#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#104281'],
  },
  dark: {
    series: ['#3987e5', '#d95926', '#199e70', '#c98500'],
    ink: '#c3c2b7',
    muted: '#898781',
    grid: '#2c2c2a',
    axis: '#383835',
    surface: '#1a1a19',
    ramp: ['#383835', '#184f95', '#1c5cab', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4'],
  },
} as const;

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Plain-language labels for the engine's terminal grades. */
const VERDICT_LABELS: Record<string, string> = {
  Fired: 'Fired',
  NeverFired: 'Never fired',
  Invalidated: 'Thesis broke',
  Cancelled: 'Cancelled',
  Expired: 'Ran out of time',
  Error: 'Errored',
};

type SymbolSortKey = 'symbol' | 'live' | 'created' | 'fires' | 'fireRate' | 'ttf' | 'signals' | 'pnl' | 'last';

/**
 * The cockpit's analytics panel: is any of what we arm worth arming?
 *
 * <p>The board above answers "what is armed right now". This answers the questions the board can't:
 * how often watches actually fire, how long that takes, which pairs and which kinds of watch work,
 * when in the week fires cluster, how watches end, and what the trades they filed returned.</p>
 *
 * <p>Every rate is measured on one cohort — the watches ARMED inside the window — so "fire rate"
 * cannot be inflated by old recurring watches that keep firing.</p>
 */
@Component({
  selector: 'app-monitor-insights',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChartCardComponent, DatePipe, DecimalPipe, PercentPipe],
  template: `
    @if (insights(); as ins) {
      <div class="grid">
        <!-- Trend -->
        <section class="cell span-2">
          <header class="cell-head">
            <h3>Daily outcomes</h3>
            <span class="hint"
              >Watches armed (line) against how they ended, per UTC day · {{ ins.totals.created }} armed,
              {{ ins.totals.fires }} fires</span
            >
          </header>
          <app-chart-card
            flush
            height="210px"
            [options]="dailyOptions()"
            [emptyMessage]="hasDaily() ? null : 'Nothing armed or ended in this window.'"
            alt="Daily monitor outcomes: armed, fired, thesis broke, expired, cancelled"
          />
        </section>

        <!-- How watches end -->
        <section class="cell">
          <header class="cell-head">
            <h3>How watches end</h3>
            <span class="hint">Terminal grade of this window's finished watches</span>
          </header>
          @if (verdictRows().length === 0) {
            <p class="empty">None of this window's watches has finished yet.</p>
          } @else {
            <ul class="bars">
              @for (v of verdictRows(); track v.key) {
                <li>
                  <span class="bar-label">{{ v.label }}</span>
                  <span class="bar-track"
                    ><span class="bar-fill" [style.width.%]="v.share * 100"></span
                  ></span>
                  <span class="bar-val mono">{{ v.count }}</span>
                  <span class="bar-pct mono">{{ v.share | percent: '1.0-0' }}</span>
                </li>
              }
            </ul>
          }
          <h4 class="sub">Time from arming to first fire</h4>
          @if (ttfTotal() === 0) {
            <p class="empty">No watch armed in this window has fired yet.</p>
          } @else {
            <div class="hist">
              @for (b of ins.timeToFire; track b.key) {
                <div class="hist-col" [title]="b.count + ' watch' + (b.count === 1 ? '' : 'es') + ' fired ' + b.key + ' after arming'">
                  <span class="hist-val mono">{{ b.count || '' }}</span>
                  <span class="hist-bar" [style.height.%]="ttfMax() ? (b.count / ttfMax()) * 100 : 0"></span>
                  <span class="hist-key">{{ b.key }}</span>
                </div>
              }
            </div>
          }
        </section>

        <!-- Per symbol -->
        <section class="cell span-2">
          <header class="cell-head">
            <h3>By instrument</h3>
            <span class="hint">Click a row to filter the board to it</span>
          </header>
          @if (ins.bySymbol.length === 0) {
            <p class="empty">No instrument had a watch in this window.</p>
          } @else {
            <div class="table-wrap">
              <table class="sym-table">
                <thead>
                  <tr>
                    <th (click)="sortBy('symbol')" [class.sorted]="symSort() === 'symbol'">Instrument</th>
                    <th class="num" (click)="sortBy('live')" [class.sorted]="symSort() === 'live'">Live</th>
                    <th class="num" (click)="sortBy('created')" [class.sorted]="symSort() === 'created'">Armed</th>
                    <th class="num" (click)="sortBy('fires')" [class.sorted]="symSort() === 'fires'">Fires</th>
                    <th (click)="sortBy('fireRate')" [class.sorted]="symSort() === 'fireRate'">Fire rate</th>
                    <th class="num" title="Thesis broke / expired / cancelled">Broke · Exp · Cxl</th>
                    <th class="num" (click)="sortBy('ttf')" [class.sorted]="symSort() === 'ttf'">Med. to fire</th>
                    <th class="num" (click)="sortBy('signals')" [class.sorted]="symSort() === 'signals'">Signals</th>
                    <th class="num" (click)="sortBy('pnl')" [class.sorted]="symSort() === 'pnl'">Net P&amp;L</th>
                    <th class="num" (click)="sortBy('last')" [class.sorted]="symSort() === 'last'">Last fire</th>
                  </tr>
                </thead>
                <tbody>
                  @for (s of sortedSymbols(); track s.symbol) {
                    <tr
                      [class.active]="activeSymbol() === s.symbol"
                      (click)="symbolPicked.emit(activeSymbol() === s.symbol ? '' : s.symbol)"
                    >
                      <td class="mono strong">{{ s.symbol }}</td>
                      <td class="num">
                        @if (s.live > 0) {
                          <span class="live-dot"></span>{{ s.live }}
                        } @else {
                          <span class="muted">0</span>
                        }
                      </td>
                      <td class="num">{{ s.created }}</td>
                      <td class="num">{{ s.fires }}</td>
                      <td>
                        @if (has(s.fireRate)) {
                          <span class="rate">
                            <span class="rate-track"
                              ><span class="rate-fill" [style.width.%]="s.fireRate * 100"></span
                            ></span>
                            <span class="mono">{{ s.fireRate | percent: '1.0-0' }}</span>
                            <span class="muted small">of {{ s.ended }}</span>
                          </span>
                        } @else {
                          <span class="muted small">none finished</span>
                        }
                      </td>
                      <td class="num muted">{{ s.invalidated }} · {{ s.expired }} · {{ s.cancelled }}</td>
                      <td class="num">{{ hours(s.medianHoursToFire) }}</td>
                      <td class="num">{{ s.signalsFiled || '—' }}</td>
                      <td class="num" [class.pos]="s.netPnl > 0" [class.neg]="s.netPnl < 0">
                        @if (s.closedTrades > 0) {
                          {{ s.netPnl > 0 ? '+' : '' }}{{ s.netPnl | number: '1.2-2' }}
                          <span class="muted small">({{ s.closedTrades }})</span>
                        } @else {
                          <span class="muted">—</span>
                        }
                      </td>
                      <td class="num muted">
                        {{ s.lastFiredAtUtc ? (s.lastFiredAtUtc | date: 'MMM d HH:mm' : 'UTC') : '—' }}
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>

        <!-- Segments -->
        <section class="cell">
          <header class="cell-head">
            <h3>Which kinds of watch work</h3>
            <span class="hint">Fire rate of finished watches, by slice</span>
          </header>
          @for (group of segmentGroups(); track group.dimension) {
            <h4 class="sub">{{ group.label }}</h4>
            <ul class="bars">
              @for (s of group.rows; track s.key) {
                <li
                  [title]="
                    s.firedAtLeastOnce + ' of ' + s.created + ' armed fired; ' + s.ended + ' finished, ' +
                    s.invalidated + ' broke their thesis'
                  "
                >
                  <span class="bar-label">{{ s.key }}</span>
                  <span class="bar-track"
                    ><span class="bar-fill" [style.width.%]="(s.fireRate ?? 0) * 100"></span
                  ></span>
                  <span class="bar-val mono">{{ has(s.fireRate) ? (s.fireRate | percent: '1.0-0') : '—' }}</span>
                  <span class="bar-pct mono muted">n={{ s.created }}</span>
                </li>
              }
            </ul>
          }
        </section>

        <!-- Heatmap -->
        <section class="cell span-2">
          <header class="cell-head">
            <h3>When fires happen</h3>
            <span class="hint">Fires by weekday × hour (UTC) · darker = more</span>
          </header>
          <app-chart-card
            flush
            height="190px"
            [options]="heatmapOptions()"
            [emptyMessage]="ins.totals.fires > 0 ? null : 'No fires in this window.'"
            alt="Heatmap of monitor fires by weekday and UTC hour"
          />
        </section>

        <!-- Trades -->
        <section class="cell">
          <header class="cell-head">
            <h3>What the fires traded</h3>
            <span class="hint">Signals filed by fires in this window, followed to their positions</span>
          </header>
          @if (ins.trades.signalsFiled === 0) {
            <p class="empty">No fire in this window filed a signal.</p>
          } @else {
            <div class="funnel">
              <div class="funnel-step">
                <span class="f-val">{{ ins.trades.signalsFiled }}</span><span class="f-key">filed</span>
              </div>
              <span class="f-arrow">→</span>
              <div class="funnel-step">
                <span class="f-val">{{ ins.trades.executed }}</span><span class="f-key">executed</span>
              </div>
              <span class="f-arrow">→</span>
              <div class="funnel-step">
                <span class="f-val">{{ ins.trades.closedTrades }}</span><span class="f-key">closed</span>
              </div>
            </div>
            <p class="muted small">
              {{ ins.trades.rejected }} rejected · {{ ins.trades.expired }} expired ·
              {{ ins.trades.pending }} pending · {{ ins.trades.openTrades }} still open
            </p>
            <dl class="trade-facts">
              <dt>Net P&amp;L</dt>
              <dd class="mono" [class.pos]="ins.trades.netPnl > 0" [class.neg]="ins.trades.netPnl < 0">
                {{ ins.trades.netPnl > 0 ? '+' : '' }}{{ ins.trades.netPnl | number: '1.2-2' }}
              </dd>
              <dt>Win rate</dt>
              <dd class="mono">
                {{ has(ins.trades.winRate) ? (ins.trades.winRate | percent: '1.0-0') : '—' }}
                <span class="muted small">{{ ins.trades.wins }}W / {{ ins.trades.losses }}L</span>
              </dd>
              <dt>Avg win / loss</dt>
              <dd class="mono">
                {{ has(ins.trades.avgWin) ? (ins.trades.avgWin | number: '1.2-2') : '—' }} /
                {{ has(ins.trades.avgLoss) ? (ins.trades.avgLoss | number: '1.2-2') : '—' }}
              </dd>
              <dt>Profit factor</dt>
              <dd class="mono">
                {{ has(ins.trades.profitFactor) ? (ins.trades.profitFactor | number: '1.2-2') : '—' }}
              </dd>
            </dl>
            <p class="muted tiny">P&amp;L is net of swap and commission, in each account's own currency.</p>
          }
        </section>
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: var(--space-3);
      }
      @media (max-width: 1200px) {
        .grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      @media (max-width: 800px) {
        .grid {
          grid-template-columns: 1fr;
        }
        .span-2 {
          grid-column: auto !important;
        }
      }
      .cell {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
        min-width: 0;
      }
      .span-2 {
        grid-column: span 2;
      }
      .cell-head {
        display: flex;
        flex-direction: column;
        gap: 2px;
        margin-bottom: var(--space-2);
      }
      h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .hint {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      h4.sub {
        margin: var(--space-3) 0 var(--space-1);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-tertiary);
        font-weight: var(--font-medium);
      }
      .empty {
        margin: var(--space-2) 0;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .mono {
        font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
        font-variant-numeric: tabular-nums;
      }
      .muted {
        color: var(--text-tertiary);
      }
      .small {
        font-size: var(--text-xs);
      }
      .tiny {
        font-size: 11px;
        margin: var(--space-2) 0 0;
      }
      .strong {
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .pos {
        color: var(--tone-green);
      }
      .neg {
        color: var(--tone-red);
      }

      /* Horizontal bars (verdicts, segments): one hue, magnitude only. */
      .bars {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 5px;
      }
      .bars li {
        display: grid;
        grid-template-columns: minmax(90px, 0.9fr) minmax(60px, 1.4fr) 44px 40px;
        align-items: center;
        gap: var(--space-2);
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .bar-label {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .bar-track,
      .rate-track {
        height: 8px;
        border-radius: 4px;
        background: var(--bg-tertiary);
        overflow: hidden;
        display: block;
      }
      .bar-fill,
      .rate-fill {
        display: block;
        height: 100%;
        border-radius: 4px;
        background: #2a78d6;
        transition: width var(--dur-base, 200ms) ease;
      }
      :host-context([data-theme='dark']) .bar-fill,
      :host-context([data-theme='dark']) .rate-fill,
      :host-context([data-theme='dark']) .hist-bar {
        background: #3987e5;
      }
      .bar-val,
      .bar-pct {
        text-align: right;
        color: var(--text-primary);
      }
      .bar-pct.muted {
        color: var(--text-tertiary);
      }

      /* Time-to-fire histogram. */
      .hist {
        display: grid;
        grid-template-columns: repeat(6, minmax(0, 1fr));
        gap: 6px;
        height: 96px;
        align-items: end;
      }
      .hist-col {
        display: flex;
        flex-direction: column;
        align-items: stretch;
        justify-content: flex-end;
        height: 100%;
        gap: 2px;
      }
      .hist-val {
        font-size: 11px;
        text-align: center;
        color: var(--text-secondary);
        min-height: 14px;
      }
      .hist-bar {
        display: block;
        background: #2a78d6;
        border-radius: 4px 4px 0 0;
        min-height: 0;
      }
      .hist-key {
        font-size: 10px;
        text-align: center;
        color: var(--text-tertiary);
        border-top: 1px solid var(--border);
        padding-top: 2px;
        white-space: nowrap;
      }

      /* Per-symbol table. */
      .table-wrap {
        overflow-x: auto;
        max-height: 260px;
        overflow-y: auto;
      }
      .sym-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-xs);
      }
      .sym-table th {
        position: sticky;
        top: 0;
        background: var(--bg-primary);
        text-align: left;
        font-weight: var(--font-medium);
        color: var(--text-tertiary);
        padding: 4px 8px;
        border-bottom: 1px solid var(--border);
        white-space: nowrap;
        cursor: pointer;
        user-select: none;
      }
      .sym-table th.sorted {
        color: var(--text-primary);
      }
      .sym-table th.sorted::after {
        content: ' ↓';
      }
      .sym-table td {
        padding: 5px 8px;
        border-bottom: 1px solid var(--border);
        color: var(--text-secondary);
        white-space: nowrap;
      }
      .sym-table .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .sym-table tbody tr {
        cursor: pointer;
      }
      .sym-table tbody tr:hover {
        background: var(--bg-secondary);
      }
      .sym-table tbody tr.active {
        background: color-mix(in srgb, var(--accent) 12%, transparent);
      }
      .live-dot {
        display: inline-block;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--profit);
        margin-right: 5px;
        vertical-align: middle;
      }
      .rate {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .rate-track {
        width: 64px;
      }

      /* Trades. */
      .funnel {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        margin: var(--space-1) 0 var(--space-2);
      }
      .funnel-step {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 6px 4px;
        border-radius: var(--radius-sm);
        background: var(--bg-secondary);
      }
      .f-val {
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }
      .f-key {
        font-size: 11px;
        color: var(--text-tertiary);
      }
      .f-arrow {
        color: var(--text-tertiary);
      }
      .trade-facts {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 4px var(--space-3);
        margin: var(--space-2) 0 0;
        font-size: var(--text-xs);
      }
      .trade-facts dt {
        color: var(--text-tertiary);
      }
      .trade-facts dd {
        margin: 0;
        color: var(--text-primary);
        text-align: right;
      }
    `,
  ],
})
export class MonitorInsightsComponent {
  /** Template null-check: the lint rule forbids `!= null` in templates, and `!== null` alone misses undefined. */
  protected has(v: unknown): boolean {
    return v !== null && v !== undefined;
  }

  private readonly theme = inject(ThemeService);

  readonly insights = input<MonitorInsights | null>(null);
  /** Symbol the board is filtered to, highlighted in the table. */
  readonly activeSymbol = input<string>('');
  readonly symbolPicked = output<string>();

  protected readonly symSort = signal<SymbolSortKey>('live');

  private readonly pal = computed(() => (this.theme.theme() === 'dark' ? PALETTE.dark : PALETTE.light));

  protected readonly hasDaily = computed(() =>
    (this.insights()?.daily ?? []).some(
      (d) => d.created + d.fired + d.invalidated + d.expired + d.cancelled > 0,
    ),
  );

  protected readonly ttfTotal = computed(() =>
    (this.insights()?.timeToFire ?? []).reduce((a, b) => a + b.count, 0),
  );
  protected readonly ttfMax = computed(() =>
    Math.max(0, ...(this.insights()?.timeToFire ?? []).map((b) => b.count)),
  );

  protected readonly verdictRows = computed(() => {
    const v = this.insights()?.verdicts ?? [];
    const total = v.reduce((a, b) => a + b.count, 0);
    return v.map((x) => ({
      key: x.key,
      label: VERDICT_LABELS[x.key] ?? x.key,
      count: x.count,
      share: total ? x.count / total : 0,
    }));
  });

  protected readonly segmentGroups = computed(() => {
    const segs = this.insights()?.segments ?? [];
    const labels: Record<string, string> = { origin: 'Who armed it', mode: 'How it is checked', kind: 'Watch type' };
    return ['kind', 'mode', 'origin']
      .map((dimension) => ({
        dimension,
        label: labels[dimension],
        rows: segs.filter((s: MonitorSegmentInsight) => s.dimension === dimension),
      }))
      .filter((g) => g.rows.length > 0);
  });

  protected readonly sortedSymbols = computed(() => {
    const rows = [...(this.insights()?.bySymbol ?? [])];
    const key = this.symSort();
    const val = (s: MonitorSymbolInsight): number | string => {
      switch (key) {
        case 'symbol':
          return s.symbol;
        case 'live':
          return s.live * 1e6 + s.created;
        case 'created':
          return s.created;
        case 'fires':
          return s.fires;
        case 'fireRate':
          return s.fireRate ?? -1;
        case 'ttf':
          return -(s.medianHoursToFire ?? 1e9);
        case 'signals':
          return s.signalsFiled;
        case 'pnl':
          return s.netPnl;
        case 'last':
          return s.lastFiredAtUtc ? Date.parse(s.lastFiredAtUtc) : 0;
      }
    };
    return rows.sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (typeof x === 'string' && typeof y === 'string') return x.localeCompare(y);
      return (y as number) - (x as number);
    });
  });

  protected sortBy(k: SymbolSortKey): void {
    this.symSort.set(k);
  }

  protected hours(h: number | null | undefined): string {
    if (h == null) return '—';
    if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
    if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)}h`;
    return `${(h / 24).toFixed(1)}d`;
  }

  // ── Charts ────────────────────────────────────────────────────────────────

  protected readonly dailyOptions = computed<EChartsOption>(() => {
    const ins = this.insights();
    const p = this.pal();
    if (!ins) return {};
    const days = ins.daily.map((d) => d.dateUtc.slice(5, 10).replace('-', '/'));
    const bar = (name: string, data: number[], color: string, last: boolean) => ({
      name,
      type: 'bar' as const,
      stack: 'end',
      barMaxWidth: 22,
      data: data.map((v) => (v === 0 ? null : v)),
      itemStyle: {
        color,
        borderColor: p.surface,
        borderWidth: 1,
        // Rounded data-end on the top segment only.
        borderRadius: last ? [4, 4, 0, 0] : 0,
      },
      emphasis: { focus: 'series' as const },
    });
    return {
      animationDuration: 300,
      grid: { top: 30, right: 8, bottom: 22, left: 30, containLabel: false },
      legend: {
        top: 0,
        left: 0,
        itemWidth: 10,
        itemHeight: 10,
        icon: 'roundRect',
        textStyle: { color: p.ink, fontSize: 11 },
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        valueFormatter: (v) => (v == null ? '0' : String(v)),
      },
      xAxis: {
        type: 'category',
        data: days,
        axisLine: { lineStyle: { color: p.axis } },
        axisTick: { show: false },
        axisLabel: { color: p.muted, fontSize: 10, hideOverlap: true },
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        splitLine: { lineStyle: { color: p.grid } },
        axisLabel: { color: p.muted, fontSize: 10 },
      },
      series: [
        bar('Fired', ins.daily.map((d) => d.fired), p.series[0], false),
        bar('Thesis broke', ins.daily.map((d) => d.invalidated), p.series[1], false),
        bar('Expired', ins.daily.map((d) => d.expired), p.series[2], false),
        bar('Cancelled', ins.daily.map((d) => d.cancelled), p.series[3], true),
        {
          name: 'Armed',
          type: 'line',
          data: ins.daily.map((d) => d.created),
          symbol: 'circle',
          symbolSize: 5,
          lineStyle: { width: 2, color: p.ink, type: 'dashed' },
          itemStyle: { color: p.ink, borderColor: p.surface, borderWidth: 2 },
          z: 5,
        },
      ],
    };
  });

  protected readonly heatmapOptions = computed<EChartsOption>(() => {
    const ins = this.insights();
    const p = this.pal();
    if (!ins) return {};
    const data: [number, number, number][] = [];
    let max = 0;
    ins.fireHeatmap.forEach((row, wd) =>
      row.forEach((v, h) => {
        data.push([h, wd, v]);
        max = Math.max(max, v);
      }),
    );
    return {
      animationDuration: 300,
      grid: { top: 4, right: 8, bottom: 22, left: 34, containLabel: false },
      tooltip: {
        formatter: (params) => {
          const d = (params as unknown as { data: [number, number, number] }).data;
          return `${WEEKDAYS[d[1]]} ${String(d[0]).padStart(2, '0')}:00–${String(d[0]).padStart(2, '0')}:59 UTC<br/><b>${d[2]}</b> fire${d[2] === 1 ? '' : 's'}`;
        },
      },
      xAxis: {
        type: 'category',
        data: Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')),
        splitArea: { show: false },
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: p.muted, fontSize: 10, interval: 2 },
      },
      yAxis: {
        type: 'category',
        data: WEEKDAYS,
        inverse: true,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: p.muted, fontSize: 10 },
      },
      visualMap: {
        show: false,
        min: 0,
        max: Math.max(1, max),
        inRange: { color: [...p.ramp] },
      },
      series: [
        {
          type: 'heatmap',
          data,
          itemStyle: { borderColor: p.surface, borderWidth: 2, borderRadius: 3 },
          emphasis: { itemStyle: { borderColor: p.ink, borderWidth: 1 } },
        },
      ],
    };
  });
}
