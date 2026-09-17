import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe, PercentPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { PatientTraderService } from '@core/services/patient-trader.service';
import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import { createPolledResource } from '@core/polling/polled-resource';
import {
  DEFAULT_PATIENT_TRADER_CONFIG,
  PatientTraderConfig,
  PatientTraderMarket,
  PatientTraderMode,
  PatientTraderPlan,
  parseOutcome,
  parseScenarios,
} from '@features/patient-trader/patient-trader.types';

/**
 * Patient Trader cockpit — what the agent currently thinks, what it has planned, and whether it
 * is any good.
 *
 * The page leads with the two numbers that decide whether the module is working, rather than with
 * a count of activity: view accuracy (does it read the market at all — answerable before a penny
 * is risked) and fill rate (do its entries ever actually get hit). A busy agent whose entries are
 * never reached looks identical to a productive one on any count of plans written.
 */
@Component({
  selector: 'app-patient-trader-page',
  standalone: true,
  imports: [DatePipe, DecimalPipe, PercentPipe, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Patient Trader</h1>
          <p class="muted">
            A generation-only discretionary agent. It keeps a standing view of each market it
            follows, waits for quiet to break into a large move, and writes a complete plan — entry,
            stop and target — when one does. It never manages a position.
          </p>
        </div>
        @if (config(); as c) {
          <div class="mode-chip" [class.live]="c.mode === 'Live'" [class.off]="!c.enabled">
            {{ c.enabled ? c.mode : 'Disabled' }}
          </div>
        }
      </header>

      <!-- ── The two numbers that matter ─────────────────────────────── -->
      @if (board(); as b) {
        <section class="headline">
          <div class="metric">
            <span class="metric-label">View accuracy</span>
            <span class="metric-value">
              {{
                b.counters.viewAccuracy !== null
                  ? (b.counters.viewAccuracy | percent: '1.0-1')
                  : '—'
              }}
            </span>
            <span class="metric-note">
              {{ b.counters.viewsScored }} scored · {{ b.counters.viewsAbstained }} abstained. Does
              it read the market? Answerable before any money is involved.
            </span>
          </div>
          <div class="metric">
            <span class="metric-label">Fill rate</span>
            <span class="metric-value">
              {{ b.counters.fillRate !== null ? (b.counters.fillRate | percent: '1.0-1') : '—' }}
            </span>
            <span class="metric-note">
              {{ b.counters.entryNotReachedCount }} entries never reached. The failure that looks
              like success.
            </span>
          </div>
          <div class="metric">
            <span class="metric-label">Expectancy</span>
            <span class="metric-value">
              {{
                b.counters.meanRMultiple !== null
                  ? (b.counters.meanRMultiple | number: '1.2-2') + 'R'
                  : '—'
              }}
            </span>
            <span class="metric-note">
              Mean realised R over {{ b.counters.settledLast7Days }} settled, from the position-free
              walk.
            </span>
          </div>
          <div class="metric" [class.warn]="b.counters.nearFloorCount > 0">
            <span class="metric-label">Stops at the floor</span>
            <span class="metric-value">{{ b.counters.nearFloorCount }}</span>
            <span class="metric-note">
              Accepted plans hugging the survivability minimum. A run of these means the agent is
              writing to the checker, not the market.
            </span>
          </div>
        </section>

        <section class="activity">
          <span
            ><b>{{ b.counters.plansLast7Days }}</b> plans (7d)</span
          >
          <span
            ><b>{{ b.counters.declinedLast7Days }}</b> declined</span
          >
          <span
            ><b>{{ b.counters.rejectedLast7Days }}</b> rejected by the checker</span
          >
          <span
            ><b>{{ b.counters.armedPlans }}</b> armed now</span
          >
          <span
            ><b>{{ b.counters.activeMarkets }}</b> markets followed</span
          >
        </section>

        <!-- ── Standing views ───────────────────────────────────────── -->
        <section class="panel">
          <h2>What it currently thinks</h2>
          @if (b.views.length === 0) {
            <p class="empty">
              No views yet. The agent writes one per followed market on its cadence — nothing here
              means it is disabled, has no markets configured, or has not yet reached its first
              interval.
            </p>
          } @else {
            <div class="views">
              @for (v of b.views; track v.id) {
                <article class="view">
                  <header>
                    <span class="sym">{{ v.symbol }} {{ v.timeframe }}</span>
                    <span class="regime">{{ v.regime }}</span>
                    <span
                      class="lean"
                      [class.buy]="v.lean === 'Buy'"
                      [class.sell]="v.lean === 'Sell'"
                      [class.none]="v.lean === 'None'"
                    >
                      {{ v.lean === 'None' ? 'no view' : v.lean }}
                      @if (v.lean !== 'None') {
                        <em>{{ v.confidence | number: '1.2-2' }}</em>
                      }
                    </span>
                    <span class="age muted">{{ v.ageMinutes | number: '1.0-0' }}m ago</span>
                  </header>
                  <p class="narrative">{{ v.narrative }}</p>
                  @if (parseScenarios(v.scenariosJson); as scenarios) {
                    @if (scenarios.length > 0) {
                      <ul class="scenarios">
                        @for (s of scenarios; track $index) {
                          <li>
                            <b>{{ s.trigger }}</b> → {{ s.expectedReaction }}
                            <span class="action">{{ s.myAction }}</span>
                          </li>
                        }
                      </ul>
                    }
                  }
                  @if (v.whatWouldChangeMyMind) {
                    <p class="change-mind">
                      <span class="muted">Would change my mind:</span> {{ v.whatWouldChangeMyMind }}
                    </p>
                  }
                </article>
              }
            </div>
          }
        </section>

        <!-- ── Plans, including the refusals ────────────────────────── -->
        <section class="panel">
          <h2>Plans and refusals</h2>
          <p class="muted small">
            Declines and rejections are shown alongside live plans on purpose — "the setups it
            passed on" is half of what makes a discretionary record readable, and the only way to
            tell a genuinely patient agent from a broken one that never finds anything.
          </p>
          @if (b.plans.length === 0) {
            <p class="empty spaced">Nothing written yet.</p>
          } @else {
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Market</th>
                    <th>Status</th>
                    <th class="num">Entry</th>
                    <th class="num">Stop</th>
                    <th class="num">Target</th>
                    <th class="num">R:R</th>
                    <th class="num">Stop ×ATR</th>
                    <th>Reasoning</th>
                  </tr>
                </thead>
                <tbody>
                  @for (p of b.plans; track p.id) {
                    <tr [class.refused]="isRefused(p)">
                      <td class="nowrap">{{ p.createdAtUtc | date: 'dd MMM HH:mm' }}</td>
                      <td class="nowrap">
                        {{ p.symbol }}
                        @if (p.direction !== 'None') {
                          <span class="dir" [class.buy]="p.direction === 'Buy'">{{
                            p.direction
                          }}</span>
                        }
                      </td>
                      <td>
                        <span class="status" [class]="statusClass(p)">{{ p.status }}</span>
                        @if (p.observeOnly && !isRefused(p)) {
                          <span class="tag">observe-only</span>
                        }
                        @if (p.nearFloor) {
                          <span class="tag warn">at floor</span>
                        }
                      </td>
                      <td class="num">{{ isRefused(p) ? '—' : p.entryPrice }}</td>
                      <td class="num">{{ isRefused(p) ? '—' : p.stopLoss }}</td>
                      <td class="num">{{ isRefused(p) ? '—' : p.takeProfit }}</td>
                      <td class="num">
                        {{ p.rewardRisk ? (p.rewardRisk | number: '1.2-2') : '—' }}
                      </td>
                      <td class="num">
                        {{ p.stopAtrMultiple ? (p.stopAtrMultiple | number: '1.2-2') : '—' }}
                      </td>
                      <td class="reason">
                        @if (p.rejectionReason) {
                          <span class="rejection">{{ p.rejectionReason }}</span>
                        } @else {
                          {{ p.thesis }}
                        }
                        @if (outcomeOf(p); as o) {
                          <span class="outcome">
                            {{ o.outcome }}
                            @if (o.rMultiple !== null && o.rMultiple !== undefined) {
                              · {{ o.rMultiple | number: '1.2-2' }}R
                            }
                            @if (o.mfeR !== null && o.mfeR !== undefined) {
                              · MFE {{ o.mfeR | number: '1.2-2' }}R
                            }
                          </span>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>
      }

      <!-- ── Configuration ─────────────────────────────────────────── -->
      @if (draft(); as d) {
        <section class="panel">
          <h2>Configuration</h2>

          <div class="row">
            <label class="check">
              <input type="checkbox" [(ngModel)]="d.enabled" name="enabled" />
              <span>Enabled</span>
            </label>

            <label>
              <span>Mode</span>
              <select [(ngModel)]="d.mode" name="mode">
                <option value="ForecastOnly">ForecastOnly — views only, writes no plans</option>
                <option value="PlanOnly">PlanOnly — plans and walks them, files nothing</option>
                <option value="Live">Live — files signals into the pipeline</option>
              </select>
            </label>
          </div>

          <p class="muted small">
            Each mode is the gate on the next. Start in ForecastOnly until view accuracy says the
            agent reads the market; move to PlanOnly until the fill rate says its entries are
            reachable. Only then does Live mean anything.
          </p>

          <h3>Markets</h3>
          <p class="muted small">
            Picked from the active currency-pair catalogue, so a market the engine does not know
            cannot be followed by a typo. Each one carries its own timeframe — the agent frames its
            view and its levels on that chart.
          </p>

          <div class="tf-default">
            <label>
              <span>Timeframe for newly added markets</span>
              <select [(ngModel)]="newMarketTimeframe" name="newTf">
                @for (tf of timeframes; track tf) {
                  <option [value]="tf">{{ tf }}</option>
                }
              </select>
            </label>
          </div>

          @if (pairsLoading()) {
            <p class="empty">Loading the currency-pair catalogue…</p>
          } @else if (availableSymbols().length === 0) {
            <p class="empty">
              No active currency pairs found. Add one under Currency Pairs before configuring this
              module.
            </p>
          } @else {
            <div class="pair-grid">
              @for (sym of availableSymbols(); track sym) {
                <label class="pair" [class.selected]="isFollowed(sym)">
                  <input
                    type="checkbox"
                    [checked]="isFollowed(sym)"
                    (change)="toggleMarket(sym)"
                    [name]="'pair-' + sym"
                  />
                  <span class="pair-sym">{{ sym }}</span>
                  @if (marketFor(sym); as m) {
                    <select
                      class="pair-tf"
                      [ngModel]="m.timeframe"
                      (ngModelChange)="setTimeframe(sym, $event)"
                      [name]="'tf-' + sym"
                      (click)="$event.preventDefault()"
                    >
                      @for (tf of timeframes; track tf) {
                        <option [value]="tf">{{ tf }}</option>
                      }
                    </select>
                  }
                </label>
              }
            </div>

            @if (followedCount() > 0) {
              <p class="muted small followed-note">
                Following <b>{{ followedCount() }}</b> market{{ followedCount() === 1 ? '' : 's' }}.
                Start with two or three — the cost and the quality of the writing both tell you
                quickly whether it scales.
              </p>
            }
          }

          <h3>Plan standards</h3>
          <p class="muted small">
            These are <b>rejection criteria</b>, not targets. A plan that breaches any of them is
            refused outright and never adjusted — the agent owns its own levels, so this is what
            prevents an attractive payoff being manufactured from a stop too tight to survive.
          </p>
          <div class="grid">
            <label>
              <span>Min stop ×ATR</span>
              <input type="number" step="0.1" [(ngModel)]="d.minStopAtrMultiple" name="minStop" />
              <small>The single most important number here.</small>
            </label>
            <label>
              <span>Max stop ×ATR</span>
              <input type="number" step="0.1" [(ngModel)]="d.maxStopAtrMultiple" name="maxStop" />
            </label>
            <label>
              <span>Min reward:risk</span>
              <input type="number" step="0.1" [(ngModel)]="d.minRewardRisk" name="minRr" />
              <small>Never met by tightening the stop.</small>
            </label>
            <label>
              <span>Max target ×ATR</span>
              <input type="number" step="0.5" [(ngModel)]="d.maxTargetAtrMultiple" name="maxTgt" />
            </label>
            <label>
              <span>Min confidence</span>
              <input
                type="number"
                step="0.05"
                min="0"
                max="1"
                [(ngModel)]="d.minConfidence"
                name="minConf"
              />
            </label>
          </div>

          <h3>Cadence and limits</h3>
          <div class="grid">
            <label>
              <span>View interval (min)</span>
              <input type="number" [(ngModel)]="d.viewIntervalMinutes" name="viewInt" />
              <small>The cost dial.</small>
            </label>
            <label>
              <span>View horizon (h)</span>
              <input type="number" [(ngModel)]="d.viewHorizonHours" name="viewHor" />
              <small>What accuracy is scored against.</small>
            </label>
            <label>
              <span>Plan expiry (h)</span>
              <input type="number" [(ngModel)]="d.planExpiryHours" name="planExp" />
            </label>
            <label>
              <span>Max open plans / market</span>
              <input type="number" [(ngModel)]="d.maxOpenPlansPerSymbol" name="maxOpen" />
            </label>
            <label>
              <span>Max plans / day</span>
              <input type="number" [(ngModel)]="d.maxPlansPerDay" name="maxDay" />
              <small>A ceiling, not a quota.</small>
            </label>
            <label>
              <span>Catalyst blackout (min before)</span>
              <input type="number" [(ngModel)]="d.catalystBlackoutMinutesBefore" name="blackout" />
              <small>Nothing armed into a major print.</small>
            </label>
            <label>
              <span>Catalyst window (min after)</span>
              <input type="number" [(ngModel)]="d.catalystArmMinutesAfter" name="armAfter" />
            </label>
            <label>
              <span>Daily spend cap (USD)</span>
              <input type="number" step="0.5" [(ngModel)]="d.dailySpendCapUsd" name="spend" />
            </label>
          </div>

          <h3>Memory</h3>
          <div class="row">
            <label class="check">
              <input type="checkbox" [(ngModel)]="d.memoryEnabled" name="mem" />
              <span>Show the agent what it has learned, and which ideas have already failed</span>
            </label>
            <label>
              <span>Lessons in prompt</span>
              <input type="number" [(ngModel)]="d.maxNotesInPrompt" name="notes" />
            </label>
          </div>

          <div class="actions">
            <label class="reason">
              <span>Reason (audit log)</span>
              <input type="text" [(ngModel)]="reason" name="reason" placeholder="why this change" />
            </label>
            <button type="button" class="primary" [disabled]="saving()" (click)="save()">
              {{ saving() ? 'Saving…' : 'Save configuration' }}
            </button>
          </div>

          @if (saveMessage(); as msg) {
            <p class="save-msg">{{ msg }}</p>
          }
        </section>
      }
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
        margin: 0 0 var(--space-2);
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      h3 {
        margin: var(--space-4) 0 var(--space-2);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-secondary);
      }
      .muted {
        color: var(--text-secondary);
        max-width: 78ch;
      }
      .small {
        font-size: var(--text-xs);
      }
      .mode-chip {
        padding: var(--space-1) var(--space-3);
        border-radius: var(--radius-full, 999px);
        background: var(--surface-2);
        border: 1px solid var(--border);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        white-space: nowrap;
      }
      .mode-chip.live {
        background: var(--success-bg, #e6f4ea);
        color: var(--success-fg, #1e6b3a);
      }
      .mode-chip.off {
        opacity: 0.7;
      }

      .headline {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
        gap: var(--space-3);
      }
      .metric {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: var(--radius-md, 6px);
        padding: var(--space-3) var(--space-4);
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }
      .metric.warn {
        border-color: var(--warning-fg, #b8860b);
      }
      .metric-label {
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-secondary);
      }
      .metric-value {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
      }
      .metric-note {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        line-height: 1.4;
      }

      .activity {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-4);
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .activity b {
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }

      .panel {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: var(--radius-md, 6px);
        padding: var(--space-4);
      }
      .empty {
        color: var(--text-secondary);
        font-size: var(--text-sm);
        margin: 0;
        max-width: 78ch;
      }
      /* Separated from the explanatory copy above, which it otherwise reads as a line of. */
      .empty.spaced {
        margin-top: var(--space-3);
      }

      .views {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
        gap: var(--space-3);
      }
      .view {
        border: 1px solid var(--border);
        border-radius: var(--radius-sm, 4px);
        padding: var(--space-3);
      }
      .view header {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: var(--space-2);
        margin-bottom: var(--space-2);
      }
      .sym {
        font-weight: var(--font-semibold);
      }
      .regime {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .lean {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        padding: 0 var(--space-2);
        border-radius: var(--radius-sm, 4px);
        background: var(--surface-2);
      }
      .lean.buy {
        color: var(--success-fg, #1e6b3a);
      }
      .lean.sell {
        color: var(--danger-fg, #a3352c);
      }
      .lean.none {
        color: var(--text-secondary);
      }
      .lean em {
        font-style: normal;
        opacity: 0.75;
        margin-left: var(--space-1);
      }
      .age {
        margin-left: auto;
        font-size: var(--text-xs);
      }
      .narrative {
        margin: 0 0 var(--space-2);
        font-size: var(--text-sm);
        line-height: 1.5;
      }
      .scenarios {
        margin: 0 0 var(--space-2);
        padding-left: var(--space-4);
        font-size: var(--text-xs);
        line-height: 1.5;
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }
      .scenarios .action {
        display: block;
        color: var(--text-secondary);
      }
      .change-mind {
        margin: 0;
        font-size: var(--text-xs);
        line-height: 1.5;
      }

      .table-wrap {
        overflow-x: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-xs);
      }
      th,
      td {
        text-align: left;
        padding: var(--space-2);
        border-bottom: 1px solid var(--border);
        vertical-align: top;
      }
      th {
        color: var(--text-secondary);
        font-weight: var(--font-medium);
        white-space: nowrap;
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .nowrap {
        white-space: nowrap;
      }
      tr.refused {
        opacity: 0.72;
      }
      .status {
        font-weight: var(--font-semibold);
      }
      .status.ok {
        color: var(--success-fg, #1e6b3a);
      }
      .status.bad {
        color: var(--danger-fg, #a3352c);
      }
      .status.neutral {
        color: var(--text-secondary);
      }
      .dir {
        margin-left: var(--space-1);
        color: var(--danger-fg, #a3352c);
      }
      .dir.buy {
        color: var(--success-fg, #1e6b3a);
      }
      .tag {
        display: inline-block;
        margin-left: var(--space-1);
        padding: 0 var(--space-1);
        border-radius: var(--radius-sm, 4px);
        background: var(--surface-2);
        color: var(--text-secondary);
        font-size: 0.68rem;
      }
      .tag.warn {
        color: var(--warning-fg, #8a6516);
      }
      .reason {
        max-width: 46ch;
        line-height: 1.45;
      }
      .rejection {
        color: var(--text-secondary);
        font-style: italic;
      }
      .outcome {
        display: block;
        margin-top: var(--space-1);
        color: var(--text-secondary);
        font-variant-numeric: tabular-nums;
      }

      .row {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-4);
        align-items: flex-end;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
        gap: var(--space-3);
      }
      label {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
        font-size: var(--text-xs);
      }
      label > span {
        color: var(--text-secondary);
      }
      label small {
        color: var(--text-secondary);
        opacity: 0.85;
      }
      label.check {
        flex-direction: row;
        align-items: center;
        gap: var(--space-2);
      }
      input,
      select {
        padding: var(--space-1) var(--space-2);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm, 4px);
        background: var(--surface);
        color: var(--text-primary);
        font: inherit;
      }
      input[type='checkbox'] {
        width: auto;
      }
      .tf-default {
        margin-bottom: var(--space-3);
      }
      /* A flex-column label stretches its control to the container width, which turned a
         four-option dropdown into a full-page-width bar. Controls size to their content
         unless a grid cell is giving them a track. */
      .tf-default label,
      .row label {
        max-width: 24rem;
      }
      .row label.check {
        max-width: none;
      }
      .tf-default select {
        max-width: 9rem;
      }
      .pair-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
        gap: var(--space-2);
      }
      .pair {
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: var(--space-2);
        padding: var(--space-1) var(--space-2);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm, 4px);
        cursor: pointer;
      }
      .pair.selected {
        border-color: var(--accent-fg, #0e6e73);
        background: var(--surface-2);
      }
      .pair-sym {
        font-weight: var(--font-medium);
        font-variant-numeric: tabular-nums;
      }
      .pair-tf {
        margin-left: auto;
        padding: 0 var(--space-1);
        font-size: 0.7rem;
      }
      .followed-note {
        margin-top: var(--space-2);
      }
      .link {
        background: none;
        border: none;
        color: var(--accent-fg, #0e6e73);
        cursor: pointer;
        font: inherit;
        padding: 0;
      }
      .link.danger {
        color: var(--danger-fg, #a3352c);
      }
      .actions {
        display: flex;
        gap: var(--space-3);
        align-items: flex-end;
        margin-top: var(--space-4);
      }
      .actions .reason {
        flex: 1;
        max-width: 42ch;
      }
      button.primary {
        padding: var(--space-2) var(--space-4);
        border-radius: var(--radius-sm, 4px);
        border: 1px solid var(--border);
        background: var(--surface-2);
        cursor: pointer;
        font: inherit;
        font-weight: var(--font-semibold);
      }
      button.primary:disabled {
        opacity: 0.6;
        cursor: default;
      }
      .save-msg {
        margin: var(--space-2) 0 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
    `,
  ],
})
export class PatientTraderPageComponent {
  private readonly svc = inject(PatientTraderService);

  private readonly currencyPairs = inject(CurrencyPairsService);

  readonly timeframes = ['M15', 'H1', 'H4', 'D1'];

  /** Timeframe applied when a market is newly ticked; per-market after that. */
  newMarketTimeframe = 'H1';

  readonly availableSymbols = signal<string[]>([]);
  readonly pairsLoading = signal(true);

  constructor() {
    this.loadCurrencyPairs();
  }

  /**
   * Active symbols from the currency-pair catalogue.
   *
   * The catalogue is the authority on what the engine can actually trade, so following a market is
   * a selection rather than a typed string — a mistyped symbol would otherwise be configured
   * happily and then silently resolve no readings for ever.
   */
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

  readonly parseScenarios = parseScenarios;

  private readonly boardResource = createPolledResource(() => this.svc.getBoard(50), {
    intervalMs: 60_000,
  });
  readonly board = this.boardResource.value;

  private readonly configResource = createPolledResource(() => this.svc.getConfig(), {
    intervalMs: 300_000,
  });
  readonly config = this.configResource.value;

  /**
   * The editable copy.
   *
   * Cloned from the last poll rather than bound to it, so a refresh landing mid-edit cannot
   * silently discard what an operator has typed.
   */
  private readonly localDraft = signal<PatientTraderConfig | null>(null);

  readonly draft = computed<PatientTraderConfig | null>(() => {
    const local = this.localDraft();
    if (local) return local;
    const loaded = this.config();
    return loaded ? structuredClone(loaded) : null;
  });

  readonly saving = signal(false);
  readonly saveMessage = signal<string | null>(null);
  reason = '';

  /** True when this symbol is in the followed set. */
  isFollowed(symbol: string): boolean {
    return this.draft()?.markets.some((m) => m.symbol === symbol) ?? false;
  }

  marketFor(symbol: string): PatientTraderMarket | undefined {
    return this.draft()?.markets.find((m) => m.symbol === symbol);
  }

  followedCount(): number {
    return this.draft()?.markets.length ?? 0;
  }

  /** Adds or removes a market. Ticking it also enables it — following a market you left off would
   * be a confusing half-state on a page where the checkbox IS the decision. */
  toggleMarket(symbol: string): void {
    const current = this.draft();
    if (!current) return;
    const next = structuredClone(current);

    next.markets = next.markets.some((m) => m.symbol === symbol)
      ? next.markets.filter((m) => m.symbol !== symbol)
      : [...next.markets, { symbol, timeframe: this.newMarketTimeframe, enabled: true }];

    this.localDraft.set(next);
  }

  setTimeframe(symbol: string, timeframe: string): void {
    const current = this.draft();
    if (!current) return;
    const next = structuredClone(current);
    next.markets = next.markets.map((m) => (m.symbol === symbol ? { ...m, timeframe } : m));
    this.localDraft.set(next);
  }

  save(): void {
    const current = this.draft();
    if (!current || this.saving()) return;

    // Normalise symbols before they reach the engine — a lower-case entry would silently follow a
    // market the rest of the engine does not recognise.
    const payload = structuredClone(current);
    payload.markets = payload.markets
      .map((m) => ({ ...m, symbol: m.symbol.trim().toUpperCase() }))
      .filter((m) => m.symbol.length > 0);
    payload.mode = payload.mode as PatientTraderMode;

    this.saving.set(true);
    this.saveMessage.set(null);

    this.svc.saveConfig(payload, { reason: this.reason }).subscribe({
      next: (result) => {
        // The PERSISTED state wins — anything governance queued or refused shows its real reading.
        this.localDraft.set(structuredClone(result.config));
        this.saveMessage.set(result.message ?? 'Saved.');
        this.saving.set(false);
        this.reason = '';
        this.configResource.refresh();
        this.boardResource.refresh();
      },
      error: (err: unknown) => {
        this.saveMessage.set(
          err instanceof Error ? err.message : 'Save failed — the configuration was not changed.',
        );
        this.saving.set(false);
      },
    });
  }

  /** A plan the agent or the checker turned down, rather than one that ran. */
  isRefused(plan: PatientTraderPlan): boolean {
    return plan.status === 'Declined' || plan.status === 'Rejected';
  }

  statusClass(plan: PatientTraderPlan): string {
    switch (plan.status) {
      case 'Settled':
      case 'Filled':
        return 'ok';
      case 'Rejected':
        return 'bad';
      default:
        return 'neutral';
    }
  }

  outcomeOf(plan: PatientTraderPlan) {
    return parseOutcome(plan.outcomeJson);
  }

  protected readonly defaults = DEFAULT_PATIENT_TRADER_CONFIG;
}
