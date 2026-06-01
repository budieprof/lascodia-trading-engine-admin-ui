import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { catchError, map, of } from 'rxjs';

import { SignalRejectionsService } from '@core/services/signal-rejections.service';
import type { SignalRejectionEventDto } from '@core/api/api.types';

import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

/**
 * v8.47.172/.173 — per-signal "Account attempts" panel.  Answers the
 * inverse question to the per-instance Rejection log:
 *
 *   per-instance:  "what's EA-X been rejecting today?"
 *   per-signal:    "which accounts tried signal Y, and what happened?"
 *
 * One row per (account, instance) that touched the signal — stage badge
 * (Local / Engine / Broker) coloured by category, plus the granular
 * sub-stage and reason.  Multiple rows per same-(account, instance)
 * are possible when a transient gate (e.g. SpreadFilter) fires
 * repeatedly; we surface every emission so operators can spot
 * intermittent vs persistent.
 *
 * Single fetch on construction (no polling) — events are append-only
 * and the signal-detail view is short-lived; an operator reload covers
 * the refresh case.
 */
@Component({
  selector: 'app-account-attempts',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    CardSkeletonComponent,
    ErrorStateComponent,
    EmptyStateComponent,
    RelativeTimePipe,
  ],
  template: `
    <section class="panel" aria-label="Per-signal account-attempts log">
      <header class="panel-head">
        <h3>Account attempts</h3>
        <span class="count" *ngIf="rows().length as n">{{ n }} event{{ n === 1 ? '' : 's' }}</span>
      </header>

      @if (loading()) {
        <app-card-skeleton [lines]="4" />
      } @else if (error()) {
        <app-error-state
          title="Could not load account attempts"
          message="Engine returned an error fetching rejection events for this signal."
          (retry)="reload()"
        />
      } @else if (rows().length === 0) {
        <app-empty-state
          title="No rejection events for this signal"
          message="No EA rejected this signal locally, and the engine + brokers accepted every attempt. Check the Orders panel for the resulting fills."
        />
      } @else {
        <ul class="attempt-list" role="list">
          @for (row of rows(); track row.id) {
            <li class="attempt-row" (click)="toggle(row.id)" role="button">
              <div class="head">
                <span class="acct">acct&nbsp;{{ row.tradingAccountId }}</span>
                <span class="instance" [title]="row.eaInstanceId">
                  {{ shortInstance(row.eaInstanceId) }}
                </span>
                <span class="stage" [attr.data-stage]="row.stage">{{ row.stage }}</span>
                <span class="substage">{{ row.subStage }}</span>
                <span class="time" [title]="row.createdAt | date: 'medium'">
                  {{ row.createdAt | relativeTime }}
                </span>
              </div>
              <div class="reason">{{ row.reason }}</div>
              @if (expanded() === row.id && row.metadataJson) {
                <pre class="metadata">{{ formatMetadata(row.metadataJson) }}</pre>
              }
            </li>
          }
        </ul>
      }
    </section>
  `,
  styles: [
    `
      .panel {
        background: var(--surface-base);
        border-radius: 8px;
        padding: 16px;
      }
      .panel-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        margin-bottom: 12px;
      }
      .panel-head h3 {
        margin: 0;
      }
      .count {
        font-size: 12px;
        color: var(--text-muted);
      }
      .attempt-list {
        list-style: none;
        padding: 0;
        margin: 0;
      }
      .attempt-row {
        border-bottom: 1px solid var(--border-subtle);
        padding: 10px 0;
        cursor: pointer;
      }
      .attempt-row:hover {
        background: var(--surface-hover);
      }
      .attempt-row:last-child {
        border-bottom: 0;
      }
      .head {
        display: grid;
        grid-template-columns: 70px 1fr 80px 160px 80px;
        gap: 8px;
        align-items: center;
        font-size: 13px;
        margin-bottom: 4px;
      }
      .acct {
        font-family: var(--font-mono);
        font-weight: 600;
      }
      .instance {
        font-family: var(--font-mono);
        font-size: 11px;
        color: var(--text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .stage {
        font-size: 11px;
        padding: 2px 6px;
        border-radius: 4px;
        text-transform: uppercase;
        font-weight: 600;
        text-align: center;
      }
      .stage[data-stage='Local'] {
        background: var(--badge-amber-bg);
        color: var(--badge-amber-fg);
      }
      .stage[data-stage='Engine'] {
        background: var(--badge-blue-bg);
        color: var(--badge-blue-fg);
      }
      .stage[data-stage='Broker'] {
        background: var(--badge-red-bg);
        color: var(--badge-red-fg);
      }
      .substage {
        font-family: var(--font-mono);
        font-size: 12px;
        color: var(--text-secondary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .time {
        font-size: 12px;
        color: var(--text-muted);
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .reason {
        font-size: 13px;
        color: var(--text-base);
        padding-left: 8px;
      }
      .metadata {
        background: var(--surface-sunken);
        padding: 8px;
        border-radius: 4px;
        font-size: 11px;
        margin: 6px 0 0 0;
        overflow-x: auto;
      }
    `,
  ],
})
export class AccountAttemptsComponent {
  readonly signalId = input<number | null>(null);

  private readonly rejectionsService = inject(SignalRejectionsService);

  readonly rows = signal<SignalRejectionEventDto[]>([]);
  readonly loading = signal<boolean>(false);
  readonly error = signal<unknown | null>(null);
  readonly expanded = signal<number | null>(null);

  constructor() {
    // Fetch on signalId change.  Using effect() rather than the polling
    // resource because per-signal views are short-lived — operator opens
    // the page, scans the attempts, moves on; a manual reload covers
    // the refresh case.
    effect(() => {
      const id = this.signalId();
      if (!id || id <= 0) {
        this.rows.set([]);
        return;
      }
      this.fetchFor(id);
    });
  }

  reload(): void {
    const id = this.signalId();
    if (id && id > 0) this.fetchFor(id);
  }

  toggle(id: number): void {
    this.expanded.set(this.expanded() === id ? null : id);
  }

  shortInstance(s: string): string {
    // LASC-MULTI-11-4680-134247161590944680-A107699364  →  MULTI-11 / 4680 / A1076…
    const parts = s.split('-');
    if (parts.length < 6) return s;
    return `${parts[1]}-${parts[2]} / ${parts[3]} / ${parts[5].slice(0, 5)}…`;
  }

  formatMetadata(json: string | null): string {
    if (!json) return '';
    try {
      return JSON.stringify(JSON.parse(json), null, 2);
    } catch {
      return json;
    }
  }

  private fetchFor(id: number): void {
    this.loading.set(true);
    this.error.set(null);
    this.rejectionsService
      .forSignal(id, 200)
      .pipe(
        map((res) => res.data?.data ?? []),
        catchError((err) => {
          this.error.set(err);
          return of<SignalRejectionEventDto[]>([]);
        }),
      )
      .subscribe((rows) => {
        this.rows.set(rows);
        this.loading.set(false);
      });
  }
}
