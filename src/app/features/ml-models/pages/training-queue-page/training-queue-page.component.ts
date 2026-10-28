import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { catchError, map, of } from 'rxjs';

import { MLModelsService } from '@core/services/ml-models.service';
import type { ActiveMLTrainingRunDto, MLTrainingRunDto } from '@core/api/api.types';
import { unwrapResponse } from '@core/api/api.service';
import { createPolledResource } from '@core/polling/polled-resource';
import { NotificationService } from '@core/notifications/notification.service';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';
import { ConfigService } from '@core/services/config.service';
import { FeatureStateComponent } from '@shared/components/feedback/feature-state.component';

import { failureCategory, summariseRuns } from './training-history.logic';

import { RefreshButtonComponent } from '@shared/components/refresh-button/refresh-button.component';

/**
 * Live snapshot of every Queued/Running ML training run. Powered by
 * `GET /ml-model/training/queue` — a flat list with no pagination because the
 * active set is bounded by the per-pair active-run unique index. Polled at
 * 15s so the queue age stays fresh without hammering the engine.
 *
 * Operator surface for two recurring questions:
 *   "Why hasn't pair X started training yet?" → look at `Queued for` age.
 *   "Is MLTrainingWorker actually doing anything?" → look at the running-row
 *   count + `Running for` age (zero running + non-zero queued = worker stuck
 *   or gated off via Workers:MLTrainingWorker:Enabled).
 */
@Component({
  selector: 'app-training-queue-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    RouterLink,
    PageHeaderComponent,
    MetricCardComponent,
    CardSkeletonComponent,
    ErrorStateComponent,
    FeatureStateComponent,
    RelativeTimePipe,
    RefreshButtonComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="ML — Training Queue"
        subtitle="Live snapshot of every Queued or Running training run"
      >
        <a routerLink="/ml-models" class="btn btn-secondary">← ML Models</a>
        <app-refresh-button [refreshing]="resource.refreshing()" (refresh)="resource.refresh()" />
      </app-page-header>

      @if (loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (resource.error()) {
        <app-error-state
          title="Could not load training queue"
          message="Engine returned an error fetching the active runs. Verify the engine is reachable."
          (retry)="resource.refresh()"
        />
      } @else {
        <section class="kpis">
          <app-metric-card
            label="Total active"
            [value]="runs().length"
            format="number"
            [dotColor]="runs().length > 0 ? '#0A84FF' : '#34C759'"
          />
          <app-metric-card
            label="Queued (no worker)"
            [value]="queuedCount()"
            format="number"
            [dotColor]="queuedCount() > 0 ? '#FF9500' : '#34C759'"
          />
          <app-metric-card
            label="Running"
            [value]="runningCount()"
            format="number"
            [dotColor]="runningCount() > 0 ? '#34C759' : '#8E8E93'"
          />
          <!-- Same tile as its three neighbours: the age is expressed in hours
               so it fits MetricCard's numeric contract, and an empty queue
               renders the card's own placeholder rather than a custom one. -->
          <app-metric-card
            label="Oldest queue age (h)"
            [value]="oldestQueueAgeHours()"
            format="number"
            [dotColor]="oldestQueueWarning() ? '#FF3B30' : '#8E8E93'"
          />
        </section>

        <!-- ── Auto-pick blocklist ──────────────────────────────────────────
             Lets the operator exclude specific architectures from every engine-
             driven training path. Manual triggers (the trigger modal on the
             ML Models page) ignore this list — operators can still pick blocked
             architectures explicitly. Saves via PUT /training/blocked-architectures. -->
        <section class="card blocklist">
          <header class="blocklist-header">
            <div>
              <h3>Auto-pick blocklist</h3>
              <p class="muted small">
                Checked architectures are skipped by drift workers, trainer-selector fallbacks,
                shadow rotation, and self-tuning retry. Manual training triggers still allow them.
              </p>
            </div>
            <button
              type="button"
              class="btn btn-primary"
              (click)="saveBlocklist()"
              [disabled]="!archResource.value() || savingBlocklist() || !blocklistDirty()"
              title="Persist the blocklist to EngineConfig"
            >
              {{ savingBlocklist() ? 'Saving…' : 'Save changes' }}
            </button>
          </header>

          @if (archResource.loading() && !archResource.value()) {
            <app-card-skeleton [lines]="3" />
          } @else if (archResource.error()) {
            <app-error-state
              title="Could not load architectures"
              message="Engine returned an error fetching the architecture list."
              (retry)="archResource.refresh()"
            />
          } @else {
            <div class="arch-grid">
              @for (a of archResource.value()?.architectures ?? []; track a.value) {
                <label class="arch-chip" [class.blocked]="blockedSet().has(a.name)">
                  <input
                    type="checkbox"
                    [checked]="blockedSet().has(a.name)"
                    (change)="toggleBlocked(a.name)"
                  />
                  <span class="arch-name mono">{{ a.name }}</span>
                </label>
              }
            </div>
            @if ((archResource.value()?.disabledArchitectures?.length ?? 0) > 0) {
              <p class="muted small disabled-note">
                Disabled by host capability ({{ archResource.value()?.disabledReason }}):
                {{ archResource.value()!.disabledArchitectures.join(', ') }}
              </p>
            }
          }
        </section>

        @if (runs().length === 0) {
          <app-feature-state
            title="ML training worker"
            summary="The training worker picks up queued runs one pair at a time: a retrain is queued automatically when a live model degrades or drifts, on schedule, or by hand from the ML Models page. Each run must pass the quality gates before its model can be promoted."
            [kind]="workerOn() === false ? 'off' : 'on'"
            [stateLabel]="workerOn() === false ? 'Off' : 'On · nothing queued'"
            switchKey="Workers:MLTrainingWorker:Enabled"
            [detail]="idleDetail()"
            [requirements]="idleRequirements()"
            [links]="[
              { label: 'ML models (trigger training)', route: '/ml-models' },
              { label: 'Overfit watchlist', route: '/ml-models/overfit-watchlist' },
              { label: 'Worker health', route: '/worker-health' },
            ]"
          />
        } @else {
          <section class="card">
            <table class="queue-table">
              <thead>
                <tr>
                  <th>Id</th>
                  <th>Pair</th>
                  <th>Status</th>
                  <th>Trigger</th>
                  <th>Architecture</th>
                  <th>Queued</th>
                  <th>Running</th>
                  <th class="num">Attempts</th>
                  <th>Last error</th>
                  <th class="actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                @for (r of runs(); track r.id) {
                  <tr
                    [class.is-queued]="r.status === 'Queued'"
                    [class.is-running]="r.status === 'Running'"
                    [class.is-cancel-pending]="r.cancelRequested"
                  >
                    <td class="mono">#{{ r.id }}</td>
                    <td>
                      <span class="mono symbol">{{ r.symbol }}</span>
                      <span class="muted small"> · {{ r.timeframe }}</span>
                    </td>
                    <td>
                      <span class="chip" [attr.data-state]="r.status.toLowerCase()">
                        {{ r.status }}
                      </span>
                      @if (r.cancelRequested) {
                        <span class="chip cancel-chip" title="Cancel requested by operator"
                          >cancel pending</span
                        >
                      }
                    </td>
                    <td class="mono small">{{ r.triggerType }}</td>
                    <td class="mono small">{{ r.learnerArchitecture }}</td>
                    <td class="time" [title]="r.startedAt | date: 'yyyy-MM-dd HH:mm:ss UTC'">
                      {{ r.startedAt | relativeTime }}
                    </td>
                    <td
                      class="time"
                      [title]="r.pickedUpAt ? (r.pickedUpAt | date: 'yyyy-MM-dd HH:mm:ss UTC') : ''"
                    >
                      @if (r.pickedUpAt) {
                        {{ r.pickedUpAt | relativeTime }}
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td class="num mono">{{ r.attemptCount }}/{{ r.maxAttempts }}</td>
                    <td class="reason">
                      @if (r.errorMessage) {
                        <span [title]="r.errorMessage">{{ truncate(r.errorMessage, 80) }}</span>
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td class="actions">
                      <button
                        type="button"
                        class="btn btn-xs btn-secondary"
                        (click)="cancel(r)"
                        [disabled]="r.cancelRequested || cancelling().has(r.id)"
                        title="Cancel this training run"
                      >
                        {{ cancelling().has(r.id) ? 'Cancelling…' : 'Cancel' }}
                      </button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        }

        @if (history(); as h) {
          @if (h.total > 0) {
            <section class="card">
              <header class="card-head">
                <h3>Recently finished</h3>
                <span class="sub">
                  Last {{ h.total }} runs since {{ h.oldestUtc | date: 'd MMM' : 'UTC' }}:
                  {{ h.completed }} completed · {{ h.failed }} failed · {{ h.cancelled }} cancelled
                  @if (lastCompleted(); as lc) {
                    · last model trained {{ lc.completedAt | relativeTime }} ({{ lc.symbol }}
                    {{ lc.timeframe }})
                  }
                </span>
              </header>
              @if (h.reasons.length) {
                <div class="reasons" aria-label="Why runs did not complete">
                  @for (r of h.reasons.slice(0, 6); track r.reason) {
                    <span class="reason-chip"
                      ><strong>{{ r.count }}</strong> {{ r.reason }}</span
                    >
                  }
                </div>
              }
              <table class="queue-table">
                <thead>
                  <tr>
                    <th>Id</th>
                    <th>Pair</th>
                    <th>Result</th>
                    <th>Trigger</th>
                    <th>Architecture</th>
                    <th>Finished</th>
                    <th class="num">Took</th>
                    <th>Why</th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of recentRows(); track r.id) {
                    <tr>
                      <td class="mono">#{{ r.id }}</td>
                      <td>
                        <span class="mono symbol">{{ r.symbol }}</span>
                        <span class="muted small"> · {{ r.timeframe }}</span>
                      </td>
                      <td>
                        <span class="chip" [attr.data-state]="('' + r.status).toLowerCase()">{{
                          r.status
                        }}</span>
                      </td>
                      <td class="mono small">{{ r.triggerType }}</td>
                      <td class="mono small">{{ r.learnerArchitecture }}</td>
                      <td
                        class="time"
                        [title]="
                          r.completedAt ? (r.completedAt | date: 'yyyy-MM-dd HH:mm:ss UTC') : ''
                        "
                      >
                        {{ r.completedAt ? (r.completedAt | relativeTime) : '—' }}
                      </td>
                      <td class="num mono small">{{ took(r) }}</td>
                      <td class="reason">
                        @if (r.errorMessage) {
                          <span [title]="r.errorMessage">{{ category(r.errorMessage) }}</span>
                        } @else {
                          <span class="muted">—</span>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </section>
          }
        }
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .kpis {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: var(--space-3);
        align-items: start;
      }
      @media (max-width: 720px) {
        .kpis {
          grid-template-columns: repeat(2, 1fr);
        }
      }
      .card-head {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: var(--space-1) var(--space-3);
        padding: var(--space-3) var(--space-4) var(--space-2);
      }
      .card-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .card-head .sub {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .reasons {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        padding: 0 var(--space-4) var(--space-3);
      }
      .reason-chip {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-full);
        padding: 2px 10px;
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        box-shadow: var(--shadow-sm);
        overflow-x: auto;
      }
      .queue-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .queue-table th,
      .queue-table td {
        padding: 8px 10px;
        text-align: left;
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }
      .queue-table th {
        color: var(--text-secondary);
        font-weight: var(--font-medium);
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .queue-table td.num,
      .queue-table th.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .queue-table tr.is-running {
        background: rgba(52, 199, 89, 0.05);
      }
      .queue-table tr.is-queued td:first-child {
        border-left: 3px solid #ff9500;
        padding-left: 8px;
      }
      .queue-table tr.is-running td:first-child {
        border-left: 3px solid #34c759;
        padding-left: 8px;
      }
      .queue-table tr.is-cancel-pending {
        opacity: 0.65;
      }
      .symbol {
        font-weight: var(--font-semibold);
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
      .reason {
        max-width: 360px;
        color: var(--text-secondary);
        word-break: break-word;
        font-size: var(--text-xs);
      }
      .time {
        color: var(--text-secondary);
        font-size: var(--text-xs);
        white-space: nowrap;
      }
      .chip {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 999px;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .chip[data-state='running'] {
        background: rgba(52, 199, 89, 0.15);
        color: #34c759;
      }
      .chip[data-state='queued'] {
        background: rgba(255, 149, 0, 0.15);
        color: #ff9500;
      }
      .chip.cancel-chip {
        margin-left: 6px;
        background: rgba(255, 59, 48, 0.1);
        color: #d70015;
      }
      .actions {
        text-align: right;
        white-space: nowrap;
      }
      /* Per-component button chrome. The global styles.scss only adds the
         primary gradient overlay — every page that uses .btn is expected to
         supply its own base (padding/height/radius) plus per-variant colours.
         Matches the risk-profiles-page pattern so action buttons across the
         app feel consistent. */
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
        gap: 6px;
        line-height: 1;
        text-decoration: none;
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
      .btn-secondary:hover:not(:disabled) {
        background: var(--bg-quaternary, var(--bg-tertiary));
      }
      .btn-xs {
        height: 26px;
        padding: 0 10px;
        font-size: var(--text-xs);
      }
      .blocklist-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: var(--space-3);
        margin-bottom: var(--space-3);
      }
      .blocklist-header h3 {
        margin: 0 0 4px 0;
        font-size: var(--text-base);
      }
      .blocklist-header p {
        margin: 0;
        max-width: 520px;
      }
      .arch-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
        gap: 8px;
      }
      .arch-chip {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        cursor: pointer;
        user-select: none;
        transition: background 0.15s ease;
      }
      .arch-chip:hover {
        background: var(--bg-tertiary);
      }
      .arch-chip.blocked {
        background: rgba(255, 59, 48, 0.08);
        border-color: rgba(255, 59, 48, 0.3);
      }
      .arch-chip input {
        margin: 0;
        cursor: pointer;
      }
      .arch-name {
        font-size: var(--text-sm);
      }
      .disabled-note {
        margin-top: var(--space-3);
      }
    `,
  ],
})
export class TrainingQueuePageComponent {
  private readonly ml = inject(MLModelsService);
  private readonly notifications = inject(NotificationService);

  protected readonly resource = createPolledResource(
    () =>
      // Errors propagate to resource.error(); swallowed into [] an engine
      // failure read as "Nothing queued or running".
      this.ml.listActiveTrainingRuns().pipe(map(unwrapResponse)),
    {
      // Push-driven: the interval is only a fallback for a missed
      // push or a reconnect gap.
      intervalMs: 120_000,
      refreshOn: ['mlModelActivated', 'mlModelRetired', 'mlDriftRecoveryTriggered'],
    },
  );

  private readonly config = inject(ConfigService);

  /** The newest 100 runs of any status — what the worker has been doing lately. */
  protected readonly recent = createPolledResource(
    () =>
      this.ml
        .listTrainingRuns({
          currentPage: 1,
          itemCountPerPage: 100,
          sortBy: 'Id',
          sortDirection: 'desc',
          filter: null,
        })
        .pipe(
          map((res) => (res.data?.data ?? []) as MLTrainingRunDto[]),
          catchError(() => of(null)),
        ),
    { intervalMs: 300_000 },
  );
  /** The newest COMPLETED run, which may be older than the 100 above. */
  protected readonly lastCompletedRes = createPolledResource(
    () =>
      this.ml
        .listTrainingRuns({
          currentPage: 1,
          itemCountPerPage: 1,
          sortBy: 'Id',
          sortDirection: 'desc',
          filter: { status: 'Completed' },
        })
        .pipe(
          map((res) => ((res.data?.data ?? [])[0] ?? null) as MLTrainingRunDto | null),
          catchError(() => of(null)),
        ),
    { intervalMs: 600_000 },
  );
  protected readonly workerSwitch = createPolledResource(
    () =>
      this.config.getByKey('Workers:MLTrainingWorker:Enabled', { silent: true }).pipe(
        map((r) => (r.status && r.data ? (r.data.value ?? '').trim().toLowerCase() : null)),
        catchError(() => of(null)),
      ),
    { intervalMs: 600_000 },
  );

  protected readonly history = computed(() => {
    const rows = this.recent.value();
    return rows ? summariseRuns(rows) : null;
  });
  protected readonly recentRows = computed(() => (this.recent.value() ?? []).slice(0, 20));
  protected readonly lastCompleted = computed(() => this.lastCompletedRes.value() ?? null);
  protected readonly workerOn = computed(() => {
    const v = this.workerSwitch.value();
    return v === 'true' ? true : v === 'false' ? false : null;
  });
  protected readonly idleDetail = computed(() => {
    const h = this.history();
    if (!h || h.total === 0) return 'Nothing is queued or running right now.';
    const last = h.newestFinishedUtc ? new Date(h.newestFinishedUtc) : null;
    const when = last ? `${last.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'unknown';
    return `Nothing is queued or running right now. The last run finished ${when}; the recent history is below.`;
  });
  protected readonly idleRequirements = computed(() => {
    const on = this.workerOn();
    const lc = this.lastCompleted();
    const h = this.history();
    return [
      {
        label: 'Training worker switched on',
        ok: on,
        detail:
          on === null
            ? 'no setting — code default applies'
            : `Workers:MLTrainingWorker:Enabled = ${on}`,
        route: '/engine-config',
        query: { search: 'MLTrainingWorker' },
      },
      {
        label: 'A recent run passed the quality gates',
        ok: lc ? Date.now() - Date.parse(lc.completedAt ?? lc.startedAt) < 14 * 86_400_000 : false,
        detail: lc
          ? `last completed run #${lc.id} (${lc.symbol} ${lc.timeframe}) finished ${(lc.completedAt ?? lc.startedAt).slice(0, 10)}`
          : 'no completed run found',
      },
      ...(h && h.reasons.length
        ? [
            {
              label: 'Most common reason runs stop',
              ok: null,
              detail: `${h.reasons[0].reason} (${h.reasons[0].count} of the last ${h.total} runs)`,
            },
          ]
        : []),
    ];
  });

  protected category(msg: string): string {
    return failureCategory(msg);
  }
  protected took(r: MLTrainingRunDto): string {
    if (!r.completedAt || !r.startedAt) return '—';
    const min = Math.round((Date.parse(r.completedAt) - Date.parse(r.startedAt)) / 60_000);
    return min < 60 ? `${min} min` : `${(min / 60).toFixed(1)} h`;
  }

  protected readonly runs = computed(() => this.resource.value() ?? []);
  protected readonly loading = computed(() => this.resource.loading() && this.runs().length === 0);
  protected readonly queuedCount = computed(
    () => this.runs().filter((r) => r.status === 'Queued').length,
  );
  protected readonly runningCount = computed(
    () => this.runs().filter((r) => r.status === 'Running').length,
  );

  /**
   * Oldest queue age across the active set, in hours (one decimal). Drives
   * the "Oldest queue age" KPI tile and the warning colour when it exceeds
   * 6h — the empirical threshold above which the operator should investigate
   * (worker gated off, pair stuck on quality gate, etc.). Null when nothing
   * is queued so the tile shows its placeholder rather than a fake 0.
   */
  protected readonly oldestQueueAgeHours = computed<number | null>(() => {
    const arr = this.runs();
    if (arr.length === 0) return null;
    const oldestMs = Math.min(...arr.map((r) => new Date(r.startedAt).getTime()));
    return +Math.max(0, (Date.now() - oldestMs) / 3_600_000).toFixed(1);
  });
  protected readonly oldestQueueWarning = computed(() => (this.oldestQueueAgeHours() ?? 0) > 6);

  protected readonly cancelling = signal<Set<number>>(new Set());

  // ── Auto-pick blocklist state ──────────────────────────────────────────
  // Fetched once on page load and again after a successful save. The local
  // `blockedSet` is the editable state — initialised from the server payload
  // and diffed against `archResource.value().blockedFromAutoPick` to drive
  // the Save button's `disabled` state. Polling interval long (5 min) since
  // operators rarely change the blocklist and the server-side value can also
  // change out of band (direct EngineConfig edit, another operator session).
  protected readonly archResource = createPolledResource(
    () => this.ml.getAvailableArchitectures().pipe(map(unwrapResponse)),
    { intervalMs: 5 * 60_000 },
  );
  protected readonly blockedSet = signal<Set<string>>(new Set());
  protected readonly savingBlocklist = signal(false);
  /**
   * True when the editable set differs from the server's persisted blocklist.
   * Compares set contents (order-independent). Empty + empty = clean.
   */
  protected readonly blocklistDirty = computed(() => {
    const server = new Set(this.archResource.value()?.blockedFromAutoPick ?? []);
    const local = this.blockedSet();
    if (server.size !== local.size) return true;
    for (const name of server) if (!local.has(name)) return true;
    return false;
  });

  /** The server blocklist the editable set was last seeded from (sorted, joined). */
  private seededFrom: string | null = null;

  constructor() {
    // Seed the editable blocklist from the server, and follow it when it
    // changes out of band (another operator, a direct EngineConfig edit) as
    // long as there are no unsaved edits here. It used to seed once, so a
    // later server change surfaced as a phantom "unsaved" diff whose Save
    // would have silently reverted the other change.
    effect(() => {
      const server = this.archResource.value()?.blockedFromAutoPick;
      if (!server) return;
      untracked(() => {
        const serverKey = [...server].sort().join('|');
        const localKey = [...this.blockedSet()].sort().join('|');
        if (this.seededFrom === null || localKey === this.seededFrom) {
          this.blockedSet.set(new Set(server));
        }
        this.seededFrom = serverKey;
      });
    });
  }

  protected toggleBlocked(name: string): void {
    const next = new Set(this.blockedSet());
    if (next.has(name)) next.delete(name);
    else next.add(name);
    this.blockedSet.set(next);
  }

  protected saveBlocklist(): void {
    if (this.savingBlocklist()) return;
    this.savingBlocklist.set(true);
    const payload = Array.from(this.blockedSet()).sort();
    this.ml.setBlockedArchitectures(payload).subscribe({
      next: (res) => {
        this.savingBlocklist.set(false);
        if (res?.status === true) {
          this.notifications.success(
            payload.length === 0
              ? 'Auto-pick blocklist cleared'
              : `Auto-pick blocklist updated (${payload.length} blocked)`,
          );
          this.archResource.refresh();
        } else {
          this.notifications.error(res?.message ?? 'Failed to save blocklist');
        }
      },
      error: () => {
        this.savingBlocklist.set(false);
        this.notifications.error('Failed to save blocklist');
      },
    });
  }

  protected cancel(run: ActiveMLTrainingRunDto): void {
    if (!confirm(`Cancel training run #${run.id} (${run.symbol} / ${run.timeframe})?`)) return;

    const pending = new Set(this.cancelling());
    pending.add(run.id);
    this.cancelling.set(pending);

    this.ml.cancelTraining(run.id).subscribe({
      next: (res) => {
        const next = new Set(this.cancelling());
        next.delete(run.id);
        this.cancelling.set(next);
        if (res?.status === true) {
          this.notifications.success(`Cancelled training run #${run.id}`);
          this.resource.refresh();
        } else {
          this.notifications.error(res?.message ?? 'Cancel request failed');
        }
      },
      error: () => {
        const next = new Set(this.cancelling());
        next.delete(run.id);
        this.cancelling.set(next);
        this.notifications.error('Failed to cancel the training run');
      },
    });
  }

  protected truncate(s: string, n: number): string {
    if (s.length <= n) return s;
    return s.slice(0, n - 1) + '…';
  }
}
