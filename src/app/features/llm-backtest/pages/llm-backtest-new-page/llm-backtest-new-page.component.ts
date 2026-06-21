import {
  Component,
  ChangeDetectionStrategy,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule, CurrencyPipe, DecimalPipe } from '@angular/common';
import {
  AbstractControl,
  FormBuilder,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { catchError, debounceTime, of, Subscription } from 'rxjs';

import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import {
  BacktestBudgetStatus,
  BacktestBudgetWindow,
  BacktestCostEstimate,
  BacktestGridSpec,
  BacktestSweepSpec,
  CreateLlmBacktestRunRequest,
  GUARD_KNOB_META,
  GridSampling,
  GuardKnob,
  LlmBacktestService,
  SWEEP_MAX_VALUES,
} from '@core/services/llm-backtest.service';
import { NotificationService } from '@core/notifications/notification.service';
import { Timeframe } from '@core/api/api.types';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

const TIMEFRAMES: Timeframe[] = ['M5', 'M15', 'H1', 'H4', 'D1'];

const DEFAULT_MAX_POINTS = 1000;
const DEFAULT_MAX_BUDGET = 50;
const MAX_BUDGET = 500;
const MAX_POINTS = 1000;

/**
 * Form values bound to the launch form. Mirrors the C# `BacktestGridSpec`
 * + parent `CreateLlmBacktestRunCommand` shape, but stays in flat-control
 * form so Reactive Forms can validate every leaf independently.
 */
interface LaunchFormValue {
  name: string | null;
  symbols: string[];
  timeframes: Timeframe[];
  windowStartLocal: string;
  windowEndLocal: string;
  sampling: GridSampling;
  everyNthBar: number | null;
  explicitTimestampsRaw: string | null;
  maxPoints: number | null;
  maxTokenBudgetUsd: number | null;
  dryRun: boolean;
  promptVersionOverride: string | null;
  note: string | null;
  sweepEnabled: boolean;
  sweepKnob: GuardKnob;
  sweepStart: number | null;
  sweepEnd: number | null;
  sweepStep: number | null;
  // Phase 3 — multi-sample stability mode. Mutually exclusive with sweep.
  multiSampleEnabled: boolean;
  sampleCount: number | null;
  // Order-style preference. Threads through to the LLM prompt + post-LLM
  // filter (mirrors the live spot-sweep entry-preference knob).
  entryBias: 'Any' | 'Stop' | 'Limit';
}

/** Phase 3 — multi-sample stability bounds (mirrors backend validator). */
const MULTI_SAMPLE_MIN = 2;
const MULTI_SAMPLE_MAX = 10;
const MULTI_SAMPLE_DEFAULT = 3;

/**
 * Launch-form page for a new LLM Analysis Backtest. Symbols + timeframes are
 * chip multi-selects, sampling drives conditional fields, and a live cost
 * estimate (debounced 300 ms) gates Submit.
 *
 * Hits POST /llm-backtest/estimate-cost on every input change for the
 * preview, then POST /llm-backtest on submit. On success, redirects to
 * /llm-backtest/{newId}.
 */
@Component({
  selector: 'app-llm-backtest-new-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    CurrencyPipe,
    DecimalPipe,
    ReactiveFormsModule,
    RouterLink,
    PageHeaderComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Launch LLM Backtest"
        subtitle="Configure the grid, preview the cost, submit. The worker fans out asynchronously."
      >
        <a routerLink="/llm-backtest" class="btn-secondary">‹ Back to list</a>
      </app-page-header>

      <form class="layout" [formGroup]="form" (ngSubmit)="onSubmit()">
        <section class="form-card">
          <h3>Symbols</h3>
          <div class="chips">
            @for (sym of availableSymbols(); track sym) {
              <button
                type="button"
                class="chip"
                [class.chip--on]="isSymbolSelected(sym)"
                (click)="toggleSymbol(sym)"
              >
                {{ sym }}
              </button>
            } @empty {
              <span class="muted">Loading currency pairs…</span>
            }
          </div>
          @if (symbolsControl.invalid && symbolsControl.touched) {
            <p class="error-text">Pick at least one symbol.</p>
          }

          <h3>Timeframes</h3>
          <div class="chips">
            @for (tf of timeframes; track tf) {
              <button
                type="button"
                class="chip"
                [class.chip--on]="isTimeframeSelected(tf)"
                (click)="toggleTimeframe(tf)"
              >
                {{ tf }}
              </button>
            }
          </div>
          @if (tfControl.invalid && tfControl.touched) {
            <p class="error-text">Pick at least one timeframe.</p>
          }

          <h3>Window</h3>
          <div class="row">
            <label class="field">
              <span>Start (UTC)</span>
              <input type="datetime-local" formControlName="windowStartLocal" />
            </label>
            <label class="field">
              <span>End (UTC)</span>
              <input type="datetime-local" formControlName="windowEndLocal" />
            </label>
          </div>
          @if (form.errors?.['windowOrder']) {
            <p class="error-text">End must be after Start.</p>
          }

          <h3>Sampling</h3>
          <div class="row">
            <label class="field">
              <span>Mode</span>
              <select formControlName="sampling">
                <option [ngValue]="GridSampling.EveryBarClose">Every bar close</option>
                <option [ngValue]="GridSampling.EveryNthBar">Every Nth bar</option>
                <option [ngValue]="GridSampling.ExplicitTimestamps">Explicit timestamps</option>
              </select>
            </label>
            @if (form.value.sampling === GridSampling.EveryNthBar) {
              <label class="field">
                <span>N (stride)</span>
                <input type="number" min="1" step="1" formControlName="everyNthBar" />
              </label>
            }
          </div>
          @if (form.value.sampling === GridSampling.ExplicitTimestamps) {
            <label class="field">
              <span>Timestamps <small>(one ISO UTC per line)</small></span>
              <textarea
                formControlName="explicitTimestampsRaw"
                rows="5"
                placeholder="2026-06-13T08:00:00Z&#10;2026-06-13T12:00:00Z"
              ></textarea>
            </label>
          }

          <h3>Caps</h3>
          <div class="row">
            <label class="field">
              <span
                >Max points <small>(≤ {{ maxPoints }})</small></span
              >
              <input type="number" min="1" [max]="maxPoints" formControlName="maxPoints" />
            </label>
            <label class="field">
              <span
                >Max budget USD <small>(≤ {{ maxBudget | currency: 'USD' }})</small></span
              >
              <input
                type="number"
                min="1"
                [max]="maxBudget"
                step="1"
                formControlName="maxTokenBudgetUsd"
              />
            </label>
          </div>

          <h3>Options</h3>
          <label class="chk">
            <input type="checkbox" formControlName="dryRun" />
            <span>Dry-run</span>
          </label>
          @if (form.value.dryRun) {
            <p class="muted small">
              No LLM calls; exercises walker + viability gate against a synthetic Hold rec. Free.
            </p>
          }

          <label class="field">
            <span
              >Order preference <small>(biases the LLM's ranking + filters the output)</small></span
            >
            <select formControlName="entryBias">
              <option value="Any">No preference</option>
              <option value="Stop">Prefer breakout (stop orders)</option>
              <option value="Limit">Prefer pullback (limit orders)</option>
            </select>
            <small class="muted">
              Threaded into the prompt as a soft directive and applied as a post-LLM filter — recs
              whose order type doesn't match the bias are dropped before the viability gate runs.
              Same knob the live spot-sweep page uses. Stop / Limit auto-namespace the backtest
              cache so bias variants don't pool with default runs.
            </small>
          </label>

          <label class="field">
            <span
              >Prompt framework
              <small>(controls the LLM emission contract + engine spec construction)</small></span
            >
            <select formControlName="promptVersionOverride">
              <option [ngValue]="null">
                Active default ({{ defaultPromptVersionPlaceholder }})
              </option>
              <option value="v10-2026-06-20-trim">v10 — LLM emits full entry/SL/TP geometry</option>
              <option value="v11.3-2026-06-21-thinframework-tier1-only-hold">
                v11.3 — Hold reserved for TIER-1 data releases only
              </option>
              <option value="v11.2-2026-06-21-thinframework-no-holiday-hold">
                v11.2 — Bank holidays don't trigger Hold
              </option>
              <option value="v11.1-2026-06-21-thinframework-bias-act">
                v11.1 — Thin framework + bias-to-act
              </option>
              <option value="v11-2026-06-21-thinframework">
                v11 — Thin framework: LLM emits direction + thesis prices, engine derives spec
              </option>
            </select>
            <small class="muted">
              v11 ports geometry construction from the LLM to deterministic engine code
              (TradeSpecComputer). Picks Entry / SL / TP using operator-configured strategies
              (default: Limit-at-anchor + before-first-opposing-level) anchored to the LLM's thesis
              target + invalidation prices. Cache is namespaced per version so v10 and v11 responses
              don't pool. See docs/spot-llm-thin-framework-2026-06-21.md.
            </small>
          </label>

          <label class="field">
            <span>Name <small>(optional, auto-generated if blank)</small></span>
            <input type="text" formControlName="name" placeholder="backtest-…" />
          </label>

          <label class="field">
            <span>Note <small>(optional free text)</small></span>
            <textarea
              formControlName="note"
              rows="2"
              placeholder="What are we trying to validate?"
            ></textarea>
          </label>

          <!-- Phase 2 — guard-threshold sweep (advanced) ------------------ -->
          <h3 class="sweep-heading">
            <button
              type="button"
              class="sweep-toggle-btn"
              (click)="sweepExpanded.set(!sweepExpanded())"
            >
              <span class="sweep-caret">{{ sweepExpanded() ? '▾' : '▸' }}</span>
              Guard threshold sweep (advanced)
            </button>
          </h3>
          @if (sweepExpanded()) {
            <div class="sweep-block">
              <label class="chk">
                <input type="checkbox" formControlName="sweepEnabled" />
                <span>
                  Sweep one engine-guard threshold across this grid
                  <small>(no extra LLM cost — sweep reuses each point's single LLM call)</small>
                </span>
              </label>
              @if (form.value.sweepEnabled) {
                <p class="muted small sweep-free">
                  Sweep mode reuses each cell's single LLM call across all knob values — $0
                  incremental cost.
                </p>
                <div class="row">
                  <label class="field">
                    <span>Knob</span>
                    <select formControlName="sweepKnob">
                      @for (k of sortedKnobOptions; track k.knob) {
                        <option [ngValue]="k.knob">{{ k.displayName }}</option>
                      }
                    </select>
                  </label>
                  <div class="field knob-default">
                    <span>Default value</span>
                    <span class="default-value mono">
                      {{ activeKnobMeta().defaultValue }} <small>{{ activeKnobMeta().unit }}</small>
                    </span>
                  </div>
                </div>
                <div class="row">
                  <label class="field">
                    <span>Start</span>
                    <input
                      type="number"
                      [step]="sweepStepHint()"
                      [min]="activeKnobMeta().min"
                      [max]="activeKnobMeta().max"
                      formControlName="sweepStart"
                    />
                  </label>
                  <label class="field">
                    <span>End</span>
                    <input
                      type="number"
                      [step]="sweepStepHint()"
                      [min]="activeKnobMeta().min"
                      [max]="activeKnobMeta().max"
                      formControlName="sweepEnd"
                    />
                  </label>
                  <label class="field">
                    <span>Step</span>
                    <input
                      type="number"
                      [step]="sweepStepHint()"
                      [min]="0"
                      formControlName="sweepStep"
                    />
                  </label>
                </div>
                <p class="small muted">
                  Derived count:
                  <strong [class.error-text]="sweepError() !== null">{{ sweepCount() }}</strong>
                  of {{ sweepMaxValues }} max.
                </p>
                @if (sweepError(); as err) {
                  <p class="error-text">{{ err }}</p>
                }
              }
            </div>
          }

          <!-- Phase 3 — multi-sample stability (advanced) -------------- -->
          <h3 class="sweep-heading">
            <button
              type="button"
              class="sweep-toggle-btn"
              (click)="multiSampleExpanded.set(!multiSampleExpanded())"
            >
              <span class="sweep-caret">{{ multiSampleExpanded() ? '▾' : '▸' }}</span>
              Multi-sample stability (advanced)
            </button>
          </h3>
          @if (multiSampleExpanded()) {
            <div class="sweep-block">
              <label class="chk">
                <input type="checkbox" formControlName="multiSampleEnabled" />
                <span> Run multiple LLM calls per snapshot to measure stochasticity </span>
              </label>
              @if (form.value.multiSampleEnabled) {
                <p class="muted small sweep-free">
                  Each cell will make N independent LLM calls. Cost is
                  <strong>N×</strong> a single-sample run for cache-miss cells; cache hits are free
                  for sample 0 only.
                </p>
                <div class="row">
                  <label class="field">
                    <span
                      >Sample count <small>(2..{{ multiSampleMax }})</small></span
                    >
                    <input
                      type="number"
                      [min]="multiSampleMin"
                      [max]="multiSampleMax"
                      step="1"
                      formControlName="sampleCount"
                    />
                  </label>
                </div>
                @if (multiSampleError(); as err) {
                  <p class="error-text">{{ err }}</p>
                }
              }
            </div>
          }
        </section>

        <aside class="estimate-card">
          <h3>Cost estimate</h3>
          @if (estimating()) {
            <p class="muted">Estimating…</p>
          } @else if (estimate(); as e) {
            <dl class="estimate">
              <dt>Total points</dt>
              <dd>{{ e.totalPoints | number }}</dd>
              <dt>Est. input tokens</dt>
              <dd>{{ e.estimatedInputTokens | number }}</dd>
              <dt>Est. output tokens</dt>
              <dd>{{ e.estimatedOutputTokens | number }}</dd>
              <dt>Est. cost</dt>
              <dd>
                <strong>{{ effectiveEstimatedCost(e) | currency: 'USD' }}</strong>
                @if (multiSampleMultiplier() > 1) {
                  <div class="multiplier-hint">
                    (includes {{ multiSampleMultiplier() }}× multi-sample multiplier)
                  </div>
                }
              </dd>
              <dt>Budget cap</dt>
              <dd>{{ e.maxTokenBudgetUsd | currency: 'USD' }}</dd>
              <dt>Fits budget</dt>
              <dd>
                <span
                  class="fit-pill"
                  [class.fit-pill--ok]="fitsBudgetEffective(e)"
                  [class.fit-pill--no]="!fitsBudgetEffective(e)"
                >
                  {{ fitsBudgetEffective(e) ? 'Yes' : 'Over budget' }}
                </span>
              </dd>
            </dl>
          } @else if (estimateError()) {
            <p class="error-text">{{ estimateError() }}</p>
          } @else {
            <p class="muted">Fill the form to see a preview.</p>
          }

          @if (form.value.dryRun && estimate()) {
            <p class="muted small">
              Dry-run skips LLM calls — actual spend will be $0 regardless of estimate.
            </p>
          }

          <!-- Phase 4 (P4.1) — rolling-window budget panel. Snapshot is
                fetched once on init; the worker enforces the same caps
                server-side. Each row renders as a progress bar coloured
                by the remaining-fraction tier. Disabled caps show an
                inline pill instead of a bar. -->
          <h3 class="budget-heading">Rolling budget</h3>
          @if (budgetStatus(); as bs) {
            <div class="budget-rows">
              <div class="budget-row">
                <div class="budget-row-label">
                  <span class="budget-name">Daily</span>
                  @if (bs.daily.enabled) {
                    <span class="budget-figures mono">
                      {{ bs.daily.spentUsd | currency: 'USD' }}
                      /
                      {{ bs.daily.capUsd | currency: 'USD' }}
                    </span>
                  } @else {
                    <span class="budget-disabled">Daily cap disabled</span>
                  }
                </div>
                @if (bs.daily.enabled) {
                  <div class="budget-bar">
                    <div
                      class="budget-bar-fill"
                      [class.budget-bar-fill--green]="budgetTier(bs.daily) === 'green'"
                      [class.budget-bar-fill--amber]="budgetTier(bs.daily) === 'amber'"
                      [class.budget-bar-fill--red]="budgetTier(bs.daily) === 'red'"
                      [style.width.%]="budgetFillPct(bs.daily)"
                    ></div>
                  </div>
                  <p class="budget-remaining muted small">
                    {{ bs.daily.remainingUsd | currency: 'USD' }} remaining
                  </p>
                }
              </div>
              <div class="budget-row">
                <div class="budget-row-label">
                  <span class="budget-name">Weekly</span>
                  @if (bs.weekly.enabled) {
                    <span class="budget-figures mono">
                      {{ bs.weekly.spentUsd | currency: 'USD' }}
                      /
                      {{ bs.weekly.capUsd | currency: 'USD' }}
                    </span>
                  } @else {
                    <span class="budget-disabled">Weekly cap disabled</span>
                  }
                </div>
                @if (bs.weekly.enabled) {
                  <div class="budget-bar">
                    <div
                      class="budget-bar-fill"
                      [class.budget-bar-fill--green]="budgetTier(bs.weekly) === 'green'"
                      [class.budget-bar-fill--amber]="budgetTier(bs.weekly) === 'amber'"
                      [class.budget-bar-fill--red]="budgetTier(bs.weekly) === 'red'"
                      [style.width.%]="budgetFillPct(bs.weekly)"
                    ></div>
                  </div>
                  <p class="budget-remaining muted small">
                    {{ bs.weekly.remainingUsd | currency: 'USD' }} remaining
                  </p>
                }
              </div>
            </div>
          } @else if (budgetLoading()) {
            <p class="muted small">Loading budget…</p>
          } @else if (budgetError()) {
            <p class="muted small">Budget status unavailable.</p>
          }

          <!-- Rolling-budget gate. Independent of fitsBudget — the per-run
                cap and the rolling cap both have to pass. -->
          @if (budgetExceededMessage(); as msg) {
            <p class="error-text rolling-budget-error">{{ msg }}</p>
          }

          <button
            type="submit"
            class="btn-primary"
            [disabled]="!canSubmit()"
            [class.btn-primary--disabled]="!canSubmit()"
          >
            @if (submitting()) {
              Launching…
            } @else {
              Launch backtest
            }
          </button>
          @if (!canSubmit() && !submitting() && estimate() && !fitsBudgetEffective(estimate()!)) {
            <p class="error-text">
              Tighten the grid or raise the budget so the estimated spend fits the cap.
            </p>
          }
        </aside>
      </form>
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
      .btn-primary {
        background: var(--accent);
        color: #fff;
        border: none;
        padding: 0.6rem 1rem;
        border-radius: var(--radius-sm);
        font-weight: 600;
        font-size: 0.9rem;
        cursor: pointer;
      }
      .btn-primary:hover:not(:disabled) {
        filter: brightness(1.05);
      }
      .btn-primary--disabled,
      .btn-primary:disabled {
        opacity: 0.55;
        cursor: not-allowed;
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
      .layout {
        display: grid;
        grid-template-columns: 1fr 320px;
        gap: var(--space-5);
        align-items: start;
      }
      @media (max-width: 980px) {
        .layout {
          grid-template-columns: 1fr;
        }
      }
      .form-card,
      .estimate-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-4);
      }
      .form-card h3,
      .estimate-card h3 {
        margin: 0.75rem 0 0.5rem 0;
        font-size: 0.85rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-secondary);
      }
      .form-card h3:first-of-type {
        margin-top: 0;
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 0.35rem;
        margin-bottom: 0.25rem;
      }
      .chip {
        background: var(--bg-tertiary);
        border: 1px solid var(--border);
        color: var(--text-secondary);
        padding: 0.3rem 0.65rem;
        border-radius: 999px;
        font-size: 0.78rem;
        cursor: pointer;
        font-weight: 600;
        transition:
          background 0.12s,
          color 0.12s;
      }
      .chip:hover {
        color: var(--text-primary);
      }
      .chip--on {
        background: var(--accent);
        color: #fff;
        border-color: var(--accent);
      }
      .row {
        display: flex;
        gap: 1rem;
        flex-wrap: wrap;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        font-size: 0.78rem;
        color: var(--text-secondary);
        flex: 1;
        min-width: 220px;
      }
      .field input,
      .field select,
      .field textarea {
        background: var(--bg-primary);
        color: var(--text-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: 0.45rem 0.65rem;
        font-size: 0.9rem;
        font-family: inherit;
      }
      .field textarea {
        resize: vertical;
        min-height: 60px;
      }
      .chk {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.9rem;
        cursor: pointer;
      }
      .muted {
        color: var(--text-secondary);
        font-size: 0.85rem;
      }
      .muted.small {
        font-size: 0.78rem;
      }
      .error-text {
        color: #c4290a;
        font-size: 0.8rem;
        margin: 0.25rem 0 0;
      }
      .estimate-card {
        position: sticky;
        top: var(--space-4);
      }
      .estimate {
        margin: 0;
        display: grid;
        grid-template-columns: 1fr 1fr;
        row-gap: 0.4rem;
        column-gap: 0.5rem;
        font-size: 0.85rem;
      }
      .estimate dt {
        color: var(--text-secondary);
      }
      .estimate dd {
        margin: 0;
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .fit-pill {
        display: inline-block;
        padding: 0.15rem 0.5rem;
        border-radius: 999px;
        font-size: 0.7rem;
        font-weight: 700;
        text-transform: uppercase;
      }
      .fit-pill--ok {
        background: rgba(48, 209, 88, 0.18);
        color: #1f8a3d;
      }
      .fit-pill--no {
        background: rgba(255, 69, 58, 0.18);
        color: #c4290a;
      }
      .sweep-heading {
        margin-top: 1rem;
      }
      .sweep-toggle-btn {
        background: none;
        border: none;
        padding: 0;
        font: inherit;
        font-size: 0.85rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-secondary);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
      }
      .sweep-toggle-btn:hover {
        color: var(--text-primary);
      }
      .sweep-caret {
        font-size: 0.7rem;
        opacity: 0.6;
      }
      .sweep-block {
        padding: 0.75rem;
        border: 1px dashed var(--border);
        border-radius: var(--radius-sm);
        margin-top: 0.5rem;
        display: flex;
        flex-direction: column;
        gap: 0.6rem;
      }
      .sweep-free {
        margin: 0;
      }
      .knob-default {
        justify-content: flex-end;
      }
      .default-value {
        font-size: 0.95rem;
        color: var(--text-primary);
        font-weight: 600;
      }
      .multiplier-hint {
        font-size: 0.72rem;
        color: var(--text-secondary);
        font-weight: 400;
        margin-top: 2px;
      }
      /* Phase 4 — rolling-window budget panel. */
      .budget-heading {
        margin-top: 1rem;
      }
      .budget-rows {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
      }
      .budget-row {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
      }
      .budget-row-label {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        font-size: 0.82rem;
      }
      .budget-name {
        font-weight: 600;
        color: var(--text-primary);
      }
      .budget-figures {
        font-variant-numeric: tabular-nums;
        color: var(--text-secondary);
        font-size: 0.78rem;
      }
      .budget-disabled {
        display: inline-block;
        padding: 0.1rem 0.45rem;
        border-radius: 999px;
        background: rgba(120, 120, 128, 0.15);
        color: var(--text-secondary);
        font-size: 0.7rem;
        font-weight: 600;
      }
      .budget-bar {
        height: 6px;
        background: var(--bg-tertiary);
        border-radius: 999px;
        overflow: hidden;
      }
      .budget-bar-fill {
        height: 100%;
        transition: width 0.2s;
      }
      .budget-bar-fill--green {
        background: #1f8a3d;
      }
      .budget-bar-fill--amber {
        background: #c47a0a;
      }
      .budget-bar-fill--red {
        background: #c4290a;
      }
      .budget-remaining {
        margin: 0;
      }
      .rolling-budget-error {
        margin-top: 0.5rem;
      }
      .mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      }
    `,
  ],
})
export class LlmBacktestNewPageComponent implements OnInit, OnDestroy {
  readonly GridSampling = GridSampling;
  readonly timeframes = TIMEFRAMES;
  readonly maxPoints = MAX_POINTS;
  readonly maxBudget = MAX_BUDGET;
  readonly defaultPromptVersionPlaceholder = 'auto (engine default)';

  // Phase 2 — guard-threshold sweep. The block is collapsible (advanced)
  // and lives inside the main launch form so a single submit carries the
  // sweep spec inline with the rest of the grid.
  readonly sweepExpanded = signal(false);
  readonly sweepMaxValues = SWEEP_MAX_VALUES;

  // Phase 3 — multi-sample stability. Parallel collapsible block; the
  // form-level guard rejects sweep+multi-sample combined (mirrors backend
  // validator) so only one of the two can be in flight at submit time.
  readonly multiSampleExpanded = signal(false);
  readonly multiSampleMin = MULTI_SAMPLE_MIN;
  readonly multiSampleMax = MULTI_SAMPLE_MAX;
  /** Sorted-alphabetical-by-displayName view of GUARD_KNOB_META for the dropdown. */
  readonly sortedKnobOptions = Object.values(GUARD_KNOB_META).sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  );

  private readonly fb = inject(FormBuilder);
  private readonly svc = inject(LlmBacktestService);
  private readonly currencyPairsSvc = inject(CurrencyPairsService);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);

  readonly availableSymbols = signal<string[]>([]);
  readonly estimate = signal<BacktestCostEstimate | null>(null);
  readonly estimating = signal(false);
  readonly estimateError = signal<string | null>(null);
  readonly submitting = signal(false);

  // Phase 4 (P4.1) — rolling-window budget snapshot. Loaded once on
  // ngOnInit; the worker enforces the same caps server-side, so a stale
  // panel is only a UX hint, not a correctness gate.
  readonly budgetStatus = signal<BacktestBudgetStatus | null>(null);
  readonly budgetLoading = signal(false);
  readonly budgetError = signal<string | null>(null);

  /**
   * Reactive form. We model `symbols` + `timeframes` as FormControls holding
   * arrays so the chip buttons can drive them imperatively while still
   * benefiting from Validators.
   */
  readonly form: FormGroup;
  readonly symbolsControl: FormControl<string[]>;
  readonly tfControl: FormControl<Timeframe[]>;

  private formSub?: Subscription;

  constructor() {
    const { start, end } = this.defaultWindow();
    this.symbolsControl = new FormControl<string[]>([], {
      nonNullable: true,
      validators: [Validators.required, this.nonEmptyArrayValidator],
    });
    this.tfControl = new FormControl<Timeframe[]>(['H1'], {
      nonNullable: true,
      validators: [Validators.required, this.nonEmptyArrayValidator],
    });

    this.form = this.fb.group(
      {
        name: this.fb.control<string | null>(null),
        symbols: this.symbolsControl,
        timeframes: this.tfControl,
        windowStartLocal: this.fb.nonNullable.control(start, Validators.required),
        windowEndLocal: this.fb.nonNullable.control(end, Validators.required),
        sampling: this.fb.nonNullable.control<GridSampling>(GridSampling.EveryBarClose),
        everyNthBar: this.fb.control<number | null>(2),
        explicitTimestampsRaw: this.fb.control<string | null>(null),
        maxPoints: this.fb.control<number | null>(DEFAULT_MAX_POINTS, [
          Validators.min(1),
          Validators.max(MAX_POINTS),
        ]),
        maxTokenBudgetUsd: this.fb.control<number | null>(DEFAULT_MAX_BUDGET, [
          Validators.min(1),
          Validators.max(MAX_BUDGET),
        ]),
        dryRun: this.fb.nonNullable.control(false),
        promptVersionOverride: this.fb.control<string | null>(null),
        note: this.fb.control<string | null>(null),
        // Sweep defaults — a sensible MinConfidence sweep around the prod
        // default so the form is immediately runnable when the operator
        // flips the toggle on.
        sweepEnabled: this.fb.nonNullable.control(false),
        sweepKnob: this.fb.nonNullable.control<GuardKnob>(GuardKnob.MinConfidence),
        sweepStart: this.fb.control<number | null>(0.5),
        sweepEnd: this.fb.control<number | null>(0.8),
        sweepStep: this.fb.control<number | null>(0.05),
        // Phase 3 — multi-sample stability. Off by default; mutually exclusive
        // with sweep mode (see `multiSampleError` for the cross-block check).
        multiSampleEnabled: this.fb.nonNullable.control(false),
        sampleCount: this.fb.control<number | null>(MULTI_SAMPLE_DEFAULT),
        // Order-style preference. Default "Any" preserves prior behaviour
        // (the runner sends no entry-bias directive to the LLM).
        entryBias: this.fb.nonNullable.control<'Any' | 'Stop' | 'Limit'>('Any'),
      },
      { validators: this.windowOrderValidator },
    );
  }

  /** Active knob metadata signal — drives the default-value label + UI ranges. */
  readonly activeKnobMeta = computed(() => {
    const knob = this.form?.value.sweepKnob ?? GuardKnob.MinConfidence;
    return GUARD_KNOB_META[knob as GuardKnob];
  });

  /** Suggested HTML `step` attribute for the start/end/step inputs (purely a UI hint). */
  sweepStepHint(): number {
    const meta = this.activeKnobMeta();
    // Per-knob step heuristic — finer for sub-1 ratios, coarse for the
    // minute / R:R-ceiling knobs. Pure UI hint; the user can override.
    if (meta.max <= 1) return 0.01;
    if (meta.max <= 3) return 0.05;
    if (meta.max <= 10) return 0.1;
    return 1;
  }

  /**
   * Effective estimated cost with the multi-sample multiplier applied. The
   * server estimate is single-sample; the worker fans out N LLM calls per
   * cache-miss cell, so the conservative launch-form preview is
   * `serverEstimate × N`. Cache hits give a "free sample 0" bonus on
   * re-runs but the launch form doesn't try to model that — it'd require
   * a separate "expected cache hits" estimate the operator hasn't asked
   * the server for yet.
   */
  effectiveEstimatedCost(e: BacktestCostEstimate): number {
    return e.estimatedCostUsd * this.multiSampleMultiplier();
  }

  /** Budget check against the multi-sample-multiplied cost. */
  fitsBudgetEffective(e: BacktestCostEstimate): boolean {
    return this.effectiveEstimatedCost(e) <= e.maxTokenBudgetUsd;
  }

  /**
   * Derived count of sweep values from current start/end/step.
   * Returns 0 when any input is missing or invalid; the UI surfaces an
   * error message via {@link sweepError} when the inputs are present
   * but inconsistent.
   */
  readonly sweepCount = computed(() => {
    if (!this.form.value.sweepEnabled) return 0;
    const start = this.form.value.sweepStart;
    const end = this.form.value.sweepEnd;
    const step = this.form.value.sweepStep;
    if (start == null || end == null || step == null) return 0;
    if (step <= 0) return 0;
    if (end < start) return 0;
    return Math.floor((end - start) / step) + 1;
  });

  /**
   * Phase 3 — multi-sample mode validation. Returns an inline error string
   * or null when the block is valid (or disabled). The "sweep + multi-sample"
   * mutual-exclusion check sits here so the error appears under whichever
   * block the operator toggles on second.
   */
  readonly multiSampleError = computed<string | null>(() => {
    if (!this.form.value.multiSampleEnabled) return null;
    if (this.form.value.sweepEnabled) {
      return 'Sweep mode and multi-sample mode are mutually exclusive — pick one.';
    }
    const n = this.form.value.sampleCount;
    if (n == null) return 'Set a sample count.';
    if (!Number.isFinite(n)) return 'Sample count must be a number.';
    if (n < MULTI_SAMPLE_MIN || n > MULTI_SAMPLE_MAX) {
      return `Sample count must be between ${MULTI_SAMPLE_MIN} and ${MULTI_SAMPLE_MAX}.`;
    }
    if (!Number.isInteger(n)) return 'Sample count must be a whole number.';
    return null;
  });

  /** Effective multiplier the cost preview applies. 1 when multi-sample is off. */
  readonly multiSampleMultiplier = computed<number>(() => {
    if (!this.form.value.multiSampleEnabled) return 1;
    if (this.multiSampleError() !== null) return 1;
    const n = this.form.value.sampleCount;
    return n && n >= MULTI_SAMPLE_MIN ? n : 1;
  });

  /** Inline-error message for the sweep block; null when the block is valid. */
  readonly sweepError = computed<string | null>(() => {
    if (!this.form.value.sweepEnabled) return null;
    const start = this.form.value.sweepStart;
    const end = this.form.value.sweepEnd;
    const step = this.form.value.sweepStep;
    if (start == null || end == null || step == null) {
      return 'Fill in start, end, and step.';
    }
    if (step <= 0) return 'Step must be > 0.';
    if (end < start) return 'End must be ≥ start.';
    const count = Math.floor((end - start) / step) + 1;
    if (count > SWEEP_MAX_VALUES) {
      return `Sweep would expand to ${count} values (cap is ${SWEEP_MAX_VALUES}). Tighten the range or widen the step.`;
    }
    return null;
  });

  ngOnInit(): void {
    // Pre-populate the symbol picker from the active CurrencyPair catalogue.
    // Failure is non-fatal — operator can still launch with symbols typed in
    // via the URL (no such surface today, but the picker can be re-tried).
    this.currencyPairsSvc
      .list({ currentPage: 1, itemCountPerPage: 500 })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        if (res?.status && res.data?.data) {
          const symbols = res.data.data
            .filter((p) => p.isActive && !!p.symbol)
            .map((p) => p.symbol!.toUpperCase())
            .sort();
          this.availableSymbols.set(symbols);
        }
      });

    // Phase 4 — rolling-window budget snapshot. Fetch once; the worker
    // enforces server-side so a stale snapshot is only a UX hint. Failures
    // are non-fatal — the form falls back to per-run-budget gating only.
    this.budgetLoading.set(true);
    this.svc
      .getBudgetStatus()
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.budgetLoading.set(false);
        if (res?.status && res.data) {
          this.budgetStatus.set(res.data);
          this.budgetError.set(null);
        } else {
          this.budgetStatus.set(null);
          this.budgetError.set(res?.message ?? 'Failed to load budget.');
        }
      });

    // Live cost preview — debounced 300 ms. Fires on EVERY form change so the
    // operator sees the spend update as they tweak the grid. The estimate
    // endpoint is free and stateless on the server.
    this.formSub = this.form.valueChanges
      .pipe(debounceTime(300))
      .subscribe(() => this.refreshEstimate());

    // Kick off an initial estimate so the right-side card isn't empty on load.
    this.refreshEstimate();
  }

  // ── Phase 4 — rolling-budget helpers ─────────────────────────────────────

  /**
   * Colour-code tier for one budget window: green = > 30% remaining,
   * amber = 10–30%, red = < 10%. Disabled windows never render a bar so
   * this is only called with `enabled === true` rows.
   */
  budgetTier(w: BacktestBudgetWindow): 'green' | 'amber' | 'red' {
    if (!w.enabled || w.capUsd <= 0) return 'green';
    const ratio = w.remainingUsd / w.capUsd;
    if (ratio < 0.1) return 'red';
    if (ratio < 0.3) return 'amber';
    return 'green';
  }

  /** Progress-bar fill percentage for one window (spent / cap, clamped 0..100). */
  budgetFillPct(w: BacktestBudgetWindow): number {
    if (!w.enabled || w.capUsd <= 0) return 0;
    const pct = (w.spentUsd / w.capUsd) * 100;
    if (!Number.isFinite(pct)) return 0;
    if (pct < 0) return 0;
    if (pct > 100) return 100;
    return pct;
  }

  /**
   * Inline error pill copy when the effective cost (with the multi-sample
   * multiplier already applied) exceeds the smaller of (daily remaining,
   * weekly remaining). Independent of the per-run `fitsBudget` check — the
   * worker enforces BOTH on the server side, so the form gates submit on
   * both too.
   *
   * Returns `null` when the budget is unknown (snapshot not loaded) or
   * the estimate fits — i.e. submit is allowed by the rolling-budget gate.
   */
  budgetExceededMessage(): string | null {
    const bs = this.budgetStatus();
    const e = this.estimate();
    if (!bs || !e) return null;
    if (this.form.value.dryRun) return null; // dry-run spends $0

    const cost = this.effectiveEstimatedCost(e);

    // Smaller of (daily remaining, weekly remaining), considering only
    // enabled windows. Disabled windows contribute Infinity (no limit).
    const dailyRemaining = bs.daily.enabled ? bs.daily.remainingUsd : Infinity;
    const weeklyRemaining = bs.weekly.enabled ? bs.weekly.remainingUsd : Infinity;
    const tightest = Math.min(dailyRemaining, weeklyRemaining);
    if (!Number.isFinite(tightest)) return null; // both disabled

    if (cost <= tightest) return null;

    const which = dailyRemaining <= weeklyRemaining ? 'daily' : 'weekly';
    const remaining = which === 'daily' ? bs.daily.remainingUsd : bs.weekly.remainingUsd;
    return (
      `Estimated cost ${this.formatCurrency(cost)} exceeds remaining ` +
      `${which} budget ${this.formatCurrency(remaining)}. Lower the grid ` +
      `scope or wait for the budget window to roll over.`
    );
  }

  private formatCurrency(n: number): string {
    return `$${n.toFixed(2)}`;
  }

  ngOnDestroy(): void {
    this.formSub?.unsubscribe();
  }

  // ── Chip handlers ───────────────────────────────────────────────────────

  isSymbolSelected(s: string): boolean {
    return this.symbolsControl.value.includes(s);
  }

  toggleSymbol(s: string): void {
    const cur = this.symbolsControl.value;
    const next = cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s];
    this.symbolsControl.setValue(next);
    this.symbolsControl.markAsTouched();
  }

  isTimeframeSelected(tf: Timeframe): boolean {
    return this.tfControl.value.includes(tf);
  }

  toggleTimeframe(tf: Timeframe): void {
    const cur = this.tfControl.value;
    const next = cur.includes(tf) ? cur.filter((x) => x !== tf) : [...cur, tf];
    this.tfControl.setValue(next);
    this.tfControl.markAsTouched();
  }

  // ── Estimate + submit ───────────────────────────────────────────────────

  private buildSpec(): BacktestGridSpec | null {
    const v = this.form.value as LaunchFormValue;
    if (!v.symbols || v.symbols.length === 0) return null;
    if (!v.timeframes || v.timeframes.length === 0) return null;
    if (!v.windowStartLocal || !v.windowEndLocal) return null;

    const startUtc = new Date(v.windowStartLocal).toISOString();
    const endUtc = new Date(v.windowEndLocal).toISOString();

    let explicit: string[] | null = null;
    if (v.sampling === GridSampling.ExplicitTimestamps) {
      const raw = (v.explicitTimestampsRaw ?? '').trim();
      explicit = raw
        ? raw
            .split(/\r?\n|,/g)
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
            .map((s) => {
              // Pass through valid ISO strings, otherwise round-trip via Date
              // so timezone-less input ("2026-06-13 08:00") still serialises.
              const d = new Date(s);
              return Number.isNaN(d.getTime()) ? s : d.toISOString();
            })
        : null;
    }

    // Sweep block — only emitted when the operator opted in AND the block
    // is locally valid (the same guard `canSubmit` enforces). The server
    // also validates (32-value cap + monotonic range), so this is best-effort.
    let sweep: BacktestSweepSpec | null = null;
    if (v.sweepEnabled && this.sweepError() === null) {
      if (v.sweepStart != null && v.sweepEnd != null && v.sweepStep != null) {
        sweep = {
          knob: v.sweepKnob,
          startValue: v.sweepStart,
          endValue: v.sweepEnd,
          stepValue: v.sweepStep,
        };
      }
    }

    // Phase 3 — multi-sample. Only emit `sampleCount` when the block is
    // toggled on AND locally valid; backend treats absent / 1 as legacy
    // single-sample mode.
    let sampleCount: number | null = null;
    if (v.multiSampleEnabled && this.multiSampleError() === null) {
      sampleCount = v.sampleCount ?? null;
    }

    return {
      symbols: v.symbols,
      timeframes: v.timeframes,
      windowStartUtc: startUtc,
      windowEndUtc: endUtc,
      sampling: v.sampling,
      everyNthBar: v.sampling === GridSampling.EveryNthBar ? (v.everyNthBar ?? null) : null,
      explicitTimestamps: explicit,
      maxPoints: v.maxPoints ?? null,
      maxTokenBudgetUsd: v.maxTokenBudgetUsd ?? null,
      dryRun: !!v.dryRun,
      promptVersionOverride: v.promptVersionOverride?.trim() || null,
      note: v.note?.trim() || null,
      sweep,
      sampleCount,
      // "Any" maps to null on the wire — keeps the backtest cache key
      // bare (no `+bias=` suffix), so default runs hit existing cache rows.
      entryBias: v.entryBias && v.entryBias !== 'Any' ? v.entryBias : null,
    };
  }

  refreshEstimate(): void {
    const spec = this.buildSpec();
    if (!spec) {
      this.estimate.set(null);
      this.estimateError.set(null);
      return;
    }
    this.estimating.set(true);
    this.svc
      .estimateCost({ spec })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.estimating.set(false);
        if (res?.status && res.data) {
          this.estimate.set(res.data);
          this.estimateError.set(null);
        } else {
          this.estimate.set(null);
          this.estimateError.set(res?.message ?? 'Estimate failed. Check your inputs.');
        }
      });
  }

  /**
   * Submit gate — the form must be valid, an estimate must be present, and
   * the estimate must fit the budget. Submission is also blocked while an
   * estimate refresh is in flight to avoid racing the budget check.
   */
  readonly canSubmit = computed(() => {
    if (this.submitting()) return false;
    if (this.estimating()) return false;
    const e = this.estimate();
    // Use the effective (multi-sample-multiplied) cost for the budget gate —
    // backend will reject if the *actual* spend overruns, so the launch form
    // applies the same multiplier the worker will when fanning out samples.
    if (!e || !this.fitsBudgetEffective(e)) return false;
    // form.value still set even when invalid; just don't submit then.
    if (!this.form.valid) return false;
    // Sweep block, if enabled, must locally validate (count ≤ cap, step > 0,
    // end ≥ start). The server enforces too — this gate just keeps the
    // operator's intent honest from the launch form.
    if (this.sweepError() !== null) return false;
    // Phase 3 — multi-sample block, when enabled, must validate AND must
    // not collide with sweep mode. The cross-check lives inside
    // multiSampleError so this single line covers both.
    if (this.multiSampleError() !== null) return false;
    // Phase 4 (P4.1) — rolling-budget gate. Independent of the per-run
    // `fitsBudget` check above; the worker enforces both server-side, so
    // the launch form blocks submit whenever EITHER would trip. Null
    // means the budget snapshot is unknown (transient) or the cost fits
    // — both cases let submit through.
    if (this.budgetExceededMessage() !== null) return false;
    return true;
  });

  onSubmit(): void {
    if (!this.canSubmit()) {
      this.form.markAllAsTouched();
      return;
    }
    const spec = this.buildSpec();
    if (!spec) return;
    const req: CreateLlmBacktestRunRequest = {
      name: (this.form.value.name as string | null)?.trim() || null,
      spec,
    };
    this.submitting.set(true);
    this.svc
      .createRun(req)
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.submitting.set(false);
        if (res?.status && res.data) {
          this.notifications.success(
            `Run #${res.data.id} queued — ${res.data.totalPoints} point(s).`,
          );
          this.router.navigate(['/llm-backtest', res.data.id]);
        } else {
          this.notifications.error(res?.message ?? 'Failed to launch backtest.');
        }
      });
  }

  // ── Validators / defaults ───────────────────────────────────────────────

  private nonEmptyArrayValidator(control: AbstractControl) {
    const v = control.value;
    return Array.isArray(v) && v.length > 0 ? null : { required: true };
  }

  private windowOrderValidator(group: AbstractControl) {
    const start = group.get('windowStartLocal')?.value;
    const end = group.get('windowEndLocal')?.value;
    if (!start || !end) return null;
    return new Date(end) > new Date(start) ? null : { windowOrder: true };
  }

  /**
   * Default window: the trailing 7 days ending now, rounded down to the hour
   * so the start/end picker values are tidy. The form expects
   * `datetime-local` strings (no Z suffix, no offset).
   */
  private defaultWindow(): { start: string; end: string } {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    const end = new Date(now);
    const start = new Date(now);
    start.setUTCDate(start.getUTCDate() - 7);
    const fmt = (d: Date) => {
      const pad = (n: number) => n.toString().padStart(2, '0');
      return (
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
        `T${pad(d.getHours())}:${pad(d.getMinutes())}`
      );
    };
    return { start: fmt(start), end: fmt(end) };
  }
}
