import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import type { ColDef } from 'ag-grid-community';
import { catchError, map, of } from 'rxjs';

import { MLModelsService } from '@core/services/ml-models.service';
import type {
  AlertSeverity,
  DriftAlertDto,
  DriftReportQueryFilter,
  PagedData,
  PagerRequest,
} from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import {
  TimeRangePickerComponent,
  TimeRange,
} from '@shared/components/time-range-picker/time-range-picker.component';

const SEVERITY_COLOR: Record<AlertSeverity, string> = {
  Info: '#0A84FF',
  Medium: '#FF9500',
  High: '#FF3B30',
  Critical: '#D70015',
};

@Component({
  selector: 'app-drift-report-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    PageHeaderComponent,
    DataTableComponent,
    EmptyStateComponent,
    DatePipe,
    TimeRangePickerComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Drift Report"
        subtitle="ML drift alerts across all detector families"
      />

      <section class="filter-bar">
        <label class="filter">
          <span class="filter-label">Symbol</span>
          <input
            type="text"
            placeholder="e.g. EURUSD"
            [(ngModel)]="filterSymbol"
            (change)="reload()"
          />
        </label>
        <label class="filter">
          <span class="filter-label">Detector</span>
          <select [(ngModel)]="filterDetector" (change)="reload()">
            <option value="">All</option>
            <option value="DriftAgreement">DriftAgreement</option>
            <option value="CUSUM">CUSUM</option>
            <option value="Adwin">Adwin</option>
            <option value="CovariateShift">CovariateShift</option>
            <option value="MultiScale">MultiScale</option>
          </select>
        </label>
        <label class="filter">
          <span class="filter-label">Severity</span>
          <select [(ngModel)]="filterSeverity" (change)="reload()">
            <option value="">All</option>
            <option value="Info">Info</option>
            <option value="Medium">Medium</option>
            <option value="High">High</option>
            <option value="Critical">Critical</option>
          </select>
        </label>
        <label class="filter checkbox">
          <input type="checkbox" [(ngModel)]="unresolvedOnly" (change)="reload()" />
          <span>Unresolved only</span>
        </label>
        <div class="filter">
          <span class="filter-label">Range</span>
          <app-time-range-picker
            [(value)]="range"
            defaultPreset="7d"
            (valueChange)="onRangeChange($event)"
          />
        </div>
      </section>

      <app-data-table
        [columnDefs]="columns"
        [fetchData]="fetchPage"
        (rowClick)="selectRow($event)"
        stateKey="drift-report"
      />

      @if (selected(); as alert) {
        <section class="detail">
          <header class="detail-head">
            <h3>Alert #{{ alert.id }} — {{ alert.symbol || '(no symbol)' }}</h3>
            <span
              class="severity-pill"
              [style.background]="severityBg(alert.severity)"
              [style.color]="severityColor(alert.severity)"
              >{{ alert.severity }}</span
            >
          </header>

          <dl class="detail-grid">
            <div>
              <dt>Detector</dt>
              <dd>{{ alert.detectorType || '—' }}</dd>
            </div>
            <div>
              <dt>Alert type</dt>
              <dd>{{ alert.alertType }}</dd>
            </div>
            <div>
              <dt>Active</dt>
              <dd>{{ alert.isActive ? 'Yes' : 'No' }}</dd>
            </div>
            <div>
              <dt>Auto-resolved</dt>
              <dd>
                {{ alert.autoResolvedAt ? (alert.autoResolvedAt | date: 'MMM d, HH:mm:ss') : '—' }}
              </dd>
            </div>
            <div>
              <dt>Last triggered</dt>
              <dd>
                {{
                  alert.lastTriggeredAt
                    ? (alert.lastTriggeredAt | date: 'MMM d, HH:mm:ss')
                    : 'Never'
                }}
              </dd>
            </div>
            <div>
              <dt>Cooldown</dt>
              <dd>{{ alert.cooldownSeconds }} s</dd>
            </div>
            <div class="full">
              <dt>Dedup key</dt>
              <dd class="mono">{{ alert.deduplicationKey || '—' }}</dd>
            </div>
          </dl>

          <details open>
            <summary>Condition payload</summary>
            <pre class="json">{{ formatJson(alert.conditionJson) }}</pre>
          </details>
        </section>
      } @else {
        <app-empty-state
          title="No alert selected"
          description="Click a row above to inspect the detector payload."
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
        gap: var(--space-5);
      }
      .filter-bar {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-3) var(--space-4);
        padding: var(--space-3) var(--space-4);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }
      .filter {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
        min-width: 160px;
      }
      .filter.checkbox {
        flex-direction: row;
        align-items: center;
        gap: var(--space-2);
      }
      .filter-label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .filter input[type='text'],
      .filter select {
        padding: 6px 10px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
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
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
      }
      .detail-head h3 {
        margin: 0;
        font-size: var(--text-base);
      }
      .severity-pill {
        padding: 4px var(--space-3);
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
      }
      .detail-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: var(--space-3);
        margin: 0;
      }
      .detail-grid > div {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .detail-grid .full {
        grid-column: 1 / -1;
      }
      .detail-grid dt {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .detail-grid dd {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .detail-grid dd.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
        word-break: break-all;
      }
      summary {
        cursor: pointer;
        font-size: var(--text-sm);
        color: var(--text-secondary);
        padding: var(--space-2) 0;
      }
      .json {
        margin: var(--space-2) 0 0;
        padding: var(--space-3);
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
        max-height: 320px;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
      }
    `,
  ],
})
export class DriftReportPageComponent {
  private readonly mlService = inject(MLModelsService);

  filterSymbol = '';
  filterDetector = '';
  filterSeverity = '';
  unresolvedOnly = false;

  // Default 7d is computed lazily by the picker itself when left null, but
  // we seed a signal so the picker can emit into it via [(value)].
  readonly range = signal<TimeRange | null>(null);

  readonly selected = signal<DriftAlertDto | null>(null);
  private reloadTick = signal(0);

  readonly columns: ColDef<DriftAlertDto>[] = [
    { headerName: 'ID', field: 'id', width: 90 },
    { headerName: 'Symbol', field: 'symbol', width: 110 },
    {
      headerName: 'Detector',
      field: 'detectorType',
      width: 160,
      valueFormatter: (p) => (p.value as string | null) ?? '—',
    },
    {
      headerName: 'Severity',
      field: 'severity',
      width: 120,
      cellRenderer: (p: { value: AlertSeverity }) => {
        const color = SEVERITY_COLOR[p.value] ?? 'currentColor';
        return `<span style="color: ${color}; font-weight: 600;">${p.value}</span>`;
      },
    },
    {
      headerName: 'Active',
      field: 'isActive',
      width: 90,
      valueFormatter: (p) => (p.value ? 'Yes' : 'No'),
    },
    {
      headerName: 'Last triggered',
      field: 'lastTriggeredAt',
      width: 200,
      valueFormatter: (p) => (p.value ? new Date(p.value as string).toLocaleString() : '—'),
    },
    {
      headerName: 'Auto-resolved',
      field: 'autoResolvedAt',
      width: 200,
      valueFormatter: (p) => (p.value ? new Date(p.value as string).toLocaleString() : '—'),
    },
  ];

  readonly fetchPage = (params: PagerRequest) => {
    // Touch reloadTick so changing filters re-runs the fetcher.
    this.reloadTick();
    const r = this.range();
    const filter: DriftReportQueryFilter = {
      symbol: this.filterSymbol || undefined,
      detectorType: this.filterDetector || undefined,
      severity: this.filterSeverity || undefined,
      unresolvedOnly: this.unresolvedOnly || undefined,
      fromDate: r?.from ?? undefined,
      toDate: r?.to ?? undefined,
    };
    return this.mlService
      .listDriftReport({
        currentPage: params.currentPage,
        itemCountPerPage: params.itemCountPerPage,
        filter,
      })
      .pipe(
        map((res): PagedData<DriftAlertDto> => res.data ?? this.emptyPage()),
        catchError(() => of(this.emptyPage())),
      );
  };

  reload(): void {
    // Force the table to refetch by bumping the tick and clearing selection.
    this.selected.set(null);
    this.reloadTick.update((n) => n + 1);
  }

  onRangeChange(_range: TimeRange | null): void {
    // Value is already written into `range` via the two-way model binding;
    // just nudge the table to refetch.
    this.reload();
  }

  selectRow(row: DriftAlertDto): void {
    this.selected.set(row);
  }

  severityColor(s: AlertSeverity): string {
    return SEVERITY_COLOR[s] ?? 'inherit';
  }

  severityBg(s: AlertSeverity): string {
    const color = SEVERITY_COLOR[s];
    return color ? `${color}1f` : 'transparent';
  }

  formatJson(raw: string): string {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }

  private emptyPage(): PagedData<DriftAlertDto> {
    return {
      pager: {
        totalItemCount: 0,
        filter: null,
        currentPage: 1,
        itemCountPerPage: 25,
        pageNo: 1,
        pageSize: 25,
      },
      data: [],
    };
  }
}
