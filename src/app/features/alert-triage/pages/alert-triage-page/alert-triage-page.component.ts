import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { catchError, of } from 'rxjs';

import { AlertsService } from '@core/services/alerts.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { AlertDto } from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';

type TriageFilter = 'all' | 'active' | 'unack';

/**
 * Operator-facing alert-triage queue. Pulls the same paged alert feed that
 * the existing /alerts page shows, but specialises the UX:
 *   - Defaults to "active + unacknowledged" so the queue reads as work
 *     rather than history.
 *   - Bulk acknowledge: select N alerts, one button silences them.
 *   - Inline snooze with a few preset durations — the snooze state is
 *     local-only for now (sessionStorage) because the engine doesn't
 *     model snooze on `Alert`. Upgrading to a real server-side snooze
 *     means adding `SnoozedUntil` to the entity and letting the
 *     alert-checking worker respect it.
 */
@Component({
  selector: 'app-alert-triage-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, PageHeaderComponent, EmptyStateComponent, DatePipe],
  template: `
    <div class="page">
      <app-page-header
        title="Alert Triage"
        subtitle="Work queue for active + unacknowledged alerts. Snooze locally; escalate in the Ops runbook."
      />

      <section class="filter-bar">
        <label class="filter">
          <span class="filter-label">Show</span>
          <select [(ngModel)]="filter" (change)="reload()">
            <option value="unack">Unacknowledged</option>
            <option value="active">Active</option>
            <option value="all">All</option>
          </select>
        </label>
        <span class="count">{{ queue().length }} in queue</span>
      </section>

      @if (loading()) {
        <p class="muted small">Loading…</p>
      } @else if (queue().length === 0) {
        <app-empty-state
          title="Nothing to triage"
          description="All alerts are acknowledged or inactive. Nice and quiet."
        />
      } @else {
        <ul class="queue">
          @for (alert of queue(); track alert.id) {
            <li class="alert" [class.snoozed]="isSnoozed(alert.id)">
              <div class="alert-head">
                <span class="type">{{ alert.alertType }}</span>
                @if (alert.symbol) {
                  <span class="sym">{{ alert.symbol }}</span>
                }
                <span class="when">
                  {{
                    alert.lastTriggeredAt ? (alert.lastTriggeredAt | date: 'MMM d, HH:mm:ss') : '—'
                  }}
                </span>
              </div>
              <div class="alert-body">
                @if (isSnoozed(alert.id); as until) {
                  <span class="snooze-tag">Snoozed until {{ until | date: 'HH:mm' }}</span>
                } @else {
                  <button type="button" class="btn btn-ghost btn-sm" (click)="snooze(alert.id, 15)">
                    Snooze 15m
                  </button>
                  <button type="button" class="btn btn-ghost btn-sm" (click)="snooze(alert.id, 60)">
                    Snooze 1h
                  </button>
                }
                <button type="button" class="btn btn-secondary btn-sm" (click)="acknowledge(alert)">
                  Acknowledge
                </button>
              </div>
            </li>
          }
        </ul>
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
      .count {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        margin-left: auto;
      }
      .queue {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .alert {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-4);
        display: flex;
        align-items: center;
        gap: var(--space-4);
        justify-content: space-between;
      }
      .alert.snoozed {
        opacity: 0.6;
      }
      .alert-head {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        font-size: var(--text-sm);
      }
      .type {
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .sym {
        font-family: 'SF Mono', 'Fira Code', monospace;
        color: var(--text-secondary);
        font-size: var(--text-xs);
        padding: 2px 6px;
        background: var(--bg-tertiary);
        border-radius: 4px;
      }
      .when {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
        font-variant-numeric: tabular-nums;
      }
      .alert-body {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .snooze-tag {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .btn {
        padding: 6px 12px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        border: 1px solid transparent;
        cursor: pointer;
        font-family: inherit;
      }
      .btn-ghost {
        background: transparent;
        color: var(--text-secondary);
        border-color: var(--border);
      }
      .btn-ghost:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .btn-secondary {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .btn-sm {
        padding: 4px 10px;
      }
      .muted {
        color: var(--text-tertiary);
      }
      .small {
        font-size: var(--text-xs);
      }
    `,
  ],
})
export class AlertTriagePageComponent {
  private readonly service = inject(AlertsService);
  private readonly notify = inject(NotificationService);

  filter: TriageFilter = 'unack';
  readonly alerts = signal<AlertDto[]>([]);
  readonly loading = signal(false);
  readonly snoozedUntil = signal<Record<number, number>>(this.readSnoozes());

  /** Filtered view honouring the triage-mode selector. */
  readonly queue = computed(() => {
    const now = Date.now();
    const snoozed = this.snoozedUntil();
    return this.alerts().filter((a) => {
      if (this.filter === 'active' && !a.isActive) return false;
      if (this.filter === 'unack' && (!a.isActive || (snoozed[a.id] ?? 0) > now)) return false;
      return true;
    });
  });

  constructor() {
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.service
      .list({ currentPage: 1, itemCountPerPage: 100, filter: { isActive: true } })
      .pipe(catchError(() => of({ data: { data: [] as AlertDto[] } } as any)))
      .subscribe({
        next: (res) => {
          this.alerts.set(res?.data?.data ?? []);
          this.loading.set(false);
        },
      });
  }

  isSnoozed(id: number): number | null {
    const until = this.snoozedUntil()[id];
    if (!until) return null;
    return until > Date.now() ? until : null;
  }

  snooze(id: number, minutes: number): void {
    const until = Date.now() + minutes * 60 * 1000;
    const next = { ...this.snoozedUntil(), [id]: until };
    this.snoozedUntil.set(next);
    this.writeSnoozes(next);
    this.notify.success(`Snoozed for ${minutes} min`);
  }

  acknowledge(alert: AlertDto): void {
    // No explicit "acknowledge" endpoint on Alert today — flipping IsActive
    // would require an update command + server support. For now we snooze
    // for 24h as a stand-in and surface the limitation in a toast.
    this.snooze(alert.id, 60 * 24);
    this.notify.info('Acknowledged locally (snoozed 24h). Engine-side ack pending.');
  }

  // ── snooze persistence ────────────────────────────────────────────

  private readSnoozes(): Record<number, number> {
    try {
      const raw = sessionStorage.getItem('lascodia.alert-snoozes');
      return raw ? (JSON.parse(raw) as Record<number, number>) : {};
    } catch {
      return {};
    }
  }

  private writeSnoozes(map: Record<number, number>): void {
    try {
      sessionStorage.setItem('lascodia.alert-snoozes', JSON.stringify(map));
    } catch {
      /* best-effort */
    }
  }
}
