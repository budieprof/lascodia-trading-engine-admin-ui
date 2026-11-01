import { ChangeDetectionStrategy, Component, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { failureMessage } from '@features/organisation/organisation.logic';

import { RiskApiService } from '../risk-api.service';
import { forecastLabel, forecastTone, formatMoney, formatNumber, verdictLabel, verdictTone } from '../risk.logic';
import type { PortfolioRiskAccountRow, WhatIfResult } from '../risk.types';

/** Read-only what-if: what a proposed trade does to VaR, the worst stress scenario and the stop-out distance. */
@Component({
  selector: 'app-risk-what-if',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  styleUrl: '../risk.scss',
  template: `
    <section class="card" aria-labelledby="wi-title">
      <header class="card-head"><h3 id="wi-title">What-if trade</h3></header>
      <p class="pad small muted">Nothing is placed or stored. The answer is what Tier 2's marginal-VaR gate and the stress pre-trade check would see for this account now.</p>
      <form class="form-grid pad" (ngSubmit)="run()">
        <label class="field"><span class="label">Account</span>
          <select class="select" name="account" [(ngModel)]="account" required>
            @for (a of accounts(); track a.tradingAccountId) { <option [ngValue]="a.tradingAccountId">{{ a.accountName || a.accountId }}</option> }
          </select></label>
        <label class="field"><span class="label">Symbol</span><input class="input" name="symbol" [(ngModel)]="symbol" required maxlength="32" /></label>
        <label class="field"><span class="label">Side</span>
          <select class="select" name="dir" [(ngModel)]="direction"><option value="Buy">Buy</option><option value="Sell">Sell</option></select></label>
        <label class="field"><span class="label">Lots</span><input class="input" type="number" name="lots" [(ngModel)]="lots" min="0.01" step="0.01" required /></label>
        <label class="field"><span class="label">Price (blank = live)</span><input class="input" type="number" name="price" [(ngModel)]="price" step="0.00001" /></label>
        <div class="actions-row"><button type="submit" class="btn btn-primary" [disabled]="busy() || !account || !symbol || !(lots > 0)">{{ busy() ? 'Working…' : 'Evaluate' }}</button></div>
      </form>
      @if (error()) { <p class="pad small neg" role="alert">{{ error() }}</p> }
    </section>

    @if (result(); as r) {
      <section class="card" aria-live="polite">
        <header class="card-head"><h3>{{ r.direction }} {{ r.lots }} {{ r.symbol }} @ {{ r.price }}</h3>
          <span [class]="'chip ' + vTone(r.stepVerdict)">{{ vLabel(r.stepVerdict) }}</span></header>
        <div class="tiles pad">
          <div class="tile"><div class="k">VaR 95 % before → after</div><div class="v">{{ money(r.preTradeVaR95, r.currency) }} → {{ money(r.postTradeVaR95, r.currency) }}</div>
            <div class="small" [class.neg]="r.wouldBreachVaRLimit">marginal {{ money(r.marginalVaR95, r.currency) }}{{ r.wouldBreachVaRLimit ? ' — breaches the ' + r.maxVaR95Pct + ' % limit (§20 would reject)' : '' }}</div></div>
          <div class="tile"><div class="k">Worst scenario after</div>
            <div class="v">{{ r.stress.worstScenario ? num(r.stress.worstScenario.postTradeLossPct) + ' %' : '—' }}</div>
            <div class="small muted">{{ r.stress.worstScenario?.name ?? 'no active scenario' }} · limit {{ r.stress.settings.maxScenarioLossPct }} %</div></div>
          <div class="tile"><div class="k">Stop-out distance before → after</div>
            <div class="v">{{ num(r.stress.preTradeStopOutSigma, 1) }} → {{ num(r.stress.postTradeStopOutSigma, 1) }} σ</div>
            <div class="small muted">minimum {{ r.stress.settings.minStopOutSigma }} σ{{ r.stress.stopOutUnavailable ? ' · ' + r.stress.stopOutUnavailable : '' }}</div></div>
          <div class="tile"><div class="k">Largest lot inside both limits</div><div class="v">{{ r.stress.maxLots ?? 'no cap' }}</div>
            <div class="small muted">mode {{ r.stress.settings.mode }} · {{ num(r.stress.elapsedMs, 1) }} ms</div></div>
        </div>
        @if (r.stress.reason) { <p class="pad small">{{ r.stress.reason }}</p> }
        <p class="pad small">Margin forecast: <span [class]="'chip ' + fTone(r.preTradeForecast.status)">{{ fLabel(r.preTradeForecast.status) }}</span> →
          <span [class]="'chip ' + fTone(r.postTradeForecast.status)">{{ fLabel(r.postTradeForecast.status) }}</span></p>
        <div class="table-wrap">
          <table class="grid">
            <thead><tr><th>Scenario</th><th class="num">Book now</th><th class="num">Per lot</th><th class="num">After</th><th class="num">% equity</th><th class="num">Max lots</th></tr></thead>
            <tbody>
              @for (s of r.stress.scenarios; track s.scenarioId) {
                <tr><td>{{ s.name }}</td><td class="num">{{ money(s.preTradePnl, r.currency) }}</td><td class="num">{{ money(s.pnlPerLot, r.currency) }}</td>
                  <td class="num" [class.neg]="s.postTradePnl < 0">{{ money(s.postTradePnl, r.currency) }}</td><td class="num">{{ num(s.postTradeLossPct) }} %</td>
                  <td class="num">{{ s.maxLots ?? '—' }}</td></tr>
              }
            </tbody>
          </table>
        </div>
      </section>
    }
  `,
})
export class RiskWhatIfComponent {
  private readonly api = inject(RiskApiService);

  readonly accountId = input<number | null>(null);
  readonly accounts = input<PortfolioRiskAccountRow[]>([]);

  account: number | null = null;
  symbol = 'EURUSD';
  direction: 'Buy' | 'Sell' = 'Buy';
  lots = 1;
  price: number | null = null;

  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly result = signal<WhatIfResult | null>(null);

  constructor() {
    effect(() => {
      const id = this.accountId() ?? this.accounts()[0]?.tradingAccountId ?? null;
      untracked(() => (this.account = id));
    });
  }

  run(): void {
    if (!this.account) return;
    this.busy.set(true);
    this.error.set(null);
    this.api
      .whatIf({ tradingAccountId: this.account, symbol: this.symbol.trim().toUpperCase(), direction: this.direction, lots: this.lots, price: this.price || null })
      .subscribe({
        next: (r) => {
          this.result.set(r);
          this.busy.set(false);
        },
        error: (err: unknown) => {
          this.error.set(failureMessage(err, 'The what-if could not be evaluated.'));
          this.busy.set(false);
        },
      });
  }

  protected money(v: number | null | undefined, ccy: string): string {
    return formatMoney(v, ccy);
  }
  protected num(v: number | null | undefined, d = 2): string {
    return formatNumber(v, d);
  }
  protected vTone = verdictTone;
  protected vLabel = verdictLabel;
  protected fTone = forecastTone;
  protected fLabel = forecastLabel;
}
