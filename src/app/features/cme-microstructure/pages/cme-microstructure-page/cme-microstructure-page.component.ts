import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { catchError, finalize, of } from 'rxjs';

import { CmeMicrostructureService } from '@core/services/cme-microstructure.service';
import { NotificationService } from '@core/notifications/notification.service';
import type {
  CmeOrderflowExperimentResultDto,
  CmeStatusDto,
} from '@features/cme-microstructure/cme-microstructure.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

/**
 * CME Microstructure operator panel (engine ADR-0021 / ADR-0022).
 *
 * The engine captures real CME futures tape + depth — the only place FX has a genuine centralized
 * book and aggressor-tagged trades — and bridges it to the spot symbol we trade. Everything is gated
 * on one decisive experiment: does REAL aggressor delta beat the tick-rule proxy out-of-sample? This
 * page is where an operator seeds the contract calendar, back-adjusts the roll gaps, runs that
 * experiment, and reads what the shadow monitor would have traded.
 */
@Component({
  selector: 'app-cme-microstructure-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    FormsModule,
    PageHeaderComponent,
    MetricCardComponent,
    CardSkeletonComponent,
    ErrorStateComponent,
    EmptyStateComponent,
    RelativeTimePipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="CME Microstructure"
        subtitle="Real futures tape + depth bridged to spot — gated on the real-vs-proxy experiment (ADR-0021/0022)"
      >
        <button type="button" class="btn btn-secondary" [disabled]="loading()" (click)="load()">
          Refresh
        </button>
      </app-page-header>

      @if (loading() && !status()) {
        <app-card-skeleton [lines]="6" />
      } @else if (loadError()) {
        <app-error-state
          title="Could not load CME status"
          [message]="loadError()!"
          (retry)="load()"
        />
      } @else if (status(); as s) {
        <section class="kpis">
          <app-metric-card
            label="Contracts seeded"
            [value]="s.contractCount"
            format="number"
            [dotColor]="s.contractCount > 0 ? '#34C759' : '#FF9500'"
          />
          <app-metric-card
            label="Trades ingested"
            [value]="s.tradeCount"
            format="number"
            [dotColor]="s.tradeCount > 0 ? '#34C759' : '#8E8E93'"
          />
          <app-metric-card
            label="Book snapshots"
            [value]="s.bookSnapshotCount"
            format="number"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="Derived bars"
            [value]="s.barCount"
            format="number"
            dotColor="#8b5cf6"
          />
          <app-metric-card
            label="Shadow would-haves"
            [value]="s.shadowSignalCount"
            format="number"
            dotColor="#FF9500"
          />
        </section>

        @if (!hasData()) {
          <section class="banner">
            <strong>No CME data ingested yet.</strong>
            The subsystem ships disabled and inert: it needs a Databento slice plus
            <code>Microstructure:Enabled=true</code> and an API key. Seeding the contract calendar
            below is the prerequisite that makes the futures→spot resolver return anything.
          </section>
        }

        <!-- ── Setup: seed + back-adjust ─────────────────────────────── -->
        <section class="card">
          <header class="card-head">
            <h3>Contract calendar</h3>
            <span class="muted small">
              Front month:
              <strong>{{ s.frontMonthContract ?? '—' }}</strong>
              @if (s.latestBarUtc) {
                · latest bar {{ s.latestBarUtc | relativeTime }}
              }
            </span>
          </header>

          <div class="toolbar">
            <input class="input sm" placeholder="Root (6E)" [(ngModel)]="seedRoot" />
            <input class="input sm" placeholder="Spot (EURUSD)" [(ngModel)]="seedSpot" />
            <input class="input sm" type="date" [(ngModel)]="seedFrom" />
            <input class="input sm" type="date" [(ngModel)]="seedTo" />
            <button
              type="button"
              class="btn btn-primary"
              [disabled]="busy() || !seedRoot || !seedSpot"
              (click)="seed()"
            >
              Seed calendar
            </button>
            <button
              type="button"
              class="btn btn-secondary"
              [disabled]="busy() || !seedRoot"
              (click)="backAdjust()"
              title="Compute roll-gap offsets so a multi-quarter series is continuous"
            >
              Back-adjust rolls
            </button>
          </div>

          @if (s.contracts.length === 0) {
            <app-empty-state
              title="No contracts seeded"
              description="Seed a root → spot mapping (e.g. 6E → EURUSD) so the futures→spot resolver has a chain to resolve."
            />
          } @else {
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Contract</th>
                    <th>Spot</th>
                    <th>Expiry</th>
                    <th>Roll</th>
                    <th class="num">Back-adjust</th>
                    <th>Ingested through</th>
                  </tr>
                </thead>
                <tbody>
                  @for (c of s.contracts; track c.contractCode) {
                    <tr [class.front]="c.isFrontMonth">
                      <td>
                        <code>{{ c.contractCode }}</code>
                        @if (c.isFrontMonth) {
                          <span class="pill">front</span>
                        }
                      </td>
                      <td>{{ c.spotSymbol }}</td>
                      <td>{{ c.expiryDate | date: 'yyyy-MM-dd' }}</td>
                      <td>{{ c.rollDate ? (c.rollDate | date: 'yyyy-MM-dd') : '—' }}</td>
                      <td class="num">{{ c.priceAdjustment | number: '1.0-5' }}</td>
                      <td>
                        {{
                          c.lastTradeEventTimestamp
                            ? (c.lastTradeEventTimestamp | relativeTime)
                            : '—'
                        }}
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>

        <!-- ── The decisive experiment ───────────────────────────────── -->
        <section class="card">
          <header class="card-head">
            <h3>Decisive experiment — real delta vs tick-rule proxy</h3>
            <span class="muted small">
              Same strategy, same events, one variable. A positive and fold-consistent delta is the
              go/no-go for the whole data spend.
            </span>
          </header>

          <div class="toolbar">
            <input class="input sm" placeholder="Contract (6EU5)" [(ngModel)]="expContract" />
            <input class="input sm" type="date" [(ngModel)]="expFrom" />
            <input class="input sm" type="date" [(ngModel)]="expTo" />
            <input class="input xs" type="number" min="1" max="50" [(ngModel)]="expFolds" />
            <button
              type="button"
              class="btn btn-primary"
              [disabled]="busy() || !expContract"
              (click)="runExperiment()"
            >
              Run experiment
            </button>
          </div>

          @if (experiment(); as x) {
            @if (!x.ran) {
              <p class="muted small">
                Not scored — <code>{{ x.reason }}</code>
                @if (x.reason === 'no_data') {
                  · ingest a Databento slice for this contract/window first.
                }
              </p>
            } @else {
              <div class="verdict" [attr.data-good]="x.oosNetPnlDelta > 0">
                <div class="verdict-headline">
                  {{
                    x.oosNetPnlDelta > 0
                      ? 'Real flow beat the proxy'
                      : 'Real flow did NOT beat the proxy'
                  }}
                </div>
                <div class="verdict-sub muted small">
                  OOS net-PnL delta {{ x.oosNetPnlDelta | number: '1.2-2' }} · PF delta
                  {{ x.oosProfitFactorDelta | number: '1.2-2' }} ·
                  {{ x.fractionFoldsRealBeatsProxy * 100 | number: '1.0-0' }}% of
                  {{ x.foldsScored }} folds · {{ x.eventsLoaded | number }} events
                </div>
              </div>

              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Arm</th>
                      <th class="num">Net PnL</th>
                      <th class="num">Profit factor</th>
                      <th class="num">Trades</th>
                      <th class="num">Win rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (arm of [x.real, x.proxy]; track arm.name) {
                      <tr>
                        <td>
                          <strong>{{
                            arm.name === 'real' ? 'Real aggressor' : 'Tick-rule proxy'
                          }}</strong>
                        </td>
                        <td class="num">{{ arm.netPnl | number: '1.2-2' }}</td>
                        <td class="num">{{ arm.profitFactor | number: '1.2-2' }}</td>
                        <td class="num">{{ arm.tradeCount }}</td>
                        <td class="num">{{ arm.winRate * 100 | number: '1.0-1' }}%</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          } @else {
            <p class="muted small">
              Run the experiment for an ingested contract/window to get a verdict.
            </p>
          }
        </section>

        <!-- ── Shadow monitor ────────────────────────────────────────── -->
        <section class="card">
          <header class="card-head">
            <h3>Shadow monitor — would-have signals</h3>
            <span class="muted small">
              Recorded, never traded. Prove precision here before enabling a live
              CmeDeepBookOrderflow strategy.
            </span>
          </header>

          @if (s.recentShadowSignals.length === 0) {
            <app-empty-state
              title="No shadow signals yet"
              description="The shadow monitor ships disabled (Microstructure:SignalEnabled=false) and needs live CME flow."
            />
          } @else {
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Symbol</th>
                    <th>Would-have</th>
                    <th class="num">Confidence</th>
                    <th class="num">Delta</th>
                    <th class="num">Imbalance</th>
                    <th class="num">Basis</th>
                  </tr>
                </thead>
                <tbody>
                  @for (sig of s.recentShadowSignals; track sig.id) {
                    <tr>
                      <td>{{ sig.evaluatedAt | relativeTime }}</td>
                      <td>{{ sig.symbol }}</td>
                      <td>
                        <span class="dot" [style.background]="dirColor(sig.direction)"></span>
                        {{ sig.direction }}
                      </td>
                      <td class="num">{{ sig.confidence | number: '1.2-2' }}</td>
                      <td class="num">{{ sig.cumulativeDelta | number: '1.0-0' }}</td>
                      <td class="num">{{ sig.bookImbalanceTop5 | number: '1.2-2' }}</td>
                      <td class="num">
                        {{ sig.basis === null ? '—' : (sig.basis | number: '1.0-5') }}
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>
      }
    </div>
  `,
  styles: [
    `
      .kpis {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 12px;
        margin-bottom: 16px;
      }
      .banner {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-left: 3px solid #ff9500;
        border-radius: var(--radius-lg);
        padding: 12px 16px;
        margin-bottom: 16px;
        font-size: 13px;
        color: var(--text-secondary);
      }
      .banner strong {
        color: var(--text-primary);
        margin-right: 6px;
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        padding: 16px;
        margin-bottom: 16px;
      }
      .card-head {
        display: flex;
        flex-direction: column;
        gap: 4px;
        margin-bottom: 12px;
      }
      .card-head h3 {
        margin: 0;
        font-size: 15px;
        font-weight: var(--font-bold);
      }
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        margin-bottom: 12px;
      }
      .input {
        height: 30px;
        padding: 0 8px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-family: inherit;
        font-size: 12px;
      }
      .input.sm {
        width: 140px;
      }
      .input.xs {
        width: 70px;
      }
      .table-wrap {
        overflow-x: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }
      th,
      td {
        padding: 8px 12px;
        text-align: left;
        border-bottom: 1px solid var(--border);
        white-space: nowrap;
      }
      th {
        font-weight: var(--font-bold);
        color: var(--text-secondary);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      tr.front code {
        font-weight: var(--font-bold);
      }
      .pill {
        margin-left: 6px;
        padding: 1px 6px;
        border-radius: 999px;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        font-size: 10px;
        color: var(--text-tertiary);
      }
      .verdict {
        border: 1px solid var(--border);
        border-left: 3px solid #ff3b30;
        border-radius: var(--radius-sm);
        padding: 10px 14px;
        margin-bottom: 12px;
      }
      .verdict[data-good='true'] {
        border-left-color: #34c759;
      }
      .verdict-headline {
        font-weight: var(--font-bold);
        font-size: 14px;
      }
      .dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        margin-right: 4px;
        vertical-align: middle;
      }
      .muted {
        color: var(--text-tertiary);
      }
      .small {
        font-size: 12px;
      }
      .btn {
        height: 30px;
        padding: 0 12px;
        border-radius: var(--radius-sm);
        font-weight: var(--font-semibold);
        font-size: 12px;
        cursor: pointer;
        font-family: inherit;
        border: 1px solid var(--border);
      }
      .btn-secondary {
        background: var(--bg-primary);
        color: var(--text-primary);
      }
      .btn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
    `,
  ],
})
export class CmeMicrostructurePageComponent {
  private readonly cme = inject(CmeMicrostructureService);
  private readonly notify = inject(NotificationService);

  protected readonly status = signal<CmeStatusDto | null>(null);
  protected readonly experiment = signal<CmeOrderflowExperimentResultDto | null>(null);
  protected readonly loading = signal(false);
  protected readonly busy = signal(false);
  protected readonly loadError = signal<string | null>(null);

  // Seed form
  protected seedRoot = '6E';
  protected seedSpot = 'EURUSD';
  protected seedFrom = isoDate(-365);
  protected seedTo = isoDate(365);

  // Experiment form
  protected expContract = '';
  protected expFrom = isoDate(-90);
  protected expTo = isoDate(0);
  protected expFolds = 5;

  protected readonly hasData = computed(() => (this.status()?.tradeCount ?? 0) > 0);

  constructor() {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.cme
      .getStatus()
      .pipe(
        finalize(() => this.loading.set(false)),
        catchError((err) => {
          this.loadError.set(
            err?.error?.message ?? 'The engine returned an error. Verify it is reachable.',
          );
          return of(null);
        }),
      )
      .subscribe((res) => {
        if (res?.status && res.data) {
          this.status.set(res.data);
          this.loadError.set(null);
          // Default the experiment contract to the resolved front month.
          if (!this.expContract && res.data.frontMonthContract) {
            this.expContract = res.data.frontMonthContract;
          }
        }
      });
  }

  protected seed(): void {
    this.run(
      this.cme.seedContracts({
        rootSymbol: this.seedRoot,
        spotSymbol: this.seedSpot,
        fromUtc: `${this.seedFrom}T00:00:00Z`,
        toUtc: `${this.seedTo}T00:00:00Z`,
      }),
      (n) => `Seeded ${n} contract(s).`,
    );
  }

  protected backAdjust(): void {
    this.run(this.cme.backAdjust(this.seedRoot), (n) => `Back-adjusted ${n} contract(s).`);
  }

  protected runExperiment(): void {
    this.busy.set(true);
    this.cme
      .runExperiment({
        contract: this.expContract,
        fromUtc: `${this.expFrom}T00:00:00Z`,
        toUtc: `${this.expTo}T00:00:00Z`,
        oosFolds: this.expFolds,
      })
      .pipe(
        finalize(() => this.busy.set(false)),
        catchError((err) => {
          this.notify.error(err?.error?.message ?? 'Experiment failed.');
          return of(null);
        }),
      )
      .subscribe((res) => {
        if (res === null) return;
        if (res.status && res.data) {
          this.experiment.set(res.data);
          this.notify.success(
            res.data.ran ? 'Experiment complete.' : `Not scored: ${res.data.reason}`,
          );
        } else {
          this.notify.error(res.message ?? 'Experiment failed.');
        }
      });
  }

  /** Shared command runner: toast the outcome (including a meaningful "0 written") and refresh. */
  private run(
    call: import('rxjs').Observable<{
      status: boolean;
      data: number | null;
      message: string | null;
    }>,
    success: (n: number) => string,
  ): void {
    this.busy.set(true);
    call
      .pipe(
        finalize(() => this.busy.set(false)),
        catchError((err) => {
          this.notify.error(err?.error?.message ?? 'Request failed.');
          return of(null);
        }),
      )
      .subscribe((res) => {
        if (res === null) return;
        if (res.status) {
          this.notify.success(success(res.data ?? 0));
          this.load();
        } else {
          this.notify.error(res.message ?? 'Request failed.');
        }
      });
  }

  protected dirColor(direction: string): string {
    return direction === 'Buy' ? '#34C759' : '#FF3B30';
  }
}

/** yyyy-MM-dd offset from today — for the date inputs. */
function isoDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
