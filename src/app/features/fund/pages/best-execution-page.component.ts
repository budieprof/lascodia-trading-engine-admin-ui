import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { NotificationService } from '@core/notifications/notification.service';
import { errorText } from '@features/iam/iam.logic';
import { saveBlob } from '@features/scripting/shared/download';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

import { FundApiService } from '../fund-api.service';
import {
  day,
  defaultPeriod,
  isUpgradeNotice,
  markoutCell,
  num,
  pct,
  periodQuery,
} from '../fund.logic';
import type { BestExecutionReport, FillGroupStats, FundScope } from '../fund.types';

/**
 * Best-execution evidence (fund module): how each live fill compared with the market around it —
 * slippage against the arrival mid and the requested price, spread paid, fill latency and markouts —
 * per broker, account and symbol, with the methodology. Evidence for the organisation's own policy;
 * it is not a regulatory report template and the page says so. Needs `fund.bestex.read`.
 */
@Component({
  selector: 'app-fund-best-execution-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, PageHeaderComponent],
  styleUrls: ['../../iam/shared/iam-page.scss', './fund-page.scss'],
  template: `
    <div class="page">
      <app-page-header
        title="Best execution"
        subtitle="Evidence of execution quality for live fills. Not a regulatory report template."
      />

      @if (upgrade()) {
        <section class="card upgrade" role="status">
          <span class="chip warn">Not in your plan</span> {{ upgrade() }}
        </section>
      } @else {
        <section class="card">
          <div class="filters">
            <label class="field">
              <span class="label">Account</span>
              <select
                class="select"
                name="account"
                [ngModel]="account()"
                (ngModelChange)="account.set($event)"
              >
                <option [ngValue]="null">Every account I may see</option>
                @for (a of scope().accounts; track a.id) {
                  <option [ngValue]="a.id">{{ a.accountId }} · {{ a.broker }}</option>
                }
              </select>
            </label>
            <label class="field"
              ><span class="label">Symbol</span>
              <input
                class="input"
                name="symbol"
                placeholder="all"
                [ngModel]="symbol()"
                (ngModelChange)="symbol.set($event)"
            /></label>
            <label class="field"
              ><span class="label">From (UTC)</span>
              <input
                class="input"
                type="date"
                name="from"
                [ngModel]="from()"
                (ngModelChange)="from.set($event)"
            /></label>
            <label class="field"
              ><span class="label">To (UTC, exclusive)</span>
              <input
                class="input"
                type="date"
                name="to"
                [ngModel]="to()"
                (ngModelChange)="to.set($event)"
            /></label>
            <button type="button" class="btn btn-primary" [disabled]="loading()" (click)="load()">
              {{ loading() ? 'Measuring…' : 'Show' }}
            </button>
            <button
              type="button"
              class="btn btn-secondary"
              [disabled]="!report() || busy()"
              (click)="download('pdf')"
            >
              PDF
            </button>
            <button
              type="button"
              class="btn btn-secondary"
              [disabled]="!report() || busy()"
              (click)="download('csv')"
            >
              CSV
            </button>
          </div>
          @if (error()) {
            <p class="pad" role="alert">
              <span class="chip bad">Could not load</span> {{ error() }}
            </p>
          }
        </section>

        @if (report(); as r) {
          <section class="card">
            <div class="card-head">
              <strong>{{ r.fillsMeasured }} fill(s)</strong>
              <span class="muted small">
                · pips are costs when positive; markouts positive = the market then moved in the
                account's favour</span
              >
            </div>
            @for (t of tables(r); track t.title) {
              <div class="pad small">
                <strong>{{ t.title }}</strong>
              </div>
              <div class="table-wrap">
                <table class="grid">
                  <thead>
                    <tr>
                      <th>Group</th>
                      <th class="num">Fills</th>
                      <th class="num">Lots</th>
                      <th class="num">Mean slip</th>
                      <th class="num">Median</th>
                      <th class="num">P95 |slip|</th>
                      <th class="num">Improved</th>
                      <th class="num">Vs requested</th>
                      <th class="num">Quoted sprd</th>
                      <th class="num">Eff. sprd</th>
                      <th class="num">Latency p50 / p95</th>
                      @for (h of r.markoutHorizons; track h) {
                        <th class="num">MO {{ h }}</th>
                      }
                    </tr>
                  </thead>
                  <tbody>
                    @for (s of t.rows; track s.key) {
                      <tr>
                        <td>{{ s.key }}</td>
                        <td class="num">{{ s.fills }}</td>
                        <td class="num">{{ num(s.lots) }}</td>
                        <td class="num">{{ num(s.meanSlippagePips) }}</td>
                        <td class="num">{{ num(s.medianSlippagePips) }}</td>
                        <td class="num">{{ num(s.p95AbsSlippagePips) }}</td>
                        <td class="num">{{ pct(s.priceImprovementShare, 0) }}</td>
                        <td class="num">{{ num(s.meanVsRequestedPips) }}</td>
                        <td class="num">{{ num(s.meanQuotedSpreadPips) }}</td>
                        <td class="num">{{ num(s.meanEffectiveSpreadPips) }}</td>
                        <td class="num">
                          {{ num(s.medianLatencyMs, 0) }} / {{ num(s.p95LatencyMs, 0) }} ms
                        </td>
                        @for (m of s.meanMarkoutPips; track $index) {
                          <td class="num">{{ markoutCell(m, s.markoutSamples[$index]) }}</td>
                        }
                      </tr>
                    } @empty {
                      <tr>
                        <td [attr.colspan]="11 + r.markoutHorizons.length" class="muted">
                          No fills.
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          </section>

          <section class="card">
            <div class="card-head">
              <strong>Fills</strong>
              <span class="muted small"
                >newest first; {{ r.fills.length }} of {{ r.fillsMeasured }} shown here (the CSV has
                all)</span
              >
            </div>
            <div class="table-wrap">
              <table class="grid">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Account</th>
                    <th>Symbol</th>
                    <th>Side</th>
                    <th class="num">Lots</th>
                    <th>Filled (UTC)</th>
                    <th class="num">Fill</th>
                    <th class="num">Arrival mid</th>
                    <th>Benchmark</th>
                    <th class="num">Slip pips</th>
                    <th class="num">Latency ms</th>
                    @for (h of r.markoutHorizons; track h) {
                      <th class="num">MO {{ h }}</th>
                    }
                  </tr>
                </thead>
                <tbody>
                  @for (f of r.fills; track f.orderId) {
                    <tr>
                      <td>#{{ f.orderId }}</td>
                      <td class="small">{{ f.account }}</td>
                      <td>{{ f.symbol }}</td>
                      <td>{{ f.side }}</td>
                      <td class="num">{{ num(f.lots) }}</td>
                      <td class="small">{{ f.filledAtUtc.slice(0, 19).replace('T', ' ') }}</td>
                      <td class="num">{{ num(f.fillPrice, 5) }}</td>
                      <td class="num">{{ num(f.arrivalMid, 5) }}</td>
                      <td class="small">{{ f.arrivalSource }}</td>
                      <td class="num">{{ num(f.slippageVsArrivalPips) }}</td>
                      <td class="num">{{ f.latencyMs ?? '—' }}</td>
                      @for (m of f.markoutPips; track $index) {
                        <td class="num">{{ num(m) }}</td>
                      }
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>

          <section class="card">
            <div class="card-head">
              <strong>Data notes and methodology</strong>
              <span class="muted small">generated {{ day(r.generatedAtUtc) }}</span>
            </div>
            <ul class="pad notes small">
              @for (n of r.dataNotes; track $index) {
                <li>
                  <strong>{{ n }}</strong>
                </li>
              }
              @for (m of r.methodology; track $index) {
                <li>{{ m }}</li>
              }
            </ul>
          </section>
        }
      }
    </div>
  `,
})
export class BestExecutionPageComponent {
  private readonly fund = inject(FundApiService);
  private readonly notify = inject(NotificationService);

  protected readonly num = num;
  protected readonly pct = pct;
  protected readonly day = day;
  protected readonly markoutCell = markoutCell;

  readonly scope = signal<FundScope>({ accounts: [], groups: [], bestExecution: false });
  readonly account = signal<number | null>(null);
  readonly symbol = signal('');
  readonly from = signal(defaultPeriod(new Date(), 30).from);
  readonly to = signal(defaultPeriod(new Date(), 30).to);
  readonly report = signal<BestExecutionReport | null>(null);
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly upgrade = signal<string | null>(null);

  constructor() {
    this.fund.scope().subscribe({ next: (s) => this.scope.set(s), error: (e) => this.fail(e) });
  }

  tables(r: BestExecutionReport): { title: string; rows: FillGroupStats[] }[] {
    return [
      { title: 'Overall', rows: [r.overall] },
      { title: 'By broker (venue)', rows: r.byBroker },
      { title: 'By account', rows: r.byAccount },
      { title: 'By symbol', rows: r.bySymbol },
    ];
  }

  private params() {
    const period = periodQuery(this.from(), this.to());
    if ('problem' in period) {
      this.error.set(period.problem);
      return null;
    }
    return {
      from: period.from,
      to: period.to,
      tradingAccountId: this.account(),
      symbol: this.symbol().trim().toUpperCase() || null,
    };
  }

  private fail(e: unknown): void {
    this.loading.set(false);
    if (isUpgradeNotice(e))
      this.upgrade.set(errorText(e, 'Your plan does not include the fund module.'));
    else this.error.set(errorText(e, 'The report could not be loaded.'));
  }

  load(): void {
    const params = this.params();
    if (!params) return;
    this.loading.set(true);
    this.error.set(null);
    this.fund.bestExecution(params).subscribe({
      next: (r) => {
        this.report.set(r);
        this.loading.set(false);
      },
      error: (e) => this.fail(e),
    });
  }

  download(format: 'pdf' | 'csv'): void {
    const params = this.params();
    if (!params) return;
    this.busy.set(true);
    this.fund.bestExecutionExport(params, format).subscribe({
      next: (file) => {
        this.busy.set(false);
        saveBlob(file.blob, file.fileName);
      },
      error: (e) => {
        this.busy.set(false);
        this.notify.error(errorText(e, 'The download failed.'));
      },
    });
  }
}
