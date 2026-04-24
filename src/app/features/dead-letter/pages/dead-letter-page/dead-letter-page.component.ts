import { ChangeDetectionStrategy, Component, ViewChild, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { map, Observable } from 'rxjs';
import type { ColDef } from 'ag-grid-community';

import { DeadLetterService } from '@core/services/dead-letter.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { DeadLetterDto, PagedData, PagerRequest } from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';

@Component({
  selector: 'app-dead-letter-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageHeaderComponent, DataTableComponent, ConfirmDialogComponent, DatePipe],
  template: `
    <div class="page">
      <app-page-header
        title="Dead Letter Queue"
        subtitle="Integration events the engine could not process — inspect, replay, or resolve"
      />

      <app-data-table
        #table
        [columnDefs]="columns"
        [fetchData]="fetchData"
        [searchable]="true"
        (rowClick)="select($event)"
      />

      @if (selected()) {
        <section class="detail">
          <header class="detail-head">
            <div class="title">
              <h3>Dead Letter #{{ selected()!.id }}</h3>
              <span class="pill" [class.resolved]="selected()!.isResolved">
                {{ selected()!.isResolved ? 'Resolved' : 'Unresolved' }}
              </span>
            </div>
            <div class="actions">
              @if (!selected()!.isResolved) {
                <button
                  type="button"
                  class="btn btn-primary"
                  (click)="confirmReplay.set(true)"
                  [disabled]="busy()"
                >
                  Replay
                </button>
                <button
                  type="button"
                  class="btn btn-secondary"
                  (click)="confirmResolve.set(true)"
                  [disabled]="busy()"
                >
                  Mark Resolved
                </button>
              }
              <button
                type="button"
                class="btn btn-secondary"
                (click)="selected.set(null)"
                [disabled]="busy()"
              >
                Close
              </button>
            </div>
          </header>
          <dl class="info">
            <div>
              <dt>Event Type</dt>
              <dd class="mono">{{ selected()!.eventType ?? '—' }}</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{{ selected()!.createdAt | date: 'MMM d, yyyy HH:mm:ss' }}</dd>
            </div>
            <div>
              <dt>Attempts</dt>
              <dd class="mono">{{ selected()!.attemptCount }}</dd>
            </div>
            @if (selected()!.resolvedAt) {
              <div>
                <dt>Resolved</dt>
                <dd>{{ selected()!.resolvedAt | date: 'MMM d, yyyy HH:mm:ss' }}</dd>
              </div>
            }
          </dl>
          @if (selected()!.errorMessage) {
            <div class="block">
              <h4>Error</h4>
              <pre>{{ selected()!.errorMessage }}</pre>
            </div>
          }
          @if (selected()!.payloadJson) {
            <div class="block">
              <h4>Payload</h4>
              <pre>{{ formatJson(selected()!.payloadJson!) }}</pre>
            </div>
          }
        </section>
      }

      <app-confirm-dialog
        [open]="confirmReplay()"
        title="Replay dead-lettered event"
        message="Re-publish this event to the internal bus. If the original failure persists, the event will land here again."
        confirmLabel="Replay"
        confirmVariant="primary"
        [loading]="busy()"
        (confirm)="replay()"
        (cancelled)="confirmReplay.set(false)"
      />
      <app-confirm-dialog
        [open]="confirmResolve()"
        title="Mark as resolved"
        message="This marks the dead letter as handled and removes it from the unresolved queue. It will not be replayed automatically."
        confirmLabel="Mark Resolved"
        confirmVariant="destructive"
        [loading]="busy()"
        (confirm)="resolve()"
        (cancelled)="confirmResolve.set(false)"
      />
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
      .detail {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-5);
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .detail-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: var(--space-4);
        flex-wrap: wrap;
      }
      .title {
        display: flex;
        align-items: center;
        gap: var(--space-3);
      }
      .title h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .pill {
        padding: 2px 10px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .pill.resolved {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .actions {
        display: flex;
        gap: var(--space-2);
      }
      .btn {
        height: 32px;
        padding: 0 var(--space-4);
        border-radius: var(--radius-full);
        border: none;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        cursor: pointer;
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
      .btn-secondary {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .info {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: var(--space-4);
        margin: 0;
      }
      .info dt {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-weight: var(--font-medium);
        margin: 0;
      }
      .info dd {
        margin: 2px 0 0;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        color: var(--text-primary);
      }
      .info dd.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
      }
      .block h4 {
        margin: 0 0 var(--space-2);
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
      }
      .block pre {
        margin: 0;
        padding: var(--space-3);
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
        color: var(--text-primary);
        overflow-x: auto;
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 320px;
      }
    `,
  ],
  providers: [DatePipe],
})
export class DeadLetterPageComponent {
  private readonly service = inject(DeadLetterService);
  private readonly notifications = inject(NotificationService);
  private readonly datePipe = new DatePipe('en-US');

  @ViewChild('table') table?: DataTableComponent<DeadLetterDto>;

  readonly selected = signal<DeadLetterDto | null>(null);
  readonly busy = signal(false);
  readonly confirmReplay = signal(false);
  readonly confirmResolve = signal(false);

  readonly columns: ColDef<DeadLetterDto>[] = [
    { headerName: 'ID', field: 'id', width: 90 },
    { headerName: 'Event Type', field: 'eventType', flex: 1, minWidth: 240 },
    { headerName: 'Attempts', field: 'attemptCount', width: 110 },
    {
      headerName: 'Status',
      field: 'isResolved',
      width: 130,
      cellRenderer: (p: { value: unknown }) => {
        const resolved = Boolean(p.value);
        const bg = resolved ? 'rgba(52,199,89,0.12)' : 'rgba(255,59,48,0.12)';
        const color = resolved ? '#248A3D' : '#D70015';
        const label = resolved ? 'Resolved' : 'Unresolved';
        return `<span style="display:inline-flex;align-items:center;padding:2px 10px;border-radius:9999px;font-size:12px;font-weight:600;background:${bg};color:${color}">${label}</span>`;
      },
    },
    {
      headerName: 'Created',
      field: 'createdAt',
      width: 180,
      valueFormatter: (p) => this.datePipe.transform(p.value as string, 'MMM d, HH:mm:ss') ?? '-',
    },
    {
      headerName: 'Resolved',
      field: 'resolvedAt',
      width: 180,
      valueFormatter: (p) =>
        p.value ? (this.datePipe.transform(p.value as string, 'MMM d, HH:mm:ss') ?? '—') : '—',
    },
    { headerName: 'Error', field: 'errorMessage', flex: 1, minWidth: 280 },
  ];

  readonly fetchData = (params: PagerRequest): Observable<PagedData<DeadLetterDto>> =>
    this.service.list(params).pipe(map((r) => r.data ?? { pager: emptyPager(), data: [] }));

  select(row: DeadLetterDto): void {
    this.selected.set(row);
  }

  replay(): void {
    const dl = this.selected();
    if (!dl) return;
    this.busy.set(true);
    this.service.replay(dl.id).subscribe({
      next: (res) => {
        this.busy.set(false);
        this.confirmReplay.set(false);
        if (res.status) {
          this.notifications.success(`Dead letter #${dl.id} replayed`);
          this.table?.loadData();
        } else {
          this.notifications.error(res.message ?? 'Replay failed');
        }
      },
      error: () => {
        this.busy.set(false);
        this.confirmReplay.set(false);
      },
    });
  }

  resolve(): void {
    const dl = this.selected();
    if (!dl) return;
    this.busy.set(true);
    this.service.resolve(dl.id).subscribe({
      next: (res) => {
        this.busy.set(false);
        this.confirmResolve.set(false);
        if (res.status) {
          this.notifications.success(`Dead letter #${dl.id} resolved`);
          this.selected.set({ ...dl, isResolved: true, resolvedAt: new Date().toISOString() });
          this.table?.loadData();
        } else {
          this.notifications.error(res.message ?? 'Resolve failed');
        }
      },
      error: () => {
        this.busy.set(false);
        this.confirmResolve.set(false);
      },
    });
  }

  formatJson(value: string): string {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
}

function emptyPager() {
  return {
    totalItemCount: 0,
    filter: null,
    currentPage: 1,
    itemCountPerPage: 25,
    pageNo: 1,
    pageSize: 25,
  };
}
