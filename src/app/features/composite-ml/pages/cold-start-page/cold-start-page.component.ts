import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { map, of, tap } from 'rxjs';

import { CompositeMLService } from '@core/services/composite-ml.service';
import { unwrapResponse } from '@core/api/api.service';
import type {
  ColdStartFloorRowDto,
  ColdStartReportDto,
  CompositeMLDonorSelectionDto,
  Timeframe,
} from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';
import { refetchOnChange } from '@core/polling/refetch-on-change';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';
import { CompositeMlNavComponent } from '../../components/composite-ml-nav/composite-ml-nav.component';

const TIMEFRAMES: readonly Timeframe[] = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'] as const;

const EMPTY_REPORT: ColdStartReportDto = {
  symbol: null,
  timeframe: null,
  asOfUtc: '',
  floors: [],
};

/** A report tagged with the scope it was fetched for, so a scope switch never shows another scope's floors. */
interface ScopedReport {
  scopeKey: string;
  report: ColdStartReportDto;
}

/**
 * The global report takes ~3 s on the engine (it counts every ledger row behind each floor), and
 * every CompositeML tab switch destroys and re-creates this page. Reports younger than this are
 * reused for a revisit's first paint instead of being fetched again; the poll, pushes and the
 * Refresh button always go to the engine.
 */
const REPORT_REUSE_MS = 60_000;
const reportCache = new Map<string, { result: ScopedReport; fetchedAt: number }>();

function scopeKeyOf(symbol: string | null, timeframe: Timeframe | null): string {
  return `${symbol ?? ''}|${timeframe ?? ''}`;
}

@Component({
  selector: 'app-cold-start-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    FormsModule,
    PageHeaderComponent,
    CompositeMlNavComponent,
    MetricCardComponent,
    CardSkeletonComponent,
    EmptyStateComponent,
    ErrorStateComponent,
    RelativeTimePipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="CompositeML — Cold-Start Diagnostics"
        subtitle="Per-floor warm/cold state + donor-warm-start forensic table"
      />
      <app-composite-ml-nav
        [showRefresh]="true"
        [refreshing]="reportResource.refreshing() || donorResource.refreshing()"
        (refresh)="reportResource.refresh(); donorResource.refresh()"
      />

      <!-- ── Scope picker ── -->
      <section class="scope-row">
        <span class="scope-label">Scope</span>
        <div class="scope-tabs">
          <button type="button" [class.active]="!symbolInput()" (click)="setScope(null, null)">
            Global
          </button>
          <button
            type="button"
            [class.active]="!!symbolInput() && !timeframeInput()"
            (click)="symbolInput() && setScope(symbolInput(), null)"
            [disabled]="!symbolInput()"
          >
            Per symbol
          </button>
          <button
            type="button"
            [class.active]="!!symbolInput() && !!timeframeInput()"
            (click)="symbolInput() && timeframeInput() && setScope(symbolInput(), timeframeInput())"
            [disabled]="!symbolInput() || !timeframeInput()"
          >
            Per pair
          </button>
        </div>

        <div class="scope-inputs">
          <input
            type="search"
            placeholder="Symbol (e.g. EURUSD)"
            [ngModel]="symbolInput()"
            (ngModelChange)="symbolInput.set($event); applyIfBothSet()"
          />
          <select
            [ngModel]="timeframeInput()"
            (ngModelChange)="timeframeInput.set($event); applyIfBothSet()"
          >
            <option [ngValue]="null">— timeframe —</option>
            @for (tf of TIMEFRAMES; track tf) {
              <option [ngValue]="tf">{{ tf }}</option>
            }
          </select>
        </div>

        <span class="scope-current">
          Active scope: <strong>{{ activeScopeLabel() }}</strong>
        </span>
      </section>

      <!-- ── Cold-Start Floors panel ── -->
      <section class="section">
        <header class="section-head">
          <h2>Cold-Start Floors</h2>
          @if (report().asOfUtc) {
            <span class="muted small">
              As of
              <span [title]="report().asOfUtc | date: 'yyyy-MM-dd HH:mm:ss UTC'">
                {{ report().asOfUtc | relativeTime }}
              </span>
            </span>
          }
        </header>

        @if (loadingFloors()) {
          <app-card-skeleton [lines]="6" />
        } @else if (reportResource.error()) {
          <app-error-state
            title="Could not load cold-start report"
            message="Engine returned an error. Check System Health to confirm the CompositeML pipeline is running."
            (retry)="reportResource.refresh()"
          />
        } @else if (floors().length === 0) {
          <app-empty-state
            title="No catalogue floors registered"
            description="The cold-start catalogue is empty for this scope. Try changing scope or check that the engine is running CompositeML."
          />
        } @else {
          <div class="kpis">
            <app-metric-card
              label="Total floors"
              [value]="floors().length"
              format="number"
              dotColor="#0071E3"
            />
            <app-metric-card
              label="Warm"
              [value]="warmCount()"
              format="number"
              dotColor="#34C759"
            />
            <app-metric-card
              label="Cold"
              [value]="coldCount()"
              format="number"
              [dotColor]="coldCount() > 0 ? '#FF9500' : '#34C759'"
            />
            <div
              title="Floors that have enough observations to count as warm but whose closed trades net to a loss"
            >
              <app-metric-card
                label="Outcome-cold"
                [value]="outcomeColdCount()"
                format="number"
                [dotColor]="outcomeColdCount() > 0 ? '#FF3B30' : '#34C759'"
              />
            </div>
          </div>

          <section class="card">
            <table class="floors-table">
              <thead>
                <tr>
                  <th>Layer</th>
                  <th class="num">Observed / threshold</th>
                  <th>State</th>
                  <th class="num">Still needed</th>
                  <th>Outcome</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                @for (floor of floors(); track floor.layerKey) {
                  <tr [class.cold]="!floor.isWarm" [class.outcome-cold]="isOutcomeCold(floor)">
                    <!-- Key and description share the elastic column: as two
                         columns the description was clipped to ~14 characters. -->
                    <td class="layer-cell">
                      <span class="mono key">{{ floor.layerKey }}</span>
                      <span class="desc" [title]="floor.description">{{ floor.description }}</span>
                    </td>
                    <td class="num mono nowrap">
                      <span [class.below]="floor.observed < floor.threshold">
                        {{ floor.observed | number: '1.0-0' }}
                      </span>
                      <span class="muted small"> / {{ floor.threshold | number: '1.0-0' }}</span>
                    </td>
                    <td>
                      @if (floor.isWarm) {
                        <span class="state-pill warm">warm</span>
                      } @else {
                        <span class="state-pill cold">cold</span>
                      }
                    </td>
                    <td class="num mono">
                      @if (floor.observationsNeeded > 0) {
                        {{ floor.observationsNeeded | number: '1.0-0' }}
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <!-- Zero closed trades is "no data", not a loss: the old
                         cell painted every empty floor as a red "+0 × 0
                         unprofitable" — 24 of 28 rows on the global scope. -->
                    <td class="outcome nowrap">
                      @if (
                        floor.outcomeRowCount !== null &&
                        floor.outcomeNetPnL !== null &&
                        floor.outcomeRowCount > 0
                      ) {
                        <span
                          class="outcome-cell mono"
                          [class.positive]="floor.outcomeNetPnL > 0"
                          [class.negative]="floor.outcomeNetPnL < 0"
                        >
                          {{ floor.outcomeNetPnL > 0 ? '+' : ''
                          }}{{ floor.outcomeNetPnL | number: '1.2-2' }}
                          <span class="muted small">
                            over {{ floor.outcomeRowCount | number }} trade{{
                              floor.outcomeRowCount === 1 ? '' : 's'
                            }}
                          </span>
                        </span>
                        @if (floor.isOutcomeWarm) {
                          <span class="warm-tag">profitable</span>
                        } @else {
                          <span class="cold-tag">unprofitable</span>
                        }
                      } @else {
                        <span class="muted small">no closed trades</span>
                      }
                    </td>
                    <td class="detail small mono muted" [title]="floor.groupingDetail ?? ''">
                      @if (floor.groupingDetail) {
                        {{ floor.groupingDetail }}
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        }
      </section>

      <!-- ── Donor Selection panel ── -->
      <section class="section">
        <header class="section-head">
          <h2>Donor Selection</h2>
          <span class="muted small"> Per-pair best donor under the canonical selector </span>
        </header>

        @if (loadingDonors()) {
          <app-card-skeleton [lines]="6" />
        } @else if (donorResource.error()) {
          <app-error-state
            title="Could not load donor selection"
            message="Engine returned an error fetching the donor-warm-start forensic surface."
            (retry)="donorResource.refresh()"
          />
        } @else if (donors().length === 0) {
          <section class="card">
            <app-empty-state
              title="No Active CompositeML pairs"
              description="The donor selector needs at least one Active CompositeML pair to produce a candidate set."
            />
          </section>
        } @else {
          <div class="kpis">
            <app-metric-card
              label="Active pairs"
              [value]="donors().length"
              format="number"
              dotColor="#0071E3"
            />
            <app-metric-card
              label="With donor"
              [value]="donorMatchedCount()"
              format="number"
              dotColor="#34C759"
            />
            <app-metric-card
              label="No donor cleared floor"
              [value]="donorOrphanCount()"
              format="number"
              [dotColor]="donorOrphanCount() > 0 ? '#FF9500' : '#34C759'"
            />
            <app-metric-card
              label="Min score floor"
              [value]="minScoreFloor()"
              format="number"
              dotColor="#8E8E93"
            />
          </div>

          <section class="card">
            <table class="donors-table">
              <thead>
                <tr>
                  <th>Target</th>
                  <th>Donor</th>
                  <th class="num">Score</th>
                  <th>Bucket</th>
                </tr>
              </thead>
              <tbody>
                @for (row of donors(); track donorKey(row)) {
                  <tr [class.no-donor]="!row.donorSymbol">
                    <td class="mono">
                      {{ row.targetSymbol }}
                      <span class="muted small">{{ row.targetTimeframe }}</span>
                    </td>
                    <td class="mono">
                      @if (row.donorSymbol && row.donorTimeframe) {
                        {{ row.donorSymbol }}
                        <span class="muted small">{{ row.donorTimeframe }}</span>
                      } @else {
                        <span class="muted">— no donor —</span>
                      }
                    </td>
                    <td class="num mono">
                      @if (row.donorScore !== null) {
                        {{ row.donorScore | number: '1.0-3' }}
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td>
                      <span class="bucket-pill" [attr.data-bucket]="row.scoreBucket">
                        {{ row.scoreBucket }}
                      </span>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        }
      </section>
    </div>
  `,
  styles: [
    `
      /* Pill/text tones. The light-theme hexes these replace (#0040dd blue at
         ~2.2:1, #c93400 amber, #d70015 red ~3:1) were used on the dark theme
         too, where they were barely readable; dark gets the system tints. */
      :host {
        --tone-green: #248a3d;
        --tone-amber: #c93400;
        --tone-red: #d70015;
        --tone-blue: #0040dd;
        --tone-grey: #636366;
        --tone-purple: #8e44ad;
      }
      :host-context([data-theme='dark']) {
        --tone-green: #30d158;
        --tone-amber: #ff9f0a;
        --tone-red: #ff6961;
        --tone-blue: #64d2ff;
        --tone-grey: #a1a1a6;
        --tone-purple: #bf5af2;
      }
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-5);
      }
      .scope-row {
        display: flex;
        align-items: center;
        gap: var(--space-4);
        flex-wrap: wrap;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
      }
      .scope-label {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .scope-tabs {
        display: inline-flex;
        gap: 4px;
        background: var(--bg-primary);
        padding: 4px;
        border-radius: var(--radius-md);
      }
      .scope-tabs button {
        background: transparent;
        border: none;
        padding: 6px 14px;
        border-radius: var(--radius-sm);
        font-size: var(--text-sm);
        color: var(--text-secondary);
        cursor: pointer;
        font-weight: var(--font-medium);
      }
      .scope-tabs button.active {
        background: var(--bg-secondary);
        color: var(--text-primary);
        box-shadow: var(--shadow-sm);
      }
      .scope-tabs button:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .scope-inputs {
        display: flex;
        gap: var(--space-2);
      }
      .scope-inputs input,
      .scope-inputs select {
        padding: 6px 10px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        min-width: 140px;
      }
      .scope-current {
        margin-left: auto;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .scope-current strong {
        color: var(--text-primary);
        font-weight: var(--font-semibold);
      }
      .section {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .section-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
      }
      .section-head h2 {
        margin: 0;
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
      }
      .kpis {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: var(--space-3);
        align-items: start;
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        box-shadow: var(--shadow-sm);
        overflow-x: auto;
      }
      /* Description is the one elastic column and is clipped to a single
         line (full text on hover): 28 rows of 3–5-line prose made the table
         1,400px tall and buried the warm/cold column it exists to show. */
      .floors-table {
        table-layout: fixed;
        min-width: 960px;
      }
      .floors-table th:nth-child(2) {
        width: 140px;
      }
      .floors-table th:nth-child(3) {
        width: 76px;
      }
      .floors-table th:nth-child(4) {
        width: 96px;
      }
      .floors-table th:nth-child(5) {
        width: 230px;
      }
      .floors-table th:nth-child(6) {
        width: 170px;
      }
      .floors-table,
      .donors-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .layer-cell {
        line-height: 1.35;
      }
      .layer-cell .key {
        display: block;
        overflow-wrap: anywhere;
      }
      .layer-cell .desc {
        display: block;
        margin-top: 2px;
        font-size: var(--text-xs);
      }
      .nowrap {
        white-space: nowrap;
      }
      .floors-table th,
      .floors-table td,
      .donors-table th,
      .donors-table td {
        padding: 8px 10px;
        text-align: left;
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }
      .floors-table th,
      .donors-table th {
        color: var(--text-secondary);
        font-weight: var(--font-medium);
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .floors-table td.num,
      .floors-table th.num,
      .donors-table td.num,
      .donors-table th.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .floors-table tr.cold .desc {
        color: var(--text-tertiary);
      }
      .floors-table tr.outcome-cold {
        background: rgba(255, 59, 48, 0.04);
      }
      .floors-table tr.outcome-cold td:first-child {
        border-left: 3px solid var(--tone-red);
        padding-left: 8px;
      }
      .donors-table tr.no-donor {
        opacity: 0.65;
      }
      .below {
        color: var(--tone-amber);
      }
      .mono {
        font-family: var(--font-mono);
      }
      .muted {
        color: var(--text-tertiary);
      }
      .small {
        font-size: var(--text-xs);
      }
      .desc {
        color: var(--text-secondary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .state-pill {
        font-size: var(--text-xs);
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-weight: var(--font-semibold);
      }
      .state-pill.warm {
        background: rgba(52, 199, 89, 0.12);
        color: var(--tone-green);
      }
      .state-pill.cold {
        background: rgba(255, 149, 0, 0.12);
        color: var(--tone-amber);
      }
      .outcome-cell {
        display: inline-flex;
        align-items: baseline;
        gap: 4px;
      }
      .positive {
        color: var(--tone-green);
      }
      .negative {
        color: var(--tone-red);
      }
      .warm-tag,
      .cold-tag {
        display: inline-block;
        margin-left: 8px;
        font-size: var(--text-xs);
        padding: 1px 6px;
        border-radius: var(--radius-sm);
        font-weight: var(--font-medium);
      }
      .warm-tag {
        background: rgba(52, 199, 89, 0.12);
        color: var(--tone-green);
      }
      .cold-tag {
        background: rgba(255, 59, 48, 0.12);
        color: var(--tone-red);
      }
      .detail {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .bucket-pill {
        font-size: var(--text-xs);
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-weight: var(--font-medium);
        background: var(--bg-primary);
        color: var(--text-secondary);
      }
      .bucket-pill[data-bucket='exact_match'] {
        background: rgba(52, 199, 89, 0.16);
        color: var(--tone-green);
      }
      .bucket-pill[data-bucket='high'] {
        background: rgba(52, 199, 89, 0.12);
        color: var(--tone-green);
      }
      .bucket-pill[data-bucket='medium'] {
        background: rgba(0, 113, 227, 0.12);
        color: var(--tone-blue);
      }
      .bucket-pill[data-bucket='low'] {
        background: rgba(255, 149, 0, 0.12);
        color: var(--tone-amber);
      }
      .bucket-pill[data-bucket='none'] {
        background: rgba(142, 142, 147, 0.16);
        color: var(--tone-grey);
      }
    `,
  ],
})
export class ColdStartPageComponent {
  private readonly compositeMl = inject(CompositeMLService);

  protected readonly TIMEFRAMES = TIMEFRAMES;

  // Picker state (raw inputs operator types into) — separate from the
  // "applied scope" pair that actually drives the fetch, so partial input
  // (just symbol typed, no timeframe yet) doesn't refetch prematurely.
  protected readonly symbolInput = signal<string>('');
  protected readonly timeframeInput = signal<Timeframe | null>(null);

  // Applied scope — what the report fetcher actually reads.
  protected readonly appliedSymbol = signal<string | null>(null);
  protected readonly appliedTimeframe = signal<Timeframe | null>(null);

  // Cold-start report depends on scope. Donor selection is engine-wide
  // (no scope filter) so it polls independently.
  /** Only this instance's first fetch may be answered from {@link reportCache}. */
  private firstReportFetch = true;

  protected readonly reportResource = createPolledResource<ScopedReport>(
    () => {
      const symbol = this.appliedSymbol();
      const timeframe = this.appliedTimeframe();
      const scopeKey = scopeKeyOf(symbol, timeframe);
      const reuse = this.firstReportFetch;
      this.firstReportFetch = false;
      const cached = reportCache.get(scopeKey);
      if (reuse && cached && Date.now() - cached.fetchedAt < REPORT_REUSE_MS) {
        return of(cached.result);
      }
      // Errors propagate to reportResource.error(): they used to become an
      // empty report, i.e. "No catalogue floors registered".
      return this.compositeMl.getColdStartReport({ symbol, timeframe }).pipe(
        map(unwrapResponse),
        map((report) => ({ scopeKey, report })),
        tap((result) => reportCache.set(scopeKey, { result, fetchedAt: Date.now() })),
      );
    },
    {
      // Push-driven: the interval is only a fallback for a missed
      // push or a reconnect gap.
      intervalMs: 120_000,
      refreshOn: ['compositeMLCatalogueDriftDropAlert', 'mlModelActivated', 'mlModelRetired'],
    },
  );

  protected readonly donorResource = createPolledResource(
    () => this.compositeMl.getDonorSelection().pipe(map(unwrapResponse)),
    {
      // Push-driven: the interval is only a fallback for a missed
      // push or a reconnect gap.
      intervalMs: 120_000,
      refreshOn: ['compositeMLCatalogueDriftDropAlert', 'mlModelActivated', 'mlModelRetired'],
    },
  );

  private readonly appliedScopeKey = computed(() =>
    scopeKeyOf(this.appliedSymbol(), this.appliedTimeframe()),
  );

  constructor() {
    // Refetch when the applied scope changes — debounced, because typing a
    // symbol applies it per keystroke ("E", "EU", "EUR"…).
    refetchOnChange(
      () => this.appliedScopeKey(),
      () => this.reportResource.refresh(),
      300,
    );
  }

  /** The report for the applied scope, or null while it has not arrived yet. */
  private readonly currentReport = computed(() => {
    const v = this.reportResource.value();
    return v && v.scopeKey === this.appliedScopeKey() ? v.report : null;
  });
  protected readonly report = computed(() => this.currentReport() ?? EMPTY_REPORT);
  protected readonly floors = computed(() => this.report().floors);
  /**
   * First paint, or a scope switch still in flight. The old check
   * (`loading() && floors empty`) went false the moment the previous scope's
   * floors were on screen, so they stayed up under the new scope's label for
   * the whole ~3 s request.
   */
  protected readonly loadingFloors = computed(
    () =>
      this.reportResource.loading() ||
      (this.currentReport() === null && !this.reportResource.error()),
  );

  protected readonly warmCount = computed(() => this.floors().filter((f) => f.isWarm).length);
  protected readonly coldCount = computed(() => this.floors().filter((f) => !f.isWarm).length);
  protected readonly outcomeColdCount = computed(
    () => this.floors().filter((f) => this.isOutcomeCold(f)).length,
  );

  protected readonly donors = computed(() => this.donorResource.value() ?? []);
  protected readonly loadingDonors = computed(
    () => this.donorResource.loading() && this.donors().length === 0,
  );
  protected readonly donorMatchedCount = computed(
    () => this.donors().filter((d) => d.donorSymbol !== null).length,
  );
  protected readonly donorOrphanCount = computed(
    () => this.donors().filter((d) => d.donorSymbol === null).length,
  );
  protected readonly minScoreFloor = computed(() => this.donors()[0]?.minScoreFloor ?? null);

  protected readonly activeScopeLabel = computed(() => {
    const s = this.appliedSymbol();
    const tf = this.appliedTimeframe();
    if (!s) return 'global';
    if (!tf) return `${s} (all timeframes)`;
    return `${s} · ${tf}`;
  });

  protected setScope(rawSymbol: string | null, timeframe: Timeframe | null): void {
    // Symbols are upper-case on the engine; "eurusd" used to be sent verbatim.
    const symbol = rawSymbol?.trim().toUpperCase() || null;
    this.appliedSymbol.set(symbol);
    this.appliedTimeframe.set(timeframe);
    // Keep the picker inputs in sync so the active tab + radio reflect state.
    if (symbol === null) {
      this.symbolInput.set('');
      this.timeframeInput.set(null);
    } else {
      this.symbolInput.set(symbol);
      this.timeframeInput.set(timeframe);
    }
  }

  /**
   * Called from ngModelChange — auto-apply once both inputs are set so the
   * picker behaves like a typeahead (no Apply button needed). Global tier
   * is reached by clicking the "Global" segmented-tab.
   */
  protected applyIfBothSet(): void {
    const symbol = this.symbolInput()?.trim().toUpperCase() || null;
    const tf = this.timeframeInput() ?? null;
    if (symbol && tf) {
      this.appliedSymbol.set(symbol);
      this.appliedTimeframe.set(tf);
    } else if (symbol && !tf) {
      // Per-symbol tier: apply once symbol is non-empty even without tf.
      this.appliedSymbol.set(symbol);
      this.appliedTimeframe.set(null);
    }
  }

  protected isOutcomeCold(floor: ColdStartFloorRowDto): boolean {
    return (
      floor.isWarm &&
      floor.isOutcomeWarm === false &&
      floor.outcomeRowCount !== null &&
      floor.outcomeRowCount > 0
    );
  }

  protected donorKey(d: CompositeMLDonorSelectionDto): string {
    return `${d.targetSymbol}|${d.targetTimeframe}`;
  }
}
