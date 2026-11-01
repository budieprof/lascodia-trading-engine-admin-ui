import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';

import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { failureMessage } from '@features/organisation/organisation.logic';

import { RiskApiService } from '../risk-api.service';
import { breachLabels, formatMoney, formatNumber, isBreach } from '../risk.logic';
import type { StressResult } from '../risk.types';

/**
 * The latest result of every scenario for one account, worst first, with the per-position drill-down; "Run now" runs every
 * active scenario (stored as Manual; a margin call / stop-out / drawdown breach raises a PortfolioRisk alert).
 */
@Component({
  selector: 'app-risk-stress',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, ConfirmDialogComponent],
  styleUrl: '../risk.scss',
  template: `
    <section class="card" aria-labelledby="st-title">
      <header class="card-head">
        <h3 id="st-title">Stress test results</h3>
        @if (canManage()) {
          <button type="button" class="btn btn-primary btn-sm" (click)="confirmOpen.set(true)" [disabled]="running()">
            {{ running() ? 'Running…' : accountId() === null ? 'Run every scenario on every account' : 'Run every scenario now' }}
          </button>
        }
      </header>
      @if (message(); as m) { <p class="pad small" role="status">{{ m }}</p> }
      @if (accountId() === null) {
        <p class="pad small muted">Pick an account to see its latest result per scenario. The weekly run and "Run now" store a result per account and scenario.</p>
      } @else if (error()) {
        <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ error() }}</p>
      } @else {
        <div class="table-wrap">
          <table class="grid">
            <thead><tr><th>Scenario</th><th class="num">P&amp;L</th><th class="num">% equity</th><th class="num">Equity after</th><th class="num">Margin level after</th><th>Breaches</th><th>Run</th></tr></thead>
            <tbody>
              @for (r of results(); track r.id) {
                <tr class="clickable" [class.selected]="selected()?.id === r.id" (click)="selected.set(r)" tabindex="0" (keydown.enter)="selected.set(r)">
                  <td>{{ r.scenarioName }} <span class="small muted">{{ r.scenarioType }}</span></td>
                  <td class="num" [class.neg]="r.stressedPnl < 0">{{ money(r.stressedPnl, r.currency) }}</td>
                  <td class="num">{{ num(r.stressedPnlPct) }} %</td>
                  <td class="num">{{ money(r.postStressEquity, r.currency) }}</td>
                  <td class="num">{{ r.postStressMarginLevelPct !== null ? num(r.postStressMarginLevelPct, 0) + ' %' : '—' }}</td>
                  <td>
                    @for (b of breaches(r); track b) { <span class="chip bad">{{ b }}</span> } @empty { <span class="chip ok">None</span> }
                  </td>
                  <td class="small">{{ r.executedAt | date: 'd MMM, HH:mm' }} · {{ r.trigger ?? 'Scheduled' }}</td>
                </tr>
              } @empty {
                <tr><td colspan="7" class="muted">{{ loading() ? 'Loading…' : 'No stress result for this account in the last 35 days. Run now, or wait for the weekly run.' }}</td></tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>

    @if (selected(); as r) {
      <section class="card" aria-labelledby="imp-title">
        <header class="card-head"><h3 id="imp-title">{{ r.scenarioName }} — position impacts</h3>
          <button type="button" class="btn btn-secondary btn-sm" (click)="selected.set(null)">Close</button></header>
        @if (r.minimumShockPct !== null) { <p class="pad small">Minimum uniform adverse shock reaching the target loss: <strong>{{ num(r.minimumShockPct) }} %</strong>.</p> }
        <div class="table-wrap">
          <table class="grid">
            <thead><tr><th>Position</th><th>Symbol</th><th>Side</th><th class="num">Lots</th><th class="num">Notional</th><th class="num">Move</th><th>From</th><th class="num">P&amp;L</th></tr></thead>
            <tbody>
              @for (i of r.impacts; track $index) {
                <tr>
                  <td>#{{ i.positionId }}</td><td>{{ i.symbol }}</td><td>{{ i.direction ?? '—' }}</td><td class="num">{{ i.lots }}</td>
                  <td class="num">{{ money(i.notional, r.currency) }}</td><td class="num">{{ num(i.movePct) }} %</td>
                  <td class="small">{{ sourceLabel(i.source) }}</td>
                  <td class="num" [class.neg]="i.pnlImpact < 0">{{ money(i.pnlImpact, r.currency) }}</td>
                </tr>
              } @empty {
                <tr><td colspan="8" class="muted">The account had no open positions when this ran.</td></tr>
              }
            </tbody>
          </table>
        </div>
      </section>
    }

    <app-confirm-dialog
      [open]="confirmOpen()"
      title="Run stress tests now?"
      [message]="accountId() === null ? 'Runs every active scenario against every active account of the organisation and stores the results. Breaches raise alerts.' : 'Runs every active scenario against this account and stores the results. Breaches raise alerts.'"
      confirmLabel="Run now"
      [loading]="running()"
      (confirm)="run()"
      (cancelled)="confirmOpen.set(false)"
    />
  `,
})
export class RiskStressComponent {
  private readonly api = inject(RiskApiService);
  private readonly destroyRef = inject(DestroyRef);

  readonly accountId = input<number | null>(null);
  readonly canManage = input(false);

  readonly results = signal<StressResult[]>([]);
  readonly selected = signal<StressResult | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly running = signal(false);
  readonly confirmOpen = signal(false);
  readonly message = signal<string | null>(null);

  constructor() {
    effect(() => {
      const id = this.accountId();
      untracked(() => this.load(id));
    });
  }

  private load(id: number | null): void {
    this.selected.set(null);
    this.results.set([]);
    this.error.set(null);
    if (id === null) return;
    this.loading.set(true);
    const sub = this.api.latestStress(id).subscribe({
      next: (r) => {
        this.results.set(r);
        this.loading.set(false);
      },
      error: () => {
        this.error.set('The stress results did not load.');
        this.loading.set(false);
      },
    });
    this.destroyRef.onDestroy(() => sub.unsubscribe());
  }

  run(): void {
    this.running.set(true);
    this.api.runStress(this.accountId(), null).subscribe({
      next: (r) => {
        this.running.set(false);
        this.confirmOpen.set(false);
        const breaches = r.filter(isBreach).length;
        this.message.set(`${r.length} stress test(s) run, ${breaches} with a breach.`);
        this.load(this.accountId());
      },
      error: (err: unknown) => {
        this.running.set(false);
        this.confirmOpen.set(false);
        this.message.set(failureMessage(err, 'The stress tests could not be run.'));
      },
    });
  }

  protected breaches = breachLabels;
  protected money(v: number | null | undefined, ccy: string): string {
    return formatMoney(v, ccy);
  }
  protected num(v: number | null | undefined, d = 2): string {
    return formatNumber(v, d);
  }
  protected sourceLabel(s: string): string {
    switch (s) {
      case 'candles':
        return 'stored candles';
      case 'currency':
        return 'currency shock';
      case 'symbol':
        return 'symbol shock';
      case 'assetClass':
        return 'asset-class shock';
      case 'none':
        return 'not moved by this scenario';
      default:
        return s;
    }
  }
}
