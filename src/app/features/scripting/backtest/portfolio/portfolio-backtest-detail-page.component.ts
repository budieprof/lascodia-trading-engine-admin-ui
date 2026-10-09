import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { AuthService } from '@core/auth/auth.service';
import { ThemeService } from '@core/theme/theme.service';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

import { SCRIPTING_UI_STYLES } from '../../components/scripting-ui.styles';
import { reportPalette } from '../../report/report-charts';
import {
  formatDateTime,
  formatMoney,
  formatNumber,
  formatPercent,
  formatPrice,
  formatRatio,
  inferPriceDecimals,
} from '../../report/report-format';
import { ANALYST_PERMISSION } from '../../research/research-permissions';
import { describeFailure, isOk } from '../../shared/api-error';
import { ScriptDialogService } from '../../shared/script-dialog.service';
import { PortfolioBacktestApiService } from './portfolio-backtest-api.service';
import {
  accountCurveOptions,
  comparisonOptions,
  correlationFill,
  exitReasonLabel,
  exposureOptions,
  isActive,
  marginOptions,
  memberTradeRows,
  memberTradeSummary,
  refusalCounts,
  refusalKindLabel,
  statusChip,
  type MemberTradeSummary,
} from './portfolio-backtest.model';
import type { PortfolioRefusalKind, PortfolioRun } from './portfolio-backtest.types';
import { PORTFOLIO_POLL_MS } from './portfolio-backtests-page.component';

/** The refusals table shows the first ones; the counts above it cover all of them. */
const REFUSALS_SHOWN = 200;
/** A member's trade table shows its first trades in closing order; the summary above it covers all of them. */
export const MEMBER_TRADES_SHOWN = 500;

/**
 * One portfolio backtest: what was queued and, once it completed, the account's findings — its curve, drawdown and margin,
 * each member's contribution, how the members' daily results moved together, the currencies the account was exposed to,
 * every entry it refused and why, and the members' own backtests for comparison. Every figure is the engine's.
 */
@Component({
  selector: 'app-portfolio-backtest-detail-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageHeaderComponent, RouterLink, ChartCardComponent],
  template: `
    <div class="page" data-testid="pf-detail">
      <app-page-header [title]="title()" [subtitle]="subtitle()">
        <a routerLink="/portfolio-backtests" class="btn btn-ghost btn-sm">All portfolio backtests</a>
      </app-page-header>

      @if (error(); as e) {
        <p class="error-box" role="alert">{{ e }}</p>
      }
      @if (!run() && loading()) {
        <p class="muted">Loading the run…</p>
      }

      @if (run(); as r) {
        <section class="card" aria-labelledby="pf-status-title">
          <header class="head">
            <h2 id="pf-status-title" class="title">Status</h2>
            <span [class]="'chip ' + chip()" data-testid="pf-status">{{ r.status }}</span>
            @if (r.stage && active()) {
              <span class="muted small">{{ r.stage }}</span>
            }
            <span class="spacer"></span>
            @if (active() && canQueue()) {
              <button type="button" class="btn btn-sm" (click)="cancel()" [disabled]="r.cancelRequested">
                {{ r.cancelRequested ? 'Stopping…' : 'Cancel…' }}
              </button>
            }
          </header>
          @if (r.status === 'Failed') {
            <p class="error-box" role="alert" data-testid="pf-failure">
              {{ r.errorMessage || 'The run failed.' }}
              @if (r.failedMemberIndex !== null) {
                (member {{ r.failedMemberIndex + 1 }})
              }
            </p>
          }
          <dl class="facts">
            <div><dt>Account</dt><dd>{{ money(r.initialBalance, r.accountCurrency) }}{{ r.leverage ? ' at 1:' + r.leverage : ', each script’s own margin' }}</dd></div>
            <div><dt>Window</dt><dd>{{ r.fromDate.slice(0, 10) }} → {{ r.toDate.slice(0, 10) }}</dd></div>
            <div><dt>Queued</dt><dd>{{ when(r.queuedAt) }}{{ r.queuedBy ? ' by ' + r.queuedBy : '' }}</dd></div>
            @if (r.completedAt) {
              <div><dt>Finished</dt><dd>{{ when(r.completedAt) }}</dd></div>
            }
            @if (r.exposure; as x) {
              <div>
                <dt>Exposure limits</dt>
                <dd data-testid="pf-rule">
                  {{ limit(x.maxSameDirectionCurrencyLegs) }} same-direction position(s) per currency,
                  {{ limit(x.maxCorrelatedPositions) }} per correlation group ({{ x.source }})
                </dd>
              </div>
            }
            @if (r.costModelKey) {
              <div><dt>Cost model</dt><dd class="mono small">{{ r.costModelKey }}</dd></div>
            }
          </dl>
          <table class="members-queued">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Member</th>
                <th scope="col">Symbol</th>
                <th scope="col">Timeframe</th>
                <th scope="col" class="num">Share of equity</th>
                <th scope="col">Inputs changed</th>
              </tr>
            </thead>
            <tbody>
              @for (m of r.members; track m.index) {
                <tr>
                  <td>{{ m.index + 1 }}</td>
                  <td>
                    @if (m.strategyId) {
                      <a [routerLink]="['/strategies', m.strategyId]">{{ m.name }}</a>
                    } @else {
                      {{ m.name }} <span class="muted small">(written for the run)</span>
                    }
                  </td>
                  <td>{{ m.symbol }}</td>
                  <td>{{ m.timeframe }}</td>
                  <td class="num">{{ pct(m.equitySharePct) }}</td>
                  <td class="mono small">{{ inputsText(m.inputOverrides) }}</td>
                </tr>
              }
            </tbody>
          </table>
        </section>

        @if (r.result; as res) {
          <section class="card" aria-labelledby="pf-account-title">
            <h2 id="pf-account-title" class="title">The account</h2>
            <div class="figures" data-testid="pf-figures">
              <div><span class="label">Net profit</span><span class="value">{{ money(res.account.netProfit, res.accountCurrency, true) }}</span></div>
              <div><span class="label">Return</span><span class="value">{{ pct(res.account.totalReturn, true) }}</span></div>
              <div><span class="label">Max drawdown</span><span class="value">{{ pct(res.account.maxDrawdownPct) }}</span></div>
              <div><span class="label">Trades held</span><span class="value">{{ res.account.totalTrades }}</span></div>
              <div><span class="label">Win rate</span><span class="value">{{ pct(res.account.winRate * 100) }}</span></div>
              <div><span class="label">Profit factor</span><span class="value">{{ ratio(res.account.profitFactor) }}</span></div>
              <div><span class="label">Expectancy</span><span class="value">{{ r1(res.account.expectancyR) }}</span></div>
              <div><span class="label">Sharpe</span><span class="value">{{ ratio(res.account.sharpeRatio) }}</span></div>
              <div><span class="label">Refused entries</span><span class="value">{{ res.refusals.length }}</span></div>
              <div><span class="label">Margin calls</span><span class="value">{{ res.marginCalls.length }}</span></div>
            </div>
            <app-chart-card
              title="Equity, drawdown and margin"
              [options]="curveOptions() ?? {}"
              [emptyMessage]="curveOptions() ? null : 'Too few points to draw.'"
              height="440px"
            />
          </section>

          <section class="card" aria-labelledby="pf-members-title">
            <h2 id="pf-members-title" class="title">What each member contributed</h2>
            <div class="table-wrap">
              <table data-testid="pf-members">
                <thead>
                  <tr>
                    <th scope="col">Member</th>
                    <th scope="col" class="num">Net profit</th>
                    <th scope="col" class="num">Trades</th>
                    <th scope="col" class="num">Win rate</th>
                    <th scope="col" class="num">Sum of R</th>
                    <th scope="col" class="num">Expectancy</th>
                    <th scope="col" class="num">Share of max drawdown</th>
                    <th scope="col" class="num">In the market</th>
                    <th scope="col">Refused</th>
                  </tr>
                </thead>
                <tbody>
                  @for (m of res.members; track m.index) {
                    <tr>
                      <td>{{ m.index + 1 }}. {{ m.name }} <span class="muted small">{{ m.symbol }} {{ m.timeframe }}</span></td>
                      <td class="num">{{ money(m.netProfit, res.accountCurrency, true) }}</td>
                      <td class="num">{{ m.trades }}</td>
                      <td class="num">{{ pct(m.winRate * 100) }}</td>
                      <td class="num">{{ num(m.sumR, 2, true) }}</td>
                      <td class="num">{{ r1(m.expectancyR) }}</td>
                      <td class="num">{{ pct(m.drawdownSharePct) }}</td>
                      <td class="num">{{ pct(m.timeInMarketPct) }}</td>
                      <td class="small">{{ refusedText(m.refusedEntries) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            <p class="muted small">
              A member's share of the drawdown is how much of the account's largest fall (peak to trough) its own
              results made up; shares above 100 % mean other members gained over the same stretch.
            </p>
          </section>

          @if (res.members.length > 0) {
            <section class="card" aria-labelledby="pf-trades-title">
              <header class="head">
                <h2 id="pf-trades-title" class="title">Each member’s trades</h2>
                <span class="spacer"></span>
                <label class="small">
                  Member
                  <select data-testid="pf-trades-member" [value]="tradesMember()" (change)="pickTradesMember($event)">
                    @for (m of res.members; track m.index) {
                      <option [value]="m.index">{{ m.index + 1 }}. {{ m.name }} — {{ m.symbol }} {{ m.timeframe }}</option>
                    }
                  </select>
                </label>
              </header>
              @if (tradesOf(); as t) {
                @if (t.rows.length === 0) {
                  <p class="muted" data-testid="pf-trades-empty">{{ t.member.name }} held no trade on the account.</p>
                } @else {
                  <p class="small" data-testid="pf-trades-summary">{{ tradesSummaryText(t.summary, res.accountCurrency) }}</p>
                  <div class="table-wrap">
                    <table data-testid="pf-trades">
                      <thead>
                        <tr>
                          <th scope="col" class="num">#</th>
                          <th scope="col">Side</th>
                          <th scope="col">Entry (UTC)</th>
                          <th scope="col" class="num">Entry price</th>
                          <th scope="col">Exit (UTC)</th>
                          <th scope="col" class="num">Exit price</th>
                          <th scope="col">Exit</th>
                          <th scope="col" class="num">Lots</th>
                          <th scope="col" class="num">Costs</th>
                          <th scope="col" class="num">P&amp;L</th>
                          <th scope="col" class="num">R</th>
                          <th scope="col" class="num">Member P&amp;L so far</th>
                        </tr>
                      </thead>
                      <tbody>
                        @for (row of t.shown; track row.number) {
                          <tr>
                            <td class="num">{{ row.number }}</td>
                            <td>{{ row.trade.direction === 'Buy' ? 'Long' : 'Short' }}</td>
                            <td class="small">{{ when(row.trade.entryTime) }}</td>
                            <td class="num">{{ price(row.trade.entryPrice, t.decimals) }}</td>
                            <td class="small">{{ when(row.trade.exitTime) }}</td>
                            <td class="num">{{ price(row.trade.exitPrice, t.decimals) }}</td>
                            <td class="small">{{ exitLabel(row.trade.exitReason) }}</td>
                            <td class="num">{{ num(row.trade.lotSize, 2) }}</td>
                            <td class="num">{{ money(row.trade.commission + row.trade.swap + row.trade.slippage, '') }}</td>
                            <td class="num">{{ money(row.trade.pnL, '', true) }}</td>
                            <td class="num">{{ rText(row.trade.rMultiple) }}</td>
                            <td class="num">{{ money(row.cumulativePnL, '', true) }}</td>
                          </tr>
                        }
                      </tbody>
                    </table>
                  </div>
                  @if (t.rows.length > t.shown.length) {
                    <p class="muted small">The first {{ t.shown.length }} of {{ t.rows.length }} trades are listed.</p>
                  }
                }
                <p class="muted small">
                  The trades this member held on the shared account, in the order they closed. Entries the account did
                  not take are listed under “Entries the account did not take”. Amounts are in {{ res.accountCurrency }};
                  costs are commission, swap and slippage.
                </p>
              }
            </section>
          }

          @if (res.correlation.members.length > 1) {
            <section class="card" aria-labelledby="pf-corr-title">
              <h2 id="pf-corr-title" class="title">How the members moved together</h2>
              <p class="muted small">
                Correlation of the members' daily results over {{ res.correlation.days }} trading days. Near +1, their
                losses come together; near −1, one offsets the other.
              </p>
              <div class="table-wrap">
                <table class="matrix" data-testid="pf-correlation">
                  <thead>
                    <tr>
                      <th scope="col"><span class="sr-only">Member</span></th>
                      @for (i of res.correlation.members; track i) {
                        <th scope="col" class="num">{{ i + 1 }}</th>
                      }
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of res.correlation.matrix; track $index; let ri = $index) {
                      <tr>
                        <th scope="row">{{ res.correlation.members[ri] + 1 }}. {{ memberName(res.correlation.members[ri]) }}</th>
                        @for (v of row; track $index) {
                          <td class="num" [style.background]="fill(v)">{{ v === null ? '—' : num(v, 2) }}</td>
                        }
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </section>
          }

          <section class="card" aria-labelledby="pf-exposure-title">
            <header class="head">
              <h2 id="pf-exposure-title" class="title">Currency exposure</h2>
              <span class="spacer"></span>
              <div class="toggle" role="group" aria-label="Exposure measure">
                <button type="button" class="btn btn-sm" [class.btn-primary]="exposureMode() === 'legs'" (click)="exposureMode.set('legs')">
                  Positions
                </button>
                <button type="button" class="btn btn-sm" [class.btn-primary]="exposureMode() === 'notional'" (click)="exposureMode.set('notional')">
                  Value
                </button>
              </div>
            </header>
            <app-chart-card
              [title]="exposureMode() === 'legs' ? 'Net open positions per currency' : 'Net open value per currency'"
              subtitle="+1 for each position long the currency, −1 for each short — what the live currency-leg limit counts."
              [options]="exposureChart() ?? {}"
              [emptyMessage]="exposureChart() ? null : 'The account held no position.'"
              height="280px"
            />
            <app-chart-card
              title="Highest margin use each trading day"
              [options]="marginChart() ?? {}"
              [emptyMessage]="marginChart() ? null : 'No margin was used.'"
              height="200px"
            />
          </section>

          <section class="card" aria-labelledby="pf-refusals-title">
            <h2 id="pf-refusals-title" class="title">Entries the account did not take</h2>
            @if (res.refusals.length === 0) {
              <p class="muted">None: the account took every entry its members' scripts made.</p>
            } @else {
              <p class="counts" data-testid="pf-refusal-counts">
                @for (c of refusals(); track c.kind) {
                  <span class="chip">{{ c.label }}: {{ c.count }}</span>
                }
              </p>
              <div class="table-wrap">
                <table data-testid="pf-refusals">
                  <thead>
                    <tr>
                      <th scope="col">Time (UTC)</th>
                      <th scope="col">Member</th>
                      <th scope="col">Entry</th>
                      <th scope="col">Why</th>
                      <th scope="col">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (x of shownRefusals(); track $index) {
                      <tr>
                        <td class="small">{{ when(x.timeUtc) }}</td>
                        <td>{{ x.memberIndex + 1 }}. {{ x.member }}</td>
                        <td class="small">{{ x.direction ?? '' }} {{ x.symbol }}{{ x.lots !== null ? ' ' + num(x.lots, 2) + ' lots' : '' }}</td>
                        <td class="small">{{ kindLabel(x.kind) }}</td>
                        <td class="small">{{ x.reason }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
              @if (res.refusals.length > shownRefusals().length) {
                <p class="muted small">The first {{ shownRefusals().length }} of {{ res.refusals.length }} are listed.</p>
              }
            }
          </section>

          <section class="card" aria-labelledby="pf-compare-title">
            <h2 id="pf-compare-title" class="title">Against the members' own backtests</h2>
            <p class="muted small">
              Each member also ran alone on its own capital ({{ res.comparison.currency }}). The difference is what
              sharing one account changed: compounding on the shared equity, shared margin and the exposure limits.
            </p>
            <app-chart-card
              title="Profit: the portfolio against its members alone"
              [options]="compareChart() ?? {}"
              [emptyMessage]="compareChart() ? null : 'Too few points to draw.'"
              height="260px"
            />
            <div class="table-wrap">
              <table data-testid="pf-standalone">
                <thead>
                  <tr>
                    <th scope="col">Member alone</th>
                    <th scope="col" class="num">Capital</th>
                    <th scope="col" class="num">Net profit</th>
                    <th scope="col" class="num">Return</th>
                    <th scope="col" class="num">Max drawdown</th>
                    <th scope="col" class="num">Trades</th>
                    <th scope="col" class="num">Expectancy</th>
                  </tr>
                </thead>
                <tbody>
                  @for (s of res.comparison.members; track s.index) {
                    <tr>
                      <td>{{ s.index + 1 }}. {{ s.name }}</td>
                      @if (s.failure) {
                        <td colspan="6" class="small">Did not run alone: {{ s.failure }}</td>
                      } @else {
                        <td class="num">{{ money(s.initialBalance, '') }}</td>
                        <td class="num">{{ money(s.netProfit, '', true) }}</td>
                        <td class="num">{{ pct(s.totalReturnPct, true) }}</td>
                        <td class="num">{{ pct(s.maxDrawdownPct) }}</td>
                        <td class="num">{{ s.trades ?? '—' }}</td>
                        <td class="num">{{ r1(s.expectancyR) }}</td>
                      }
                    </tr>
                  }
                  <tr class="total">
                    <th scope="row">Members alone, summed</th>
                    <td class="num">{{ money(res.comparison.sumInitialBalance, '') }}</td>
                    <td class="num">{{ money(res.comparison.sumNetProfit, '', true) }}</td>
                    <td></td>
                    <td></td>
                    <td class="num">{{ res.comparison.sumTrades }}</td>
                    <td></td>
                  </tr>
                  <tr class="total">
                    <th scope="row">The portfolio</th>
                    <td class="num">{{ money(res.initialBalance, '') }}</td>
                    <td class="num">{{ money(res.comparison.portfolioNetProfit, '', true) }}</td>
                    <td></td>
                    <td></td>
                    <td class="num">{{ res.comparison.portfolioTrades }}</td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          @if (res.notes.length > 0) {
            <section class="card" aria-labelledby="pf-notes-title">
              <h2 id="pf-notes-title" class="title">Notes</h2>
              <ul class="notes">
                @for (n of res.notes; track $index) {
                  <li>{{ n }}</li>
                }
              </ul>
            </section>
          }
        }
      }
    </div>
  `,
  styles: [
    SCRIPTING_UI_STYLES,
    `
      .page { padding: var(--space-2) 0; display: flex; flex-direction: column; gap: var(--space-4); }
      .card {
        padding: var(--space-4) var(--space-5); background: var(--bg-secondary); border: 1px solid var(--border);
        border-radius: var(--radius-md); display: flex; flex-direction: column; gap: var(--space-3);
      }
      .head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .title { margin: 0; font-size: var(--text-base); font-weight: var(--font-semibold); }
      .spacer { flex: 1; }
      .facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: var(--space-2) var(--space-4); margin: 0; }
      .facts dt { font-size: var(--text-xs); color: var(--text-secondary); }
      .facts dd { margin: 2px 0 0; font-size: var(--text-sm); overflow-wrap: anywhere; }
      .figures { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: var(--space-3); }
      .figures > div { display: flex; flex-direction: column; gap: 2px; }
      .label { font-size: var(--text-xs); color: var(--text-secondary); }
      .value { font-size: var(--text-lg); font-weight: var(--font-semibold); font-variant-numeric: tabular-nums; }
      .table-wrap { overflow-x: auto; }
      table { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
      th, td { padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; font-weight: normal; }
      thead th { font-size: var(--text-xs); color: var(--text-secondary); }
      .num { text-align: right; font-variant-numeric: tabular-nums; }
      .matrix td { min-width: 56px; }
      .total th, .total td { font-weight: var(--font-semibold); }
      .counts { display: flex; gap: 6px; flex-wrap: wrap; margin: 0; }
      .toggle { display: inline-flex; gap: 4px; }
      .notes { margin: 0; padding-left: 18px; font-size: var(--text-sm); }
      .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); }
      p { margin: 0; }
    `,
  ],
})
export class PortfolioBacktestDetailPageComponent implements OnInit {
  private readonly api = inject(PortfolioBacktestApiService);
  private readonly auth = inject(AuthService);
  private readonly theme = inject(ThemeService);
  private readonly dialogs = inject(ScriptDialogService);
  private readonly route = inject(ActivatedRoute);

  readonly canQueue = computed(() => this.auth.hasPermission(ANALYST_PERMISSION));
  readonly run = signal<PortfolioRun | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly exposureMode = signal<'legs' | 'notional'>('legs');

  readonly id = signal(0);
  readonly title = computed(() => {
    const r = this.run();
    return r ? `Portfolio backtest #${r.id}` : `Portfolio backtest #${this.id()}`;
  });
  readonly subtitle = computed(() => this.run()?.name ?? '');
  readonly active = computed(() => {
    const r = this.run();
    return !!r && isActive(r.status);
  });
  readonly chip = computed(() => {
    const r = this.run();
    return r ? statusChip(r.status) : '';
  });

  private readonly palette = computed(() => reportPalette(this.theme.theme()));
  readonly curveOptions = computed(() => {
    const res = this.run()?.result;
    return res ? accountCurveOptions(res, this.palette()) : null;
  });
  readonly compareChart = computed(() => {
    const res = this.run()?.result;
    return res ? comparisonOptions(res, this.palette()) : null;
  });
  readonly exposureChart = computed(() => {
    const res = this.run()?.result;
    return res ? exposureOptions(res.exposure, this.palette(), this.exposureMode(), res.accountCurrency) : null;
  });
  readonly marginChart = computed(() => {
    const res = this.run()?.result;
    return res ? marginOptions(res.margin, this.palette()) : null;
  });
  readonly refusals = computed(() => refusalCounts(this.run()?.result?.refusals ?? []));

  /** The member whose trades are listed (its index); the first member until another is picked. */
  readonly tradesMember = signal(0);
  readonly tradesOf = computed(() => {
    const members = this.run()?.result?.members ?? [];
    const member = members.find((m) => m.index === this.tradesMember()) ?? members[0];
    if (!member) return null;
    const trades = member.tradeList ?? [];
    const rows = memberTradeRows(trades);
    return {
      member,
      rows,
      shown: rows.slice(0, MEMBER_TRADES_SHOWN),
      summary: memberTradeSummary(trades),
      decimals: inferPriceDecimals(trades.flatMap((t) => [t.entryPrice, t.exitPrice])),
    };
  });
  readonly shownRefusals = computed(() => (this.run()?.result?.refusals ?? []).slice(0, REFUSALS_SHOWN));

  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stopPolling());
  }

  ngOnInit(): void {
    this.id.set(Number(this.route.snapshot.paramMap.get('id')));
    void this.reload();
  }

  money(v: number | null | undefined, currency: string, signed = false): string {
    return formatMoney(v ?? null, currency, { signed });
  }
  pct(v: number | null | undefined, signed = false): string {
    return formatPercent(v ?? null, { signed });
  }
  num(v: number | null | undefined, decimals = 2, signed = false): string {
    return formatNumber(v ?? null, decimals, signed);
  }
  price(v: number | null | undefined, decimals: number): string {
    return formatPrice(v ?? null, decimals);
  }
  rText(v: number | null | undefined): string {
    return v === null || v === undefined ? '—' : formatNumber(v, 2, true);
  }
  exitLabel(reason: string): string {
    return exitReasonLabel(reason);
  }
  tradesSummaryText(s: MemberTradeSummary, currency: string): string {
    const r = s.averageR === null ? '' : `, average ${this.r1(s.averageR)} over ${s.rTrades} trade(s) with a stop`;
    return (
      `${s.trades} trade(s) held: ${s.longs} long, ${s.shorts} short; ${s.winners} won, ${s.losers} lost; ` +
      `net ${this.money(s.netPnL, currency, true)}${r}.`
    );
  }
  pickTradesMember(event: Event): void {
    this.tradesMember.set(Number((event.target as HTMLSelectElement).value));
  }
  ratio(v: number | null | undefined): string {
    return formatRatio(v ?? null);
  }
  r1(v: number | null | undefined): string {
    return v === null || v === undefined ? '—' : `${formatNumber(v, 2, true)} R`;
  }
  when(iso: string | null | undefined): string {
    return iso ? `${formatDateTime(Date.parse(iso))} UTC` : '—';
  }
  limit(v: number): string {
    return v > 0 ? String(v) : 'no limit on';
  }
  fill(v: number | null): string {
    return correlationFill(v, this.palette());
  }
  kindLabel(kind: PortfolioRefusalKind): string {
    return refusalKindLabel(kind);
  }
  memberName(index: number): string {
    return this.run()?.result?.members.find((m) => m.index === index)?.name ?? '';
  }
  refusedText(counts: Partial<Record<PortfolioRefusalKind, number>>): string {
    const parts = Object.entries(counts)
      .filter(([, n]) => (n ?? 0) > 0)
      .map(([k, n]) => `${refusalKindLabel(k as PortfolioRefusalKind)}: ${n}`);
    return parts.length > 0 ? parts.join(', ') : 'none';
  }
  inputsText(inputs: Record<string, unknown> | null): string {
    if (!inputs || Object.keys(inputs).length === 0) return 'none';
    return Object.entries(inputs)
      .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
      .join(', ');
  }

  async reload(): Promise<void> {
    this.stopPolling();
    if (!(this.id() > 0)) {
      this.error.set('That is not a portfolio backtest id.');
      return;
    }
    this.loading.set(true);
    try {
      const res = await firstValueFrom(this.api.get(this.id()));
      if (!isOk(res) || !res.data) throw res;
      const run = res.data;
      this.run.set(run);
      this.error.set(null);
      if (isActive(run.status)) this.timer = setTimeout(() => void this.reload(), PORTFOLIO_POLL_MS);
    } catch (err) {
      this.error.set(describeFailure(err, 'The portfolio backtest could not be read.'));
    } finally {
      this.loading.set(false);
    }
  }

  async cancel(): Promise<void> {
    const r = this.run();
    if (!r) return;
    const ok = await this.dialogs.confirm({
      title: `Cancel portfolio backtest #${r.id}?`,
      message:
        r.status === 'Queued'
          ? 'It has not started; cancelling takes it out of the queue.'
          : 'It stops at its worker’s next heartbeat (within about 20 seconds) and keeps no findings.',
      confirmLabel: 'Cancel the run',
      cancelLabel: 'Keep it',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      const res = await firstValueFrom(this.api.cancel(r.id));
      if (!isOk(res)) throw res;
      await this.reload();
    } catch (err) {
      this.error.set(describeFailure(err, 'The run could not be cancelled.'));
    }
  }

  private stopPolling(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
