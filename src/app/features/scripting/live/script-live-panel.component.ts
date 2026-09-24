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
import { catchError, of } from 'rxjs';

import { createPolledResource } from '@core/polling/polled-resource';

import { ScriptStrategyApiService } from '../api/script-strategy-api.service';
import { StrategyExecutionApiService } from '../api/strategy-execution-api.service';
import type { ScriptDivergence } from '../api/scripting-api.types';
import { describeFailure, isOk } from '../shared/api-error';
import { StrategyReportComponent } from '../report/strategy-report.component';
import { normalizeStrategyReport, reportCurrency } from '../report/strategy-report.model';
import { NA, formatDateTime, formatMoney, inferPriceDecimals } from '../report/report-format';
import {
  OPEN_TRADE_COLUMNS,
  PENDING_ORDER_COLUMNS,
  barAgeMinutes,
  deriveColumns,
  formatAge,
  formatLiveValue,
  humanize,
  liveStatusTone,
  normalizeLiveStatus,
  positionHeadline,
} from './live.model';

/** Fallback cadence; a live session advances on bar closes, so 15 s is plenty. */
const POLL_MS = 15_000;

/** A bar older than this (minutes) on a running session is called out as stale. */
const STALE_MINUTES = 240;

/**
 * Live status of a script strategy's session (`GET strategy/{id}/script/live`): session state,
 * the emulator's position, open trades and pending orders, equity, the divergences between the
 * emulator and the bound accounts, and the live emulator's Strategy report.
 */
@Component({
  selector: 'app-script-live-panel',
  standalone: true,
  imports: [StrategyReportComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="stack">
      <header class="head">
        <div class="head-left">
          <h3 class="title">Live session</h3>
          @if (live(); as l) {
            <span class="status" [attr.data-tone]="tone()">{{ l.status || 'Unknown' }}</span>
          }
        </div>
        <div class="head-right">
          @if (updatedText()) {
            <span class="muted" aria-live="polite">{{ updatedText() }}</span>
          }
          <button type="button" class="btn" (click)="refresh()" [disabled]="resource.refreshing()">
            {{ resource.refreshing() ? 'Refreshing…' : 'Refresh' }}
          </button>
        </div>
      </header>

      @if (resource.loading()) {
        <p class="muted" role="status">Loading the live session…</p>
      } @else if (notFound()) {
        <div class="empty" role="status">
          <p class="empty-title">No live session</p>
          <p>{{ notFound() }}</p>
          <p class="muted">
            A script strategy runs live once it is Active; it trades on bound accounts only.
          </p>
        </div>
      } @else if (errorText() && !live()) {
        <div class="error" role="alert">
          <span>{{ errorText() }}</span>
          <button type="button" class="btn" (click)="refresh()">Retry</button>
        </div>
      } @else if (live(); as l) {
        @if (errorText()) {
          <p class="warn" role="status">
            The last refresh failed ({{ errorText() }}); showing the previous state.
          </p>
        }
        <section class="facts" aria-label="Session">
          <div class="fact">
            <span class="fact-label">Last bar</span>
            <span class="fact-value">{{ lastBarText() }}</span>
            @if (stale()) {
              <span class="fact-note warn-text">No new bar for {{ ageText() }}</span>
            } @else if (ageText()) {
              <span class="fact-note">{{ ageText() }}</span>
            }
          </div>
          <div class="fact">
            <span class="fact-label">Equity (emulator)</span>
            <span class="fact-value">{{ equityText() }}</span>
          </div>
          <div class="fact">
            <span class="fact-label">Position</span>
            <span class="fact-value" [attr.data-side]="headline().side">{{ headline().text }}</span>
            @if (headline().pnl !== null) {
              <span
                class="fact-note"
                [class.gain]="headline().pnl! > 0"
                [class.loss]="headline().pnl! < 0"
                >Open P&L {{ pnlText() }}</span
              >
            }
          </div>
          <div class="fact">
            <span class="fact-label">Divergences</span>
            <span class="fact-value" [class.loss]="l.divergences.length > 0">{{
              l.divergences.length
            }}</span>
            <span class="fact-note">emulator vs bound accounts</span>
          </div>
        </section>

        @if (positionFields().length > 0) {
          <details class="fold">
            <summary>Position details</summary>
            <dl class="kv">
              @for (f of positionFields(); track f.key) {
                <div>
                  <dt>{{ f.label }}</dt>
                  <dd>{{ f.value }}</dd>
                </div>
              }
            </dl>
          </details>
        }

        <section class="block" aria-labelledby="live-open-trades">
          <h4 class="block-title" id="live-open-trades">
            Open trades <span class="count">{{ l.openTrades.length }}</span>
          </h4>
          @if (l.openTrades.length === 0) {
            <p class="muted">None.</p>
          } @else {
            <div class="table-wrap" tabindex="0" role="region" aria-labelledby="live-open-trades">
              <table>
                <thead>
                  <tr>
                    @for (c of tradeColumns(); track c.key) {
                      <th scope="col">{{ c.label }}</th>
                    }
                  </tr>
                </thead>
                <tbody>
                  @for (row of l.openTrades; track $index) {
                    <tr>
                      @for (c of tradeColumns(); track c.key) {
                        <td>{{ cell(c.key, row) }}</td>
                      }
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>

        <section class="block" aria-labelledby="live-pending-orders">
          <h4 class="block-title" id="live-pending-orders">
            Pending orders <span class="count">{{ l.pendingOrders.length }}</span>
          </h4>
          @if (l.pendingOrders.length === 0) {
            <p class="muted">None.</p>
          } @else {
            <div
              class="table-wrap"
              tabindex="0"
              role="region"
              aria-labelledby="live-pending-orders"
            >
              <table>
                <thead>
                  <tr>
                    @for (c of orderColumns(); track c.key) {
                      <th scope="col">{{ c.label }}</th>
                    }
                  </tr>
                </thead>
                <tbody>
                  @for (row of l.pendingOrders; track $index) {
                    <tr>
                      @for (c of orderColumns(); track c.key) {
                        <td>{{ cell(c.key, row) }}</td>
                      }
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>

        <section class="block" aria-labelledby="live-divergences">
          <h4 class="block-title" id="live-divergences">
            Divergences <span class="count">{{ l.divergences.length }}</span>
          </h4>
          <p class="hint">
            Where a bound account did not follow the emulator (a rejected order, slippage, a
            broker-side stop-out). The mirror records these; it never catches up by opening
            positions on its own.
          </p>
          @if (l.divergences.length === 0) {
            <p class="muted">None — every bound account matches the emulator.</p>
          } @else {
            <div class="table-wrap" tabindex="0" role="region" aria-labelledby="live-divergences">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Time (UTC)</th>
                    <th scope="col">Account</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  @for (d of sortedDivergences(); track $index) {
                    <tr>
                      <td class="nowrap">{{ divergenceTime(d) }}</td>
                      <td>{{ accountLabel(d.accountId) }}</td>
                      <td>
                        <span class="kind">{{ d.kind || '—' }}</span>
                      </td>
                      <td class="detail">{{ d.detail || '—' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>

        @if (hasReport()) {
          <app-strategy-report [report]="l.report" heading="Live emulator report" />
        } @else {
          <p class="muted">The live session has not produced a report yet.</p>
        }
      }
    </div>
  `,
  styles: [
    `
      .stack {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
      }
      .head-left,
      .head-right {
        display: flex;
        align-items: center;
        gap: var(--space-3);
      }
      .title {
        margin: 0;
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
      }
      .status {
        padding: 2px 10px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .status[data-tone='success'] {
        background: rgba(52, 199, 89, 0.14);
        color: #248a3d;
      }
      .status[data-tone='info'] {
        background: rgba(0, 113, 227, 0.12);
        color: var(--accent);
      }
      .status[data-tone='error'] {
        background: rgba(255, 59, 48, 0.12);
        color: var(--loss);
      }
      .facts {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
        gap: var(--space-3);
      }
      .fact {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: var(--space-4);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }
      .fact-label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .fact-value {
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
        overflow-wrap: anywhere;
      }
      .fact-value[data-side='long'] {
        color: var(--accent);
      }
      .fact-value[data-side='short'] {
        color: #b25000;
      }
      .fact-note {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .warn-text {
        color: #b25000;
      }
      .gain {
        color: var(--profit);
      }
      .loss {
        color: var(--loss);
      }
      .fold summary {
        cursor: pointer;
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .kv {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: var(--space-2) var(--space-5);
        margin: var(--space-2) 0 0;
      }
      .kv div {
        display: flex;
        justify-content: space-between;
        gap: var(--space-3);
        border-bottom: 1px solid var(--border);
        padding: 4px 0;
        font-size: var(--text-sm);
      }
      .kv dt {
        color: var(--text-secondary);
      }
      .kv dd {
        margin: 0;
        font-weight: var(--font-medium);
      }
      .block {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .block-title {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .count {
        margin-left: 4px;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .hint {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
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
      th {
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary);
        background: var(--bg-tertiary);
        white-space: nowrap;
      }
      .nowrap {
        white-space: nowrap;
      }
      .detail {
        min-width: 240px;
      }
      .kind {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
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
      .btn:disabled {
        opacity: 0.5;
        cursor: progress;
      }
      .muted {
        margin: 0;
        color: var(--text-secondary);
        font-size: var(--text-sm);
      }
      .empty {
        padding: var(--space-5);
        border: 1px dashed var(--border);
        border-radius: var(--radius-md);
        font-size: var(--text-sm);
      }
      .empty p {
        margin: 0 0 var(--space-1);
      }
      .empty-title {
        font-weight: var(--font-semibold);
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
    `,
  ],
})
export class ScriptLivePanelComponent {
  private readonly api = inject(ScriptStrategyApiService);
  private readonly executionApi = inject(StrategyExecutionApiService);

  readonly strategyId = input.required<number>();

  /** Account names for the divergence table, from the strategy's bindings. */
  private readonly accountNames = signal<ReadonlyMap<string, string>>(new Map());
  private readonly now = signal(Date.now());

  /**
   * The engine's envelope, polled. A failed refresh keeps the last good envelope on screen
   * (`resource.error()` carries the failure); a "not found" envelope replaces it, because then
   * the session really is gone.
   */
  readonly resource = createPolledResource(() => this.api.getLiveStatus(this.strategyId()), {
    intervalMs: POLL_MS,
    runImmediately: false,
  });

  private readonly envelope = computed(() => this.resource.value());

  readonly live = computed(() => {
    const env = this.envelope();
    return env && isOk(env) ? normalizeLiveStatus(env.data) : null;
  });

  /** The engine answered "no live session" (not an outage). */
  readonly notFound = computed(() => {
    const env = this.envelope();
    if (!env || isOk(env)) return null;
    return env.responseCode === '-14'
      ? describeFailure(env, 'This strategy has no live session.')
      : null;
  });

  readonly errorText = computed(() => {
    const err = this.resource.error();
    if (err) return describeFailure(err, 'The live status could not be loaded.');
    const env = this.envelope();
    if (env && !isOk(env) && env.responseCode !== '-14') {
      return describeFailure(env, 'The live status could not be loaded.');
    }
    return null;
  });

  readonly tone = computed(() => liveStatusTone(this.live()?.status ?? ''));

  private readonly report = computed(() => normalizeStrategyReport(this.live()?.report ?? null));
  readonly hasReport = computed(() => this.report() !== null);
  private readonly currency = computed(() => {
    const r = this.report();
    return r ? reportCurrency(r) : '';
  });

  private readonly priceDecimals = computed(() => {
    const l = this.live();
    if (!l) return 5;
    const prices: (number | null)[] = [];
    for (const row of [...l.openTrades, ...l.pendingOrders, l.position ?? {}]) {
      for (const [k, v] of Object.entries(row)) {
        if (/price|limit|stop/i.test(k) && typeof v === 'number') prices.push(v);
      }
    }
    // The live report's trades carry the most quotes; they settle the symbol's precision.
    for (const t of this.report()?.trades ?? []) prices.push(t.entryPrice, t.exitPrice);
    return prices.some((p) => p !== null) ? inferPriceDecimals(prices) : 5;
  });

  readonly headline = computed(() =>
    positionHeadline(this.live()?.position ?? null, this.priceDecimals()),
  );
  readonly pnlText = computed(() =>
    formatMoney(this.headline().pnl, this.currency(), { signed: true }),
  );

  readonly positionFields = computed(() => {
    const p = this.live()?.position;
    if (!p) return [];
    return Object.entries(p)
      .filter(([, v]) => v === null || typeof v !== 'object')
      .map(([key, v]) => ({
        key,
        label: humanize(key),
        value: formatLiveValue(key, v, this.currency(), this.priceDecimals()),
      }));
  });

  readonly tradeColumns = computed(() =>
    deriveColumns(this.live()?.openTrades ?? [], OPEN_TRADE_COLUMNS),
  );
  readonly orderColumns = computed(() =>
    deriveColumns(this.live()?.pendingOrders ?? [], PENDING_ORDER_COLUMNS),
  );

  readonly sortedDivergences = computed(() =>
    [...(this.live()?.divergences ?? [])].sort((a, b) =>
      (b.timeUtc || '').localeCompare(a.timeUtc || ''),
    ),
  );

  readonly equityText = computed(() => {
    const e = this.live()?.equity;
    if (typeof e === 'number') return formatMoney(e, this.currency());
    if (e && typeof e === 'object') {
      const v = (e as Record<string, unknown>)['equity'];
      return typeof v === 'number' ? formatMoney(v, this.currency()) : NA;
    }
    return NA;
  });

  readonly lastBarText = computed(() => {
    const t = this.live()?.lastBarTimeMs ?? null;
    return t === null ? NA : `${formatDateTime(t)} UTC`;
  });

  private readonly ageMinutes = computed(() =>
    barAgeMinutes(this.live()?.lastBarTimeMs ?? null, this.now()),
  );
  readonly ageText = computed(() => formatAge(this.ageMinutes()));
  readonly stale = computed(() => {
    const age = this.ageMinutes();
    return age !== null && age > STALE_MINUTES && this.tone() === 'success';
  });

  readonly updatedText = computed(() => {
    const at = this.resource.lastUpdated();
    if (!at) return '';
    const s = Math.max(0, Math.round((this.now() - at) / 1000));
    return s < 5 ? 'Updated just now' : `Updated ${s}s ago`;
  });

  constructor() {
    effect(() => {
      this.strategyId();
      untracked(() => {
        this.resource.refresh();
        this.loadAccountNames();
      });
    });
    // Keeps the relative times honest between polls.
    const tick = setInterval(() => this.now.set(Date.now()), 10_000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
  }

  refresh(): void {
    this.now.set(Date.now());
    this.resource.refresh();
  }

  cell(key: string, row: Record<string, unknown>): string {
    return formatLiveValue(key, row[key], this.currency(), this.priceDecimals());
  }

  divergenceTime(d: ScriptDivergence): string {
    const t = Date.parse(d.timeUtc);
    return Number.isFinite(t) ? formatDateTime(t) : d.timeUtc || NA;
  }

  accountLabel(id: number | string | null): string {
    if (id === null || id === '') return NA;
    const name = this.accountNames().get(String(id));
    return name ? `${name} (#${id})` : `Account #${id}`;
  }

  private loadAccountNames(): void {
    this.executionApi
      .getAccountBindings(this.strategyId())
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        if (!res || !isOk(res)) return;
        const map = new Map<string, string>();
        for (const b of res.data ?? []) {
          if (b.accountName) map.set(String(b.tradingAccountId), b.accountName);
        }
        this.accountNames.set(map);
      });
  }
}
