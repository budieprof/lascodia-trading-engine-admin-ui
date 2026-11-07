import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { BacktestRunDto, ExecutionQualityLogDto } from '@core/api/api.types';
import { ExecutionQualityService } from '@core/services/execution-quality.service';
import { BacktestsService } from '@core/services/backtests.service';
import { ThemeService } from '@core/theme/theme.service';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';

import type { ScriptDivergence, ScriptLiveClosedTrade } from '../api/scripting-api.types';
import { reportPalette } from '../report/report-charts';
import { formatDateTime, formatNumber } from '../report/report-format';
import { rSampleFromEngineTrades } from '../report/r-analysis';
import { parseEngineRun } from '../report/engine-run';
import { RollingRChartComponent } from '../report/rolling-r-chart.component';
import type { RPoint } from '../report/rolling-metrics';
import { ResearchApiService } from '../research/research-api.service';
import { tradeR } from './live.model';
import {
  buildOverlayOptions,
  buildSlippageOptions,
  cumulativeVsExpected,
  divergenceMarkers,
  expectationOf,
  overlayVerdict,
  rollingSlippage,
  stageTimeline,
  type Expectation,
} from './live-vs-backtest';
// Runs that are not the strategy's own evidence (parity reconciles, lab reproductions, invalidated runs) are skipped.
import { isEvidenceRun } from '@features/backtests/run-provenance';

/**
 * U08 (live) + U09 — a script strategy's paper and live trades against its backtest: cumulative R vs the backtest's
 * expectation band, rolling expectancy/Sharpe of the session's trades, the fills' rolling slippage, the path
 * backtest → walk-forward → paper → live, and divergence markers (BarRevised included) on the time axis.
 *
 * Reads only: the newest completed backtest of the strategy (its trades' R), the newest walk-forward, the strategy's
 * execution-quality rows. Nothing is estimated where a record is missing — the card says what is missing.
 */
@Component({
  selector: 'app-live-vs-backtest-panel',
  standalone: true,
  imports: [ChartCardComponent, RollingRChartComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="block" aria-labelledby="lvb-title" data-testid="live-vs-backtest">
      <h4 class="block-title" id="lvb-title">Live and paper vs the backtest</h4>
      @if (expectation(); as e) {
        <p class="hint">
          Expected = backtest #{{ e.backtestRunId }}'s mean of {{ num(e.meanR, 3) }} R per trade
          over {{ e.trades }} trades, times the trades taken; the bands are ±1σ and ±2σ of a sum of
          that many backtest trades. Session R is measured on the emulator's prices against each
          trade's stop.
        </p>
      } @else if (expectationNote(); as n) {
        <p class="hint">{{ n }}</p>
      }
      @if (verdict(); as v) {
        <p class="verdict" data-testid="lvb-verdict">{{ v }}</p>
      }
      <app-chart-card
        title="Cumulative R — expected vs realised"
        subtitle="Dotted red: divergences (BarRevised and the rest). Grey: research → paper → live milestones."
        [options]="overlay() ?? {}"
        [emptyMessage]="overlay() ? null : 'No paper or live trade with a stop has closed yet'"
        alt="Cumulative R of paper and live trades against the backtest expectation band over time"
        height="320px"
      />

      @if (milestones().length > 0) {
        <ol class="timeline" aria-label="Research to live path">
          @for (m of milestones(); track m.label) {
            <li [attr.data-stage]="m.stage">
              <span class="t-label">{{ m.label }}</span>
              <span class="muted small">{{ when(m.time) }} · {{ m.detail }}</span>
            </li>
          }
        </ol>
      }

      <app-rolling-r-chart
        title="Rolling expectancy and Sharpe — session trades (R)"
        [points]="sessionPoints()"
        [closed]="sessionClosed()"
        source="paper and live trades"
      />

      <app-chart-card
        title="Rolling slippage of the strategy's fills"
        [subtitle]="slippageSubtitle()"
        [options]="slippage() ?? {}"
        [emptyMessage]="slippage() ? null : slippageEmpty()"
        alt="Rolling median slippage in pips of the strategy's account fills over time"
        height="220px"
      />
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .block {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .block-title {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .hint,
      .verdict {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
        line-height: 1.5;
      }
      .verdict {
        color: var(--text-primary);
        font-size: var(--text-sm);
      }
      .timeline {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-wrap: wrap;
        gap: 6px 18px;
      }
      .timeline li {
        display: flex;
        flex-direction: column;
        border-left: 2px solid var(--border);
        padding-left: 8px;
      }
      .timeline li[data-stage='live'] {
        border-left-color: var(--accent);
      }
      .t-label {
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
      }
      .muted {
        color: var(--text-secondary);
      }
      .small {
        font-size: var(--text-xs);
      }
    `,
  ],
})
export class LiveVsBacktestPanelComponent {
  private readonly backtests = inject(BacktestsService);
  private readonly execQuality = inject(ExecutionQualityService);
  private readonly research = inject(ResearchApiService);
  private readonly theme = inject(ThemeService);

  readonly strategyId = input.required<number>();
  readonly trades = input<readonly ScriptLiveClosedTrade[]>([]);
  readonly divergences = input<readonly ScriptDivergence[]>([]);
  readonly lifecycleStage = input<string | null>(null);
  readonly lifecycleStageEnteredAt = input<string | null>(null);

  readonly backtest = signal<BacktestRunDto | null>(null);
  readonly expectation = signal<Expectation | null>(null);
  readonly expectationNote = signal<string | null>('Looking for the strategy’s newest backtest…');
  readonly walkForward = signal<{ id: number; completedAt: string | null } | null>(null);
  readonly fills = signal<ExecutionQualityLogDto[] | null>(null);
  readonly fillsError = signal<string | null>(null);

  private readonly palette = computed(() => reportPalette(this.theme.theme()));

  private readonly paper = computed(() =>
    cumulativeVsExpected(this.trades(), 'paper', this.expectation()),
  );
  private readonly live = computed(() =>
    cumulativeVsExpected(this.trades(), 'live', this.expectation()),
  );
  readonly milestones = computed(() => {
    const b = this.backtest();
    return stageTimeline({
      backtest: b
        ? { id: b.id, completedAt: b.completedAt, fromDate: b.fromDate, toDate: b.toDate }
        : null,
      walkForward: this.walkForward(),
      trades: this.trades(),
      lifecycleStage: this.lifecycleStage(),
      lifecycleStageEnteredAt: this.lifecycleStageEnteredAt(),
    });
  });
  readonly overlay = computed(() =>
    buildOverlayOptions(
      [
        { origin: 'paper', points: this.paper().points },
        { origin: 'live', points: this.live().points },
      ],
      divergenceMarkers(this.divergences()),
      this.milestones(),
      this.palette(),
    ),
  );
  readonly verdict = computed(() => {
    const live = this.live().points;
    const paper = this.paper().points;
    const main = live.length >= paper.length ? live : paper;
    const v = overlayVerdict(main);
    return v ? `${main === live ? 'Live' : 'Paper'}: ${v}` : null;
  });

  readonly sessionPoints = computed<RPoint[]>(() =>
    this.trades()
      .filter((t) => (t.origin === 'paper' || t.origin === 'live') && t.exitTimeMs !== null)
      .map((t) => ({ time: t.exitTimeMs!, r: tradeR(t) }))
      .filter((p): p is RPoint => p.r !== null)
      .sort((a, b) => a.time - b.time),
  );
  readonly sessionClosed = computed(
    () => this.trades().filter((t) => t.origin === 'paper' || t.origin === 'live').length,
  );

  readonly slippagePoints = computed(() => rollingSlippage(this.fills() ?? []));
  readonly slippage = computed(() => buildSlippageOptions(this.slippagePoints(), this.palette()));
  readonly slippageSubtitle = computed(() => {
    const n = this.fills()?.length ?? 0;
    return `Median of the last 20 account fills (${n} fill${n === 1 ? '' : 's'} recorded, newest 500). Paper fills have no slippage.`;
  });
  readonly slippageEmpty = computed(
    () =>
      this.fillsError() ??
      (this.fills() === null ? 'Loading fills…' : 'Fewer than six account fills recorded'),
  );

  constructor() {
    effect(() => {
      const id = this.strategyId();
      untracked(() => void this.load(id));
    });
  }

  private async load(id: number): Promise<void> {
    this.backtest.set(null);
    this.expectation.set(null);
    this.walkForward.set(null);
    this.fills.set(null);
    this.fillsError.set(null);
    await Promise.all([this.loadBacktest(id), this.loadWalkForward(id), this.loadFills(id)]);
  }

  private async loadBacktest(id: number): Promise<void> {
    try {
      const res = await firstValueFrom(
        this.backtests.list({
          currentPage: 1,
          itemCountPerPage: 10,
          filter: { strategyId: id, status: 'Completed', includeResultJson: true },
          sortBy: 'id',
          sortDirection: 'desc',
        }),
      );
      if (id !== this.strategyId()) return;
      const run = (res?.data?.data ?? []).find(
        (r) => isEvidenceRun(r),
      );
      if (!run) {
        this.expectationNote.set('No completed backtest of this strategy to compare with.');
        return;
      }
      this.backtest.set(run);
      const engine = parseEngineRun(run.resultJson);
      const sample = rSampleFromEngineTrades(engine?.trades ?? []);
      const e = expectationOf({
        backtestRunId: run.id,
        rValues: sample.values,
        fromDate: run.fromDate,
        toDate: run.toDate,
      });
      this.expectation.set(e);
      this.expectationNote.set(
        e ? null : `Backtest #${run.id} has no trade with a stop, so it has no R to expect.`,
      );
    } catch {
      if (id === this.strategyId())
        this.expectationNote.set('The strategy’s backtests could not be read.');
    }
  }

  private async loadWalkForward(id: number): Promise<void> {
    try {
      const res = await firstValueFrom(this.research.walkForwardRuns(id, 10));
      if (id !== this.strategyId()) return;
      const wf = (res?.data?.data ?? []).find((r) => String(r.status) === 'Completed');
      if (wf) this.walkForward.set({ id: wf.id, completedAt: wf.completedAt ?? null });
    } catch {
      /* the milestone is simply absent */
    }
  }

  private async loadFills(id: number): Promise<void> {
    try {
      const res = await firstValueFrom(
        this.execQuality.list({
          currentPage: 1,
          itemCountPerPage: 500,
          filter: { strategyId: id },
          sortBy: 'recordedAt',
          sortDirection: 'desc',
        }),
      );
      if (id !== this.strategyId()) return;
      this.fills.set(res?.data?.data ?? []);
    } catch {
      if (id === this.strategyId()) {
        this.fills.set([]);
        this.fillsError.set('The execution-quality log could not be read');
      }
    }
  }

  num(v: number | null, d = 2): string {
    return formatNumber(v, d);
  }
  when(ms: number): string {
    return formatDateTime(ms);
  }
}
