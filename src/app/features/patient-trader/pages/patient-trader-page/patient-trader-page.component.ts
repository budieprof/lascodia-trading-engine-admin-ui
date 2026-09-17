import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
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
 * Structure and tokens follow the Spot Sweep page, its sibling module: a status strip of
 * counters, then a two-column body with the configuration form on the left and the read-only
 * panels on the right. The counters lead with the two numbers that decide whether the module is
 * working rather than a count of activity — view accuracy (does it read the market at all, which
 * is answerable before a penny is risked) and fill rate (do its entries ever actually get hit).
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
            Generation-only discretionary agent — keeps a standing view of each market it follows,
            waits for quiet to break into a large move, and writes a complete plan (entry, stop and
            target) when one does. It never manages a position.
          </p>
        </div>
        @if (config(); as c) {
          <div class="head-actions">
            <span class="mode-badge" [class.live]="c.enabled && c.mode === 'Live'">
              {{ c.enabled ? c.mode : 'Disabled' }}
            </span>
          </div>
        }
      </header>

      @if (saveMessage(); as msg) {
        <div class="banner info">{{ msg }}</div>
      }

      <!-- ── Status strip ─────────────────────────────────────────────── -->
      @if (board(); as b) {
        <section class="card status-card">
          <div class="status-head">
            <span class="phase-pill" [class.analyzing]="b.counters.armedPlans > 0">
              {{ b.counters.armedPlans > 0 ? 'Armed' : 'Waiting' }}
            </span>
            <span class="muted small">
              {{ b.counters.activeMarkets }} market{{ b.counters.activeMarkets === 1 ? '' : 's' }}
              followed · last 7 days
            </span>
            <span class="spacer"></span>
            <span class="muted small">
              {{ b.counters.declinedLast7Days }} declined · {{ b.counters.rejectedLast7Days }}
              rejected by the checker
            </span>
          </div>

          <dl class="counters">
            <div>
              <dt>View accuracy</dt>
              <dd>
                {{
                  b.counters.viewAccuracy !== null
                    ? (b.counters.viewAccuracy | percent: '1.0-1')
                    : '—'
                }}
              </dd>
            </div>
            <div>
              <dt>Views scored</dt>
              <dd>{{ b.counters.viewsScored }}</dd>
            </div>
            <div>
              <dt>Abstained</dt>
              <dd>{{ b.counters.viewsAbstained }}</dd>
            </div>
            <div>
              <dt>Fill rate</dt>
              <dd>
                {{ b.counters.fillRate !== null ? (b.counters.fillRate | percent: '1.0-1') : '—' }}
              </dd>
            </div>
            <div>
              <dt>Never reached</dt>
              <dd>{{ b.counters.entryNotReachedCount }}</dd>
            </div>
            <div>
              <dt>Expectancy</dt>
              <dd>
                {{
                  b.counters.meanRMultiple !== null
                    ? (b.counters.meanRMultiple | number: '1.2-2') + 'R'
                    : '—'
                }}
              </dd>
            </div>
            <div>
              <dt>Plans (7d)</dt>
              <dd>{{ b.counters.plansLast7Days }}</dd>
            </div>
            <div>
              <dt>Armed</dt>
              <dd>{{ b.counters.armedPlans }}</dd>
            </div>
            <div>
              <dt>Stops at floor</dt>
              <dd [class.warn-value]="b.counters.nearFloorCount > 0">
                {{ b.counters.nearFloorCount }}
              </dd>
            </div>
          </dl>

          <p class="muted small">
            <b>View accuracy</b> answers whether the agent reads the market, before any money is
            involved — it is the gate on leaving ForecastOnly. <b>Never reached</b> is the failure
            that looks like success: beautiful plans at levels the market never visits.
            <b>Stops at floor</b> counts accepted plans hugging the survivability minimum; a run of
            those means the agent is writing to the checker rather than the market.
          </p>
        </section>
      }

      <div class="cols">
        <!-- ── Configuration ──────────────────────────────────────────── -->
        <div class="col">
          @if (draft(); as d) {
            <section class="card">
              <h2>Configuration</h2>

              <div class="field check">
                <label>
                  <input type="checkbox" [(ngModel)]="d.enabled" name="enabled" />
                  <span>Enabled</span>
                </label>
              </div>

              <div class="field">
                <label for="pt-mode">Mode</label>
                <select id="pt-mode" [(ngModel)]="d.mode" name="mode">
                  <option value="ForecastOnly">ForecastOnly — views only, writes no plans</option>
                  <option value="PlanOnly">PlanOnly — plans and walks them, files nothing</option>
                  <option value="Live">Live — files signals into the pipeline</option>
                </select>
                <p class="muted small">
                  Each mode is the gate on the next. Start in ForecastOnly until view accuracy says
                  the agent reads the market; move to PlanOnly until the fill rate says its entries
                  are reachable. Only then does Live mean anything.
                </p>
              </div>

              <p class="sub-label">Markets</p>
              <div class="tf-row">
                <span class="muted small">{{ followedCount() }} selected</span>
                <select
                  class="tf-select"
                  [(ngModel)]="newMarketTimeframe"
                  name="newTf"
                  title="Timeframe applied to newly ticked markets"
                >
                  @for (tf of timeframes; track tf) {
                    <option [value]="tf">{{ tf }}</option>
                  }
                </select>
                <span class="spacer"></span>
                @if (followedCount() > 0) {
                  <button type="button" class="linkish" (click)="clearMarkets()">Clear all</button>
                }
              </div>

              @if (pairsLoading()) {
                <p class="muted small">Loading currency pairs…</p>
              } @else if (availableSymbols().length === 0) {
                <p class="muted small">No active currency pairs found in the catalogue.</p>
              } @else {
                <ul class="pair-check-list">
                  @for (sym of availableSymbols(); track sym) {
                    <li class="pair-row">
                      <label class="inline-check">
                        <input
                          type="checkbox"
                          [checked]="isFollowed(sym)"
                          (change)="toggleMarket(sym)"
                        />
                        <span class="mono">{{ sym }}</span>
                      </label>
                      @if (marketFor(sym); as m) {
                        <select
                          class="tf-chip"
                          [ngModel]="m.timeframe"
                          (ngModelChange)="setTimeframe(sym, $event)"
                          [name]="'tf-' + sym"
                        >
                          @for (tf of timeframes; track tf) {
                            <option [value]="tf">{{ tf }}</option>
                          }
                        </select>
                      }
                    </li>
                  }
                </ul>
                <p class="muted small">
                  Picked from the active catalogue, so a market the engine does not know cannot be
                  followed by a typo. Start with two or three.
                </p>
              }

              <p class="sub-label">Plan standards</p>
              <p class="muted small">
                These are <b>rejection criteria</b>, not targets. A plan breaching any of them is
                refused outright and never adjusted — the agent owns its own levels, so this is what
                prevents an attractive payoff being manufactured from a stop too tight to survive.
              </p>
              <div class="row-2">
                <div class="field">
                  <label for="pt-minstop">Min stop ×ATR</label>
                  <input
                    id="pt-minstop"
                    type="number"
                    step="0.1"
                    [(ngModel)]="d.minStopAtrMultiple"
                    name="minStop"
                  />
                  <p class="muted small">The single most important number here.</p>
                </div>
                <div class="field">
                  <label for="pt-maxstop">Max stop ×ATR</label>
                  <input
                    id="pt-maxstop"
                    type="number"
                    step="0.1"
                    [(ngModel)]="d.maxStopAtrMultiple"
                    name="maxStop"
                  />
                </div>
                <div class="field">
                  <label for="pt-minrr">Min reward:risk</label>
                  <input
                    id="pt-minrr"
                    type="number"
                    step="0.1"
                    [(ngModel)]="d.minRewardRisk"
                    name="minRr"
                  />
                  <p class="muted small">Never met by tightening the stop.</p>
                </div>
                <div class="field">
                  <label for="pt-maxtgt">Max target ×ATR</label>
                  <input
                    id="pt-maxtgt"
                    type="number"
                    step="0.5"
                    [(ngModel)]="d.maxTargetAtrMultiple"
                    name="maxTgt"
                  />
                </div>
                <div class="field">
                  <label for="pt-minconf">Min confidence</label>
                  <input
                    id="pt-minconf"
                    type="number"
                    step="0.05"
                    min="0"
                    max="1"
                    [(ngModel)]="d.minConfidence"
                    name="minConf"
                  />
                </div>
                <div class="field">
                  <label for="pt-noise">Stop beyond noise (×)</label>
                  <input
                    id="pt-noise"
                    type="number"
                    step="0.1"
                    [(ngModel)]="d.stopNoiseMultiple"
                    name="noise"
                  />
                  <p class="muted small">1.0 = just outside what this market routinely does.</p>
                </div>
                <div class="field">
                  <label for="pt-spread">Spread cost (×)</label>
                  <input
                    id="pt-spread"
                    type="number"
                    step="0.5"
                    [(ngModel)]="d.spreadCostMultiple"
                    name="spread"
                  />
                  <p class="muted small">Charged before the payoff is judged. 2 = in and out.</p>
                </div>
                <div class="field">
                  <label for="pt-lookback">Evidence lookback (bars)</label>
                  <input
                    id="pt-lookback"
                    type="number"
                    step="100"
                    [(ngModel)]="d.evidenceLookbackBars"
                    name="lookback"
                  />
                  <p class="muted small">Long on purpose — a short window caps reach.</p>
                </div>
                <div class="field">
                  <label for="pt-corr">Max correlated plans</label>
                  <input
                    id="pt-corr"
                    type="number"
                    [(ngModel)]="d.maxCorrelatedPlans"
                    name="corr"
                  />
                  <p class="muted small">One dollar bet placed three times is still one bet.</p>
                </div>
              </div>

              <div class="field check">
                <label>
                  <input type="checkbox" [(ngModel)]="d.requireStopStructure" name="structure" />
                  <span>Stop must sit beyond a real swing, not float in mid-range</span>
                </label>
              </div>
              <div class="field check">
                <label>
                  <input type="checkbox" [(ngModel)]="d.respectKillSwitch" name="kill" />
                  <span>Stand down entirely while the fleet kill switch is thrown</span>
                </label>
              </div>

              <p class="sub-label">Conviction</p>
              <div class="row-2">
                <div class="field">
                  <label for="pt-hcrr">High conviction extra R:R</label>
                  <input
                    id="pt-hcrr"
                    type="number"
                    step="0.1"
                    [(ngModel)]="d.highConvictionRewardRiskBonus"
                    name="hcrr"
                  />
                  <p class="muted small">
                    A tier that costs nothing to claim ends up on every plan.
                  </p>
                </div>
                <div class="field">
                  <label for="pt-hcconf">High conviction min confidence</label>
                  <input
                    id="pt-hcconf"
                    type="number"
                    step="0.05"
                    min="0"
                    max="1"
                    [(ngModel)]="d.highConvictionMinConfidence"
                    name="hcconf"
                  />
                </div>
              </div>

              <p class="sub-label">Cadence and limits</p>
              <div class="row-2">
                <div class="field">
                  <label for="pt-vi">View interval (min)</label>
                  <input id="pt-vi" type="number" [(ngModel)]="d.viewIntervalMinutes" name="vi" />
                  <p class="muted small">The cost dial.</p>
                </div>
                <div class="field">
                  <label for="pt-vh">View horizon (h)</label>
                  <input id="pt-vh" type="number" [(ngModel)]="d.viewHorizonHours" name="vh" />
                  <p class="muted small">What accuracy is scored against.</p>
                </div>
                <div class="field">
                  <label for="pt-pe">Plan expiry (h)</label>
                  <input id="pt-pe" type="number" [(ngModel)]="d.planExpiryHours" name="pe" />
                </div>
                <div class="field">
                  <label for="pt-mo">Max open plans / market</label>
                  <input id="pt-mo" type="number" [(ngModel)]="d.maxOpenPlansPerSymbol" name="mo" />
                </div>
                <div class="field">
                  <label for="pt-md">Max plans / day</label>
                  <input id="pt-md" type="number" [(ngModel)]="d.maxPlansPerDay" name="md" />
                  <p class="muted small">A ceiling, not a quota.</p>
                </div>
                <div class="field">
                  <label for="pt-cb">Catalyst blackout (min before)</label>
                  <input
                    id="pt-cb"
                    type="number"
                    [(ngModel)]="d.catalystBlackoutMinutesBefore"
                    name="cb"
                  />
                  <p class="muted small">Nothing armed into a major print.</p>
                </div>
                <div class="field">
                  <label for="pt-ca">Catalyst window (min after)</label>
                  <input
                    id="pt-ca"
                    type="number"
                    [(ngModel)]="d.catalystArmMinutesAfter"
                    name="ca"
                  />
                </div>
                <div class="field">
                  <label for="pt-sc">Daily spend cap (USD)</label>
                  <input
                    id="pt-sc"
                    type="number"
                    step="0.5"
                    [(ngModel)]="d.dailySpendCapUsd"
                    name="sc"
                  />
                </div>
                <div class="field">
                  <label for="pt-pmsc">Per-market cap (USD)</label>
                  <input
                    id="pt-pmsc"
                    type="number"
                    step="0.5"
                    [(ngModel)]="d.perMarketDailySpendCapUsd"
                    name="pmsc"
                  />
                  <p class="muted small">
                    Stops the earliest catalyst eating the day. 0 = shared pot.
                  </p>
                </div>
              </div>

              <p class="sub-label">Memory</p>
              <div class="field check">
                <label>
                  <input type="checkbox" [(ngModel)]="d.memoryEnabled" name="mem" />
                  <span>Show past lessons, and which ideas have already failed</span>
                </label>
              </div>
              <div class="field">
                <label for="pt-notes">Lessons in prompt</label>
                <input id="pt-notes" type="number" [(ngModel)]="d.maxNotesInPrompt" name="notes" />
              </div>

              <p class="sub-label">Prompt experiment</p>
              <div class="field">
                <label for="pt-variant">View prompt</label>
                <select id="pt-variant" [(ngModel)]="d.promptVariant" name="variant">
                  <option value="a">a — control</option>
                  <option value="b">b — argue the other side first</option>
                  <option value="split">split — run both and compare</option>
                </select>
                <p class="muted small">
                  The arm is recorded on every view, so accuracy can be split by it.
                </p>
              </div>

              <div class="field">
                <label for="pt-reason">Reason (audit log)</label>
                <input
                  id="pt-reason"
                  type="text"
                  [(ngModel)]="reason"
                  name="reason"
                  placeholder="why this change"
                />
              </div>

              <button type="button" class="save-btn" [disabled]="saving()" (click)="save()">
                {{ saving() ? 'Saving…' : 'Save configuration' }}
              </button>
            </section>
          }
        </div>

        <!-- ── Views + plans ──────────────────────────────────────────── -->
        <div class="col">
          @if (board(); as b) {
            <section class="card">
              <h2>What it currently thinks</h2>
              @if (b.views.length === 0) {
                <p class="muted small">
                  No views yet. The agent writes one per followed market on its cadence — nothing
                  here means it is disabled, has no markets configured, or has not yet reached its
                  first interval.
                </p>
              } @else {
                @for (v of b.views; track v.id) {
                  <article class="view">
                    <header>
                      <span class="mono">{{ v.symbol }} {{ v.timeframe }}</span>
                      <span class="muted small">{{ v.regime }}</span>
                      <span
                        class="lean-pill"
                        [class.buy]="v.lean === 'Buy'"
                        [class.sell]="v.lean === 'Sell'"
                      >
                        {{ v.lean === 'None' ? 'no view' : v.lean }}
                        @if (v.lean !== 'None') {
                          · {{ v.confidence | number: '1.2-2' }}
                        }
                      </span>
                      <span class="spacer"></span>
                      <span class="muted small">{{ v.ageMinutes | number: '1.0-0' }}m ago</span>
                    </header>
                    <p class="narrative">{{ v.narrative }}</p>
                    @if (parseScenarios(v.scenariosJson); as scenarios) {
                      @if (scenarios.length > 0) {
                        <ul class="scenarios">
                          @for (s of scenarios; track $index) {
                            <li>
                              <b>{{ s.trigger }}</b> → {{ s.expectedReaction }}
                              <span class="muted">{{ s.myAction }}</span>
                            </li>
                          }
                        </ul>
                      }
                    }
                    @if (v.whatWouldChangeMyMind) {
                      <p class="muted small">Would change my mind: {{ v.whatWouldChangeMyMind }}</p>
                    }
                  </article>
                }
              }
            </section>

            <section class="card">
              <h2>Plans and refusals</h2>
              <p class="muted small">
                Declines and rejections are shown alongside live plans on purpose — "the setups it
                passed on" is half of what makes a discretionary record readable, and the only way
                to tell a genuinely patient agent from a broken one that never finds anything.
              </p>
              @if (b.plans.length === 0) {
                <p class="muted small">Nothing written yet.</p>
              } @else {
                <div class="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Market</th>
                        <th>Status</th>
                        <th class="num">R:R</th>
                        <th class="num">Stop ×ATR</th>
                        <th>Reasoning</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (p of b.plans; track p.id) {
                        <tr [class.refused]="isRefused(p)">
                          <td class="nowrap">{{ p.createdAtUtc | date: 'dd MMM HH:mm' }}</td>
                          <td class="nowrap mono">
                            {{ p.symbol }}
                            @if (p.direction !== 'None') {
                              <span class="dir" [class.buy]="p.direction === 'Buy'">{{
                                p.direction
                              }}</span>
                            }
                          </td>
                          <td>
                            <span class="status" [class]="statusClass(p)">{{ p.status }}</span>
                            @if (p.nearFloor) {
                              <span class="floor-tag" title="Stop hugging the survivability minimum"
                                >floor</span
                              >
                            }
                            @if (p.conviction === 'High') {
                              <span
                                class="conviction-tag"
                                title="Backed above the ordinary bar — tracked separately"
                                >high</span
                              >
                            }
                          </td>
                          <td class="num">
                            {{ p.rewardRisk ? (p.rewardRisk | number: '1.2-2') : '—' }}
                          </td>
                          <td class="num">
                            {{ p.stopAtrMultiple ? (p.stopAtrMultiple | number: '1.2-2') : '—' }}
                          </td>
                          <td class="reason">
                            @if (p.rejectionReason) {
                              <span class="muted">{{ p.rejectionReason }}</span>
                            } @else {
                              {{ p.thesis }}
                            }
                            @if (p.preMortem) {
                              <span class="premortem muted" title="Named before the plan was armed">
                                How it dies: {{ p.preMortem }}
                              </span>
                            }
                            @if (p.invalidationPrice) {
                              <span
                                class="premortem muted"
                                title="Abandoned before entry if price reaches this"
                              >
                                Abandon at {{ p.invalidationPrice }}
                              </span>
                            }
                            @if (outcomeOf(p); as o) {
                              <span class="outcome muted">
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
        </div>
      </div>
    </div>
  `,
  styles: [
    `
      /* Tokens and structure follow the Spot Sweep page so the two siblings read as one
         product. An earlier pass invented token names (--surface, --accent-fg) that do not
         exist in the design system, so every colour silently fell back to a hardcoded hex
         and the page drifted away from the rest of the console. */
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
      .spacer {
        flex: 1;
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
        background: rgba(0, 113, 227, 0.16);
        color: var(--accent);
      }
      .banner {
        padding: var(--space-3) var(--space-4);
        border-radius: var(--radius-md);
        font-size: var(--text-sm);
      }
      .banner.info {
        background: rgba(0, 122, 255, 0.1);
        color: var(--accent, #0a66c2);
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
      .status-card {
        gap: var(--space-4);
      }
      .status-head {
        display: flex;
        align-items: center;
        gap: var(--space-3);
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
      .counters {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
        gap: var(--space-4) var(--space-3);
        margin: 0;
      }
      .counters div {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
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
        font-variant-numeric: tabular-nums;
      }
      .counters dd.warn-value {
        color: #b45309;
      }

      .cols {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-4);
        align-items: start;
      }
      .col {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
        min-width: 0;
      }
      @media (max-width: 1000px) {
        .cols {
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
      }
      .field p {
        margin: 0;
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
      .linkish {
        border: none;
        background: transparent;
        color: var(--accent);
        cursor: pointer;
        font-size: var(--text-xs);
        padding: 0;
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

      .tf-row {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        margin-bottom: 6px;
      }
      .tf-select {
        padding: 4px 8px;
        font-size: var(--text-xs);
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
      .pair-row {
        align-items: center;
        justify-content: space-between;
        gap: 6px;
      }
      .inline-check {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: var(--text-sm);
        cursor: pointer;
      }
      /* The per-market timeframe, sized as a chip so a followed row stays the same height as
         an unfollowed one and the grid does not go ragged. */
      .tf-chip {
        flex: none;
        padding: 1px 4px;
        font-size: 10px;
        border-radius: var(--radius-sm);
        background: var(--bg-secondary);
        color: var(--text-secondary);
      }

      .view {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
      }
      .view header {
        display: flex;
        align-items: baseline;
        gap: var(--space-2);
      }
      .lean-pill {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        padding: 2px 8px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .lean-pill.buy {
        background: rgba(52, 199, 89, 0.16);
        color: var(--profit, #15803d);
      }
      .lean-pill.sell {
        background: rgba(255, 59, 48, 0.14);
        color: var(--loss, #b91c1c);
      }
      .narrative {
        margin: 0;
        font-size: var(--text-sm);
        line-height: 1.5;
      }
      .scenarios {
        margin: 0;
        padding-left: var(--space-4);
        font-size: var(--text-xs);
        line-height: 1.5;
        display: flex;
        flex-direction: column;
        gap: 2px;
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
        padding: 6px 8px;
        border-bottom: 1px solid var(--border);
        vertical-align: top;
      }
      th {
        color: var(--text-tertiary);
        font-weight: var(--font-medium);
        text-transform: uppercase;
        font-size: 10.5px;
        letter-spacing: 0.04em;
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
        opacity: 0.7;
      }
      .status {
        font-weight: var(--font-semibold);
      }
      .status.ok {
        color: var(--profit, #15803d);
      }
      .status.bad {
        color: var(--loss, #b91c1c);
      }
      .status.neutral {
        color: var(--text-secondary);
      }
      .dir {
        margin-left: 4px;
        color: var(--loss, #b91c1c);
      }
      .dir.buy {
        color: var(--profit, #15803d);
      }
      .floor-tag {
        margin-left: 4px;
        padding: 1px 6px;
        border-radius: var(--radius-full);
        background: rgba(234, 179, 8, 0.15);
        color: #b45309;
        font-size: 10px;
        font-weight: var(--font-semibold);
      }
      .conviction-tag {
        display: inline-block;
        margin-left: 6px;
        padding: 1px 6px;
        border-radius: var(--radius-full);
        background: color-mix(in srgb, var(--accent) 16%, transparent);
        color: var(--accent);
        font-size: 10px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      /* Its own line: the pre-mortem is a sentence, not a badge, and inlining it
         beside the thesis made both unreadable. */
      .premortem {
        display: block;
        margin-top: 3px;
        font-size: 11px;
        font-style: italic;
      }
      .reason {
        max-width: 42ch;
        line-height: 1.45;
      }
      .outcome {
        display: block;
        margin-top: 2px;
        font-variant-numeric: tabular-nums;
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

  /**
   * The board is push-driven. The interval is a long fallback that only heals a missed push or a
   * reconnect gap — an interval short enough to feel live is also short enough to repaint the
   * page under an operator mid-edit, which is what polling did here before.
   */
  private readonly boardResource = createPolledResource(() => this.svc.getBoard(50), {
    intervalMs: 600_000,
    refreshOn: ['patientTraderChanged'],
  });
  readonly board = this.boardResource.value;

  /**
   * Configuration never refetches on its own.
   *
   * It is operator-owned: nothing in the engine changes it, so a background refetch can only ever
   * arrive while somebody is typing into the form it would replace. Fetched once, and refreshed
   * explicitly after a save so the persisted state — including anything governance queued or
   * refused — is what ends up on screen.
   */
  private readonly configResource = createPolledResource(() => this.svc.getConfig(), {
    intervalMs: 0,
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

    // Seeded from the first load and then owned outright. Returning a fresh clone of config()
    // each time looks equivalent, but the form binds straight into the returned object — so any
    // re-emit of config() would hand back a new clone and silently discard whatever had been
    // typed into the old one.
    const loaded = this.config();
    return loaded ? structuredClone(loaded) : null;
  });

  /** Adopts the first loaded config as the editable copy, once. */
  private readonly seedDraft = effect(() => {
    const loaded = this.config();
    if (loaded && this.localDraft() === null) {
      this.localDraft.set(structuredClone(loaded));
    }
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

  /** Stops following every market. The tick list has no other bulk action. */
  clearMarkets(): void {
    const current = this.draft();
    if (!current) return;
    const next = structuredClone(current);
    next.markets = [];
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
