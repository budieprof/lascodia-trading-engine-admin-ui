import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  OnInit,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule, DatePipe, DecimalPipe, SlicePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { catchError, of } from 'rxjs';

import { LlmService } from '@core/services/llm.service';
import {
  LlmInvocationDetailDto,
  LlmInvocationDto,
  LlmInvocationsSummaryDto,
  LlmOutcome,
  LlmOutcomeLabel,
} from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import type { EChartsOption } from 'echarts';

@Component({
  selector: 'app-llm-invocations-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    DatePipe,
    DecimalPipe,
    SlicePipe,
    FormsModule,
    PageHeaderComponent,
    MetricCardComponent,
    ChartCardComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="LLM Invocations"
        subtitle="Every model call the engine made — provider, model, tokens, cost, latency, outcome."
      >
        <select class="window-select" [(ngModel)]="windowHours" (change)="reloadSummary()">
          <option [ngValue]="1">Last 1h</option>
          <option [ngValue]="6">Last 6h</option>
          <option [ngValue]="24">Last 24h</option>
          <option [ngValue]="168">Last 7d</option>
          <option [ngValue]="720">Last 30d</option>
        </select>
        <button type="button" class="btn-refresh" (click)="reload()">↻ Refresh</button>
      </app-page-header>

      <!-- ── KPI strip ──────────────────────────────────────────────── -->
      <div class="kpi-strip">
        <app-metric-card
          label="Total calls"
          [value]="summary()?.totalCalls ?? 0"
          format="number"
          dotColor="#0071E3"
        />
        <app-metric-card
          label="Total cost"
          [value]="summary()?.totalCostUsd ?? 0"
          format="currency"
          [colorByValue]="false"
          dotColor="#FF9500"
        />
        <app-metric-card
          label="Input tokens"
          [value]="summary()?.totalTokensInput ?? 0"
          format="number"
          dotColor="#5AC8FA"
        />
        <app-metric-card
          label="Output tokens"
          [value]="summary()?.totalTokensOutput ?? 0"
          format="number"
          dotColor="#AF52DE"
        />
        <app-metric-card
          label="Avg latency (ms)"
          [value]="summary()?.averageLatencyMs ?? 0"
          format="number"
          dotColor="#FFCC00"
        />
        <app-metric-card
          label="Failure rate"
          [value]="failureRate()"
          format="percent"
          [colorByValue]="true"
        />
      </div>

      <!-- ── Outcome breakdown ──────────────────────────────────────── -->
      @if (summary(); as s) {
        <div class="outcome-row">
          <div class="outcome-pill ok">
            <span class="oc-label">Ok</span><span class="oc-value">{{ s.okCount }}</span>
          </div>
          <div class="outcome-pill retry">
            <span class="oc-label">Retry</span><span class="oc-value">{{ s.retryCount }}</span>
          </div>
          <div class="outcome-pill failed">
            <span class="oc-label">Failed</span><span class="oc-value">{{ s.failedCount }}</span>
          </div>
          <div class="outcome-pill budget">
            <span class="oc-label">Budget exceeded</span
            ><span class="oc-value">{{ s.budgetExceededCount }}</span>
          </div>
          <div class="outcome-pill schema">
            <span class="oc-label">Schema fallback</span
            ><span class="oc-value">{{ s.schemaFallbackCount }}</span>
          </div>
        </div>
      }

      <!-- ── Charts row ─────────────────────────────────────────────── -->
      <div class="charts-grid">
        <app-chart-card
          title="Spend by provider"
          subtitle="USD over the window, top providers by cost"
          [options]="byProviderOptions()"
          height="280px"
        />
        <app-chart-card
          title="Spend by model"
          subtitle="USD over the window, top models by cost"
          [options]="byModelOptions()"
          height="280px"
        />
        <app-chart-card
          title="Spend by purpose"
          subtitle="Which engine feature is driving cost"
          [options]="byPurposeOptions()"
          height="280px"
        />
      </div>

      <!-- ── Ledger table ───────────────────────────────────────────── -->
      <section class="card">
        <header class="card-head">
          <h3>Invocation ledger</h3>
          <div class="filters">
            <input
              class="filter-input"
              type="text"
              placeholder="Provider"
              [(ngModel)]="filterProvider"
              (change)="resetAndReload()"
            />
            <input
              class="filter-input"
              type="text"
              placeholder="Model"
              [(ngModel)]="filterModel"
              (change)="resetAndReload()"
            />
            <input
              class="filter-input"
              type="text"
              placeholder="Purpose contains…"
              [(ngModel)]="filterPurpose"
              (change)="resetAndReload()"
            />
            <select class="filter-input" [(ngModel)]="filterOutcome" (change)="resetAndReload()">
              <option [ngValue]="null">All outcomes</option>
              <option ngValue="Ok">Ok</option>
              <option ngValue="Retry">Retry</option>
              <option ngValue="Failed">Failed</option>
              <option ngValue="BudgetExceeded">Budget exceeded</option>
              <option ngValue="SchemaFallback">Schema fallback</option>
            </select>
          </div>
        </header>
        @if (loading()) {
          <div class="note">Loading invocations…</div>
        } @else if (invocations().length === 0) {
          <div class="note">
            No invocations match the current filter. The engine logs every model call — if this is
            empty you may need to widen the time window or check whether the LLM features are
            enabled in <a routerLink="/llm/settings">Settings</a>.
          </div>
        } @else {
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Invoked at</th>
                  <th>Provider</th>
                  <th>Model</th>
                  <th>Purpose</th>
                  <th class="num">Tokens in</th>
                  <th class="num">Tokens out</th>
                  <th class="num">Latency</th>
                  <th class="num">Cost</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                @for (inv of invocations(); track inv.id) {
                  <tr
                    class="clickable"
                    [class.error]="isErrorOutcome(inv.outcome)"
                    [title]="inv.errorMessage ?? 'Click to see the full request and response'"
                    (click)="openDetail(inv)"
                  >
                    <td class="nowrap">{{ inv.invokedAt | date: 'MMM d HH:mm:ss' }}</td>
                    <td>{{ inv.provider }}</td>
                    <td class="mono">{{ inv.model }}</td>
                    <td class="mono purpose">{{ inv.purpose }}</td>
                    <td class="num mono">{{ inv.tokensInput | number: '1.0-0' }}</td>
                    <td class="num mono">{{ inv.tokensOutput | number: '1.0-0' }}</td>
                    <td class="num mono">{{ inv.latencyMs | number: '1.0-0' }}ms</td>
                    <td class="num mono">\${{ inv.costUsd | number: '1.4-4' }}</td>
                    <td>
                      <span class="outcome-tag" [class]="outcomeClass(inv.outcome)">{{
                        outcomeLabel(inv.outcome)
                      }}</span>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <footer class="pager">
            <span class="muted"
              >Showing {{ pageStart() }}–{{ pageEnd() }} of {{ totalRows() }}</span
            >
            <div class="pager-buttons">
              <button
                type="button"
                class="pager-btn"
                [disabled]="currentPage() === 1"
                (click)="goToPage(currentPage() - 1)"
              >
                ← Prev
              </button>
              <button
                type="button"
                class="pager-btn"
                [disabled]="pageEnd() >= totalRows()"
                (click)="goToPage(currentPage() + 1)"
              >
                Next →
              </button>
            </div>
          </footer>
        }
      </section>

      <!-- ── Invocation detail drawer ──────────────────────────────────
           Native <dialog> opened with showModal(): renders in the browser
           top layer above every stacking context. Fetched lazily when a
           row is clicked so the list query stays cheap. -->
      <dialog
        #detailDialog
        class="detail-dialog"
        aria-labelledby="detail-title"
        (close)="onDetailDialogClose()"
        (click)="onDetailBackdropClick($event)"
      >
        <article class="detail-card" (click)="$event.stopPropagation()">
          @if (detailLoading()) {
            <header class="detail-head">
              <h3 id="detail-title">Loading invocation…</h3>
              <button type="button" class="btn-close" (click)="closeDetail()">×</button>
            </header>
            <div class="detail-body">
              <div class="note">Fetching request and response…</div>
            </div>
          } @else if (detail(); as d) {
            <header class="detail-head">
              <div class="detail-title-wrap">
                <h3 id="detail-title">Invocation #{{ d.id }} · {{ d.purpose }}</h3>
                <div class="detail-meta">
                  <span class="tag mono">{{ d.provider }} / {{ d.model }}</span>
                  <span class="muted">·</span>
                  <span class="muted">{{ d.tokensInput | number }} in</span>
                  <span class="muted">·</span>
                  <span class="muted">{{ d.tokensOutput | number }} out</span>
                  <span class="muted">·</span>
                  <span class="muted">{{ d.latencyMs | number }}ms</span>
                  <span class="muted">·</span>
                  <span class="muted">\${{ d.costUsd | number: '1.4-4' }}</span>
                  <span class="muted">·</span>
                  <span class="outcome-tag" [class]="outcomeClass(d.outcome)">{{
                    outcomeLabel(d.outcome)
                  }}</span>
                  <span class="muted">·</span>
                  <span class="muted">{{ d.invokedAt | date: 'MMM d, HH:mm:ss' }}</span>
                </div>
                @if (d.errorMessage) {
                  <div class="detail-error">{{ d.errorMessage }}</div>
                }
              </div>
              <button type="button" class="btn-close" (click)="closeDetail()">×</button>
            </header>
            <div class="detail-body">
              <section class="pane">
                <header class="pane-head">
                  <h4>Request</h4>
                  <span class="muted mono">sha256 {{ d.promptHash | slice: 0 : 12 }}…</span>
                </header>
                @if (d.requestBody) {
                  <pre class="pane-text">{{ d.requestBody }}</pre>
                } @else {
                  <div class="note">No request body persisted for this row.</div>
                }
              </section>
              <section class="pane">
                <header class="pane-head">
                  <h4>Response</h4>
                </header>
                @if (d.responseBody) {
                  <pre class="pane-text">{{ d.responseBody }}</pre>
                } @else {
                  <div class="note">
                    No response body — call never returned (failed / budget exceeded).
                  </div>
                }
              </section>
            </div>
          } @else if (detailError()) {
            <header class="detail-head">
              <h3 id="detail-title">Couldn't load invocation</h3>
              <button type="button" class="btn-close" (click)="closeDetail()">×</button>
            </header>
            <div class="detail-body">
              <div class="note error">{{ detailError() }}</div>
            </div>
          }
        </article>
      </dialog>
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
      .window-select,
      .btn-refresh {
        height: 32px;
        padding: 0 var(--space-3);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        cursor: pointer;
      }
      .btn-refresh:hover {
        background: var(--bg-tertiary);
      }
      .kpi-strip {
        display: grid;
        grid-template-columns: repeat(6, 1fr);
        gap: var(--space-4);
      }
      .outcome-row {
        display: flex;
        gap: var(--space-2);
        flex-wrap: wrap;
      }
      .outcome-pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        font-size: var(--text-sm);
      }
      .oc-label {
        color: var(--text-tertiary);
        text-transform: uppercase;
        font-size: var(--text-xs);
        letter-spacing: 0.04em;
      }
      .oc-value {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-weight: var(--font-semibold);
      }
      .outcome-pill.ok {
        background: rgba(52, 199, 89, 0.08);
        border-color: rgba(52, 199, 89, 0.3);
      }
      .outcome-pill.retry {
        background: rgba(255, 204, 0, 0.08);
        border-color: rgba(255, 204, 0, 0.3);
      }
      .outcome-pill.failed,
      .outcome-pill.budget,
      .outcome-pill.schema {
        background: rgba(255, 59, 48, 0.08);
        border-color: rgba(255, 59, 48, 0.3);
      }
      .charts-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: var(--space-4);
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .card-head {
        padding: var(--space-3) var(--space-5);
        border-bottom: 1px solid var(--border);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
        flex-wrap: wrap;
      }
      .card-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .filters {
        display: flex;
        gap: var(--space-2);
        flex-wrap: wrap;
      }
      .filter-input {
        height: 30px;
        padding: 0 var(--space-2);
        font-size: var(--text-sm);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        min-width: 140px;
      }
      .table-wrap {
        max-height: 600px;
        overflow: auto;
      }
      .table {
        width: 100%;
        border-collapse: collapse;
      }
      .table th,
      .table td {
        padding: var(--space-2) var(--space-4);
        font-size: var(--text-sm);
        border-bottom: 1px solid var(--border);
      }
      .table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        position: sticky;
        top: 0;
      }
      .table th.num,
      .table td.num {
        text-align: right;
      }
      .table td.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
      }
      .table td.purpose {
        color: var(--text-secondary);
      }
      .table td.nowrap {
        white-space: nowrap;
      }
      .table tr.error {
        background: rgba(255, 59, 48, 0.04);
      }
      .outcome-tag {
        padding: 2px 8px;
        border-radius: 3px;
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .outcome-tag.ok {
        background: rgba(52, 199, 89, 0.14);
        color: #34c759;
      }
      .outcome-tag.retry {
        background: rgba(255, 204, 0, 0.14);
        color: #c79a00;
      }
      .outcome-tag.failed,
      .outcome-tag.budget,
      .outcome-tag.schema {
        background: rgba(255, 59, 48, 0.14);
        color: #ff3b30;
      }
      .pager {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: var(--space-3) var(--space-5);
        border-top: 1px solid var(--border);
        font-size: var(--text-sm);
      }
      .pager-buttons {
        display: flex;
        gap: var(--space-2);
      }
      .pager-btn {
        padding: 4px 10px;
        font-size: var(--text-sm);
        border-radius: 4px;
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-primary);
        cursor: pointer;
      }
      .pager-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .pager-btn:hover:not(:disabled) {
        background: var(--bg-tertiary);
      }
      .note {
        padding: var(--space-4) var(--space-5);
        font-size: var(--text-sm);
        color: var(--text-secondary);
        text-align: center;
      }
      .muted {
        color: var(--text-tertiary);
      }

      /* Ledger row click affordance — entire row is a button for the
         detail drawer. Subtle hover so it doesn't fight the table density. */
      tbody tr.clickable {
        cursor: pointer;
      }
      tbody tr.clickable:hover {
        background: var(--bg-tertiary);
      }

      /* ── Detail drawer ──────────────────────────────────────────────
         Native <dialog> in the browser top layer. Wide card so request
         and response panes can sit side-by-side on desktop. */
      dialog.detail-dialog {
        padding: 0;
        background: transparent;
        border: none;
        max-width: none;
        max-height: none;
        color: var(--text-primary);
      }
      dialog.detail-dialog:modal {
        position: fixed;
        inset: 0;
        margin: auto;
      }
      dialog.detail-dialog::backdrop {
        background: rgba(0, 0, 0, 0.55);
        backdrop-filter: blur(2px);
      }
      .detail-card {
        width: min(1180px, 94vw);
        max-height: 90vh;
        display: flex;
        flex-direction: column;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
        overflow: hidden;
      }
      .detail-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-5);
        border-bottom: 1px solid var(--border);
      }
      .detail-title-wrap h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .detail-meta {
        margin-top: 4px;
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: var(--space-2);
        font-size: var(--text-xs);
      }
      .detail-meta .tag {
        padding: 2px 6px;
        border-radius: 3px;
        background: var(--bg-tertiary);
        color: var(--text-tertiary);
      }
      .detail-error {
        margin-top: 6px;
        padding: 6px 8px;
        border-left: 3px solid #dc2626;
        background: rgba(220, 38, 38, 0.08);
        color: #dc2626;
        font-size: var(--text-xs);
        font-family: 'SF Mono', 'Fira Code', monospace;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .btn-close {
        background: transparent;
        border: 1px solid var(--border);
        width: 28px;
        height: 28px;
        border-radius: var(--radius-sm);
        font-size: 18px;
        line-height: 1;
        cursor: pointer;
        color: var(--text-secondary);
      }
      .btn-close:hover {
        color: var(--text-primary);
        background: var(--bg-tertiary);
      }
      .detail-body {
        flex: 1;
        overflow: auto;
        padding: var(--space-4) var(--space-5);
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-4);
      }
      .pane {
        display: flex;
        flex-direction: column;
        min-width: 0;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        overflow: hidden;
      }
      .pane-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        padding: var(--space-2) var(--space-3);
        border-bottom: 1px solid var(--border);
        background: var(--bg-secondary);
      }
      .pane-head h4 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .pane-text {
        margin: 0;
        padding: var(--space-3);
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
        line-height: 1.5;
        white-space: pre-wrap;
        word-break: break-word;
        overflow: auto;
        max-height: 70vh;
        color: var(--text-primary);
      }
      .note.error {
        color: #dc2626;
      }
      @media (max-width: 900px) {
        .detail-body {
          grid-template-columns: 1fr;
        }
      }

      @media (max-width: 1200px) {
        .kpi-strip {
          grid-template-columns: repeat(3, 1fr);
        }
        .charts-grid {
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
})
export class LlmInvocationsPageComponent implements OnInit {
  private readonly llm = inject(LlmService);
  // takeUntilDestroyed() needs an injection context — capture the
  // DestroyRef at field-init time so reload() / reloadList() (called
  // from method bodies, not the injection context) can still cancel
  // their subscriptions on teardown.
  private readonly destroyRef = inject(DestroyRef);

  // ── State ──────────────────────────────────────────────────────────
  readonly windowHours = signal(24);
  readonly summary = signal<LlmInvocationsSummaryDto | null>(null);
  readonly invocations = signal<LlmInvocationDto[]>([]);
  readonly totalRows = signal(0);
  readonly currentPage = signal(1);
  readonly pageSize = 50;
  readonly loading = signal(true);

  // ── Row-detail drawer ─────────────────────────────────────────────
  /** Non-null while the drawer should be open; flips the native dialog. */
  readonly detail = signal<LlmInvocationDetailDto | null>(null);
  readonly detailLoading = signal(false);
  readonly detailError = signal<string | null>(null);
  private readonly detailDialog = viewChild<ElementRef<HTMLDialogElement>>('detailDialog');

  constructor() {
    // Drive the native <dialog> off the drawer state. We open as soon as a
    // row is clicked (even before the body arrives) so the user gets an
    // immediate "loading…" frame instead of a blank delay.
    effect(() => {
      const open = this.detailLoading() || this.detail() !== null || this.detailError() !== null;
      const el = this.detailDialog()?.nativeElement;
      if (!el) return;
      if (open && !el.open && typeof el.showModal === 'function') {
        el.showModal();
      } else if (!open && el.open) {
        el.close();
      }
    });
  }

  // Filters
  filterProvider = '';
  filterModel = '';
  filterPurpose = '';
  filterOutcome: LlmOutcome | null = null;

  // ── Derived ────────────────────────────────────────────────────────
  readonly failureRate = computed(() => {
    const s = this.summary();
    if (!s || s.totalCalls === 0) return 0;
    return ((s.failedCount + s.budgetExceededCount) / s.totalCalls) * 100;
  });

  readonly pageStart = computed(() =>
    this.totalRows() === 0 ? 0 : (this.currentPage() - 1) * this.pageSize + 1,
  );
  readonly pageEnd = computed(() => Math.min(this.currentPage() * this.pageSize, this.totalRows()));

  // ── Chart options ──────────────────────────────────────────────────
  readonly byProviderOptions = computed<EChartsOption>(() =>
    this.barChart(this.summary()?.byProvider ?? [], '#0071E3'),
  );
  readonly byModelOptions = computed<EChartsOption>(() =>
    this.barChart(this.summary()?.byModel ?? [], '#AF52DE'),
  );
  readonly byPurposeOptions = computed<EChartsOption>(() =>
    this.barChart(this.summary()?.byPurpose ?? [], '#FF9500'),
  );

  // ── Lifecycle ──────────────────────────────────────────────────────
  ngOnInit(): void {
    this.reload();
  }

  reload(): void {
    this.reloadSummary();
    this.reloadList();
  }

  reloadSummary(): void {
    this.llm
      .invocationsSummary(this.windowHours(), 10)
      .pipe(
        catchError(() => of(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        this.summary.set(res?.data ?? null);
      });
  }

  resetAndReload(): void {
    this.currentPage.set(1);
    this.reloadList();
  }

  goToPage(page: number): void {
    this.currentPage.set(page);
    this.reloadList();
  }

  private reloadList(): void {
    this.loading.set(true);
    this.llm
      .listInvocations({
        currentPage: this.currentPage(),
        itemCountPerPage: this.pageSize,
        filter: {
          provider: this.filterProvider || null,
          model: this.filterModel || null,
          purpose: this.filterPurpose || null,
          outcome: this.filterOutcome,
        },
      })
      .pipe(
        catchError(() => of(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        this.loading.set(false);
        const data = res?.data;
        this.invocations.set(data?.data ?? []);
        this.totalRows.set(data?.pager?.totalItemCount ?? 0);
      });
  }

  // ── Detail drawer ──────────────────────────────────────────────────
  /**
   * Fetch the full request/response bodies for the clicked invocation and
   * open the drawer. The loading signal goes true synchronously so the
   * dialog opens immediately with a placeholder frame — better than a half-
   * second of nothing while the network round-trips.
   */
  openDetail(row: LlmInvocationDto): void {
    this.detail.set(null);
    this.detailError.set(null);
    this.detailLoading.set(true);
    this.llm
      .invocationDetail(row.id)
      .pipe(
        catchError((err) => {
          const msg = err?.error?.message ?? err?.message ?? String(err);
          this.detailError.set(`Failed to load invocation #${row.id}: ${msg}`);
          return of(null);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        this.detailLoading.set(false);
        if (res?.status && res.data) {
          this.detail.set(res.data);
        } else if (res && !this.detailError()) {
          this.detailError.set(res.message ?? 'Engine refused the detail request.');
        }
      });
  }

  closeDetail(): void {
    this.detail.set(null);
    this.detailError.set(null);
    this.detailLoading.set(false);
  }

  /** Native <dialog> backdrop click — target is the dialog itself. */
  onDetailBackdropClick(event: MouseEvent): void {
    if (event.target === this.detailDialog()?.nativeElement) {
      this.closeDetail();
    }
  }

  /** Escape key / programmatic close fires native (close); keep state in sync. */
  onDetailDialogClose(): void {
    this.detail.set(null);
    this.detailError.set(null);
    this.detailLoading.set(false);
  }

  // ── Helpers ────────────────────────────────────────────────────────
  outcomeLabel(o: LlmOutcome): string {
    return LlmOutcomeLabel[o] ?? String(o);
  }

  outcomeClass(o: LlmOutcome): string {
    switch (o) {
      case 'Ok':
        return 'ok';
      case 'Retry':
        return 'retry';
      case 'BudgetExceeded':
        return 'budget';
      case 'SchemaFallback':
        return 'schema';
      default:
        return 'failed';
    }
  }

  isErrorOutcome(o: LlmOutcome): boolean {
    return o === 'Failed' || o === 'BudgetExceeded' || o === 'SchemaFallback';
  }

  private barChart(
    buckets: { label: string; calls: number; costUsd: number }[],
    color: string,
  ): EChartsOption {
    if (!buckets.length) {
      return {
        grid: { top: 10, right: 20, bottom: 30, left: 50 },
        xAxis: { type: 'category', data: [] },
        yAxis: { type: 'value' },
        series: [],
      };
    }
    return {
      grid: { top: 20, right: 20, bottom: 60, left: 70 },
      tooltip: {
        trigger: 'axis',
        formatter: (params: any) => {
          const p = Array.isArray(params) ? params[0] : params;
          const b = buckets[p.dataIndex];
          return `${b.label}<br/>$${b.costUsd.toFixed(4)}<br/>${b.calls} calls`;
        },
      },
      xAxis: {
        type: 'category',
        data: buckets.map((b) => b.label),
        axisLabel: {
          fontSize: 10,
          color: '#6E6E73',
          rotate: buckets.length > 4 ? 25 : 0,
          interval: 0,
        },
      },
      yAxis: {
        type: 'value',
        axisLabel: {
          fontSize: 11,
          color: '#6E6E73',
          formatter: (v: number) => `$${v.toFixed(2)}`,
        },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          type: 'bar',
          data: buckets.map((b) => ({
            value: +b.costUsd.toFixed(4),
            itemStyle: { color, borderRadius: [4, 4, 0, 0] },
          })),
          barWidth: '55%',
        },
      ],
    };
  }
}
