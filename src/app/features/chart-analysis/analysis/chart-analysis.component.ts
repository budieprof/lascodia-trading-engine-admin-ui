import { DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  model,
  output,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { firstValueFrom, merge } from 'rxjs';
import { debounceTime } from 'rxjs/operators';

import type { MarketAnalysisResultDto } from '@core/api/api.types';
import { UiCommandService } from '@core/assistant/ui-command.service';
import { RealtimeService } from '@core/realtime/realtime.service';

import type { ChartHostComponent, ChartMarker } from '../chart/chart-host.component';
import { ChartAlertsService } from '../alerts/chart-alerts.service';
import type { TicketPrefill } from '../trading/ticket-model';
import { WatchlistService } from '../watchlist/watchlist.service';
import { addSymbol, listSymbols, removeSymbol } from '../watchlist/watchlist.model';
import { analysisCommands, type AnalysisCommandHost } from './analysis-commands';
import { AnalysisLevelsPrimitive } from './analysis-levels-primitive';
import {
  analysisOutcome,
  analysisTimeframe,
  describeWatch,
  isLive,
  planLines,
  tradesOf,
  watchLines,
  watchMarkers,
  watchTimeframe,
} from './analysis-overlay';
import { ChartAnalysisService } from './chart-analysis.service';
import type {
  AnalysisRequestMode,
  ChartAnalysisMonitors,
  ChartMonitor,
} from './chart-analysis.types';
import {
  SCRIPT_INVALIDATION,
  SCRIPT_TRIGGER,
  WATCH_TEMPLATES,
  buildWatchScript,
  explainWatch,
  watchInputProblem,
  watchTemplate,
  type WatchTemplate,
} from './watch-script';

/** How often the watches are re-read while the chart is open (fires also arrive by push). */
const WATCH_REFRESH_MS = 60_000;

/** What an analysis request is called in the panel. */
const MODE_LABELS: Record<AnalysisRequestMode, string> = {
  spot: 'Analyse now',
  limitBuy: 'Buy on a pullback (limit)',
  limitSell: 'Sell on a rally (limit)',
  stopBuy: 'Buy a breakout (stop)',
  stopSell: 'Sell a breakdown (stop)',
};

/** The "Watch this" form. */
interface WatchForm {
  template: WatchTemplate['id'];
  level: number | null;
  calledOff: number | null;
  side: 'Buy' | 'Sell' | null;
  hours: number;
}

/**
 * LLM analysis on the main chart (SP-I5), in one place so the page only places it:
 * <ul>
 *   <li><b>Analyse</b>: a spot analysis (the patient TRADE NOW / WATCH / STAND ASIDE) or a directed one (a side and an
 *   order type) through the existing analysis endpoints. The chart never files a signal: a proposed trade opens the
 *   order ticket, where the operator decides.</li>
 *   <li>The analysis' <b>plan</b> — entry, stop ("the idea is wrong here") and target — drawn as its own labelled lines
 *   with the analysis id.</li>
 *   <li>The symbol's <b>watches</b> — analysis watches, hunter and Patient Trader watches, Structure Watches, the
 *   operator's own — with the prices they wait at and are called off at, and their fires, touches, call-offs and
 *   script steps as markers on the bars they happened in.</li>
 *   <li><b>Watch this</b>: a Structure Watch with a Pine condition, armed through the existing monitor path (the engine
 *   checks the script against the watch contract and its history before arming; a refusal says why).</li>
 * </ul>
 */
@Component({
  selector: 'app-chart-analysis',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, RouterLink],
  template: `
    @if (open()) {
      <section class="ca" role="region" aria-label="Analysis" data-testid="chart-analysis">
        <header class="ca-head">
          <strong>Analysis</strong>
          <span class="ca-sub">{{ symbol() }} · {{ timeframe() }}</span>
          <button
            type="button"
            class="ca-x"
            (click)="open.set(false)"
            aria-label="Close the analysis panel"
          >
            ×
          </button>
        </header>

        <div class="ca-run">
          <button
            type="button"
            class="primary"
            [disabled]="running() !== null"
            (click)="analyse('spot')"
            data-testid="analyse-spot"
            title="The AI reads the market and says: trade now, watch a level, or stand aside. One AI call."
          >
            {{ modeLabels.spot }}
          </button>
          <details class="ca-directed">
            <summary>Directed…</summary>
            @for (m of directedModes; track m) {
              <button type="button" [disabled]="running() !== null" (click)="analyse(m)">
                {{ modeLabels[m] }}
              </button>
            }
          </details>
        </div>
        @if (running(); as r) {
          <p class="muted" data-testid="analyse-running">
            {{ modeLabels[r] }} on {{ symbol() }} {{ timeframe() }}… an analysis takes up to a
            minute.
          </p>
        }
        @if (error(); as e) {
          <p class="refused">{{ e }}</p>
        }

        @if (result(); as r) {
          <div class="ca-result" data-testid="analysis-result">
            <div class="ca-row">
              <span
                class="badge"
                [class.trade]="outcomeClass() === 'trade'"
                [class.watch]="outcomeClass() === 'watch'"
                >{{ outcome() }}</span
              >
              <span class="muted">#{{ r.llmInvocationId }} · {{ ageText() }}</span>
              <a
                class="link"
                [routerLink]="['/conversations']"
                [queryParams]="{ conversation: r.llmInvocationId }"
                title="Read the whole analysis, ask about it, or file it as a signal"
                >Open</a
              >
            </div>
            @if (r.symbol.toUpperCase() !== symbol().toUpperCase()) {
              <p class="refused">This analysis is for {{ r.symbol }}, not {{ symbol() }}.</p>
            }
            @for (t of trades(); track t.index) {
              <div class="trade" [class.sell]="t.rec.action === 'Sell'">
                <div class="ca-row">
                  <strong>{{ t.rec.action }}</strong>
                  <span>entry {{ t.rec.entryPrice ?? 'at market' }}</span>
                  <span>stop {{ t.rec.stopLoss ?? '—' }}</span>
                  <span>target {{ t.rec.takeProfit ?? '—' }}</span>
                </div>
                <div class="ca-row">
                  <span class="muted"
                    >confidence {{ t.rec.confidence * 100 | number: '1.0-0' }}%</span
                  >
                  <button
                    type="button"
                    (click)="toTicket(t.rec)"
                    title="Open the order ticket with this side, stop and target — in paper, nothing is sent until you submit"
                  >
                    Open in ticket
                  </button>
                </div>
                @if (t.rec.rationale) {
                  <p class="why">{{ t.rec.rationale }}</p>
                }
              </div>
            }
            @for (rej of r.rejectedRecommendations ?? []; track $index) {
              <p class="muted">
                Not usable: {{ rej.recommendation.action }} —
                {{ rej.reasonDetail || rej.reasonCode }}
              </p>
            }
            @if (r.armedMonitorIds?.length) {
              <p class="muted">
                Armed
                {{
                  r.armedMonitorIds!.length === 1
                    ? 'a watch'
                    : r.armedMonitorIds!.length + ' watches'
                }}:
                @for (id of r.armedMonitorIds!; track id) {
                  <a [routerLink]="['/analysis-monitors']" [queryParams]="{ focus: id }"
                    >W{{ id }}</a
                  >
                  {{ ' ' }}
                }
              </p>
            }
            <details class="ca-text">
              <summary>What the AI wrote</summary>
              <p class="prose">{{ r.analysis }}</p>
            </details>
          </div>
        } @else if (running() === null && !error()) {
          <p class="muted">No analysis of {{ symbol() }} {{ timeframe() }} yet.</p>
        }

        <div class="ca-toggles">
          <label
            ><input type="checkbox" [checked]="showPlan()" (change)="showPlan.set(!showPlan())" />
            Plan on chart</label
          >
          <label
            ><input
              type="checkbox"
              [checked]="showWatches()"
              (change)="showWatches.set(!showWatches())"
            />
            Watches on chart</label
          >
        </div>

        <h4>Watches on {{ symbol() }}</h4>
        @if (watchError(); as e) {
          <p class="refused">{{ e }}</p>
        }
        @for (m of liveWatches(); track m.id) {
          <div class="watch" data-testid="chart-watch">
            <div class="ca-row">
              <a [routerLink]="['/analysis-monitors']" [queryParams]="{ focus: m.id }"
                >W{{ m.id }}</a
              >
              <span>{{ describe(m) }}</span>
            </div>
            <p class="why">{{ m.intentText }}</p>
            @if (m.scriptLastReading) {
              <p class="muted">Script: {{ m.scriptLastReading }}</p>
            }
          </div>
        } @empty {
          <p class="muted">No live watches on {{ symbol() }}.</p>
        }
        @if (endedCount() > 0) {
          <p class="muted">
            {{ endedCount() }} ended in the chart's window (their fires are marked on the bars).
          </p>
        }
        @if (monitors()?.monitorsTruncated || monitors()?.eventsTruncated) {
          <p class="muted">Showing the newest watches and events only.</p>
        }

        <details class="ca-watch" [open]="watchOpen()" (toggle)="onWatchToggle($event)">
          <summary data-testid="watch-this">Watch this…</summary>
          <p class="muted">
            A Structure Watch: a small Pine script follows the setup candle by candle and tells you
            when it is ready. It never trades. Runs on {{ watchTf()
            }}{{ watchTf() !== timeframe() ? ' (the nearest timeframe watches use)' : '' }}.
          </p>
          <label class="ca-field"
            ><span>Wait for</span>
            <select [value]="form().template" (change)="setTemplate($any($event.target).value)">
              @for (t of templates; track t.id) {
                <option [value]="t.id">{{ t.label }}</option>
              }
            </select>
          </label>
          <label class="ca-field"
            ><span>Level</span>
            <input
              type="number"
              [step]="step()"
              [value]="form().level ?? ''"
              (input)="patchForm({ level: num($any($event.target).value) })"
              data-testid="watch-level"
          /></label>
          <label class="ca-field"
            ><span>Called off at</span>
            <input
              type="number"
              [step]="step()"
              placeholder="optional"
              [value]="form().calledOff ?? ''"
              (input)="patchForm({ calledOff: num($any($event.target).value) })"
          /></label>
          <label class="ca-field"
            ><span>Trade it sets up</span>
            <select
              [value]="form().side ?? ''"
              (change)="patchForm({ side: $any($event.target).value || null })"
            >
              <option value="">None — just tell me</option>
              <option value="Buy">Buy</option>
              <option value="Sell">Sell</option>
            </select>
          </label>
          <label class="ca-field"
            ><span>Keep watching</span>
            <select
              [value]="form().hours"
              (change)="patchForm({ hours: +$any($event.target).value })"
            >
              @for (h of hourChoices; track h) {
                <option [value]="h">{{ h }} hours</option>
              }
            </select>
          </label>
          @if (result(); as r) {
            @if (trades().length) {
              <div class="ca-row">
                <span class="muted">Use the analysis' levels:</span>
                @for (t of trades(); track t.index) {
                  @if (t.rec.entryPrice) {
                    <button type="button" (click)="patchForm({ level: t.rec.entryPrice })">
                      entry
                    </button>
                  }
                  @if (t.rec.stopLoss) {
                    <button type="button" (click)="patchForm({ calledOff: t.rec.stopLoss })">
                      stop as called off
                    </button>
                  }
                }
              </div>
            }
          }
          @if (formProblem(); as p) {
            <p class="refused">{{ p }}</p>
          } @else {
            <p class="explain">
              {{ formExplain() }} When it is ready you get a notification (bell and push).
            </p>
          }
          <details>
            <summary>Show the script</summary>
            <pre class="script">{{ script() }}</pre>
          </details>
          <div class="ca-row">
            <button
              type="button"
              class="primary"
              [disabled]="!!formProblem() || arming()"
              (click)="armWatch()"
              data-testid="arm-watch"
            >
              {{ arming() ? 'Arming…' : 'Arm the watch' }}
            </button>
          </div>
          @if (watchResult(); as w) {
            <p [class.refused]="!w.ok" data-testid="watch-result">{{ w.message }}</p>
          }
        </details>
      </section>
    }
  `,
  styles: [
    `
      :host {
        display: contents;
      }
      .ca {
        position: absolute;
        top: 8px;
        left: 56px;
        z-index: 20;
        width: 320px;
        max-height: calc(100% - 16px);
        overflow-y: auto;
        background: var(--surface-1, #1e222d);
        color: var(--text-1, #d1d4dc);
        border: 1px solid var(--border-1, #363a45);
        border-radius: 6px;
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
        padding: 8px 10px;
        font-size: 12px;
      }
      .ca-head {
        display: flex;
        align-items: baseline;
        gap: 6px;
        margin-bottom: 6px;
      }
      .ca-sub {
        opacity: 0.7;
        flex: 1;
      }
      .ca-x {
        background: none;
        border: 0;
        color: inherit;
        font-size: 16px;
        cursor: pointer;
      }
      .ca-run {
        display: flex;
        gap: 6px;
        align-items: flex-start;
        flex-wrap: wrap;
      }
      .ca-directed {
        flex: 1;
      }
      .ca-directed button {
        display: block;
        width: 100%;
        margin-top: 3px;
        text-align: left;
      }
      button {
        padding: 3px 8px;
        border-radius: 4px;
        border: 1px solid var(--border-1, #363a45);
        background: transparent;
        color: inherit;
        cursor: pointer;
        font-size: 12px;
      }
      button.primary {
        background: #2962ff;
        border-color: #2962ff;
        color: #fff;
      }
      button:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .ca-row {
        display: flex;
        gap: 6px;
        align-items: center;
        flex-wrap: wrap;
        margin: 3px 0;
      }
      .badge {
        padding: 1px 6px;
        border-radius: 3px;
        font-weight: 600;
        background: #455a64;
        color: #fff;
      }
      .badge.trade {
        background: #2962ff;
      }
      .badge.watch {
        background: #f59e0b;
        color: #111;
      }
      .trade {
        border-left: 3px solid #2962ff;
        padding-left: 6px;
        margin: 6px 0;
      }
      .trade.sell {
        border-left-color: #ab47bc;
      }
      .why,
      .prose {
        margin: 2px 0;
        white-space: pre-wrap;
        opacity: 0.9;
      }
      .prose {
        max-height: 240px;
        overflow-y: auto;
      }
      .muted {
        opacity: 0.75;
        margin: 3px 0;
      }
      .refused {
        color: #ef5350;
        margin: 3px 0;
      }
      .explain {
        margin: 4px 0;
      }
      .link,
      a {
        color: #5b9cf6;
      }
      .ca-toggles {
        display: flex;
        gap: 10px;
        margin: 8px 0 4px;
      }
      h4 {
        margin: 8px 0 4px;
        font-size: 12px;
      }
      .watch {
        border-top: 1px solid var(--border-1, #363a45);
        padding-top: 3px;
      }
      .ca-watch {
        margin-top: 8px;
        border-top: 1px solid var(--border-1, #363a45);
        padding-top: 6px;
      }
      .ca-field {
        display: flex;
        align-items: center;
        gap: 6px;
        margin: 4px 0;
      }
      .ca-field > span {
        width: 92px;
        opacity: 0.8;
      }
      .ca-field select,
      .ca-field input {
        flex: 1;
        min-width: 0;
      }
      .script {
        max-height: 200px;
        overflow: auto;
        font-size: 11px;
        background: rgba(0, 0, 0, 0.25);
        padding: 4px;
      }
    `,
  ],
})
export class ChartAnalysisComponent {
  private readonly service = inject(ChartAnalysisService);
  private readonly realtime = inject(RealtimeService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly alerts = inject(ChartAlertsService);
  private readonly watchlists = inject(WatchlistService);

  /** The chart host the overlay draws on (the page's primary chart). */
  readonly host = input<ChartHostComponent | undefined>(undefined);
  readonly symbol = input.required<string>();
  /** The chart's resolution (TradingView form: "60", "240", "1D"…). */
  readonly resolution = input.required<string>();
  readonly precision = input<number>(5);
  /** The newest price, the default level for "Watch this". */
  readonly lastPrice = input<number | null>(null);
  /** UTC ms of the oldest loaded bar: the start of the window watches' events are read for. */
  readonly windowFrom = input<number | null>(null);
  /** The panel is open (the overlay stays drawn when it is closed). */
  readonly open = model(false);

  /** Fire / touch / call-off / step markers for the page's marker layer. */
  readonly markersChange = output<ChartMarker[]>();
  /** A proposed trade the operator chose to open in the order ticket. */
  readonly ticket = output<TicketPrefill>();

  protected readonly modeLabels = MODE_LABELS;
  protected readonly directedModes: AnalysisRequestMode[] = [
    'limitBuy',
    'limitSell',
    'stopBuy',
    'stopSell',
  ];
  protected readonly templates = WATCH_TEMPLATES;
  protected readonly hourChoices = [4, 12, 24, 48];

  readonly timeframe = computed(() => analysisTimeframe(this.resolution()));
  readonly watchTf = computed(() => watchTimeframe(this.resolution()));

  readonly result = signal<MarketAnalysisResultDto | null>(null);
  readonly running = signal<AnalysisRequestMode | null>(null);
  readonly error = signal<string | null>(null);
  readonly showPlan = signal(true);
  readonly showWatches = signal(true);
  readonly monitors = signal<ChartAnalysisMonitors | null>(null);
  readonly watchError = signal<string | null>(null);

  protected readonly outcome = computed(() => {
    const r = this.result();
    return r ? analysisOutcome(r) : null;
  });
  protected readonly outcomeClass = computed(() =>
    this.outcome() === 'TRADE NOW' ? 'trade' : this.outcome() === 'WATCH' ? 'watch' : '',
  );
  protected readonly trades = computed(() => {
    const r = this.result();
    return r ? tradesOf(r) : [];
  });
  protected readonly liveWatches = computed(() => (this.monitors()?.monitors ?? []).filter(isLive));
  protected readonly endedCount = computed(
    () => (this.monitors()?.monitors ?? []).filter((m) => !isLive(m)).length,
  );

  private readonly lines = new AnalysisLevelsPrimitive(() => this.precision());
  private analysisSeq = 0;
  private monitorSeq = 0;
  private pairKey: string | null = null;
  private latestAskedFor: string | null = null;

  // ── Watch this ────────────────────────────────────────────────────────────
  readonly watchOpen = signal(false);
  readonly form = signal<WatchForm>({
    template: 'closeAbove',
    level: null,
    calledOff: null,
    side: null,
    hours: 24,
  });
  readonly arming = signal(false);
  readonly watchResult = signal<{ ok: boolean; message: string } | null>(null);
  protected readonly step = computed(() => Math.pow(10, -Math.max(0, this.precision())));
  private readonly watchInput = computed(() => ({
    template: this.form().template,
    level: this.form().level ?? NaN,
    calledOff: this.form().calledOff,
    precision: this.precision(),
  }));
  protected readonly formProblem = computed(() => watchInputProblem(this.watchInput()));
  protected readonly formExplain = computed(() => explainWatch(this.watchInput()));
  protected readonly script = computed(() =>
    this.formProblem() ? '' : buildWatchScript(this.watchInput()),
  );

  constructor() {
    // SP-I8: the assistant's chart tools, for as long as the chart is mounted (the browser registry is the gate).
    inject(UiCommandService).register(analysisCommands(this.commandHost()), this.destroyRef);

    effect((onCleanup) => {
      const host = this.host();
      if (!host) return;
      onCleanup(host.attachPricePrimitive(this.lines));
    });

    effect(() => {
      const r = this.result();
      const plan =
        this.showPlan() && r && r.symbol.toUpperCase() === this.symbol().toUpperCase()
          ? planLines(r)
          : [];
      const watches = this.showWatches()
        ? watchLines(this.monitors(), r?.llmInvocationId ?? null)
        : [];
      this.lines.setLines([...plan, ...watches]);
    });

    effect(() => this.markersChange.emit(this.showWatches() ? watchMarkers(this.monitors()) : []));

    // A new symbol or timeframe: the analysis on screen belongs to the old one. Opening the panel shows the newest
    // stored analysis of the pair (no AI call) — asked once per pair, so a pair never analysed is not asked again
    // every time the panel opens.
    effect(() => {
      const key = `${this.symbol()}|${this.timeframe()}`;
      const open = this.open();
      untracked(() => {
        if (key !== this.pairKey) {
          this.pairKey = key;
          this.latestAskedFor = null;
          this.analysisSeq++;
          this.result.set(null);
          this.running.set(null);
          this.error.set(null);
          this.watchResult.set(null);
          this.form.update((f) => ({ ...f, level: null, calledOff: null }));
        }
        if (
          open &&
          this.result() === null &&
          this.running() === null &&
          this.latestAskedFor !== key
        ) {
          this.latestAskedFor = key;
          this.loadLatest();
        }
      });
    });

    // The watches: on symbol change, on window change, every minute, and when the engine says a watch moved.
    effect(() => {
      const show = this.showWatches();
      const symbol = this.symbol();
      this.windowFrom();
      if (!show || !symbol) {
        untracked(() => this.monitors.set(null));
        return;
      }
      untracked(() => this.loadMonitors());
    });
    const timer = setInterval(() => {
      if (this.showWatches()) this.loadMonitors();
    }, WATCH_REFRESH_MS);
    this.destroyRef.onDestroy(() => clearInterval(timer));
    merge(
      this.realtime.on<{ symbol?: string }>('analysisMonitorFired'),
      this.realtime.on<{ symbol?: string }>('analysisMonitorInvalidated'),
      this.realtime.on<{ symbol?: string }>('analysisMonitorChanged'),
    )
      .pipe(debounceTime(1_500), takeUntilDestroyed())
      .subscribe((p) => {
        const sym = typeof p?.symbol === 'string' ? p.symbol.toUpperCase() : null;
        if (this.showWatches() && (sym === null || sym === this.symbol().toUpperCase()))
          this.loadMonitors();
      });

    // "Watch this" opens on the newest price.
    effect(() => {
      if (!this.watchOpen()) return;
      untracked(() => {
        if (this.form().level === null && this.lastPrice() !== null)
          this.patchForm({ level: roundTo(this.lastPrice()!, this.precision()) });
      });
    });
  }

  /** Run an analysis now (one AI call). Returns what happened, for the assistant's `chart.analyse`. */
  analyse(
    mode: AnalysisRequestMode,
  ): Promise<{ ok: boolean; message: string; result?: MarketAnalysisResultDto }> {
    if (this.running() !== null)
      return Promise.resolve({
        ok: false,
        message: 'An analysis is already running on this chart.',
      });
    const seq = ++this.analysisSeq;
    const symbol = this.symbol();
    const tf = this.timeframe();
    this.running.set(mode);
    this.error.set(null);
    return new Promise((resolve) => {
      this.service
        .analyse(symbol, tf, mode)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (res) => {
            if (seq !== this.analysisSeq)
              return resolve({ ok: false, message: 'The chart moved to another symbol.' });
            this.running.set(null);
            if (res?.status && res.data) {
              this.result.set(res.data);
              this.loadMonitors();
              resolve({
                ok: true,
                message: `${MODE_LABELS[mode]}: ${analysisOutcome(res.data)}`,
                result: res.data,
              });
            } else {
              const msg = res?.message || 'The analysis came back without a usable answer.';
              this.error.set(msg);
              resolve({ ok: false, message: msg });
            }
          },
          error: (err: unknown) => {
            if (seq !== this.analysisSeq)
              return resolve({ ok: false, message: 'The chart moved to another symbol.' });
            this.running.set(null);
            const msg = errorText(err, 'The analysis failed. Is the engine reachable?');
            this.error.set(msg);
            resolve({ ok: false, message: msg });
          },
        });
    });
  }

  /** Open the order ticket with a proposed trade (paper, at market; nothing is sent until the operator submits). */
  toTicket(rec: {
    action: string;
    entryPrice: number | null;
    stopLoss: number | null;
    takeProfit: number | null;
  }): void {
    if (rec.action !== 'Buy' && rec.action !== 'Sell') return;
    this.ticket.emit({
      direction: rec.action,
      entry: rec.entryPrice ?? null,
      stop: rec.stopLoss ?? null,
      target: rec.takeProfit ?? null,
    });
  }

  protected describe(m: ChartMonitor): string {
    return describeWatch(m);
  }

  protected ageText(): string {
    const r = this.result();
    if (!r) return '';
    const mins = Math.max(0, Math.round((Date.now() - Date.parse(r.completedAt)) / 60_000));
    if (!Number.isFinite(mins)) return '';
    if (mins < 1) return 'just now';
    if (mins < 120) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
  }

  protected num(v: string): number | null {
    const n = Number(String(v).trim());
    return String(v).trim() === '' || !Number.isFinite(n) ? null : n;
  }

  patchForm(patch: Partial<WatchForm>): void {
    this.form.update((f) => ({ ...f, ...patch }));
    this.watchResult.set(null);
  }

  protected setTemplate(id: string): void {
    const t = watchTemplate(id);
    if (!t) return;
    this.patchForm({ template: t.id, side: t.side ?? this.form().side, calledOff: null });
  }

  protected onWatchToggle(ev: Event): void {
    this.watchOpen.set((ev.target as HTMLDetailsElement).open);
  }

  /** Arm the Structure Watch through the existing monitor path. The engine checks the script before arming. */
  armWatch(): Promise<{ ok: boolean; message: string }> {
    const problem = this.formProblem();
    if (problem) return Promise.resolve({ ok: false, message: problem });
    const f = this.form();
    const t = watchTemplate(f.template)!;
    const symbol = this.symbol();
    const explain = this.formExplain();
    this.arming.set(true);
    this.watchResult.set(null);
    return new Promise((resolve) => {
      this.service
        .createStructureWatch({
          symbol,
          timeframe: this.watchTf(),
          subjectKind: 'Symbol',
          subjectRef: symbol,
          intentText: `${t.label} ${roundTo(f.level!, this.precision())} — ${explain}`,
          triggerSpecJson: JSON.stringify(SCRIPT_TRIGGER),
          invalidationSpecJson: JSON.stringify(SCRIPT_INVALIDATION),
          actionSpecJson: JSON.stringify({ steps: [{ type: 'notify' }] }),
          deliverTo: ['bell', 'push'],
          expiresInHours: f.hours,
          maxActionTier: 0,
          scriptSource: this.script(),
          expectStepNow: 0,
          plannedDirection: f.side,
          origin: 'operator',
        })
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (res) => {
            this.arming.set(false);
            const out =
              res?.status && res.data
                ? {
                    ok: true,
                    message:
                      `Armed W${res.data.id}: ${t.label.toLowerCase()} on ${symbol} ${this.watchTf()}.` +
                      // The create response says when arming changed what was asked (engine ArmingNote).
                      ((res.data as { armingNote?: string | null }).armingNote
                        ? ` ${(res.data as { armingNote?: string | null }).armingNote}`
                        : ''),
                  }
                : { ok: false, message: res?.message || 'The engine did not arm the watch.' };
            this.watchResult.set(out);
            if (out.ok) this.loadMonitors();
            resolve(out);
          },
          error: (err: unknown) => {
            this.arming.set(false);
            const out = { ok: false, message: errorText(err, 'The engine did not answer.') };
            this.watchResult.set(out);
            resolve(out);
          },
        });
    });
  }

  /** What the assistant's chart tools act through: the chart, the existing alert and watchlist services, this panel. */
  private commandHost(): AnalysisCommandHost {
    return {
      symbol: () => this.symbol(),
      resolution: () => this.resolution(),
      precision: () => this.precision(),
      lastPrice: () => this.lastPrice(),
      valueRows: () => this.host()?.exportRows() ?? null,
      listAlerts: async () => {
        const res = await firstValueFrom(this.service.alerts());
        if (!res?.status) throw new Error(res?.message || 'The alerts could not be read.');
        return res.data ?? [];
      },
      createAlert: async (input) => {
        const res = await firstValueFrom(this.alerts.create(input));
        return res?.status && res.data
          ? { ok: true, message: res.message || 'Created.', alert: res.data }
          : { ok: false, message: res?.message || 'The engine did not create the alert.' };
      },
      deleteAlert: async (id) => {
        const res = await firstValueFrom(this.alerts.delete(id));
        return res?.status
          ? { ok: true, message: `Deleted alert ${id}.` }
          : { ok: false, message: res?.message || `Alert ${id} was not deleted.` };
      },
      watchlist: async () => {
        if (!this.watchlists.loaded()) await this.watchlists.load();
        const active = this.watchlists.active();
        if (!active)
          return this.watchlists.error()
            ? null
            : { name: 'Watchlist', symbols: [], otherLists: [] };
        return {
          name: active.name,
          symbols: listSymbols(active),
          otherLists: this.watchlists
            .lists()
            .filter((l) => l.id !== active.id)
            .map((l) => l.name),
        };
      },
      addToWatchlist: async (symbol) => {
        if (!/^[A-Z0-9._-]{2,20}$/.test(symbol))
          return { ok: false, message: `"${symbol}" is not a symbol.` };
        // The engine must know the symbol: a typo would sit in the list as a row with no prices.
        const quotes = await this.watchlists.quotes([symbol]).catch(() => []);
        if (!quotes.some((q) => q.symbol.toUpperCase() === symbol))
          return { ok: false, message: `The engine has no prices for ${symbol}; not added.` };
        if (!this.watchlists.loaded()) await this.watchlists.load();
        const active = this.watchlists.active();
        if (!active) return { ok: false, message: 'There is no watchlist to add to.' };
        if (listSymbols(active).includes(symbol))
          return { ok: true, message: `${symbol} is already on ${active.name}.` };
        this.watchlists.update(addSymbol(active, symbol));
        this.watchlists.flush();
        return { ok: true, message: `Added ${symbol} to ${active.name}.` };
      },
      removeFromWatchlist: async (symbol) => {
        if (!this.watchlists.loaded()) await this.watchlists.load();
        const active = this.watchlists.active();
        if (!active || !listSymbols(active).includes(symbol))
          return { ok: false, message: `${symbol} is not on the active watchlist.` };
        this.watchlists.update(removeSymbol(active, symbol));
        this.watchlists.flush();
        return { ok: true, message: `Removed ${symbol} from ${active.name}.` };
      },
      analyse: (mode) => {
        this.open.set(true);
        return this.analyse(mode);
      },
      proposeTrade: (prefill) => this.ticket.emit(prefill),
    };
  }

  private loadLatest(): void {
    const seq = this.analysisSeq;
    this.service
      .latest(this.symbol(), this.timeframe())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          if (seq !== this.analysisSeq || this.result() !== null) return;
          // -14: the pair was never analysed on this timeframe — the panel says so.
          if (res?.status && res.data) this.result.set(res.data);
        },
        error: () => undefined,
      });
  }

  loadMonitors(): void {
    const seq = ++this.monitorSeq;
    const symbol = this.symbol();
    if (!symbol) return;
    this.service
      .monitors(symbol, this.windowFrom(), null)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          if (seq !== this.monitorSeq) return;
          if (res?.status && res.data) {
            this.monitors.set(res.data);
            this.watchError.set(null);
          } else this.watchError.set(res?.message || 'The watches could not be read.');
        },
        error: () => {
          if (seq === this.monitorSeq)
            this.watchError.set('The watches could not be read: the engine did not answer.');
        },
      });
  }
}

function roundTo(v: number, precision: number): number {
  const f = Math.pow(10, Math.max(0, precision));
  return Math.round(v * f) / f;
}

function errorText(err: unknown, fallback: string): string {
  const e = err as { error?: { message?: string }; message?: string } | null;
  return e?.error?.message || e?.message || fallback;
}
