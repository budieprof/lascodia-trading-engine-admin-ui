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
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { finalize } from 'rxjs';

import { ScriptStrategyService } from '@features/scripting/api/script-strategy.service';
import type {
  PortfolioReadiness,
  PortfolioReadinessItem,
} from '@features/scripting/api/scripting-api.types';
import { RefreshButtonComponent } from '@shared/components/refresh-button/refresh-button.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

/** The text and tone of a checklist status. */
export function readinessStatusLabel(status: PortfolioReadinessItem['status']): {
  text: string;
  tone: 'ok' | 'bad' | 'wait' | 'manual' | 'info';
} {
  switch (status) {
    case 'pass':
      return { text: 'Pass', tone: 'ok' };
    case 'fail':
      return { text: 'Fail', tone: 'bad' };
    case 'pending':
      return { text: 'Pending', tone: 'wait' };
    case 'manual':
      return { text: 'Operator drill', tone: 'manual' };
    default:
      return { text: 'Info', tone: 'info' };
  }
}

/**
 * What the console knows of the portfolio walk-forward (b11-portfolio-research adds `portfolioWalkForwardRunId` to the strategy
 * DTO): `undefined` = an engine build without the field, `null` = none yet, a number = the run.
 */
export function walkForwardText(id: number | null | undefined): string {
  if (id === undefined) return 'Not available on this engine build.';
  if (id === null) return 'None yet — a portfolio walk-forward has not been run for this strategy.';
  return `Portfolio walk-forward run #${id}`;
}

/**
 * b11-portfolio-hardening: a `//@lascodia-portfolio` strategy's readiness to leave Paper / be activated, from
 * `GET strategy/{id}/script/portfolio/readiness` — the checklist (member feeds, bar grids, evidence, paper, mode, capacity, the
 * live record, drills), the members with their feed and capacity, its portfolio evidence run and its portfolio walk-forward.
 * Read-only: nothing here changes the strategy.
 */
@Component({
  selector: 'app-portfolio-readiness-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, RouterLink, RefreshButtonComponent, RelativeTimePipe],
  template: `
    <section class="panel" aria-labelledby="portfolio-readiness-title">
      <header class="panel-head">
        <h3 id="portfolio-readiness-title">Portfolio readiness</h3>
        @if (readiness(); as r) {
          <span class="pill" [class.ok]="r.ready" [class.bad]="!r.ready" data-testid="portfolio-ready">
            {{ r.ready ? 'Ready (drills aside)' : 'Not ready' }}
          </span>
        }
        <app-refresh-button
          variant="outline"
          [refreshing]="loading()"
          (refresh)="load()"
        />
      </header>

      @if (error(); as e) {
        <p class="muted error" role="alert">{{ e }}</p>
      } @else if (readiness(); as r) {
        <p class="muted small">
          {{ r.members.length }} members · accounts <strong>{{ r.accountModel }}</strong> (ScriptLive:Portfolio:MemberAccount) ·
          live mode <strong>{{ r.mode }}</strong> · stage {{ r.lifecycleStage }}
        </p>

        <ul class="checklist" data-testid="portfolio-checklist">
          @for (item of r.checklist; track item.key) {
            <li [attr.data-key]="item.key">
              <span class="status" [attr.data-tone]="label(item.status).tone">{{ label(item.status).text }}</span>
              <div>
                <strong>{{ item.title }}</strong>
                <p class="muted small">{{ item.detail }}</p>
              </div>
            </li>
          }
        </ul>

        <h4 class="sub">Members</h4>
        <div class="table-wrap" tabindex="0" role="region" aria-label="Portfolio members">
          <table data-testid="portfolio-members">
            <thead>
              <tr>
                <th scope="col">Symbol</th>
                <th scope="col">Data feed</th>
                <th scope="col">Newest heartbeat</th>
                <th scope="col" class="num">Capacity (lots)</th>
              </tr>
            </thead>
            <tbody>
              @for (m of members(); track m.symbol) {
                <tr>
                  <td>{{ m.symbol }}</td>
                  <td [class.loss]="!m.serving" [title]="m.detail">
                    {{ m.serving ? m.instances + ' EA instance(s)' : 'No serving EA' }}
                  </td>
                  <td>{{ m.heartbeat ? (m.heartbeat | relativeTime) : '—' }}</td>
                  <td class="num">
                    {{ m.capacity === null ? 'not estimated' : (m.capacity | number: '1.0-2') }}
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        @if (r.estimatedCapacityLots !== null) {
          <p class="muted small">
            Strategy capacity (the smallest member's): {{ r.estimatedCapacityLots | number: '1.0-2' }} lots.
          </p>
        }

        <dl class="kv">
          <div>
            <dt>Portfolio evidence</dt>
            <dd data-testid="portfolio-evidence">
              @if (r.evidencePortfolioBacktestRunId !== null) {
                <a [routerLink]="['/portfolio-backtests', r.evidencePortfolioBacktestRunId]"
                  >Portfolio backtest #{{ r.evidencePortfolioBacktestRunId }}</a
                >
              }
              <span class="muted small">{{ r.evidenceDetail }}</span>
            </dd>
          </div>
          <div>
            <dt>Portfolio walk-forward</dt>
            <dd data-testid="portfolio-walk-forward">{{ walkForward() }}</dd>
          </div>
          @if (r.grid; as g) {
            <div>
              <dt>Bar grids</dt>
              <dd>
                <span [class.loss]="!!g.refusal">{{ g.refusal ?? g.detail }}</span>
              </dd>
            </div>
          }
          <div>
            <dt>Live record (30 d)</dt>
            <dd data-testid="portfolio-live-record">
              {{ r.holdTimeouts }} hold timeout(s) · {{ r.barRevised }} late candle(s) ·
              {{ r.outOfOrderBars }} bar(s) out of order
            </dd>
          </div>
        </dl>
      } @else if (loading()) {
        <p class="muted small"><span class="spinner"></span> Loading…</p>
      }
    </section>
  `,
  styles: [
    `
      .panel-head {
        display: flex;
        align-items: center;
        gap: var(--space-3, 12px);
      }
      .panel-head h3 {
        margin: 0;
        flex: 1;
      }
      .pill {
        border-radius: var(--radius-full, 999px);
        padding: 2px 10px;
        font-size: 12px;
        border: 1px solid var(--border);
      }
      .pill.ok {
        color: var(--success, #15803d);
      }
      .pill.bad {
        color: var(--danger, #b91c1c);
      }
      .checklist {
        list-style: none;
        padding: 0;
        margin: var(--space-3, 12px) 0;
        display: grid;
        gap: var(--space-2, 8px);
      }
      .checklist li {
        display: grid;
        grid-template-columns: 112px 1fr;
        gap: var(--space-3, 12px);
        align-items: start;
      }
      .checklist p {
        margin: 2px 0 0;
      }
      .status {
        font-size: 12px;
        font-weight: 600;
        padding: 2px 8px;
        border-radius: var(--radius-sm, 4px);
        border: 1px solid var(--border);
        text-align: center;
      }
      .status[data-tone='ok'] {
        color: var(--success, #15803d);
      }
      .status[data-tone='bad'] {
        color: var(--danger, #b91c1c);
      }
      .status[data-tone='wait'] {
        color: var(--warning, #b45309);
      }
      .sub {
        margin: var(--space-4, 16px) 0 var(--space-2, 8px);
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
        text-align: left;
        padding: 4px 8px;
        border-bottom: 1px solid var(--border);
      }
      .num {
        text-align: right;
      }
      .loss {
        color: var(--danger, #b91c1c);
      }
      .kv {
        display: grid;
        gap: var(--space-2, 8px);
        margin-top: var(--space-4, 16px);
      }
      .kv div {
        display: grid;
        grid-template-columns: 160px 1fr;
        gap: var(--space-3, 12px);
      }
      .kv dd {
        margin: 0;
        display: grid;
        gap: 2px;
      }
      .error {
        color: var(--danger, #b91c1c);
      }
    `,
  ],
})
export class PortfolioReadinessCardComponent {
  private readonly scripts = inject(ScriptStrategyService);

  readonly strategyId = input.required<number>();
  /**
   * The strategy DTO's `portfolioWalkForwardRunId` (b11-portfolio-research): `undefined` when the engine build does not send it,
   * `null` when none was run.
   */
  readonly portfolioWalkForwardRunId = input<number | null | undefined>(undefined);

  readonly readiness = signal<PortfolioReadiness | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  readonly walkForward = computed(() => walkForwardText(this.portfolioWalkForwardRunId()));

  /** Each member with its feed and capacity side by side. */
  readonly members = computed(() => {
    const r = this.readiness();
    if (!r) return [];
    return r.members.map((symbol) => {
      const feed = r.feeds.find((f) => f.symbol === symbol);
      const cap = r.capacity.find((c) => c.symbol === symbol);
      return {
        symbol,
        serving: feed?.serving ?? false,
        instances: feed?.instances ?? 0,
        heartbeat: feed?.newestHeartbeatUtc ?? null,
        detail: feed?.detail ?? '',
        capacity: cap?.capacityCeilingLots ?? null,
      };
    });
  });

  readonly label = readinessStatusLabel;

  constructor() {
    effect(() => {
      this.strategyId();
      untracked(() => this.load());
    });
  }

  load(): void {
    const id = this.strategyId();
    this.loading.set(true);
    this.scripts
      .getPortfolioReadiness(id)
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (res) => {
          if (res.status && res.data) {
            this.readiness.set(res.data);
            this.error.set(null);
          } else {
            this.error.set(res.message || 'The engine did not answer the portfolio readiness.');
          }
        },
        error: () => this.error.set('Could not load the portfolio readiness.'),
      });
  }
}
