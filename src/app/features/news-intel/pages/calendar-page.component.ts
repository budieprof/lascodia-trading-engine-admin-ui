import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';

import { NewsIntelService } from '@core/services/news-intel.service';
import { createPolledResource } from '@core/polling/polled-resource';
import { FeatureStateComponent } from '@shared/components/feedback/feature-state.component';
import { errorText } from '@features/iam/iam.logic';
import { NewsIntelNavComponent } from '../components/news-intel-nav.component';
import {
  EXPOSURE_KIND_LABEL,
  calendarDays,
  countByKind,
  eventKindLabel,
  exposureKindOf,
} from '../news-intel.logic';
import { ExposureKindName } from '../news-intel.types';

const KINDS = [
  'Earnings',
  'Inventories',
  'RigCount',
  'OpecMeeting',
  'OptionsExpiry',
  'IndexRebalance',
  'TokenUnlock',
  'CentralBankDecision',
  'Other',
];
const EXPOSURE_KINDS: ExposureKindName[] = [
  'Currency',
  'Commodity',
  'EquityIndex',
  'Equity',
  'Crypto',
  'Factor',
];

/**
 * Scheduled market events — earnings, EIA inventories, rig counts, expiries, OPEC+, token unlocks and
 * promoted central-bank decisions (economic releases stay on the economic calendar). What the
 * multi-asset blackout reads; only High-impact events can block, and only under Enforce.
 */
@Component({
  selector: 'app-news-calendar-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, NewsIntelNavComponent, FeatureStateComponent],
  styleUrls: ['../news-intel-shared.scss'],
  template: `
    <div class="page">
      <header>
        <h1>Scheduled market events</h1>
        <p class="muted small">
          Known-in-advance events per exposure. Times are UTC. "First seen" is when the engine
          learned of the event — backtests only see an event from then on.
        </p>
      </header>
      <app-news-intel-nav
        [showRefresh]="true"
        [refreshing]="events.refreshing()"
        (refresh)="events.refresh()"
      />

      <section class="card">
        <div class="filters">
          <label class="small"
            >Window
            <select class="sel" [value]="days()" (change)="setDays($any($event.target).value)">
              <option value="7">next 7 days</option>
              <option value="14">next 14 days</option>
              <option value="30">next 30 days</option>
              <option value="-7">past 7 days</option>
            </select>
          </label>
          <select
            class="sel"
            aria-label="Event kind"
            (change)="kind.set($any($event.target).value || null)"
          >
            <option value="">All kinds</option>
            @for (k of kinds; track k) {
              <option [value]="k">{{ kindLabel(k) }}</option>
            }
          </select>
          <select
            class="sel"
            aria-label="Exposure kind"
            (change)="exposureKind.set($any($event.target).value || null)"
          >
            <option value="">All exposures</option>
            @for (k of exposureKinds; track k) {
              <option [value]="k">{{ expLabel(k) }}</option>
            }
          </select>
          <input
            class="inp mono"
            placeholder="Key: EQ:AAPL, WTI"
            aria-label="Exposure key"
            [value]="key()"
            (change)="setKey($any($event.target).value)"
          />
          <label class="small"
            ><input type="checkbox" [checked]="highOnly()" (change)="highOnly.set(!highOnly())" />
            High impact only</label
          >
        </div>
        @if (counts().length) {
          <div class="legs">
            @for (c of counts(); track c.kind) {
              <span class="pill">{{ kindLabel(c.kind) }} · {{ c.count }}</span>
            }
          </div>
        }
      </section>

      @if (events.error(); as e) {
        <div class="banner error">{{ err(e) }}</div>
      }
      @if (events.loading()) {
        <p class="muted small">Loading…</p>
      }

      @if (events.value(); as list) {
        @if (!list.length) {
          <app-feature-state
            kind="waiting"
            title="No scheduled events in this window"
            summary="The scheduled-event worker fills this calendar every 6 hours from the computed US calendar (EIA, Baker Hughes, expiries), Nasdaq earnings, the OPEC+ and token-unlock lists and promoted central-bank decisions."
            switchKey="NewsIntel:Calendar:Enabled"
            detail="If it stays empty after a deploy, check that Calendar:Enabled is on and the worker's group runs (MarketData)."
            [links]="[{ label: 'Calendar settings', route: '/news-intel' }]"
          />
        }
        @for (d of grouped(); track d.day) {
          <section class="card">
            <h2>{{ d.day + 'T00:00:00Z' | date: 'EEEE d MMMM' : 'UTC' }}</h2>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Key</th>
                    <th>Kind</th>
                    <th>Event</th>
                    <th>Impact</th>
                    <th>Source</th>
                    <th>First seen</th>
                  </tr>
                </thead>
                <tbody>
                  @for (e of d.events; track e.id) {
                    <tr>
                      <td class="mono">{{ e.scheduledAtUtc | date: 'HH:mm' : 'UTC' }}</td>
                      <td>
                        <span class="key">{{ e.exposureKey }}</span>
                      </td>
                      <td>{{ kindLabel(e.kind) }}</td>
                      <td>
                        {{ e.title }}
                        @if (e.actual) {
                          <span class="muted xsmall"> · actual {{ e.actual }}</span>
                        }
                        @if (e.notes) {
                          <div class="muted xsmall">{{ e.notes }}</div>
                        }
                      </td>
                      <td>
                        <span class="pill" [class.bad]="e.impact === 'High'">{{ e.impact }}</span>
                      </td>
                      <td class="xsmall">{{ e.source }}</td>
                      <td class="xsmall muted">
                        {{ e.firstSeenUtc | date: 'MMM d HH:mm' : 'UTC' }}
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        } @empty {
          @if (list.length) {
            <p class="empty">No event matches the filters.</p>
          }
        }
      }
    </div>
  `,
})
export class NewsCalendarPageComponent {
  private readonly svc = inject(NewsIntelService);

  protected readonly kinds = KINDS;
  protected readonly exposureKinds = EXPOSURE_KINDS;

  readonly days = signal(14);
  readonly key = signal('');
  readonly kind = signal<string | null>(null);
  readonly exposureKind = signal<ExposureKindName | null>(null);
  readonly highOnly = signal(false);

  readonly events = createPolledResource(
    () => {
      const now = new Date();
      const d = this.days();
      const a = new Date(now.getTime() + Math.min(0, d) * 86_400_000);
      const b = new Date(now.getTime() + Math.max(0, d) * 86_400_000);
      a.setUTCHours(0, 0, 0, 0);
      return this.svc.getScheduledEvents({
        from: a.toISOString(),
        to: b.toISOString(),
        key: this.key().trim().toUpperCase() || undefined,
        take: 2000,
      });
    },
    { intervalMs: 300_000 },
  );

  readonly grouped = computed(() =>
    calendarDays(this.events.value() ?? [], {
      kind: this.kind(),
      exposureKind: this.exposureKind(),
      highOnly: this.highOnly(),
    }),
  );
  readonly counts = computed(() => countByKind(this.events.value() ?? []));

  setDays(v: string): void {
    this.days.set(Number(v));
    this.events.refresh();
  }

  setKey(v: string): void {
    const k = v.trim().toUpperCase();
    if (k && !exposureKindOf(k)) return;
    this.key.set(k);
    this.events.refresh();
  }

  kindLabel(k: string): string {
    return eventKindLabel(k);
  }

  expLabel(k: ExposureKindName): string {
    return EXPOSURE_KIND_LABEL[k];
  }

  err(e: unknown): string {
    return errorText(e, 'Could not load scheduled events.');
  }
}
