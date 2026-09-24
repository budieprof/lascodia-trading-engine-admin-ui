import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import type { StrategyDto } from '@core/api/api.types';
import { NotificationService } from '@core/notifications/notification.service';
import { ScriptingService } from '@core/services/scripting.service';

import { ScriptStrategyService } from '../api/script-strategy.service';
import type {
  ScriptBacktestRequest,
  ScriptInputDef,
  ScriptStrategyFields,
} from '../api/scripting-api.types';
import { describeFailure, isOk } from '../shared/api-error';
import { scriptInputsOf, scriptSourceOf } from '../shared/script-strategy';
import { InputOverridesEditorComponent } from '../shared/input-overrides-editor.component';

export const ENGINE_TIMEFRAMES = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'] as const;

type MagnifierChoice = 'script' | 'on' | 'off';

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Checks the launcher form; returns the first problem, or null. */
export function validateBacktestForm(f: {
  fromDate: string;
  toDate: string;
  initialBalance: number | string;
  symbolOverride: string;
}): string | null {
  if (!f.fromDate || !f.toDate) return 'Choose a start and an end date.';
  if (Date.parse(f.toDate) <= Date.parse(f.fromDate))
    return 'The end date must be after the start.';
  const balance = Number(f.initialBalance);
  if (!Number.isFinite(balance) || balance <= 0) return 'The initial balance must be above zero.';
  const sym = f.symbolOverride.trim();
  if (sym && !/^[A-Za-z0-9]{1,10}$/.test(sym))
    return 'The symbol override must be 1–10 letters or digits.';
  return null;
}

/**
 * Queues a backtest of a script strategy (§4 `POST backtest`): date range and balance, plus the
 * script-only options — symbol / timeframe override, input overrides (typed from the compiled
 * inputs schema), deep mode and the bar magnifier.
 */
@Component({
  selector: 'app-script-backtest-launcher',
  standalone: true,
  imports: [InputOverridesEditorComponent, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" [attr.aria-labelledby]="uid + '-title'">
      <header class="head">
        <div>
          <h3 class="title" [id]="uid + '-title'">Run a script backtest</h3>
          <p class="sub">
            Runs the script through the broker emulator — the same engine the live session uses.
          </p>
        </div>
        <button
          type="button"
          class="btn ghost"
          [attr.aria-expanded]="open()"
          [attr.aria-controls]="uid + '-form'"
          (click)="open.set(!open())"
        >
          {{ open() ? 'Hide' : 'Configure…' }}
        </button>
      </header>

      @if (lastRunId(); as runId) {
        <p class="queued" role="status">
          Backtest #{{ runId }} queued.
          <a [routerLink]="['/backtests', runId]">Open the run</a>
        </p>
      }

      @if (open()) {
        <!-- novalidate: validateBacktestForm() owns validation; a browser step mismatch on the
             balance or an input would otherwise block the submit without a word. -->
        <form
          [id]="uid + '-form'"
          class="form"
          novalidate
          (submit)="$event.preventDefault(); submit()"
        >
          <div class="grid">
            <label class="field">
              <span>From</span>
              <input
                type="date"
                [value]="fromDate()"
                (change)="fromDate.set($any($event.target).value)"
              />
            </label>
            <label class="field">
              <span>To</span>
              <input
                type="date"
                [value]="toDate()"
                (change)="toDate.set($any($event.target).value)"
              />
            </label>
            <label class="field">
              <span>Initial balance</span>
              <input
                type="number"
                min="1"
                step="any"
                [value]="initialBalance()"
                (change)="initialBalance.set($any($event.target).value)"
              />
            </label>
            <label class="field">
              <span>Symbol override</span>
              <input
                type="text"
                spellcheck="false"
                autocomplete="off"
                [placeholder]="strategy().symbol || 'Strategy symbol'"
                [value]="symbolOverride()"
                (input)="symbolOverride.set($any($event.target).value.toUpperCase())"
              />
            </label>
            <label class="field">
              <span>Timeframe override</span>
              <select (change)="timeframeOverride.set($any($event.target).value)">
                <option value="" [selected]="timeframeOverride() === ''">
                  Strategy's own ({{ strategy().timeframe }})
                </option>
                @for (tf of timeframes; track tf) {
                  <option [value]="tf" [selected]="timeframeOverride() === tf">{{ tf }}</option>
                }
              </select>
            </label>
            <label class="field">
              <span>Bar magnifier</span>
              <select (change)="magnifier.set($any($event.target).value)">
                <option value="script" [selected]="magnifier() === 'script'">
                  Script setting ({{
                    declaredMagnifier() === null ? 'unknown' : declaredMagnifier() ? 'on' : 'off'
                  }})
                </option>
                <option value="on" [selected]="magnifier() === 'on'">
                  On — fill on lower-timeframe bars
                </option>
                <option value="off" [selected]="magnifier() === 'off'">Off — OHLC path only</option>
              </select>
            </label>
          </div>

          <label class="check">
            <input
              type="checkbox"
              [checked]="deep()"
              (change)="deep.set($any($event.target).checked)"
            />
            <span>Deep mode — stream the history (up to 2M bars) for long ranges</span>
          </label>

          @if (overrideNote()) {
            <p class="note">{{ overrideNote() }}</p>
          }

          <div class="inputs">
            <h4 class="inputs-title">Inputs</h4>
            @if (compiling()) {
              <p class="muted" role="status">Reading the script's inputs…</p>
            } @else {
              @if (compileNote()) {
                <p class="note">{{ compileNote() }}</p>
              }
              <app-input-overrides-editor
                [inputs]="inputDefs()"
                [baseline]="savedInputs()"
                (overridesChange)="overrides.set($event)"
                (validityChange)="inputsValid.set($event)"
              />
            }
          </div>

          @if (formError()) {
            <p class="error" role="alert">{{ formError() }}</p>
          }
          <div class="actions">
            <button type="submit" class="btn primary" [disabled]="submitting() || compiling()">
              {{ submitting() ? 'Queuing…' : 'Queue backtest' }}
            </button>
          </div>
        </form>
      }
    </section>
  `,
  styles: [
    `
      .card {
        margin-bottom: var(--space-4);
        padding: var(--space-4) var(--space-5);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: var(--space-3);
      }
      .title {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .sub {
        margin: 2px 0 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .form {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr));
        gap: var(--space-3);
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .field input,
      .field select {
        height: 34px;
        padding: 0 var(--space-2);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font: inherit;
        font-size: var(--text-sm);
      }
      .check {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        font-size: var(--text-sm);
      }
      .inputs-title {
        margin: 0 0 var(--space-2);
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .actions {
        display: flex;
        justify-content: flex-end;
      }
      .btn {
        height: 34px;
        padding: 0 var(--space-4);
        border-radius: var(--radius-full);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font: inherit;
        font-size: var(--text-sm);
        cursor: pointer;
      }
      .btn.primary {
        background: var(--accent);
        border-color: var(--accent);
        color: #fff;
      }
      .btn.ghost {
        background: transparent;
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .btn:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      .queued {
        margin: 0;
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-sm);
        background: rgba(52, 199, 89, 0.1);
        font-size: var(--text-sm);
      }
      .queued a {
        color: var(--accent);
        margin-left: var(--space-2);
      }
      .note {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .muted {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .error {
        margin: 0;
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-sm);
        background: rgba(255, 59, 48, 0.08);
        color: var(--loss);
        font-size: var(--text-sm);
      }
    `,
  ],
})
export class ScriptBacktestLauncherComponent {
  private readonly api = inject(ScriptStrategyService);
  private readonly scripting = inject(ScriptingService);
  private readonly notifications = inject(NotificationService);

  readonly strategy = input.required<StrategyDto & ScriptStrategyFields>();
  /** A run was queued; carries its id. */
  readonly queued = output<number>();

  private static nextUid = 0;
  readonly uid = `sbl-${ScriptBacktestLauncherComponent.nextUid++}`;
  readonly timeframes = ENGINE_TIMEFRAMES;

  readonly open = signal(false);
  readonly fromDate = signal(isoDate(new Date(Date.now() - 365 * 86_400_000)));
  readonly toDate = signal(isoDate(new Date()));
  readonly initialBalance = signal<number | string>(10_000);
  readonly symbolOverride = signal('');
  readonly timeframeOverride = signal('');
  readonly magnifier = signal<MagnifierChoice>('script');
  readonly deep = signal(false);

  readonly compiling = signal(false);
  readonly compileNote = signal<string | null>(null);
  readonly inputDefs = signal<ScriptInputDef[] | null>(null);
  readonly declaredMagnifier = signal<boolean | null>(null);
  readonly overrides = signal<Record<string, unknown>>({});
  readonly inputsValid = signal(true);

  readonly submitting = signal(false);
  readonly formError = signal<string | null>(null);
  readonly lastRunId = signal<number | null>(null);

  readonly savedInputs = computed(() => scriptInputsOf(this.strategy()));

  readonly overrideNote = computed(() => {
    const sym = this.symbolOverride().trim();
    const tf = this.timeframeOverride();
    if (!sym && !tf) return null;
    return 'An override run tests the script on another market; it is recorded as such and is never read as validation of the deployed strategy.';
  });

  private compiledFor: string | null = null;

  constructor() {
    // Compile on first open (and again if the script changed) to learn the inputs schema.
    effect(() => {
      const isOpen = this.open();
      const source = scriptSourceOf(this.strategy());
      untracked(() => {
        if (isOpen && source !== this.compiledFor) this.compile(source);
      });
    });
  }

  private compile(source: string | null): void {
    this.compiledFor = source;
    this.compileNote.set(null);
    if (!source) {
      this.inputDefs.set(null);
      this.compileNote.set('This strategy carries no script source to read inputs from.');
      return;
    }
    const s = this.strategy();
    this.compiling.set(true);
    // A script with errors still resolves (with its diagnostics); only a refusal without a
    // compile result, or an unreachable engine, rejects.
    this.scripting
      .compile({ source, symbol: s.symbol ?? undefined, timeframe: s.timeframe ?? undefined })
      .subscribe({
        next: (result) => {
          this.compiling.set(false);
          this.inputDefs.set(result.inputs ?? []);
          const props = result.declaration?.strategy ?? null;
          const capital = Number(props?.initialCapital);
          if (Number.isFinite(capital) && capital > 0) this.initialBalance.set(capital);
          const mag = props?.useBarMagnifier;
          this.declaredMagnifier.set(typeof mag === 'boolean' ? mag : null);
        },
        error: (err: unknown) => {
          this.compiling.set(false);
          this.inputDefs.set(null);
          this.compileNote.set(
            `The script could not be compiled (${describeFailure(err, 'the engine did not answer')}); enter overrides by input id.`,
          );
        },
      });
  }

  /** The request body, or an error message. */
  buildRequest(): ScriptBacktestRequest | string {
    const problem = validateBacktestForm({
      fromDate: this.fromDate(),
      toDate: this.toDate(),
      initialBalance: this.initialBalance(),
      symbolOverride: this.symbolOverride(),
    });
    if (problem) return problem;
    if (!this.inputsValid()) return 'Fix the highlighted inputs first.';
    const s = this.strategy();
    if (!s.symbol) return 'The strategy has no symbol.';
    const req: ScriptBacktestRequest = {
      strategyId: s.id,
      symbol: s.symbol,
      timeframe: s.timeframe,
      fromDate: this.fromDate(),
      toDate: this.toDate(),
      initialBalance: Number(this.initialBalance()),
    };
    const sym = this.symbolOverride().trim().toUpperCase();
    if (sym && sym !== s.symbol.toUpperCase()) req.symbolOverride = sym;
    const tf = this.timeframeOverride();
    if (tf && tf !== s.timeframe) req.timeframeOverride = tf;
    const inputs = this.overrides();
    if (Object.keys(inputs).length > 0) req.inputs = inputs;
    if (this.deep()) req.deep = true;
    if (this.magnifier() !== 'script') req.barMagnifier = this.magnifier() === 'on';
    return req;
  }

  submit(): void {
    if (this.submitting()) return;
    const req = this.buildRequest();
    if (typeof req === 'string') {
      this.formError.set(req);
      return;
    }
    this.formError.set(null);
    this.submitting.set(true);
    this.api.queueBacktest(req).subscribe({
      next: (res) => {
        this.submitting.set(false);
        if (!isOk(res) || !res.data) {
          this.formError.set(describeFailure(res, 'The engine did not queue the backtest.'));
          return;
        }
        this.lastRunId.set(res.data);
        this.notifications.success(`Backtest #${res.data} queued`);
        this.queued.emit(res.data);
      },
      error: (err: unknown) => {
        this.submitting.set(false);
        this.formError.set(describeFailure(err, 'Queuing the backtest failed.'));
      },
    });
  }
}
