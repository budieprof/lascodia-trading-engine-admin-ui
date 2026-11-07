import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';

import { NewsIntelService } from '@core/services/news-intel.service';
import { createPolledResource } from '@core/polling/polled-resource';
import { FeatureStateComponent } from '@shared/components/feedback/feature-state.component';
import { errorText } from '@features/iam/iam.logic';
import { NewsIntelNavComponent } from '../components/news-intel-nav.component';
import {
  NiInfoComponent,
  NiKeyComponent,
  NiPanelComponent,
  NiStatComponent,
} from '../components/viz/ni-primitives';
import { HBarItem, NiHBarsComponent, NiTimelineComponent } from '../components/viz/ni-tabs-b';
import { minutesText, shortKey } from '../components/viz/ni-viz';
import {
  EXPOSURE_KIND_LABEL,
  calendarDays,
  countByKind,
  eventKindLabel,
  exposureKindOf,
} from '../news-intel.logic';
import { ExposureKindName, ScheduledMarketEventRow } from '../news-intel.types';

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
const ENERGY = new Set(['Inventories', 'RigCount', 'OpecMeeting']);
const EXPIRY = new Set(['OptionsExpiry', 'IndexRebalance']);

/**
 * Scheduled market events — earnings, EIA inventories, rig counts, expiries, OPEC+, token unlocks and
 * promoted central-bank decisions (economic releases stay on the economic calendar). What the
 * multi-asset blackout reads; only High-impact events can block, and only under Enforce.
 *
 * Dense layout (DESIGN.md): KPI strip · day × exposure-kind timeline + breakdowns · one agenda table
 * grouped by UTC day.
 */
@Component({
  selector: 'app-news-calendar-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    NewsIntelNavComponent,
    FeatureStateComponent,
    NiPanelComponent,
    NiInfoComponent,
    NiStatComponent,
    NiKeyComponent,
    NiHBarsComponent,
    NiTimelineComponent,
  ],
  styleUrls: ['../news-intel-shared.scss'],
  template: `
    <div class="page">
      <header class="page-head">
        <div class="title">
          <h1>Scheduled market events</h1>
          <app-ni-info
            text="Known-in-advance events per exposure, from the computed US calendar (EIA, Baker Hughes, expiries), Nasdaq earnings, the OPEC+ and token-unlock lists and promoted central-bank decisions. Times are UTC. 'First seen' is when the engine learned of an event — backtests only see it from then on. Only High-impact events can block entries, and only when the multi-asset blackout is Enforce."
          />
          <span class="faint xsmall">all times UTC</span>
        </div>
      </header>
      <app-news-intel-nav
        [showRefresh]="true"
        [refreshing]="events.refreshing()"
        (refresh)="events.refresh()"
      />

      @if (events.error(); as e) {
        <div class="banner error">{{ err(e) }}</div>
      }

      <div class="ni-kpis">
        <app-ni-stat label="In window" [value]="kpi().total" [sub]="windowText()" />
        <app-ni-stat
          label="Next 24h"
          [value]="kpi().next24"
          [sub]="kpi().next24High + ' high'"
          [tone]="kpi().next24High ? 'warn' : null"
        />
        <app-ni-stat
          label="High impact"
          [value]="kpi().high"
          sub="can block (Enforce)"
          info="High-impact events on a symbol's calendar keys are what the multi-asset blackout refuses entries around — under Enforce only. Observe records them as would-blocks."
        />
        <app-ni-stat label="Next high" [value]="kpi().nextHighIn" [sub]="kpi().nextHighTitle" />
        <app-ni-stat label="Earnings" [value]="kpi().earnings" sub="stocks · Nasdaq" />
        <app-ni-stat label="Energy" [value]="kpi().energy" sub="EIA · rigs · OPEC+" />
        <app-ni-stat label="Expiries" [value]="kpi().expiry" sub="options · rebalances" />
        <app-ni-stat label="Keys" [value]="kpi().keys" sub="exposures touched" />
      </div>

      <div class="ni-grid-main">
        <app-ni-panel
          title="Timeline"
          info="UTC days across, exposure kinds down. One dot per event in its kind's colour; size = impact (solid = High, small = Medium, hollow = Low). Hover a cell for its events; click a day to filter the agenda."
        >
          <span meta
            >{{ timelineSpan() }} days from
            {{ timelineStart() + 'T00:00:00Z' | date: 'EEE d MMM' : 'UTC' }}</span
          >
          <div actions class="seg" role="group" aria-label="Window">
            @for (o of windows; track o.v) {
              <button type="button" [class.on]="days() === o.v" (click)="setDays(o.v)">
                {{ o.label }}
              </button>
            }
          </div>
          @if (events.loading() && !events.value()) {
            <p class="empty">Loading…</p>
          } @else {
            <app-ni-timeline
              [events]="filtered()"
              [start]="timelineStart()"
              [span]="timelineSpan()"
              [selected]="day()"
              (pickDay)="day.set($event)"
            />
          }
        </app-ni-panel>

        <div class="ni-stack">
          <app-ni-panel
            title="By event kind"
            info="Events in the window per kind. Click a kind to filter the timeline and agenda; click it again to clear."
          >
            @if (kind()) {
              <button actions type="button" class="btn subtle" (click)="kind.set(null)">
                {{ kindLabel(kind()!) }} ✕
              </button>
            }
            <app-ni-hbars
              [items]="kindBars()"
              [clickable]="true"
              (pick)="toggleKind($event)"
              emptyText="No events."
              style="--lab-w: 132px"
            />
          </app-ni-panel>
          <app-ni-panel
            title="Busiest keys"
            info="Exposure keys with the most events in the window. Click a key to load only its events; click again to clear."
          >
            @if (key()) {
              <button actions type="button" class="btn subtle" (click)="setKey('')">
                {{ key() }} ✕
              </button>
            }
            <app-ni-hbars
              [items]="keyBars()"
              [limit]="8"
              [clickable]="true"
              (pick)="setKey($event)"
              emptyText="No events."
              style="--lab-w: 90px"
            />
          </app-ni-panel>
        </div>
      </div>

      @if (events.value(); as list) {
        @if (!list.length) {
          <app-feature-state
            kind="waiting"
            title="No scheduled events in this window"
            summary="The scheduled-event worker fills this calendar every 6 hours from the computed US calendar (EIA, Baker Hughes, expiries), Nasdaq earnings, the OPEC+ and token-unlock lists and promoted central-bank decisions."
            switchKey="NewsIntel:Calendar:Enabled"
            detail="If it stays empty after a deploy, check that Calendar:Enabled is on and the worker's group runs (MarketData)."
            [links]="[{ label: 'Calendar settings', route: '/news-intel/settings' }]"
          />
        } @else {
          <app-ni-panel
            title="Agenda"
            [flush]="true"
            info="Every event matching the filters, grouped by UTC day. 'In' is the time from now; 'First seen' is the point-in-time anchor. An amber edge marks High impact."
          >
            <span meta
              >{{ agendaCount() }} events{{
                day() ? ' · ' + (day() + 'T00:00:00Z' | date: 'EEE d MMM' : 'UTC') : ''
              }}</span
            >
            <div actions class="filters">
              @if (day()) {
                <button type="button" class="btn subtle" (click)="day.set(null)">All days ✕</button>
              }
              <select
                class="sel"
                aria-label="Event kind"
                (change)="kind.set($any($event.target).value || null)"
              >
                <option value="">All kinds</option>
                @for (k of kinds; track k) {
                  <option [value]="k" [selected]="k === kind()">{{ kindLabel(k) }}</option>
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
                class="inp mono key-inp"
                placeholder="Key: EQ:AAPL"
                aria-label="Exposure key"
                [value]="key()"
                (change)="setKey($any($event.target).value)"
              />
              <label class="chk"
                ><input
                  type="checkbox"
                  [checked]="highOnly()"
                  (change)="highOnly.set(!highOnly())"
                />
                High only</label
              >
            </div>
            <div class="table-wrap agenda">
              <table>
                <thead>
                  <tr>
                    <th class="num">Time</th>
                    <th>Key</th>
                    <th>Kind</th>
                    <th>Event</th>
                    <th>Impact</th>
                    <th class="num">In</th>
                    <th>Source</th>
                    <th class="num">First seen</th>
                  </tr>
                </thead>
                <tbody>
                  @for (d of grouped(); track d.day) {
                    <tr class="dayrow" data-testid="cal-day">
                      <td colspan="8">
                        <span class="dn">{{
                          d.day + 'T00:00:00Z' | date: 'EEEE d MMMM' : 'UTC'
                        }}</span>
                        <span class="faint"
                          >{{ d.events.length }} event{{ d.events.length === 1 ? '' : 's' }}</span
                        >
                        @if (highCount(d.events); as h) {
                          <span class="pill warn">{{ h }} high</span>
                        }
                      </td>
                    </tr>
                    @for (e of d.events; track e.id) {
                      <tr [class.hi]="e.impact === 'High'" [class.past]="isPast(e)">
                        <td class="num">{{ e.scheduledAtUtc | date: 'HH:mm' : 'UTC' }}</td>
                        <td><app-ni-key [key]="e.exposureKey" /></td>
                        <td class="faint kd">{{ kindLabel(e.kind) }}</td>
                        <td class="ev">
                          <span class="et" [title]="e.title">{{ e.title }}</span>
                          @if (e.actual) {
                            <span class="faint">
                              · actual <b>{{ e.actual }}</b></span
                            >
                          }
                          @if (e.notes) {
                            <span class="note" [title]="e.notes">{{ e.notes }}</span>
                          }
                        </td>
                        <td>
                          <span
                            class="pill"
                            [class.warn]="e.impact === 'High'"
                            [class.plain]="e.impact !== 'High'"
                            >{{ e.impact }}</span
                          >
                        </td>
                        <td class="num faint">{{ rel(e.scheduledAtUtc) }}</td>
                        <td class="faint src" [title]="e.source">{{ e.source }}</td>
                        <td class="num faint">
                          {{ e.firstSeenUtc | date: 'MMM d HH:mm' : 'UTC' }}
                        </td>
                      </tr>
                    }
                  } @empty {
                    <tr>
                      <td colspan="8" class="empty pad">No event matches the filters.</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </app-ni-panel>
        }
      }
    </div>
  `,
  styles: [
    `
      .agenda {
        max-height: 640px;
      }
      .agenda th:first-child,
      .agenda td:first-child {
        padding-left: 12px;
        width: 48px;
      }
      .agenda th:last-child,
      .agenda td:last-child {
        padding-right: 12px;
      }
      .dayrow td {
        background: var(--ni-sunken);
        font-size: 11px;
        padding-top: 4px;
        padding-bottom: 4px;
      }
      .dayrow td > * {
        margin-right: 8px;
      }
      .dn {
        font-weight: 600;
        color: var(--text-primary);
      }
      tr.hi td:first-child {
        box-shadow: inset 2px 0 0 var(--ni-warn);
      }
      tr.past td {
        opacity: 0.55;
      }
      .kd {
        white-space: nowrap;
        font-size: 11.5px;
      }
      .ev {
        max-width: 440px;
      }
      .et {
        font-weight: 500;
      }
      .note {
        display: block;
        font-size: 10.5px;
        color: var(--text-tertiary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .src {
        max-width: 150px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-size: 11px;
      }
      .key-inp {
        width: 120px;
      }
      .chk {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 11.5px;
        color: var(--text-secondary);
      }
      .empty.pad {
        padding: 12px;
      }
    `,
  ],
})
export class NewsCalendarPageComponent {
  private readonly svc = inject(NewsIntelService);

  protected readonly kinds = KINDS;
  protected readonly exposureKinds = EXPOSURE_KINDS;
  protected readonly windows = [
    { v: -7, label: 'past 7d' },
    { v: 7, label: '7d' },
    { v: 14, label: '14d' },
    { v: 30, label: '30d' },
  ];

  readonly days = signal(14);
  readonly key = signal('');
  readonly kind = signal<string | null>(null);
  readonly exposureKind = signal<ExposureKindName | null>(null);
  readonly highOnly = signal(false);
  /** A UTC day picked on the timeline (YYYY-MM-DD) — narrows the agenda. */
  readonly day = signal<string | null>(null);

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

  /** Kind / exposure-kind / impact filters (the timeline and every breakdown read this). */
  readonly filtered = computed(() =>
    calendarDays(this.events.value() ?? [], {
      kind: this.kind(),
      exposureKind: this.exposureKind(),
      highOnly: this.highOnly(),
    }).flatMap((d) => d.events),
  );

  readonly grouped = computed(() => {
    const days = calendarDays(this.filtered());
    const d = this.day();
    return d ? days.filter((x) => x.day === d) : days;
  });
  readonly agendaCount = computed(() => this.grouped().reduce((s, d) => s + d.events.length, 0));

  readonly timelineStart = computed(() => {
    const d = this.days();
    return new Date(Date.now() + Math.min(0, d) * 86_400_000).toISOString().slice(0, 10);
  });
  readonly timelineSpan = computed(() => Math.abs(this.days()) + 1);

  readonly kindBars = computed<HBarItem[]>(() =>
    countByKind(
      calendarDays(this.events.value() ?? [], {
        exposureKind: this.exposureKind(),
        highOnly: this.highOnly(),
      }).flatMap((d) => d.events),
    ).map((c) => ({
      label: eventKindLabel(c.kind),
      value: c.count,
      color: c.kind === this.kind() ? 'var(--accent)' : 'var(--text-tertiary)',
    })),
  );

  readonly keyBars = computed<HBarItem[]>(() => {
    const m = new Map<string, number>();
    for (const e of this.filtered()) m.set(e.exposureKey, (m.get(e.exposureKey) ?? 0) + 1);
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([k, v]) => ({ label: k, key: k, value: v }));
  });

  readonly kpi = computed(() => {
    const list = this.filtered();
    const now = Date.now();
    const upcoming = list.filter((e) => Date.parse(e.scheduledAtUtc) >= now);
    const in24 = upcoming.filter((e) => Date.parse(e.scheduledAtUtc) <= now + 86_400_000);
    const nextHigh = upcoming.find((e) => isHigh(e));
    const has = this.events.value() !== null;
    const count = (s: Set<string>) => String(list.filter((e) => s.has(e.kind)).length);
    return {
      total: has ? String(list.length) : '—',
      next24: has ? String(in24.length) : '—',
      next24High: in24.filter((e) => isHigh(e)).length,
      high: has ? String(list.filter((e) => isHigh(e)).length) : '—',
      nextHighIn: nextHigh
        ? minutesText((Date.parse(nextHigh.scheduledAtUtc) - now) / 60_000)
        : '—',
      nextHighTitle: nextHigh
        ? `${shortKey(nextHigh.exposureKey)} · ${nextHigh.title}`
        : 'none upcoming',
      earnings: has ? String(list.filter((e) => e.kind === 'Earnings').length) : '—',
      energy: has ? count(ENERGY) : '—',
      expiry: has ? count(EXPIRY) : '—',
      keys: has ? String(new Set(list.map((e) => e.exposureKey)).size) : '—',
    };
  });

  readonly windowText = computed(() => {
    const d = this.days();
    return d < 0 ? `past ${-d} days` : `next ${d} days`;
  });

  setDays(v: number): void {
    this.days.set(Number(v));
    this.day.set(null);
    this.events.refresh();
  }

  setKey(v: string): void {
    const k = v.trim().toUpperCase();
    if (k && !exposureKindOf(k)) return;
    this.key.set(this.key() === k ? '' : k);
    this.events.refresh();
  }

  /** The bar list emits the display label; map it back to the engine kind name. */
  toggleKind(label: string): void {
    const k = KINDS.find((x) => eventKindLabel(x) === label) ?? label;
    this.kind.set(this.kind() === k ? null : k);
  }

  highCount(list: readonly ScheduledMarketEventRow[]): number {
    return list.filter((e) => isHigh(e)).length;
  }

  isPast(e: ScheduledMarketEventRow): boolean {
    return Date.parse(e.scheduledAtUtc) < Date.now();
  }

  rel(iso: string): string {
    const m = (Date.parse(iso) - Date.now()) / 60_000;
    if (!Number.isFinite(m)) return '';
    return m < 0 ? `${minutesText(-m)} ago` : minutesText(m);
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

function isHigh(e: ScheduledMarketEventRow): boolean {
  return (e.impact ?? '').toLowerCase() === 'high';
}
