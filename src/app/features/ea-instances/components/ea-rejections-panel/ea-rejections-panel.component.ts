import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, map, of } from 'rxjs';

import { SignalRejectionsService } from '@core/services/signal-rejections.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { SignalRejectionEventDto, SignalRejectionStage } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { ProgressBarComponent } from '@shared/components/ui/progress-bar/progress-bar.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

type StageFilter = 'all' | SignalRejectionStage;

const STAGE_OPTIONS: ReadonlyArray<{ value: StageFilter; label: string }> = [
  { value: 'all', label: 'All stages' },
  { value: 'Local', label: 'Local (EA gate)' },
  { value: 'Engine', label: 'Engine' },
  { value: 'Broker', label: 'Broker' },
];

/**
 * One operator-actionable "rejection incident": a bucket of events that
 * share a (stage, subStage). A single SafetyGate.MaxLotsPerOrder
 * misconfig will fire 20+ events per polling window — grouping them
 * collapses that wall into one row with a count, symbol chips, and an
 * expand-to-see-events affordance.
 */
interface RejectionIncident {
  key: string;
  stage: SignalRejectionStage;
  subStage: string;
  count: number;
  events: SignalRejectionEventDto[];
  topSymbols: string[];
  symbolOverflow: number;
  latestAt: string;
}

const STAGE_ORDER: Record<SignalRejectionStage, number> = {
  Local: 0,
  Engine: 1,
  Broker: 2,
};

/**
 * v8.47.172 — per-instance rejection log.  Answers "why didn't this EA
 * take signal X?" in one click without VNC-ing into MT5.  Polls
 * `/signal-rejection` filtered by `eaInstanceId` every 15 s; admin can
 * narrow by stage, sub-stage substring, or symbol.
 *
 * Empty state is the healthy default — most EAs reject 0 signals in
 * any given 24h window once the safety stack is tuned.  Two view modes:
 *   - **Grouped** (default): events bucketed by `stage::subStage` so
 *     recurring noise collapses to one row with a count.
 *   - **Flat**: one row per event, for raw inspection.
 *
 * Click a row (in either view) to expand the metadata blob (gate-
 * specific context like drift fraction, notional projection, broker
 * retcode params).
 */
@Component({
  selector: 'app-ea-rejections-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    FormsModule,
    RouterLink,
    CardSkeletonComponent,
    ErrorStateComponent,
    EmptyStateComponent,
    ProgressBarComponent,
    RelativeTimePipe,
  ],
  template: `
    <section class="panel" aria-label="EA signal-rejection log">
      <header class="panel-head">
        <div class="panel-title">
          <h3>Rejection log</h3>
          <span class="muted small">
            @if (rows().length > 0) {
              {{ rows().length }} event{{ rows().length === 1 ? '' : 's' }}
              @if (viewMode() === 'grouped') {
                · {{ incidentGroups().length }} incident{{
                  incidentGroups().length === 1 ? '' : 's'
                }}
              }
            } @else {
              no events
            }
          </span>
        </div>
        <div class="panel-tools">
          <div class="view-toggle" role="tablist" aria-label="Rejection view mode">
            <button
              type="button"
              role="tab"
              class="vt-btn"
              [class.active]="viewMode() === 'grouped'"
              [attr.aria-selected]="viewMode() === 'grouped'"
              (click)="viewMode.set('grouped')"
              title="Group by stage + sub-stage — collapses repeated rejections"
            >
              Grouped
            </button>
            <button
              type="button"
              role="tab"
              class="vt-btn"
              [class.active]="viewMode() === 'flat'"
              [attr.aria-selected]="viewMode() === 'flat'"
              (click)="viewMode.set('flat')"
              title="One row per event — for raw inspection"
            >
              Flat
            </button>
          </div>
          <button
            type="button"
            class="btn btn-ghost"
            (click)="resource.refresh()"
            [disabled]="resource.loading()"
            title="Refresh now"
          >
            @if (resource.loading()) {
              Refreshing…
            } @else {
              Refresh
            }
          </button>
        </div>
      </header>

      <ui-progress-bar [active]="resource.loading()" />

      <!-- ── Compact summary strip ─────────────────────────────────── -->
      @if (rows().length > 0) {
        <div class="summary-strip">
          <span class="stat"
            ><strong>{{ rows().length }}</strong> events</span
          >
          @if (stageCount('Local') > 0) {
            <span class="stat local"
              ><span class="stage-dot" data-stage="Local"></span>Local
              <strong>{{ stageCount('Local') }}</strong></span
            >
          }
          @if (stageCount('Engine') > 0) {
            <span class="stat engine"
              ><span class="stage-dot" data-stage="Engine"></span>Engine
              <strong>{{ stageCount('Engine') }}</strong></span
            >
          }
          @if (stageCount('Broker') > 0) {
            <span class="stat broker"
              ><span class="stage-dot" data-stage="Broker"></span>Broker
              <strong>{{ stageCount('Broker') }}</strong></span
            >
          }
          <span class="stat"
            ><strong>{{ distinctSymbols() }}</strong> symbol{{
              distinctSymbols() === 1 ? '' : 's'
            }}</span
          >
          @if (latestAt(); as t) {
            <span class="stat"
              >newest <strong>{{ t | relativeTime }}</strong></span
            >
          }
        </div>
      }

      <!-- ── Filters ──────────────────────────────────────────────── -->
      <div class="filters">
        <select
          class="input"
          [ngModel]="stageFilter()"
          (ngModelChange)="stageFilter.set($event)"
          aria-label="Filter by stage"
        >
          @for (opt of stageOptions; track opt.value) {
            <option [value]="opt.value">{{ opt.label }}</option>
          }
        </select>
        <input
          type="text"
          class="input"
          placeholder="Sub-stage substring (e.g. SafetyGate.)"
          [ngModel]="subStageFilter()"
          (ngModelChange)="onSubStageChange($event)"
          aria-label="Filter by SubStage substring"
        />
        <input
          type="text"
          class="input"
          placeholder="Symbol (e.g. EURGBP)"
          [ngModel]="symbolFilter()"
          (ngModelChange)="onSymbolChange($event)"
          aria-label="Filter by symbol"
        />
        @if (hasFilters()) {
          <button type="button" class="link-btn" (click)="clearFilters()">Clear filters</button>
        }
        @if (viewMode() === 'grouped' && incidentGroups().length > 0) {
          <div class="link-group">
            <button type="button" class="link-btn" (click)="expandAllGroups()">Expand all</button>
            <button type="button" class="link-btn" (click)="collapseAllGroups()">
              Collapse all
            </button>
          </div>
        }
      </div>

      @if (loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (resource.error()) {
        <app-error-state
          title="Could not load rejection log"
          message="Engine returned an error fetching rejection events."
          (retry)="resource.refresh()"
        />
      } @else if (rows().length === 0) {
        <app-empty-state
          title="No rejections in the last 24h"
          message="EA is processing every eligible signal — no local gate, engine check, or broker retcode has fired against this account."
        />
      } @else if (viewMode() === 'grouped') {
        @if (incidentGroups().length === 0) {
          <p class="empty-line muted">No rejections match the current filters.</p>
        } @else {
          <div class="rejection-scroll">
            <div class="incident-list">
              @for (g of incidentGroups(); track g.key) {
                <article class="incident" [attr.data-stage]="g.stage">
                  <header
                    class="incident-head"
                    (click)="toggleGroup(g.key)"
                    role="button"
                    [attr.aria-expanded]="isGroupOpen(g.key)"
                  >
                    <span class="incident-chev" [class.open]="isGroupOpen(g.key)">&#9654;</span>
                    <span class="stage-pill" [attr.data-stage]="g.stage">{{ g.stage }}</span>
                    <span class="substage mono">{{ g.subStage }}</span>
                    <span class="incident-count">×&nbsp;{{ g.count }}</span>
                    <span class="incident-symbols">
                      @for (s of g.topSymbols; track s) {
                        <button
                          type="button"
                          class="sym-chip"
                          (click)="filterBySymbol(s); $event.stopPropagation()"
                          [title]="'Filter by ' + s"
                        >
                          {{ s }}
                        </button>
                      }
                      @if (g.symbolOverflow > 0) {
                        <span class="sym-overflow muted">+{{ g.symbolOverflow }}</span>
                      }
                    </span>
                    <span class="incident-time muted">
                      latest {{ g.latestAt | relativeTime }}
                    </span>
                  </header>
                  @if (isGroupOpen(g.key)) {
                    <div class="incident-body">
                      @for (row of g.events; track row.id) {
                        <div class="event-row">
                          <div
                            class="event-head"
                            (click)="toggle(row.id)"
                            role="button"
                            [attr.aria-expanded]="expanded() === row.id"
                          >
                            <span class="time" [title]="row.createdAt | date: 'medium'">{{
                              row.createdAt | relativeTime
                            }}</span>
                            <a
                              class="signal mono"
                              [routerLink]="['/trade-signals', row.tradeSignalId]"
                              (click)="$event.stopPropagation()"
                              title="Open signal detail — cross-account attempts"
                              >#{{ row.tradeSignalId }}</a
                            >
                            <span class="symbol mono">{{ row.symbol ?? '—' }}</span>
                            <span class="reason">{{ row.reason }}</span>
                            <span class="event-chev" [class.open]="expanded() === row.id"
                              >&#9654;</span
                            >
                          </div>
                          @if (expanded() === row.id) {
                            <div class="metadata-wrap">
                              <div class="metadata-bar">
                                <span class="muted small">Metadata</span>
                                <button
                                  type="button"
                                  class="link-btn"
                                  (click)="copyMetadata(row.metadataJson)"
                                >
                                  Copy JSON
                                </button>
                              </div>
                              <pre class="metadata">{{ formatMetadata(row.metadataJson) }}</pre>
                            </div>
                          }
                        </div>
                      }
                    </div>
                  }
                </article>
              }
            </div>
          </div>
        }
      } @else {
        <!-- Flat view -->
        <div class="rejection-scroll">
          <ul class="rejection-list" role="list">
            <li class="rejection-row legend" aria-hidden="true">
              <div class="row-head row-legend">
                <span>Time</span>
                <span>Signal</span>
                <span>Symbol</span>
                <span>Stage</span>
                <span>Sub-stage</span>
                <span>Reason</span>
              </div>
            </li>
            @for (row of rows(); track row.id) {
              <li class="rejection-row" [attr.data-stage]="row.stage">
                <div
                  class="row-head"
                  (click)="toggle(row.id)"
                  role="button"
                  [attr.aria-expanded]="expanded() === row.id"
                >
                  <span class="time" [title]="row.createdAt | date: 'medium'">
                    {{ row.createdAt | relativeTime }}
                  </span>
                  <a
                    class="signal mono"
                    [routerLink]="['/trade-signals', row.tradeSignalId]"
                    (click)="$event.stopPropagation()"
                    title="Open signal detail — cross-account attempts"
                    >#{{ row.tradeSignalId }}</a
                  >
                  <button
                    type="button"
                    class="symbol-btn mono"
                    (click)="filterBySymbol(row.symbol ?? ''); $event.stopPropagation()"
                    [title]="row.symbol ? 'Filter by ' + row.symbol : ''"
                    [disabled]="!row.symbol"
                  >
                    {{ row.symbol ?? '—' }}
                  </button>
                  <span class="stage-pill" [attr.data-stage]="row.stage">{{ row.stage }}</span>
                  <span class="substage mono">{{ row.subStage }}</span>
                  <span class="reason">{{ row.reason }}</span>
                </div>
                @if (expanded() === row.id) {
                  <div class="metadata-wrap">
                    <div class="metadata-bar">
                      <span class="muted small">Metadata</span>
                      <button
                        type="button"
                        class="link-btn"
                        (click)="copyMetadata(row.metadataJson)"
                      >
                        Copy JSON
                      </button>
                    </div>
                    <pre class="metadata">{{ formatMetadata(row.metadataJson) }}</pre>
                  </div>
                }
              </li>
            }
          </ul>
        </div>
      }
    </section>
  `,
  styles: [
    `
      .panel {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding, var(--space-4));
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
      }
      .panel-title {
        display: flex;
        align-items: baseline;
        gap: var(--space-2);
      }
      .panel-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .panel-tools {
        display: inline-flex;
        align-items: center;
        gap: var(--space-2);
      }

      .small {
        font-size: var(--text-xs);
      }
      .muted {
        color: var(--text-tertiary);
      }

      /* ── View toggle ──────────────────────────────────────────── */
      .view-toggle {
        display: inline-flex;
        gap: 2px;
        padding: 2px;
        background: var(--bg-tertiary);
        border-radius: var(--radius-full);
      }
      .vt-btn {
        appearance: none;
        border: none;
        background: transparent;
        color: var(--text-secondary);
        font-family: inherit;
        font-size: 11px;
        font-weight: var(--font-semibold);
        padding: 3px 10px;
        border-radius: var(--radius-full);
        cursor: pointer;
        transition:
          background 0.12s ease,
          color 0.12s ease;
      }
      .vt-btn:hover {
        color: var(--text-primary);
      }
      .vt-btn.active {
        background: var(--bg-secondary);
        color: var(--text-primary);
        box-shadow: 0 0 0 1px var(--border);
      }

      /* ── Buttons ──────────────────────────────────────────────── */
      .btn {
        height: 28px;
        padding: 0 12px;
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        cursor: pointer;
        border: 1px solid transparent;
        font-family: inherit;
      }
      .btn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .btn-ghost {
        background: transparent;
        color: var(--text-secondary);
        border-color: var(--border);
      }
      .btn-ghost:hover:not(:disabled) {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .link-btn {
        appearance: none;
        background: transparent;
        border: none;
        color: var(--accent, #0071e3);
        font-family: inherit;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        cursor: pointer;
        padding: 0;
      }
      .link-btn:hover {
        text-decoration: underline;
      }
      .link-group {
        display: inline-flex;
        gap: var(--space-2);
        align-items: center;
      }
      .link-group .link-btn + .link-btn::before {
        content: '·';
        margin-right: var(--space-2);
        color: var(--text-tertiary);
      }

      /* ── Summary strip (1-liner) ──────────────────────────────── */
      .summary-strip {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-3);
        padding: 6px var(--space-3);
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .stat {
        display: inline-flex;
        align-items: baseline;
        gap: 5px;
      }
      .stat strong {
        color: var(--text-primary);
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
        font-size: 13px;
      }
      .stat + .stat::before {
        content: '·';
        margin-right: var(--space-3);
        color: var(--text-tertiary);
      }
      .stage-dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        align-self: center;
      }
      .stage-dot[data-stage='Local'] {
        background: #cb8a17;
      }
      .stage-dot[data-stage='Engine'] {
        background: #0058b8;
      }
      .stage-dot[data-stage='Broker'] {
        background: #c93631;
      }

      /* ── Filters row ──────────────────────────────────────────── */
      .filters {
        display: flex;
        gap: var(--space-2);
        flex-wrap: wrap;
        align-items: center;
      }
      .input {
        height: 30px;
        min-width: 140px;
        padding: 0 10px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-xs);
        outline: none;
        transition: border-color 0.12s ease;
      }
      .input:focus {
        border-color: var(--accent, #0071e3);
      }

      /* ── Scroll surface ──────────────────────────────────────── */
      .rejection-scroll {
        max-height: 480px;
        overflow: auto;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
      }
      .empty-line {
        margin: 0;
        padding: var(--space-3);
        text-align: center;
        font-size: var(--text-xs);
      }

      /* ── Stage pill (shared) ─────────────────────────────────── */
      .stage-pill {
        font-size: 10.5px;
        font-weight: var(--font-bold);
        padding: 1px 7px;
        border-radius: var(--radius-full);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        flex-shrink: 0;
      }
      .stage-pill[data-stage='Local'] {
        background: rgba(255, 149, 0, 0.16);
        color: #b86200;
      }
      .stage-pill[data-stage='Engine'] {
        background: rgba(0, 113, 227, 0.14);
        color: #0058b8;
      }
      .stage-pill[data-stage='Broker'] {
        background: rgba(255, 59, 48, 0.16);
        color: #c4290a;
      }

      .mono {
        font-family: var(--font-mono, ui-monospace, monospace);
      }

      /* ── Incident cards (grouped view) ───────────────────────── */
      .incident-list {
        display: flex;
        flex-direction: column;
        gap: 1px;
        background: var(--border);
      }
      .incident {
        background: var(--bg-primary);
      }
      .incident-head {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        padding: 8px var(--space-3);
        cursor: pointer;
        user-select: none;
        flex-wrap: wrap;
        border-left: 3px solid transparent;
        transition: background 0.1s ease;
      }
      .incident-head:hover {
        background: var(--bg-secondary);
      }
      .incident[data-stage='Local'] .incident-head {
        border-left-color: #cb8a17;
      }
      .incident[data-stage='Engine'] .incident-head {
        border-left-color: #0058b8;
      }
      .incident[data-stage='Broker'] .incident-head {
        border-left-color: #c93631;
      }
      .incident-chev,
      .event-chev {
        font-size: 9px;
        color: var(--text-tertiary);
        transition: transform 0.15s ease;
        flex-shrink: 0;
      }
      .incident-chev.open,
      .event-chev.open {
        transform: rotate(90deg);
      }
      .substage {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        word-break: break-all;
      }
      .incident-count {
        font-size: 11px;
        font-weight: var(--font-bold);
        color: var(--text-primary);
        background: var(--bg-tertiary);
        padding: 1px 8px;
        border-radius: var(--radius-full);
        font-variant-numeric: tabular-nums;
      }
      .incident-symbols {
        display: inline-flex;
        flex-wrap: wrap;
        gap: 4px;
        align-items: center;
        max-width: 360px;
      }
      .sym-chip {
        appearance: none;
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-secondary);
        font-family: var(--font-mono, monospace);
        font-size: 10.5px;
        padding: 1px 6px;
        border-radius: var(--radius-sm);
        cursor: pointer;
        transition:
          background 0.1s ease,
          color 0.1s ease;
      }
      .sym-chip:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .sym-overflow {
        font-size: 10.5px;
      }
      .incident-time {
        margin-left: auto;
        font-size: 11px;
        white-space: nowrap;
      }
      .incident-body {
        background: var(--bg-secondary);
        border-top: 1px solid var(--border);
        padding: 4px 8px 4px 28px;
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .event-row {
        background: var(--bg-primary);
        border-radius: var(--radius-sm);
      }
      .event-head {
        display: grid;
        grid-template-columns: 80px 80px 80px 1fr 16px;
        gap: var(--space-2);
        align-items: center;
        padding: 6px var(--space-2);
        cursor: pointer;
        font-size: 12px;
      }
      .event-head:hover {
        background: var(--bg-secondary);
      }

      /* ── Flat list (unchanged shape, refreshed tokens) ────────── */
      .rejection-list {
        list-style: none;
        padding: 0;
        margin: 0;
      }
      .rejection-row {
        border-bottom: 1px solid var(--border);
        padding: 0;
      }
      .rejection-row:last-child {
        border-bottom: 0;
      }
      .row-head {
        display: grid;
        grid-template-columns: 90px 70px 90px 80px 160px 1fr;
        gap: var(--space-2);
        cursor: pointer;
        align-items: center;
        font-size: 12px;
        padding: 6px var(--space-3);
        border-left: 3px solid transparent;
      }
      .row-head:hover {
        background: var(--bg-secondary);
      }
      .rejection-row[data-stage='Local'] .row-head {
        border-left-color: #cb8a17;
      }
      .rejection-row[data-stage='Engine'] .row-head {
        border-left-color: #0058b8;
      }
      .rejection-row[data-stage='Broker'] .row-head {
        border-left-color: #c93631;
      }
      .rejection-row.legend .row-head {
        background: var(--bg-secondary);
        cursor: default;
        position: sticky;
        top: 0;
        z-index: 1;
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        border-left-color: transparent;
      }
      .row-legend span {
        white-space: nowrap;
      }
      .time {
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
      }
      .signal {
        color: var(--text-secondary);
        text-decoration: none;
      }
      .signal:hover {
        color: var(--accent, #0071e3);
        text-decoration: underline;
      }
      .symbol-btn {
        appearance: none;
        background: transparent;
        border: none;
        color: var(--text-primary);
        font-weight: var(--font-semibold);
        text-align: left;
        cursor: pointer;
        padding: 0;
        font-family: var(--font-mono, monospace);
        font-size: 12px;
      }
      .symbol-btn:hover:not(:disabled) {
        color: var(--accent, #0071e3);
      }
      .symbol-btn:disabled {
        color: var(--text-tertiary);
        cursor: default;
      }
      .reason {
        color: var(--text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* ── Metadata expansion (shared) ─────────────────────────── */
      .metadata-wrap {
        background: var(--bg-secondary);
        border-top: 1px dashed var(--border);
        padding: 6px var(--space-3) 8px;
      }
      .metadata-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 4px;
      }
      .metadata {
        background: var(--bg-tertiary);
        padding: 8px 10px;
        border-radius: var(--radius-sm);
        font-size: 11px;
        font-family: var(--font-mono, monospace);
        margin: 0;
        overflow-x: auto;
        max-height: 240px;
        overflow-y: auto;
      }
    `,
  ],
})
export class EARejectionsPanelComponent {
  // Intentionally non-required: createPolledResource invokes the fetcher
  // synchronously inside its field-initializer, which would otherwise
  // hit Angular's NG0950 ("required input not yet available") because
  // parent template bindings don't flush until after construction.
  // The fetcher's `if (!id)` guard handles the empty first tick and
  // picks up the real instance id on the next polling cycle.
  readonly instanceId = input<string>('');
  readonly stageOptions = STAGE_OPTIONS;

  readonly stageFilter = signal<StageFilter>('all');
  readonly subStageFilter = signal<string>('');
  readonly symbolFilter = signal<string>('');
  readonly expanded = signal<number | null>(null);
  readonly viewMode = signal<'grouped' | 'flat'>('grouped');
  /** Incident keys (stage::subStage) the operator has expanded. */
  readonly openGroups = signal<Set<string>>(new Set());

  private readonly rejectionsService = inject(SignalRejectionsService);
  private readonly notifications = inject(NotificationService);

  // Debounce text inputs so each keystroke doesn't burst the engine —
  // same pattern as ea-audit-timeline.  committedSubStage/Symbol are the
  // values the fetcher actually reads; the two raw signals are bound to
  // the inputs directly so typing remains responsive.
  private readonly committedSubStage = signal<string>('');
  private readonly committedSymbol = signal<string>('');
  private debounceHandle: ReturnType<typeof setTimeout> | null = null;

  onSubStageChange(value: string): void {
    this.subStageFilter.set(value);
    this.scheduleDebouncedCommit();
  }

  onSymbolChange(value: string): void {
    this.symbolFilter.set(value);
    this.scheduleDebouncedCommit();
  }

  private scheduleDebouncedCommit(): void {
    if (this.debounceHandle != null) clearTimeout(this.debounceHandle);
    this.debounceHandle = setTimeout(() => {
      this.committedSubStage.set(this.subStageFilter().trim());
      this.committedSymbol.set(this.symbolFilter().trim());
    }, 350);
  }

  protected readonly resource = createPolledResource(
    () => {
      const id = this.instanceId();
      if (!id) return of<SignalRejectionEventDto[]>([]);
      const stage = this.stageFilter();
      const subStage = this.committedSubStage();
      const symbol = this.committedSymbol();
      return this.rejectionsService
        .list({
          eaInstanceId: id,
          stage: stage === 'all' ? undefined : stage,
          subStage: subStage || undefined,
          symbol: symbol || undefined,
          currentPage: 1,
          itemCountPerPage: 100,
        })
        .pipe(
          map((res) => res.data?.data ?? []),
          catchError(() => of<SignalRejectionEventDto[]>([])),
        );
    },
    { intervalMs: 15_000 },
  );

  readonly rows = computed(() => this.resource.value() ?? []);
  readonly loading = computed(
    () => this.resource.loading() && (this.resource.value() ?? null) === null,
  );

  // ── Summary metrics ────────────────────────────────────────────
  stageCount(stage: SignalRejectionStage): number {
    return this.rows().filter((r) => r.stage === stage).length;
  }

  readonly distinctSymbols = computed(() => new Set(this.rows().map((r) => r.symbol ?? '—')).size);

  readonly latestAt = computed<string | null>(() => {
    const xs = this.rows();
    if (xs.length === 0) return null;
    return xs.reduce((max, r) => (r.createdAt > max ? r.createdAt : max), xs[0].createdAt);
  });

  /**
   * Events bucketed by `stage × subStage`. Drives the grouped view.
   * Sort: stage (Local → Engine → Broker), then count desc, then most
   * recent. The intuition: same-stage incidents stay together; the
   * loudest noise sits at the top of each stage's group.
   */
  readonly incidentGroups = computed<RejectionIncident[]>(() => {
    const buckets = new Map<string, SignalRejectionEventDto[]>();
    for (const r of this.rows()) {
      const key = `${r.stage}::${r.subStage}`;
      const list = buckets.get(key) ?? [];
      list.push(r);
      buckets.set(key, list);
    }
    const out: RejectionIncident[] = [];
    for (const [key, events] of buckets.entries()) {
      const [stage, subStage] = key.split('::') as [SignalRejectionStage, string];
      const symbols: string[] = [];
      let latestAt = '';
      const sortedEvents = [...events].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      for (const e of sortedEvents) {
        const s = e.symbol ?? '—';
        if (!symbols.includes(s)) symbols.push(s);
        if (e.createdAt > latestAt) latestAt = e.createdAt;
      }
      out.push({
        key,
        stage,
        subStage,
        count: events.length,
        events: sortedEvents,
        topSymbols: symbols.slice(0, 5),
        symbolOverflow: Math.max(0, symbols.length - 5),
        latestAt,
      });
    }
    return out.sort((a, b) => {
      const sa = STAGE_ORDER[a.stage];
      const sb = STAGE_ORDER[b.stage];
      if (sa !== sb) return sa - sb;
      if (a.count !== b.count) return b.count - a.count;
      return (b.latestAt ?? '').localeCompare(a.latestAt ?? '');
    });
  });

  hasFilters(): boolean {
    return (
      this.stageFilter() !== 'all' ||
      this.subStageFilter().trim() !== '' ||
      this.symbolFilter().trim() !== ''
    );
  }

  clearFilters(): void {
    this.stageFilter.set('all');
    this.subStageFilter.set('');
    this.symbolFilter.set('');
    this.committedSubStage.set('');
    this.committedSymbol.set('');
  }

  filterBySymbol(symbol: string): void {
    if (!symbol || symbol === '—') return;
    this.symbolFilter.set(symbol);
    this.committedSymbol.set(symbol);
  }

  // ── Grouped view actions ───────────────────────────────────────
  toggleGroup(key: string): void {
    const next = new Set(this.openGroups());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.openGroups.set(next);
  }

  isGroupOpen(key: string): boolean {
    return this.openGroups().has(key);
  }

  expandAllGroups(): void {
    this.openGroups.set(new Set(this.incidentGroups().map((g) => g.key)));
  }

  collapseAllGroups(): void {
    this.openGroups.set(new Set());
  }

  // ── Per-event actions ──────────────────────────────────────────
  toggle(id: number): void {
    this.expanded.set(this.expanded() === id ? null : id);
  }

  copyMetadata(json: string | null): void {
    const formatted = this.formatMetadata(json);
    if (!navigator.clipboard?.writeText) {
      this.notifications.error('Clipboard unavailable in this browser.');
      return;
    }
    navigator.clipboard
      .writeText(formatted)
      .then(() => this.notifications.success('Metadata copied.'))
      .catch(() => this.notifications.error('Copy failed.'));
  }

  formatMetadata(json: string | null): string {
    if (!json) return '(no metadata)';
    try {
      return JSON.stringify(JSON.parse(json), null, 2);
    } catch {
      return json;
    }
  }
}
