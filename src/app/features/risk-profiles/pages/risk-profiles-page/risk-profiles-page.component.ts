import { Component, ChangeDetectionStrategy, inject, signal, viewChild } from '@angular/core';
import type { ColDef } from 'ag-grid-community';
import { map } from 'rxjs';

import { RiskProfilesService } from '@core/services/risk-profiles.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { RiskProfileDto, PagedData, PagerRequest } from '@core/api/api.types';

import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { GaugeComponent } from '@shared/components/gauge/gauge.component';
import { TabsComponent, TabItem } from '@shared/components/ui/tabs/tabs.component';

@Component({
  selector: 'app-risk-profiles-page',
  standalone: true,
  imports: [
    DataTableComponent,
    PageHeaderComponent,
    GaugeComponent,
    TabsComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <app-page-header title="Risk Management" subtitle="Risk profiles and real-time monitoring" />

      <ui-tabs [tabs]="tabs" [(activeTab)]="activeTab">
        @if (activeTab() === 'profiles') {
          <app-data-table
            [columnDefs]="columns"
            [fetchData]="fetchData"
          />
        }

        @if (activeTab() === 'monitor') {
          <div class="monitor-section">
            <div class="gauges-grid">
              <div class="gauge-card">
                <app-gauge
                  [value]="positionUtilization()"
                  label="Position Utilization"
                  size="180px"
                />
              </div>
              <div class="gauge-card">
                <app-gauge
                  [value]="dailyDrawdownUtilization()"
                  label="Daily Drawdown"
                  size="180px"
                />
              </div>
              <div class="gauge-card">
                <app-gauge
                  [value]="tradeCountUtilization()"
                  label="Trade Count"
                  size="180px"
                />
              </div>
              <div class="gauge-card">
                <app-gauge
                  [value]="symbolExposure()"
                  label="Symbol Exposure"
                  size="180px"
                />
              </div>
            </div>

            <div class="risk-events-section">
              <h3 class="section-title">Risk Events</h3>
              <div class="risk-events-list">
                @for (event of riskEvents(); track event.id) {
                  <div class="risk-event" [class.risk-event--warning]="event.severity === 'warning'" [class.risk-event--critical]="event.severity === 'critical'">
                    <div class="risk-event__indicator"></div>
                    <div class="risk-event__content">
                      <span class="risk-event__message">{{ event.message }}</span>
                      <span class="risk-event__time">{{ event.time }}</span>
                    </div>
                  </div>
                } @empty {
                  <div class="empty-events">No risk events recorded</div>
                }
              </div>
            </div>
          </div>
        }
      </ui-tabs>
    </div>
  `,
  styles: [`
    .page { padding: var(--space-2) 0; }

    .monitor-section {
      display: flex;
      flex-direction: column;
      gap: var(--space-6);
    }

    .gauges-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: var(--space-4);
    }

    @media (max-width: 900px) {
      .gauges-grid { grid-template-columns: repeat(2, 1fr); }
    }

    .gauge-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: var(--space-4);
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .section-title {
      font-size: var(--text-base);
      font-weight: var(--font-semibold);
      color: var(--text-primary);
      margin: 0 0 var(--space-3);
    }

    .risk-events-section {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: var(--space-4);
    }

    .risk-events-list {
      max-height: 320px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }

    .risk-event {
      display: flex;
      align-items: flex-start;
      gap: var(--space-3);
      padding: var(--space-3);
      border-radius: var(--radius-sm);
      background: var(--bg-primary);
      border: 1px solid var(--border);
    }

    .risk-event__indicator {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-top: 5px;
      flex-shrink: 0;
      background: rgba(52,199,89,1);
    }

    .risk-event--warning .risk-event__indicator { background: rgba(255,149,0,1); }
    .risk-event--critical .risk-event__indicator { background: rgba(255,59,48,1); }

    .risk-event__content {
      display: flex;
      flex-direction: column;
      gap: 2px;
      flex: 1;
    }

    .risk-event__message {
      font-size: var(--text-sm);
      color: var(--text-primary);
    }

    .risk-event__time {
      font-size: var(--text-xs);
      color: var(--text-tertiary);
    }

    .empty-events {
      text-align: center;
      padding: var(--space-8);
      color: var(--text-tertiary);
      font-size: var(--text-sm);
    }
  `],
})
export class RiskProfilesPageComponent {
  private readonly riskProfilesService = inject(RiskProfilesService);
  private readonly notifications = inject(NotificationService);

  tabs: TabItem[] = [
    { label: 'Risk Profiles', value: 'profiles' },
    { label: 'Risk Monitor', value: 'monitor' },
  ];

  activeTab = signal('profiles');

  positionUtilization = signal(42);
  dailyDrawdownUtilization = signal(18);
  tradeCountUtilization = signal(65);
  symbolExposure = signal(31);

  riskEvents = signal([
    { id: 1, message: 'Position utilization exceeded 60% threshold on EUR/USD', severity: 'warning' as const, time: '2 minutes ago' },
    { id: 2, message: 'Daily drawdown approaching limit (1.8% of 2.0% max)', severity: 'critical' as const, time: '15 minutes ago' },
    { id: 3, message: 'New position opened within risk parameters', severity: 'info' as const, time: '32 minutes ago' },
    { id: 4, message: 'Symbol exposure rebalanced after GBP/USD closure', severity: 'info' as const, time: '1 hour ago' },
    { id: 5, message: 'Max daily trades threshold at 80% (8/10)', severity: 'warning' as const, time: '2 hours ago' },
    { id: 6, message: 'Risk profile "Conservative" applied to Strategy #4', severity: 'info' as const, time: '3 hours ago' },
  ]);

  columns: ColDef<RiskProfileDto>[] = [
    { headerName: 'Name', field: 'name', flex: 1, minWidth: 160 },
    {
      headerName: 'Max Lot',
      field: 'maxLotSizePerTrade',
      width: 100,
      valueFormatter: (params) => params.value?.toFixed(2) ?? '-',
    },
    {
      headerName: 'Max Drawdown %',
      field: 'maxTotalDrawdownPct',
      width: 140,
      valueFormatter: (params) => params.value != null ? `${params.value.toFixed(1)}%` : '-',
    },
    {
      headerName: 'Max Positions',
      field: 'maxOpenPositions',
      width: 120,
    },
    {
      headerName: 'Max Daily Trades',
      field: 'maxDailyTrades',
      width: 130,
    },
    {
      headerName: 'Risk Per Trade %',
      field: 'maxRiskPerTradePct',
      width: 130,
      valueFormatter: (params) => params.value != null ? `${params.value.toFixed(1)}%` : '-',
    },
    {
      headerName: 'Default',
      field: 'isDefault',
      width: 90,
      cellRenderer: (params: { value: boolean }) => {
        if (!params.value) return '';
        return `<span style="background:rgba(0,113,227,0.12);color:#0040DD;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">Default</span>`;
      },
    },
  ];

  fetchData = (params: PagerRequest) => {
    return this.riskProfilesService.list(params).pipe(
      map((response) => {
        if (response.data) return response.data;
        return { data: [], pager: { totalItemCount: 0, filter: null, currentPage: 1, itemCountPerPage: 25, pageNo: 0, pageSize: 25 } } as PagedData<RiskProfileDto>;
      }),
    );
  };
}
