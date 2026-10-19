import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, map, of, switchMap } from 'rxjs';
import type { EChartsOption } from 'echarts';

import { EAAdminService } from '@core/services/ea-admin.service';
import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import { TradingAccountsService } from '@core/services/trading-accounts.service';
import type { CurrencyPairDto, EAFleetItem, TradingAccountDto } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';

import { FleetActionsBarComponent } from '../../components/fleet-actions-bar/fleet-actions-bar.component';
import { EATradingWindowPanelComponent } from '../../components/ea-trading-window-panel/ea-trading-window-panel.component';
import { EAPendingSignalRevalPanelComponent } from '../../components/ea-pending-signal-reval-panel/ea-pending-signal-reval-panel.component';
import { EASpreadPadMasterPanelComponent } from '../../components/ea-spread-pad-master-panel/ea-spread-pad-master-panel.component';
import { EACandleSourcePanelComponent } from '../../components/ea-candle-source-panel/ea-candle-source-panel.component';
import {
  FLEET_STATUS_LABELS,
  currentFleetIds,
  fleetStatusOf,
  type FleetStatus,
} from '../../current-fleet';

/**
 * 'current' (the default) = every live instance (Active, or ShuttingDown inside the liveness
 * window), anything that dropped off in the last 24 h, and the newest instance of an active account
 * that has no live EA. The fleet list keeps every registration ever made (57 rows for 5 live EAs),
 * so 'all' would bury the live ones. 'Deregistered' is a ShuttingDown row long past its heartbeat
 * (see fleetStatusOf) — the same split Fleet Health makes.
 */
type StatusFilter = 'current' | 'all' | FleetStatus;
type ViewMode = 'cards' | 'table';
type CoverageFilter = 'all' | 'covered' | 'uncovered';

/** Tile dot for a count that carries no signal (zero) — grey, not green. */
const NEUTRAL_DOT = '#8E8E93';

const STATUS_RANK: Record<FleetStatus, number> = {
  Active: 0,
  ShuttingDown: 1,
  Disconnected: 2,
  Deregistered: 3,
};

@Component({
  selector: 'app-ea-instances-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PageHeaderComponent,
    MetricCardComponent,
    ChartCardComponent,
    CardSkeletonComponent,
    EmptyStateComponent,
    DatePipe,
    DecimalPipe,
    FormsModule,
    RouterLink,
    FleetActionsBarComponent,
    EATradingWindowPanelComponent,
    EAPendingSignalRevalPanelComponent,
    EASpreadPadMasterPanelComponent,
    EACandleSourcePanelComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="EA Instances"
        subtitle="Expert Advisor heartbeats and symbol ownership"
      />

      <!-- Phase-3A: fleet bulk-ops bar above the per-instance grid -->
      <app-fleet-actions-bar (commandQueued)="onFleetCommandQueued($event)" />

      <!-- Engine-wide fleet config row: trading window + pending-signal
           re-validation + spread-pad master. Auto-fit grid (stacks on narrow). -->
      <div class="fleet-config-row">
        <!-- Fleet-wide trading window — auto-rejects signals + optionally
             flattens positions at window exit. UTC-clock, fleet-scoped. -->
        <app-ea-trading-window-panel />

        <!-- Engine-wide pending-signal re-validation — park LLM recs whose
             entry is far from market and re-validate when price returns. -->
        <app-ea-pending-signal-reval-panel />

        <!-- Engine-wide master for SpreadPadder — AND-ed with each account's
             per-EA toggle on the EA detail page. -->
        <app-ea-spread-pad-master-panel />

        <!-- Single-source candle guard — designate which instance streams each
             symbol's candles so cross-broker feeds can't collide into dup bars. -->
        <app-ea-candle-source-panel />
      </div>

      @if (loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (instances().length > 0) {
        <!-- Fleet status as stat tiles.  With a handful of instances the
             status split is usually one-sided (a single-slice donut says
             nothing), so the counts are the chart.  Dots only colour a
             non-zero count that means something; zero stays neutral. -->
        <div class="tiles tiles-6" aria-label="Fleet status">
          <app-metric-card label="Registered" [value]="instances().length" format="number" />
          <app-metric-card
            label="Active"
            [value]="activeCount()"
            format="number"
            [dotColor]="dotFor(activeCount(), '#34C759')"
          />
          <app-metric-card
            label="Shutting down"
            [value]="idleCount()"
            format="number"
            [dotColor]="dotFor(idleCount(), '#FF9500')"
          />
          <app-metric-card
            label="Disconnected"
            [value]="disconnectedCount()"
            format="number"
            [dotColor]="dotFor(disconnectedCount(), '#FF3B30')"
          />
          <!-- Finished registrations, not a problem: grey whatever the count. -->
          <app-metric-card
            label="Deregistered"
            [value]="deregisteredCount()"
            format="number"
            [dotColor]="neutralDot"
          />
          <app-metric-card label="Live accounts" [value]="uniqueAccounts().size" format="number" />
        </div>

        <div class="tiles tiles-4" aria-label="Symbol coverage">
          <app-metric-card
            label="Owned symbols (live)"
            [value]="totalOwnedSymbols()"
            format="number"
          />
          <app-metric-card
            label="Unique symbols"
            [value]="uniqueOwnedSymbols().size"
            format="number"
          />
          <app-metric-card
            label="Uncovered pairs"
            [value]="uncoveredSymbols().size"
            format="number"
            [dotColor]="dotFor(uncoveredSymbols().size, '#FF3B30')"
          />
          <app-metric-card
            label="Coverage"
            [value]="coveragePct()"
            format="percent"
            [dotColor]="coverageDot()"
          />
        </div>

        <app-chart-card
          title="Symbols owned per live EA"
          subtitle="How the {{ uniqueOwnedSymbols().size }} unique symbols are distributed"
          [options]="symbolsPerEAOptions()"
          height="260px"
        />

        <!-- Toolbar -->
        <div class="toolbar">
          <input
            type="text"
            class="input search"
            placeholder="Filter by instance ID, account, or symbol…"
            [ngModel]="search()"
            (ngModelChange)="search.set($event)"
          />
          <select
            class="input"
            [ngModel]="statusFilter()"
            (ngModelChange)="statusFilter.set($event)"
          >
            <option value="current">Current ({{ currentCount() }})</option>
            <option value="all">All registered ({{ instances().length }})</option>
            <option value="Active">Active ({{ activeCount() }})</option>
            <option value="ShuttingDown">Shutting down ({{ idleCount() }})</option>
            <option value="Disconnected">Disconnected ({{ disconnectedCount() }})</option>
            <option value="Deregistered">Deregistered ({{ deregisteredCount() }})</option>
          </select>
          <div class="view-toggle" role="group" aria-label="View mode">
            <button
              type="button"
              [class.active]="viewMode() === 'cards'"
              (click)="viewMode.set('cards')"
            >
              Cards
            </button>
            <button
              type="button"
              [class.active]="viewMode() === 'table'"
              (click)="viewMode.set('table')"
            >
              Dense
            </button>
          </div>
          <span class="muted">{{ filtered().length }} of {{ instances().length }}</span>
        </div>

        @if (viewMode() === 'cards') {
          <section class="grid">
            @for (i of filtered(); track i.instanceId) {
              <article
                class="card clickable"
                [attr.data-status]="statusOf(i)"
                [routerLink]="['/ea-instances', i.instanceId]"
                role="link"
                tabindex="0"
                (keydown.enter)="$any($event.target).click()"
              >
                <header class="head">
                  <div class="title">
                    <span class="status-dot" [attr.data-status]="statusOf(i)"></span>
                    <h4 [title]="i.instanceId">{{ i.instanceId }}</h4>
                  </div>
                  <span class="pill" [attr.data-status]="statusOf(i)">{{
                    statusLabel(statusOf(i))
                  }}</span>
                </header>
                <dl class="info">
                  <div>
                    <dt>Account</dt>
                    <dd class="mono">{{ i.tradingAccountId }}</dd>
                  </div>
                  <div>
                    <dt>Heartbeat</dt>
                    <dd
                      class="mono"
                      [class.bad]="heartbeatTier(i) === 'dead'"
                      [class.warn]="heartbeatTier(i) === 'stale'"
                      [class.good]="heartbeatTier(i) === 'fresh'"
                      [title]="i.lastHeartbeat"
                    >
                      {{ heartbeatLabel(i) }}
                    </dd>
                  </div>
                  <div>
                    <dt>Uptime</dt>
                    <dd
                      class="mono"
                      [title]="i.registeredAt ? (i.registeredAt | date: 'MMM d, HH:mm') : ''"
                    >
                      {{ uptimeLabel(i) }}
                    </dd>
                  </div>
                  <div>
                    <dt>Equity</dt>
                    <dd
                      class="mono"
                      [class.warn]="syncTier(i) === 'stale'"
                      [class.stale-val]="syncTier(i) === 'dead'"
                      [title]="syncTitle(i)"
                    >
                      @if (accountOf(i); as a) {
                        {{ a.equity | number: '1.2-2' }}
                        <span class="muted">{{ accountCurrency(i) }}</span>
                      } @else {
                        —
                      }
                    </dd>
                  </div>
                  <div>
                    <dt>Balance</dt>
                    <dd class="mono" [title]="syncTitle(i)">
                      @if (accountOf(i); as a) {
                        {{ a.balance | number: '1.2-2' }}
                        <span class="muted">{{ accountCurrency(i) }}</span>
                      } @else {
                        —
                      }
                    </dd>
                  </div>
                  <div class="full">
                    <dt>Owned symbols ({{ symbolsOf(i).length }})</dt>
                    <dd>
                      @if (symbolsOf(i).length > 0) {
                        <div class="chips">
                          @for (s of symbolsOf(i); track s) {
                            <span
                              class="chip"
                              [class.chip-active]="activeSymbolSet().has(s)"
                              [title]="
                                activeSymbolSet().has(s)
                                  ? s + ' · active currency pair'
                                  : s + ' · not in active currency pairs'
                              "
                            >
                              {{ s }}
                            </span>
                          }
                        </div>
                      } @else {
                        <span class="muted">No symbols owned</span>
                      }
                    </dd>
                  </div>
                </dl>
              </article>
            }
          </section>
        } @else {
          <section class="dense-wrap">
            <table class="dense">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Instance</th>
                  <th>Account</th>
                  <th class="num">Equity</th>
                  <th class="num">Balance</th>
                  <th class="num">Symbols</th>
                  <th>Heartbeat</th>
                  <th>Uptime</th>
                  <th>Owned symbols</th>
                </tr>
              </thead>
              <tbody>
                @for (i of filtered(); track i.instanceId) {
                  <tr
                    class="row-clickable"
                    [routerLink]="['/ea-instances', i.instanceId]"
                    role="link"
                    tabindex="0"
                    (keydown.enter)="$any($event.target).click()"
                  >
                    <td>
                      <span class="pill" [attr.data-status]="statusOf(i)">
                        {{ statusLabel(statusOf(i)) }}
                      </span>
                    </td>
                    <td class="mono name" [title]="i.instanceId">{{ i.instanceId }}</td>
                    <td class="mono">{{ i.tradingAccountId }}</td>
                    <td
                      class="num mono"
                      [class.warn]="syncTier(i) === 'stale'"
                      [class.stale-val]="syncTier(i) === 'dead'"
                      [title]="syncTitle(i)"
                    >
                      @if (accountOf(i); as a) {
                        {{ a.equity | number: '1.2-2' }}
                      } @else {
                        —
                      }
                    </td>
                    <td class="num mono" [title]="syncTitle(i)">
                      @if (accountOf(i); as a) {
                        {{ a.balance | number: '1.2-2' }}
                      } @else {
                        —
                      }
                    </td>
                    <td class="num mono">{{ symbolsOf(i).length }}</td>
                    <td
                      class="mono"
                      [class.bad]="heartbeatTier(i) === 'dead'"
                      [class.warn]="heartbeatTier(i) === 'stale'"
                      [class.good]="heartbeatTier(i) === 'fresh'"
                    >
                      {{ heartbeatLabel(i) }}
                    </td>
                    <td class="mono muted">{{ uptimeLabel(i) }}</td>
                    <td class="symbols-cell">
                      @if (symbolsOf(i).length > 0) {
                        <span class="symbols-inline">
                          {{ symbolsOf(i).join(', ') }}
                        </span>
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        }

        <!-- Symbol coverage board: cross-references active currency pairs -->
        @if (coverageRows().length > 0) {
          <section class="cov-board">
            <header class="cov-head">
              <h3>Symbol coverage</h3>
              <span class="muted">
                {{ coveredSymbols().size }} covered ·
                <span [class.bad]="uncoveredSymbols().size > 0">
                  {{ uncoveredSymbols().size }} uncovered
                </span>
                · {{ activeSymbolSet().size }} active currency pairs
              </span>
              <div class="cov-filter" role="group" aria-label="Coverage filter">
                <button
                  type="button"
                  [class.active]="coverageFilter() === 'all'"
                  (click)="coverageFilter.set('all')"
                >
                  All
                </button>
                <button
                  type="button"
                  [class.active]="coverageFilter() === 'covered'"
                  (click)="coverageFilter.set('covered')"
                >
                  Covered
                </button>
                <button
                  type="button"
                  [class.active]="coverageFilter() === 'uncovered'"
                  (click)="coverageFilter.set('uncovered')"
                >
                  Uncovered
                </button>
              </div>
            </header>
            <div class="cov-scroll" [class.expanded]="coverageExpanded()">
              <table class="dense sticky">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Coverage</th>
                    <th>Owner</th>
                    <th>Owner status</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of coverageRowsVisible(); track row.symbol) {
                    <tr>
                      <td class="mono">{{ row.symbol }}</td>
                      <td>
                        @if (row.isCovered) {
                          <span class="pill" data-status="Active">Covered</span>
                        } @else {
                          <span class="pill" data-status="Disconnected">Uncovered</span>
                        }
                      </td>
                      <td class="mono">
                        @if (row.ownerId) {
                          {{ row.ownerId }}
                        } @else {
                          <span class="muted">—</span>
                        }
                      </td>
                      <td>
                        @if (row.ownerStatus) {
                          <span class="pill" [attr.data-status]="row.ownerStatus">
                            {{ statusLabel(row.ownerStatus) }}
                          </span>
                        } @else {
                          <span class="muted">—</span>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            <!-- Always say how many rows the table holds — a max-height scroll
                 box hides the count, and an operator scanning for a missing
                 pair needs to know whether the list is complete. -->
            <footer class="cov-foot">
              <span class="muted">
                @if (coverageHiddenCount() > 0) {
                  Showing {{ coverageRowsVisible().length }} of
                  {{ coverageRowsFiltered().length }} symbols
                } @else {
                  Showing {{ coverageRowsFiltered().length }}
                  {{ coverageRowsFiltered().length === 1 ? 'symbol' : 'symbols' }}
                }
              </span>
              @if (coverageRowsFiltered().length > coveragePreviewRows) {
                <button type="button" class="link-btn" (click)="toggleCoverageExpanded()">
                  {{
                    coverageExpanded()
                      ? 'Show fewer'
                      : 'Show all (' + coverageRowsFiltered().length + ')'
                  }}
                </button>
              }
            </footer>
          </section>
        }

        <p class="note">
          Dead EAs mark their symbols <code>DATA_UNAVAILABLE</code> after ~60s without a heartbeat.
          Symbols are reassigned automatically when a new EA registers.
        </p>
      } @else {
        <app-empty-state
          title="No EA instances registered"
          description="Register an Expert Advisor from MT5 to populate this view."
        />
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }

      /* Stat-tile rows: equal-width columns, never more than six per row. */
      .tiles {
        display: grid;
        gap: var(--space-2);
        align-items: start;
      }
      .tiles-6 {
        grid-template-columns: repeat(6, minmax(0, 1fr));
      }
      .tiles-4 {
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }
      @media (max-width: 1100px) {
        .tiles-6,
        .tiles-4 {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
      }
      @media (max-width: 720px) {
        .tiles-6,
        .tiles-4 {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }

      /* Fleet config row: trading window + pending-signal re-validation
         side-by-side on wide screens; auto-fit collapses to a single
         column when neither will fit at min width. */
      .fleet-config-row {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(440px, 1fr));
        gap: var(--space-3);
        align-items: stretch;
      }
      .fleet-config-row > * {
        min-width: 0;
      }

      .toolbar {
        display: flex;
        gap: var(--space-3);
        align-items: center;
        flex-wrap: wrap;
      }
      .input {
        height: 36px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        outline: none;
      }
      .input:focus {
        border-color: var(--accent);
      }
      .search {
        flex: 1 1 280px;
        min-width: 240px;
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .view-toggle {
        display: inline-flex;
        background: var(--bg-tertiary);
        border-radius: var(--radius-sm);
        overflow: hidden;
        border: 1px solid var(--border);
      }
      .view-toggle button {
        height: 36px;
        padding: 0 var(--space-3);
        background: transparent;
        border: none;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        color: var(--text-secondary);
        cursor: pointer;
      }
      .view-toggle button.active {
        background: var(--bg-primary);
        color: var(--text-primary);
        box-shadow: var(--shadow-sm);
      }

      /* Cards grid */
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
        gap: var(--space-3);
      }
      .card.clickable {
        cursor: pointer;
        transition:
          background 0.12s ease,
          border-color 0.12s ease,
          transform 0.12s ease;
      }
      .card.clickable:hover {
        background: var(--bg-tertiary, rgba(0, 113, 227, 0.05));
        border-color: var(--accent);
        transform: translateY(-1px);
      }
      .card.clickable:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      .row-clickable {
        cursor: pointer;
      }
      .row-clickable:hover {
        background: var(--bg-tertiary, rgba(0, 113, 227, 0.05));
      }
      .row-clickable:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: -2px;
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-4);
        box-shadow: var(--shadow-sm);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .card[data-status='Active'] {
        border-left: 3px solid var(--profit);
      }
      .card[data-status='ShuttingDown'] {
        border-left: 3px solid var(--warning);
      }
      .card[data-status='Disconnected'] {
        border-left: 3px solid var(--loss);
      }
      .card[data-status='Deregistered'] {
        border-left: 3px solid var(--text-tertiary);
      }
      .head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: var(--space-2);
      }
      .title {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        min-width: 0;
        flex: 1;
      }
      .title h4 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        font-family: 'SF Mono', 'Fira Code', monospace;
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .status-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--text-tertiary);
        flex-shrink: 0;
      }
      .status-dot[data-status='Active'] {
        background: var(--profit);
      }
      .status-dot[data-status='ShuttingDown'] {
        background: var(--warning);
      }
      .status-dot[data-status='Disconnected'] {
        background: var(--loss);
      }
      .pill {
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-size: 11px;
        font-weight: var(--font-semibold);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        white-space: nowrap;
      }
      .pill[data-status='Active'] {
        background: rgba(52, 199, 89, 0.12);
        color: var(--tone-green);
      }
      .pill[data-status='ShuttingDown'] {
        background: rgba(255, 149, 0, 0.12);
        color: var(--tone-amber);
      }
      .pill[data-status='Disconnected'] {
        background: rgba(255, 59, 48, 0.12);
        color: var(--tone-red);
      }
      .info {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: var(--space-2);
        margin: 0;
      }
      .info .full {
        grid-column: 1 / -1;
      }
      .info dt {
        font-size: 10.5px;
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        margin: 0;
      }
      .info dd {
        margin: 2px 0 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
        font-weight: var(--font-medium);
      }
      .info dd.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
      }
      .info dd.good {
        color: var(--profit);
      }
      .info dd.warn {
        color: var(--tone-amber);
      }
      .info dd.bad {
        color: var(--loss);
      }
      /* Broker snapshot older than a minute: dimmed, never loss-red — a red equity read as a
         losing account when the number was merely old. The title gives the sync time. */
      .info dd.stale-val,
      table.dense td.stale-val {
        color: var(--text-tertiary);
        text-decoration: underline dotted;
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      .chip {
        padding: 2px 8px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        color: var(--text-primary);
        font-size: 11px;
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      /* Symbols that match an active currency pair are highlighted —
         operator can spot orphaned symbols (owned but not in pair list). */
      .chip.chip-active {
        background: rgba(0, 113, 227, 0.12);
        color: var(--tone-blue);
      }

      /* Dense table view */
      .dense-wrap {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: auto;
        max-height: 540px;
      }
      .dense-wrap thead th {
        position: sticky;
        top: 0;
        z-index: 1;
      }
      table.dense {
        width: 100%;
        border-collapse: collapse;
      }
      table.dense th,
      table.dense td {
        padding: 6px var(--space-3);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      table.dense thead th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      table.dense th.num,
      table.dense td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      table.dense td.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      table.dense td.muted {
        color: var(--text-tertiary);
      }
      table.dense td.name {
        max-width: 280px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      table.dense td.bad,
      table.dense td.warn,
      table.dense td.good {
        font-weight: var(--font-semibold);
      }
      table.dense td.bad {
        color: var(--loss);
      }
      table.dense td.warn {
        color: var(--tone-amber);
      }
      table.dense td.good {
        color: var(--profit);
      }
      table.dense tbody tr:hover {
        background: var(--bg-tertiary);
      }
      .symbols-cell {
        max-width: 480px;
      }
      .symbols-inline {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: 11px;
        color: var(--text-secondary);
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }

      /* Coverage board */
      .cov-board {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .cov-head {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
        flex-wrap: wrap;
      }
      .cov-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .cov-head .bad {
        color: var(--loss);
      }
      .cov-filter {
        margin-left: auto;
        display: inline-flex;
        background: var(--bg-tertiary);
        border-radius: var(--radius-sm);
        overflow: hidden;
        border: 1px solid var(--border);
      }
      .cov-filter button {
        height: 30px;
        padding: 0 var(--space-3);
        background: transparent;
        border: none;
        font-size: 11px;
        font-weight: var(--font-medium);
        color: var(--text-secondary);
        cursor: pointer;
      }
      .cov-filter button.active {
        background: var(--bg-primary);
        color: var(--text-primary);
      }
      /* Collapsed: the preview rows fit without scrolling, so nothing is
         clipped silently.  Expanded: cap the height and scroll — the footer
         count tells the operator how many rows are in the box. */
      .cov-scroll.expanded {
        max-height: 480px;
        overflow-y: auto;
      }
      .dense.sticky thead th {
        position: sticky;
        top: 0;
        z-index: 1;
      }
      .cov-foot {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
        padding: var(--space-2) var(--space-4);
        border-top: 1px solid var(--border);
      }
      .link-btn {
        background: none;
        border: none;
        padding: 0;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        color: var(--accent);
        cursor: pointer;
      }
      .link-btn:hover {
        text-decoration: underline;
      }

      .note {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        background: var(--bg-secondary);
        border: 1px dashed var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-5);
        margin: 0;
      }
      .note code {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
        padding: 1px 6px;
        border-radius: 4px;
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
    `,
  ],
})
export class EAInstancesPageComponent {
  private readonly admin = inject(EAAdminService);
  private readonly currencyPairsService = inject(CurrencyPairsService);
  private readonly tradingAccountsService = inject(TradingAccountsService);

  /**
   * Every registered instance — Active, ShuttingDown and Disconnected. The page used `/ea/instances`,
   * which returns Active rows only, so the "Shutting down" and "Disconnected" tiles could never be
   * anything but 0 (48 Disconnected + 4 ShuttingDown existed) and a dead EA simply vanished.
   */
  private readonly resource = createPolledResource(
    () =>
      this.admin.listFleet().pipe(
        map((r) => r.data ?? []),
        catchError(() => of([] as EAFleetItem[])),
      ),
    {
      // Push-driven: the interval is only a fallback for a missed
      // push or a reconnect gap.
      intervalMs: 30_000,
      refreshOn: ['positionOpened', 'positionClosed', 'orderFilled', 'emergencyFlatten'],
    },
  );

  /**
   * Phase-3A: refresh the fleet list after a fan-out completes so the
   * KPI strip + per-instance grid reflect the new posture (e.g. instances
   * that just transitioned RUNNING → SAFETY_STOP).  The audit timeline
   * updates per-instance once each EA pushes its outbox.
   */
  protected onFleetCommandQueued(_actionKey: string): void {
    this.resource.refresh();
  }

  // Active currency pairs — used to score coverage. Probe-and-fetch so a
  // fresh deployment with hundreds of pairs all loads in one round-trip.
  private readonly pairsResource = createPolledResource(
    () =>
      this.currencyPairsService
        .list({ currentPage: 1, itemCountPerPage: 1, filter: { isActive: true } })
        .pipe(
          switchMap((probe) => {
            const total = probe.data?.pager?.totalItemCount ?? 0;
            if (total === 0) return of([] as CurrencyPairDto[]);
            return this.currencyPairsService
              .list({
                currentPage: 1,
                itemCountPerPage: Math.min(total, 5000),
                filter: { isActive: true },
              })
              .pipe(map((r) => r.data?.data ?? []));
          }),
          catchError(() => of([] as CurrencyPairDto[])),
        ),
    {
      // Push-driven: the interval is only a fallback for a missed
      // push or a reconnect gap.
      intervalMs: 30_000,
      refreshOn: ['positionOpened', 'positionClosed', 'orderFilled', 'emergencyFlatten'],
    },
  );

  // Live trading-account snapshot — used by the EA instance card to show
  // the current balance + equity for each EA's owning account.  Polled at
  // the same cadence as the broker-snapshot worker's sync (~15s) so the
  // card is at most one tick stale.  Probe-and-fetch like the pairs path
  // so a fleet with many accounts loads in one round-trip.
  private readonly accountsResource = createPolledResource(
    () =>
      this.tradingAccountsService.list({ currentPage: 1, itemCountPerPage: 1 }).pipe(
        switchMap((probe) => {
          const total = probe.data?.pager?.totalItemCount ?? 0;
          if (total === 0) return of([] as TradingAccountDto[]);
          return this.tradingAccountsService
            .list({ currentPage: 1, itemCountPerPage: Math.min(total, 500) })
            .pipe(map((r) => r.data?.data ?? []));
        }),
        catchError(() => of([] as TradingAccountDto[])),
      ),
    {
      // Push-driven: the interval is only a fallback for a missed
      // push or a reconnect gap.
      intervalMs: 30_000,
      refreshOn: ['positionOpened', 'positionClosed', 'orderFilled', 'emergencyFlatten'],
    },
  );

  // Lookup map (account id → DTO) so the card's per-row helpers are O(1)
  // instead of scanning the accounts list per row.  Falls back to an empty
  // Map while the first fetch is in flight so the dt rows render the em
  // dash placeholder gracefully.
  private readonly accountsById = computed(() => {
    const m = new Map<number, TradingAccountDto>();
    for (const a of this.accountsResource.value() ?? []) m.set(a.id, a);
    return m;
  });

  /**
   * Stable order — live first, then by account and instance. The engine sorts by last heartbeat,
   * which reshuffled the live cards on every poll.
   */
  readonly instances = computed(() =>
    [...(this.resource.value() ?? [])].sort(
      (a, b) =>
        (STATUS_RANK[this.statusOf(a)] ?? 4) - (STATUS_RANK[this.statusOf(b)] ?? 4) ||
        a.tradingAccountId - b.tradingAccountId ||
        a.instanceId.localeCompare(b.instanceId),
    ),
  );
  /** Instances with a live EA behind them — what symbol ownership and coverage are about. */
  readonly liveInstances = computed(() => this.instances().filter((i) => i.status === 'Active'));
  readonly loading = computed(() => this.resource.loading() && this.resource.value() === null);

  readonly search = signal('');
  readonly statusFilter = signal<StatusFilter>('current');

  /** See StatusFilter / currentFleetIds. */
  private readonly currentSet = computed(() => {
    const accounts = this.accountsById();
    return currentFleetIds(
      this.instances(),
      (id) => accounts.get(id)?.isActive === true,
      Date.now(),
    );
  });
  readonly currentCount = computed(() => this.currentSet().size);
  readonly viewMode = signal<ViewMode>('cards');
  readonly coverageFilter = signal<CoverageFilter>('all');

  /** Split the engine's CSV `symbols` field into a clean array. */
  protected symbolsOf(ea: EAFleetItem): string[] {
    if (!ea?.symbols) return [];
    return ea.symbols
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  readonly filtered = computed(() => {
    const q = this.search().toLowerCase().trim();
    const st = this.statusFilter();
    const current = this.currentSet();
    return this.instances().filter((i) => {
      if (st === 'current' && !current.has(i.instanceId)) return false;
      if (st !== 'all' && st !== 'current' && this.statusOf(i) !== st) return false;
      if (!q) return true;
      if (i.instanceId.toLowerCase().includes(q)) return true;
      if (String(i.tradingAccountId).includes(q)) return true;
      if (this.symbolsOf(i).some((s) => s.toLowerCase().includes(q))) return true;
      return false;
    });
  });

  readonly activeCount = computed(
    () => this.instances().filter((i) => i.status === 'Active').length,
  );
  /** Shutdowns still in flight (heartbeat inside the liveness window). */
  readonly idleCount = computed(
    () => this.instances().filter((i) => this.statusOf(i) === 'ShuttingDown').length,
  );
  readonly disconnectedCount = computed(
    () => this.instances().filter((i) => i.status === 'Disconnected').length,
  );
  readonly deregisteredCount = computed(
    () => this.instances().filter((i) => this.statusOf(i) === 'Deregistered').length,
  );
  protected readonly neutralDot = NEUTRAL_DOT;

  /**
   * The engine's status, with a long-silent ShuttingDown row shown as "Deregistered": four such
   * rows from May/June read as "Shutting down" with a warning dot on the default view.
   */
  protected statusOf(i: EAFleetItem): FleetStatus {
    return fleetStatusOf(i, Date.now());
  }

  // Ownership is a property of a live EA: a Disconnected row keeps its old `symbols` CSV, but the
  // engine has released those symbols (DATA_UNAVAILABLE), so counting them would inflate coverage.
  readonly totalOwnedSymbols = computed(() =>
    this.liveInstances().reduce((s, i) => s + this.symbolsOf(i).length, 0),
  );

  readonly uniqueOwnedSymbols = computed(() => {
    const set = new Set<string>();
    for (const i of this.liveInstances()) {
      for (const s of this.symbolsOf(i)) set.add(s);
    }
    return set;
  });

  readonly uniqueAccounts = computed(() => {
    const set = new Set<number>();
    for (const i of this.liveInstances()) set.add(i.tradingAccountId);
    return set;
  });

  // Active currency-pair symbols, keyed by symbol for O(1) coverage checks.
  readonly activeSymbolSet = computed(() => {
    const set = new Set<string>();
    for (const p of this.pairsResource.value() ?? []) {
      if (p.isActive && p.symbol) set.add(p.symbol);
    }
    return set;
  });

  readonly coveredSymbols = computed(() => {
    const owned = this.uniqueOwnedSymbols();
    const active = this.activeSymbolSet();
    const covered = new Set<string>();
    for (const s of owned) if (active.has(s)) covered.add(s);
    return covered;
  });

  readonly uncoveredSymbols = computed(() => {
    const owned = this.uniqueOwnedSymbols();
    const active = this.activeSymbolSet();
    const uncovered = new Set<string>();
    for (const s of active) if (!owned.has(s)) uncovered.add(s);
    return uncovered;
  });

  readonly coveragePct = computed(() => {
    const active = this.activeSymbolSet();
    if (active.size === 0) return 0;
    return (this.coveredSymbols().size / active.size) * 100;
  });

  // symbol -> owning EA for the coverage board: the live owner when there is one, else the most
  // recent instance that held it (so an uncovered pair names who dropped it).
  private readonly symbolOwnerMap = computed(() => {
    const map = new Map<string, EAFleetItem>();
    const better = (a: EAFleetItem, b: EAFleetItem) =>
      (STATUS_RANK[this.statusOf(a)] ?? 4) - (STATUS_RANK[this.statusOf(b)] ?? 4) ||
      Date.parse(b.lastHeartbeat) - Date.parse(a.lastHeartbeat);
    for (const i of this.instances()) {
      for (const s of this.symbolsOf(i)) {
        const prev = map.get(s);
        if (!prev || better(i, prev) < 0) map.set(s, i);
      }
    }
    return map;
  });

  readonly coverageRows = computed(() => {
    const owners = this.symbolOwnerMap();
    const allSymbols = new Set<string>([...this.activeSymbolSet(), ...this.uniqueOwnedSymbols()]);
    return Array.from(allSymbols)
      .map((symbol) => {
        const owner = owners.get(symbol) ?? null;
        const isActive = this.activeSymbolSet().has(symbol);
        const isCovered = isActive && !!owner && owner.status === 'Active';
        return {
          symbol,
          isActive,
          ownerId: owner?.instanceId ?? null,
          ownerStatus: owner ? this.statusOf(owner) : null,
          isCovered,
        };
      })
      .sort((a, b) => {
        // Uncovered first (most urgent), then alphabetical.
        if (a.isCovered !== b.isCovered) return a.isCovered ? 1 : -1;
        return a.symbol.localeCompare(b.symbol);
      });
  });

  readonly coverageRowsFiltered = computed(() => {
    const f = this.coverageFilter();
    const rows = this.coverageRows();
    if (f === 'covered') return rows.filter((r) => r.isCovered);
    if (f === 'uncovered') return rows.filter((r) => !r.isCovered);
    return rows;
  });

  /**
   * The coverage table starts collapsed to a preview that fits without a
   * scrollbar; the footer states the total and offers "Show all".  Ten rows
   * is enough to surface every uncovered pair (they sort first) on a
   * typical fleet without pushing the page note off-screen.
   */
  protected readonly coveragePreviewRows = 10;
  readonly coverageExpanded = signal(false);

  readonly coverageRowsVisible = computed(() => {
    const rows = this.coverageRowsFiltered();
    return this.coverageExpanded() ? rows : rows.slice(0, this.coveragePreviewRows);
  });

  readonly coverageHiddenCount = computed(
    () => this.coverageRowsFiltered().length - this.coverageRowsVisible().length,
  );

  protected toggleCoverageExpanded(): void {
    this.coverageExpanded.update((v) => !v);
  }

  /** Dot colour for a count tile: meaning only when the count is non-zero. */
  protected dotFor(count: number, color: string): string {
    return count > 0 ? color : NEUTRAL_DOT;
  }

  readonly coverageDot = computed(() => {
    if (this.activeSymbolSet().size === 0) return NEUTRAL_DOT;
    const pct = this.coveragePct();
    return pct >= 90 ? '#34C759' : pct >= 50 ? '#FF9500' : '#FF3B30';
  });

  /** Human label for the status — the raw engine enum never reaches copy. */
  protected statusLabel(status: FleetStatus): string {
    return FLEET_STATUS_LABELS[status] ?? status;
  }

  readonly symbolsPerEAOptions = computed<EChartsOption>(() => {
    // ECharts draws category rows bottom-up, so reverse once and share the
    // ordering between the axis, the bars and the tooltip lookup.
    const rows = [...this.liveInstances()]
      .map((i) => ({ id: i.instanceId, value: this.symbolsOf(i).length }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 12)
      .reverse();
    if (rows.length === 0) return {};
    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: unknown) => {
          const first = (Array.isArray(params) ? params[0] : params) as
            | { dataIndex?: number; value?: unknown }
            | undefined;
          const row = first?.dataIndex != null ? rows[first.dataIndex] : undefined;
          if (!row) return '';
          const noun = row.value === 1 ? 'symbol' : 'symbols';
          return `<span style="font-family:var(--font-mono,monospace)">${row.id}</span><br/>${row.value} ${noun}`;
        },
      },
      grid: { top: 10, right: 50, bottom: 30, left: 176 },
      xAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: rows.map((r) => this.shortenInstanceId(r.id)),
        // Truncate from the right with an ellipsis if a label still does not
        // fit, so the account/login prefix that tells instances apart stays.
        axisLabel: {
          fontSize: 10,
          color: '#6E6E73',
          width: 164,
          overflow: 'truncate',
          ellipsis: '…',
          hideOverlap: true,
        },
      },
      series: [
        {
          type: 'bar',
          data: rows.map((r) => ({
            value: r.value,
            itemStyle: {
              color: r.value === 0 ? '#FF9500' : '#0071E3',
              borderRadius: [0, 4, 4, 0],
            },
          })),
          barWidth: 12,
          label: { show: true, position: 'right', fontSize: 10, color: '#6E6E73' },
        },
      ],
    };
  });

  // Instance ids look like "LASC-MULTI-10-9480-134218691004849480": the
  // middle segments (account, login) are what tell instances apart, the
  // trailing chart id only separates siblings on the same login.  Keep the
  // prefix intact and shrink any long numeric segment to its last 4 digits
  // so the whole label fits on the axis.
  private shortenInstanceId(id: string): string {
    return id
      .split('-')
      .map((part) => (/^\d{9,}$/.test(part) ? `…${part.slice(-4)}` : part))
      .join('-');
  }

  heartbeatLabel(instance: EAFleetItem): string {
    if (!instance.lastHeartbeat) return '—';
    const elapsed = Date.now() - new Date(instance.lastHeartbeat).getTime();
    if (elapsed < 60_000) return `${Math.round(elapsed / 1000)}s ago`;
    if (elapsed < 3_600_000) return `${Math.round(elapsed / 60_000)}m ago`;
    if (elapsed < 48 * 3_600_000) return `${Math.round(elapsed / 3_600_000)}h ago`;
    return `${Math.round(elapsed / 86_400_000)}d ago`;
  }

  // Heartbeat tier mirrors the engine's 60s DATA_UNAVAILABLE threshold — past
  // that, the EA's symbols are about to be released.
  heartbeatTier(instance: EAFleetItem): 'fresh' | 'stale' | 'dead' | 'unknown' {
    // A finished deregistration is expected to be silent — its months-old heartbeat is not an alarm.
    if (!instance.lastHeartbeat || this.statusOf(instance) === 'Deregistered') return 'unknown';
    const elapsed = Date.now() - new Date(instance.lastHeartbeat).getTime();
    if (elapsed < 30_000) return 'fresh';
    if (elapsed < 60_000) return 'stale';
    return 'dead';
  }

  uptimeLabel(instance: EAFleetItem): string {
    // Time since registration is uptime only while the EA is alive; for a dead row it would claim
    // weeks of uptime for an instance that stopped heartbeating long ago.
    if (!instance.registeredAt || instance.status !== 'Active') return '—';
    const elapsed = Date.now() - new Date(instance.registeredAt).getTime();
    if (elapsed < 60_000) return `${Math.round(elapsed / 1000)}s`;
    if (elapsed < 3_600_000) return `${Math.round(elapsed / 60_000)}m`;
    if (elapsed < 86_400_000) return `${(elapsed / 3_600_000).toFixed(1)}h`;
    return `${Math.round(elapsed / 86_400_000)}d`;
  }

  /**
   * Resolve the trading-account record backing an EA instance card.
   * Returns null until the first accounts fetch lands — the template
   * renders an em dash placeholder in that window.
   */
  accountOf(instance: EAFleetItem): TradingAccountDto | null {
    return this.accountsById().get(instance.tradingAccountId) ?? null;
  }

  /** Account currency code (e.g. "USD"). Falls back to the empty string. */
  accountCurrency(instance: EAFleetItem): string {
    return this.accountOf(instance)?.currency ?? '';
  }

  /**
   * Tier the equity/balance freshness off the account's lastSyncedAt so
   * the card can dim/highlight the value when the broker snapshot is
   * stale.  Mirrors the heartbeat tier semantics — the engine's broker-
   * snapshot worker pushes a sync every ~15s during market hours; past
   * 60s we treat it as stale.
   */
  syncTier(instance: EAFleetItem): 'fresh' | 'stale' | 'dead' | 'unknown' {
    const a = this.accountOf(instance);
    if (!a?.lastSyncedAt) return 'unknown';
    const elapsed = Date.now() - new Date(a.lastSyncedAt).getTime();
    if (elapsed < 30_000) return 'fresh';
    if (elapsed < 60_000) return 'stale';
    return 'dead';
  }

  /** Optional tooltip on the equity/balance row — surfaces the broker
   *  sync timestamp so operators can spot a stuck account snapshot. */
  syncTitle(instance: EAFleetItem): string {
    const a = this.accountOf(instance);
    if (!a?.lastSyncedAt) return 'No broker snapshot yet';
    return `Last broker sync: ${new Date(a.lastSyncedAt).toLocaleString()}`;
  }
}
