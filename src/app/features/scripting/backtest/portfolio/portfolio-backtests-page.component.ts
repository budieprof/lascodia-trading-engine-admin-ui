import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { AuthService } from '@core/auth/auth.service';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

import { SCRIPTING_UI_STYLES } from '../../components/scripting-ui.styles';
import { formatDateTime, formatMoney, formatPercent } from '../../report/report-format';
import { ANALYST_PERMISSION } from '../../research/research-permissions';
import { describeFailure, isOk } from '../../shared/api-error';
import { ScriptDialogService } from '../../shared/script-dialog.service';
import { PortfolioBacktestApiService } from './portfolio-backtest-api.service';
import { PortfolioBacktestFormComponent } from './portfolio-backtest-form.component';
import { isActive, statusChip } from './portfolio-backtest.model';
import type { PortfolioRunSummary } from './portfolio-backtest.types';

/** How often the list re-reads while a run is queued or running. */
export const PORTFOLIO_POLL_MS = 5_000;

/**
 * Portfolio backtests (BT-I12 / BX-5): several script strategies trading one account on one bar clock. The newest runs
 * with their status and headline figures — re-read every 5 s while one is queued or running — and, for an analyst, the
 * form that queues a new one.
 */
@Component({
  selector: 'app-portfolio-backtests-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageHeaderComponent, RouterLink, PortfolioBacktestFormComponent],
  template: `
    <div class="page">
      <app-page-header
        title="Portfolio Backtests"
        subtitle="Several script strategies on one account: shared equity and margin, the live currency-exposure limits, one bar clock."
      >
        @if (canQueue()) {
          <button type="button" class="btn btn-primary" (click)="showForm.set(!showForm())" data-testid="pf-new">
            {{ showForm() ? 'Close the form' : 'New portfolio backtest' }}
          </button>
        }
      </app-page-header>

      @if (queuedId(); as id) {
        <p class="ok-box" role="status" data-testid="pf-queued">
          Portfolio backtest <a [routerLink]="['/portfolio-backtests', id]">#{{ id }}</a> is queued.
        </p>
      }
      @if (showForm() && canQueue()) {
        <app-portfolio-backtest-form (queued)="onQueued($event)" />
      }

      <section class="card" aria-labelledby="pf-runs-title" data-testid="pf-runs">
        <header class="head">
          <h2 id="pf-runs-title" class="title">Runs</h2>
          @if (polling()) {
            <span class="chip chip-accent">Updating while a run is going</span>
          }
          <span class="spacer"></span>
          <button type="button" class="btn btn-ghost btn-sm" (click)="reload()">Refresh</button>
        </header>
        @if (error(); as e) {
          <p class="error-box" role="alert">{{ e }}</p>
        }
        @if (runs().length === 0) {
          <p class="muted">{{ loading() ? 'Loading the runs…' : 'No portfolio backtest yet.' }}</p>
        } @else {
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Run</th>
                  <th scope="col">Status</th>
                  <th scope="col" class="num">Members</th>
                  <th scope="col">Window</th>
                  <th scope="col" class="num">Net profit</th>
                  <th scope="col" class="num">Return</th>
                  <th scope="col" class="num">Max drawdown</th>
                  <th scope="col" class="num">Trades</th>
                  <th scope="col" class="num">Refused</th>
                  <th scope="col">Queued</th>
                  <th scope="col"><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                @for (r of runs(); track r.id) {
                  <tr [attr.data-run]="r.id">
                    <td>
                      <a [routerLink]="['/portfolio-backtests', r.id]" class="mono">#{{ r.id }}</a>
                      <span class="block">{{ r.name }}</span>
                    </td>
                    <td>
                      <span [class]="'chip ' + chip(r)">{{ r.status }}</span>
                      @if (r.stage && active(r)) {
                        <span class="muted small block">{{ r.stage }}</span>
                      }
                      @if (r.status === 'Failed' && r.errorMessage) {
                        <span class="muted small block">{{ r.errorMessage }}</span>
                      }
                    </td>
                    <td class="num">{{ r.memberCount }}</td>
                    <td class="small">{{ r.fromDate.slice(0, 10) }} → {{ r.toDate.slice(0, 10) }}</td>
                    <td class="num">{{ money(r.netProfit, r.accountCurrency) }}</td>
                    <td class="num">{{ pct(r.totalReturnPct, true) }}</td>
                    <td class="num">{{ pct(r.maxDrawdownPct) }}</td>
                    <td class="num">{{ r.totalTrades ?? '—' }}</td>
                    <td class="num">{{ r.refusedEntries ?? '—' }}</td>
                    <td class="small">{{ when(r.queuedAt) }}<span class="muted block">{{ r.queuedBy ?? '' }}</span></td>
                    <td class="actions">
                      @if (canQueue()) {
                        @if (active(r)) {
                          <button
                            type="button"
                            class="btn btn-sm"
                            (click)="cancel(r)"
                            [disabled]="r.cancelRequested"
                            [attr.data-testid]="'pf-cancel-' + r.id"
                          >
                            {{ r.cancelRequested ? 'Stopping…' : 'Cancel…' }}
                          </button>
                        } @else {
                          <button
                            type="button"
                            class="btn btn-sm btn-danger"
                            (click)="remove(r)"
                            [attr.data-testid]="'pf-delete-' + r.id"
                          >
                            Delete…
                          </button>
                        }
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>
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
      .head { display: flex; align-items: center; gap: 8px; }
      .title { margin: 0; font-size: var(--text-base); font-weight: var(--font-semibold); }
      .spacer { flex: 1; }
      .table-wrap { overflow-x: auto; }
      table { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
      th, td { padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; font-weight: normal; }
      thead th { font-size: var(--text-xs); color: var(--text-secondary); }
      .num { text-align: right; font-variant-numeric: tabular-nums; }
      .block { display: block; margin-top: 2px; }
      .actions { white-space: nowrap; }
      .ok-box { margin: 0; padding: 8px 12px; border-radius: 8px; background: rgba(52, 199, 89, 0.12); font-size: 13px; }
      .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); }
      p { margin: 0; }
    `,
  ],
})
export class PortfolioBacktestsPageComponent implements OnInit {
  private readonly api = inject(PortfolioBacktestApiService);
  private readonly auth = inject(AuthService);
  private readonly dialogs = inject(ScriptDialogService);

  /** Queue, cancel and delete are `access.analyst` on the engine. */
  readonly canQueue = computed(() => this.auth.hasPermission(ANALYST_PERMISSION));
  readonly runs = signal<PortfolioRunSummary[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly polling = signal(false);
  readonly showForm = signal(false);
  readonly queuedId = signal<number | null>(null);

  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stopPolling());
  }

  ngOnInit(): void {
    void this.reload();
  }

  active(r: PortfolioRunSummary): boolean {
    return isActive(r.status);
  }
  chip(r: PortfolioRunSummary): string {
    return statusChip(r.status);
  }
  money(v: number | null, currency: string): string {
    return formatMoney(v, currency, { signed: true });
  }
  pct(v: number | null, signed = false): string {
    return formatPercent(v, { signed });
  }
  when(iso: string | null): string {
    return iso ? `${formatDateTime(Date.parse(iso))} UTC` : '—';
  }

  async reload(): Promise<void> {
    this.stopPolling();
    this.loading.set(true);
    try {
      const res = await firstValueFrom(this.api.list());
      if (!isOk(res)) throw res;
      const runs = res.data ?? [];
      this.runs.set(runs);
      this.error.set(null);
      if (runs.some((r) => isActive(r.status))) this.schedule();
    } catch (err) {
      this.error.set(describeFailure(err, 'The portfolio backtests could not be read.'));
    } finally {
      this.loading.set(false);
    }
  }

  onQueued(id: number): void {
    this.queuedId.set(id);
    this.showForm.set(false);
    void this.reload();
  }

  async cancel(r: PortfolioRunSummary): Promise<void> {
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
    await this.act(() => firstValueFrom(this.api.cancel(r.id)), 'The run could not be cancelled.');
  }

  async remove(r: PortfolioRunSummary): Promise<void> {
    const ok = await this.dialogs.confirm({
      title: `Delete portfolio backtest #${r.id}?`,
      message: 'It leaves the list with its findings.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    await this.act(() => firstValueFrom(this.api.remove(r.id)), 'The run could not be deleted.');
  }

  private async act(call: () => Promise<{ status?: boolean } | null | undefined>, fallback: string): Promise<void> {
    try {
      const res = await call();
      if (!res?.status) throw res;
      await this.reload();
    } catch (err) {
      this.error.set(describeFailure(err, fallback));
    }
  }

  private schedule(): void {
    this.polling.set(true);
    this.timer = setTimeout(() => void this.reload(), PORTFOLIO_POLL_MS);
  }

  private stopPolling(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.polling.set(false);
  }
}
