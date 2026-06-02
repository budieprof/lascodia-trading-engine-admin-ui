import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
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

type DateRange = 'all' | 'today' | 'week' | 'next24h' | 'past24h';
type QuickFilter = 'all' | 'today' | 'week' | 'next24h' | 'high' | 'awaiting' | 'usd';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

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
              <input appFormFieldControl formControlName="forecast" placeholder="optional" />
            </app-form-field>
            <app-form-field
              label="Previous"
              hint="Optional"
              [control]="createForm.controls.previous"
            >
              <input appFormFieldControl formControlName="previous" placeholder="optional" />
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
        <aside class="drawer" role="dialog" aria-label="Economic event detail">
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
                  evt.scheduledAt | date: 'EEE, MMM d · HH:mm' : 'UTC'
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
                    <span class="muted small">Updated {{ ts | date: 'medium' }}</span>
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
                <dd>{{ evt.scheduledAt | date: 'yyyy-MM-dd HH:mm' : 'UTC' }}</dd>
                <dt>Scheduled (Local)</dt>
                <dd>{{ evt.scheduledAt | date: 'medium' }}</dd>
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

      <!-- 8-card KPI strip — calendar density at a glance -->
      <div class="kpis">
        <app-metric-card
          label="Total events"
          [value]="totalEver()"
          format="number"
          dotColor="#0071E3"
        />
        <app-metric-card label="Today" [value]="todayCount()" format="number" dotColor="#5AC8FA" />
        <app-metric-card
          label="Next 24h"
          [value]="next24hCount()"
          format="number"
          [dotColor]="next24hCount() > 0 ? '#FF9500' : '#34C759'"
        />
        <app-metric-card
          label="This week"
          [value]="weekCount()"
          format="number"
          dotColor="#5AC8FA"
        />
        <app-metric-card
          label="High impact (window)"
          [value]="highImpactCount()"
          format="number"
          [dotColor]="highImpactCount() > 0 ? '#FF3B30' : '#34C759'"
        />
        <app-metric-card
          label="Awaiting actual"
          [value]="awaitingActualCount()"
          format="number"
          [dotColor]="awaitingActualCount() > 0 ? '#FF9500' : '#34C759'"
        />
        <app-metric-card
          label="Currencies covered"
          [value]="distinctCurrencies().length"
          format="number"
          dotColor="#AF52DE"
        />
        <app-metric-card
          label="Sources"
          [value]="distinctSources().length"
          format="number"
          dotColor="#AF52DE"
        />
      </div>

      <!-- 3-col chart row: impact donut + currency exposure + per-day timeline -->
      <div class="chart-row">
        <app-chart-card
          title="Impact distribution"
          subtitle="Low · Medium · High in the analytics window"
          [options]="impactDonutOptions()"
          height="220px"
        />
        <app-chart-card
          title="Currency exposure"
          subtitle="Top currencies by event count"
          [options]="currencyBarOptions()"
          height="220px"
        />
        <app-chart-card
          title="Calendar density (next 14d)"
          subtitle="Scheduled releases per day · stacked by impact"
          [options]="timelineByDayOptions()"
          height="220px"
        />
      </div>

      <!-- Quick filter chips + filter dropdowns -->
      <div class="filter-bar">
        <div class="chips">
          <button
            type="button"
            [class.active]="quickFilter() === 'all'"
            (click)="setQuickFilter('all')"
          >
            All
          </button>
          <button
            type="button"
            [class.active]="quickFilter() === 'today'"
            (click)="setQuickFilter('today')"
          >
            Today
          </button>
          <button
            type="button"
            [class.active]="quickFilter() === 'next24h'"
            (click)="setQuickFilter('next24h')"
          >
            Next 24h
          </button>
          <button
            type="button"
            [class.active]="quickFilter() === 'week'"
            (click)="setQuickFilter('week')"
          >
            This week
          </button>
          <button
            type="button"
            [class.active]="quickFilter() === 'high'"
            (click)="setQuickFilter('high')"
          >
            High impact only
          </button>
          <button
            type="button"
            [class.active]="quickFilter() === 'awaiting'"
            (click)="setQuickFilter('awaiting')"
          >
            Awaiting actual
          </button>
          <button
            type="button"
            [class.active]="quickFilter() === 'usd'"
            (click)="setQuickFilter('usd')"
          >
            USD only
          </button>
        </div>

        <select
          class="input"
          [ngModel]="currencyFilter()"
          (ngModelChange)="onFilterChange('currency', $event)"
        >
          <option value="">All currencies</option>
          @for (c of currencyOptions(); track c.value) {
            <option [value]="c.value">{{ c.value }} ({{ c.count }})</option>
          }
        </select>
        <select
          class="input"
          [ngModel]="impactFilter()"
          (ngModelChange)="onFilterChange('impact', $event)"
        >
          <option value="">All impacts</option>
          <option value="High">High ({{ impactCounts().High }})</option>
          <option value="Medium">Medium ({{ impactCounts().Medium }})</option>
          <option value="Low">Low ({{ impactCounts().Low }})</option>
        </select>
        <select
          class="input"
          [ngModel]="dateRangeFilter()"
          (ngModelChange)="onFilterChange('dateRange', $event)"
        >
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

      <!-- Upcoming high-impact countdown panel -->
      @if (upcomingHighImpact().length > 0) {
        <section class="upcoming">
          <header class="card-head">
            <h3>Next high-impact releases</h3>
            <span class="muted">
              {{ upcomingHighImpact().length }} upcoming · the engine filters signals around these
            </span>
          </header>
          <ul class="up-list">
            @for (e of upcomingHighImpact(); track e.id) {
              <li class="up-row">
                <span class="up-time mono">{{ countdown(e.scheduledAt) }}</span>
                <span class="impact-pill high">High</span>
                <span class="up-currency mono">{{ e.currency }}</span>
                <span class="up-title" [title]="e.title ?? ''">{{ e.title }}</span>
                <span class="up-meta">
                  fcst <span class="mono">{{ e.forecast || '—' }}</span> · prev
                  <span class="mono">{{ e.previous || '—' }}</span>
                </span>
              </li>
            }
          </ul>
        </section>
      }

      <app-data-table
        #table
        [columnDefs]="columns"
        [fetchData]="fetchData"
        [searchable]="true"
        (rowClick)="openActual($event)"
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
      .btn {
        height: 36px;
        padding: 0 var(--space-4);
        border-radius: var(--radius-full);
        border: none;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
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
      .panel {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      /* ── Chips (reused across drawer + future inline contexts) ───────────── */
      .chip {
        display: inline-flex;
        align-items: center;
        padding: 2px 10px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        white-space: nowrap;
      }
      .chip-currency {
        font-family: var(--font-mono);
        font-weight: var(--font-semibold);
        background: rgba(0, 113, 227, 0.12);
        color: #0071e3;
      }
      .chip-impact[data-impact='High'] {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .chip-impact[data-impact='Medium'] {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }
      .chip-impact[data-impact='Low'] {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .chip-source {
        font-size: 11px;
      }
      .chip-desc[data-source='Scraped'] {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .chip-desc[data-source='LlmGenerated'] {
        background: rgba(191, 90, 242, 0.14);
        color: #8e4ec6;
      }
      .chip-desc[data-source='Manual'] {
        background: rgba(0, 113, 227, 0.12);
        color: #0071e3;
      }
      .chip-desc[data-source='None'] {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }

      /* ── Side drawer (slides in from the right) ───────────────────────────
         Fixed-position so the underlying calendar / filters / table stay
         in place; backdrop click + Escape both close it. */
      .drawer-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.36);
        z-index: 998;
        animation: drawer-fade-in 140ms ease-out;
      }
      .drawer {
        position: fixed;
        top: 0;
        right: 0;
        bottom: 0;
        width: min(560px, 100vw);
        z-index: 999;
        background: var(--bg-primary);
        border-left: 1px solid var(--border);
        box-shadow: -4px 0 24px rgba(0, 0, 0, 0.12);
        display: flex;
        flex-direction: column;
        animation: drawer-slide-in 200ms cubic-bezier(0.22, 0.61, 0.36, 1);
      }
      @keyframes drawer-fade-in {
        from {
          opacity: 0;
        }
        to {
          opacity: 1;
        }
      }
      @keyframes drawer-slide-in {
        from {
          transform: translateX(100%);
        }
        to {
          transform: translateX(0);
        }
      }
      .drawer-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: var(--space-3);
        padding: var(--space-5);
        border-bottom: 1px solid var(--border);
        background: var(--bg-secondary);
      }
      .drawer-head-meta {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .drawer-chips {
        display: flex;
        gap: var(--space-2);
        flex-wrap: wrap;
      }
      .drawer-title {
        margin: 0;
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        line-height: 1.25;
        color: var(--text-primary);
        word-wrap: break-word;
      }
      .drawer-subtitle {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-secondary);
        display: flex;
        gap: var(--space-2);
        align-items: baseline;
        flex-wrap: wrap;
      }
      .drawer-time {
        font-variant-numeric: tabular-nums;
        color: var(--text-primary);
        font-weight: var(--font-medium);
      }
      .drawer-time-suffix {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .drawer-sep {
        opacity: 0.5;
      }
      .drawer-countdown {
        font-size: var(--text-xs);
        padding: 1px 8px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .drawer-close {
        flex: 0 0 auto;
        background: transparent;
        border: none;
        font-size: 24px;
        line-height: 1;
        color: var(--text-secondary);
        cursor: pointer;
        width: 36px;
        height: 36px;
        border-radius: var(--radius-full);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition:
          background 100ms ease,
          color 100ms ease;
      }
      .drawer-close:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .drawer-body {
        flex: 1 1 auto;
        overflow-y: auto;
        padding: var(--space-5);
        display: flex;
        flex-direction: column;
        gap: var(--space-5);
      }

      /* ── Drawer sections ──────────────────────────────────────────────── */
      .drawer-section {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-4);
      }
      .section-title {
        margin: 0 0 var(--space-3) 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .section-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
        margin-bottom: var(--space-3);
      }
      .section-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .section-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
        margin-top: var(--space-3);
        flex-wrap: wrap;
      }

      /* Explainer section gets a soft tint to draw the eye */
      .explainer-section {
        background: linear-gradient(180deg, rgba(191, 90, 242, 0.04) 0%, var(--bg-secondary) 60%);
        border-color: rgba(191, 90, 242, 0.2);
      }
      .explainer-prose {
        margin: 0;
        font-size: var(--text-sm);
        line-height: 1.6;
        color: var(--text-primary);
        white-space: pre-wrap;
      }

      .loading-state,
      .empty-state {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        color: var(--text-secondary);
        font-size: var(--text-sm);
      }
      .empty-state {
        flex-direction: column;
        align-items: flex-start;
        gap: var(--space-2);
      }

      /* Facts grid — Forecast / Previous / Actual side-by-side */
      .facts-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: var(--space-2);
      }
      .fact {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: var(--space-3);
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
      }
      .fact-label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .fact-value {
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
        color: var(--text-primary);
      }
      .fact-emphasis {
        background: rgba(0, 113, 227, 0.06);
        border-color: rgba(0, 113, 227, 0.3);
      }
      .fact-emphasis .fact-value {
        color: #0071e3;
      }

      /* Key/value list for metadata */
      .kv-list {
        display: grid;
        grid-template-columns: 140px 1fr;
        gap: var(--space-2) var(--space-3);
        margin: 0;
      }
      .kv-list dt {
        color: var(--text-secondary);
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .kv-list dd {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }

      /* Collapsible Update Actual */
      .actual-details summary {
        list-style: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-2);
      }
      .actual-details summary::-webkit-details-marker {
        display: none;
      }
      .actual-summary {
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        color: var(--text-primary);
      }
      .actual-summary::before {
        content: '▸';
        margin-right: var(--space-2);
        color: var(--text-secondary);
        transition: transform 120ms ease;
        display: inline-block;
      }
      .actual-details[open] .actual-summary::before {
        transform: rotate(90deg);
      }
      .actual-form {
        margin-top: var(--space-3);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .actual-form-actions {
        display: flex;
        justify-content: flex-end;
      }

      /* Shared utility classes */
      .btn-sm {
        padding: 4px 10px;
        font-size: var(--text-xs);
      }
      .btn-ghost {
        background: transparent;
        color: var(--text-secondary);
        border: 1px solid var(--border);
      }
      .btn-ghost:hover:not(:disabled) {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .muted {
        color: var(--text-secondary);
      }
      .small {
        font-size: var(--text-xs);
      }
      .mono {
        font-family: var(--font-mono);
      }
      .panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--space-4) var(--space-5);
        border-bottom: 1px solid var(--border);
      }
      .panel-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .close {
        background: transparent;
        border: none;
        font-size: 20px;
        color: var(--text-secondary);
        cursor: pointer;
        width: 32px;
        height: 32px;
        border-radius: var(--radius-full);
      }
      .close:hover {
        background: var(--bg-tertiary);
      }
      .panel-body {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: var(--space-4);
        padding: var(--space-5);
      }
      .field {
        display: flex;
        flex-direction: column;
      }
      .field.wide {
        grid-column: 1 / -1;
      }
      .field label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        margin-bottom: var(--space-1);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-weight: var(--font-medium);
      }
      .input {
        height: 36px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        outline: none;
      }
      .input:focus {
        border-color: var(--accent);
      }
      .actions {
        grid-column: 1 / -1;
        display: flex;
        gap: var(--space-2);
        justify-content: flex-end;
        padding-top: var(--space-3);
        border-top: 1px solid var(--border);
        margin-top: var(--space-2);
      }
      .spin {
        width: 16px;
        height: 16px;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-top-color: white;
        border-radius: 50%;
        animation: spin 0.6s linear infinite;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }

      /* 8-card KPI strip */
      .kpis {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        gap: var(--space-2);
      }
      @media (max-width: 1400px) {
        .kpis {
          grid-template-columns: repeat(4, 1fr);
        }
      }
      @media (max-width: 720px) {
        .kpis {
          grid-template-columns: repeat(2, 1fr);
        }
      }

      /* 3-col chart row */
      .chart-row {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: var(--space-3);
      }
      @media (max-width: 1100px) {
        .chart-row {
          grid-template-columns: 1fr;
        }
      }

      /* Filter bar */
      .filter-bar {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        align-items: center;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-2) var(--space-3);
      }
      .chips {
        display: inline-flex;
        gap: 4px;
        background: var(--bg-tertiary);
        border: 1px solid var(--border);
        border-radius: var(--radius-full);
        padding: 2px;
      }
      .chips button {
        height: 28px;
        padding: 0 var(--space-3);
        border: none;
        background: transparent;
        border-radius: var(--radius-full);
        font-size: 11px;
        font-weight: var(--font-medium);
        color: var(--text-secondary);
        cursor: pointer;
      }
      .chips button.active {
        background: var(--bg-primary);
        color: var(--text-primary);
        box-shadow: var(--shadow-sm);
      }
      .input {
        height: 32px;
        padding: 0 var(--space-2);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-xs);
        outline: none;
        max-width: 220px;
      }
      .input:focus {
        border-color: var(--accent);
      }
      .link-btn {
        background: transparent;
        border: none;
        padding: 0 var(--space-2);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        color: var(--accent);
        cursor: pointer;
      }
      .link-btn:hover {
        text-decoration: underline;
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }

      /* Upcoming high-impact panel */
      .upcoming {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .card-head {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .card-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .up-list {
        list-style: none;
        margin: 0;
        padding: 0;
        max-height: 320px;
        overflow-y: auto;
      }
      .up-row {
        display: grid;
        grid-template-columns: 110px 60px 60px 1fr auto;
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-2) var(--space-4);
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .up-row:last-child {
        border-bottom: none;
      }
      .up-time {
        font-variant-numeric: tabular-nums;
        font-weight: var(--font-semibold);
        color: var(--accent);
      }
      .up-currency {
        color: var(--text-secondary);
      }
      .up-title {
        color: var(--text-primary);
        font-weight: var(--font-medium);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .up-meta {
        color: var(--text-tertiary);
        font-size: 11px;
      }
      .impact-pill {
        display: inline-flex;
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
      }
      .impact-pill.high {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .impact-pill.medium {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }
      .impact-pill.low {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .mono {
        font-family: 'SF Mono', 'Menlo', monospace;
      }
    `,
  ],
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

  readonly columns: ColDef<EconomicEventDto>[] = [
    { headerName: 'Title', field: 'title', flex: 2, minWidth: 240 },
    { headerName: 'Currency', field: 'currency', width: 100 },
    {
      headerName: 'Impact',
      field: 'impact',
      width: 100,
      cellRenderer: (p: { value: unknown }) => {
        const v = String(p.value ?? '');
        const palette: Record<string, { bg: string; color: string }> = {
          High: { bg: 'rgba(255,59,48,0.12)', color: '#D70015' },
          Medium: { bg: 'rgba(255,149,0,0.12)', color: '#C93400' },
          Low: { bg: 'rgba(52,199,89,0.12)', color: '#248A3D' },
        };
        const s = palette[v] ?? palette['Low'];
        return `<span style="background:${s.bg};color:${s.color};padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">${v}</span>`;
      },
    },
    { headerName: 'Forecast', field: 'forecast', width: 110 },
    { headerName: 'Previous', field: 'previous', width: 110 },
    {
      headerName: 'Actual',
      field: 'actual',
      width: 110,
      valueFormatter: (p) => (p.value as string) ?? '—',
      cellStyle: (p) => (p.value ? { fontWeight: 600 } : null),
    },
    {
      // "Surprise" — actual vs forecast delta. Only meaningful when both
      // strings parse as numbers; otherwise renders blank. Green = beat (actual
      // > forecast), red = miss. Helps the operator spot release-day surprises
      // without manually diffing the strings.
      headerName: 'Surprise',
      colId: 'surprise',
      width: 110,
      sortable: false,
      cellRenderer: (p: { data: EconomicEventDto }) => {
        const delta = parseSurprise(p.data?.actual ?? null, p.data?.forecast ?? null);
        if (delta === null) return '—';
        const color = delta > 0 ? '#248A3D' : delta < 0 ? '#D70015' : '#636366';
        const sign = delta > 0 ? '+' : '';
        return `<span style="color:${color};font-weight:600;font-variant-numeric:tabular-nums">${sign}${delta.toFixed(2)}</span>`;
      },
    },
    {
      headerName: 'Scheduled',
      field: 'scheduledAt',
      width: 160,
      valueFormatter: (p) => this.datePipe.transform(p.value as string, 'MMM d, HH:mm') ?? '-',
    },
    { headerName: 'Source', field: 'source', width: 120 },
  ];

  // ── Filter state ────────────────────────────────────────────────────────
  readonly currencyFilter = signal('');
  readonly impactFilter = signal('');
  readonly dateRangeFilter = signal<DateRange>('all');
  readonly quickFilter = signal<QuickFilter>('all');

  // ── Analytics resource — probe-and-fetch up to 2000 events ──────────────
  // Used to power KPIs, charts, and the upcoming-high-impact panel without
  // running a separate count query per metric. Polled every 2 minutes —
  // calendars don't change often.
  private readonly analyticsResource = createPolledResource(
    () =>
      this.service.list({ currentPage: 1, itemCountPerPage: 1, filter: null }).pipe(
        switchMap((probe) => {
          const total = probe.data?.pager?.totalItemCount ?? 0;
          const limit = Math.min(total, 2000);
          if (limit === 0) return of({ rows: [] as EconomicEventDto[], total });
          return this.service
            .list({ currentPage: 1, itemCountPerPage: limit, filter: null })
            .pipe(map((r) => ({ rows: r.data?.data ?? [], total })));
        }),
        catchError(() => of({ rows: [] as EconomicEventDto[], total: 0 })),
      ),
    { intervalMs: 120_000 },
  );

  readonly analyticsRows = computed(() => this.analyticsResource.value()?.rows ?? []);
  readonly totalEver = computed(() => this.analyticsResource.value()?.total ?? 0);

  // ── KPI computeds ───────────────────────────────────────────────────────
  readonly todayCount = computed(() => {
    const start = startOfDay(Date.now());
    const end = start + DAY_MS;
    return this.analyticsRows().filter((e) => {
      const t = new Date(e.scheduledAt).getTime();
      return t >= start && t < end;
    }).length;
  });

  readonly next24hCount = computed(() => {
    const now = Date.now();
    return this.analyticsRows().filter((e) => {
      const t = new Date(e.scheduledAt).getTime();
      return t >= now && t < now + DAY_MS;
    }).length;
  });

  readonly weekCount = computed(() => {
    const start = startOfDay(Date.now());
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

  readonly distinctSources = computed(() => {
    const set = new Set<string>();
    for (const e of this.analyticsRows()) if (e.source) set.add(e.source);
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
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: rows.map((r) => r.value).reverse(),
        axisLabel: { fontSize: 10, color: '#6E6E73' },
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
          label: { show: true, position: 'right', fontSize: 10, color: '#6E6E73' },
        },
      ],
    };
  });

  // Stacked bar — events per day (next 14 days), broken down by impact.
  readonly timelineByDayOptions = computed<EChartsOption>(() => {
    const startDay = startOfDay(Date.now());
    const days = 14;
    const labels: string[] = [];
    const high: number[] = new Array(days).fill(0);
    const medium: number[] = new Array(days).fill(0);
    const low: number[] = new Array(days).fill(0);
    for (let i = 0; i < days; i++) {
      const d = new Date(startDay + i * DAY_MS);
      labels.push(`${d.getMonth() + 1}/${d.getDate()}`);
    }
    for (const e of this.analyticsRows()) {
      const t = new Date(e.scheduledAt).getTime();
      const idx = Math.floor((t - startDay) / DAY_MS);
      if (idx < 0 || idx >= days) continue;
      if (e.impact === 'High') high[idx]++;
      else if (e.impact === 'Medium') medium[idx]++;
      else low[idx]++;
    }
    if (high.every((v) => v === 0) && medium.every((v) => v === 0) && low.every((v) => v === 0)) {
      return {
        title: {
          text: 'No upcoming events in the next 14 days',
          left: 'center',
          top: 'middle',
          textStyle: { fontSize: 12, color: '#8E8E93', fontWeight: 'normal' },
        },
      };
    }
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { bottom: 0, textStyle: { fontSize: 10, color: '#6E6E73' } },
      grid: { top: 10, right: 16, bottom: 36, left: 32 },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: { fontSize: 9, color: '#6E6E73', interval: 1 },
      },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          name: 'High',
          type: 'bar',
          stack: 'impact',
          data: high,
          itemStyle: { color: '#FF3B30' },
          barWidth: '70%',
        },
        {
          name: 'Medium',
          type: 'bar',
          stack: 'impact',
          data: medium,
          itemStyle: { color: '#FF9500' },
        },
        {
          name: 'Low',
          type: 'bar',
          stack: 'impact',
          data: low,
          itemStyle: { color: '#34C759' },
        },
      ],
    };
  });

  // ── Filter helpers ──────────────────────────────────────────────────────
  hasActiveFilters(): boolean {
    return !!this.currencyFilter() || !!this.impactFilter() || this.dateRangeFilter() !== 'all';
  }

  resetFilters(): void {
    this.currencyFilter.set('');
    this.impactFilter.set('');
    this.dateRangeFilter.set('all');
    this.quickFilter.set('all');
  }

  setQuickFilter(value: QuickFilter): void {
    this.quickFilter.set(value);
    if (value === 'all') {
      this.currencyFilter.set('');
      this.impactFilter.set('');
      this.dateRangeFilter.set('all');
    } else if (value === 'today') {
      this.currencyFilter.set('');
      this.impactFilter.set('');
      this.dateRangeFilter.set('today');
    } else if (value === 'next24h') {
      this.currencyFilter.set('');
      this.impactFilter.set('');
      this.dateRangeFilter.set('next24h');
    } else if (value === 'week') {
      this.currencyFilter.set('');
      this.impactFilter.set('');
      this.dateRangeFilter.set('week');
    } else if (value === 'high') {
      this.currencyFilter.set('');
      this.impactFilter.set('High');
      this.dateRangeFilter.set('all');
    } else if (value === 'awaiting') {
      // Server-side filter doesn't have an "awaiting actual" predicate — fall
      // back to "past 24h" as a useful approximation for the operator.
      this.currencyFilter.set('');
      this.impactFilter.set('');
      this.dateRangeFilter.set('past24h');
    } else if (value === 'usd') {
      this.currencyFilter.set('USD');
      this.impactFilter.set('');
      this.dateRangeFilter.set('all');
    }
  }

  onFilterChange(field: 'currency' | 'impact' | 'dateRange', value: string): void {
    this.quickFilter.set('all');
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
    // Refetch the table whenever a filter changes.
    effect(() => {
      this.currencyFilter();
      this.impactFilter();
      this.dateRangeFilter();
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
      const start = startOfDay(now);
      merged['from'] = new Date(start).toISOString();
      merged['to'] = new Date(start + DAY_MS).toISOString();
    } else if (range === 'next24h') {
      merged['from'] = new Date(now).toISOString();
      merged['to'] = new Date(now + DAY_MS).toISOString();
    } else if (range === 'past24h') {
      merged['from'] = new Date(now - DAY_MS).toISOString();
      merged['to'] = new Date(now).toISOString();
    } else if (range === 'week') {
      const start = startOfDay(now);
      merged['from'] = new Date(start).toISOString();
      merged['to'] = new Date(start + 7 * DAY_MS).toISOString();
    }
    return this.service
      .list({ ...params, filter: Object.keys(merged).length > 0 ? merged : null })
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

  //--- Escape key closes the side drawer (modal-style affordance).  Only
  //--- fires when there's an open detail; otherwise let the key bubble so
  //--- other surfaces (e.g. the global command palette) can claim it.
  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    if (this.mode() === 'actual' && this.selectedEvent()) {
      this.cancel();
    }
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

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Parse strings like "275K", "1.9%", "<0.75%", "-42" as numbers so we can
// compute an actual-vs-forecast surprise. Returns null when either side fails
// to parse — better to render "—" than a misleading delta.
function parseEconValue(v: string | null): number | null {
  if (v == null) return null;
  const s = v.trim();
  if (s === '') return null;
  // Drop comparison operators / leading symbols (<, >, ~, ≈, ±).
  const stripped = s.replace(/^[<>~≈±]+\s*/, '').replace(/[,\s]/g, '');
  // Match number with optional sign + optional unit suffix (K/M/B/T).
  const m = stripped.match(/^(-?\d+(?:\.\d+)?)\s*([KkMmBbTt%]?)/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toUpperCase();
  if (unit === 'K') n *= 1_000;
  else if (unit === 'M') n *= 1_000_000;
  else if (unit === 'B') n *= 1_000_000_000;
  else if (unit === 'T') n *= 1_000_000_000_000;
  return n;
}

function parseSurprise(actual: string | null, forecast: string | null): number | null {
  const a = parseEconValue(actual);
  const f = parseEconValue(forecast);
  if (a === null || f === null) return null;
  return a - f;
}
