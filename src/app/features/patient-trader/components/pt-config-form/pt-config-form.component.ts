import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  model,
  output,
  signal,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import type {
  PatientTraderConfig,
  PatientTraderHealth,
  PatientTraderMode,
} from '@features/patient-trader/patient-trader.types';
import {
  effectiveMode,
  isCustomInstruction,
  toPips,
} from '@features/patient-trader/patient-trader.logic';

/** A partial change to the draft; the container applies it immutably. */
export type ConfigPatch = Partial<PatientTraderConfig>;

/**
 * The configuration form. Presentational: it reads the draft and emits patches, so the container
 * owns the draft, the dirty check and the save (and the route guard can ask the page).
 *
 * Settings that only the Classic engine reads are grouped under one section that is collapsed
 * unless Classic is in use — on the Assistant engine they do nothing, and showing them as if they
 * did was the most misleading part of the old page.
 */
@Component({
  selector: 'app-pt-config-form',
  standalone: true,
  imports: [DecimalPipe, FormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let d = draft();
    <!-- PUT patient-trader/config needs platform.engine.manage; without it the form is read-only
         (a disabled fieldset disables every control inside). -->
    <fieldset class="ro-fieldset" [disabled]="!canManage()">
      <section class="card" aria-label="Configuration">
        <div class="row">
          <h2>Configuration</h2>
          <span class="spacer"></span>
          @if (dirty()) {
            <span class="tag warn" role="status">Unsaved changes</span>
          }
        </div>
        @if (!canManage()) {
          <p class="muted small">
            Read-only — changing the Patient Trader needs the platform.engine.manage permission.
          </p>
        }

        <div class="field check">
          <label>
            <input
              type="checkbox"
              [ngModel]="d.enabled"
              (ngModelChange)="set('enabled', $event)"
              name="enabled"
            />
            <span>Switched on</span>
          </label>
        </div>

        <div class="field">
          <label for="pt-mode">Mode</label>
          <select id="pt-mode" [ngModel]="d.mode" (ngModelChange)="set('mode', $event)" name="mode">
            <option value="ForecastOnly">ForecastOnly — views only, no plans</option>
            <option value="PlanOnly">PlanOnly — plans on paper, files nothing</option>
            <option value="Live">Live — files real signals</option>
          </select>
          <p class="muted small">
            Each mode is the gate on the next: stay in ForecastOnly until view accuracy says the
            agent reads the market, and in PlanOnly until the fill rate says its entries are
            reachable. A market can be given its own mode below, but never one further than this.
          </p>
        </div>

        <div class="field">
          <label for="pt-engine">Analysis engine</label>
          <select
            id="pt-engine"
            [ngModel]="d.analysisEngine"
            (ngModelChange)="set('analysisEngine', $event)"
            name="analysisEngine"
          >
            <option value="Assistant">Assistant — a card per idea, each watched</option>
            <option value="Classic">Classic — one view and at most one plan</option>
          </select>
          <p class="muted small">
            <b>Assistant</b> reads the market the way the console assistant does and writes a
            recommendation card for every idea worth having, each with the price condition that
            should trigger it. Every card is armed as a watch. When a watch fires, the signal the
            card becomes is judged by the <a routerLink="/viability-gates">viability gates</a> at
            that moment — so a card can be armed and still be refused when it fires. Alternatives
            can be grouped so the first to fire cancels the others.
          </p>
        </div>

        @if (!isClassic()) {
          <div class="row-2">
            <div class="field">
              <label for="pt-maxcards">Max cards per market</label>
              <input
                id="pt-maxcards"
                type="number"
                min="1"
                max="6"
                [ngModel]="d.maxCardsPerAnalysis"
                (ngModelChange)="set('maxCardsPerAnalysis', $event)"
                name="maxCardsPerAnalysis"
              />
            </div>
            <div class="field">
              <label for="pt-watchh">Card watch life (hours)</label>
              <input
                id="pt-watchh"
                type="number"
                min="1"
                max="72"
                [ngModel]="d.cardWatchExpiryHours"
                (ngModelChange)="set('cardWatchExpiryHours', $event)"
                name="cardWatchExpiryHours"
              />
            </div>
            <div class="field">
              <label for="pt-resumes">Max resumes per analysis</label>
              <input
                id="pt-resumes"
                type="number"
                min="0"
                max="30"
                [ngModel]="d.analysisMaxResumes"
                (ngModelChange)="set('analysisMaxResumes', $event)"
                name="analysisMaxResumes"
              />
            </div>
            <div class="field">
              <label for="pt-analyst">Run as admin id (0 = oldest)</label>
              <input
                id="pt-analyst"
                type="number"
                min="0"
                max="1000000"
                [ngModel]="d.analystAdminUserId"
                (ngModelChange)="set('analystAdminUserId', $event)"
                name="analystAdminUserId"
              />
            </div>
          </div>

          <div class="field">
            <div class="instr-head">
              <label for="pt-instruction">Analysis instruction</label>
              <span class="instr-tag" [class.custom]="customInstruction()">
                {{ customInstruction() ? 'Custom' : 'Built-in' }}
              </span>
              <span class="spacer"></span>
              @if (customInstruction()) {
                <button type="button" class="linkish" (click)="resetInstruction()">
                  Reset to default
                </button>
              }
            </div>
            <textarea
              id="pt-instruction"
              rows="6"
              [maxlength]="instructionMaxLength"
              [ngModel]="d.analysisInstruction"
              (ngModelChange)="set('analysisInstruction', $event)"
              name="analysisInstruction"
              [placeholder]="d.defaultAnalysisInstruction ?? ''"
            ></textarea>
            <p class="muted small">
              What the assistant is asked to do for each market. Use
              <code>{{ '{' }}symbol{{ '}' }}</code> and <code>{{ '{' }}timeframe{{ '}' }}</code> for
              the market being read. The engine always adds the mode, the cards already being
              watched and the gate limits after it. Applies from the next analysis.
              {{ d.analysisInstruction.length }} / {{ instructionMaxLength }}
            </p>
          </div>

          <details class="cfg-group">
            <summary class="sub-label">Limits a card's signal is held to now</summary>
            <p class="muted small">
              Read-only. These are the enforced viability-gate limits for each market as measured
              now, in pips — the numbers a card's signal must meet when its watch fires. Change them
              on the <a routerLink="/viability-gates">Viability Gates</a> page.
            </p>
            @if (limitRows().length === 0) {
              <p class="muted small">
                No limits to show — no market is followed, the health check has not loaded, or no
                gate is enforced.
              </p>
            } @else {
              <div class="table-wrap">
                <table class="limits">
                  <thead>
                    <tr>
                      <th>Market</th>
                      <th>Side</th>
                      <th class="n">Min stop</th>
                      <th class="n">Max stop</th>
                      <th class="n">Max target</th>
                      <th class="n">Noise</th>
                      <th class="n">Reach</th>
                      <th>Swing stop</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (r of limitRows(); track r.key) {
                      <tr>
                        <td class="mono">
                          @if (r.first) {
                            {{ r.symbol }}
                            <div class="muted">
                              ATR {{ r.atrPips }} pips
                              @if (r.minRr !== null) {
                                · R:R ≥ {{ r.minRr | number: '1.1-2' }}
                              }
                              @if (r.minConf !== null) {
                                · conf ≥ {{ r.minConf | number: '1.2-2' }}
                              }
                            </div>
                          }
                        </td>
                        <td>{{ r.side }}</td>
                        <td class="n">{{ r.minStop }}</td>
                        <td class="n">{{ r.maxStop }}</td>
                        <td class="n">{{ r.maxTarget }}</td>
                        <td class="n">{{ r.noise }}</td>
                        <td class="n">{{ r.reach }}</td>
                        <td>{{ r.structure ? 'required' : '—' }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          </details>
        }

        <details class="cfg-group" open>
          <summary class="sub-label">Markets</summary>
          <div class="tf-row">
            <span class="muted small">{{ followed().size }} selected</span>
            <select
              class="tf-select"
              [ngModel]="newMarketTimeframe()"
              (ngModelChange)="newMarketTimeframe.set($event)"
              name="newTf"
              title="Timeframe given to a newly ticked market"
              aria-label="Timeframe for newly ticked markets"
            >
              @for (tf of timeframes; track tf) {
                <option [value]="tf">{{ tf }}</option>
              }
            </select>
            <span class="spacer"></span>
            @if (followed().size > 0) {
              <button type="button" class="linkish" (click)="patch.emit({ markets: [] })">
                Clear all
              </button>
            }
          </div>

          @if (pairsLoading()) {
            <p class="muted small">Loading currency pairs…</p>
          } @else if (symbolList().length === 0) {
            <p class="muted small">No active currency pairs found in the catalogue.</p>
          } @else {
            <ul class="pair-check-list">
              @for (sym of symbolList(); track sym) {
                @let m = followed().get(sym);
                <li class="pair-row" [class.on]="!!m">
                  <label class="inline-check">
                    <input type="checkbox" [checked]="!!m" (change)="toggleMarket(sym)" />
                    <span class="mono">{{ sym }}</span>
                  </label>
                  @if (m) {
                    <span class="market-ctl">
                      <select
                        class="chip"
                        [ngModel]="m.timeframe"
                        (ngModelChange)="setMarket(sym, { timeframe: $event })"
                        [name]="'tf-' + sym"
                        [attr.aria-label]="sym + ' timeframe'"
                      >
                        @for (tf of timeframes; track tf) {
                          <option [value]="tf">{{ tf }}</option>
                        }
                      </select>
                      <select
                        class="chip"
                        [class.live]="effective(m.mode) === 'Live'"
                        [ngModel]="m.mode ?? ''"
                        (ngModelChange)="setMarket(sym, { mode: $event || null })"
                        [name]="'mode-' + sym"
                        [attr.aria-label]="sym + ' mode'"
                        [title]="'Runs as ' + effective(m.mode)"
                      >
                        <option value="">Module mode</option>
                        <option value="ForecastOnly">ForecastOnly</option>
                        <option value="PlanOnly">PlanOnly</option>
                        <option value="Live">Live</option>
                      </select>
                    </span>
                  }
                </li>
              }
            </ul>
            <p class="muted small">
              Picked from the active catalogue, so a typo cannot follow a market the engine does not
              know. A market's own mode can hold it back (for example PlanOnly while the rest run
              Live); it can never take it further than the module's mode.
            </p>
          }
        </details>

        <details class="cfg-group">
          <summary class="sub-label">Cadence, spend and safety</summary>
          <div class="row-2">
            <div class="field">
              <label for="pt-vi">Look every (minutes)</label>
              <input
                id="pt-vi"
                type="number"
                min="5"
                max="1440"
                [ngModel]="d.viewIntervalMinutes"
                (ngModelChange)="set('viewIntervalMinutes', $event)"
                name="vi"
              />
              <p class="muted small">The main cost dial.</p>
            </div>
            <div class="field">
              <label for="pt-vh">View scored after (hours)</label>
              <input
                id="pt-vh"
                type="number"
                min="1"
                max="168"
                [ngModel]="d.viewHorizonHours"
                (ngModelChange)="set('viewHorizonHours', $event)"
                name="vh"
              />
            </div>
            <div class="field">
              <label for="pt-md">Max armed analyses / day</label>
              <input
                id="pt-md"
                type="number"
                min="0"
                max="200"
                [ngModel]="d.maxPlansPerDay"
                (ngModelChange)="set('maxPlansPerDay', $event)"
                name="md"
              />
              <p class="muted small">A ceiling, not a quota.</p>
            </div>
            <div class="field">
              <label for="pt-corr">Max correlated plans</label>
              <input
                id="pt-corr"
                type="number"
                min="0"
                max="20"
                [ngModel]="d.maxCorrelatedPlans"
                (ngModelChange)="set('maxCorrelatedPlans', $event)"
                name="corr"
              />
              <p class="muted small">Armed plans sharing a currency the same way. 0 = no limit.</p>
            </div>
            <div class="field">
              <label for="pt-cb">Stop looking before a release (minutes)</label>
              <input
                id="pt-cb"
                type="number"
                min="0"
                max="1440"
                [ngModel]="d.catalystBlackoutMinutesBefore"
                (ngModelChange)="set('catalystBlackoutMinutesBefore', $event)"
                name="cb"
              />
            </div>
            <div class="field">
              <label for="pt-ca">Look again after a release (minutes)</label>
              <input
                id="pt-ca"
                type="number"
                min="0"
                max="1440"
                [ngModel]="d.catalystArmMinutesAfter"
                (ngModelChange)="set('catalystArmMinutesAfter', $event)"
                name="ca"
              />
            </div>
            <div class="field">
              <label for="pt-sc">Daily cap on {{ capBasis() }} spend (USD)</label>
              <input
                id="pt-sc"
                type="number"
                min="0"
                max="1000"
                step="0.5"
                [ngModel]="d.dailySpendCapUsd"
                (ngModelChange)="set('dailySpendCapUsd', $event)"
                name="sc"
              />
            </div>
            <div class="field">
              <label for="pt-pmsc">Per-market cap on {{ capBasis() }} spend (USD)</label>
              <input
                id="pt-pmsc"
                type="number"
                min="0"
                max="1000"
                step="0.5"
                [ngModel]="d.perMarketDailySpendCapUsd"
                (ngModelChange)="set('perMarketDailySpendCapUsd', $event)"
                name="pmsc"
              />
              <p class="muted small">Stops one busy market eating the day. 0 = shared pot.</p>
            </div>
          </div>
          @if (!d.spendCapCountsNotional) {
            <p class="muted small">
              The caps only stop billed (paid) spend. Analyses on the subscription are not counted
              against them.
            </p>
          }

          <div class="field check">
            <label>
              <input
                type="checkbox"
                [ngModel]="d.spendCapCountsNotional"
                (ngModelChange)="set('spendCapCountsNotional', $event)"
                name="capNotional"
              />
              <span>Count subscription (notional) spend against the caps too</span>
            </label>
            <p class="muted small">
              On the subscription provider every analysis is notional — not billed, but worth
              several dollars a day at API prices. Turning this on at the current caps would sharply
              cut how many analyses run.
            </p>
          </div>
          <div class="field check">
            <label>
              <input
                type="checkbox"
                [ngModel]="d.blackoutAppliesAtFire"
                (ngModelChange)="set('blackoutAppliesAtFire', $event)"
                name="blackoutFire"
              />
              <span>Hold back a card whose watch fires close to a major release</span>
            </label>
            <p class="muted small">
              A watch can live for days, so a card armed hours earlier could otherwise file straight
              into a release.
            </p>
          </div>
          <div class="field check">
            <label>
              <input
                type="checkbox"
                [ngModel]="d.respectKillSwitch"
                (ngModelChange)="set('respectKillSwitch', $event)"
                name="kill"
              />
              <span>Stand down entirely while the fleet kill switch is on</span>
            </label>
          </div>
          <div class="field check">
            <label>
              <input
                type="checkbox"
                [ngModel]="d.memoryEnabled"
                (ngModelChange)="set('memoryEnabled', $event)"
                name="mem"
              />
              <span>Show the agent its past results and notes</span>
            </label>
          </div>
        </details>

        <details class="cfg-group classic" [open]="isClassic()">
          <summary class="sub-label">Classic engine only</summary>
          <p class="muted small">
            @if (isClassic()) {
              These settings shape the single plan the Classic engine writes.
            } @else {
              The Assistant engine does not use any of these — its cards are judged by the viability
              gates when they fire. Kept here for switching back to Classic.
            }
          </p>

          <h4 class="mini">Plan standards</h4>
          <p class="muted small">
            Refusal criteria, not targets: a plan that breaks any of them is refused, never
            adjusted.
          </p>
          <div class="row-2">
            <div class="field">
              <label for="pt-minstop">Min stop ×ATR</label>
              <input
                id="pt-minstop"
                type="number"
                step="0.1"
                min="0.1"
                max="10"
                [ngModel]="d.minStopAtrMultiple"
                (ngModelChange)="set('minStopAtrMultiple', $event)"
                name="minStop"
              />
            </div>
            <div class="field">
              <label for="pt-maxstop">Max stop ×ATR</label>
              <input
                id="pt-maxstop"
                type="number"
                step="0.1"
                min="0.2"
                max="20"
                [ngModel]="d.maxStopAtrMultiple"
                (ngModelChange)="set('maxStopAtrMultiple', $event)"
                name="maxStop"
              />
            </div>
            <div class="field">
              <label for="pt-minrr">Min reward:risk</label>
              <input
                id="pt-minrr"
                type="number"
                step="0.1"
                min="0.1"
                max="10"
                [ngModel]="d.minRewardRisk"
                (ngModelChange)="set('minRewardRisk', $event)"
                name="minRr"
              />
            </div>
            <div class="field">
              <label for="pt-maxtgt">Max target ×ATR</label>
              <input
                id="pt-maxtgt"
                type="number"
                step="0.5"
                min="0.5"
                max="50"
                [ngModel]="d.maxTargetAtrMultiple"
                (ngModelChange)="set('maxTargetAtrMultiple', $event)"
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
                [ngModel]="d.minConfidence"
                (ngModelChange)="set('minConfidence', $event)"
                name="minConf"
              />
            </div>
            <div class="field">
              <label for="pt-noise">Stop beyond noise (×)</label>
              <input
                id="pt-noise"
                type="number"
                step="0.1"
                min="0"
                max="5"
                [ngModel]="d.stopNoiseMultiple"
                (ngModelChange)="set('stopNoiseMultiple', $event)"
                name="noise"
              />
            </div>
            <div class="field">
              <label for="pt-spread">Spread cost (×)</label>
              <input
                id="pt-spread"
                type="number"
                step="0.5"
                min="0"
                max="10"
                [ngModel]="d.spreadCostMultiple"
                (ngModelChange)="set('spreadCostMultiple', $event)"
                name="spread"
              />
            </div>
            <div class="field">
              <label for="pt-lookback">Evidence lookback (bars)</label>
              <input
                id="pt-lookback"
                type="number"
                step="100"
                min="100"
                max="20000"
                [ngModel]="d.evidenceLookbackBars"
                (ngModelChange)="set('evidenceLookbackBars', $event)"
                name="lookback"
              />
            </div>
            <div class="field">
              <label for="pt-pe">Plan expiry (hours)</label>
              <input
                id="pt-pe"
                type="number"
                min="1"
                max="168"
                [ngModel]="d.planExpiryHours"
                (ngModelChange)="set('planExpiryHours', $event)"
                name="pe"
              />
            </div>
            <div class="field">
              <label for="pt-mo">Max open plans / market</label>
              <input
                id="pt-mo"
                type="number"
                min="1"
                max="10"
                [ngModel]="d.maxOpenPlansPerSymbol"
                (ngModelChange)="set('maxOpenPlansPerSymbol', $event)"
                name="mo"
              />
            </div>
          </div>
          <div class="field check">
            <label>
              <input
                type="checkbox"
                [ngModel]="d.requireStopStructure"
                (ngModelChange)="set('requireStopStructure', $event)"
                name="structure"
              />
              <span>Stop must sit beyond a real swing, not float in mid-range</span>
            </label>
          </div>

          <h4 class="mini">Conviction</h4>
          <div class="row-2">
            <div class="field">
              <label for="pt-hcrr">High conviction extra R:R</label>
              <input
                id="pt-hcrr"
                type="number"
                step="0.1"
                min="0"
                max="5"
                [ngModel]="d.highConvictionRewardRiskBonus"
                (ngModelChange)="set('highConvictionRewardRiskBonus', $event)"
                name="hcrr"
              />
            </div>
            <div class="field">
              <label for="pt-hcconf">High conviction min confidence</label>
              <input
                id="pt-hcconf"
                type="number"
                step="0.05"
                min="0"
                max="1"
                [ngModel]="d.highConvictionMinConfidence"
                (ngModelChange)="set('highConvictionMinConfidence', $event)"
                name="hcconf"
              />
            </div>
          </div>

          <h4 class="mini">Prompt</h4>
          <div class="row-2">
            <div class="field">
              <label for="pt-notes">Past notes in the prompt</label>
              <input
                id="pt-notes"
                type="number"
                min="0"
                max="30"
                [ngModel]="d.maxNotesInPrompt"
                (ngModelChange)="set('maxNotesInPrompt', $event)"
                name="notes"
              />
            </div>
            <div class="field">
              <label for="pt-variant">View prompt experiment</label>
              <select
                id="pt-variant"
                [ngModel]="d.promptVariant"
                (ngModelChange)="set('promptVariant', $event)"
                name="variant"
              >
                <option value="a">a — control</option>
                <option value="b">b — argue the other side first</option>
                <option value="split">split — run both and compare</option>
              </select>
            </div>
          </div>
        </details>

        <div class="field">
          <label for="pt-reason">Reason (audit log)</label>
          <input
            id="pt-reason"
            type="text"
            maxlength="500"
            [ngModel]="reason()"
            (ngModelChange)="reason.set($event)"
            name="reason"
            placeholder="why this change"
          />
        </div>

        @if (message(); as msg) {
          <div class="banner" [class.bad]="conflict()" role="status">
            {{ msg }}
            @if (conflict()) {
              <div class="row">
                <button type="button" class="linkish" (click)="reloadCurrent.emit()">
                  Reload current settings
                </button>
                <span class="muted small">(your unsaved changes are kept until you do)</span>
              </div>
            }
          </div>
        }

        <div class="row actions">
          <button
            type="button"
            class="save-btn"
            [disabled]="saving() || !canManage() || !dirty()"
            (click)="save.emit()"
          >
            {{ saving() ? 'Saving…' : 'Save configuration' }}
          </button>
          @if (dirty()) {
            <button type="button" class="linkish" [disabled]="saving()" (click)="discard.emit()">
              Discard changes
            </button>
          }
        </div>
      </section>
    </fieldset>
  `,
  styleUrls: ['../pt-common.css'],
  styles: [
    `
      .ro-fieldset {
        display: contents;
        border: 0;
        margin: 0;
        padding: 0;
        min-width: 0;
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
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .sub-label {
        margin: var(--space-2) 0 0;
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .mini {
        margin: var(--space-3) 0 var(--space-1);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
      }
      .row-2 {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-3);
      }
      input,
      select,
      textarea {
        font: inherit;
        font-size: var(--text-sm);
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
      textarea {
        resize: vertical;
        min-height: 110px;
        line-height: 1.45;
      }
      .instr-head {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .instr-head > label {
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        color: var(--text-secondary);
      }
      .instr-tag {
        font-size: 10px;
        padding: 1px 8px;
        border-radius: var(--radius-full);
        border: 1px solid var(--border);
        color: var(--text-secondary);
      }
      .instr-tag.custom {
        border-color: var(--accent);
        color: var(--accent);
      }
      .banner {
        padding: var(--space-3);
        border-radius: var(--radius-md);
        font-size: var(--text-sm);
        background: color-mix(in srgb, var(--accent) 10%, transparent);
        color: var(--accent);
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .banner.bad {
        background: rgba(255, 59, 48, 0.1);
        color: var(--loss, #b91c1c);
      }
      .actions {
        margin-top: var(--space-2);
        gap: var(--space-3);
      }
      .save-btn {
        border: none;
        background: var(--accent);
        color: #fff;
        border-radius: var(--radius-full);
        padding: 9px 22px;
        font-weight: var(--font-semibold);
        cursor: pointer;
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
        grid-template-columns: repeat(auto-fill, minmax(min(150px, 100%), 1fr));
        gap: 4px 12px;
        max-height: 260px;
        overflow-y: auto;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
      }
      .pair-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        flex-wrap: wrap;
      }
      .inline-check {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: var(--text-sm);
        cursor: pointer;
      }
      .market-ctl {
        display: inline-flex;
        gap: 3px;
      }
      .chip {
        flex: none;
        padding: 1px 4px;
        font-size: 10px;
        border-radius: var(--radius-sm);
        background: var(--bg-secondary);
        color: var(--text-secondary);
      }
      .chip.live {
        border-color: var(--accent);
        color: var(--accent);
      }
      .cfg-group {
        border-top: 1px solid var(--border);
        padding-top: var(--space-3);
      }
      .cfg-group > summary {
        cursor: pointer;
        user-select: none;
        list-style: none;
      }
      .cfg-group > summary::-webkit-details-marker {
        display: none;
      }
      .cfg-group > summary::after {
        content: ' ▾';
        color: var(--text-secondary);
        font-size: 11px;
      }
      .cfg-group[open] > summary::after {
        content: ' ▴';
      }
      .cfg-group > * + * {
        margin-top: var(--space-2);
      }
      .table-wrap {
        overflow-x: auto;
      }
      table.limits {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-xs);
      }
      .limits th,
      .limits td {
        text-align: left;
        padding: 4px 6px;
        border-bottom: 1px solid var(--border);
        vertical-align: top;
      }
      .limits th {
        color: var(--text-tertiary);
        font-weight: var(--font-medium);
        text-transform: uppercase;
        font-size: 10px;
        white-space: nowrap;
      }
      .limits .n {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
    `,
  ],
})
export class PtConfigFormComponent {
  readonly draft = input.required<PatientTraderConfig>();
  /** Supplies the gate limits that apply now (Assistant section). */
  readonly health = input<PatientTraderHealth | null>(null);
  readonly canManage = input(false);
  readonly saving = input(false);
  readonly dirty = input(false);
  readonly availableSymbols = input<string[]>([]);
  readonly pairsLoading = input(false);
  /** Result of the last save (or the conflict text). */
  readonly message = input<string | null>(null);
  /** The last save was refused because someone else saved first. */
  readonly conflict = input(false);
  readonly reason = model('');

  readonly patch = output<ConfigPatch>();
  readonly save = output<void>();
  readonly discard = output<void>();
  readonly reloadCurrent = output<void>();

  readonly instructionMaxLength = 8000;
  readonly timeframes = ['M15', 'H1', 'H4', 'D1'];
  /** Timeframe given to a newly ticked market; per-market after that. */
  readonly newMarketTimeframe = signal('H1');

  protected readonly isClassic = computed(() => this.draft().analysisEngine === 'Classic');
  protected readonly customInstruction = computed(() => isCustomInstruction(this.draft()));
  protected readonly capBasis = computed(() =>
    this.draft().spendCapCountsNotional ? 'paid + notional' : 'paid',
  );

  /** Followed markets by symbol. */
  protected readonly followed = computed(
    () => new Map(this.draft().markets.map((m) => [m.symbol.toUpperCase(), m])),
  );

  /** The catalogue plus any followed market it no longer lists (so it can still be unticked). */
  protected readonly symbolList = computed(() => {
    const set = new Set(this.availableSymbols());
    for (const s of this.followed().keys()) set.add(s);
    return [...set].sort();
  });

  protected effective(mode: PatientTraderMode | null | undefined): PatientTraderMode {
    return effectiveMode(this.draft().mode, { mode: mode ?? null });
  }

  /** Gate limits per followed market and side, in pips. */
  protected readonly limitRows = computed(() => {
    const h = this.health();
    if (!h) return [];
    const followed = this.followed();
    return h.markets
      .filter((m) => m.limits && followed.has(m.symbol.toUpperCase()))
      .flatMap((m) => {
        const l = m.limits!;
        return (['Buy', 'Sell'] as const).map((side, i) => {
          const s = side === 'Buy' ? l.buy : l.sell;
          return {
            key: `${m.symbol}-${side}`,
            first: i === 0,
            symbol: m.symbol,
            side,
            atrPips: toPips(l.atr, l.pipSize),
            minRr: l.minRewardRisk,
            minConf: l.minConfidence,
            minStop: toPips(s.minStop, l.pipSize),
            maxStop: toPips(s.maxStop, l.pipSize),
            maxTarget: toPips(s.maxTarget, l.pipSize),
            noise: toPips(s.noise, l.pipSize),
            reach: toPips(s.reach, l.pipSize),
            structure: s.needsStructure,
          };
        });
      });
  });

  protected set<K extends keyof PatientTraderConfig>(key: K, value: PatientTraderConfig[K]): void {
    this.patch.emit({ [key]: value } as ConfigPatch);
  }

  /** Puts the built-in instruction back in the box. Saved, it is stored as "use the default". */
  protected resetInstruction(): void {
    this.set('analysisInstruction', this.draft().defaultAnalysisInstruction ?? '');
  }

  /** Ticking a market also enables it — the checkbox IS the decision on this page. */
  protected toggleMarket(symbol: string): void {
    const markets = this.draft().markets;
    const has = markets.some((m) => m.symbol.toUpperCase() === symbol);
    this.patch.emit({
      markets: has
        ? markets.filter((m) => m.symbol.toUpperCase() !== symbol)
        : [...markets, { symbol, timeframe: this.newMarketTimeframe(), enabled: true, mode: null }],
    });
  }

  protected setMarket(
    symbol: string,
    change: { timeframe?: string; mode?: PatientTraderMode | null },
  ): void {
    this.patch.emit({
      markets: this.draft().markets.map((m) =>
        m.symbol.toUpperCase() === symbol ? { ...m, ...change } : m,
      ),
    });
  }
}
