import {
  Component,
  ChangeDetectionStrategy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CurrencyPipe, DatePipe, DecimalPipe, PercentPipe } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { catchError, of } from 'rxjs';

import {
  BacktestStatus,
  BacktestStatusName,
  CompareLlmBacktestRunsResult,
  LlmBacktestRunComparisonSide,
  LlmBacktestService,
  PerSymbolComparison,
} from '@core/services/llm-backtest.service';
import {
  PromptTemplateService,
  PromptTemplateSummary,
} from '@core/services/prompt-template.service';
import { NotificationService } from '@core/notifications/notification.service';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

/** Direction-of-good helper rows for the headline-metrics delta table. */
type DirectionGood = 'up' | 'down';
interface DeltaRow {
  metric: string;
  left: number | null;
  right: number | null;
  delta: number;
  direction: DirectionGood;
  format: 'percent' | 'number' | 'count' | 'currency';
}

/**
 * Phase 2 — paired-run comparison page (`/llm-backtest/compare?left=X&right=Y`).
 * Renders both runs' headline metrics side-by-side + a delta block + a
 * per-symbol delta table + an automated verdict footer.
 */
@Component({
  selector: 'app-llm-backtest-compare-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CurrencyPipe, DatePipe, DecimalPipe, PercentPipe, RouterLink, PageHeaderComponent],
  template: `
    <div class="page">
      <app-page-header
        title="Compare backtest runs"
        subtitle="Baseline (left) vs Candidate (right). Deltas are candidate − baseline."
      >
        <a routerLink="/llm-backtest" class="btn-secondary">‹ Back to list</a>
      </app-page-header>

      @if (loading()) {
        <section class="card empty">Loading comparison…</section>
      } @else if (errorMessage(); as msg) {
        <section class="card empty error">{{ msg }}</section>
      } @else if (result(); as r) {
        <!-- Header cards: baseline + candidate side-by-side -->
        <section class="head-grid">
          <div class="card side side--left">
            <div class="side-head">
              <span class="side-label">Baseline</span>
              <a class="side-id" [routerLink]="['/llm-backtest', r.left.runId]"
                >#{{ r.left.runId }}</a
              >
            </div>
            <h2 class="side-name">{{ r.left.name }}</h2>
            <dl class="kv-list">
              <dt>Status</dt>
              <dd>
                <span class="status-pill" [class]="pillClass(r.left.status)">
                  {{ statusLabel(r.left.status) }}
                </span>
              </dd>
              <dt>Prompt version</dt>
              <dd class="mono small">{{ r.left.promptVersion }}</dd>
              <dt>Model tier</dt>
              <dd>{{ r.left.modelTier === 0 ? 'Spot' : 'Macro' }}</dd>
              <dt>Total points</dt>
              <dd>{{ r.left.totalPoints | number }}</dd>
              <dt>Completed</dt>
              <dd>{{ r.left.completedPoints | number }}</dd>
              <dt>Actual cost</dt>
              <dd>{{ r.left.actualCostUsd | currency: 'USD' }}</dd>
              <dt>Cache hit</dt>
              <dd>{{ r.left.cacheHitRatio | percent: '1.0-1' }}</dd>
              <dt>Started</dt>
              <dd>{{ r.left.startedAt ? (r.left.startedAt | date: 'short') : '—' }}</dd>
              <dt>Completed</dt>
              <dd>{{ r.left.completedAt ? (r.left.completedAt | date: 'short') : '—' }}</dd>
            </dl>
          </div>

          <div class="card side side--right">
            <div class="side-head">
              <span class="side-label side-label--candidate">Candidate</span>
              <a class="side-id" [routerLink]="['/llm-backtest', r.right.runId]"
                >#{{ r.right.runId }}</a
              >
            </div>
            <h2 class="side-name">{{ r.right.name }}</h2>
            <dl class="kv-list">
              <dt>Status</dt>
              <dd>
                <span class="status-pill" [class]="pillClass(r.right.status)">
                  {{ statusLabel(r.right.status) }}
                </span>
              </dd>
              <dt>Prompt version</dt>
              <dd class="mono small">{{ r.right.promptVersion }}</dd>
              <dt>Model tier</dt>
              <dd>{{ r.right.modelTier === 0 ? 'Spot' : 'Macro' }}</dd>
              <dt>Total points</dt>
              <dd>{{ r.right.totalPoints | number }}</dd>
              <dt>Completed</dt>
              <dd>{{ r.right.completedPoints | number }}</dd>
              <dt>Actual cost</dt>
              <dd>{{ r.right.actualCostUsd | currency: 'USD' }}</dd>
              <dt>Cache hit</dt>
              <dd>{{ r.right.cacheHitRatio | percent: '1.0-1' }}</dd>
              <dt>Started</dt>
              <dd>{{ r.right.startedAt ? (r.right.startedAt | date: 'short') : '—' }}</dd>
              <dt>Completed</dt>
              <dd>{{ r.right.completedAt ? (r.right.completedAt | date: 'short') : '—' }}</dd>
            </dl>
          </div>
        </section>

        <!-- Headline metrics delta table -->
        <section class="card">
          <h3>Headline metrics</h3>
          <div class="table-scroll">
            <table class="data-table delta-table">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th class="num">Baseline</th>
                  <th class="num">Candidate</th>
                  <th class="num">Delta</th>
                  <th class="dir"></th>
                </tr>
              </thead>
              <tbody>
                @for (row of deltaRows(); track row.metric) {
                  <tr>
                    <td>{{ row.metric }}</td>
                    <td class="num">{{ formatMetric(row.left, row.format) }}</td>
                    <td class="num">{{ formatMetric(row.right, row.format) }}</td>
                    <td class="num" [class.good]="isGoodDelta(row)" [class.bad]="isBadDelta(row)">
                      {{ formatDelta(row.delta, row.format) }}
                    </td>
                    <td class="dir">
                      <span
                        class="dir-arrow"
                        [class.good]="isGoodDelta(row)"
                        [class.bad]="isBadDelta(row)"
                        [attr.title]="
                          row.direction === 'up' ? 'Higher is better' : 'Lower is better'
                        "
                      >
                        {{ row.direction === 'up' ? '↑' : '↓' }}
                      </span>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>

        <!-- Per-symbol delta table -->
        <section class="card">
          <h3>Per-symbol breakdown</h3>
          @if (sortedPerSymbol().length === 0) {
            <p class="empty-sub">No overlapping symbols across the two runs.</p>
          } @else {
            <div class="table-scroll">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th class="num">L count</th>
                    <th class="num">R count</th>
                    <th class="num">L hit rate</th>
                    <th class="num">R hit rate</th>
                    <th class="num">ΔHit rate</th>
                    <th class="num">L Exp R</th>
                    <th class="num">R Exp R</th>
                    <th class="num">ΔExp R</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of sortedPerSymbol(); track row.symbol) {
                    <tr>
                      <td class="mono">{{ row.symbol }}</td>
                      <td class="num">{{ row.leftCount }}</td>
                      <td class="num">{{ row.rightCount }}</td>
                      <td class="num">{{ row.leftHitRate | percent: '1.0-1' }}</td>
                      <td class="num">{{ row.rightHitRate | percent: '1.0-1' }}</td>
                      <td
                        class="num"
                        [class.good]="row.hitRateDelta > 0"
                        [class.bad]="row.hitRateDelta < 0"
                      >
                        {{ formatDelta(row.hitRateDelta, 'percent') }}
                      </td>
                      <td class="num">{{ row.leftExpectedR | number: '1.2-2' }}</td>
                      <td class="num">{{ row.rightExpectedR | number: '1.2-2' }}</td>
                      <td
                        class="num"
                        [class.good]="row.expectedRDelta > 0"
                        [class.bad]="row.expectedRDelta < 0"
                      >
                        {{ formatDelta(row.expectedRDelta, 'number') }}
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>

        <!-- P4.3 — Promote-candidate CTA. Visible only when the right-side
             run's promptVersion maps to a Draft row in the PromptTemplate
             table AND the delta block shows the candidate is at least
             matching the baseline on hit-rate + expected-R with at least one
             metric strictly positive. -->
        @if (canPromoteCandidate()) {
          <section class="card promote-cta">
            <div class="promote-cta__body">
              <h3>Promote candidate to Active</h3>
              <p>
                The candidate prompt
                <strong>{{ candidateTemplate()!.name }} {{ candidateTemplate()!.version }}</strong>
                is currently a Draft. Based on this comparison the candidate matches or beats the
                baseline on the two headline metrics — promoting it will demote the currently-active
                version to Archived and make this one the Active template the runtime resolves (when
                DB-backed prompts mode is enabled).
              </p>
            </div>
            <button class="btn-promote" (click)="openPromoteModal()" [disabled]="promoteInFlight()">
              {{ promoteInFlight() ? 'Promoting…' : 'Promote candidate to Active' }}
            </button>
          </section>
        }

        <!-- Verdict footer -->
        <section class="card verdict">
          <h3>Verdict</h3>
          <p>{{ verdict() }}</p>
        </section>
      }

      @if (showPromoteModal()) {
        <div class="modal-backdrop" (click)="cancelPromote()">
          <div class="modal" (click)="$event.stopPropagation()">
            <h3>Confirm promotion</h3>
            <p>
              Promote
              <strong>{{ candidateTemplate()!.name }} {{ candidateTemplate()!.version }}</strong>
              to Active?
            </p>
            <p class="modal-warning">
              The currently-active version will be demoted to Archived. If
              <code>UseDbBackedPromptTemplate</code> is enabled in the engine config, live
              spot-analysis behaviour will change immediately on the next call.
            </p>
            <div class="modal-actions">
              <button
                class="btn-secondary"
                (click)="cancelPromote()"
                [disabled]="promoteInFlight()"
              >
                Cancel
              </button>
              <button class="btn-promote" (click)="confirmPromote()" [disabled]="promoteInFlight()">
                {{ promoteInFlight() ? 'Promoting…' : 'Confirm promote' }}
              </button>
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-6);
        display: flex;
        flex-direction: column;
        gap: var(--space-5);
      }
      .btn-secondary {
        background: transparent;
        color: var(--text-primary);
        border: 1px solid var(--border);
        padding: 0.45rem 0.85rem;
        border-radius: var(--radius-sm);
        font-weight: 600;
        font-size: 0.85rem;
        text-decoration: none;
        cursor: pointer;
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-4);
      }
      .card h3 {
        margin: 0 0 0.6rem 0;
        font-size: 0.95rem;
        font-weight: 600;
      }
      .empty,
      .empty-sub {
        padding: var(--space-4);
        text-align: center;
        color: var(--text-secondary);
      }
      .empty.error {
        color: #c4290a;
      }

      .head-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-4);
      }
      @media (max-width: 980px) {
        .head-grid {
          grid-template-columns: 1fr;
        }
      }
      .side {
        display: flex;
        flex-direction: column;
        gap: 0.6rem;
      }
      .side--left {
        border-left: 4px solid var(--text-secondary);
      }
      .side--right {
        border-left: 4px solid #0071e3;
      }
      .side-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .side-label {
        font-size: 0.7rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-secondary);
      }
      .side-label--candidate {
        color: #0071e3;
      }
      .side-id {
        font-family: var(--font-mono, monospace);
        font-size: 0.85rem;
        color: var(--text-primary);
        text-decoration: none;
      }
      .side-id:hover {
        text-decoration: underline;
      }
      .side-name {
        margin: 0;
        font-size: 1.05rem;
        font-weight: 700;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .kv-list {
        margin: 0;
        display: grid;
        grid-template-columns: max-content 1fr;
        column-gap: 0.75rem;
        row-gap: 0.3rem;
        font-size: 0.85rem;
      }
      .kv-list dt {
        color: var(--text-secondary);
        font-size: 0.78rem;
      }
      .kv-list dd {
        margin: 0;
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .mono {
        font-family: var(--font-mono, monospace);
      }
      .small {
        font-size: 0.78rem;
      }

      .status-pill {
        display: inline-block;
        padding: 0.15rem 0.55rem;
        border-radius: 999px;
        font-size: 0.7rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .pill--pending {
        background: rgba(142, 142, 147, 0.2);
        color: var(--text-secondary);
      }
      .pill--running {
        background: rgba(0, 113, 227, 0.18);
        color: #0071e3;
      }
      .pill--completed {
        background: rgba(48, 209, 88, 0.18);
        color: #1f8a3d;
      }
      .pill--failed {
        background: rgba(255, 69, 58, 0.18);
        color: #c4290a;
      }
      .pill--cancelled {
        background: rgba(255, 159, 10, 0.18);
        color: #b3640a;
      }

      .table-scroll {
        overflow-x: auto;
      }
      .data-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.85rem;
      }
      .data-table th,
      .data-table td {
        padding: 0.45rem 0.65rem;
        text-align: left;
        border-bottom: 1px solid var(--border);
      }
      .data-table th {
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary);
        font-weight: 600;
      }
      .data-table th.num,
      .data-table td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .data-table th.dir,
      .data-table td.dir {
        text-align: center;
        width: 2rem;
      }
      .good {
        color: #1f8a3d;
        font-weight: 600;
      }
      .bad {
        color: #c4290a;
        font-weight: 600;
      }
      :host-context([data-theme='dark']) .good {
        color: #5dd47e;
      }
      :host-context([data-theme='dark']) .bad {
        color: #ff8278;
      }
      .dir-arrow {
        font-size: 0.95rem;
        opacity: 0.5;
      }
      .dir-arrow.good,
      .dir-arrow.bad {
        opacity: 1;
      }

      .verdict p {
        margin: 0;
        font-size: 0.95rem;
        line-height: 1.5;
        color: var(--text-primary);
      }
      .promote-cta {
        display: flex;
        align-items: center;
        gap: var(--space-5);
        border: 1px solid var(--success, #1f8a4b);
        background: color-mix(in srgb, var(--success, #1f8a4b) 8%, var(--bg-secondary));
      }
      .promote-cta__body {
        flex: 1;
      }
      .promote-cta__body h3 {
        margin: 0 0 0.4rem 0;
        font-size: 1rem;
        color: var(--success, #1f8a4b);
      }
      .promote-cta__body p {
        margin: 0;
        font-size: 0.9rem;
        line-height: 1.5;
        color: var(--text-secondary);
      }
      .btn-promote {
        background: var(--success, #1f8a4b);
        color: #fff;
        border: 0;
        padding: 0.6rem 1.2rem;
        border-radius: var(--radius-sm);
        font-weight: 600;
        font-size: 0.9rem;
        cursor: pointer;
        white-space: nowrap;
      }
      .btn-promote:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.55);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 100;
      }
      .modal {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-5);
        max-width: 520px;
        width: 90vw;
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .modal h3 {
        margin: 0;
      }
      .modal p {
        margin: 0;
        line-height: 1.5;
      }
      .modal-warning {
        font-size: 0.85rem;
        color: var(--warning, #b58108);
      }
      .modal-warning code {
        background: var(--bg-tertiary, #1a1a1a);
        padding: 0.05rem 0.35rem;
        border-radius: var(--radius-xs, 3px);
        font-family: ui-monospace, SFMono-Regular, monospace;
        font-size: 0.85em;
      }
      .modal-actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-3);
        margin-top: var(--space-2);
      }
    `,
  ],
})
export class LlmBacktestComparePageComponent implements OnInit {
  readonly BacktestStatus = BacktestStatus;

  private readonly svc = inject(LlmBacktestService);
  private readonly promptTemplates = inject(PromptTemplateService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly notifications = inject(NotificationService);

  readonly loading = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly result = signal<CompareLlmBacktestRunsResult | null>(null);

  /**
   * P4.3 — Candidate prompt template lookup. Populated after the comparison
   * loads by listing draft templates for `name=spot-analysis` and matching
   * the right side's <c>promptVersion</c>. <c>null</c> when the right side's
   * version is the currently-active template, is archived, or doesn't have
   * a corresponding DB row (e.g. backtest pinned to a string version that
   * never made it into the table). Drives the promotion CTA.
   */
  readonly candidateTemplate = signal<PromptTemplateSummary | null>(null);
  readonly promoteInFlight = signal(false);
  readonly showPromoteModal = signal(false);

  ngOnInit(): void {
    const params = this.route.snapshot.queryParamMap;
    const left = Number(params.get('left'));
    const right = Number(params.get('right'));
    if (!Number.isFinite(left) || left <= 0 || !Number.isFinite(right) || right <= 0) {
      this.errorMessage.set('Missing or invalid ?left=…&right=… query parameters.');
      return;
    }
    if (left === right) {
      this.errorMessage.set('Left and right run IDs must differ.');
      return;
    }
    this.loading.set(true);
    this.svc
      .compareRuns({ leftRunId: left, rightRunId: right })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.loading.set(false);
        if (res?.status && res.data) {
          this.result.set(res.data);
          this.resolveCandidateTemplate(res.data);
        } else {
          const msg = res?.message ?? 'Comparison failed.';
          this.errorMessage.set(msg);
          this.notifications.error(msg);
        }
      });
  }

  /**
   * After loading the comparison, look up the right-side run's promptVersion
   * in the PromptTemplate table. Only Draft (non-Active, non-Archived) rows
   * are promotion-eligible — Active is already live, Archived can't be
   * promoted directly (operator must fork it first).
   */
  private resolveCandidateTemplate(r: CompareLlmBacktestRunsResult): void {
    const rightVersion = r.right.promptVersion;
    if (!rightVersion) return;
    this.promptTemplates
      .list({
        currentPage: 1,
        itemCountPerPage: 50,
        name: 'spot-analysis',
        includeArchived: false,
      })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        if (!res?.status || !res.data) return;
        const match = res.data.data.find(
          (t: PromptTemplateSummary) => t.version === rightVersion && !t.isActive && !t.isArchived,
        );
        this.candidateTemplate.set(match ?? null);
      });
  }

  /**
   * Show the Promote CTA only when ALL of:
   *  - candidate prompt is a known Draft row (resolveCandidateTemplate matched)
   *  - delta on hit-rate AND expected-R is non-negative (candidate not strictly worse)
   *  - at least one of those two deltas is strictly positive (must be an actual win)
   * Returns true → CTA renders. Returns false → CTA hidden (and the operator
   * can still go through the template editor manually).
   */
  readonly canPromoteCandidate = computed(() => {
    const t = this.candidateTemplate();
    const r = this.result();
    if (!t || !r) return false;
    const dr = r.delta;
    if (dr.hitRateDelta < 0 || dr.expectedRDelta < 0) return false;
    return dr.hitRateDelta > 0 || dr.expectedRDelta > 0;
  });

  openPromoteModal(): void {
    this.showPromoteModal.set(true);
  }
  cancelPromote(): void {
    this.showPromoteModal.set(false);
  }
  confirmPromote(): void {
    const t = this.candidateTemplate();
    if (!t || this.promoteInFlight()) return;
    this.promoteInFlight.set(true);
    this.promptTemplates
      .promote(t.id)
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.promoteInFlight.set(false);
        this.showPromoteModal.set(false);
        if (res?.status) {
          this.notifications.success(
            `Promoted ${t.name} ${t.version} to Active. Prior active version is now archived.`,
          );
          // Refresh the candidate state — after promotion the row is no
          // longer a draft, so the CTA disappears.
          this.candidateTemplate.set({
            ...t,
            isActive: true,
            promotedAt: new Date().toISOString(),
          });
        } else {
          this.notifications.error(res?.message ?? 'Promote failed.');
        }
      });
  }

  // ── Presentation helpers ─────────────────────────────────────────────────

  statusLabel(s: BacktestStatus): string {
    return BacktestStatusName[s] ?? String(s);
  }

  pillClass(s: BacktestStatus): string {
    switch (s) {
      case BacktestStatus.Pending:
        return 'pill--pending';
      case BacktestStatus.Running:
        return 'pill--running';
      case BacktestStatus.Completed:
        return 'pill--completed';
      case BacktestStatus.Failed:
        return 'pill--failed';
      case BacktestStatus.Cancelled:
        return 'pill--cancelled';
      default:
        return '';
    }
  }

  /** Per-row delta table. Server side delivers right - left, surface verbatim. */
  readonly deltaRows = computed<DeltaRow[]>(() => {
    const r = this.result();
    if (!r) return [];
    const l = r.left.summary;
    const c = r.right.summary;
    const d = r.delta;
    return [
      {
        metric: 'Hit rate',
        left: l?.hitRate ?? null,
        right: c?.hitRate ?? null,
        delta: d.hitRateDelta,
        direction: 'up',
        format: 'percent',
      },
      {
        metric: 'Expected R',
        left: l?.expectedR ?? null,
        right: c?.expectedR ?? null,
        delta: d.expectedRDelta,
        direction: 'up',
        format: 'number',
      },
      {
        metric: 'Viable count',
        left: l?.viableCount ?? null,
        right: c?.viableCount ?? null,
        delta: d.viableCountDelta,
        direction: 'up',
        format: 'count',
      },
      {
        metric: 'Rejected by gate',
        left: l?.rejectedByGateCount ?? null,
        right: c?.rejectedByGateCount ?? null,
        delta: d.rejectedByGateCountDelta,
        direction: 'down',
        format: 'count',
      },
      {
        metric: 'Bypassed',
        left: l?.bypassedCount ?? null,
        right: c?.bypassedCount ?? null,
        delta: d.bypassedCountDelta,
        direction: 'down',
        format: 'count',
      },
      {
        metric: 'Actual cost (USD)',
        left: l?.actualCostUsd ?? r.left.actualCostUsd ?? null,
        right: c?.actualCostUsd ?? r.right.actualCostUsd ?? null,
        delta: d.actualCostUsdDelta,
        direction: 'down',
        format: 'currency',
      },
      {
        metric: 'Cache hit ratio',
        left: l?.cacheHitRatio ?? r.left.cacheHitRatio ?? null,
        right: c?.cacheHitRatio ?? r.right.cacheHitRatio ?? null,
        delta: d.cacheHitRatioDelta,
        direction: 'up',
        format: 'percent',
      },
      {
        metric: 'Hit TP',
        left: l?.outcomes.hitTP ?? null,
        right: c?.outcomes.hitTP ?? null,
        delta: d.hitTpDelta,
        direction: 'up',
        format: 'count',
      },
      {
        metric: 'Hit SL',
        left: l?.outcomes.hitSL ?? null,
        right: c?.outcomes.hitSL ?? null,
        delta: d.hitSlDelta,
        direction: 'down',
        format: 'count',
      },
      {
        metric: 'Expired positive',
        left: l?.outcomes.expiredPositive ?? null,
        right: c?.outcomes.expiredPositive ?? null,
        delta: d.expiredPositiveDelta,
        direction: 'up',
        format: 'count',
      },
      {
        metric: 'Expired negative',
        left: l?.outcomes.expiredNegative ?? null,
        right: c?.outcomes.expiredNegative ?? null,
        delta: d.expiredNegativeDelta,
        direction: 'down',
        format: 'count',
      },
    ];
  });

  /** Treat |delta| < ε as "neutral" so a noise-floor zero isn't coloured. */
  private static readonly DELTA_EPSILON = 1e-6;

  isGoodDelta(row: DeltaRow): boolean {
    if (Math.abs(row.delta) < LlmBacktestComparePageComponent.DELTA_EPSILON) return false;
    return row.direction === 'up' ? row.delta > 0 : row.delta < 0;
  }
  isBadDelta(row: DeltaRow): boolean {
    if (Math.abs(row.delta) < LlmBacktestComparePageComponent.DELTA_EPSILON) return false;
    return row.direction === 'up' ? row.delta < 0 : row.delta > 0;
  }

  formatMetric(v: number | null, fmt: DeltaRow['format']): string {
    if (v == null) return '—';
    switch (fmt) {
      case 'percent':
        return `${(v * 100).toFixed(1)}%`;
      case 'currency':
        return `$${v.toFixed(2)}`;
      case 'count':
        return Math.round(v).toLocaleString();
      case 'number':
      default:
        return v.toFixed(2);
    }
  }

  formatDelta(d: number, fmt: DeltaRow['format']): string {
    const sign = d > 0 ? '+' : '';
    switch (fmt) {
      case 'percent':
        return `${sign}${(d * 100).toFixed(2)}%`;
      case 'currency':
        return `${sign}$${d.toFixed(2)}`;
      case 'count':
        return `${sign}${Math.round(d).toLocaleString()}`;
      case 'number':
      default:
        return `${sign}${d.toFixed(2)}`;
    }
  }

  /**
   * Per-symbol delta sorted by best ExpectedR improvement first, so the
   * operator sees the candidate's wins at the top of the table.
   */
  readonly sortedPerSymbol = computed<PerSymbolComparison[]>(() => {
    const r = this.result();
    if (!r) return [];
    return [...r.perSymbol].sort((a, b) => b.expectedRDelta - a.expectedRDelta);
  });

  /**
   * One-paragraph automated verdict. Counts "good" deltas across the
   * delta rows and reports the headline hit-rate / expected-R deltas.
   */
  readonly verdict = computed(() => {
    const r = this.result();
    if (!r) return '';
    const rows = this.deltaRows();
    let good = 0;
    let bad = 0;
    let neutral = 0;
    for (const row of rows) {
      if (this.isGoodDelta(row)) good++;
      else if (this.isBadDelta(row)) bad++;
      else neutral++;
    }
    const total = rows.length;
    const dominates =
      good > bad
        ? `Candidate dominates baseline on ${good} of ${total} metrics`
        : good < bad
          ? `Candidate underperforms baseline on ${bad} of ${total} metrics`
          : `Candidate matches baseline (good/bad balanced at ${good}/${bad})`;
    const hitRateDelta = (r.delta.hitRateDelta * 100).toFixed(2);
    const expectedRDelta = r.delta.expectedRDelta.toFixed(2);
    const sign = (v: string) => (v.startsWith('-') ? v : `+${v}`);
    const neutralFrag = neutral > 0 ? ` (${neutral} neutral)` : '';
    return (
      `${dominates}${neutralFrag}. ` +
      `Net hit-rate change: ${sign(hitRateDelta)}%. ` +
      `Net expected-R change: ${sign(expectedRDelta)}R.`
    );
  });

  /**
   * The container template uses these as helpers without further allocations.
   */
  asSide(s: LlmBacktestRunComparisonSide): LlmBacktestRunComparisonSide {
    return s;
  }
}
