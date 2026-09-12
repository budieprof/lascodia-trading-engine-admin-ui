import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Observable, catchError, forkJoin, map, of, switchMap } from 'rxjs';

import { AlgoEngineerService } from '@core/services/algo-engineer.service';
import { MarketDataService } from '@core/services/market-data.service';
import { NotificationService } from '@core/notifications/notification.service';
import { createPolledResource } from '@core/polling/polled-resource';
import type {
  AgentChangeSetDto,
  AlgoEngineerAuditRowDto,
  AlgoEngineerRunStateDto,
  AnalysisConversationSummaryDto,
  AnalysisMonitorDto,
  SpotAnalysisFollowUpTurnDto,
} from '@core/api/api.types';
import { isRunLive } from '@shared/components/engineer-chat/engineer-turns';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';

import { OpsApprovalsComponent } from './ops-approvals.component';
import { OpsRunningComponent } from './ops-running.component';
import {
  auditKindLabel,
  buildWorkOrder,
  formatAge,
  isEngineerConversation,
  runningWorkOrders,
  startOfLocalDay,
  summariseToday,
  todaysActivity,
  waitingForYou,
  watchingWorkOrders,
  type WorkOrderInput,
} from './agent-ops';

/** Engineer conversations to list. A work order is a heavyweight thing; 40 covers weeks of them. */
const CONVERSATION_PAGE = 40;
/** Sessions to fetch a run state for. Only ones the list says have a run. */
const RUN_LIMIT = 12;
/**
 * Sessions whose thread is read looking for open approval cards.
 *
 * The thread is the ONLY place a pending card lives, and reading one is not cheap, so this is
 * deliberately small and aimed where cards actually are: a run that is alive (a Working run can hold
 * an open card too — the host stops blocking on it after ~3 minutes but the card stays Pending), a
 * run that stopped reporting, and anything touched in the last few hours. A card left open on a work
 * order that finished days ago is not shown here; its conversation still has it.
 */
const APPROVAL_SCAN_LIMIT = 6;
const APPROVAL_SCAN_WINDOW_MS = 6 * 3_600_000;

interface OpsBoard {
  conversations: AnalysisConversationSummaryDto[];
  runs: Record<number, AlgoEngineerRunStateDto | null>;
  monitors: Record<number, AnalysisMonitorDto[]>;
  turns: Record<number, SpotAnalysisFollowUpTurnDto[]>;
  changeSets: AgentChangeSetDto[];
  /** Null when the audit endpoint is not deployed (or failed) — the page then degrades, silently. */
  audit: AlgoEngineerAuditRowDto[] | null;
}

const EMPTY_BOARD: OpsBoard = {
  conversations: [],
  runs: {},
  monitors: {},
  turns: {},
  changeSets: [],
  audit: null,
};

/** `forkJoin([])` completes without emitting, which would strand the whole board. */
function collect<T>(sources: Observable<T>[]): Observable<T[]> {
  return sources.length ? forkJoin(sources) : of([]);
}

/**
 * What the algo-engineer agent is doing, across every work order.
 *
 * Until this page, an operator could see one conversation at a time and a scorecard of changes that
 * had already shipped — nothing in between. The four rows here are the four questions that get asked
 * about an agent that runs for hours: is anything blocked on me, what is running, what is it waiting
 * for, and what did today cost.
 *
 * "Waiting for you" comes first deliberately. An unanswered approval does not fail or retry: the work
 * order simply sits there, indistinguishable from slow work, until someone opens the thread.
 *
 * Everything is read-only except Stop — approving happens in the conversation, where the reasoning
 * that led to the request is above the buttons.
 */
@Component({
  selector: 'app-algo-engineer-operations-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    RouterLink,
    PageHeaderComponent,
    MetricCardComponent,
    CardSkeletonComponent,
    EmptyStateComponent,
    ErrorStateComponent,
    OpsApprovalsComponent,
    OpsRunningComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Algo-Engineer — Operations"
        subtitle="Every work order the agent is running, what it is blocked on, and what it changed today"
      >
        <span class="muted">
          @if (updatedLabel(); as label) {
            {{ label }}
          }
        </span>
        <button
          type="button"
          class="btn btn-secondary"
          (click)="resource.refresh()"
          [disabled]="resource.loading()"
        >
          Refresh
        </button>
      </app-page-header>

      @if (firstLoad()) {
        <app-card-skeleton [lines]="8" />
      } @else if (fatal()) {
        <app-error-state
          title="Could not read the agent fleet"
          message="The conversations endpoint did not answer. Everything on this page is derived from it."
          (retry)="resource.refresh()"
        />
      } @else {
        <!-- ── Waiting for you ─────────────────────────────────────────────── -->
        <section class="block" [class.urgent]="approvals().length > 0">
          <header class="block-head">
            <h2>Waiting for you</h2>
            @if (approvals().length > 0) {
              <span class="count urgent">{{ approvals().length }}</span>
            }
            <span class="hint">Approvals nobody has answered — each one holds its work order</span>
          </header>
          @if (approvals().length === 0) {
            <p class="none">Nothing is waiting on you.</p>
          } @else {
            <app-ops-approvals [approvals]="approvals()" />
          }
        </section>

        <!-- ── Running now ─────────────────────────────────────────────────── -->
        <section class="block">
          <header class="block-head">
            <h2>Running now</h2>
            @if (running().length > 0) {
              <span class="count">{{ running().length }}</span>
            }
            <span class="hint">Working, waiting or watching — with what each has spent</span>
          </header>
          @if (running().length === 0) {
            <p class="none">
              No work order is running. Start one from Conversations → New analysis.
            </p>
          } @else {
            <app-ops-running
              [rows]="running()"
              [stopping]="stopping()"
              [nowMs]="now()"
              (stop)="stopRun($event)"
            />
          }
        </section>

        <!-- ── Watching ────────────────────────────────────────────────────── -->
        <section class="block">
          <header class="block-head">
            <h2>Watching</h2>
            @if (watchTotal() > 0) {
              <span class="count">{{ watchTotal() }}</span>
            }
            <span class="hint">Armed monitors and host-side watches, and when they next look</span>
          </header>
          @if (watching().length === 0) {
            <p class="none">Nothing armed.</p>
          } @else {
            <ul class="watch-orders">
              @for (r of watching(); track r.sessionId) {
                <li>
                  <a
                    class="wo"
                    [routerLink]="['/conversations']"
                    [queryParams]="{ conversation: r.sessionId }"
                    [title]="r.title"
                    >{{ r.title }}</a
                  >
                  <ul class="watches">
                    @for (w of r.watches; track w.key) {
                      <li class="watch">
                        <span class="src" [attr.data-src]="w.source">{{
                          w.source === 'monitor' ? 'monitor' : 'watch'
                        }}</span>
                        <span class="what" [title]="w.what">{{ w.what }}</span>
                        <span class="when">
                          @if (w.nextCheckAtUtc) {
                            next {{ w.nextCheckAtUtc | date: 'HH:mm' }}
                          } @else if (w.note) {
                            {{ w.note }}
                          }
                        </span>
                        @if (w.monitorId) {
                          <!-- focus= is the cockpit's own deep link: it opens this monitor, not
                               just the page it is somewhere on. -->
                          <a
                            class="link"
                            [routerLink]="['/analysis-monitors']"
                            [queryParams]="{ focus: w.monitorId }"
                            >cockpit →</a
                          >
                        }
                      </li>
                    }
                  </ul>
                </li>
              }
            </ul>
          }
        </section>

        <!-- ── Today ───────────────────────────────────────────────────────── -->
        <section class="block">
          <header class="block-head">
            <h2>Today</h2>
            <span class="hint">
              @if (today().fromAudit) {
                From the agent's audit timeline
              } @else {
                Derived from change sets and run state — the audit timeline is not available
              }
            </span>
          </header>
          <div class="kpis">
            <app-metric-card
              label="Live changes"
              [value]="today().liveChanges"
              format="number"
              [dotColor]="today().liveChanges > 0 ? '#0071E3' : '#8E8E93'"
            />
            <app-metric-card label="Spend" [value]="today().spendUsd" format="currency" />
            <app-metric-card
              label="Work orders started"
              [value]="today().started"
              format="number"
            />
            <app-metric-card
              label="Work orders finished"
              [value]="today().finished"
              format="number"
            />
          </div>
          @if (activity().length > 0) {
            <ul class="feed">
              @for (a of activity(); track $index) {
                <li>
                  <time [attr.datetime]="a.atUtc">{{ a.atUtc | date: 'HH:mm' }}</time>
                  <span class="kind" [attr.data-kind]="a.kind">{{ kindLabel(a.kind) }}</span>
                  <a
                    class="summary"
                    [routerLink]="['/conversations']"
                    [queryParams]="{ conversation: a.sessionLlmInvocationId }"
                    [title]="a.detail || a.summary"
                    >{{ a.summary }}</a
                  >
                  @if (a.ref) {
                    <code>{{ a.ref }}</code>
                  }
                  <span class="actor">{{ a.actor }}</span>
                </li>
              }
            </ul>
          } @else if (today().fromAudit) {
            <p class="none">Nothing on the timeline today.</p>
          }
        </section>

        @if (orders().length === 0) {
          <app-empty-state
            title="No work orders yet"
            description="Launch one from Conversations → New analysis → Algo-engineer work order."
          />
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
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
        margin-right: var(--space-2);
      }
      .btn {
        height: 36px;
        padding: 0 var(--space-4);
        border-radius: var(--radius-full);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        cursor: pointer;
        font-family: inherit;
      }
      .btn-secondary {
        background: transparent;
        color: var(--text-primary);
        border: 1px solid var(--border);
      }
      .btn-secondary:hover:not(:disabled) {
        background: var(--bg-tertiary);
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .block {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        padding: var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        background: var(--bg-primary);
      }
      /* The one section that changes the page's temperature when it is not empty. */
      .block.urgent {
        border-color: color-mix(in srgb, var(--warning) 45%, var(--border));
      }
      .block-head {
        display: flex;
        align-items: baseline;
        flex-wrap: wrap;
        gap: var(--space-2);
      }
      h2 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .count {
        padding: 1px 8px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        background: var(--bg-tertiary);
      }
      .count.urgent {
        color: #fff;
        background: var(--warning);
      }
      .hint {
        margin-left: auto;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .none {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-tertiary);
      }
      .kpis {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: var(--space-2);
        align-items: start;
      }
      @media (max-width: 900px) {
        .kpis {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      /* ── Watching ── */
      .watch-orders,
      .watches,
      .feed {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .watch-orders > li {
        padding: 6px 0;
        border-top: 1px solid var(--border);
      }
      .watch-orders > li:first-child {
        border-top: none;
      }
      .wo {
        display: block;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        color: var(--text-primary);
        text-decoration: none;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .wo:hover {
        color: var(--accent);
        text-decoration: underline;
      }
      .watches {
        display: flex;
        flex-direction: column;
        gap: 2px;
        margin-top: 3px;
      }
      .watch {
        display: flex;
        align-items: baseline;
        gap: var(--space-2);
        font-size: var(--text-xs);
        min-width: 0;
      }
      .src {
        flex: none;
        padding: 0 6px;
        border-radius: var(--radius-full);
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary);
        background: var(--bg-tertiary);
      }
      .src[data-src='monitor'] {
        color: var(--profit);
        background: color-mix(in srgb, var(--profit) 14%, transparent);
      }
      .what {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--text-secondary);
      }
      .when {
        margin-left: auto;
        flex: none;
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
      }
      .link {
        flex: none;
        color: var(--accent);
        text-decoration: none;
      }
      .link:hover {
        text-decoration: underline;
      }
      /* ── Today feed ── */
      .feed > li {
        display: flex;
        align-items: baseline;
        gap: var(--space-2);
        padding: 3px 0;
        border-top: 1px solid var(--border);
        font-size: var(--text-xs);
        min-width: 0;
      }
      .feed time {
        flex: none;
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
      }
      .kind {
        flex: none;
        padding: 0 6px;
        border-radius: var(--radius-full);
        font-size: 10px;
        color: var(--text-secondary);
        background: var(--bg-tertiary);
        white-space: nowrap;
      }
      .kind[data-kind='config_change'],
      .kind[data-kind='change_set'],
      .kind[data-kind='model_lifecycle'] {
        color: var(--accent);
        background: color-mix(in srgb, var(--accent) 13%, transparent);
      }
      .summary {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--text-primary);
        text-decoration: none;
      }
      .summary:hover {
        text-decoration: underline;
      }
      .feed code {
        flex: none;
        font-family: var(--font-mono, monospace);
        font-size: 10px;
        padding: 0 5px;
        border-radius: 4px;
        background: var(--bg-tertiary);
      }
      .actor {
        margin-left: auto;
        flex: none;
        color: var(--text-tertiary);
      }
    `,
  ],
})
export class AlgoEngineerOperationsPageComponent {
  private readonly algoEngineer = inject(AlgoEngineerService);
  private readonly marketData = inject(MarketDataService);
  private readonly notify = inject(NotificationService);

  /**
   * One clock for the whole page, ticking every 15s.
   *
   * Ages and elapsed times are computed from it, so they stay honest between refetches without
   * every card holding an interval — and at 15s the numbers this page shows (minutes, hours) never
   * look stale.
   */
  protected readonly now = signal(Date.now());

  protected readonly stopping = signal<number | null>(null);

  protected readonly resource = createPolledResource<OpsBoard>(() => this.loadBoard(), {
    intervalMs: 20_000,
    refreshOn: ['analysisConversationChanged', 'analysisMonitorChanged', 'analysisMonitorFired'],
    refreshDebounceMs: 800,
  });

  private readonly board = computed(() => this.resource.value() ?? EMPTY_BOARD);

  protected readonly firstLoad = computed(
    () => this.resource.loading() && this.board().conversations.length === 0,
  );
  /** The conversations read is the page's spine; everything else degrades on its own. */
  protected readonly fatal = computed(
    () => !!this.resource.error() && this.board().conversations.length === 0,
  );

  protected readonly orders = computed(() => {
    const b = this.board();
    const nowMs = this.now();
    return b.conversations.map((c) =>
      buildWorkOrder(
        {
          conversation: c,
          run: b.runs[c.llmInvocationId] ?? null,
          monitors: b.monitors[c.llmInvocationId] ?? [],
          turns: b.turns[c.llmInvocationId] ?? [],
        } satisfies WorkOrderInput,
        nowMs,
      ),
    );
  });

  protected readonly approvals = computed(() => waitingForYou(this.orders()));
  protected readonly running = computed(() => runningWorkOrders(this.orders()));
  protected readonly watching = computed(() => watchingWorkOrders(this.orders()));
  protected readonly watchTotal = computed(() =>
    this.watching().reduce((n, r) => n + r.watches.length, 0),
  );

  private readonly dayStartMs = computed(() => startOfLocalDay(this.now()));

  protected readonly today = computed(() => {
    const b = this.board();
    return summariseToday({
      audit: b.audit,
      runs: Object.values(b.runs).filter((r): r is AlgoEngineerRunStateDto => r !== null),
      changeSets: b.changeSets,
      dayStartMs: this.dayStartMs(),
    });
  });

  protected readonly activity = computed(() =>
    todaysActivity(this.board().audit, this.dayStartMs()),
  );

  protected readonly kindLabel = auditKindLabel;

  /** "updated 12s ago" — from the page's own clock, so it ages between refetches. */
  protected readonly updatedLabel = computed(() => {
    const t = this.resource.lastUpdated();
    return t === null ? '' : `updated ${formatAge(this.now() - t)} ago`;
  });

  constructor() {
    effect((onCleanup) => {
      const h = setInterval(() => this.now.set(Date.now()), 15_000);
      onCleanup(() => clearInterval(h));
    });
  }

  /**
   * One board from five reads.
   *
   * The conversation list is the spine — it names the work orders and carries their run status. Every
   * other read is per-session and best-effort: a failure resolves to nothing for that session rather
   * than failing the page, because a run-state read that 404s must not hide the approval that is
   * waiting three cards below it.
   */
  private loadBoard(): Observable<OpsBoard> {
    const nowMs = Date.now();
    const from = new Date(startOfLocalDay(nowMs)).toISOString();
    const to = new Date(nowMs).toISOString();

    // Every read here is silent: the page polls, so an engine hiccup would otherwise stack one
    // toast per endpoint per cycle over a page that already says, in place, what it could not read.
    return this.marketData
      .listAnalysisConversations({ kind: 'Engineer' }, 1, CONVERSATION_PAGE, { silent: true })
      .pipe(
        map((res) => (res?.data?.items ?? []).filter(isEngineerConversation)),
        switchMap((conversations) => {
          const withRun = conversations
            .filter((c) => (c.runStatus ?? '').trim().length > 0)
            .slice(0, RUN_LIMIT);
          const withMonitors = conversations.filter((c) => (c.activeMonitorCount ?? 0) > 0);
          const toScan = conversations
            .filter(
              (c) =>
                isRunLive(c.runStatus) ||
                (c.runStatus ?? '').toLowerCase() === 'stale' ||
                nowMs - Date.parse(c.lastActivityAtUtc) < APPROVAL_SCAN_WINDOW_MS,
            )
            .slice(0, APPROVAL_SCAN_LIMIT);

          return forkJoin({
            conversations: of(conversations),
            runs: collect(
              withRun.map((c) =>
                this.algoEngineer.getRunState(c.llmInvocationId).pipe(
                  map((r) => [c.llmInvocationId, r?.data ?? null] as const),
                  catchError(() => of([c.llmInvocationId, null] as const)),
                ),
              ),
            ).pipe(map((pairs) => Object.fromEntries(pairs))),
            monitors: collect(
              withMonitors.map((c) =>
                this.marketData.getAnalysisMonitors(c.llmInvocationId, true, { silent: true }).pipe(
                  map((r) => [c.llmInvocationId, r?.data ?? []] as const),
                  catchError(() => of([c.llmInvocationId, [] as AnalysisMonitorDto[]] as const)),
                ),
              ),
            ).pipe(map((pairs) => Object.fromEntries(pairs))),
            turns: collect(
              toScan.map((c) =>
                this.marketData.getAnalysisFollowUps(c.llmInvocationId, { silent: true }).pipe(
                  map((r) => [c.llmInvocationId, r?.data ?? []] as const),
                  catchError(() =>
                    of([c.llmInvocationId, [] as SpotAnalysisFollowUpTurnDto[]] as const),
                  ),
                ),
              ),
            ).pipe(map((pairs) => Object.fromEntries(pairs))),
            changeSets: this.algoEngineer.getChangeSets(null, 100).pipe(
              map((r) => r?.data ?? []),
              catchError(() => of<AgentChangeSetDto[]>([])),
            ),
            // Null, not [] — "the timeline is not available" is a different answer from "nothing
            // happened today", and the Today row says which one it is showing.
            audit: this.algoEngineer.getAudit(from, to, 200).pipe(
              map((r) => (r?.status ? (r.data ?? []) : null)),
              catchError(() => of(null)),
            ),
          });
        }),
      );
  }

  protected stopRun(sessionId: number): void {
    if (this.stopping() !== null) return;
    this.stopping.set(sessionId);
    this.algoEngineer.stopRun(sessionId).subscribe({
      next: (res) => {
        this.stopping.set(null);
        const d = res?.data;
        if (res?.status && d?.stopped) {
          this.notify.success(d.message || 'Stop requested — the agent halts at its next step.');
        } else {
          this.notify.warning(d?.message || res?.message || 'Could not stop the run.');
        }
        this.resource.refresh();
      },
      error: (err: { error?: { message?: string }; message?: string }) => {
        this.stopping.set(null);
        this.notify.error(
          err?.error?.message ?? err?.message ?? 'Stop failed. Is the engine reachable?',
        );
      },
    });
  }
}
