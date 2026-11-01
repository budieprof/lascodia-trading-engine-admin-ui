import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { catchError, of } from 'rxjs';

import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';

import { RiskApiService } from '../risk-api.service';
import { forecastLabel, forecastTone, formatMoney, formatNumber, varHistoryOption } from '../risk.logic';
import type { MarginForecastResponse, PortfolioRiskOverview, PortfolioRiskSeries, PortfolioRiskSnapshot } from '../risk.types';

type Range = '1d' | '7d' | '30d' | '90d';
const RANGE_MS: Record<Range, number> = { '1d': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000, '90d': 90 * 86_400_000 };

/** VaR / CVaR tiles, the VaR history chart, the margin forecast and every account's latest line. */
@Component({
  selector: 'app-risk-overview',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, ChartCardComponent],
  styleUrl: '../risk.scss',
  template: `
    @if (snapshot(); as s) {
      <div class="tiles" role="list" aria-label="Value at risk">
        <div class="tile" role="listitem"><div class="k">VaR 95 % (1 day)</div><div class="v">{{ money(s.vaR95, s.currency) }}</div>
          <div class="small muted">{{ s.vaR95Pct !== null ? num(s.vaR95Pct) + ' % of equity' : '—' }}{{ limitText() }}</div></div>
        <div class="tile" role="listitem"><div class="k">VaR 99 %</div><div class="v">{{ money(s.vaR99, s.currency) }}</div></div>
        <div class="tile" role="listitem"><div class="k">CVaR 95 % (expected shortfall)</div><div class="v">{{ money(s.cVaR95, s.currency) }}</div></div>
        <div class="tile" role="listitem"><div class="k">CVaR 99 %</div><div class="v">{{ money(s.cVaR99, s.currency) }}</div></div>
        <div class="tile" role="listitem"><div class="k">Stressed VaR (worst scenario)</div><div class="v">{{ money(s.stressedVaR, s.currency) }}</div></div>
        <div class="tile" role="listitem"><div class="k">Monte Carlo VaR 95 %</div><div class="v">{{ money(s.monteCarloVaR95, s.currency) }}</div></div>
        <div class="tile" role="listitem"><div class="k">EVT VaR 99 % (fat tail)</div><div class="v">{{ money(s.evtVaR99, s.currency) }}</div></div>
        <div class="tile" role="listitem"><div class="k">Concentration (Herfindahl)</div><div class="v">{{ num(s.correlationConcentration, 3) }}</div>
          <div class="small muted">{{ s.openPositionCount }} open · gross {{ money(s.grossExposure, s.currency) }}</div></div>
      </div>
      <p class="small muted">
        {{ s.scope === 'Tenant' ? 'Organisation book' : 'Account' }} snapshot of {{ s.computedAtUtc | date: 'd MMM yyyy, HH:mm' }} ·
        {{ s.returnWindowDays }}-day return window · status <strong>{{ s.status }}</strong>
        @if (s.status === 'MissingHistory') { — positions are open but there are not enough daily candles: the VaR gate is blind for this book. }
      </p>
    } @else if (!loading()) {
      <section class="card"><p class="pad muted">No snapshot is stored for this {{ accountId() === null ? 'organisation book' : 'account' }} yet. The Controls tab can take one now.</p></section>
    }

    <div class="split">
      <div>
        <div class="toolbar" role="group" aria-label="History range">
          @for (r of ranges; track r) {
            <button type="button" class="btn btn-sm" [class.btn-primary]="range() === r" [class.btn-secondary]="range() !== r" (click)="range.set(r)">{{ r }}</button>
          }
          <span class="small muted">{{ series()?.storedPoints ?? 0 }} stored point(s){{ (series()?.storedPoints ?? 0) > (series()?.points?.length ?? 0) ? ', each bucket keeps its highest VaR 95 %' : '' }}</span>
        </div>
        <app-chart-card
          title="VaR history"
          subtitle="One-day VaR / CVaR at 95 % and 99 %, and the worst stress scenario."
          height="300px"
          [loading]="seriesLoading()"
          [options]="chart()"
          [emptyMessage]="(series()?.points?.length ?? 0) === 0 ? 'No history in this range yet.' : null"
        />
      </div>

      <section class="card" aria-labelledby="mf-title">
        <header class="card-head"><h3 id="mf-title">Margin and stop-out forecast</h3></header>
        @if (accountId() === null) {
          <p class="pad small muted">Pick an account: the forecast reads that account's broker margin and stop-out level.
            @if (snapshot()?.portfolioSigma1d; as sd) { The organisation book's one-day σ is {{ money(sd, 'USD') }}. }</p>
        } @else if (forecast(); as f) {
          <div class="pad">
            <p><span [class]="'chip ' + tone(f.forecast.status)">{{ label(f.forecast.status) }}</span></p>
            <dl class="small">
              <dt>Margin level</dt><dd>{{ f.forecast.marginLevelPct !== null ? num(f.forecast.marginLevelPct, 0) + ' %' : '—' }} ({{ f.forecast.marginUsedSource }} margin {{ money(f.forecast.marginUsed, f.forecast.currency) }})</dd>
              <dt>Stop-out at</dt><dd>{{ f.forecast.stopOutLevel }}{{ f.forecast.stopOutMode === 'Money' ? ' ' + f.forecast.currency : ' %' }} → equity {{ money(f.forecast.equityAtStopOut, f.forecast.currency) }}</dd>
              <dt>Loss to stop-out</dt><dd>{{ money(f.forecast.lossToStopOut, f.forecast.currency) }} = {{ num(f.forecast.stopOutSigma1d) }} σ (1 day) · {{ num(f.forecast.stopOutSigma1h) }} σ (1 hour)</dd>
              <dt>Chance of touching it</dt><dd>{{ pct(f.forecast.stopOutProbability1h) }} within 1 h · {{ pct(f.forecast.stopOutProbability1d) }} within 1 day</dd>
              <dt>Days to stop-out</dt><dd>{{ num(f.forecast.daysToStopOut, 1) }} at {{ f.forecast.adverseDriftSigmaPerDay }} σ adverse drift per day</dd>
              <dt>Loss to margin call</dt><dd>{{ money(f.forecast.lossToMarginCall, f.forecast.currency) }}</dd>
            </dl>
            @if (f.forecast.note) { <p class="small muted">{{ f.forecast.note }}</p> }
          </div>
          @if (f.forecast.symbols.length) {
            <div class="table-wrap">
              <table class="grid">
                <caption class="sr-only">Move of one symbol alone that reaches the stop-out</caption>
                <thead><tr><th>Symbol</th><th class="num">Net</th><th>Hurts if</th><th class="num">Move to stop-out</th><th class="num">σ</th></tr></thead>
                <tbody>
                  @for (s of f.forecast.symbols; track s.symbol) {
                    <tr><td>{{ s.symbol }}</td><td class="num">{{ money(s.netNotional, f.forecast.currency) }}</td><td>{{ s.adverseDirection }}</td>
                      <td class="num">{{ s.pctMoveToStopOut !== null ? num(s.pctMoveToStopOut) + ' %' : '—' }}</td><td class="num">{{ num(s.sigmaMoveToStopOut, 1) }}</td></tr>
                  }
                </tbody>
              </table>
            </div>
          }
        } @else if (forecastError()) {
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ forecastError() }}</p>
        } @else {
          <p class="pad small muted">Loading…</p>
        }
      </section>
    </div>

    <section class="card" aria-labelledby="acc-title">
      <header class="card-head"><h3 id="acc-title">Accounts</h3></header>
      <div class="table-wrap">
        <table class="grid">
          <thead><tr><th>Account</th><th class="num">Equity</th><th class="num">VaR 95 %</th><th class="num">% equity</th><th class="num">Limit</th><th class="num">Stressed VaR</th><th class="num">Stop-out σ</th><th class="num">Open</th><th>Snapshot</th></tr></thead>
          <tbody>
            @for (a of overview()?.accounts ?? []; track a.tradingAccountId) {
              <tr class="clickable" [class.selected]="a.tradingAccountId === accountId()" (click)="selectAccount.emit(a.tradingAccountId)" tabindex="0" (keydown.enter)="selectAccount.emit(a.tradingAccountId)">
                <td>{{ a.accountName || a.accountId }} <span class="small muted">{{ a.accountId }}{{ a.isPaper ? ' · paper' : '' }}</span></td>
                <td class="num">{{ money(a.latest?.equity, a.currency) }}</td>
                <td class="num">{{ money(a.latest?.vaR95, a.currency) }}</td>
                <td class="num" [class.neg]="(a.latest?.vaR95Pct ?? 0) > (a.maxVaR95Pct ?? 1e9)">{{ a.latest?.vaR95Pct != null ? num(a.latest!.vaR95Pct) + ' %' : '—' }}</td>
                <td class="num">{{ a.maxVaR95Pct != null ? a.maxVaR95Pct + ' %' : '—' }}</td>
                <td class="num">{{ money(a.latest?.stressedVaR, a.currency) }}</td>
                <td class="num">{{ num(a.latest?.stopOutSigma1d, 1) }}</td>
                <td class="num">{{ a.latest?.openPositionCount ?? '—' }}</td>
                <td class="small">{{ a.ageSeconds !== null ? age(a.ageSeconds) : 'none yet' }}</td>
              </tr>
            } @empty {
              <tr><td colspan="9" class="muted">No active trading accounts in this organisation.</td></tr>
            }
          </tbody>
        </table>
      </div>
    </section>
  `,
})
export class RiskOverviewComponent {
  private readonly api = inject(RiskApiService);
  private readonly destroyRef = inject(DestroyRef);

  readonly overview = input<PortfolioRiskOverview | null>(null);
  readonly loading = input(false);
  readonly accountId = input<number | null>(null);
  readonly selectAccount = output<number>();

  protected readonly ranges: Range[] = ['1d', '7d', '30d', '90d'];
  readonly range = signal<Range>('7d');
  readonly series = signal<PortfolioRiskSeries | null>(null);
  readonly seriesLoading = signal(false);
  readonly forecast = signal<MarginForecastResponse | null>(null);
  readonly forecastError = signal<string | null>(null);

  readonly snapshot = computed<PortfolioRiskSnapshot | null>(() => {
    const o = this.overview();
    if (!o) return null;
    const id = this.accountId();
    return id === null ? o.book : (o.accounts.find((a) => a.tradingAccountId === id)?.latest ?? null);
  });
  readonly limitText = computed(() => {
    const id = this.accountId();
    const row = id === null ? null : this.overview()?.accounts.find((a) => a.tradingAccountId === id);
    return row?.maxVaR95Pct != null ? ` (limit ${row.maxVaR95Pct} %)` : '';
  });
  readonly chart = computed(() => varHistoryOption(this.series()?.points ?? [], this.series()?.currency ?? 'USD'));

  constructor() {
    effect(() => {
      const id = this.accountId();
      const r = this.range();
      untracked(() => this.loadSeries(id, r));
    });
    effect(() => {
      const id = this.accountId();
      untracked(() => this.loadForecast(id));
    });
  }

  private loadSeries(id: number | null, r: Range): void {
    this.seriesLoading.set(true);
    const from = new Date(Date.now() - RANGE_MS[r]).toISOString();
    const sub = this.api
      .series(id, from)
      .pipe(catchError(() => of(null)))
      .subscribe((s) => {
        this.series.set(s);
        this.seriesLoading.set(false);
      });
    this.destroyRef.onDestroy(() => sub.unsubscribe());
  }

  private loadForecast(id: number | null): void {
    this.forecast.set(null);
    this.forecastError.set(null);
    if (id === null) return;
    const sub = this.api.marginForecast(id).subscribe({
      next: (f) => this.forecast.set(f),
      error: () => this.forecastError.set('The forecast could not be computed for this account.'),
    });
    this.destroyRef.onDestroy(() => sub.unsubscribe());
  }

  protected money(v: number | null | undefined, ccy: string): string {
    return formatMoney(v, ccy);
  }
  protected num(v: number | null | undefined, digits = 2): string {
    return formatNumber(v, digits);
  }
  protected pct(p: number | null | undefined): string {
    return p === null || p === undefined ? '—' : `${(p * 100).toFixed(p < 0.01 ? 2 : 1)} %`;
  }
  protected tone = forecastTone;
  protected label = forecastLabel;
  protected age(seconds: number): string {
    if (seconds < 120) return `${seconds} s ago`;
    if (seconds < 7200) return `${Math.round(seconds / 60)} min ago`;
    return `${Math.round(seconds / 3600)} h ago`;
  }
}
