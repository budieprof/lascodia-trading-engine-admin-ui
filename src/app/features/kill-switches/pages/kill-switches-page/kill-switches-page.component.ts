import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnInit,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule, ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { catchError, forkJoin, map, of } from 'rxjs';

import { KillSwitchService } from '@core/services/kill-switch.service';
import { StrategiesService } from '@core/services/strategies.service';
import { AuditTrailService } from '@core/services/audit-trail.service';
import { NotificationService } from '@core/notifications/notification.service';
import type {
  KillSwitchStatusDto,
  StrategyDto,
  ToggleKillSwitchRequest,
} from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { PresenceBadgeComponent } from '@shared/components/presence-badge/presence-badge.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';

interface StrategySwitch {
  strategy: StrategyDto;
  status: KillSwitchStatusDto | null;
}

type SortKey = 'id' | 'status' | 'symbol' | 'timeframe' | 'switch' | 'changed';

/** Rows per page on the per-strategy table. */
const PAGE_SIZE = 25;

@Component({
  selector: 'app-kill-switches-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PageHeaderComponent,
    PresenceBadgeComponent,
    CardSkeletonComponent,
    EmptyStateComponent,
    ErrorStateComponent,
    ReactiveFormsModule,
    FormsModule,
    DatePipe,
  ],
  template: `
    <div class="page">
      <app-page-header title="Kill Switches" subtitle="Global and per-strategy circuit breakers">
        <app-presence-badge routeKey="kill-switches" />
      </app-page-header>

      <section class="global-card" [class.engaged]="service.isGlobalEngaged()">
        <div class="global-head">
          <div class="global-title">
            <span class="indicator" [class.on]="service.isGlobalEngaged()"></span>
            <div>
              <h3>Global Kill Switch</h3>
              <p class="muted">
                When engaged, no new signals are generated and no new orders are submitted. Existing
                positions are untouched.
              </p>
            </div>
          </div>
          <button
            type="button"
            class="btn"
            [class.btn-destructive]="!service.isGlobalEngaged()"
            [class.btn-primary]="service.isGlobalEngaged()"
            [disabled]="busyGlobal()"
            (click)="requestGlobalToggle()"
          >
            {{ service.isGlobalEngaged() ? 'Disengage' : 'Engage Kill Switch' }}
          </button>
        </div>
        @if (service.global(); as g) {
          <dl class="global-meta">
            <div>
              <dt>State</dt>
              <dd>
                <span class="pill" [class.on]="g.enabled">
                  {{ g.enabled ? 'Engaged' : 'Not engaged' }}
                </span>
              </dd>
            </div>
            @if (g.changedAt) {
              <div>
                <dt>Changed</dt>
                <dd>{{ g.changedAt | date: 'MMM d, yyyy HH:mm' }}</dd>
              </div>
            }
            @if (g.changedBy) {
              <div>
                <dt>By</dt>
                <dd>{{ g.changedBy }}</dd>
              </div>
            }
            @if (g.reason) {
              <div class="reason">
                <dt>Reason</dt>
                <dd>{{ g.reason }}</dd>
              </div>
            }
          </dl>
        }
      </section>

      <section class="strategies-card">
        <header class="card-head">
          <div class="card-head-title">
            <h3>Per-Strategy Kill Switches</h3>
            <span class="muted">
              @if (engagedCount() > 0) {
                <span class="engaged-count">{{ engagedCount() }} engaged</span>
                ·
              }
              {{ filteredRows().length }} of {{ rows().length }} · engaged first, then by
              {{ sortLabel() }}
            </span>
          </div>
          @if (rows().length > 0) {
            <div class="card-tools">
              <input
                type="search"
                class="search"
                placeholder="Filter by name, symbol, ID…"
                [ngModel]="searchTerm()"
                (ngModelChange)="searchTerm.set($event)"
                aria-label="Filter strategies"
              />
              <div class="chip-row" role="tablist" aria-label="Status filter">
                @for (f of statusFilters; track f.value) {
                  <button
                    type="button"
                    role="tab"
                    class="chip"
                    [class.active]="statusFilter() === f.value"
                    [attr.aria-selected]="statusFilter() === f.value"
                    (click)="statusFilter.set(f.value)"
                  >
                    {{ f.label }}
                    <span class="chip-count">{{ statusCount(f.value) }}</span>
                  </button>
                }
              </div>
            </div>
          }
        </header>
        @if (loading()) {
          <app-card-skeleton [lines]="6" [showHeader]="false" />
        } @else if (loadError(); as err) {
          <app-error-state title="Could not load strategies" [message]="err" (retry)="reload()" />
        } @else if (rows().length === 0) {
          <app-empty-state
            title="No strategies found"
            description="Create a strategy before configuring per-strategy kill switches."
          />
        } @else if (filteredRows().length === 0) {
          <p class="empty-line">{{ emptyFilterMessage() }}</p>
        } @else {
          <!-- Paged, not a fixed-height scroll box: the old container cut the twelfth row in
               half with no scrollbar while the header claimed every row was shown. -->
          <div class="table-scroll">
            <table class="table">
              <thead>
                <tr>
                  @for (col of columns; track col.key) {
                    <th [class.sorted]="sortKey() === col.key">
                      <button
                        type="button"
                        class="sort-btn"
                        (click)="toggleSort(col.key)"
                        [attr.aria-sort]="
                          sortKey() === col.key
                            ? sortDir() === 'asc'
                              ? 'ascending'
                              : 'descending'
                            : 'none'
                        "
                      >
                        {{ col.label }}
                        @if (sortKey() === col.key) {
                          <span aria-hidden="true">{{ sortDir() === 'asc' ? '▲' : '▼' }}</span>
                        }
                      </button>
                    </th>
                  }
                  <th class="actions">Action</th>
                </tr>
              </thead>
              <tbody>
                @for (row of pagedRows(); track row.strategy.id) {
                  <tr [class.row-engaged]="row.status?.enabled">
                    <td>
                      <strong>#{{ row.strategy.id }}</strong> {{ row.strategy.name ?? '—' }}
                    </td>
                    <td>
                      <span class="status-pill" [attr.data-status]="row.strategy.status">
                        {{ row.strategy.status }}
                      </span>
                    </td>
                    <td>{{ row.strategy.symbol ?? '—' }}</td>
                    <td>{{ row.strategy.timeframe }}</td>
                    <td>
                      @if (row.status === null) {
                        <span class="pill unknown" title="Kill-switch status could not be read">
                          Unknown
                        </span>
                      } @else {
                        <span class="pill" [class.on]="row.status.enabled">
                          {{ row.status.enabled ? 'Engaged' : 'Not engaged' }}
                        </span>
                      }
                    </td>
                    <td class="muted">
                      {{
                        row.status?.changedAt
                          ? (row.status!.changedAt | date: 'MMM d, yyyy HH:mm')
                          : '—'
                      }}
                    </td>
                    <td class="actions">
                      <button
                        type="button"
                        class="btn-row"
                        [class.danger]="!row.status?.enabled"
                        [disabled]="busyStrategyIds().has(row.strategy.id)"
                        (click)="requestStrategyToggle(row)"
                      >
                        {{ row.status?.enabled ? 'Disengage' : 'Engage' }}
                      </button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          @if (pageCount() > 1) {
            <footer class="pager">
              <span class="muted">
                {{ pageStart() + 1 }}–{{ pageEnd() }} of {{ filteredRows().length }}
              </span>
              <div class="pager-controls">
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  [disabled]="page() === 0"
                  (click)="page.set(page() - 1)"
                >
                  Previous
                </button>
                <span class="muted">Page {{ page() + 1 }} of {{ pageCount() }}</span>
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  [disabled]="page() >= pageCount() - 1"
                  (click)="page.set(page() + 1)"
                >
                  Next
                </button>
              </div>
            </footer>
          }
        }
      </section>

      @if (dialogOpen()) {
        <div
          class="modal-backdrop"
          role="presentation"
          (click)="cancelDialog()"
          (keydown)="onModalKey($event)"
          tabindex="-1"
        >
          <div
            class="modal-panel"
            role="dialog"
            aria-modal="true"
            [attr.aria-labelledby]="dialogTitleId"
            [attr.data-variant]="dialogVariant()"
            (click)="$event.stopPropagation()"
          >
            <header class="modal-head">
              <h3 [id]="dialogTitleId">{{ dialogTitle() }}</h3>
            </header>
            <form
              class="modal-body"
              [formGroup]="reasonForm"
              (ngSubmit)="submitToggle()"
              (keydown)="onModalKey($event)"
            >
              <p class="modal-message">{{ dialogMessage() }}</p>
              <label class="modal-label" for="ks-reason">Reason (written to audit trail)</label>
              <textarea
                id="ks-reason"
                formControlName="reason"
                rows="3"
                placeholder="e.g. Broker feed stalled; halting to investigate"
                [attr.aria-invalid]="
                  reasonForm.controls.reason.invalid && reasonForm.controls.reason.touched
                "
                #reasonInput
              ></textarea>
              @if (reasonForm.controls.reason.invalid && reasonForm.controls.reason.touched) {
                <span class="err">Reason is required (min 3 characters).</span>
              } @else {
                <span class="modal-hint muted">
                  Tip: ⌘/Ctrl + Enter to confirm, Esc to cancel.
                </span>
              }
              <footer class="modal-actions">
                <button
                  type="button"
                  class="btn btn-ghost"
                  [disabled]="busyGlobal() || dialogBusy()"
                  (click)="cancelDialog()"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  class="btn"
                  [class.btn-destructive]="dialogVariant() === 'destructive'"
                  [class.btn-primary]="dialogVariant() === 'primary'"
                  [disabled]="busyGlobal() || dialogBusy()"
                >
                  @if (busyGlobal() || dialogBusy()) {
                    Submitting…
                  } @else {
                    {{ dialogConfirmLabel() }}
                  }
                </button>
              </footer>
            </form>
          </div>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-5);
      }

      .global-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-5) var(--space-6);
        box-shadow: var(--shadow-sm);
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .global-card.engaged {
        border-color: rgba(255, 59, 48, 0.3);
        background: rgba(255, 59, 48, 0.04);
      }
      .global-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: var(--space-4);
        flex-wrap: wrap;
      }
      .global-title {
        display: flex;
        align-items: flex-start;
        gap: var(--space-3);
        flex: 1;
        min-width: 280px;
      }
      .global-title h3 {
        margin: 0;
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
      }
      .global-title p.muted {
        margin: var(--space-1) 0 0;
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .indicator {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        margin-top: 8px;
        background: var(--profit);
        flex-shrink: 0;
      }
      .indicator.on {
        background: var(--loss);
        box-shadow: 0 0 0 4px rgba(255, 59, 48, 0.12);
      }
      .global-meta {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: var(--space-4);
        margin: 0;
        padding-top: var(--space-4);
        border-top: 1px solid var(--border);
      }
      .global-meta dt {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-weight: var(--font-medium);
        margin: 0;
      }
      .global-meta dd {
        margin: var(--space-1) 0 0;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        color: var(--text-primary);
      }
      .global-meta .reason {
        grid-column: 1 / -1;
      }

      .strategies-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .card-head {
        padding: var(--space-3) var(--space-5);
        border-bottom: 1px solid var(--border);
        display: flex;
        align-items: center;
        gap: var(--space-3);
        flex-wrap: wrap;
      }
      .card-head-title {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
        flex-wrap: wrap;
      }
      .card-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .card-head .muted {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
      }
      .engaged-count {
        color: #d70015;
        font-weight: var(--font-semibold);
      }
      .card-tools {
        margin-left: auto;
        display: inline-flex;
        align-items: center;
        gap: var(--space-3);
        flex-wrap: wrap;
      }
      .search {
        appearance: none;
        height: 30px;
        padding: 0 10px;
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
        outline: none;
        width: 240px;
      }
      .search:focus {
        border-color: var(--accent);
      }
      .chip-row {
        display: inline-flex;
        gap: 2px;
        padding: 2px;
        background: var(--bg-tertiary);
        border-radius: var(--radius-full);
      }
      .chip {
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
        display: inline-flex;
        align-items: center;
        gap: 5px;
        transition:
          background 0.12s ease,
          color 0.12s ease;
      }
      .chip:hover {
        color: var(--text-primary);
      }
      .chip.active {
        background: var(--bg-secondary);
        color: var(--text-primary);
        box-shadow: 0 0 0 1px var(--border);
      }
      .chip-count {
        font-size: 10px;
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
      }
      .chip.active .chip-count {
        color: var(--text-secondary);
      }
      .empty-line {
        margin: 0;
        padding: var(--space-4);
        text-align: center;
        color: var(--text-tertiary);
        font-size: var(--text-sm);
      }
      .table-scroll {
        overflow-x: auto;
      }
      .pager {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
        padding: var(--space-2) var(--space-5);
        border-top: 1px solid var(--border);
        font-size: var(--text-xs);
        font-variant-numeric: tabular-nums;
      }
      .pager-controls {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .btn-sm {
        height: 28px;
        padding: 0 var(--space-3);
        font-size: var(--text-xs);
      }
      .sort-btn {
        background: none;
        border: none;
        padding: 0;
        margin: 0;
        font: inherit;
        color: inherit;
        text-transform: inherit;
        letter-spacing: inherit;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .sort-btn:hover {
        color: var(--text-primary);
      }
      .table th.sorted {
        color: var(--text-primary);
      }
      .table {
        width: 100%;
        border-collapse: collapse;
      }
      .table th,
      .table td {
        padding: var(--space-3) var(--space-5);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-sm);
        vertical-align: middle;
      }
      .table tbody tr:hover {
        background: var(--bg-tertiary);
      }
      .table tbody tr.row-engaged {
        background: rgba(255, 59, 48, 0.06);
      }
      .table tbody tr.row-engaged:hover {
        background: rgba(255, 59, 48, 0.1);
      }
      .table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .muted {
        color: var(--text-tertiary);
      }
      /* "Not engaged" is the normal state — neutral grey, not green: green would make an
         engaged row's red the only colour and the rest of the column a wall of "good". */
      .pill {
        display: inline-flex;
        padding: 2px 10px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        background: rgba(142, 142, 147, 0.16);
        color: var(--text-secondary);
        white-space: nowrap;
      }
      .pill.on {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .pill.unknown {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }
      .status-pill {
        display: inline-flex;
        padding: 2px 10px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        background: rgba(142, 142, 147, 0.16);
        color: var(--text-secondary);
        white-space: nowrap;
      }
      .status-pill[data-status='Active'] {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .status-pill[data-status='Paused'] {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }
      .actions {
        text-align: right;
        white-space: nowrap;
      }
      /* Row action: small outlined button, red only when it would engage (the risky direction).
         Matches the filled red global button in colour without competing with it in weight. */
      .btn-row {
        height: 28px;
        padding: 0 var(--space-3);
        border-radius: var(--radius-full);
        border: 1px solid var(--border);
        background: transparent;
        color: var(--text-primary);
        font-family: inherit;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        cursor: pointer;
      }
      .btn-row:hover:not(:disabled) {
        background: var(--bg-tertiary);
      }
      .btn-row.danger {
        color: var(--loss);
        border-color: rgba(255, 59, 48, 0.4);
      }
      .btn-row.danger:hover:not(:disabled) {
        background: rgba(255, 59, 48, 0.08);
      }
      .btn-row:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .btn {
        height: 36px;
        padding: 0 var(--space-4);
        border-radius: var(--radius-full);
        border: none;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .btn-primary {
        background: var(--accent);
        color: white;
      }
      .btn-primary:hover:not(:disabled) {
        background: var(--accent-hover);
      }
      .btn-destructive {
        background: var(--loss);
        color: white;
      }
      .btn-destructive:hover:not(:disabled) {
        opacity: 0.9;
      }

      /* ── Consolidated confirm + reason modal ─────────────────── */
      .modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.32);
        backdrop-filter: blur(2px);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--space-4);
        z-index: 1100;
        animation: fadeIn 120ms ease;
      }
      .modal-panel {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        width: min(520px, 100%);
        max-height: 90vh;
        overflow: auto;
        display: flex;
        flex-direction: column;
        animation: panelIn 140ms ease-out;
        border-top: 3px solid var(--border);
      }
      .modal-panel[data-variant='destructive'] {
        border-top-color: var(--loss);
      }
      .modal-panel[data-variant='primary'] {
        border-top-color: var(--accent);
      }
      .modal-head {
        padding: var(--space-4) var(--space-5) 0;
      }
      .modal-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .modal-body {
        padding: var(--space-3) var(--space-5) var(--space-4);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .modal-message {
        margin: 0 0 var(--space-2) 0;
        font-size: var(--text-sm);
        color: var(--text-secondary);
        line-height: 1.45;
      }
      .modal-label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-weight: var(--font-medium);
      }
      .modal-body textarea {
        padding: var(--space-2) var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-secondary);
        color: var(--text-primary);
        font-family: inherit;
        font-size: var(--text-sm);
        outline: none;
        resize: vertical;
        min-height: 72px;
        transition: border-color 0.15s ease;
      }
      .modal-body textarea:focus {
        border-color: var(--accent);
      }
      .modal-body textarea[aria-invalid='true'] {
        border-color: var(--loss);
      }
      .modal-hint {
        font-size: 11px;
      }
      .err {
        color: var(--loss);
        font-size: var(--text-xs);
      }
      .modal-actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-2);
        padding-top: var(--space-2);
        border-top: 1px solid var(--border);
        margin-top: var(--space-2);
      }
      .btn-ghost {
        background: transparent;
        color: var(--text-secondary);
        border: 1px solid var(--border);
      }
      .btn-ghost:hover:not(:disabled) {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      @keyframes fadeIn {
        from {
          opacity: 0;
        }
        to {
          opacity: 1;
        }
      }
      @keyframes panelIn {
        from {
          opacity: 0;
          transform: translateY(-8px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
    `,
  ],
})
export class KillSwitchesPageComponent implements OnInit {
  protected readonly service = inject(KillSwitchService);
  private readonly strategiesService = inject(StrategiesService);
  private readonly auditService = inject(AuditTrailService);
  private readonly notifications = inject(NotificationService);
  private readonly fb = inject(FormBuilder);

  readonly rows = signal<StrategySwitch[]>([]);
  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly busyGlobal = signal(false);
  readonly busyStrategyIds = signal(new Set<number>());

  // ── Filter state (search + status chips) ────────────────────────────
  readonly searchTerm = signal('');
  readonly statusFilter = signal<'all' | 'engaged' | 'off'>('all');
  protected readonly statusFilters: ReadonlyArray<{
    label: string;
    value: 'all' | 'engaged' | 'off';
  }> = [
    { label: 'All', value: 'all' },
    { label: 'Engaged', value: 'engaged' },
    { label: 'Off', value: 'off' },
  ];

  // ── Sort state ──────────────────────────────────────────────────────
  // Default is by strategy id: with 200 near-identical generated names, sorting by name looked
  // like no order at all.
  protected readonly columns: ReadonlyArray<{ key: SortKey; label: string }> = [
    { key: 'id', label: 'Strategy' },
    { key: 'status', label: 'Status' },
    { key: 'symbol', label: 'Symbol' },
    { key: 'timeframe', label: 'Timeframe' },
    { key: 'switch', label: 'Kill switch' },
    { key: 'changed', label: 'Last change' },
  ];
  readonly sortKey = signal<SortKey>('id');
  readonly sortDir = signal<'asc' | 'desc'>('asc');
  readonly sortLabel = computed(
    () => this.columns.find((c) => c.key === this.sortKey())?.label.toLowerCase() ?? 'strategy',
  );

  toggleSort(key: SortKey): void {
    if (this.sortKey() === key) {
      this.sortDir.update((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      this.sortKey.set(key);
      this.sortDir.set('asc');
    }
  }

  /**
   * Engaged kill switches stay pinned to the top regardless of the chosen sort — they are what
   * is actually blocking trading, and an operator must not have to page to find them. Within
   * each group the chosen column applies.
   */
  readonly filteredRows = computed<StrategySwitch[]>(() => {
    const term = this.searchTerm().trim().toLowerCase();
    const status = this.statusFilter();
    const xs = this.rows().filter((r) => {
      if (status === 'engaged' && !r.status?.enabled) return false;
      if (status === 'off' && r.status?.enabled) return false;
      if (!term) return true;
      const idStr = String(r.strategy.id);
      const name = (r.strategy.name ?? '').toLowerCase();
      const symbol = (r.strategy.symbol ?? '').toLowerCase();
      return idStr === term || idStr.includes(term) || name.includes(term) || symbol.includes(term);
    });
    const key = this.sortKey();
    const dir = this.sortDir() === 'asc' ? 1 : -1;
    const value = (r: StrategySwitch): string | number => {
      switch (key) {
        case 'id':
          return r.strategy.id;
        case 'status':
          return r.strategy.status ?? '';
        case 'symbol':
          return r.strategy.symbol ?? '';
        case 'timeframe':
          return r.strategy.timeframe ?? '';
        case 'switch':
          return r.status?.enabled ? 1 : 0;
        case 'changed':
          return r.status?.changedAt ? Date.parse(r.status.changedAt) : 0;
      }
    };
    return [...xs].sort((a, b) => {
      const ae = a.status?.enabled ? 1 : 0;
      const be = b.status?.enabled ? 1 : 0;
      if (ae !== be) return be - ae;
      const av = value(a);
      const bv = value(b);
      const cmp =
        typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv));
      return cmp !== 0 ? cmp * dir : a.strategy.id - b.strategy.id;
    });
  });

  // ── Pagination ──────────────────────────────────────────────────────
  readonly page = signal(0);
  readonly pageCount = computed(() =>
    Math.max(1, Math.ceil(this.filteredRows().length / PAGE_SIZE)),
  );
  /** Clamped so a narrower filter never strands the operator on an empty page. */
  private readonly safePage = computed(() => Math.min(this.page(), this.pageCount() - 1));
  readonly pageStart = computed(() => this.safePage() * PAGE_SIZE);
  readonly pageEnd = computed(() =>
    Math.min(this.pageStart() + PAGE_SIZE, this.filteredRows().length),
  );
  readonly pagedRows = computed(() => this.filteredRows().slice(this.pageStart(), this.pageEnd()));

  /** Filter-specific empty copy: "nothing engaged" is good news and should read like it. */
  readonly emptyFilterMessage = computed(() => {
    const term = this.searchTerm().trim();
    if (this.statusFilter() === 'engaged' && !term) {
      const n = this.rows().length;
      return `No kill switches engaged — all ${n} ${n === 1 ? 'strategy is' : 'strategies are'} running normally.`;
    }
    return 'No strategies match the current filter.';
  });

  readonly engagedCount = computed(() => this.rows().filter((r) => r.status?.enabled).length);

  statusCount(value: 'all' | 'engaged' | 'off'): number {
    const xs = this.rows();
    if (value === 'all') return xs.length;
    if (value === 'engaged') return xs.filter((r) => r.status?.enabled).length;
    return xs.filter((r) => !r.status?.enabled).length;
  }

  readonly dialogOpen = signal(false);
  readonly dialogBusy = signal(false);
  private readonly pending = signal<{
    scope: 'global' | 'strategy';
    strategyId?: number;
    nextEnabled: boolean;
    strategyName?: string;
  } | null>(null);

  readonly dialogTitle = computed(() => {
    const p = this.pending();
    if (!p) return '';
    if (p.scope === 'global')
      return p.nextEnabled ? 'Engage Global Kill Switch?' : 'Disengage Global Kill Switch?';
    return p.nextEnabled
      ? `Engage kill switch for ${p.strategyName}?`
      : `Disengage kill switch for ${p.strategyName}?`;
  });

  readonly dialogMessage = computed(() => {
    const p = this.pending();
    if (!p) return '';
    return p.nextEnabled
      ? 'This stops new signals and orders while in effect. Open positions are untouched.'
      : 'Signal generation and order submission will resume.';
  });

  readonly dialogConfirmLabel = computed(() =>
    this.pending()?.nextEnabled ? 'Engage' : 'Disengage',
  );
  readonly dialogVariant = computed<'primary' | 'destructive'>(() =>
    this.pending()?.nextEnabled ? 'destructive' : 'primary',
  );

  readonly reasonForm = this.fb.nonNullable.group({
    reason: ['', [Validators.required, Validators.minLength(3)]],
  });

  /** Stable ID for the modal title — referenced by aria-labelledby. */
  readonly dialogTitleId = 'kill-switch-dialog-title';
  @ViewChild('reasonInput') private reasonInput?: ElementRef<HTMLTextAreaElement>;

  /**
   * Modal-level keyboard shortcuts.
   *
   *   Esc          → cancel (works from anywhere inside the modal,
   *                  including the textarea).
   *   ⌘/Ctrl+Enter → submit (lets operators confirm without leaving
   *                  the textarea; raw Enter inserts a newline, which
   *                  is the conventional textarea behaviour).
   */
  onModalKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      this.cancelDialog();
      return;
    }
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      this.submitToggle();
    }
  }

  ngOnInit(): void {
    this.loadAll();
  }

  reload(): void {
    this.loadAll();
  }

  requestGlobalToggle(): void {
    this.pending.set({ scope: 'global', nextEnabled: !this.service.isGlobalEngaged() });
    this.openReasonDialog();
  }

  requestStrategyToggle(row: StrategySwitch): void {
    const nextEnabled = !row.status?.enabled;
    this.pending.set({
      scope: 'strategy',
      strategyId: row.strategy.id,
      strategyName: row.strategy.name ?? `#${row.strategy.id}`,
      nextEnabled,
    });
    this.openReasonDialog();
  }

  submitToggle(): void {
    const p = this.pending();
    if (!p) return;
    if (this.reasonForm.invalid) {
      this.reasonForm.controls.reason.markAsTouched();
      return;
    }
    const payload: ToggleKillSwitchRequest = {
      enabled: p.nextEnabled,
      reason: this.reasonForm.getRawValue().reason,
    };

    if (p.scope === 'global') {
      this.busyGlobal.set(true);
      this.service.toggleGlobal(payload).subscribe({
        next: (res) => {
          this.busyGlobal.set(false);
          if (res.status) {
            this.notifications.success(
              p.nextEnabled ? 'Global kill switch engaged' : 'Global kill switch disengaged',
            );
            this.logAudit('KillSwitch', 0, payload);
            this.closeDialog();
          } else {
            this.notifications.error(res.message ?? 'Failed to toggle kill switch');
            this.closeDialog();
          }
        },
        error: () => {
          this.busyGlobal.set(false);
          this.closeDialog();
        },
      });
    } else if (p.strategyId != null) {
      const strategyId = p.strategyId;
      const next = new Set(this.busyStrategyIds());
      next.add(strategyId);
      this.busyStrategyIds.set(next);
      this.dialogBusy.set(true);
      this.service.toggleStrategy(strategyId, payload).subscribe({
        next: (res) => {
          this.dialogBusy.set(false);
          const after = new Set(this.busyStrategyIds());
          after.delete(strategyId);
          this.busyStrategyIds.set(after);
          if (res.status) {
            this.notifications.success(
              `${p.strategyName}: kill switch ${p.nextEnabled ? 'engaged' : 'disengaged'}`,
            );
            this.logAudit('StrategyKillSwitch', strategyId, payload);
            this.updateRowStatus(
              strategyId,
              res.data ?? {
                enabled: payload.enabled,
                reason: payload.reason ?? null,
                changedAt: new Date().toISOString(),
                changedBy: null,
              },
            );
            this.closeDialog();
          } else {
            this.notifications.error(res.message ?? 'Failed to toggle kill switch');
            this.closeDialog();
          }
        },
        error: () => {
          this.dialogBusy.set(false);
          const after = new Set(this.busyStrategyIds());
          after.delete(strategyId);
          this.busyStrategyIds.set(after);
          this.closeDialog();
        },
      });
    }
  }

  cancelDialog(): void {
    this.closeDialog();
  }

  private openReasonDialog(): void {
    this.reasonForm.reset({ reason: '' });
    this.dialogOpen.set(true);
    // Wait one tick for the modal to render, then focus the textarea so
    // operators can start typing the reason immediately.
    queueMicrotask(() => this.reasonInput?.nativeElement.focus());
  }

  private closeDialog(): void {
    this.dialogOpen.set(false);
    this.pending.set(null);
    this.dialogBusy.set(false);
  }

  private updateRowStatus(strategyId: number, status: KillSwitchStatusDto): void {
    this.rows.update((arr) =>
      arr.map((row) => (row.strategy.id === strategyId ? { ...row, status } : row)),
    );
  }

  private loadAll(): void {
    this.loading.set(true);
    this.loadError.set(null);
    this.service.getGlobal().subscribe({
      error: () => {
        /* allow UI to load even if global fails */
      },
    });
    this.strategiesService.list({ currentPage: 1, itemCountPerPage: 200 }).subscribe({
      next: (res) => {
        // A rejected envelope must not render as "No strategies found".
        if (res.status === false) {
          this.loadError.set(res.message ?? 'The engine rejected the strategy list request.');
          this.loading.set(false);
          return;
        }
        const strategies = res.data?.data ?? [];
        if (strategies.length === 0) {
          this.rows.set([]);
          this.loading.set(false);
          return;
        }
        forkJoin(
          strategies.map((s) =>
            this.service.getStrategy(s.id).pipe(
              map((r) => r.data ?? null),
              catchError(() => of(null as KillSwitchStatusDto | null)),
            ),
          ),
        ).subscribe((statuses) => {
          this.rows.set(
            strategies.map((strategy, i) => ({ strategy, status: statuses[i] ?? null })),
          );
          this.loading.set(false);
        });
      },
      error: (err: { status?: number; error?: { message?: string } }) => {
        const detail = err?.error?.message ?? (err?.status ? `HTTP ${err.status}` : null);
        this.loadError.set(detail ? `${detail}.` : 'The engine could not be reached.');
        this.loading.set(false);
      },
    });
  }

  private logAudit(entityType: string, entityId: number, payload: ToggleKillSwitchRequest): void {
    this.auditService
      .create({
        entityType,
        entityId,
        decisionType: 'KillSwitchToggle',
        outcome: payload.enabled ? 'Engaged' : 'Disengaged',
        reason: payload.reason ?? '',
        source: 'AdminUI',
      })
      .subscribe({
        error: () => {
          /* non-fatal: audit is best-effort */
        },
      });
  }
}
