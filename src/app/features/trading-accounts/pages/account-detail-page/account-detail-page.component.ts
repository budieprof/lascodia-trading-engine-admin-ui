import {
  Component,
  ChangeDetectionStrategy,
  DestroyRef,
  OnInit,
  OnDestroy,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { CurrencyPipe, DatePipe } from '@angular/common';
import { Subject, catchError, forkJoin, of, takeUntil, timer } from 'rxjs';

import { TradingAccountsService } from '@core/services/trading-accounts.service';
import { EAInstancesService } from '@core/services/ea-instances.service';
import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { CurrencyPairDto, EAInstanceDto, TradingAccountDto } from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

@Component({
  selector: 'app-account-detail-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CurrencyPipe, DatePipe, PageHeaderComponent, MetricCardComponent, RelativeTimePipe],
  template: `
    <div class="page">
      <app-page-header
        [title]="account()?.accountName ?? 'Account #' + (accountId() ?? '—')"
        [subtitle]="subtitle()"
      >
        <button class="btn btn-secondary" (click)="goBack()">← Back</button>
        <button class="btn btn-secondary" (click)="loadAll()" [disabled]="loading()">
          {{ loading() ? 'Refreshing…' : '↻ Refresh' }}
        </button>
      </app-page-header>

      @if (loading() && !account()) {
        <div class="empty-state"><span class="muted">Loading account…</span></div>
      } @else if (!account()) {
        <div class="empty-state">
          <span class="muted">Account #{{ accountId() }} not found.</span>
          <span class="empty-hint">It may have been deleted, or the ID is invalid.</span>
        </div>
      } @else if (account(); as a) {
        <!-- ── Risk banner — only when broker thresholds are breached ─── -->
        @if (stopOutBreached() || marginCallBreached()) {
          <div class="risk-banner" [class.crit]="stopOutBreached()">
            <span class="risk-icon">⚠</span>
            <div class="risk-text">
              @if (stopOutBreached()) {
                <strong>Stop-out level breached.</strong>
                Margin level <span class="mono">{{ marginLevelPct().toFixed(1) }}%</span> ≤ stop-out
                <span class="mono">{{ a.marginSoStopOut }}%</span>
                — broker may force-liquidate open positions.
              } @else {
                <strong>Margin call level reached.</strong>
                Margin level <span class="mono">{{ marginLevelPct().toFixed(1) }}%</span> ≤ margin
                call <span class="mono">{{ a.marginSoCall }}%</span>
                — add funds or close positions before stop-out at
                <span class="mono">{{ a.marginSoStopOut }}%</span>.
              }
            </div>
          </div>
        }

        <!-- ── Primary KPI strip — top-line money metrics ────────── -->
        <div class="kpi-strip">
          <app-metric-card
            label="Balance"
            [value]="a.balance"
            format="currency"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="Equity"
            [value]="a.equity"
            format="currency"
            [dotColor]="a.equity >= a.balance ? '#34C759' : '#FF3B30'"
            [delta]="a.equity - a.balance"
          />
          <app-metric-card
            label="Floating P&L"
            [value]="a.profit"
            format="currency"
            [dotColor]="a.profit >= 0 ? '#34C759' : '#FF3B30'"
            [colorByValue]="true"
          />
          <app-metric-card label="Credit" [value]="a.credit" format="currency" dotColor="#AF52DE" />
        </div>

        <!-- ── Secondary KPI strip — margin / freshness ──────────── -->
        <div class="kpi-strip">
          <app-metric-card
            label="Margin used"
            [value]="a.marginUsed"
            format="currency"
            [dotColor]="marginUtilizationPct() > 80 ? '#FF3B30' : '#FF9500'"
          />
          <app-metric-card
            label="Free margin"
            [value]="a.marginAvailable"
            format="currency"
            [dotColor]="a.marginAvailable > 0 ? '#34C759' : '#FF3B30'"
          />
          <app-metric-card
            label="Margin level"
            [value]="marginLevelDisplay()"
            format="percent"
            [dotColor]="marginLevelStatus()"
          />
          <app-metric-card
            label="Sync age (s)"
            [value]="syncAgeSec()"
            format="number"
            [dotColor]="syncAgeSec() !== null && syncAgeSec()! > 60 ? '#FF3B30' : '#34C759'"
          />
        </div>

        <!-- ── Two-column main row ──────────────────────────────── -->
        <div class="detail-row">
          <!-- Account specs card -->
          <section class="detail-card">
            <header class="card-head">
              <h3>Account specs</h3>
            </header>
            <dl class="spec-grid">
              <div>
                <dt>Engine ID</dt>
                <dd class="mono">{{ a.id }}</dd>
              </div>
              <div>
                <dt>Broker</dt>
                <dd>{{ a.brokerName ?? '—' }}</dd>
              </div>
              <div>
                <dt>Broker server</dt>
                <dd class="mono">{{ a.brokerServer ?? '—' }}</dd>
              </div>
              <div>
                <dt>Broker account</dt>
                <dd class="mono">{{ a.accountId ?? '—' }}</dd>
              </div>
              <div>
                <dt>Name</dt>
                <dd>{{ a.accountName ?? '—' }}</dd>
              </div>
              <div>
                <dt>Account type</dt>
                <dd>{{ a.accountType }}</dd>
              </div>
              <div>
                <dt>Leverage</dt>
                <dd class="mono">1:{{ a.leverage }}</dd>
              </div>
              <div>
                <dt>Margin mode</dt>
                <dd>{{ a.marginMode }}</dd>
              </div>
              <div>
                <dt>Currency</dt>
                <dd class="mono">{{ a.currency ?? '—' }}</dd>
              </div>
              <div>
                <dt>Mode</dt>
                <dd>
                  <span class="mode-pill" [class.paper]="a.isPaper" [class.live]="!a.isPaper">
                    {{ a.isPaper ? 'Paper' : 'Live' }}
                  </span>
                </dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>
                  <span
                    class="status-pill"
                    [class.active]="a.isActive"
                    [class.inactive]="!a.isActive"
                  >
                    {{ a.isActive ? 'Active' : 'Inactive' }}
                  </span>
                </dd>
              </div>
              <div>
                <dt>Last synced</dt>
                <dd class="muted">
                  {{ a.lastSyncedAt | relativeTime }}
                  ·
                  <span class="mono">{{ a.lastSyncedAt | date: 'HH:mm:ss' }}</span>
                </dd>
              </div>
            </dl>
          </section>

          <!-- Balance / equity / margin breakdown -->
          <section class="detail-card">
            <header class="card-head">
              <h3>Equity composition</h3>
            </header>
            <div class="composition">
              <div class="comp-row">
                <span class="comp-label">Balance</span>
                <span class="comp-value mono">
                  {{ a.balance | currency: a.currency ?? 'USD' : 'symbol' : '1.2-2' }}
                </span>
              </div>
              <div
                class="comp-row"
                [class.profit]="unrealizedPnL() > 0"
                [class.loss]="unrealizedPnL() < 0"
              >
                <span class="comp-label">+ Unrealized</span>
                <span class="comp-value mono">
                  {{ unrealizedPnL() >= 0 ? '+' : ''
                  }}{{ unrealizedPnL() | currency: a.currency ?? 'USD' : 'symbol' : '1.2-2' }}
                </span>
              </div>
              <div class="comp-row total">
                <span class="comp-label">Equity</span>
                <span class="comp-value mono">
                  {{ a.equity | currency: a.currency ?? 'USD' : 'symbol' : '1.2-2' }}
                </span>
              </div>
              <div class="comp-divider"></div>
              <div class="comp-row">
                <span class="comp-label">Margin used</span>
                <span class="comp-value mono">
                  {{ a.marginUsed | currency: a.currency ?? 'USD' : 'symbol' : '1.2-2' }}
                </span>
              </div>
              <div class="comp-row total">
                <span class="comp-label">Free margin</span>
                <span class="comp-value mono">
                  {{ a.marginAvailable | currency: a.currency ?? 'USD' : 'symbol' : '1.2-2' }}
                </span>
              </div>
              <div class="health-row">
                <div class="health-stat">
                  <span class="comp-label">Margin used</span>
                  <span class="comp-value mono">
                    {{ a.marginUsed | currency: a.currency ?? 'USD' : 'symbol' : '1.2-2' }}
                  </span>
                </div>
                <div class="health-stat">
                  <span class="comp-label">Utilization</span>
                  <span class="comp-value mono" [class.loss]="marginUtilizationPct() > 80">
                    {{ marginUtilizationPct().toFixed(1) }}%
                  </span>
                </div>
              </div>
              <div class="util-bar-wrap">
                <div class="util-bar">
                  <span
                    class="util-fill"
                    [class.med]="marginUtilizationPct() > 50 && marginUtilizationPct() <= 75"
                    [class.high]="marginUtilizationPct() > 75"
                    [style.width.%]="Math.min(100, marginUtilizationPct())"
                  ></span>
                </div>
              </div>
              <div class="util-bar-wrap">
                <span class="comp-label">
                  Margin level ·
                  @if ((a.marginUsed ?? 0) > 0) {
                    {{ marginLevelPct() > 999 ? '> 999%' : marginLevelPct().toFixed(1) + '%' }}
                  } @else {
                    no margin used
                  }
                </span>
                <div class="util-bar">
                  <span
                    class="util-fill"
                    [class.high]="marginLevelPct() < 100"
                    [class.med]="marginLevelPct() < 200 && marginLevelPct() >= 100"
                    [style.width.%]="Math.min(100, marginLevelPct() / 5)"
                  ></span>
                </div>
                <small class="hint">
                  margin call &lt; 100% · stop-out &lt; 50% · scale shows 0–500% range
                </small>
              </div>
            </div>
          </section>
        </div>

        <!-- ── Risk thresholds + Symbol exposure (2-col) ───────── -->
        <div class="detail-row">
          <section class="detail-card">
            <header class="card-head">
              <h3>Risk thresholds</h3>
              <span class="muted">broker stop-out + operator caps</span>
            </header>
            <dl class="spec-grid">
              <div>
                <dt>Margin call level</dt>
                <dd class="mono" [class.loss]="marginCallBreached()">
                  {{ a.marginSoCall > 0 ? a.marginSoCall + '%' : '—' }}
                </dd>
              </div>
              <div>
                <dt>Stop-out level</dt>
                <dd class="mono" [class.loss]="stopOutBreached()">
                  {{ a.marginSoStopOut > 0 ? a.marginSoStopOut + '%' : '—' }}
                </dd>
              </div>
              <div>
                <dt>Stop-out mode</dt>
                <dd>{{ a.marginSoMode ?? '—' }}</dd>
              </div>
              <div>
                <dt>Current margin level</dt>
                <dd
                  class="mono"
                  [class.profit]="!marginCallBreached() && !stopOutBreached() && a.marginUsed > 0"
                  [class.loss]="marginCallBreached() || stopOutBreached()"
                >
                  @if (a.marginUsed > 0) {
                    {{ marginLevelPct() > 999 ? '> 999%' : marginLevelPct().toFixed(1) + '%' }}
                  } @else {
                    no margin used
                  }
                </dd>
              </div>
              <div>
                <dt>Daily loss cap</dt>
                <dd class="mono">
                  {{
                    a.maxAbsoluteDailyLoss > 0
                      ? (a.maxAbsoluteDailyLoss
                        | currency: a.currency ?? 'USD' : 'symbol' : '1.2-2')
                      : 'unbounded'
                  }}
                </dd>
              </div>
              <div>
                <dt>Account age</dt>
                <dd class="mono">
                  {{
                    accountAgeDays() === null
                      ? '—'
                      : accountAgeDays()!.toFixed(1) + ' d (since first EA reg.)'
                  }}
                </dd>
              </div>
            </dl>
          </section>

          <section class="detail-card">
            <header class="card-head">
              <h3>Symbol exposure</h3>
              <span class="muted">
                {{ symbolExposure().length }} symbol(s) owned by linked EAs
              </span>
            </header>
            @if (symbolExposure().length > 0) {
              <div class="exposure-list">
                @for (s of symbolExposure(); track s.symbol) {
                  <div
                    class="exposure-row"
                    [class.inactive]="!s.isActiveOnEngine"
                    [title]="
                      s.isActiveOnEngine
                        ? s.symbol + ' is an active currency pair on the engine'
                        : s.symbol +
                          ' is NOT in the engine\\'s active currency pairs — strategies cannot trade it until it is enabled'
                    "
                  >
                    <span class="exposure-symbol mono">{{ s.symbol }}</span>
                    <span class="exposure-count">{{ s.eaCount }} EA</span>
                    <span
                      class="exposure-status"
                      [class.active]="s.isActiveOnEngine"
                      [class.idle]="!s.isActiveOnEngine"
                    >
                      {{ s.isActiveOnEngine ? '● active' : '○ inactive' }}
                    </span>
                  </div>
                }
              </div>
            } @else {
              <div class="empty-state inline">
                <span class="muted">No symbols owned by EAs on this account.</span>
              </div>
            }
          </section>
        </div>

        <!-- ── Linked EA fleet ──────────────────────────────────── -->
        <section class="detail-card">
          <header class="card-head">
            <h3>Linked EA instances</h3>
            <span class="muted">
              {{ linkedEas().length }} EA(s) bound to <code>accountId={{ a.id }}</code>
            </span>
          </header>
          @if (linkedEas().length > 0) {
            <table class="grid-table">
              <thead>
                <tr>
                  <th>Instance</th>
                  <th>Status</th>
                  <th>Version</th>
                  <th>Role</th>
                  <th>Chart</th>
                  <th>Owned symbols</th>
                  <th>Registered</th>
                  <th>Last heartbeat</th>
                  <th class="num">Heartbeat age</th>
                </tr>
              </thead>
              <tbody>
                @for (ea of linkedEas(); track ea.instanceId) {
                  <tr>
                    <td class="mono ea-instance">{{ ea.instanceId }}</td>
                    <td>
                      <span
                        class="status-pill"
                        [class.active]="ea.status === 'Active'"
                        [class.idle]="ea.status === 'ShuttingDown'"
                        [class.down]="ea.status === 'Disconnected'"
                      >
                        {{ ea.status }}
                      </span>
                    </td>
                    <td class="mono muted">{{ ea.eaVersion || '—' }}</td>
                    <td>
                      @if (ea.isCoordinator) {
                        <span class="status-pill active">coordinator</span>
                      } @else {
                        <span class="muted">worker</span>
                      }
                    </td>
                    <td class="mono">
                      @if (ea.chartSymbol) {
                        {{ ea.chartSymbol }}
                        <span class="muted">· {{ ea.chartTimeframe || '—' }}</span>
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td>
                      @if (symbolsList(ea).length > 0) {
                        <div class="symbol-chips">
                          @for (s of symbolsList(ea); track s) {
                            <span class="symbol-chip">{{ s }}</span>
                          }
                        </div>
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td class="muted">{{ ea.registeredAt | relativeTime }}</td>
                    <td class="muted mono">{{ ea.lastHeartbeat | date: 'HH:mm:ss' }}</td>
                    <td
                      class="num mono"
                      [class.profit]="heartbeatAgeSec(ea) !== null && heartbeatAgeSec(ea)! < 30"
                      [class.loss]="heartbeatAgeSec(ea) !== null && heartbeatAgeSec(ea)! > 120"
                    >
                      {{ heartbeatAgeSec(ea) === null ? '—' : formatAge(heartbeatAgeSec(ea)!) }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <div class="empty-state inline">
              <span class="muted">No EAs are bound to this account.</span>
              <span class="empty-hint">
                Once an EA registers with <code>accountId = {{ a.id }}</code
                >, it appears here.
              </span>
            </div>
          }
        </section>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .page {
        padding: var(--space-2) 0;
      }

      .btn {
        height: 36px;
        padding: 0 var(--space-5);
        border: none;
        border-radius: var(--radius-full);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        font-family: inherit;
        cursor: pointer;
        transition: all 0.15s ease;
        display: inline-flex;
        align-items: center;
        gap: var(--space-1);
      }
      .btn:active {
        transform: scale(0.97);
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .btn-secondary {
        background: var(--bg-secondary);
        color: var(--text-primary);
        border: 1px solid var(--border);
      }

      /* ── Risk banner ──────────────────────────────────────────── */
      .risk-banner {
        display: flex;
        align-items: flex-start;
        gap: var(--space-2);
        margin-top: var(--space-3);
        padding: var(--space-3) var(--space-4);
        background: rgba(255, 149, 0, 0.1);
        color: #92400e;
        border: 1px solid rgba(255, 149, 0, 0.35);
        border-radius: var(--radius-md);
        font-size: var(--text-sm);
        line-height: 1.4;
      }
      .risk-banner.crit {
        background: rgba(255, 59, 48, 0.12);
        color: #991b1b;
        border-color: rgba(255, 59, 48, 0.35);
      }
      .risk-icon {
        font-size: 18px;
        line-height: 1;
        margin-top: 1px;
      }
      .risk-text strong {
        font-weight: var(--font-semibold);
      }

      /* ── Symbol exposure list ─────────────────────────────────── */
      .exposure-list {
        padding: var(--space-2) var(--space-4) var(--space-3);
        display: flex;
        flex-direction: column;
        gap: 4px;
        max-height: 360px;
        overflow-y: auto;
      }
      .exposure-row {
        display: grid;
        grid-template-columns: 1fr auto auto;
        align-items: center;
        gap: var(--space-3);
        padding: 4px 8px;
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
      }
      .exposure-row:hover {
        background: var(--bg-tertiary);
      }
      .exposure-row.inactive {
        opacity: 0.65;
      }
      .exposure-symbol {
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .exposure-count {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: 10.5px;
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
      }
      .exposure-status {
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        padding: 2px 8px;
        border-radius: 999px;
      }
      .exposure-status.active {
        background: rgba(52, 199, 89, 0.14);
        color: #15803d;
      }
      .exposure-status.idle {
        background: rgba(142, 142, 147, 0.18);
        color: var(--text-secondary);
      }

      /* ── KPI strip — 4 primary cards, wide enough for full currency. */
      .kpi-strip {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: var(--space-2);
        margin-top: var(--space-3);
      }
      @media (max-width: 1100px) {
        .kpi-strip {
          grid-template-columns: repeat(2, 1fr);
        }
      }
      @media (max-width: 560px) {
        .kpi-strip {
          grid-template-columns: 1fr;
        }
      }

      /* ── Two-column row ──────────────────────────────────────── */
      .detail-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-3);
        margin-top: var(--space-3);
        align-items: stretch;
      }
      @media (max-width: 1100px) {
        .detail-row {
          grid-template-columns: 1fr;
        }
      }
      .detail-row > .detail-card {
        display: flex;
        flex-direction: column;
      }
      .detail-row > .detail-card > .composition,
      .detail-row > .detail-card > .spec-grid {
        flex: 1;
      }

      .detail-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
        margin-top: var(--space-3);
      }
      .detail-row .detail-card {
        margin-top: 0;
      }
      .card-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .card-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      code {
        font-size: 11px;
        background: var(--bg-tertiary);
        padding: 1px 4px;
        border-radius: 3px;
        font-family: 'SF Mono', 'Fira Code', monospace;
      }

      /* ── Spec grid ───────────────────────────────────────────── */
      .spec-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-2) var(--space-4);
        margin: 0;
        padding: var(--space-3) var(--space-4);
      }
      .spec-grid > div {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .spec-grid dt {
        font-size: 9.5px;
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .spec-grid dd {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
      }

      /* ── Composition ─────────────────────────────────────────── */
      .composition {
        padding: var(--space-3) var(--space-4);
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .comp-row {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        font-size: var(--text-sm);
      }
      .comp-row.total {
        font-weight: var(--font-semibold);
        padding-top: 4px;
        border-top: 1px solid var(--border);
      }
      .comp-label {
        color: var(--text-secondary);
      }
      .comp-value {
        color: var(--text-primary);
      }
      .comp-row.profit .comp-value {
        color: var(--profit, #15803d);
      }
      .comp-row.loss .comp-value {
        color: var(--loss, #b91c1c);
      }
      .comp-divider {
        height: 1px;
        background: var(--border);
        margin: 4px 0;
      }
      .health-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-3);
        padding-top: 8px;
        border-top: 1px solid var(--border);
      }
      .health-stat {
        display: flex;
        flex-direction: column;
        gap: 2px;
        font-size: var(--text-sm);
      }
      .util-bar-wrap {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding-top: 2px;
      }
      .util-bar {
        position: relative;
        height: 8px;
        background: rgba(142, 142, 147, 0.18);
        border-radius: 4px;
        overflow: hidden;
      }
      .util-fill {
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        background: #0071e3;
        border-radius: 4px;
      }
      .util-fill.med {
        background: #ff9500;
      }
      .util-fill.high {
        background: #ff3b30;
      }
      .hint {
        color: var(--text-tertiary);
        font-size: 10px;
      }

      /* ── Pills ──────────────────────────────────────────────── */
      .mode-pill,
      .status-pill {
        display: inline-block;
        font-size: 11px;
        font-weight: var(--font-semibold);
        padding: 2px 10px;
        border-radius: 999px;
        background: rgba(142, 142, 147, 0.14);
        color: var(--text-secondary);
      }
      .mode-pill.live,
      .status-pill.active {
        background: rgba(52, 199, 89, 0.14);
        color: #15803d;
      }
      .mode-pill.paper {
        background: rgba(0, 113, 227, 0.14);
        color: #0040dd;
      }
      .status-pill.idle {
        background: rgba(255, 149, 0, 0.14);
        color: #c93400;
      }
      .status-pill.down,
      .status-pill.inactive {
        background: rgba(255, 59, 48, 0.14);
        color: #b91c1c;
      }

      /* ── Tables ──────────────────────────────────────────────── */
      .grid-table {
        width: 100%;
        border-collapse: collapse;
      }
      .grid-table th,
      .grid-table td {
        padding: var(--space-2) var(--space-4);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .grid-table tbody tr:last-child td {
        border-bottom: none;
      }
      .grid-table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .grid-table th.num,
      .grid-table td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .grid-table .ea-instance {
        max-width: 320px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .symbol-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      .symbol-chip {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: 10.5px;
        font-weight: var(--font-medium);
        padding: 1px 6px;
        background: var(--bg-tertiary);
        border-radius: 4px;
        color: var(--text-secondary);
      }

      /* ── Shared ──────────────────────────────────────────────── */
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-variant-numeric: tabular-nums;
      }
      .profit {
        color: var(--profit, #15803d);
      }
      .loss {
        color: var(--loss, #b91c1c);
      }
      .empty-state {
        padding: var(--space-6) var(--space-4);
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--space-1);
        text-align: center;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        margin-top: var(--space-3);
      }
      .empty-state.inline {
        margin-top: 0;
        background: transparent;
        border: none;
        border-radius: 0;
      }
      .empty-hint {
        font-size: 10.5px;
        color: var(--text-tertiary);
        max-width: 480px;
        line-height: 1.5;
      }
    `,
  ],
})
export class AccountDetailPageComponent implements OnInit, OnDestroy {
  protected readonly Math = Math;

  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly accountsService = inject(TradingAccountsService);
  private readonly eaService = inject(EAInstancesService);
  private readonly pairsService = inject(CurrencyPairsService);
  private readonly notifications = inject(NotificationService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly destroy$ = new Subject<void>();

  readonly accountId = signal<number | null>(null);
  readonly account = signal<TradingAccountDto | null>(null);
  readonly eaInstances = signal<EAInstanceDto[]>([]);
  readonly currencyPairs = signal<CurrencyPairDto[]>([]);
  readonly loading = signal(true);
  readonly nowMs = signal(Date.now());

  /** Set of active currency-pair symbols for the symbol-exposure card. */
  readonly activePairSymbols = computed<Set<string>>(() => {
    const set = new Set<string>();
    for (const p of this.currencyPairs()) {
      if (p.isActive && p.symbol) set.add(p.symbol);
    }
    return set;
  });

  /** Aggregated symbol exposure derived from EAs bound to this account. */
  readonly symbolExposure = computed<
    {
      symbol: string;
      eaCount: number;
      isActiveOnEngine: boolean;
    }[]
  >(() => {
    const counts = new Map<string, number>();
    for (const ea of this.linkedEas()) {
      for (const s of this.symbolsList(ea)) {
        counts.set(s, (counts.get(s) ?? 0) + 1);
      }
    }
    const active = this.activePairSymbols();
    return Array.from(counts.entries())
      .map(([symbol, eaCount]) => ({
        symbol,
        eaCount,
        isActiveOnEngine: active.has(symbol),
      }))
      .sort(
        (a, b) =>
          Number(b.isActiveOnEngine) - Number(a.isActiveOnEngine) ||
          b.eaCount - a.eaCount ||
          a.symbol.localeCompare(b.symbol),
      );
  });

  /** Account age in days since first registration. */
  readonly accountAgeDays = computed<number | null>(() => {
    const a = this.account();
    if (!a?.lastSyncedAt) return null;
    // We don't have a CreatedAt on the DTO; infer minimum from earliest EA registration.
    const eas = this.linkedEas();
    if (eas.length === 0) return null;
    const earliest = eas
      .map((e) => (e.registeredAt ? new Date(e.registeredAt).getTime() : Number.POSITIVE_INFINITY))
      .reduce((min, t) => Math.min(min, t), Number.POSITIVE_INFINITY);
    if (!Number.isFinite(earliest)) return null;
    return Math.max(0, (Date.now() - earliest) / (1000 * 60 * 60 * 24));
  });

  /** Whether margin level is below the broker's stop-out threshold. */
  readonly stopOutBreached = computed<boolean>(() => {
    const a = this.account();
    if (!a || a.marginSoStopOut <= 0 || a.marginUsed <= 0) return false;
    const lvl = a.marginLevel > 0 ? a.marginLevel : this.marginLevelPct();
    return lvl > 0 && lvl <= a.marginSoStopOut;
  });

  /** Whether margin level is below the broker's margin call threshold (but above stop-out). */
  readonly marginCallBreached = computed<boolean>(() => {
    const a = this.account();
    if (!a || a.marginSoCall <= 0 || a.marginUsed <= 0) return false;
    if (this.stopOutBreached()) return false;
    const lvl = a.marginLevel > 0 ? a.marginLevel : this.marginLevelPct();
    return lvl > 0 && lvl <= a.marginSoCall;
  });

  readonly subtitle = computed(() => {
    const a = this.account();
    if (!a) return '';
    const broker = a.brokerName ?? 'Broker —';
    const server = a.brokerServer ? ` (${a.brokerServer})` : '';
    const mode = a.isPaper ? 'Paper' : 'Live';
    const acct = a.accountId ?? '—';
    return `${broker}${server} · ${mode} · ${acct} · ${a.currency ?? '—'}`;
  });

  readonly unrealizedPnL = computed(() => {
    const a = this.account();
    if (!a) return 0;
    return (a.equity ?? 0) - (a.balance ?? 0);
  });

  readonly marginUtilizationPct = computed(() => {
    const a = this.account();
    if (!a || (a.equity ?? 0) <= 0) return 0;
    return ((a.marginUsed ?? 0) / a.equity) * 100;
  });

  readonly marginLevelPct = computed(() => {
    const a = this.account();
    if (!a || (a.marginUsed ?? 0) <= 0) return 0;
    // Prefer the engine-reported value (matches what the broker
    // actually computes — important for accounts where MarginSoMode
    // isn't a straight equity/used ratio); fall back to the compute
    // when the engine field is zero/missing.
    if (a.marginLevel && a.marginLevel > 0) return a.marginLevel;
    return ((a.equity ?? 0) / a.marginUsed) * 100;
  });

  /**
   * Capped margin level for display so a near-zero `marginUsed` doesn't
   * blow the metric card up with a 6-figure percentage. The KPI value
   * compresses to 999% beyond that — the actionable signal lives in
   * the <100% / <200% bands anyway.
   */
  readonly marginLevelDisplay = computed(() => {
    const a = this.account();
    if (!a || (a.marginUsed ?? 0) <= 0) return null;
    return Math.min(this.marginLevelPct(), 999);
  });

  readonly marginLevelStatus = computed(() => {
    const used = this.account()?.marginUsed ?? 0;
    if (used <= 0) return '#34C759';
    const lvl = this.marginLevelPct();
    if (lvl < 100) return '#FF3B30';
    if (lvl < 200) return '#FF9500';
    return '#34C759';
  });

  readonly syncAgeSec = computed<number | null>(() => {
    const a = this.account();
    if (!a?.lastSyncedAt) return null;
    const t = new Date(a.lastSyncedAt).getTime();
    if (isNaN(t)) return null;
    return Math.max(0, Math.floor((this.nowMs() - t) / 1000));
  });

  readonly linkedEas = computed<EAInstanceDto[]>(() => {
    const id = this.accountId();
    if (id === null) return [];
    return this.eaInstances().filter((ea) => ea.tradingAccountId === id);
  });

  /** Split the engine's CSV `symbols` field into a sorted unique array. */
  symbolsList(ea: EAInstanceDto): string[] {
    if (!ea?.symbols) return [];
    return ea.symbols
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  ngOnInit(): void {
    const idParam = this.route.snapshot.paramMap.get('id');
    const id = idParam ? Number(idParam) : NaN;
    if (!Number.isFinite(id) || id <= 0) {
      this.notifications.error('Invalid account id.');
      this.loading.set(false);
      return;
    }
    this.accountId.set(id);
    this.loadAll();

    // 10s data refresh — accounts/EAs change as the broker syncs;
    // dashboard cadence is fine for a detail view.
    timer(10_000, 10_000)
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => this.loadAll());

    // 1s wall-clock so heartbeat-age + sync-age numbers move smoothly
    // between network refreshes.
    timer(1_000, 1_000)
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => this.nowMs.set(Date.now()));
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  loadAll(): void {
    const id = this.accountId();
    if (id === null) return;
    this.loading.set(true);
    forkJoin({
      account: this.accountsService.getById(id).pipe(catchError(() => of(null))),
      eas: this.eaService.list().pipe(catchError(() => of(null))),
      pairs: this.pairsService
        .list({ currentPage: 1, itemCountPerPage: 200 })
        .pipe(catchError(() => of(null))),
    })
      .pipe(takeUntil(this.destroy$))
      .subscribe(({ account, eas, pairs }) => {
        this.loading.set(false);
        if (account?.data) this.account.set(account.data);
        if (eas?.data) this.eaInstances.set(eas.data);
        if (pairs?.data?.data) this.currencyPairs.set(pairs.data.data);
      });
  }

  heartbeatAgeSec(ea: EAInstanceDto): number | null {
    if (!ea.lastHeartbeat) return null;
    const t = new Date(ea.lastHeartbeat).getTime();
    if (isNaN(t)) return null;
    return Math.max(0, Math.floor((this.nowMs() - t) / 1000));
  }

  formatAge(ageSec: number): string {
    if (ageSec < 60) return `${Math.floor(ageSec)}s ago`;
    if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
    if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h ago`;
    return `${Math.floor(ageSec / 86400)}d ago`;
  }

  goBack(): void {
    this.router.navigate(['/trading-accounts']);
  }
}
