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
import { ago } from '@features/iam/shared/admin-context.logic';
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
  styleUrls: [
    '../../../iam/shared/iam-page.scss',
    '../../md-summary.scss',
    './md-licensing-pages.scss',
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Market-data usage"
        subtitle="Who read which feed in a month — for exchange and vendor declarations."
      >
        <select
          class="select month-select"
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
        <span class="dl-group" role="group" aria-label="Download CSV">
          <span class="dl-label" aria-hidden="true">⤓</span>
          <button
            type="button"
            class="btn btn-ghost"
            (click)="download('tenants')"
            [disabled]="busy()"
          >
            CSV per organisation
          </button>
          <button
            type="button"
            class="btn btn-ghost"
            (click)="download('users')"
            [disabled]="busy()"
          >
            CSV per user
          </button>
          <button
            type="button"
            class="btn btn-ghost"
            (click)="download('exchanges')"
            [disabled]="busy()"
          >
            CSV per exchange
          </button>
        </span>
      </app-page-header>

      @if (report.error(); as err) {
        <section class="card">
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        </section>
      } @else if (report.value(); as r) {
        @if (fellBack()) {
          <p class="note">
            {{ label(fellBack()!) }} has no recorded reads, so this shows {{ label(r.month) }} so
            far. Pick a month above to see another.
          </p>
        }
        @if (r.partial) {
          <p class="note warn">
            {{ label(r.month) }} is still running — counts can still grow. File a declaration after
            the month ends.
          </p>
        }
        <div class="kpis" aria-label="Summary">
          <div class="kpi info">
            <span class="k-label">Reads</span>
            <span class="k-value">{{ sum().reads.toLocaleString('en-US') }}</span>
            <span class="k-hint"
              >{{ num(sum().displayReads) }} on screen (display) ·
              {{ num(sum().nonDisplayReads) }} by machines (non-display)</span
            >
          </div>
          <div class="kpi">
            <span class="k-label">Feeds read</span>
            <span class="k-value"
              >{{ sum().feedsRead }}
              @if (catalog.value(); as c) {
                <span class="k-of">/ {{ c.feeds.length }}</span>
              }
            </span>
            <span class="k-hint">of the feeds in the catalog</span>
          </div>
          <div
            class="kpi"
            [class.warn]="sum().exchangeReads > 0"
            [class.ok]="sum().exchangeReads === 0"
          >
            <span class="k-label">Exchange-licensed reads</span>
            <span class="k-value">{{ num(sum().exchangeReads) }}</span>
            <span class="k-hint">{{
              sum().exchangeReads
                ? 'declare these to the exchange'
                : 'nothing to declare to an exchange'
            }}</span>
          </div>
          <div class="kpi">
            <span class="k-label">Organisations</span>
            <span class="k-value">{{ sum().organisations }}</span>
            <span class="k-hint">that read any feed</span>
          </div>
          <div class="kpi">
            <span class="k-label">Most people on one feed</span>
            <span class="k-value">{{ sum().peakUsers }}</span>
            <span class="k-hint">distinct users</span>
          </div>
        </div>
        @if (sum().perFeed.length) {
          <section class="card" aria-label="Reads per feed">
            <header class="card-head">
              <h3>Reads per feed</h3>
              <span class="count">{{ sum().perFeed.length }}</span>
              <span class="hint">display and non-display together, most read first</span>
            </header>
            <div class="card-body">
              <ul class="bar-list">
                @for (p of sum().perFeed; track p.feedId) {
                  <li>
                    <span class="who" [title]="p.feedName"
                      ><span class="ident">{{ p.feedId }}</span></span
                    >
                    <span class="bar" [attr.aria-label]="p.reads + ' reads'"
                      ><span [style.width.%]="p.share * 100"></span
                    ></span>
                    <span class="fig">{{ p.reads.toLocaleString('en-US') }}</span>
                    <span class="pct">{{ pctOfReads(p.reads) }}</span>
                  </li>
                }
              </ul>
            </div>
          </section>
        }
        <section class="card">
          <header class="card-head">
            <h3>Per feed</h3>
            <span class="count">{{ feeds().length }}</span>
            <span class="hint">one row per feed and use</span>
          </header>
          @if (feeds().length === 0) {
            <div class="empty">
              <strong>No market-data reads were recorded in {{ label(r.month) }}.</strong>
              <p>
                Each chart subscription, history read or chart-flow read of a feed shows up here by
                feed and use, with how many people and organisations made it.
              </p>
            </div>
          } @else {
            <div class="table-wrap">
              <table class="grid">
                <thead>
                  <tr>
                    <th>Feed</th>
                    <th>Use</th>
                    <th class="num">Distinct users</th>
                    <th class="num">Organisations</th>
                    <th class="num">Reads</th>
                    <th>Days with reads</th>
                  </tr>
                </thead>
                <tbody>
                  @for (f of feeds(); track f.feedId + f.usage) {
                    <tr>
                      <td>
                        <span class="ident">{{ f.feedId }}</span>
                        @if (f.exchangeFeed) {
                          <span class="chip info">Exchange</span>
                        }
                        <span class="feed-name">{{ f.feedName }}</span>
                      </td>
                      <td>
                        <span class="chip" [class.info]="f.usage === 'nonDisplay'">{{
                          use(f.usage)
                        }}</span>
                      </td>
                      <td class="num">{{ num(f.distinctUsers) }}</td>
                      <td class="num">{{ num(f.distinctTenants) }}</td>
                      <td class="num">
                        <strong>{{ num(f.accessCount) }}</strong>
                      </td>
                      <td>
                        <span
                          class="meter"
                          [title]="f.daysWithAccess + ' of ' + daysIn(r.month) + ' days'"
                        >
                          <span class="track"
                            ><i [style.width.%]="dayShare(f.daysWithAccess, r.month)"></i
                          ></span>
                          {{ f.daysWithAccess }}
                        </span>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>

        @if ((r.exchanges ?? []).length > 0) {
          <section class="card">
            <header class="card-head">
              <h3>Per exchange and subscriber type</h3>
              <span class="count">{{ (r.exchanges ?? []).length }}</span>
              <span class="hint">what the exchange declaration is filled from</span>
            </header>
            <div class="table-wrap">
              <table class="grid">
                <thead>
                  <tr>
                    <th>Exchange</th>
                    <th>Subscriber type</th>
                    <th>Use</th>
                    <th>Data</th>
                    <th class="num">Subscribers</th>
                    <th class="num">Organisations</th>
                    <th class="num">Reads</th>
                  </tr>
                </thead>
                <tbody>
                  @for (
                    x of r.exchanges ?? [];
                    track x.family + x.subscriberType + x.usage + x.realTime
                  ) {
                    <tr>
                      <td>
                        <strong>{{ x.familyName }}</strong>
                        <span class="sub"
                          ><code>{{ x.feeds.join(' ') }}</code></span
                        >
                      </td>
                      <td class="small">{{ subscriberType(x.subscriberType) }}</td>
                      <td>
                        <span class="chip" [class.info]="x.usage === 'nonDisplay'">{{
                          use(x.usage)
                        }}</span>
                      </td>
                      <td>
                        @if (x.realTime) {
                          <span class="dot ok">Real time</span>
                        } @else {
                          <span class="chip info">Delayed</span>
                        }
                      </td>
                      <td class="num">{{ num(x.distinctSubscribers) }}</td>
                      <td class="num">{{ num(x.distinctTenants) }}</td>
                      <td class="num">
                        <strong>{{ num(x.accessCount) }}</strong>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            <p class="pad foot">
              People without a subscriber declaration for the exchange are counted as professional,
              as the exchanges do. Delayed reads are listed apart: exchanges count real-time use.
            </p>
          </section>
        }

        @if (r.tenants.length > 0) {
          <section class="card">
            <header class="card-head">
              <h3>Per organisation</h3>
              <span class="count">{{ r.tenants.length }}</span>
              <span class="hint">one row per feed, use and organisation</span>
            </header>
            <div class="table-wrap">
              <table class="grid">
                <thead>
                  <tr>
                    <th>Feed</th>
                    <th>Use</th>
                    <th>Organisation</th>
                    <th class="num">Distinct users</th>
                    <th class="num">Reads</th>
                    <th>First / last day</th>
                  </tr>
                </thead>
                <tbody>
                  @for (t of r.tenants; track t.feedId + t.usage + t.tenantId) {
                    <tr>
                      <td>
                        <span class="ident">{{ t.feedId }}</span>
                      </td>
                      <td>
                        <span class="chip" [class.info]="t.usage === 'nonDisplay'">{{
                          use(t.usage)
                        }}</span>
                      </td>
                      <td>
                        <strong>{{ t.tenantName || 'Organisation ' + t.tenantId }}</strong>
                        <span class="sub"
                          ><code>{{ t.tenantSlug }}</code></span
                        >
                      </td>
                      <td class="num">{{ num(t.distinctUsers) }}</td>
                      <td class="num">
                        <strong>{{ num(t.accessCount) }}</strong>
                      </td>
                      <td class="small nowrap">
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
              <span class="count">{{ sum().unread.length }}</span>
              <span class="hint">nothing to declare</span>
            </header>
            <div class="card-body">
              <div class="chips">
                @for (u of sum().unread; track u.feedId) {
                  <span class="chip" [class.info]="u.exchangeFeed" [title]="u.name">{{
                    u.feedId
                  }}</span>
                }
              </div>
              <p class="note">
                Nothing to declare for these. Most are exchange feeds whose sources are registered
                but disabled (see Sources); blue = exchange-licensed.
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
        <p class="foot">
          A read is a chart subscription, a history read or a chart-flow read — not a tick. The
          engine's own use of a licensed feed is House's non-display use by <code>system:…</code>.
          Recorded every minute; generated
          <span [title]="at(r.generatedAtUtc)">{{ ago(r.generatedAtUtc) }}</span> ({{
            at(r.generatedAtUtc)
          }}).
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
  protected readonly ago = ago;

  /** Whole number with thousands separators. */
  protected num(n: number): string {
    return n.toLocaleString('en-US');
  }

  /** Share of the month's reads, as "42%" ("<1%" for a sliver). */
  protected pctOfReads(reads: number): string {
    const total = this.sum().reads;
    if (total <= 0) return '—';
    const p = (reads / total) * 100;
    return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`;
  }

  /** Days in a "YYYY-MM" month (31 when it cannot be read). */
  protected daysIn(month: string): number {
    const [y, m] = month.split('-').map(Number);
    return y && m ? new Date(Date.UTC(y, m, 0)).getUTCDate() : 31;
  }

  protected dayShare(days: number, month: string): number {
    return Math.min(100, (days / this.daysIn(month)) * 100);
  }

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
