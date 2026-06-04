import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { SpotSweepService } from '@core/services/spot-sweep.service';
import { AccountScopeService } from '@core/scope/account-scope.service';
import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import { createPolledResource } from '@core/polling/polled-resource';
import {
  ALL_ACTIVE_SCOPE,
  SpotSweepConfig,
  SweepBarPosition,
  SweepLastResult,
} from '@features/spot-sweep/spot-sweep.types';

/**
 * Spot Sweep cockpit — configure + monitor the autonomous spot-analysis loop.
 * Phase 1: full control surface + live status, driven by SpotSweepService
 * (mocked until the engine endpoints land). See docs/SPOT_SWEEP_PLAN.md.
 */
@Component({
  selector: 'app-spot-sweep-page',
  standalone: true,
  imports: [DatePipe, DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Spot Sweep</h1>
          <p class="muted">
            Autonomous spot-analysis loop — walks your pairs one at a time, skips symbols you
            already have exposure on, and (optionally) auto-trades the signal.
          </p>
        </div>

        @if (config(); as cfg) {
          <div class="head-actions">
            <span class="mode-badge" [class.live]="cfg.mode === 'Live'">{{ cfg.mode }}</span>
            <button
              type="button"
              class="power-btn"
              [class.on]="cfg.enabled"
              [disabled]="saving()"
              (click)="toggleEnabled()"
            >
              {{ cfg.enabled ? '■ Stop sweep' : '▶ Start sweep' }}
            </button>
          </div>
        }
      </header>

      @if (error(); as e) {
        <div class="banner error">{{ e }}</div>
      }
      @if (status()?.killSwitchActive) {
        <div class="banner warn">
          Kill switch is active — the sweep is halted regardless of its enabled state.
        </div>
      }

      <!-- ───────── Live status ───────── -->
      @if (status(); as st) {
        <section class="card status-card">
          <div class="status-head">
            <span
              class="phase-pill"
              [class.analyzing]="st.phase === 'Analyzing'"
              [class.cooldown]="st.phase === 'Cooldown'"
            >
              {{ st.running ? st.phase : 'Idle' }}
            </span>
            @if (st.running) {
              <span class="status-line">
                Analysing <strong class="mono">{{ st.currentSymbol }}</strong> · next
                <span class="mono">{{ st.nextEligibleSymbol }}</span>
              </span>
            } @else {
              <span class="status-line muted">{{ st.idleReason ?? 'Idle' }}</span>
            }
            <span class="spacer"></span>
            <span class="muted small">
              {{ st.eligibleCount }} eligible · {{ st.excludedCount }} excluded
            </span>
          </div>

          <dl class="counters">
            <div>
              <dt>Analyses</dt>
              <dd class="mono">{{ st.today.analyses }}</dd>
            </div>
            <div>
              <dt>Signals</dt>
              <dd class="mono">{{ st.today.signalsCreated }}</dd>
            </div>
            <div>
              <dt>Orders</dt>
              <dd class="mono">{{ st.today.ordersPlaced }}</dd>
            </div>
            <div>
              <dt>Auto-approved</dt>
              <dd class="mono">{{ st.today.autoApproved }}</dd>
            </div>
            <div>
              <dt>Manual pending</dt>
              <dd class="mono">{{ st.today.manualPending }}</dd>
            </div>
            <div>
              <dt>Gate rejected</dt>
              <dd class="mono">{{ st.today.gateRejected }}</dd>
            </div>
            <div>
              <dt>LLM cost today</dt>
              <dd class="mono">{{ st.today.costUsd | number: '1.3-3' }} $</dd>
            </div>
          </dl>
        </section>
      }

      @if (config(); as cfg) {
        <div class="grid">
          <!-- ───────── Config ───────── -->
          <section class="card">
            <header class="card-head">
              <h2>Configuration</h2>
              @if (dirty()) {
                <span class="muted small">unsaved changes</span>
              }
            </header>

            <!-- Mode -->
            <div class="field">
              <label>Mode</label>
              <div class="seg">
                <button
                  type="button"
                  [class.active]="cfg.mode === 'Paper'"
                  (click)="setMode('Paper')"
                >
                  Paper
                </button>
                <button
                  type="button"
                  class="live-opt"
                  [class.active]="cfg.mode === 'Live'"
                  (click)="requestLive()"
                >
                  Live
                </button>
              </div>
            </div>
            @if (pendingLiveConfirm()) {
              <div class="confirm-live">
                <p>
                  <strong>Live mode places real orders.</strong> The sweep will auto-approve and
                  execute signals on your live accounts. Confirm you want this.
                </p>
                <div class="confirm-actions">
                  <button type="button" class="danger" (click)="confirmLive()">
                    Enable Live mode
                  </button>
                  <button type="button" class="ghost" (click)="cancelLive()">Cancel</button>
                </div>
              </div>
            }

            <!-- Pairs -->
            <div class="field">
              <label>Pairs ({{ cfg.pairs.length }} selected)</label>
              <div class="tf-row">
                <span class="muted small">Timeframe</span>
                <select
                  [value]="sweepTimeframe()"
                  (change)="setSweepTimeframe($any($event.target).value)"
                >
                  @for (tf of timeframes; track tf) {
                    <option [value]="tf" [selected]="tf === sweepTimeframe()">{{ tf }}</option>
                  }
                </select>
                <span class="spacer"></span>
                @if (availableSymbols().length > 0) {
                  <button type="button" class="linkish" (click)="toggleAllPairs()">
                    {{ allPairsSelected() ? 'Clear all' : 'Select all' }}
                  </button>
                }
              </div>
              @if (availableSymbols().length > 0) {
                <ul class="pair-check-list">
                  @for (sym of availableSymbols(); track sym) {
                    <li>
                      <label class="inline-check">
                        <input
                          type="checkbox"
                          [checked]="isPairSelected(sym)"
                          (change)="togglePair(sym)"
                        />
                        <span class="mono">{{ sym }}</span>
                      </label>
                    </li>
                  }
                </ul>
              } @else if (pairsLoading()) {
                <p class="muted small">Loading currency pairs…</p>
              } @else {
                <p class="muted small">No active currency pairs found in the catalogue.</p>
              }
            </div>

            <!-- Account scope -->
            <div class="field">
              <label>Accounts in scope</label>
              <label class="inline-check">
                <input
                  type="checkbox"
                  [checked]="isAllActive()"
                  (change)="setAllActive($any($event.target).checked)"
                />
                All active accounts
              </label>
              @if (!isAllActive()) {
                @if (liveAccounts().length > 0) {
                  <ul class="acct-list">
                    @for (a of liveAccounts(); track a.id) {
                      <li>
                        <label class="inline-check">
                          <input
                            type="checkbox"
                            [checked]="isAccountSelected(a.id)"
                            (change)="toggleAccount(a.id)"
                          />
                          <span class="mono">{{ a.accountName || a.accountId }}</span>
                          @if (a.isPaper) {
                            <span class="chip">paper</span>
                          }
                        </label>
                      </li>
                    }
                  </ul>
                  @if (selectedAccountCount() === 0) {
                    <span class="muted small">
                      No accounts selected — the sweep will have nothing to act on.
                    </span>
                  }
                } @else {
                  <span class="muted small">No active accounts available.</span>
                }
              }
            </div>

            <!-- Pacing + framing -->
            <div class="row-2">
              <div class="field">
                <label>Bar position</label>
                <select
                  [value]="cfg.barPosition"
                  (change)="patch({ barPosition: $any($event.target).value })"
                >
                  @for (bp of barPositions; track bp) {
                    <option [value]="bp" [selected]="bp === cfg.barPosition">{{ bp }}</option>
                  }
                </select>
              </div>
              <div class="field">
                <label>Interval (seconds between analyses)</label>
                <input
                  type="number"
                  min="5"
                  [value]="cfg.intervalSeconds"
                  (input)="patch({ intervalSeconds: clampInt($any($event.target).value, 5, 3600) })"
                />
              </div>
            </div>

            <!-- Automation -->
            <div class="field check">
              <label>
                <input
                  type="checkbox"
                  [checked]="cfg.autoApprove"
                  (change)="patch({ autoApprove: $any($event.target).checked })"
                />
                Auto-approve &amp; place orders
              </label>
            </div>
            @if (cfg.autoApprove) {
              <div class="field">
                <label
                  >Min confidence to auto-trade: {{ cfg.minConfidence | number: '1.2-2' }}</label
                >
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  [value]="cfg.minConfidence"
                  (input)="patch({ minConfidence: +$any($event.target).value })"
                />
                <span class="muted small">
                  Signals below this confidence stay Pending for manual review.
                </span>
              </div>
            }

            <button
              type="button"
              class="save-btn"
              [disabled]="!dirty() || saving()"
              (click)="save()"
            >
              {{ saving() ? 'Saving…' : 'Save configuration' }}
            </button>
          </section>

          <!-- ───────── Guardrails + activity ───────── -->
          <section class="card">
            <header class="card-head"><h2>Guardrails</h2></header>

            <div class="field check">
              <label>
                <input
                  type="checkbox"
                  [checked]="cfg.respectKillSwitch"
                  (change)="patch({ respectKillSwitch: $any($event.target).checked })"
                />
                Halt on kill switch
              </label>
              <label>
                <input
                  type="checkbox"
                  [checked]="cfg.skipWhenInsufficientMargin"
                  (change)="patch({ skipWhenInsufficientMargin: $any($event.target).checked })"
                />
                Skip when no margin for a new trade
              </label>
            </div>

            <p class="sub-label">Skip a symbol when it has…</p>
            <div class="field check">
              <label>
                <input
                  type="checkbox"
                  [checked]="cfg.excludeOpenPosition"
                  (change)="patch({ excludeOpenPosition: $any($event.target).checked })"
                />
                an open position
              </label>
              <label>
                <input
                  type="checkbox"
                  [checked]="cfg.excludePendingOrder"
                  (change)="patch({ excludePendingOrder: $any($event.target).checked })"
                />
                a pending/working order
              </label>
              <label>
                <input
                  type="checkbox"
                  [checked]="cfg.excludePendingSignal"
                  (change)="patch({ excludePendingSignal: $any($event.target).checked })"
                />
                a pending signal
              </label>
              <label>
                <input
                  type="checkbox"
                  [checked]="cfg.requireActiveEaCoverage"
                  (change)="patch({ requireActiveEaCoverage: $any($event.target).checked })"
                />
                no active EA covering it
              </label>
            </div>

            <p class="sub-label">Hard caps</p>
            <div class="row-2">
              <div class="field">
                <label>Max concurrent sweep positions</label>
                <input
                  type="number"
                  min="0"
                  [value]="cfg.maxConcurrentSweepPositions"
                  (input)="
                    patch({
                      maxConcurrentSweepPositions: clampInt($any($event.target).value, 0, 999),
                    })
                  "
                />
              </div>
              <div class="field">
                <label>Max new orders / day</label>
                <input
                  type="number"
                  min="0"
                  [value]="cfg.maxNewOrdersPerDay"
                  (input)="
                    patch({ maxNewOrdersPerDay: clampInt($any($event.target).value, 0, 9999) })
                  "
                />
              </div>
              <div class="field">
                <label>Max LLM cost / day ($)</label>
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  [value]="cfg.maxDailyLlmCostUsd"
                  (input)="
                    patch({ maxDailyLlmCostUsd: clampFloat($any($event.target).value, 0, 1000) })
                  "
                />
              </div>
              <div class="field">
                <label>Max risk / trade (lots)</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  [value]="cfg.maxRiskPerTrade"
                  (input)="
                    patch({ maxRiskPerTrade: clampFloat($any($event.target).value, 0, 100) })
                  "
                />
              </div>
            </div>

            <header class="card-head"><h2>Recent activity</h2></header>
            @if (feed().length > 0) {
              <ul class="feed">
                @for (r of feed(); track r.signalId) {
                  <li>
                    <span class="feed-time mono">{{ r.at | date: 'HH:mm:ss' }}</span>
                    <span class="mono">{{ r.symbol }}</span>
                    <span class="feed-outcome">{{ r.outcome }}</span>
                    @if (r.orderId) {
                      <span class="chip ok">order #{{ r.orderId }}</span>
                    } @else if (r.signalId) {
                      <span class="chip">signal #{{ r.signalId }}</span>
                    }
                    <span class="muted small">{{ r.costUsd | number: '1.3-3' }} $</span>
                  </li>
                }
              </ul>
            } @else {
              <p class="muted small">No sweep activity yet.</p>
            }
          </section>
        </div>
      } @else if (loading()) {
        <div class="card muted">Loading configuration…</div>
      }

      <!-- ───────── History ───────── -->
      <section class="card">
        <header class="card-head">
          <h2>Recent sweep runs</h2>
          <span class="muted small">sweep-originated analyses, newest first</span>
        </header>
        @if (history(); as h) {
          @if (h.length > 0) {
            <div class="hist-scroll">
              <table class="hist-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Symbol</th>
                    <th>TF</th>
                    <th>Outcome</th>
                    <th class="num">Conf</th>
                    <th>Signal</th>
                    <th>Order</th>
                    <th>Mode</th>
                    <th class="num">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of h; track r.id) {
                    <tr>
                      <td class="mono nowrap">{{ r.at | date: 'MMM d HH:mm:ss' }}</td>
                      <td class="mono">{{ r.symbol }}</td>
                      <td class="muted">{{ r.timeframe }}</td>
                      <td>
                        <span class="oc" [class]="'oc oc-' + r.outcome">{{ r.outcome }}</span>
                      </td>
                      <td class="num mono">
                        {{ r.confidence !== null ? (r.confidence | number: '1.2-2') : '—' }}
                      </td>
                      <td class="mono">{{ r.signalId ? '#' + r.signalId : '—' }}</td>
                      <td class="mono">
                        @if (r.orderId) {
                          <span class="chip ok">#{{ r.orderId }}</span>
                        } @else {
                          <span class="muted">—</span>
                        }
                      </td>
                      <td>
                        <span class="mode-badge small-badge" [class.live]="r.mode === 'Live'">
                          {{ r.mode }}
                        </span>
                      </td>
                      <td class="num mono">{{ r.costUsd | number: '1.3-3' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else {
            <p class="muted small">No sweep runs recorded yet.</p>
          }
        }
      </section>
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-6) var(--space-8);
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .page-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: var(--space-4);
      }
      h1 {
        margin: 0;
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
      }
      h2 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .muted {
        color: var(--text-secondary);
      }
      .small {
        font-size: var(--text-xs);
      }
      .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .head-actions {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        flex-shrink: 0;
      }
      .mode-badge {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        padding: 4px 10px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .mode-badge.live {
        background: var(--loss);
        color: #fff;
      }
      .power-btn {
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-primary);
        border-radius: var(--radius-full);
        padding: 8px 18px;
        font-weight: var(--font-semibold);
        cursor: pointer;
      }
      .power-btn.on {
        background: var(--profit);
        border-color: var(--profit);
        color: #fff;
      }
      .power-btn:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .banner {
        padding: var(--space-3) var(--space-4);
        border-radius: var(--radius-md);
        font-size: var(--text-sm);
      }
      .banner.error {
        background: rgba(255, 59, 48, 0.12);
        color: var(--loss);
      }
      .banner.warn {
        background: rgba(255, 149, 0, 0.14);
        color: #b25e00;
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-4);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .card-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        margin-top: var(--space-2);
      }
      .status-card {
        gap: var(--space-4);
      }
      .status-head {
        display: flex;
        align-items: center;
        gap: var(--space-3);
      }
      .spacer {
        flex: 1;
      }
      .phase-pill {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        padding: 3px 10px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .phase-pill.analyzing {
        background: rgba(0, 113, 227, 0.15);
        color: var(--accent);
      }
      .phase-pill.cooldown {
        background: rgba(175, 82, 222, 0.15);
        color: #8944b8;
      }
      .counters {
        display: grid;
        grid-template-columns: repeat(7, 1fr);
        gap: var(--space-3);
        margin: 0;
      }
      .counters div {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .counters dt {
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
      }
      .counters dd {
        margin: 0;
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
      }
      @media (max-width: 1100px) {
        .counters {
          grid-template-columns: repeat(4, 1fr);
        }
      }
      .grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-4);
      }
      @media (max-width: 1000px) {
        .grid {
          grid-template-columns: 1fr;
        }
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .field > label {
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        color: var(--text-secondary);
      }
      .field.check label {
        flex-direction: row;
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: var(--text-sm);
        color: var(--text-primary);
        margin-bottom: 4px;
      }
      .sub-label {
        margin: var(--space-2) 0 0;
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .row-2 {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-3);
      }
      input,
      select {
        font: inherit;
        padding: 7px 10px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
      }
      input[type='checkbox'] {
        width: auto;
        padding: 0;
      }
      input[type='range'] {
        padding: 0;
      }
      .seg {
        display: inline-flex;
        border: 1px solid var(--border);
        border-radius: var(--radius-full);
        overflow: hidden;
        width: fit-content;
      }
      .seg button {
        border: none;
        background: var(--bg-primary);
        color: var(--text-secondary);
        padding: 6px 18px;
        cursor: pointer;
        font-weight: var(--font-medium);
      }
      .seg button.active {
        background: var(--accent);
        color: #fff;
      }
      .seg button.live-opt.active {
        background: var(--loss);
      }
      .confirm-live {
        border: 1px solid var(--loss);
        border-radius: var(--radius-md);
        padding: var(--space-3);
        background: rgba(255, 59, 48, 0.06);
      }
      .confirm-live p {
        margin: 0 0 var(--space-2);
        font-size: var(--text-sm);
      }
      .confirm-actions {
        display: flex;
        gap: var(--space-2);
      }
      .tf-row {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        margin-bottom: 6px;
      }
      .linkish {
        border: none;
        background: transparent;
        color: var(--accent);
        cursor: pointer;
        font-size: var(--text-xs);
        padding: 0;
      }
      .pair-check-list {
        list-style: none;
        margin: 0;
        padding: 6px;
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
        gap: 4px 12px;
        max-height: 220px;
        overflow-y: auto;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
      }
      .pair-check-list li {
        display: flex;
      }
      .inline-check {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .acct-list {
        list-style: none;
        margin: 4px 0 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
        max-height: 160px;
        overflow-y: auto;
      }
      .acct-list .chip {
        margin-left: 0;
      }
      button.ghost {
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        border-radius: var(--radius-sm);
        padding: 7px 14px;
        cursor: pointer;
      }
      button.danger {
        border: none;
        background: var(--loss);
        color: #fff;
        border-radius: var(--radius-sm);
        padding: 7px 14px;
        cursor: pointer;
        font-weight: var(--font-semibold);
      }
      .save-btn {
        align-self: flex-start;
        border: none;
        background: var(--accent);
        color: #fff;
        border-radius: var(--radius-full);
        padding: 9px 22px;
        font-weight: var(--font-semibold);
        cursor: pointer;
        margin-top: var(--space-2);
      }
      .save-btn:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .feed {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .feed li {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        font-size: var(--text-xs);
        padding: 4px 0;
        border-bottom: 1px solid var(--border);
      }
      .feed-time {
        color: var(--text-tertiary);
      }
      .feed-outcome {
        color: var(--text-secondary);
      }
      .chip {
        font-size: 10.5px;
        padding: 2px 7px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        margin-left: auto;
      }
      .chip.ok {
        background: rgba(52, 199, 89, 0.16);
        color: var(--profit);
        margin-left: auto;
      }
      .hist-scroll {
        max-height: 360px;
        overflow-y: auto;
      }
      .hist-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-xs);
      }
      .hist-table th,
      .hist-table td {
        padding: 7px var(--space-3);
        text-align: left;
        border-bottom: 1px solid var(--border);
        white-space: nowrap;
      }
      .hist-table th {
        position: sticky;
        top: 0;
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        z-index: 1;
      }
      .hist-table th.num,
      .hist-table td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .hist-table tbody tr:hover {
        background: var(--bg-tertiary);
      }
      .oc {
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        padding: 2px 8px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .oc-SignalCreated {
        background: rgba(52, 199, 89, 0.16);
        color: var(--profit);
      }
      .oc-GateRejected {
        background: rgba(255, 59, 48, 0.14);
        color: var(--loss);
      }
      .oc-Skipped {
        background: rgba(255, 149, 0, 0.14);
        color: #b25e00;
      }
      .small-badge {
        font-size: 10px;
        padding: 2px 7px;
      }
    `,
  ],
})
export class SpotSweepPageComponent {
  private readonly svc = inject(SpotSweepService);
  private readonly accountScope = inject(AccountScopeService);
  private readonly currencyPairs = inject(CurrencyPairsService);

  /** Live (active-EA) accounts, used to populate the scope picker. */
  readonly liveAccounts = this.accountScope.liveAccounts;

  readonly timeframes = ['M5', 'M15', 'M30', 'H1', 'H4', 'D1'];
  readonly barPositions: SweepBarPosition[] = ['closed', 'mid_25', 'mid_50', 'mid_75'];

  readonly config = signal<SpotSweepConfig | null>(null);
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly dirty = signal(false);
  readonly pendingLiveConfirm = signal(false);

  /** Active currency-pair symbols from the catalogue (the checkbox list). */
  readonly availableSymbols = signal<string[]>([]);
  readonly pairsLoading = signal(true);
  /** The single timeframe applied to every swept pair. */
  readonly sweepTimeframe = signal('H1');

  // Rolling activity feed, fed from the polled status' lastResult.
  readonly feed = signal<SweepLastResult[]>([]);
  private lastSeenSignalId: number | null = null;

  private readonly statusResource = createPolledResource(() => this.svc.getStatus(), {
    intervalMs: 5000,
  });
  readonly status = this.statusResource.value;

  private readonly historyResource = createPolledResource(() => this.svc.getHistory(20), {
    intervalMs: 10000,
  });
  readonly history = this.historyResource.value;

  constructor() {
    this.load();
    this.loadCurrencyPairs();
    // Append fresh sweep results to the activity feed as status polls arrive.
    effect(() => {
      const r = this.status()?.lastResult;
      if (r && r.signalId !== null && r.signalId !== this.lastSeenSignalId) {
        this.lastSeenSignalId = r.signalId;
        this.feed.update((f) => [r, ...f].slice(0, 15));
      }
    });
  }

  private load(): void {
    this.loading.set(true);
    this.svc.getConfig().subscribe({
      next: (cfg) => {
        this.config.set(cfg);
        // Seed the timeframe selector from existing pairs (uniform timeframe).
        if (cfg.pairs.length > 0) this.sweepTimeframe.set(cfg.pairs[0].timeframe);
        this.dirty.set(false);
        this.loading.set(false);
      },
      error: () => {
        this.error.set('Could not load sweep configuration.');
        this.loading.set(false);
      },
    });
  }

  /** Loads the active currency-pair symbols that populate the checkbox list. */
  private loadCurrencyPairs(): void {
    this.pairsLoading.set(true);
    this.currencyPairs.list({ currentPage: 1, itemCountPerPage: 500, filter: null }).subscribe({
      next: (res) => {
        const symbols = (res?.data?.data ?? [])
          .filter((p) => p.isActive && p.symbol)
          .map((p) => p.symbol!.toUpperCase())
          .filter((s, i, arr) => arr.indexOf(s) === i)
          .sort();
        this.availableSymbols.set(symbols);
        this.pairsLoading.set(false);
      },
      error: () => this.pairsLoading.set(false),
    });
  }

  patch(partial: Partial<SpotSweepConfig>): void {
    const cur = this.config();
    if (!cur) return;
    this.config.set({ ...cur, ...partial });
    this.dirty.set(true);
  }

  setMode(mode: 'Paper'): void {
    this.pendingLiveConfirm.set(false);
    this.patch({ mode });
  }

  requestLive(): void {
    if (this.config()?.mode === 'Live') return;
    this.pendingLiveConfirm.set(true);
  }
  confirmLive(): void {
    this.pendingLiveConfirm.set(false);
    this.patch({ mode: 'Live' });
  }
  cancelLive(): void {
    this.pendingLiveConfirm.set(false);
  }

  isPairSelected(symbol: string): boolean {
    return this.config()?.pairs.some((p) => p.symbol === symbol) ?? false;
  }

  /** Check → add the symbol at the current timeframe; uncheck → remove it. */
  togglePair(symbol: string): void {
    const cur = this.config();
    if (!cur) return;
    if (cur.pairs.some((p) => p.symbol === symbol)) {
      this.patch({ pairs: cur.pairs.filter((p) => p.symbol !== symbol) });
    } else {
      this.patch({ pairs: [...cur.pairs, { symbol, timeframe: this.sweepTimeframe() }] });
    }
  }

  allPairsSelected(): boolean {
    const syms = this.availableSymbols();
    return syms.length > 0 && syms.every((s) => this.isPairSelected(s));
  }

  toggleAllPairs(): void {
    const cur = this.config();
    if (!cur) return;
    const tf = this.sweepTimeframe();
    this.patch({
      pairs: this.allPairsSelected()
        ? []
        : this.availableSymbols().map((symbol) => ({ symbol, timeframe: tf })),
    });
  }

  /** Single sweep timeframe — applied to every selected pair. */
  setSweepTimeframe(tf: string): void {
    this.sweepTimeframe.set(tf);
    const cur = this.config();
    if (!cur || cur.pairs.length === 0) return;
    this.patch({ pairs: cur.pairs.map((p) => ({ ...p, timeframe: tf })) });
  }

  // ── Account scope ────────────────────────────────────────────────
  isAllActive(): boolean {
    return this.config()?.accountScope === ALL_ACTIVE_SCOPE;
  }
  selectedAccountCount(): number {
    const s = this.config()?.accountScope;
    return Array.isArray(s) ? s.length : 0;
  }
  isAccountSelected(id: number): boolean {
    const s = this.config()?.accountScope;
    return Array.isArray(s) && s.includes(id);
  }
  setAllActive(on: boolean): void {
    // Leaving "all active" seeds the explicit list with every live account so
    // the operator trims down rather than starting from nothing.
    this.patch({
      accountScope: on ? ALL_ACTIVE_SCOPE : this.liveAccounts().map((a) => a.id),
    });
  }
  toggleAccount(id: number): void {
    const s = this.config()?.accountScope;
    const arr = Array.isArray(s) ? [...s] : [];
    const i = arr.indexOf(id);
    if (i >= 0) arr.splice(i, 1);
    else arr.push(id);
    this.patch({ accountScope: arr });
  }

  save(): void {
    const cfg = this.config();
    if (!cfg) return;
    this.saving.set(true);
    this.error.set(null);
    this.svc.saveConfig(cfg).subscribe({
      next: (saved) => {
        this.config.set(saved);
        this.dirty.set(false);
        this.saving.set(false);
        this.statusResource.refresh();
        this.historyResource.refresh();
      },
      error: () => {
        this.error.set('Failed to save configuration.');
        this.saving.set(false);
      },
    });
  }

  /** Start/stop applies immediately (persisted), unlike the rest of the form. */
  toggleEnabled(): void {
    const cfg = this.config();
    if (!cfg) return;
    const next = { ...cfg, enabled: !cfg.enabled };
    this.saving.set(true);
    this.svc.saveConfig(next).subscribe({
      next: (saved) => {
        this.config.set(saved);
        this.dirty.set(false);
        this.saving.set(false);
        this.statusResource.refresh();
        this.historyResource.refresh();
      },
      error: () => {
        this.error.set('Failed to toggle sweep.');
        this.saving.set(false);
      },
    });
  }

  clampInt(v: string, min: number, max: number): number {
    const n = Math.round(Number(v));
    if (Number.isNaN(n)) return min;
    return Math.min(max, Math.max(min, n));
  }
  clampFloat(v: string, min: number, max: number): number {
    const n = Number(v);
    if (Number.isNaN(n)) return min;
    return Math.min(max, Math.max(min, n));
  }
}
