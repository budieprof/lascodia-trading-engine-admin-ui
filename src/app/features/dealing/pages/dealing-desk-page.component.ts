import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { appStorage } from '@core/storage/app-storage';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { DealingAbReportTabComponent } from '../components/ab-report-tab.component';
import { DealingAlertsTabComponent } from '../components/alerts-tab.component';
import { DealingClientsTabComponent } from '../components/clients-tab.component';
import { DealingFeedsTabComponent } from '../components/feeds-tab.component';
import { DealingLiquidityTabComponent } from '../components/liquidity-tab.component';
import { DealingMarkoutsTabComponent } from '../components/markouts-tab.component';
import { DealingFiltersStore } from '../dealing-filters.store';
import type { WindowPreset } from '../dealing.logic';

export type DealingTab = 'clients' | 'markouts' | 'ab' | 'alerts' | 'liquidity' | 'feeds';

const TAB_KEY = 'lascodia.dealing.tab';

/**
 * The broker dealing desk (enterprise program wave 2, broker module — a plan feature): client-flow analytics on the
 * organisation's own fills and on external client-trade feeds, markouts, toxicity, latency-arbitrage and scalping
 * profiles, ADVISORY A/B-book suggestions, LP analytics, alerts and the trade-feed registrations. Without the module in
 * the plan every read answers `-403-quota` (feature `brokerModule`) and this page shows an upgrade notice.
 */
@Component({
  selector: 'app-dealing-desk-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    PageHeaderComponent,
    DealingClientsTabComponent,
    DealingMarkoutsTabComponent,
    DealingAbReportTabComponent,
    DealingAlertsTabComponent,
    DealingLiquidityTabComponent,
    DealingFeedsTabComponent,
  ],
  styleUrl: '../../iam/shared/iam-page.scss',
  styles: [
    `
      /* Shared .filter-bar surface (styles.scss) laid out as a compact responsive grid: one row on a wide
         screen, wrapping to as many columns as fit (two on a phone). */
      .filter-bar {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
        gap: var(--space-2) var(--space-3);
        align-items: end;
        padding: var(--space-3) var(--space-4);
      }
      .filter-bar .field {
        min-width: 0;
      }
      @media (max-width: 480px) {
        .filter-bar {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      .tabs {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        border-bottom: 1px solid var(--border);
      }
      .tabs button {
        background: none;
        border: 0;
        padding: var(--space-2) var(--space-3);
        color: var(--text-secondary);
        cursor: pointer;
        border-bottom: 2px solid transparent;
      }
      .tabs button[aria-selected='true'] {
        color: var(--text-primary);
        border-bottom-color: var(--accent);
      }
    `,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Dealing desk"
        subtitle="Client flow, markouts, toxicity and liquidity — analytics only; nothing here trades or routes."
      >
        <button type="button" class="btn btn-secondary" (click)="store.refresh()">Refresh</button>
      </app-page-header>

      @if (store.moduleMissing()) {
        <section class="card" role="status">
          <div class="card-body">
            <h3>The dealing desk is not in your organisation's plan</h3>
            <p class="muted">
              The broker module adds client-flow analytics on your own accounts and on your MT5
              trade server's client trades: markouts, toxicity, latency-arbitrage and scalping
              profiles, advisory A/B-book suggestions and liquidity-provider analytics. Ask platform
              staff to move your organisation to a plan that includes it.
            </p>
          </div>
        </section>
      } @else {
        <section class="filter-bar" aria-label="Dealing desk filters">
          <label class="field">
            <span class="label">Window</span>
            <select class="select" [ngModel]="store.preset()" (ngModelChange)="setPreset($event)">
              <option value="24h">Last 24 hours</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="90d">Last 90 days</option>
            </select>
          </label>
          <label class="field" title='Blank = every feed; "own" = your own accounts&apos; fills'>
            <span class="label">Feed</span>
            <input
              class="input"
              placeholder="all · own · feed id"
              [ngModel]="store.feedId()"
              (change)="store.feedId.set(text($event))"
            />
          </label>
          <label class="field">
            <span class="label">Symbol</span>
            <input
              class="input"
              [ngModel]="store.symbol()"
              (change)="store.symbol.set(text($event))"
            />
          </label>
          <label class="field">
            <span class="label">Group</span>
            <input
              class="input"
              [ngModel]="store.group()"
              (change)="store.group.set(text($event))"
            />
          </label>
          <label class="field">
            <span class="label">Min fills</span>
            <input
              class="input"
              type="number"
              min="1"
              [ngModel]="store.minFills()"
              (change)="store.minFills.set(num($event))"
            />
          </label>
          <label class="field">
            <span class="label">A-book threshold</span>
            <input
              class="input"
              type="number"
              min="0"
              max="100"
              [ngModel]="store.aBookThreshold()"
              (change)="store.aBookThreshold.set(num($event))"
            />
          </label>
          <label class="field">
            <span class="label">Short hold (s)</span>
            <input
              class="input"
              type="number"
              min="1"
              [ngModel]="store.shortHoldSeconds()"
              (change)="store.shortHoldSeconds.set(num($event))"
            />
          </label>
        </section>

        <nav class="tabs" role="tablist" aria-label="Dealing desk">
          @for (t of tabs; track t.id) {
            <button
              type="button"
              role="tab"
              [attr.aria-selected]="tab() === t.id"
              (click)="select(t.id)"
            >
              {{ t.label }}
            </button>
          }
        </nav>

        @switch (tab()) {
          @case ('clients') {
            <app-dealing-clients-tab />
          }
          @case ('markouts') {
            <app-dealing-markouts-tab />
          }
          @case ('ab') {
            <app-dealing-ab-report-tab />
          }
          @case ('alerts') {
            <app-dealing-alerts-tab />
          }
          @case ('liquidity') {
            <app-dealing-liquidity-tab />
          }
          @case ('feeds') {
            <app-dealing-feeds-tab />
          }
        }
      }
    </div>
  `,
})
export class DealingDeskPageComponent {
  protected readonly store = inject(DealingFiltersStore);

  readonly tabs: { id: DealingTab; label: string }[] = [
    { id: 'clients', label: 'Clients' },
    { id: 'markouts', label: 'Markouts' },
    { id: 'ab', label: 'A/B suggestions' },
    { id: 'alerts', label: 'Alerts' },
    { id: 'liquidity', label: 'Liquidity' },
    { id: 'feeds', label: 'Trade feeds' },
  ];
  readonly tab = signal<DealingTab>(readTab());

  select(t: DealingTab): void {
    this.tab.set(t);
    try {
      appStorage.setItem(TAB_KEY, t);
    } catch {
      /* storage unavailable: the tab is simply not remembered */
    }
  }

  setPreset(p: WindowPreset): void {
    this.store.preset.set(p);
  }

  text(e: Event): string {
    return (e.target as HTMLInputElement).value ?? '';
  }

  num(e: Event): number | null {
    const v = (e.target as HTMLInputElement).value;
    return v === '' || !Number.isFinite(+v) ? null : +v;
  }
}

function readTab(): DealingTab {
  try {
    const t = appStorage.getItem(TAB_KEY);
    return (['clients', 'markouts', 'ab', 'alerts', 'liquidity', 'feeds'] as const).includes(
      t as DealingTab,
    )
      ? (t as DealingTab)
      : 'clients';
  } catch {
    return 'clients';
  }
}
