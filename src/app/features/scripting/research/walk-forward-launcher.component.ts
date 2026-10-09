import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { StrategyDto } from '@core/api/api.types';

import { SCRIPTING_UI_STYLES } from '../components/scripting-ui.styles';
import { describeFailure } from '../shared/api-error';
import { isScriptStrategy } from '../shared/script-strategy';
import { ResearchApiService } from './research-api.service';
import {
  defaultLauncher,
  foldEstimate,
  launchRequest,
  type LauncherDraft,
} from './research-runs.model';

/**
 * BT-I5 / BT-13 — start a walk-forward on the strategy's own market: the date range, the in-sample and out-of-sample
 * window lengths, whether the in-sample window is anchored at the start (growing) or rolls, and whether each fold
 * re-optimises the inputs on its in-sample window (the true walk-forward) or scores the current inputs on every
 * out-of-sample window. The final 10 % of the range is kept back as the locked holdout.
 */
@Component({
  selector: 'app-walk-forward-launcher',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" aria-labelledby="wfl-title" data-testid="walk-forward-launcher">
      <header class="head">
        <h3 id="wfl-title" class="title">Start a walk-forward</h3>
        <span class="muted small">{{ strategy().symbol }} {{ strategy().timeframe }}</span>
      </header>
      <div class="grid">
        <label>
          <span class="muted small">From</span>
          <input
            class="field-input"
            type="date"
            [value]="draft().fromDate"
            (change)="set('fromDate', $any($event.target).value)"
          />
        </label>
        <label>
          <span class="muted small">To</span>
          <input
            class="field-input"
            type="date"
            [value]="draft().toDate"
            (change)="set('toDate', $any($event.target).value)"
          />
        </label>
        <label>
          <span class="muted small">In-sample days</span>
          <input
            class="field-input"
            type="number"
            min="1"
            step="1"
            [value]="draft().inSampleDays"
            (input)="set('inSampleDays', $any($event.target).value)"
          />
        </label>
        <label>
          <span class="muted small">Out-of-sample days</span>
          <input
            class="field-input"
            type="number"
            min="1"
            step="1"
            [value]="draft().outOfSampleDays"
            (input)="set('outOfSampleDays', $any($event.target).value)"
          />
        </label>
        <label>
          <span class="muted small">In-sample window</span>
          <select
            class="field-input"
            (change)="set('windowMode', $any($event.target).value)"
            data-testid="wfl-mode"
          >
            <option value="Anchored" [selected]="draft().windowMode === 'Anchored'">
              Anchored — from the start, growing
            </option>
            <option value="Rolling" [selected]="draft().windowMode === 'Rolling'">
              Rolling — the days before each fold
            </option>
          </select>
        </label>
        @if (!isScript()) {
          <label>
            <span class="muted small">Starting balance</span>
            <input
              class="field-input"
              type="number"
              min="1"
              [value]="draft().initialBalance"
              (input)="set('initialBalance', $any($event.target).value)"
            />
          </label>
        }
      </div>
      <label class="check">
        <input
          type="checkbox"
          [checked]="draft().reOptimizePerFold"
          (change)="set('reOptimizePerFold', $any($event.target).checked)"
          data-testid="wfl-reopt"
        />
        Re-optimise the inputs on each fold's in-sample window
      </label>
      <p class="muted small">
        @if (draft().reOptimizePerFold) {
          Each fold searches the inputs on its in-sample window, then scores the winner on the next
          {{ draft().outOfSampleDays }} days it never saw — so efficiency and input drift can be
          measured.
        } @else {
          The current inputs are scored on every out-of-sample window; the in-sample windows are not
          used, so anchored and rolling score the same.
        }
        @if (isScript()) {
          The script's own initial capital is the starting balance.
        }
      </p>
      <p class="muted small" data-testid="wfl-folds">
        @if (folds(); as n) {
          About {{ n }} out-of-sample fold{{ n === 1 ? '' : 's' }}; the last 10 % of the range is
          kept back as the holdout, scored once when the strategy is approved.
        } @else {
          Too short for a fold: lengthen the range or shorten the windows.
        }
      </p>
      @if (problem(); as p) {
        <p class="error-box" role="alert" data-testid="wfl-problem">{{ p }}</p>
      }
      <div class="actions">
        <button
          type="button"
          class="btn btn-primary"
          data-testid="wfl-start"
          [disabled]="!canRun() || starting()"
          [attr.title]="canRun() ? null : 'Starting a walk-forward needs the analyst permission.'"
          (click)="start()"
        >
          @if (starting()) {
            <span class="spinner" aria-hidden="true"></span>
          }
          Start walk-forward
        </button>
      </div>
    </section>
  `,
  styles: [
    SCRIPTING_UI_STYLES,
    `
      :host {
        display: block;
      }
      .card {
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
        align-items: baseline;
        gap: 8px;
      }
      .title {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(min(100%, 180px), 1fr));
        gap: 12px;
      }
      .grid label {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .check {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: var(--text-sm);
      }
      .actions {
        display: flex;
        justify-content: flex-end;
      }
      p {
        margin: 0;
      }
    `,
  ],
})
export class WalkForwardLauncherComponent {
  private readonly api = inject(ResearchApiService);

  readonly strategy = input.required<StrategyDto>();
  readonly canRun = input(true);
  readonly launched = output<number>();

  readonly draft = signal<LauncherDraft>(defaultLauncher(new Date()));
  readonly starting = signal(false);
  readonly problem = signal<string | null>(null);

  readonly isScript = computed(() => isScriptStrategy(this.strategy()));
  readonly folds = computed(() => foldEstimate(this.draft()));

  set<K extends keyof LauncherDraft>(key: K, value: LauncherDraft[K]): void {
    this.draft.update((d) => ({ ...d, [key]: value }));
    this.problem.set(null);
  }

  async start(): Promise<void> {
    const s = this.strategy();
    const req = launchRequest(this.draft(), {
      id: s.id,
      symbol: s.symbol,
      timeframe: String(s.timeframe),
    });
    if (typeof req === 'string') {
      this.problem.set(req);
      return;
    }
    this.starting.set(true);
    this.problem.set(null);
    try {
      const res = await firstValueFrom(this.api.launchWalkForward(req));
      if (!res?.status || typeof res.data !== 'number') throw res;
      this.launched.emit(res.data);
    } catch (err) {
      this.problem.set(describeFailure(err, 'The walk-forward could not be started.'));
    } finally {
      this.starting.set(false);
    }
  }
}
