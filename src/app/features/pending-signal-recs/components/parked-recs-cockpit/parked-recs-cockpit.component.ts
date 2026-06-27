import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { catchError, finalize, of } from 'rxjs';
import { PendingSignalRecsService } from '@core/services/pending-signal-recs.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { PendingSignalRecDto } from '@core/api/api.types';

interface AuditEntry {
  at: string;
  decision: string;
  reason: string;
  latencyMs: number;
  llmInvocationId: number | null;
  siblingRecId?: number | null;
  siblingTradeSignalId?: number | null;
}

/**
 * Embeddable parked-recs cockpit: filters + table + per-row audit
 * drilldown.  Polls every 5 s while alive.  Used by the standalone
 * `/pending-signal-recs` page AND by the "Parked recs" tab on the
 * Trade Signals page.
 */
@Component({
  selector: 'app-parked-recs-cockpit',
  standalone: true,
  imports: [DatePipe, DecimalPipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="filters">
      <div class="filter-group">
        <label class="filter-label">State</label>
        <div class="state-chips">
          @for (s of allStates; track s) {
            <label class="chip" [class.on]="selectedStates().has(s)">
              <input
                type="checkbox"
                [checked]="selectedStates().has(s)"
                (change)="toggleState(s, $any($event.target).checked)"
              />
              <span>{{ s }}</span>
            </label>
          }
        </div>
      </div>
      <div class="filter-group symbol-group">
        <label class="filter-label">Symbol</label>
        <input
          type="text"
          placeholder="e.g. EURUSD"
          [value]="symbolFilter()"
          (input)="symbolFilter.set($any($event.target).value)"
          (keydown.enter)="reload()"
          class="symbol-input"
        />
      </div>
      <div class="filter-group toggles">
        <label class="inline-check">
          <input
            type="checkbox"
            [checked]="siblingValidatedOnly()"
            (change)="siblingValidatedOnly.set($any($event.target).checked)"
          />
          <span>Sibling-validated only</span>
        </label>
        <button type="button" class="btn btn-secondary" (click)="reload()" [disabled]="loading()">
          {{ loading() ? 'Refreshing…' : 'Refresh' }}
        </button>
      </div>
    </section>

    <section class="table-wrap">
      @if (loadError()) {
        <p class="bad">{{ loadError() }}</p>
      }
      @if (visibleRows().length === 0 && !loading()) {
        <p class="muted">
          No rows for the current filter. When the engine-wide gate is on and the LLM produces a rec
          whose entry is far from market, it lands here as a <em>Parked</em> row.
        </p>
      } @else {
        <table class="grid">
          <thead>
            <tr>
              <th class="expand-col"></th>
              <th>Id</th>
              <th>Symbol</th>
              <th>Dir</th>
              <th class="num">Entry</th>
              <th class="num">SL</th>
              <th class="num">TP</th>
              <th class="num">ATR</th>
              <th class="num">Conf</th>
              <th>State</th>
              <th>Validation</th>
              <th>Parked</th>
              <th>Park exp.</th>
              <th>Last reval</th>
              <th class="num">Attempts</th>
              <th>Terminal</th>
              <th>Resulting signal</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            @for (r of visibleRows(); track r.id) {
              <tr [class.dim]="isTerminal(r.state)" [class.expanded]="isExpanded(r.id)">
                <td class="expand-cell">
                  <button
                    type="button"
                    class="expand-btn"
                    [class.on]="isExpanded(r.id)"
                    (click)="toggleExpand(r.id)"
                    [attr.aria-label]="isExpanded(r.id) ? 'Collapse audit' : 'Expand audit'"
                    [attr.aria-expanded]="isExpanded(r.id)"
                  >
                    <span class="chev">▸</span>
                  </button>
                </td>
                <td class="num">
                  <code>{{ r.id }}</code>
                </td>
                <td>{{ r.symbol }}</td>
                <td
                  class="dir"
                  [class.dir-buy]="r.direction === 'Buy'"
                  [class.dir-sell]="r.direction === 'Sell'"
                >
                  {{ r.direction }}
                </td>
                <td class="num">{{ r.recommendedEntryPrice | number: '1.0-5' }}</td>
                <td class="num">
                  {{ r.stopLoss === null ? '—' : (r.stopLoss | number: '1.0-5') }}
                </td>
                <td class="num">
                  {{ r.takeProfit === null ? '—' : (r.takeProfit | number: '1.0-5') }}
                </td>
                <td class="num">{{ r.atrAtGeneration | number: '1.0-5' }}</td>
                <td class="num">{{ r.confidence | number: '1.2-2' }}</td>
                <td>
                  <span class="state state-{{ r.state.toLowerCase() }}">{{ r.state }}</span>
                </td>
                <td class="validation">
                  @if (r.isSiblingValidated) {
                    <span
                      class="badge sibling"
                      [attr.title]="
                        r.siblingValidatedByRecId !== null
                          ? 'Pre-validated at park time by sibling rec #' +
                            r.siblingValidatedByRecId +
                            '. The next eligibility tick will skip the LLM.'
                          : 'Pre-validated at park time. The next eligibility tick will skip the LLM.'
                      "
                    >
                      sibling
                      @if (r.siblingValidatedByRecId !== null) {
                        · #{{ r.siblingValidatedByRecId }}
                      }
                    </span>
                  } @else {
                    <span class="badge llm" title="Will go through the re-validation LLM at touch."
                      >LLM</span
                    >
                  }
                </td>
                <td class="ts">{{ r.createdAt | date: 'MMM d HH:mm' }}</td>
                <td class="ts">{{ r.parkExpiresAt | date: 'MMM d HH:mm' }}</td>
                <td class="ts">
                  {{
                    r.lastRevalAttemptAt === null
                      ? '—'
                      : (r.lastRevalAttemptAt | date: 'MMM d HH:mm')
                  }}
                </td>
                <td class="num">{{ r.revalAttempts }}</td>
                <td class="terminal" [title]="r.terminalReason ?? ''">
                  {{ r.terminalReason ?? '—' }}
                </td>
                <td class="num">
                  @if (r.resultingTradeSignalId !== null) {
                    <a [routerLink]="['/trade-signals', r.resultingTradeSignalId]" class="link">
                      <code>{{ r.resultingTradeSignalId }}</code>
                    </a>
                  } @else {
                    —
                  }
                </td>
                <td>
                  @if (r.state === 'Parked') {
                    <button
                      type="button"
                      class="btn btn-mini btn-danger"
                      (click)="cancel(r)"
                      [disabled]="canceling().has(r.id)"
                    >
                      {{ canceling().has(r.id) ? '…' : 'Cancel' }}
                    </button>
                  }
                </td>
              </tr>
              @if (isExpanded(r.id)) {
                <tr class="detail-row">
                  <td colspan="18">
                    <div class="audit-panel">
                      <!-- Lifecycle / context summary -->
                      <dl class="kv-grid">
                        <div>
                          <dt>Park TTL</dt>
                          <dd>
                            created {{ r.createdAt | date: 'MMM d HH:mm:ss' }} → expires
                            {{ r.parkExpiresAt | date: 'MMM d HH:mm:ss' }}
                          </dd>
                        </div>
                        <div>
                          <dt>Signal expiry (on promote)</dt>
                          <dd>{{ r.signalExpiresAt | date: 'MMM d HH:mm:ss' }}</dd>
                        </div>
                        <div>
                          <dt>Timeframe</dt>
                          <dd>{{ r.timeframe }}</dd>
                        </div>
                        <div>
                          <dt>LLM invocation</dt>
                          <dd>
                            @if (r.llmInvocationId !== null) {
                              <code>{{ r.llmInvocationId }}</code>
                            } @else {
                              —
                            }
                          </dd>
                        </div>
                        <div>
                          <dt>Validation</dt>
                          <dd>
                            @if (r.isSiblingValidated) {
                              Pre-validated by sibling
                              @if (r.siblingValidatedByRecId !== null) {
                                rec
                                <code>#{{ r.siblingValidatedByRecId }}</code>
                              }
                              · next eligibility tick will skip the LLM.
                            } @else {
                              Awaiting LLM re-validation at touch.
                            }
                          </dd>
                        </div>
                        <div>
                          <dt>Resulting TradeSignal</dt>
                          <dd>
                            @if (r.resultingTradeSignalId !== null) {
                              <a
                                [routerLink]="['/trade-signals', r.resultingTradeSignalId]"
                                class="link"
                                >#{{ r.resultingTradeSignalId }}</a
                              >
                            } @else {
                              —
                            }
                          </dd>
                        </div>
                      </dl>

                      <!-- Per-attempt audit history -->
                      <div class="audit-header">
                        Re-validation history · {{ r.revalAttempts }} attempt{{
                          r.revalAttempts === 1 ? '' : 's'
                        }}
                        @if (r.lastRevalAttemptAt) {
                          · last
                          <strong>{{ r.lastRevalAttemptAt | date: 'MMM d HH:mm:ss' }}</strong>
                        }
                      </div>
                      @if (parseAudit(r.revalAuditJson); as entries) {
                        @if (entries.length === 0) {
                          <p class="muted small">No re-validation attempts recorded yet.</p>
                        } @else {
                          <table class="audit-grid">
                            <thead>
                              <tr>
                                <th>When</th>
                                <th>Decision</th>
                                <th>Reason</th>
                                <th class="num">Latency</th>
                                <th>Source</th>
                              </tr>
                            </thead>
                            <tbody>
                              @for (e of entries; track $index) {
                                <tr>
                                  <td class="ts">
                                    {{ e.at | date: 'MMM d HH:mm:ss' }}
                                  </td>
                                  <td>
                                    <span
                                      class="decision-pill decision-{{ e.decision.toLowerCase() }}"
                                      >{{ e.decision }}</span
                                    >
                                  </td>
                                  <td class="reason">{{ e.reason }}</td>
                                  <td class="num">{{ e.latencyMs }}ms</td>
                                  <td>
                                    @if (
                                      e.llmInvocationId !== null && e.llmInvocationId !== undefined
                                    ) {
                                      LLM <code>{{ e.llmInvocationId }}</code>
                                    } @else if (
                                      e.siblingRecId !== null && e.siblingRecId !== undefined
                                    ) {
                                      sibling <code>#{{ e.siblingRecId }}</code>
                                    } @else if (
                                      e.siblingTradeSignalId !== null &&
                                      e.siblingTradeSignalId !== undefined
                                    ) {
                                      sibling-signal <code>#{{ e.siblingTradeSignalId }}</code>
                                    } @else {
                                      —
                                    }
                                  </td>
                                </tr>
                              }
                            </tbody>
                          </table>
                        }
                      } @else {
                        <p class="muted small">
                          No audit recorded yet
                          @if (r.revalAttempts > 0) {
                            (attempts={{ r.revalAttempts }} but audit JSON could not be parsed)
                          }
                          .
                        </p>
                      }
                    </div>
                  </td>
                </tr>
              }
            }
          </tbody>
        </table>
      }
      @if (loading() && visibleRows().length > 0) {
        <p class="muted small">Refreshing…</p>
      }
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .muted {
        color: var(--text-tertiary);
      }
      .small {
        font-size: var(--text-xs, 12px);
      }
      .bad {
        color: #d70015;
      }
      .link {
        color: var(--accent);
        text-decoration: none;
      }
      .link:hover {
        text-decoration: underline;
      }
      /* Filter bar — matches the soft secondary surface used by other
         operator-config cards (e.g. trading-window panel) so it reads as
         part of the page in both themes. */
      .filters {
        display: flex;
        gap: var(--space-4);
        align-items: flex-end;
        flex-wrap: wrap;
        margin-bottom: var(--space-3);
        padding: var(--space-3);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }
      .filter-group {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .filter-group.toggles {
        flex-direction: row;
        align-items: center;
        gap: var(--space-3);
      }
      .filter-label {
        font-size: var(--text-xs, 12px);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
        font-weight: var(--font-semibold, 600);
      }
      .state-chips {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }
      .chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-full);
        cursor: pointer;
        font-size: var(--text-xs, 12px);
        color: var(--text-secondary);
        user-select: none;
      }
      .chip input {
        accent-color: var(--accent);
      }
      .chip.on {
        background: rgba(0, 113, 227, 0.12);
        color: var(--accent);
        border-color: rgba(0, 113, 227, 0.25);
      }
      .inline-check {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: var(--text-sm, 13px);
        color: var(--text-primary);
        cursor: pointer;
      }
      .symbol-group .symbol-input {
        width: 12rem;
        padding: 6px 10px;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        color: var(--text-primary);
        border-radius: var(--radius-sm);
        font-size: var(--text-sm, 13px);
      }
      .table-wrap {
        overflow-x: auto;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }
      table.grid {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm, 13px);
      }
      table.grid th,
      table.grid td {
        padding: 8px 10px;
        border-bottom: 1px solid var(--border);
        text-align: left;
        white-space: nowrap;
      }
      table.grid th {
        font-weight: var(--font-semibold, 600);
        font-size: var(--text-xs, 12px);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
        background: var(--bg-secondary);
        position: sticky;
        top: 0;
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .ts {
        font-variant-numeric: tabular-nums;
      }
      tr.dim {
        opacity: 0.55;
      }
      .dir-buy {
        color: #248a3d;
        font-weight: var(--font-semibold, 600);
      }
      .dir-sell {
        color: #d70015;
        font-weight: var(--font-semibold, 600);
      }
      .state {
        display: inline-block;
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-size: 10.5px;
        font-weight: var(--font-semibold, 600);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        background: var(--bg-tertiary);
        color: var(--text-tertiary);
      }
      .state-parked {
        background: rgba(0, 113, 227, 0.12);
        color: var(--accent);
      }
      .state-revalidating {
        background: rgba(255, 149, 0, 0.14);
        color: #c93400;
      }
      .state-approved {
        background: rgba(52, 199, 89, 0.16);
        color: #248a3d;
      }
      .state-rejected,
      .state-expired,
      .state-canceled {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .validation .badge {
        display: inline-block;
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-size: 10.5px;
        font-weight: var(--font-semibold, 600);
        letter-spacing: 0.04em;
      }
      .badge.sibling {
        background: rgba(52, 199, 89, 0.16);
        color: #248a3d;
      }
      .badge.llm {
        background: var(--bg-tertiary);
        color: var(--text-tertiary);
      }
      .terminal {
        max-width: 14rem;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .btn {
        padding: 6px 14px;
        font-size: var(--text-xs, 12px);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-family: inherit;
        font-weight: var(--font-semibold, 600);
        cursor: pointer;
      }
      .btn[disabled] {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .btn-secondary:hover:not([disabled]) {
        background: var(--bg-tertiary);
      }
      .btn-mini {
        padding: 3px 8px;
        font-size: 11px;
      }
      .btn-danger {
        border-color: rgba(255, 59, 48, 0.4);
        color: #d70015;
      }
      .btn-danger:hover:not([disabled]) {
        background: rgba(255, 59, 48, 0.08);
      }
      code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.92em;
      }
      /* expand affordance + audit drilldown */
      th.expand-col,
      td.expand-cell {
        width: 28px;
        padding: 0;
        text-align: center;
      }
      .expand-btn {
        background: transparent;
        border: none;
        color: var(--text-tertiary);
        padding: 4px 6px;
        cursor: pointer;
        font-size: var(--text-sm, 13px);
        line-height: 1;
        border-radius: var(--radius-sm);
      }
      .expand-btn:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .expand-btn .chev {
        display: inline-block;
        transition: transform 0.12s ease;
      }
      .expand-btn.on .chev {
        transform: rotate(90deg);
        color: var(--accent);
      }
      tr.expanded {
        background: var(--bg-tertiary);
      }
      tr.detail-row td {
        padding: 0;
        background: var(--bg-tertiary);
        border-bottom: 1px solid var(--border);
      }
      .audit-panel {
        padding: 12px 16px 14px 44px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .kv-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 6px 24px;
        margin: 0;
        padding: 0;
      }
      .kv-grid > div {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .kv-grid dt {
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
        font-weight: var(--font-semibold, 600);
      }
      .kv-grid dd {
        margin: 0;
        font-size: var(--text-sm, 13px);
        color: var(--text-primary);
      }
      .audit-header {
        font-size: var(--text-xs, 12px);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
        font-weight: var(--font-semibold, 600);
      }
      table.audit-grid {
        width: auto;
        max-width: 100%;
        border-collapse: collapse;
        font-size: var(--text-xs, 12px);
      }
      table.audit-grid th,
      table.audit-grid td {
        padding: 5px 10px;
        border-bottom: 1px solid var(--border);
        text-align: left;
        white-space: nowrap;
        color: var(--text-primary);
      }
      table.audit-grid th {
        background: transparent;
        color: var(--text-tertiary);
        font-size: 10.5px;
        position: static;
      }
      table.audit-grid .reason {
        max-width: 36rem;
        white-space: normal;
      }
      .decision-pill {
        display: inline-block;
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-size: 10.5px;
        font-weight: var(--font-semibold, 600);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        background: var(--bg-tertiary);
        color: var(--text-tertiary);
      }
      .decision-approved,
      .decision-approvedbysiblingrec {
        background: rgba(52, 199, 89, 0.16);
        color: #248a3d;
      }
      .decision-rejected {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .decision-retryparked {
        background: rgba(255, 149, 0, 0.14);
        color: #c93400;
      }
    `,
  ],
})
export class ParkedRecsCockpitComponent implements OnInit, OnDestroy {
  private readonly svc = inject(PendingSignalRecsService);
  private readonly notify = inject(NotificationService);

  protected readonly allStates = [
    'Parked',
    'Revalidating',
    'Approved',
    'Rejected',
    'Expired',
    'Canceled',
  ] as const;

  protected readonly selectedStates = signal<Set<string>>(new Set(['Parked', 'Revalidating']));
  protected readonly symbolFilter = signal('');
  protected readonly siblingValidatedOnly = signal(false);
  protected readonly rows = signal<PendingSignalRecDto[]>([]);
  protected readonly loading = signal(false);
  protected readonly loadError = signal<string | null>(null);
  protected readonly canceling = signal<Set<number>>(new Set());
  protected readonly expandedRowIds = signal<Set<number>>(new Set());

  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private static readonly POLL_INTERVAL_MS = 5_000;

  ngOnInit(): void {
    this.reload();
    this.pollHandle = setInterval(() => this.reload(), ParkedRecsCockpitComponent.POLL_INTERVAL_MS);
  }

  ngOnDestroy(): void {
    if (this.pollHandle !== null) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  /** Client-side overlay on the server response — keeps the "sibling-validated only" toggle cheap. */
  protected readonly visibleRows = () => {
    const rows = this.rows();
    return this.siblingValidatedOnly() ? rows.filter((r) => r.isSiblingValidated) : rows;
  };

  protected toggleState(state: string, on: boolean): void {
    const next = new Set(this.selectedStates());
    if (on) next.add(state);
    else next.delete(state);
    this.selectedStates.set(next);
    this.reload();
  }

  protected isTerminal(state: string): boolean {
    return (
      state === 'Approved' || state === 'Rejected' || state === 'Expired' || state === 'Canceled'
    );
  }

  protected isExpanded(id: number): boolean {
    return this.expandedRowIds().has(id);
  }

  protected toggleExpand(id: number): void {
    const next = new Set(this.expandedRowIds());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.expandedRowIds.set(next);
  }

  protected parseAudit(json: string | null): AuditEntry[] | null {
    if (json === null || json === undefined || json.trim().length === 0) return null;
    try {
      const arr = JSON.parse(json) as unknown;
      if (!Array.isArray(arr)) return null;
      return arr.map((raw): AuditEntry => {
        const e = raw as Partial<AuditEntry>;
        return {
          at: typeof e.at === 'string' ? e.at : '',
          decision: typeof e.decision === 'string' ? e.decision : 'Unknown',
          reason: typeof e.reason === 'string' ? e.reason : '',
          latencyMs: typeof e.latencyMs === 'number' ? e.latencyMs : 0,
          llmInvocationId: typeof e.llmInvocationId === 'number' ? e.llmInvocationId : null,
          siblingRecId: typeof e.siblingRecId === 'number' ? e.siblingRecId : null,
          siblingTradeSignalId:
            typeof e.siblingTradeSignalId === 'number' ? e.siblingTradeSignalId : null,
        };
      });
    } catch {
      return null;
    }
  }

  protected reload(): void {
    this.loading.set(true);
    this.loadError.set(null);
    const states = Array.from(this.selectedStates());
    const symbol = this.symbolFilter().trim();
    this.svc
      .query({
        pageNumber: 1,
        pageSize: 100,
        states: states.length > 0 ? states : null,
        search: symbol.length > 0 ? symbol : null,
      })
      .pipe(
        finalize(() => this.loading.set(false)),
        catchError((err) => {
          this.loadError.set(err?.error?.message ?? 'Failed to load.');
          return of(null);
        }),
      )
      .subscribe((res) => {
        if (res === null) return;
        if (!res.status) {
          this.loadError.set(res.message ?? 'Failed to load.');
          return;
        }
        this.rows.set(res.data?.data ?? []);
      });
  }

  protected cancel(row: PendingSignalRecDto): void {
    if (!confirm(`Cancel parked rec #${row.id} (${row.direction} ${row.symbol})?`)) return;
    const inFlight = new Set(this.canceling());
    inFlight.add(row.id);
    this.canceling.set(inFlight);
    this.svc
      .cancel(row.id)
      .pipe(
        finalize(() => {
          const next = new Set(this.canceling());
          next.delete(row.id);
          this.canceling.set(next);
        }),
        catchError((err) => {
          this.notify.error(err?.error?.message ?? 'Cancel failed.');
          return of(null);
        }),
      )
      .subscribe((res) => {
        if (res === null) return;
        if (!res.status) {
          this.notify.error(res.message ?? 'Cancel failed.');
          return;
        }
        this.notify.success(`Cancelled rec #${row.id}.`);
        this.reload();
      });
  }
}
