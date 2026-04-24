import { Component, ChangeDetectionStrategy, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { ColDef } from 'ag-grid-community';
import { map } from 'rxjs';

import { AuditTrailService } from '@core/services/audit-trail.service';
import type { DecisionLogDto, PagedData, PagerRequest } from '@core/api/api.types';

import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

@Component({
  selector: 'app-audit-trail-page',
  standalone: true,
  imports: [DataTableComponent, PageHeaderComponent, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <app-page-header title="Audit Trail" subtitle="Decision logs and system audit records" />

      <app-data-table
        [columnDefs]="columns"
        [fetchData]="fetchData"
        [searchable]="true"
        (rowClick)="toggleExpand($event)"
      />

      @if (expandedEntry()) {
        <div
          class="detail-overlay"
          role="presentation"
          tabindex="-1"
          (click)="expandedEntry.set(null)"
          (keydown.escape)="expandedEntry.set(null)"
        >
          <div
            class="detail-panel"
            role="dialog"
            aria-modal="true"
            tabindex="-1"
            (click)="$event.stopPropagation()"
            (keydown)="$event.stopPropagation()"
          >
            <div class="detail-header">
              <h3 class="detail-title">Decision Log #{{ expandedEntry()!.id }}</h3>
              <button
                type="button"
                class="close-btn"
                aria-label="Close detail"
                (click)="expandedEntry.set(null)"
              >
                &times;
              </button>
            </div>
            <div class="detail-body">
              <div class="detail-section">
                <h4 class="detail-label">Reason</h4>
                <p class="detail-value">{{ expandedEntry()!.reason }}</p>
              </div>
              <div class="detail-section">
                <h4 class="detail-label">Context JSON</h4>
                <pre class="detail-json">{{ formatJson(expandedEntry()!.contextJson) }}</pre>
              </div>
              <div class="detail-meta">
                <div class="meta-item">
                  <span class="meta-label">Decision Type</span>
                  <span class="meta-value">{{ expandedEntry()!.decisionType }}</span>
                </div>
                <div class="meta-item">
                  <span class="meta-label">Entity</span>
                  <span class="meta-value"
                    >{{ expandedEntry()!.entityType }} #{{ expandedEntry()!.entityId }}</span
                  >
                </div>
                <div class="meta-item">
                  <span class="meta-label">Outcome</span>
                  <span class="meta-value">{{ expandedEntry()!.outcome }}</span>
                </div>
                <div class="meta-item">
                  <span class="meta-label">Source</span>
                  <span class="meta-value">{{ expandedEntry()!.source }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
      }

      .detail-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        backdrop-filter: blur(8px);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
        animation: fadeIn 0.15s ease;
      }

      .detail-panel {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        width: 100%;
        max-width: 640px;
        max-height: 80vh;
        overflow-y: auto;
        animation: scaleIn 0.2s ease-out;
      }

      .detail-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--space-4) var(--space-5);
        border-bottom: 1px solid var(--border);
      }

      .detail-title {
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        margin: 0;
      }

      .close-btn {
        width: 32px;
        height: 32px;
        border: none;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 18px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.15s ease;
      }

      .close-btn:hover {
        background: var(--border);
      }

      .detail-body {
        padding: var(--space-5);
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }

      .detail-section {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }

      .detail-label {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin: 0;
      }

      .detail-value {
        font-size: var(--text-sm);
        color: var(--text-primary);
        margin: 0;
        line-height: 1.5;
      }

      .detail-json {
        font-family: 'SF Mono', 'Menlo', monospace;
        font-size: 12px;
        color: var(--text-primary);
        background: var(--bg-tertiary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: var(--space-3);
        margin: 0;
        overflow-x: auto;
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 300px;
        overflow-y: auto;
      }

      .detail-meta {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-3);
        padding-top: var(--space-3);
        border-top: 1px solid var(--border);
      }

      .meta-item {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .meta-label {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }

      .meta-value {
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
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
      @keyframes scaleIn {
        from {
          transform: scale(0.96);
          opacity: 0;
        }
        to {
          transform: scale(1);
          opacity: 1;
        }
      }
    `,
  ],
})
export class AuditTrailPageComponent {
  private readonly auditTrailService = inject(AuditTrailService);
  private readonly relativeTimePipe = new RelativeTimePipe();

  expandedEntry = signal<DecisionLogDto | null>(null);

  columns: ColDef<DecisionLogDto>[] = [
    {
      headerName: 'Timestamp',
      field: 'createdAt',
      width: 150,
      sortable: true,
      valueFormatter: (params) => this.relativeTimePipe.transform(params.value),
    },
    { headerName: 'Decision Type', field: 'decisionType', flex: 1, minWidth: 140 },
    { headerName: 'Entity Type', field: 'entityType', width: 120 },
    { headerName: 'Entity ID', field: 'entityId', width: 90 },
    {
      headerName: 'Outcome',
      field: 'outcome',
      width: 120,
      cellRenderer: (params: { value: string }) => {
        const outcomeMap: Record<string, { bg: string; color: string }> = {
          Approved: { bg: 'rgba(52,199,89,0.12)', color: '#248A3D' },
          Rejected: { bg: 'rgba(255,59,48,0.12)', color: '#D70015' },
          Executed: { bg: 'rgba(52,199,89,0.12)', color: '#248A3D' },
          Skipped: { bg: 'rgba(142,142,147,0.12)', color: '#636366' },
          Passed: { bg: 'rgba(52,199,89,0.12)', color: '#248A3D' },
          Failed: { bg: 'rgba(255,59,48,0.12)', color: '#D70015' },
        };
        const s = outcomeMap[params.value] ?? { bg: 'rgba(0,113,227,0.12)', color: '#0040DD' };
        return `<span style="background:${s.bg};color:${s.color};padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">${params.value}</span>`;
      },
    },
    { headerName: 'Source', field: 'source', width: 130 },
    {
      headerName: '',
      field: 'id',
      width: 80,
      sortable: false,
      cellRenderer: () => {
        return `<button data-action="expand" style="height:26px;padding:0 10px;border:none;border-radius:999px;font-size:11px;font-weight:600;cursor:pointer;background:rgba(0,113,227,0.1);color:#0040DD">Details</button>`;
      },
      onCellClicked: (params: any) => {
        const action = (params.event?.target as HTMLElement)?.getAttribute('data-action');
        if (action === 'expand') this.toggleExpand(params.data);
      },
    },
  ];

  fetchData = (params: PagerRequest) => {
    return this.auditTrailService.list(params).pipe(
      map((response) => {
        if (response.data) return response.data;
        return {
          data: [],
          pager: {
            totalItemCount: 0,
            filter: null,
            currentPage: 1,
            itemCountPerPage: 25,
            pageNo: 0,
            pageSize: 25,
          },
        } as PagedData<DecisionLogDto>;
      }),
    );
  };

  toggleExpand(entry: DecisionLogDto): void {
    if (this.expandedEntry()?.id === entry.id) {
      this.expandedEntry.set(null);
    } else {
      this.expandedEntry.set(entry);
    }
  }

  formatJson(json: string | null): string {
    if (!json) return 'No context data';
    try {
      return JSON.stringify(JSON.parse(json), null, 2);
    } catch {
      return json;
    }
  }
}
