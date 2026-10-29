import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, firstValueFrom, of } from 'rxjs';

import { NotificationService } from '@core/notifications/notification.service';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { reportable, when } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { blobErrorText, exportMonths, monthLabel } from '@features/platform/plans.logic';
import { saveBlob } from '@features/scripting/shared/download';
import { MarketDataEntitlementsApiService } from '../md-entitlements-api.service';
import { declarationOrder, subscriberTypeLabel, usageLabel } from '../md-entitlements.logic';
import { usageSummary } from '../md-usage.logic';
import type { MarketDataFeedCatalog, MarketDataUsageReport } from '../md-entitlements.types';

/**
 * The exchange usage report (engine C6, platform staff, `platform.usage.read`): per feed and month, how many distinct
 * people viewed it (display) and which machines and algorithms consumed it (non-display), across how many
 * organisations — what an exchange or vendor monthly declaration is filled from (engine
 * `docs/api/marketdata-entitlements.md`). CSV per organisation, or per user for a subscriber list. Every read and
 * download is recorded in the audit log.
 */
@Component({
  selector: 'app-md-usage-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, PageHeaderComponent],
  styleUrls: ['../../../iam/shared/iam-page.scss', '../../md-summary.scss'],
  template: `
    <div class="page">
      <app-page-header
        title="Market-data usage"
        subtitle="Who read which feed in a month — for exchange and vendor declarations."
      >
        <select
          class="select"
          aria-label="Month"
          [ngModel]="month()"
          (ngModelChange)="pick($event)"
        >
          @for (m of months; track m) {
            <option [value]="m">{{ label(m) }}</option>
          }
        </select>
        <button
          type="button"
          class="btn btn-secondary"
          (click)="report.reload()"
          [disabled]="report.loading()"
        >
          {{ report.loading() ? 'Loading…' : 'Refresh' }}
        </button>
        <button
          type="button"
          class="btn btn-secondary"
          (click)="download('tenants')"
          [disabled]="busy()"
        >
          CSV per organisation
        </button>
        <button
          type="button"
          class="btn btn-secondary"
          (click)="download('users')"
          [disabled]="busy()"
        >
          CSV per user
        </button>
        <button
          type="button"
          class="btn btn-secondary"
          (click)="download('exchanges')"
          [disabled]="busy()"
        >
          CSV per exchange
        </button>
      </app-page-header>

      @if (report.error(); as err) {
        <section class="card">
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        </section>
      } @else if (report.value(); as r) {
        @if (fellBack()) {
          <p class="note">
            {{ label(fellBack()!) }} has no recorded reads, so this shows {{ label(r.month) }} so far. Pick a month
            above to see another.
          </p>
        }
        @if (r.partial) {
          <p class="note warn">
            {{ label(r.month) }} is still running — counts can still grow. File a declaration after
            the month ends.
          </p>
        }
        <div class="tiles" aria-label="Summary">
          <div class="tile">
            <span class="t-label">Reads</span>
            <span class="t-value">{{ sum().reads.toLocaleString('en-US') }}</span>
            <span class="t-hint">{{ sum().displayReads }} on screen (display) · {{ sum().nonDisplayReads }} by machines (non-display)</span>
          </div>
          <div class="tile">
            <span class="t-label">Feeds read</span>
            <span class="t-value">{{ sum().feedsRead }}{{ catalog.value() ? ' / ' + catalog.value()!.feeds.length : '' }}</span>
            <span class="t-hint">of the feeds in the catalog</span>
          </div>
          <div class="tile" [attr.data-tone]="sum().exchangeReads ? 'warn' : null">
            <span class="t-label">Exchange-licensed reads</span>
            <span class="t-value">{{ sum().exchangeReads }}</span>
            <span class="t-hint">{{ sum().exchangeReads ? 'declare these to the exchange' : 'nothing to declare to an exchange' }}</span>
          </div>
          <div class="tile">
            <span class="t-label">Organisations</span>
            <span class="t-value">{{ sum().organisations }}</span>
            <span class="t-hint">that read any feed</span>
          </div>
          <div class="tile">
            <span class="t-label">Most people on one feed</span>
            <span class="t-value">{{ sum().peakUsers }}</span>
            <span class="t-hint">distinct users</span>
          </div>
        </div>
        @if (sum().perFeed.length) {
          <section class="card" aria-label="Reads per feed">
            <header class="card-head"><h3>Reads per feed</h3></header>
            <div class="card-body">
              <ul class="bar-list">
                @for (p of sum().perFeed; track p.feedId) {
                  <li>
                    <code>{{ p.feedId }}</code>
                    <span class="bar" [attr.aria-label]="p.reads + ' reads'"><span [style.width.%]="p.share * 100"></span></span>
                    <span class="small">{{ p.reads.toLocaleString('en-US') }}</span>
                  </li>
                }
              </ul>
            </div>
          </section>
        }
        <section class="card">
          <header class="card-head"><h3>Per feed</h3></header>
          @if (feeds().length === 0) {
            <p class="pad muted">No market-data reads were recorded in {{ label(r.month) }}.</p>
          } @else {
            <div class="table-wrap">
              <table class="grid">
                <thead>
                  <tr>
                    <th>Feed</th>
                    <th>Use</th>
                    <th>Distinct users</th>
                    <th>Organisations</th>
                    <th>Reads</th>
                    <th>Days with reads</th>
                  </tr>
                </thead>
                <tbody>
                  @for (f of feeds(); track f.feedId + f.usage) {
                    <tr>
                      <td>
                        <code>{{ f.feedId }}</code>
                        @if (f.exchangeFeed) {
                          <span class="chip info">Exchange</span>
                        }
                        <span class="sub">{{ f.feedName }}</span>
                      </td>
                      <td class="small">{{ use(f.usage) }}</td>
                      <td class="small">{{ f.distinctUsers }}</td>
                      <td class="small">{{ f.distinctTenants }}</td>
                      <td class="small">{{ f.accessCount }}</td>
                      <td class="small">{{ f.daysWithAccess }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>

        @if ((r.exchanges ?? []).length > 0) {
          <section class="card">
            <header class="card-head"><h3>Per exchange and subscriber type</h3></header>
            <div class="table-wrap">
              <table class="grid">
                <thead>
                  <tr>
                    <th>Exchange</th>
                    <th>Subscriber type</th>
                    <th>Use</th>
                    <th>Data</th>
                    <th>Subscribers</th>
                    <th>Organisations</th>
                    <th>Reads</th>
                  </tr>
                </thead>
                <tbody>
                  @for (
                    x of r.exchanges ?? [];
                    track x.family + x.subscriberType + x.usage + x.realTime
                  ) {
                    <tr>
                      <td>
                        {{ x.familyName }}
                        <span class="sub"
                          ><code>{{ x.feeds.join(' ') }}</code></span
                        >
                      </td>
                      <td class="small">{{ subscriberType(x.subscriberType) }}</td>
                      <td class="small">{{ use(x.usage) }}</td>
                      <td class="small">
                        @if (x.realTime) {
                          Real time
                        } @else {
                          <span class="chip info">Delayed</span>
                        }
                      </td>
                      <td class="small">{{ x.distinctSubscribers }}</td>
                      <td class="small">{{ x.distinctTenants }}</td>
                      <td class="small">{{ x.accessCount }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            <p class="pad muted small">
              People without a subscriber declaration for the exchange are counted as professional,
              as the exchanges do. Delayed reads are listed apart: exchanges count real-time use.
            </p>
          </section>
        }

        @if (r.tenants.length > 0) {
          <section class="card">
            <header class="card-head"><h3>Per organisation</h3></header>
            <div class="table-wrap">
              <table class="grid">
                <thead>
                  <tr>
                    <th>Feed</th>
                    <th>Use</th>
                    <th>Organisation</th>
                    <th>Distinct users</th>
                    <th>Reads</th>
                    <th>First / last day</th>
                  </tr>
                </thead>
                <tbody>
                  @for (t of r.tenants; track t.feedId + t.usage + t.tenantId) {
                    <tr>
                      <td>
                        <code>{{ t.feedId }}</code>
                      </td>
                      <td class="small">{{ use(t.usage) }}</td>
                      <td>
                        {{ t.tenantName || 'Organisation ' + t.tenantId }}
                        <span class="sub"
                          ><code>{{ t.tenantSlug }}</code></span
                        >
                      </td>
                      <td class="small">{{ t.distinctUsers }}</td>
                      <td class="small">{{ t.accessCount }}</td>
                      <td class="small">
                        {{ t.firstDayUtc.slice(0, 10) }} – {{ t.lastDayUtc.slice(0, 10) }}
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        }
        @if (sum().unread.length) {
          <section class="card" aria-label="Feeds with no reads">
            <header class="card-head">
              <h3>Feeds nobody read in {{ label(r.month) }}</h3>
              <span class="chip">{{ sum().unread.length }}</span>
            </header>
            <div class="card-body">
              <div class="chips">
                @for (u of sum().unread; track u.feedId) {
                  <span class="chip" [class.info]="u.exchangeFeed" [title]="u.name">{{ u.feedId }}</span>
                }
              </div>
              <p class="note">
                Nothing to declare for these. Most are exchange feeds whose sources are registered but disabled (see
                Sources); blue = exchange-licensed.
              </p>
            </div>
          </section>
        }
        <nav class="links-row" aria-label="Related">
          <a routerLink="/market-data/entitlements">Entitlements (who may read)</a>
          <a routerLink="/market-data/declarations-review">Subscriber declarations</a>
          <a routerLink="/market-data/sources">Sources</a>
          <a routerLink="/docs/platform-guide">Guide: usage and declarations</a>
        </nav>
        <p class="muted small">
          A read is a chart subscription, a history read or a chart-flow read — not a tick. The
          engine's own use of a licensed feed is House's non-display use by <code>system:…</code>.
          Recorded every minute; generated {{ at(r.generatedAtUtc) }}.
        </p>
      }
    </div>
  `,
})
export class MarketDataUsagePageComponent {
  private readonly api = inject(MarketDataEntitlementsApiService);
  private readonly notify = inject(NotificationService);

  protected readonly months = exportMonths(new Date());
  protected readonly label = monthLabel;
  protected readonly use = usageLabel;
  protected readonly subscriberType = subscriberTypeLabel;
  protected readonly at = when;

  /** Last month by default: the one a declaration is filed for. */
  readonly month = signal(this.months[1] ?? this.months[0]);
  readonly busy = signal(false);
  readonly report = iamResource(
    () => this.api.usage(this.month()),
    null as MarketDataUsageReport | null,
    'Could not load the usage report.',
  );
  readonly feeds = computed(() => declarationOrder(this.report.value()?.feeds ?? []));
  readonly catalog = iamResource<MarketDataFeedCatalog | null>(
    () => this.api.feeds().pipe(catchError(() => of(null))),
    null,
  );
  readonly sum = computed(() => usageSummary(this.report.value(), this.catalog.value()));
  /** The default (last) month that had no reads, when the page moved on to the current month. */
  readonly fellBack = signal<string | null>(null);
  private picked = false;

  constructor() {
    this.report.reload();
    this.catalog.reload();
    // Last month is the declaration month; when it holds nothing, show the running month instead of an empty page.
    effect(() => {
      const r = this.report.value();
      if (this.picked || !r || r.month !== this.month() || r.feeds.length > 0) return;
      if (this.month() === this.months[0]) return;
      untracked(() => {
        this.picked = true;
        this.fellBack.set(r.month);
        this.month.set(this.months[0]);
        this.report.reload();
      });
    });
  }

  pick(month: string): void {
    this.picked = true;
    this.fellBack.set(null);
    this.month.set(month);
    this.report.reload();
  }

  async download(detail: 'tenants' | 'users' | 'exchanges'): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      const file = await firstValueFrom(this.api.exportUsage(this.month(), detail));
      saveBlob(file.blob, file.fileName);
      this.notify.success(`Market-data usage for ${monthLabel(this.month())} downloaded.`);
    } catch (err: unknown) {
      if (reportable(err)) this.notify.error(await blobErrorText(err, 'The usage export failed.'));
    } finally {
      this.busy.set(false);
    }
  }
}
