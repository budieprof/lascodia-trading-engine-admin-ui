import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { catchError, finalize, map, of, type Observable } from 'rxjs';

import { AuthService } from '@core/auth/auth.service';
import type { ResponseData } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { ScriptStrategyService } from '../api/script-strategy.service';
import type { ScriptParityReconcile, ScriptParitySession } from '../api/scripting-api.types';
import { describeFailure, isOk } from '../shared/api-error';
import { ANALYST_PERMISSION } from '../shared/permissions';
import { NA, formatDateTime } from '../report/report-format';
import {
  driftView,
  isoMs,
  liveMetricRows,
  metricText,
  normalizeParityReconcile,
  normalizeParitySessions,
  normalizeParitySummary,
  pairView,
  pricePrecision,
  reconcileDone,
  reconcileStatusText,
  rText,
  sessionLabel,
  slippageText,
  worseShareText,
} from './parity.model';

/** The summary refreshes itself this often; it is a database aggregate, not a live feed. */
const SUMMARY_POLL_MS = 60_000;

/** A queued reconcile is polled this often… */
const RECONCILE_POLL_MS = 5_000;

/** …for at most this long (a deep backtest can take a while; Refresh looks again). */
export const RECONCILE_POLL_LIMIT_MS = 30 * 60_000;

/** The summary windows offered, in days (the engine's default is 30). */
export const PARITY_WINDOWS = [7, 30, 90] as const;

/** One poll of a reconcile, tagged with the run it asked about (a refusal carries no run id). */
interface ReconcileFetch {
  runId: number;
  envelope: ResponseData<ScriptParityReconcile> | null;
  /** The request failed outright (no envelope): the engine could not be reached, a 403, … */
  failure: string | null;
}

/**
 * The Live tab's parity panel (BT-I3 / PE-I2): how this script strategy's live fills compare with
 * its emulator — signed slippage on entries and exits (pips, longs and shorts apart), latency, and
 * the R the accounts realised against the R the emulator expected — with the drift alarm's own
 * verdict; and the Reconcile action, which backtests a recorded session's span on exactly the script
 * it ran and matches the trades: matched, taken only by the backtest, taken only by the session.
 *
 * Reads `GET strategy/{id}/parity/summary` and `…/sessions`; queues with `POST …/reconcile` (the
 * analyst permission — it runs a backtest) and polls `GET …/reconcile/{runId}` until the backtest
 * finishes. Nothing here touches an order.
 */
@Component({
  selector: 'app-script-parity-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="parity" aria-labelledby="parity-title">
      <div class="block-head">
        <h4 class="block-title" id="parity-title">Live vs emulator vs backtest</h4>
        <div class="controls">
          <label class="pick">
            <span>Window</span>
            <select (change)="setDays($any($event.target).value)">
              @for (d of windows; track d) {
                <option [value]="d" [selected]="d === days()">Last {{ d }} days</option>
              }
            </select>
          </label>
          <button
            type="button"
            class="btn"
            (click)="refresh()"
            [disabled]="summaryResource.refreshing()"
          >
            {{ summaryResource.refreshing() ? 'Refreshing…' : 'Refresh' }}
          </button>
        </div>
      </div>
      <p class="hint">
        Every fill of this strategy's live and paper sessions is recorded as the emulator made it.
        Live fills are compared with what the bound accounts got. Slippage is in pips, and every
        figure says whether it was worse or better for the strategy.
      </p>

      @if (summaryResource.loading()) {
        <p class="muted" role="status">Loading the parity summary…</p>
      } @else if (summaryError() && !summary()) {
        <div class="error" role="alert">
          <span>{{ summaryError() }}</span>
          <button type="button" class="btn" (click)="refresh()">Retry</button>
        </div>
      } @else if (summary(); as s) {
        @if (summaryError()) {
          <p class="warn" role="status">
            The last refresh failed ({{ summaryError() }}); showing the previous summary.
          </p>
        }
        @if (drift(); as d) {
          <div class="drift" [attr.data-tone]="d.tone" role="status">
            <strong>{{ d.title }}</strong>
            @for (line of d.lines; track $index) {
              <span class="drift-line">{{ line }}</span>
            }
          </div>
        }

        <dl class="counts">
          <div>
            <dt>Emulator trades</dt>
            <dd>
              {{ s.trades.total }}
              <span class="sub">({{ s.trades.live }} live · {{ s.trades.paper }} paper)</span>
            </dd>
          </div>
          <div>
            <dt>Sent to the accounts</dt>
            <dd>{{ s.live.tradesSent }}</dd>
          </div>
          <div>
            <dt>Filled by an account</dt>
            <dd>{{ s.live.tradesFilled }}</dd>
          </div>
          <div>
            <dt>Sent but never filled</dt>
            <dd [class.loss]="s.live.tradesMissed > 0">{{ s.live.tradesMissed }}</dd>
          </div>
          <div>
            <dt>Not sent</dt>
            <dd>{{ s.trades.notSent + s.trades.paperBlocked + s.trades.failed }}</dd>
          </div>
          <div>
            <dt>Opened while catching up</dt>
            <dd>{{ s.trades.catchUp }}</dd>
          </div>
        </dl>

        @if (s.live.accountFills > 0) {
          <div
            class="table-wrap"
            tabindex="0"
            role="region"
            aria-label="Live fills against the emulator"
          >
            <table class="stats">
              <thead>
                <tr>
                  <th scope="col">Live fills against the emulator</th>
                  <th scope="col">Trades</th>
                  <th scope="col">Mean</th>
                  <th scope="col">Median</th>
                  <th scope="col">90th percentile</th>
                  <th scope="col">Worse in</th>
                </tr>
              </thead>
              <tbody>
                @for (row of metricRows(); track $index) {
                  <tr [class.sub-row]="row.label.startsWith('·')">
                    <th scope="row" [title]="row.hint">{{ row.label }}</th>
                    <td>{{ row.dist.n }}</td>
                    <td>{{ metric(row.kind, row.dist.mean) }}</td>
                    <td>{{ metric(row.kind, row.dist.median) }}</td>
                    <td>{{ metric(row.kind, row.dist.p90) }}</td>
                    <td>{{ worseShare(row.kind, row.dist) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else if (s.live.emulatorTrades > 0) {
          <p class="muted">No account has filled one of this window's live trades yet.</p>
        }
        @if (s.paper.trades > 0) {
          <p class="line">
            Paper: {{ s.paper.trades }} trade{{ s.paper.trades === 1 ? '' : 's' }} ({{
              s.paper.closed
            }}
            closed){{
              s.paper.expectedR.n > 0 ? ', ' + r(s.paper.expectedR.mean) + ' per trade' : ''
            }}. Paper fills are the emulator's own, so they have no slippage to show — reconcile a
            paper session to compare it with a backtest.
          </p>
        }
      }

      <div class="reconcile">
        <h5 class="sub-title">Reconcile a session with a backtest</h5>
        <p class="hint">
          Backtests the session's span on exactly the script it ran — from its warm-up, at the
          engine's execution costs — and matches the trades. Each match shows how far the session
          and each account filled from the backtest, and the difference in R.
        </p>
        @if (sessionsError()) {
          <p class="warn" role="status">{{ sessionsError() }}</p>
        } @else if (sessionsLoaded() && sessions().length === 0) {
          <p class="muted">
            No live or paper session has been recorded yet. The record starts with the first session
            after this release.
          </p>
        } @else if (sessions().length > 0) {
          <div class="controls">
            <label class="pick">
              <span>Session</span>
              <select (change)="selectSession($any($event.target).value)">
                @for (s of sessions(); track s.id) {
                  <option [value]="s.id" [selected]="s.id === selectedSessionId()">
                    {{ label(s) }}
                  </option>
                }
              </select>
            </label>
            <button
              type="button"
              class="btn primary"
              (click)="queueReconcile()"
              [disabled]="!canReconcile() || queueing() || polling()"
            >
              {{
                queueing() ? 'Queueing…' : polling() ? 'Reconciling…' : 'Reconcile with a backtest'
              }}
            </button>
          </div>
          @if (!canReconcile()) {
            <p class="hint">
              A reconcile runs a backtest, so queueing one needs the analyst permission; you can
              still read finished ones.
            </p>
          }
        }
        @if (queueNote()) {
          <p class="line" role="status">{{ queueNote() }}</p>
        }
        @if (queueError()) {
          <p class="error-text" role="alert">{{ queueError() }}</p>
        }
        @if (reconcileLoadError()) {
          <p class="error-text" role="alert">{{ reconcileLoadError() }}</p>
        }

        @if (reconcile(); as rc) {
          <p class="line" [attr.data-status]="rc.status" role="status">
            {{ reconcileStatus() }}
            @if (pollTimedOut()) {
              Still not finished after 30 minutes — Refresh looks again.
            }
          </p>
          @if (rc.summary; as sum) {
            <p class="line">
              Compared from {{ utc(rc.compareFromUtc) }} to {{ utc(rc.compareToUtc) }} UTC; the
              backtest started at {{ utc(rc.fromUtc) }} to warm up. Entries match when they are at
              most {{ rc.matchToleranceBars }} bar{{
                rc.matchToleranceBars === 1 ? '' : 's'
              }}
              apart.
              @if (!rc.session.isCurrentRevision) {
                <span class="warn-text">The session ran an earlier version of the script.</span>
              }
            </p>
            <dl class="counts">
              <div>
                <dt>Matched</dt>
                <dd>{{ sum.matched }}</dd>
              </div>
              <div>
                <dt>Backtest only</dt>
                <dd [class.loss]="sum.missing > 0">{{ sum.missing }}</dd>
              </div>
              <div>
                <dt>Session only</dt>
                <dd [class.loss]="sum.extra > 0">{{ sum.extra }}</dd>
              </div>
              <div>
                <dt>Session vs backtest (mean)</dt>
                <dd class="small">
                  @if (sum.matched > 0) {
                    entries {{ slip(sum.entrySlippagePips.mean) }}, exits
                    {{ slip(sum.exitSlippagePips.mean) }}, {{ r(sum.rDifference.mean) }} per trade
                  } @else {
                    no matched trade
                  }
                </dd>
              </div>
              <div>
                <dt>Accounts vs backtest (mean)</dt>
                <dd class="small">
                  @if (sum.accountEntrySlippagePips.n > 0) {
                    entries {{ slip(sum.accountEntrySlippagePips.mean) }}, exits
                    {{ slip(sum.accountExitSlippagePips.mean) }},
                    {{ r(sum.accountRDifference.mean) }} per trade
                  } @else {
                    no account fill to compare
                  }
                </dd>
              </div>
            </dl>
            @if (pairs().length > 0) {
              <div class="table-wrap" tabindex="0" role="region" aria-label="Reconciled trades">
                <table class="pairs">
                  <thead>
                    <tr>
                      <th scope="col">Entry (UTC)</th>
                      <th scope="col">Trade</th>
                      <th scope="col">Backtest</th>
                      <th scope="col">Session</th>
                      <th scope="col">Entry</th>
                      <th scope="col">Exit</th>
                      <th scope="col">R difference</th>
                      <th scope="col">Accounts</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (p of pairs(); track $index) {
                      <tr [attr.data-status]="p.status">
                        <td class="nowrap">{{ p.timeText }}</td>
                        <td class="nowrap">
                          <span class="pair-status" [attr.data-status]="p.status">{{
                            p.statusLabel
                          }}</span>
                          {{ p.direction }}
                        </td>
                        <td class="nowrap">{{ p.backtestText }}</td>
                        <td class="nowrap">{{ p.sessionText }}</td>
                        <td class="nowrap">{{ p.entryText }}</td>
                        <td class="nowrap">{{ p.exitText }}</td>
                        <td class="nowrap">{{ p.rText }}</td>
                        <td class="detail">
                          @for (a of p.accounts; track $index) {
                            <span class="stacked">{{ a }}</span>
                          }
                          @if (p.note) {
                            <span class="stacked note">{{ p.note }}</span>
                          }
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            } @else {
              <p class="muted">Neither the backtest nor the session took a trade in this span.</p>
            }
            @if (rc.notes.length > 0) {
              <details class="fold">
                <summary>What the comparison cannot account for</summary>
                <ul class="notes">
                  @for (n of rc.notes; track $index) {
                    <li>{{ n }}</li>
                  }
                </ul>
              </details>
            }
          }
        }
      </div>
    </section>
  `,
  styles: [
    `
      .parity,
      .reconcile {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .block-head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-2);
      }
      .controls {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-2);
      }
      .block-title {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .sub-title {
        margin: var(--space-3) 0 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .pick {
        display: inline-flex;
        align-items: center;
        gap: var(--space-2);
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .pick select {
        height: 32px;
        max-width: min(640px, 78vw);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-primary);
        font: inherit;
        font-size: var(--text-sm);
      }
      .hint {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .muted,
      .line {
        margin: 0;
        color: var(--text-secondary);
        font-size: var(--text-sm);
      }
      .line[data-status='failed'],
      .error-text {
        margin: 0;
        color: var(--loss);
        font-size: var(--text-sm);
      }
      .drift {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        font-size: var(--text-sm);
      }
      .drift[data-tone='success'] {
        border-color: rgba(52, 199, 89, 0.45);
        background: rgba(52, 199, 89, 0.08);
      }
      .drift[data-tone='error'] {
        border-color: rgba(255, 59, 48, 0.45);
        background: rgba(255, 59, 48, 0.08);
      }
      .drift-line {
        color: var(--text-secondary);
      }
      .counts {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
        gap: var(--space-2);
        margin: 0;
      }
      .counts div {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: var(--space-2) var(--space-3);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }
      .counts dt {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .counts dd {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .counts dd.small {
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
      }
      .sub {
        color: var(--text-secondary);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
      }
      .table-wrap {
        overflow-x: auto;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }
      .table-wrap:focus-visible,
      .btn:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      th,
      td {
        padding: var(--space-2) var(--space-3);
        border-bottom: 1px solid var(--border);
        text-align: left;
        vertical-align: top;
      }
      thead th {
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary);
        background: var(--bg-tertiary);
        white-space: nowrap;
      }
      table.stats th[scope='row'] {
        font-weight: var(--font-medium);
        color: var(--text-secondary);
        cursor: help;
        white-space: nowrap;
      }
      tr.sub-row th[scope='row'] {
        padding-left: var(--space-5);
      }
      .pair-status {
        display: inline-block;
        padding: 1px 8px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .pair-status[data-status='matched'] {
        background: rgba(52, 199, 89, 0.14);
        color: #248a3d;
      }
      .pair-status[data-status='missing'],
      .pair-status[data-status='extra'] {
        background: rgba(255, 149, 0, 0.14);
        color: #b25e00;
      }
      .detail {
        min-width: 260px;
      }
      .stacked {
        display: block;
      }
      .note {
        color: var(--text-secondary);
        font-size: var(--text-xs);
      }
      .nowrap {
        white-space: nowrap;
      }
      .warn-text {
        color: #b25000;
      }
      .loss {
        color: var(--loss);
      }
      .warn {
        margin: 0;
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-sm);
        background: rgba(255, 149, 0, 0.1);
        font-size: var(--text-sm);
      }
      .error {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-3);
        border-radius: var(--radius-sm);
        background: rgba(255, 59, 48, 0.08);
        color: var(--loss);
        font-size: var(--text-sm);
      }
      .fold summary {
        cursor: pointer;
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .notes {
        margin: var(--space-2) 0 0;
        padding-left: var(--space-5);
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .btn {
        height: 32px;
        padding: 0 var(--space-4);
        border-radius: var(--radius-full);
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-primary);
        font: inherit;
        font-size: var(--text-sm);
        cursor: pointer;
      }
      .btn.primary {
        border-color: var(--accent);
        color: var(--accent);
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: default;
      }
    `,
  ],
})
export class ScriptParityPanelComponent {
  private readonly api = inject(ScriptStrategyService);
  private readonly auth = inject(AuthService);

  readonly strategyId = input.required<number>();
  /** The bound accounts' names by account id, for the reconcile's account lines. */
  readonly accountNames = input<ReadonlyMap<string, string>>(new Map());

  readonly windows = PARITY_WINDOWS;
  readonly days = signal<number>(30);

  // ── the rolling summary ──────────────────────────────────────────────────────

  readonly summaryResource = createPolledResource(
    () => this.api.getParitySummary(this.strategyId(), this.days()),
    { intervalMs: SUMMARY_POLL_MS, runImmediately: false },
  );

  readonly summary = computed(() => {
    const env = this.summaryResource.value();
    return env && isOk(env) ? normalizeParitySummary(env.data) : null;
  });

  readonly summaryError = computed(() => {
    const err = this.summaryResource.error();
    if (err) return describeFailure(err, 'The parity summary could not be loaded.');
    const env = this.summaryResource.value();
    return env && !isOk(env)
      ? describeFailure(env, 'The parity summary could not be loaded.')
      : null;
  });

  readonly drift = computed(() => {
    const s = this.summary();
    return s ? driftView(s.drift, s.live) : null;
  });

  readonly metricRows = computed(() => {
    const s = this.summary();
    return s ? liveMetricRows(s.live) : [];
  });

  // ── sessions and the reconcile ───────────────────────────────────────────────

  readonly sessions = signal<ScriptParitySession[]>([]);
  readonly sessionsLoaded = signal(false);
  readonly sessionsError = signal<string | null>(null);
  readonly selectedSessionId = signal<number | null>(null);
  readonly canReconcile = computed(() => this.auth.hasPermission(ANALYST_PERMISSION));
  readonly queueing = signal(false);
  readonly queueNote = signal<string | null>(null);
  readonly queueError = signal<string | null>(null);

  /** The reconcile run shown, polled while `pollActive` until it finishes. */
  readonly reconcileRunId = signal<number | null>(null);
  private readonly pollActive = signal(false);
  readonly pollTimedOut = signal(false);
  private pollDeadline = 0;

  readonly reconcileResource = createPolledResource<ReconcileFetch | null>(
    () => this.fetchReconcile(),
    { intervalMs: RECONCILE_POLL_MS, runImmediately: false, active: this.pollActive },
  );

  /** The latest poll of the run on show (an earlier run's poll is never shown for it). */
  private readonly reconcileFetch = computed(() => {
    const f = this.reconcileResource.value();
    return f && f.runId === this.reconcileRunId() ? f : null;
  });

  readonly reconcile = computed(() => {
    const env = this.reconcileFetch()?.envelope;
    return env && isOk(env) ? normalizeParityReconcile(env.data) : null;
  });

  readonly reconcileLoadError = computed(() => {
    const f = this.reconcileFetch();
    if (!f) return null;
    if (f.failure) return f.failure;
    return f.envelope && !isOk(f.envelope)
      ? describeFailure(f.envelope, 'The reconcile could not be loaded.')
      : null;
  });

  readonly polling = computed(() => this.pollActive() && !reconcileDone(this.reconcile()?.status));

  readonly reconcileStatus = computed(() => {
    const r = this.reconcile();
    return r ? reconcileStatusText(r) : '';
  });

  readonly pairs = computed(() => {
    const r = this.reconcile();
    if (!r) return [];
    const names = this.accountNames();
    const decimals = pricePrecision(r.pipSize);
    return r.pairs.map((p) =>
      pairView(p, decimals, (id) => {
        const name = names.get(String(id));
        return name ? `${name} (#${id})` : `Account #${id}`;
      }),
    );
  });

  readonly metric = metricText;
  readonly worseShare = worseShareText;
  readonly label = sessionLabel;

  constructor() {
    effect(() => {
      this.strategyId();
      this.days();
      untracked(() => this.summaryResource.refresh());
    });
    effect(() => {
      this.strategyId();
      untracked(() => {
        this.reconcileRunId.set(null);
        this.pollActive.set(false);
        this.pollTimedOut.set(false);
        this.queueNote.set(null);
        this.queueError.set(null);
        this.sessions.set([]);
        this.sessionsLoaded.set(false);
        this.selectedSessionId.set(null);
        this.loadSessions(true);
      });
    });
    // A finished reconcile, or one the engine refused (gone, not a reconcile), stops the polling.
    effect(() => {
      const f = this.reconcileFetch();
      const r = this.reconcile();
      untracked(() => {
        if (!f || !this.pollActive()) return;
        if (reconcileDone(r?.status) || (f.envelope !== null && !isOk(f.envelope))) {
          this.pollActive.set(false);
        }
      });
    });
    inject(DestroyRef).onDestroy(() => this.pollActive.set(false));
  }

  setDays(value: string | number): void {
    const n = Number(value);
    if ((PARITY_WINDOWS as readonly number[]).includes(n)) this.days.set(n);
  }

  /** Refreshes the summary, and looks again at an unfinished reconcile (restarting its polling). */
  refresh(): void {
    this.summaryResource.refresh();
    const runId = this.reconcileRunId();
    if (runId !== null && !reconcileDone(this.reconcile()?.status)) this.follow(runId);
  }

  selectSession(value: string | number): void {
    const id = Number(value);
    if (!Number.isFinite(id) || id === this.selectedSessionId()) return;
    this.selectedSessionId.set(id);
    this.queueNote.set(null);
    this.queueError.set(null);
    this.showLastReconcileOf(id);
  }

  /** Queues a reconcile of the selected session and follows it until the backtest finishes. */
  queueReconcile(): void {
    if (!this.canReconcile() || this.queueing()) return;
    this.queueing.set(true);
    this.queueError.set(null);
    this.queueNote.set(null);
    this.api
      .queueParityReconcile(this.strategyId(), this.selectedSessionId())
      .pipe(finalize(() => this.queueing.set(false)))
      .subscribe({
        next: (res) => {
          const q = isOk(res) ? res.data : null;
          if (!q) {
            this.queueError.set(describeFailure(res, 'The reconcile could not be queued.'));
            return;
          }
          this.queueNote.set(
            q.alreadyQueued
              ? `This session's reconcile is already ${q.status === 'running' ? 'running' : 'queued'}: following backtest #${q.backtestRunId}.`
              : `Queued backtest #${q.backtestRunId}, ${this.utc(q.fromUtc)} to ${this.utc(q.toUtc)} UTC${q.deep ? ' (a long span: it runs on the deep queue)' : ''}.`,
          );
          if (q.sessionId) this.selectedSessionId.set(q.sessionId);
          this.follow(q.backtestRunId);
          this.loadSessions(false);
        },
        error: (err: unknown) =>
          this.queueError.set(describeFailure(err, 'The reconcile could not be queued.')),
      });
  }

  slip(v: number | null): string {
    return slippageText(v);
  }

  r(v: number | null): string {
    return rText(v);
  }

  utc(iso: string | null | undefined): string {
    const t = isoMs(iso);
    return t === null ? NA : formatDateTime(t);
  }

  private fetchReconcile(): Observable<ReconcileFetch | null> {
    const runId = this.reconcileRunId();
    if (runId === null) return of(null);
    if (Date.now() > this.pollDeadline) {
      this.pollActive.set(false);
      this.pollTimedOut.set(true);
      return of(null);
    }
    return this.api.getParityReconcile(this.strategyId(), runId).pipe(
      map((envelope): ReconcileFetch => ({ runId, envelope, failure: null })),
      catchError((err: unknown) =>
        of<ReconcileFetch>({
          runId,
          envelope: null,
          failure: describeFailure(err, 'The reconcile could not be loaded.'),
        }),
      ),
    );
  }

  /** Shows reconcile run `runId`, polling it until it finishes (or the poll limit passes). */
  private follow(runId: number): void {
    this.reconcileRunId.set(runId);
    this.pollTimedOut.set(false);
    this.pollDeadline = Date.now() + RECONCILE_POLL_LIMIT_MS;
    this.pollActive.set(true);
    this.reconcileResource.refresh();
  }

  private showLastReconcileOf(sessionId: number): void {
    const runId = this.sessions().find((s) => s.id === sessionId)?.lastReconcileRunId ?? null;
    if (runId !== null) {
      this.follow(runId);
    } else {
      this.reconcileRunId.set(null);
      this.pollActive.set(false);
      this.pollTimedOut.set(false);
    }
  }

  private loadSessions(selectNewest: boolean): void {
    const strategyId = this.strategyId();
    this.api.getParitySessions(strategyId).subscribe({
      next: (res) => {
        if (strategyId !== this.strategyId()) return;
        if (!isOk(res)) {
          this.sessionsError.set(
            describeFailure(res, 'The recorded sessions could not be loaded.'),
          );
          return;
        }
        this.sessionsError.set(null);
        const list = normalizeParitySessions(res.data);
        this.sessions.set(list);
        this.sessionsLoaded.set(true);
        const current = this.selectedSessionId();
        if (selectNewest || current === null || !list.some((s) => s.id === current)) {
          const newest = list[0]?.id ?? null;
          this.selectedSessionId.set(newest);
          if (newest !== null && this.reconcileRunId() === null) this.showLastReconcileOf(newest);
        }
      },
      error: (err: unknown) => {
        if (strategyId !== this.strategyId()) return;
        this.sessionsError.set(describeFailure(err, 'The recorded sessions could not be loaded.'));
      },
    });
  }
}
