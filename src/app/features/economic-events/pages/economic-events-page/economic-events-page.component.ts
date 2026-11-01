import {
  ChangeDetectionStrategy,
  Component,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { ReactiveFormsModule, FormBuilder, FormsModule, Validators } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { catchError, map, of, switchMap, type Observable } from 'rxjs';
import type { ColDef } from 'ag-grid-community';
import type { EChartsOption } from 'echarts';

import { EconomicEventsService } from '@core/services/economic-events.service';
import { NotificationService } from '@core/notifications/notification.service';
import { createPolledResource } from '@core/polling/polled-resource';
import type {
  CreateEconomicEventRequest,
  EconomicEventDescriptionSource,
  EconomicEventDto,
  EconomicImpact,
  PagedData,
  PagerRequest,
} from '@core/api/api.types';

import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import {
  FormFieldComponent,
  FormFieldControlDirective,
} from '@shared/components/form-field/form-field.component';
import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';

import { formatSurprise, parseSurprise } from './economic-events-format';

/**
 * 'upcoming' is the default view (from now on). It used to be labelled "All time" while silently
 * bounding the list to the future — "Showing 1–25 of 154" under "All time" over 94,321 events.
 * 'all' now really is unbounded (latest first unless a column is sorted).
 */
type DateRange = 'upcoming' | 'all' | 'today' | 'week' | 'next24h' | 'past24h';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Analytics window cap. The calendar holds well over 10k rows; tiles and
 * charts summarise only the latest-scheduled slice, and every label that
 * derives from it says so rather than posing as a total.
 */
const ANALYTICS_WINDOW = 2000;
const DENSITY_DAYS = 14;

/** One date format for the whole page; every timestamp is rendered in UTC. */
const DATE_FMT = 'd MMM yyyy, HH:mm';
const DAY_FMT = 'd MMM yyyy';

const numberFmt = new Intl.NumberFormat('en-US');

/** AG Grid cells are flex boxes, so `type: 'rightAligned'` alone leaves numbers on the left. */
const NUM_CELL = {
  display: 'flex',
  justifyContent: 'flex-end',
  fontVariantNumeric: 'tabular-nums',
};
const fmt = (n: number): string => numberFmt.format(n);

@Component({
  selector: 'app-economic-events-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DataTableComponent,
    PageHeaderComponent,
    MetricCardComponent,
    ChartCardComponent,
    ReactiveFormsModule,
    FormsModule,
    FormFieldComponent,
    FormFieldControlDirective,
    DatePipe,
    ModalA11yDirective,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Economic Events"
        subtitle="Calendar of macro releases the engine filters signals around"
      >
        <button type="button" class="btn btn-primary" (click)="openCreate()">+ Add Event</button>
      </app-page-header>

      @if (mode() === 'create') {
        <form class="panel" [formGroup]="createForm" (ngSubmit)="submitCreate()">
          <div class="panel-head">
            <h3>New Economic Event</h3>
            <button type="button" class="close" (click)="cancel()" aria-label="Close">
              &times;
            </button>
          </div>
          <div class="panel-body">
            <app-form-field
              class="wide"
              label="Title"
              [required]="true"
              [control]="createForm.controls.title"
            >
              <input
                appFormFieldControl
                formControlName="title"
                placeholder="e.g. US Non-Farm Payrolls"
              />
            </app-form-field>
            <app-form-field
              label="Currency"
              [required]="true"
              [control]="createForm.controls.currency"
            >
              <input appFormFieldControl formControlName="currency" placeholder="USD" />
            </app-form-field>
            <app-form-field label="Impact" [required]="true" [control]="createForm.controls.impact">
              <select appFormFieldControl formControlName="impact">
                <option value="Low">Low</option>
                <option value="Medium">Medium</option>
                <option value="High">High</option>
              </select>
            </app-form-field>
            <app-form-field
              label="Scheduled"
              [required]="true"
              [control]="createForm.controls.scheduledAt"
            >
              <input appFormFieldControl formControlName="scheduledAt" type="datetime-local" />
            </app-form-field>
            <app-form-field label="Source" [required]="true" [control]="createForm.controls.source">
              <select appFormFieldControl formControlName="source">
                <option value="Manual">Manual</option>
                <option value="ForexFactory">ForexFactory</option>
                <option value="Investing">Investing</option>
                <option value="Oanda">Oanda</option>
              </select>
            </app-form-field>
            <app-form-field
              label="Forecast"
              hint="Optional"
              [control]="createForm.controls.forecast"
            >
              <input appFormFieldControl formControlName="forecast" placeholder="e.g. 275K" />
            </app-form-field>
            <app-form-field
              label="Previous"
              hint="Optional"
              [control]="createForm.controls.previous"
            >
              <input appFormFieldControl formControlName="previous" placeholder="e.g. 260K" />
            </app-form-field>
            <div class="actions">
              <button
                type="button"
                class="btn btn-secondary"
                (click)="cancel()"
                [disabled]="busy()"
              >
                Cancel
              </button>
              <button
                type="submit"
                class="btn btn-primary"
                [disabled]="busy() || createForm.invalid"
              >
                @if (busy()) {
                  <span class="spin"></span>
                } @else {
                  Create
                }
              </button>
            </div>
          </div>
        </form>
      }

      <!--
        Event detail surface — slide-in side drawer (right edge) with a
        scrim backdrop.  Replaces the previous inline panel that pushed
        the entire page down by ~600px when an event was selected.
        Drawer is fixed-position so the underlying calendar stays in
        place; backdrop click + Escape both close it.
      -->
      @if (mode() === 'actual' && selectedEvent(); as evt) {
        <div class="drawer-backdrop" (click)="cancel()" aria-hidden="true"></div>
        <aside
          class="drawer"
          role="dialog"
          aria-modal="true"
          aria-label="Economic event detail"
          appModalA11y
          (dismiss)="cancel()"
        >
          <header class="drawer-head">
            <div class="drawer-head-meta">
              <div class="drawer-chips">
                <span class="chip chip-currency">{{ evt.currency }}</span>
                <span class="chip chip-impact" [attr.data-impact]="evt.impact"
                  >{{ evt.impact }} impact</span
                >
                <span class="chip chip-source">{{ evt.source }}</span>
              </div>
              <h2 class="drawer-title">{{ evt.title }}</h2>
              <p class="drawer-subtitle">
                <span class="drawer-time">{{
                  evt.scheduledAt | date: 'EEE ' + dateFmt : 'UTC'
                }}</span>
                <span class="drawer-time-suffix">UTC</span>
                <span class="drawer-sep">·</span>
                <span class="drawer-countdown">{{ countdown(evt.scheduledAt) }}</span>
              </p>
            </div>
            <button
              type="button"
              class="drawer-close"
              (click)="cancel()"
              aria-label="Close (Esc)"
              title="Close (Esc)"
            >
              &times;
            </button>
          </header>

          <div class="drawer-body">
            <!-- 1. Explainer — the primary read for this drawer. -->
            <section class="drawer-section explainer-section">
              <header class="section-head">
                <h3>Explainer</h3>
                @if (currentDescription()) {
                  <span class="chip chip-desc" [attr.data-source]="currentDescriptionSource()">
                    {{ descriptionSourceLabel(currentDescriptionSource()) }}
                  </span>
                }
              </header>

              @if (descriptionLoading()) {
                <div class="loading-state">
                  <span class="spin"></span>
                  <span>Resolving explainer…</span>
                </div>
              } @else if (currentDescription(); as desc) {
                <p class="explainer-prose">{{ desc }}</p>
                <footer class="section-footer">
                  @if (currentDescriptionUpdatedAt(); as ts) {
                    <span class="muted small">Updated {{ ts | date: dateFmt : 'UTC' }} UTC</span>
                  }
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    (click)="regenerateExplainer()"
                    [disabled]="descriptionLoading()"
                    title="Force a fresh LLM call, bypassing the cached explainer"
                  >
                    ↻ Regenerate
                  </button>
                </footer>
              } @else {
                <div class="empty-state">
                  <p class="muted small">No explainer cached for this event yet.</p>
                  <button
                    type="button"
                    class="btn btn-primary btn-sm"
                    (click)="generateExplainer()"
                    [disabled]="descriptionLoading()"
                  >
                    Generate explainer
                  </button>
                </div>
              }
            </section>

            <!-- 2. Release values — what every trader wants at a glance. -->
            <section class="drawer-section">
              <h3 class="section-title">Release values</h3>
              <div class="facts-grid">
                <div class="fact">
                  <span class="fact-label">Forecast</span>
                  <span class="fact-value">{{ evt.forecast || '—' }}</span>
                </div>
                <div class="fact">
                  <span class="fact-label">Previous</span>
                  <span class="fact-value">{{ evt.previous || '—' }}</span>
                </div>
                <div class="fact fact-emphasis">
                  <span class="fact-label">Actual</span>
                  <span class="fact-value">{{ evt.actual || '—' }}</span>
                </div>
              </div>
            </section>

            <!-- 3. Schedule + metadata. -->
            <section class="drawer-section">
              <h3 class="section-title">Schedule &amp; metadata</h3>
              <dl class="kv-list">
                <dt>Scheduled (UTC)</dt>
                <dd>{{ evt.scheduledAt | date: dateFmt : 'UTC' }}</dd>
                <dt>Scheduled (Local)</dt>
                <dd>{{ evt.scheduledAt | date: dateFmt }}</dd>
                <dt>External Key</dt>
                <dd class="mono small">{{ evt.externalKey || '—' }}</dd>
              </dl>
            </section>

            <!-- 4. Update Actual — collapsible to keep the drawer scannable. -->
            <section class="drawer-section">
              <details class="actual-details">
                <summary class="actual-summary">
                  <span>Update Actual value</span>
                  <span class="muted small">Manual override</span>
                </summary>
                <form [formGroup]="actualForm" (ngSubmit)="submitActual()" class="actual-form">
                  <app-form-field
                    label="Actual"
                    [required]="true"
                    [control]="actualForm.controls.actual"
                  >
                    <input appFormFieldControl formControlName="actual" placeholder="e.g. 275K" />
                  </app-form-field>
                  <div class="actual-form-actions">
                    <button
                      type="submit"
                      class="btn btn-primary btn-sm"
                      [disabled]="busy() || actualForm.invalid"
                    >
                      @if (busy()) {
                        <span class="spin"></span>
                      } @else {
                        Save actual
                      }
                    </button>
                  </div>
                </form>
              </details>
            </section>
          </div>
        </aside>
      }

      <!--
        Feed status — where the calendar actually ends. A row of zeros in the
        tiles cannot tell a quiet week from a dead feed; this line can.
      -->
      @if (calendarEnd(); as end) {
        @if (hasUpcoming()) {
          <p class="feed-status">
            <span class="status-dot">Feed live</span>
            <span>
              Calendar runs to <strong>{{ end | date: dateFmt : 'UTC' }} UTC</strong> ·
              <span class="num">{{ fmt(upcomingCount()) }}</span> upcoming events in the analytics
              window.
            </span>
          </p>
        } @else {
          <p class="feed-status stalled">
            <span class="status-dot warn">Feed may have stalled</span>
            <span>
              Calendar ends <strong>{{ end | date: dateFmt : 'UTC' }} UTC</strong> — no events are
              scheduled after that date. The calendar feed may have stalled.
            </span>
          </p>
        }
      }

      <!-- KPI strip — one row of six; everything except the total is scoped to the analytics window -->
      <div class="kpis">
        <app-metric-card
          label="Total events"
          [value]="totalEver()"
          format="number"
          dotColor="#0071E3"
        />
        <app-metric-card label="Next 24h" [value]="next24hCount()" format="number" />
        <app-metric-card label="This week" [value]="weekCount()" format="number" />
        <app-metric-card label="High impact (window)" [value]="highImpactCount()" format="number" />
        <app-metric-card
          label="Awaiting actual (window)"
          [value]="awaitingActualCount()"
          format="number"
          [dotColor]="awaitingActualCount() > 0 ? '#FF9500' : undefined"
        />
        <app-metric-card
          label="Currencies (window)"
          [value]="distinctCurrencies().length"
          format="number"
        />
      </div>

      <!-- Next high-impact releases — what the operator usually opens this page for, so it
           sits right under the headline numbers. Rows open the event like table rows do. -->
      @if (upcomingHighImpact().length > 0) {
        <section class="upcoming">
          <header class="card-head">
            <h3>Next high-impact releases</h3>
            <span class="muted">
              {{ fmt(upcomingHighImpact().length) }} upcoming · the engine filters signals around
              these
            </span>
          </header>
          <ul class="up-list">
            <li aria-hidden="true">
              <div class="up-row up-head">
                <span>Starts</span>
                <span>Scheduled (UTC)</span>
                <span>Ccy</span>
                <span>Release</span>
                <span class="up-num">Forecast</span>
                <span class="up-num">Previous</span>
              </div>
            </li>
            @for (e of upcomingHighImpact(); track e.id) {
              <li>
                <button
                  type="button"
                  class="up-row"
                  (click)="openActual(e)"
                  [attr.aria-label]="'Open ' + (e.title ?? 'event')"
                >
                  <span class="up-time mono">{{ countdown(e.scheduledAt) }}</span>
                  <span class="up-when">{{ e.scheduledAt | date: 'EEE ' + dateFmt : 'UTC' }}</span>
                  <span class="up-currency mono">{{ e.currency }}</span>
                  <span class="up-title" [title]="e.title ?? ''">{{ e.title }}</span>
                  <span class="up-num mono">{{ e.forecast || '—' }}</span>
                  <span class="up-num mono">{{ e.previous || '—' }}</span>
                </button>
              </li>
            }
          </ul>
        </section>
      }

      <!-- 3-col chart row: impact donut + currency exposure + per-day density -->
      <div class="chart-row">
        <app-chart-card
          title="Impact distribution"
          [subtitle]="windowLabel()"
          [options]="impactDonutOptions()"
          height="220px"
        />
        <app-chart-card
          title="Currency exposure"
          [subtitle]="'Top currencies · ' + windowLabel()"
          [options]="currencyBarOptions()"
          height="220px"
        />
        @if (density(); as d) {
          <app-chart-card
            [title]="
              d.mode === 'upcoming'
                ? 'Calendar density (next 14 days)'
                : 'Calendar density (last 14 days of data)'
            "
            [subtitle]="d.rangeLabel + ' · per day, stacked by impact'"
            [options]="densityOptions()"
            height="220px"
          />
        } @else {
          <div class="chart-empty">
            <strong>Calendar density</strong>
            <span>No events in the analytics window.</span>
          </div>
        }
      </div>

      <!-- Filters sit directly on the table they filter (they used to be separated from it by
           the high-impact panel). -->
      <section class="table-block">
        <!-- Filter dropdowns — one control set; counts are scoped to the analytics window -->
        <div class="filter-bar">
          <span class="filter-label">Calendar</span>
          <select
            class="input"
            aria-label="Filter by currency"
            [ngModel]="currencyFilter()"
            (ngModelChange)="onFilterChange('currency', $event)"
          >
            <option value="">All currencies</option>
            @for (c of currencyOptions(); track c.value) {
              <option [value]="c.value">{{ c.value }} ({{ fmt(c.count) }})</option>
            }
          </select>
          <select
            class="input"
            aria-label="Filter by impact"
            [ngModel]="impactFilter()"
            (ngModelChange)="onFilterChange('impact', $event)"
          >
            <option value="">All impacts</option>
            <option value="High">High ({{ fmt(impactCounts().High) }})</option>
            <option value="Medium">Medium ({{ fmt(impactCounts().Medium) }})</option>
            <option value="Low">Low ({{ fmt(impactCounts().Low) }})</option>
          </select>
          <select
            class="input"
            aria-label="Date range"
            [ngModel]="dateRangeFilter()"
            (ngModelChange)="onFilterChange('dateRange', $event)"
          >
            <option value="upcoming">Upcoming</option>
            <option value="all">All time</option>
            <option value="today">Today</option>
            <option value="next24h">Next 24h</option>
            <option value="past24h">Past 24h</option>
            <option value="week">This week</option>
          </select>
          @if (hasActiveFilters()) {
            <button type="button" class="link-btn" (click)="resetFilters()">Reset filters</button>
          }
        </div>
        <p class="table-note">Times in UTC · {{ sortNote() }}</p>
        <app-data-table
          #table
          [columnDefs]="columns"
          [fetchData]="fetchData"
          [searchable]="true"
          (rowClick)="openActual($event)"
        />
      </section>
    </div>
  `,
  styleUrl: './economic-events-page.component.scss',
})
export class EconomicEventsPageComponent {
  private readonly service = inject(EconomicEventsService);
  private readonly notifications = inject(NotificationService);
  private readonly fb = inject(FormBuilder);
  private readonly datePipe = new DatePipe('en-US');

  @ViewChild('table') table?: DataTableComponent<EconomicEventDto>;

  readonly mode = signal<'idle' | 'create' | 'actual'>('idle');
  readonly busy = signal(false);
  readonly selectedEvent = signal<EconomicEventDto | null>(null);

  //--- Detail-drawer description state.  Mirrors the selected event's
  //--- description fields with optimistic local updates after the
  //--- explainer endpoint returns — avoids a second list-refresh round
  //--- trip just to render the new description.
  readonly currentDescription = signal<string | null>(null);
  readonly currentDescriptionSource = signal<EconomicEventDescriptionSource>('None');
  readonly currentDescriptionUpdatedAt = signal<string | null>(null);
  readonly descriptionLoading = signal(false);

  readonly createForm = this.fb.nonNullable.group({
    title: ['', Validators.required],
    currency: ['USD', Validators.required],
    impact: ['Medium' as EconomicImpact, Validators.required],
    scheduledAt: ['', Validators.required],
    source: ['Manual', Validators.required],
    forecast: [''],
    previous: [''],
  });

  readonly actualForm = this.fb.nonNullable.group({
    actual: ['', Validators.required],
  });

  readonly dateFmt = DATE_FMT;
  readonly fmt = fmt;

  readonly columns: ColDef<EconomicEventDto>[] = [
    // Fixed columns trimmed so the title gets the slack: it was cut at ~190px
    // ("5-Year Climate Transition JGB Aucti…") while Source/Currency kept spare width.
    { headerName: 'Title', field: 'title', flex: 1, minWidth: 260, tooltipField: 'title' },
    { headerName: 'Currency', field: 'currency', width: 112, minWidth: 112 },
    {
      headerName: 'Impact',
      field: 'impact',
      width: 96,
      cellRenderer: (p: { value: unknown }) => {
        const v = String(p.value ?? '');
        const palette: Record<string, { bg: string; color: string }> = {
          High: { bg: 'rgba(255,59,48,0.12)', color: 'var(--tone-red)' },
          Medium: { bg: 'rgba(255,149,0,0.12)', color: 'var(--tone-amber)' },
          Low: { bg: 'rgba(52,199,89,0.12)', color: 'var(--tone-green)' },
        };
        const s = palette[v] ?? palette['Low'];
        return `<span style="background:${s.bg};color:${s.color};padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">${escapeHtml(v)}</span>`;
      },
    },
    {
      headerName: 'Forecast',
      field: 'forecast',
      width: 112,
      type: 'rightAligned',
      cellStyle: NUM_CELL,
      valueFormatter: (p) => blankDash(p.value),
    },
    {
      headerName: 'Previous',
      field: 'previous',
      width: 112,
      type: 'rightAligned',
      cellStyle: NUM_CELL,
      valueFormatter: (p) => blankDash(p.value),
    },
    {
      headerName: 'Actual',
      field: 'actual',
      width: 112,
      type: 'rightAligned',
      valueFormatter: (p) => blankDash(p.value),
      cellStyle: (p) => (p.value ? { ...NUM_CELL, fontWeight: 600 } : NUM_CELL),
    },
    {
      // "Surprise" — actual minus forecast, when both parse as numbers. Deliberately NOT
      // green/red: "above forecast" is good news for payrolls and bad news for unemployment or
      // inflation, so a colour would assert a verdict the page cannot make. Arrow + sign only.
      headerName: 'Surprise',
      colId: 'surprise',
      width: 104,
      sortable: false,
      type: 'rightAligned',
      cellStyle: NUM_CELL,
      headerTooltip: 'Actual minus forecast. Above forecast is not necessarily good news.',
      cellRenderer: (p: { data: EconomicEventDto }) => {
        const delta = parseSurprise(p.data?.actual ?? null, p.data?.forecast ?? null);
        if (delta === null) return '—';
        const text = formatSurprise(delta);
        const arrow = text === '0' ? '' : delta > 0 ? '▲ ' : '▼ ';
        return `<span style="color:var(--text-primary);font-weight:600;font-variant-numeric:tabular-nums"><span style="color:var(--text-tertiary);font-size:9px">${arrow}</span>${escapeHtml(text)}</span>`;
      },
    },
    {
      headerName: 'Scheduled (UTC)',
      field: 'scheduledAt',
      width: 160,
      cellStyle: { fontVariantNumeric: 'tabular-nums' },
      valueFormatter: (p) => this.datePipe.transform(p.value as string, DATE_FMT, 'UTC') ?? '—',
    },
    { headerName: 'Source', field: 'source', width: 110 },
  ];

  // ── Filter state ────────────────────────────────────────────────────────
  readonly currencyFilter = signal('');
  readonly impactFilter = signal('');
  readonly dateRangeFilter = signal<DateRange>('upcoming');

  // ── Analytics resource — probe-and-fetch the latest-scheduled window ────
  // Powers KPIs, charts, and the upcoming-high-impact panel without a count
  // query per metric. The window is explicitly the latest-scheduled slice:
  // the engine's default order is ScheduledAt ascending, so an unsorted
  // fetch would summarise the OLDEST rows and report "nothing upcoming" for
  // a perfectly healthy calendar. Polled every 2 minutes.
  private readonly analyticsResource = createPolledResource(
    () =>
      this.service
        .list({
          currentPage: 1,
          itemCountPerPage: 1,
          filter: null,
          sortBy: 'scheduledAt',
          sortDirection: 'desc',
        })
        .pipe(
          switchMap((probe) => {
            const total = probe.data?.pager?.totalItemCount ?? 0;
            const limit = Math.min(total, ANALYTICS_WINDOW);
            if (limit === 0) return of({ rows: [] as EconomicEventDto[], total });
            return this.service
              .list({
                currentPage: 1,
                itemCountPerPage: limit,
                filter: null,
                sortBy: 'scheduledAt',
                sortDirection: 'desc',
              })
              .pipe(map((r) => ({ rows: r.data?.data ?? [], total })));
          }),
          catchError(() => of({ rows: [] as EconomicEventDto[], total: 0 })),
        ),
    { intervalMs: 120_000 },
  );

  readonly analyticsRows = computed(() => this.analyticsResource.value()?.rows ?? []);
  readonly totalEver = computed(() => this.analyticsResource.value()?.total ?? 0);

  // ── Window / feed-status computeds ──────────────────────────────────────
  /** Latest scheduled timestamp on the calendar (ISO) — null until the window loads. */
  readonly calendarEnd = computed<string | null>(() => {
    let latest: string | null = null;
    let latestMs = -Infinity;
    for (const e of this.analyticsRows()) {
      const t = new Date(e.scheduledAt).getTime();
      if (t > latestMs) {
        latestMs = t;
        latest = e.scheduledAt;
      }
    }
    return latest;
  });

  readonly upcomingCount = computed(() => {
    const now = Date.now();
    return this.analyticsRows().filter((e) => new Date(e.scheduledAt).getTime() >= now).length;
  });

  readonly hasUpcoming = computed(() => this.upcomingCount() > 0);

  /** Honest scope label for every tile/chart that derives from the window. */
  readonly windowLabel = computed(() => {
    const rows = this.analyticsRows();
    const total = this.totalEver();
    if (rows.length === 0) return 'No events loaded';
    let earliest = Infinity;
    let latest = -Infinity;
    for (const e of rows) {
      const t = new Date(e.scheduledAt).getTime();
      if (t < earliest) earliest = t;
      if (t > latest) latest = t;
    }
    const span = `${this.datePipe.transform(earliest, DAY_FMT, 'UTC')} – ${this.datePipe.transform(latest, DAY_FMT, 'UTC')}`;
    const scope =
      rows.length < total
        ? `Latest ${fmt(rows.length)} of ${fmt(total)} events`
        : `All ${fmt(total)} events`;
    return `${scope} (${span})`;
  });

  readonly sortNote = computed(() =>
    this.hasUpcoming()
      ? 'sorted upcoming first — pick All time or a date range, or sort the Scheduled column, to browse past events'
      : 'sorted latest first — nothing upcoming on the calendar',
  );

  // ── KPI computeds ───────────────────────────────────────────────────────
  readonly next24hCount = computed(() => {
    const now = Date.now();
    return this.analyticsRows().filter((e) => {
      const t = new Date(e.scheduledAt).getTime();
      return t >= now && t < now + DAY_MS;
    }).length;
  });

  readonly weekCount = computed(() => {
    const start = startOfUtcDay(Date.now());
    const end = start + 7 * DAY_MS;
    return this.analyticsRows().filter((e) => {
      const t = new Date(e.scheduledAt).getTime();
      return t >= start && t < end;
    }).length;
  });

  readonly highImpactCount = computed(
    () => this.analyticsRows().filter((e) => e.impact === 'High').length,
  );

  readonly awaitingActualCount = computed(() => {
    const now = Date.now();
    return this.analyticsRows().filter((e) => {
      const t = new Date(e.scheduledAt).getTime();
      return t < now && !e.actual;
    }).length;
  });

  readonly distinctCurrencies = computed(() => {
    const set = new Set<string>();
    for (const e of this.analyticsRows()) if (e.currency) set.add(e.currency);
    return Array.from(set).sort();
  });

  readonly impactCounts = computed<Record<EconomicImpact, number>>(() => {
    const counts: Record<EconomicImpact, number> = { High: 0, Medium: 0, Low: 0 };
    for (const e of this.analyticsRows()) counts[e.impact] = (counts[e.impact] ?? 0) + 1;
    return counts;
  });

  readonly currencyOptions = computed(() => {
    const counts = new Map<string, number>();
    for (const e of this.analyticsRows()) {
      if (!e.currency) continue;
      counts.set(e.currency, (counts.get(e.currency) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count);
  });

  // Up to 8 closest upcoming high-impact releases — the engine filters trade
  // signals around these, so they're operationally most important.
  readonly upcomingHighImpact = computed(() => {
    const now = Date.now();
    return this.analyticsRows()
      .filter((e) => e.impact === 'High' && new Date(e.scheduledAt).getTime() >= now)
      .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime())
      .slice(0, 8);
  });

  // ── Charts ──────────────────────────────────────────────────────────────
  readonly impactDonutOptions = computed<EChartsOption>(() => {
    const c = this.impactCounts();
    const data = (
      [
        ['High', c.High, '#FF3B30'],
        ['Medium', c.Medium, '#FF9500'],
        ['Low', c.Low, '#34C759'],
      ] as [string, number, string][]
    )
      .filter(([, v]) => v > 0)
      .map(([name, value, color]) => ({ name, value, itemStyle: { color } }));
    if (data.length === 0) return {};
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { bottom: 0, textStyle: { fontSize: 10, color: '#6E6E73' } },
      series: [
        {
          type: 'pie',
          radius: ['45%', '70%'],
          center: ['50%', '45%'],
          label: { show: false },
          data,
        },
      ],
    };
  });

  readonly currencyBarOptions = computed<EChartsOption>(() => {
    const rows = this.currencyOptions().slice(0, 10);
    if (rows.length === 0) return {};
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { top: 10, right: 50, bottom: 30, left: 70 },
      xAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73', hideOverlap: true },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: rows.map((r) => r.value).reverse(),
        axisLabel: { fontSize: 10, color: '#6E6E73', hideOverlap: true },
      },
      series: [
        {
          type: 'bar',
          data: rows
            .map((r) => ({
              value: r.count,
              itemStyle: { color: '#0071E3', borderRadius: [0, 4, 4, 0] },
            }))
            .reverse(),
          barWidth: 12,
          label: {
            show: true,
            position: 'right',
            fontSize: 10,
            color: '#6E6E73',
            formatter: (p: any) => fmt(p.value),
          },
        },
      ],
    };
  });

  // Events per UTC day, stacked by impact. Prefers the next 14 days; when the
  // calendar has nothing ahead it shows the last 14 days of data instead, so
  // the card always carries real density rather than an empty box.
  readonly density = computed(() => {
    const rows = this.analyticsRows();
    const end = this.calendarEnd();
    if (rows.length === 0 || !end) return null;

    const bucket = (startDay: number) => {
      const high = new Array<number>(DENSITY_DAYS).fill(0);
      const medium = new Array<number>(DENSITY_DAYS).fill(0);
      const low = new Array<number>(DENSITY_DAYS).fill(0);
      let any = false;
      for (const e of rows) {
        const idx = Math.floor((new Date(e.scheduledAt).getTime() - startDay) / DAY_MS);
        if (idx < 0 || idx >= DENSITY_DAYS) continue;
        any = true;
        if (e.impact === 'High') high[idx]++;
        else if (e.impact === 'Medium') medium[idx]++;
        else low[idx]++;
      }
      return { high, medium, low, any };
    };

    const upcomingStart = startOfUtcDay(Date.now());
    let mode: 'upcoming' | 'trailing' = 'upcoming';
    let start = upcomingStart;
    let counts = bucket(start);
    if (!counts.any) {
      mode = 'trailing';
      start = startOfUtcDay(new Date(end).getTime()) - (DENSITY_DAYS - 1) * DAY_MS;
      counts = bucket(start);
    }
    const labels: string[] = [];
    for (let i = 0; i < DENSITY_DAYS; i++) {
      labels.push(this.datePipe.transform(start + i * DAY_MS, 'd MMM', 'UTC') ?? '');
    }
    const rangeLabel = `${this.datePipe.transform(start, DAY_FMT, 'UTC')} – ${this.datePipe.transform(start + (DENSITY_DAYS - 1) * DAY_MS, DAY_FMT, 'UTC')}`;
    return { mode, labels, rangeLabel, ...counts };
  });

  readonly densityOptions = computed<EChartsOption>(() => {
    const d = this.density();
    if (!d) return {};
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { bottom: 0, textStyle: { fontSize: 10, color: '#6E6E73' } },
      grid: { top: 10, right: 16, bottom: 36, left: 32 },
      xAxis: {
        type: 'category',
        data: d.labels,
        axisLabel: { fontSize: 9, color: '#6E6E73', hideOverlap: true },
      },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73', hideOverlap: true },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          name: 'High',
          type: 'bar',
          stack: 'impact',
          data: d.high,
          itemStyle: { color: '#FF3B30' },
          barWidth: '70%',
        },
        {
          name: 'Medium',
          type: 'bar',
          stack: 'impact',
          data: d.medium,
          itemStyle: { color: '#FF9500' },
        },
        {
          name: 'Low',
          type: 'bar',
          stack: 'impact',
          data: d.low,
          itemStyle: { color: '#34C759' },
        },
      ],
    };
  });

  // ── Filter helpers ──────────────────────────────────────────────────────
  hasActiveFilters(): boolean {
    return (
      !!this.currencyFilter() || !!this.impactFilter() || this.dateRangeFilter() !== 'upcoming'
    );
  }

  resetFilters(): void {
    this.currencyFilter.set('');
    this.impactFilter.set('');
    this.dateRangeFilter.set('upcoming');
  }

  onFilterChange(field: 'currency' | 'impact' | 'dateRange', value: string): void {
    if (field === 'currency') this.currencyFilter.set(value);
    else if (field === 'impact') this.impactFilter.set(value);
    else if (field === 'dateRange') this.dateRangeFilter.set(value as DateRange);
  }

  // Countdown to a scheduled timestamp ("in 2h 15m" / "in 3d" / "started").
  countdown(scheduledAt: string): string {
    const ms = new Date(scheduledAt).getTime() - Date.now();
    if (ms < 0) return 'started';
    const hours = Math.floor(ms / HOUR_MS);
    const mins = Math.floor((ms % HOUR_MS) / (60 * 1000));
    if (hours >= 24) {
      const days = Math.floor(hours / 24);
      const remH = hours % 24;
      return remH > 0 ? `in ${days}d ${remH}h` : `in ${days}d`;
    }
    if (hours > 0) return `in ${hours}h ${mins}m`;
    return `in ${mins}m`;
  }

  constructor() {
    // Refetch the table whenever a filter changes — and once the analytics
    // window settles whether anything is upcoming, since that decides the
    // default sort direction of the table.
    effect(() => {
      this.currencyFilter();
      this.impactFilter();
      this.dateRangeFilter();
      this.hasUpcoming();
      queueMicrotask(() => this.table?.loadData());
    });
  }

  readonly fetchData = (params: PagerRequest): Observable<PagedData<EconomicEventDto>> => {
    const baseFilter = (params.filter ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...baseFilter };
    if (this.currencyFilter()) merged['currency'] = this.currencyFilter();
    if (this.impactFilter()) merged['impact'] = this.impactFilter();
    const range = this.dateRangeFilter();
    const now = Date.now();
    if (range === 'today') {
      const start = startOfUtcDay(now);
      merged['from'] = new Date(start).toISOString();
      merged['to'] = new Date(start + DAY_MS).toISOString();
    } else if (range === 'next24h') {
      merged['from'] = new Date(now).toISOString();
      merged['to'] = new Date(now + DAY_MS).toISOString();
    } else if (range === 'past24h') {
      merged['from'] = new Date(now - DAY_MS).toISOString();
      merged['to'] = new Date(now).toISOString();
    } else if (range === 'week') {
      const start = startOfUtcDay(now);
      merged['from'] = new Date(start).toISOString();
      merged['to'] = new Date(start + 7 * DAY_MS).toISOString();
    }

    // Default order when the operator has not sorted a column: upcoming
    // first (ascending from now) while the calendar has anything ahead,
    // otherwise latest first — an ascending "All time" list that opens on the
    // oldest backfilled row is useless to a trader. An explicit column sort
    // always wins and never gets the implicit "from now" bound.
    let sortBy = params.sortBy;
    let sortDirection = params.sortDirection;
    if (!sortBy) {
      sortBy = 'scheduledAt';
      if (range === 'all') {
        sortDirection = 'desc';
      } else if (this.hasUpcoming()) {
        sortDirection = 'asc';
        if (range === 'upcoming') merged['from'] = new Date(now).toISOString();
      } else {
        sortDirection = 'desc';
      }
    }

    return this.service
      .list({
        ...params,
        sortBy,
        sortDirection,
        filter: Object.keys(merged).length > 0 ? merged : null,
      })
      .pipe(map((r) => r.data ?? { pager: emptyPager(), data: [] }));
  };

  openCreate(): void {
    this.createForm.reset({
      title: '',
      currency: 'USD',
      impact: 'Medium',
      scheduledAt: '',
      source: 'Manual',
      forecast: '',
      previous: '',
    });
    this.mode.set('create');
  }

  openActual(row: EconomicEventDto): void {
    this.selectedEvent.set(row);
    this.actualForm.reset({ actual: row.actual ?? '' });
    this.mode.set('actual');

    //--- Seed the description signals from the list-row (may be null if
    //--- the list query doesn't project all fields) then re-fetch with
    //--- the full GetById so we have the latest Description and source
    //--- provenance.
    this.currentDescription.set(row.description ?? null);
    this.currentDescriptionSource.set(row.descriptionSource ?? 'None');
    this.currentDescriptionUpdatedAt.set(row.descriptionUpdatedAt ?? null);
    this.refreshDetail(row.id);
  }

  cancel(): void {
    this.mode.set('idle');
    this.selectedEvent.set(null);
    this.currentDescription.set(null);
    this.currentDescriptionSource.set('None');
    this.currentDescriptionUpdatedAt.set(null);
    this.descriptionLoading.set(false);
  }

  /**
   * Fetches the latest full event detail (incl. description) and refreshes
   * the drawer.  Called on open and after explain/regenerate so the
   * displayed text matches the persisted row.
   */
  private refreshDetail(id: number): void {
    this.service.getById(id).subscribe({
      next: (res) => {
        if (!res.status || !res.data) return;
        // Only update if the drawer is still showing the same event
        if (this.selectedEvent()?.id !== id) return;
        this.selectedEvent.set(res.data);
        this.currentDescription.set(res.data.description ?? null);
        this.currentDescriptionSource.set(res.data.descriptionSource ?? 'None');
        this.currentDescriptionUpdatedAt.set(res.data.descriptionUpdatedAt ?? null);
      },
      // Silent on failure — the drawer keeps whatever we seeded from the
      // list row, operator can still click "Generate" to retry.
      error: () => {},
    });
  }

  generateExplainer(): void {
    const evt = this.selectedEvent();
    if (!evt) return;
    this.descriptionLoading.set(true);
    this.service.explain(evt.id, false).subscribe({
      next: (res) => {
        this.descriptionLoading.set(false);
        if (!res.status || !res.data) {
          this.notifications.error(res.message ?? 'Explainer generation failed');
          return;
        }
        this.applyExplainResult(evt.id, res.data);
        if (!res.data.description)
          this.notifications.error(
            'No explainer available — provider scrape blocked and LLM unavailable',
          );
      },
      error: () => {
        this.descriptionLoading.set(false);
        this.notifications.error('Explainer request failed');
      },
    });
  }

  regenerateExplainer(): void {
    const evt = this.selectedEvent();
    if (!evt) return;
    this.descriptionLoading.set(true);
    this.service.explain(evt.id, true).subscribe({
      next: (res) => {
        this.descriptionLoading.set(false);
        if (res.status && res.data) {
          this.applyExplainResult(evt.id, res.data);
          this.notifications.success('Explainer regenerated');
        } else {
          this.notifications.error(res.message ?? 'Regenerate failed');
        }
      },
      error: () => {
        this.descriptionLoading.set(false);
        this.notifications.error('Regenerate request failed');
      },
    });
  }

  private applyExplainResult(
    eventId: number,
    result: {
      description: string | null;
      descriptionSource: EconomicEventDescriptionSource;
      descriptionUpdatedAt: string | null;
    },
  ): void {
    if (this.selectedEvent()?.id !== eventId) return;
    this.currentDescription.set(result.description);
    this.currentDescriptionSource.set(result.descriptionSource);
    this.currentDescriptionUpdatedAt.set(result.descriptionUpdatedAt);
  }

  descriptionSourceLabel(source: EconomicEventDescriptionSource): string {
    switch (source) {
      case 'Scraped':
        return 'From source';
      case 'LlmGenerated':
        return 'AI-generated';
      case 'Manual':
        return 'Manual';
      case 'None':
      default:
        return '—';
    }
  }

  submitCreate(): void {
    const v = this.createForm.getRawValue();
    this.busy.set(true);
    const request: CreateEconomicEventRequest = {
      title: v.title,
      currency: v.currency,
      impact: v.impact,
      scheduledAt: new Date(v.scheduledAt).toISOString(),
      source: v.source,
      forecast: v.forecast || null,
      previous: v.previous || null,
    };
    this.service.create(request).subscribe({
      next: (res) => {
        this.busy.set(false);
        if (res.status) {
          this.notifications.success('Event created');
          this.cancel();
          this.table?.loadData();
        } else {
          this.notifications.error(res.message ?? 'Create failed');
        }
      },
      error: () => this.busy.set(false),
    });
  }

  submitActual(): void {
    const event = this.selectedEvent();
    if (!event) return;
    const v = this.actualForm.getRawValue();
    this.busy.set(true);
    this.service.updateActual(event.id, { actual: v.actual }).subscribe({
      next: (res) => {
        this.busy.set(false);
        if (res.status) {
          this.notifications.success('Actual value updated');
          this.cancel();
          this.table?.loadData();
        } else {
          this.notifications.error(res.message ?? 'Update failed');
        }
      },
      error: () => this.busy.set(false),
    });
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

// Day buckets are UTC because every timestamp on the page is shown in UTC;
// a local-midnight boundary would put events in a different day than the
// one printed next to them.
function startOfUtcDay(ms: number): number {
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

// AG Grid valueFormatters get `null` for missing values but `''` for blank
// strings; both must read as "no value" so a row never mixes blanks and dashes.
function blankDash(v: unknown): string {
  return v == null || v === '' ? '—' : String(v);
}

function escapeHtml(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
