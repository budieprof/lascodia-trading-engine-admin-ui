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
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import type { CurrencyPairDto, StrategyDto, Timeframe } from '@core/api/api.types';
import { StrategiesService } from '@core/services/strategies.service';
import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import { NotificationService } from '@core/notifications/notification.service';
import { ENGINE_TIMEFRAMES, forEachCondition, parseDsl, timeframeRank } from '../../dsl/dsl-model';
import { failureMessage } from '../../util/api-failure';

/**
 * "Clone to another symbol/timeframe…": copies a strategy — rules, risk
 * profile, sub-configs — into a new Paused draft via `POST /strategy/{id}/clone`
 * and opens it. This is how a strategy moves to another symbol or timeframe:
 * the engine treats both (and the type) as immutable, so the edit form no
 * longer pretends they can be changed.
 */
@Component({
  selector: 'app-clone-strategy-dialog',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (strategy(); as s) {
      <div
        class="overlay"
        role="presentation"
        tabindex="-1"
        (click)="close()"
        (keydown.escape)="close()"
      >
        <div
          class="dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="clone-strategy-title"
          tabindex="-1"
          (click)="$event.stopPropagation()"
          (keydown)="$event.stopPropagation()"
        >
          <header class="head">
            <div>
              <h3 id="clone-strategy-title">Clone strategy</h3>
              <p class="sub">
                Copies #{{ s.id }} {{ s.name }} ({{ s.symbol }} · {{ s.timeframe }}) — rules, risk
                profile and filters — into a new <strong>Paused</strong> draft, then opens it.
              </p>
            </div>
            <button type="button" class="close" (click)="close()" aria-label="Close">×</button>
          </header>

          <div class="body">
            <label class="field">
              <span>Name</span>
              <input
                type="text"
                maxlength="100"
                [ngModel]="name()"
                (ngModelChange)="name.set($event)"
                [placeholder]="(s.name ?? 'Strategy') + ' (copy)'"
              />
            </label>
            <div class="row">
              <label class="field">
                <span>Symbol</span>
                <input
                  type="text"
                  maxlength="10"
                  list="clone-strategy-symbols"
                  [ngModel]="symbol()"
                  (ngModelChange)="symbol.set(($event ?? '').toUpperCase())"
                />
              </label>
              <label class="field">
                <span>Timeframe</span>
                <select [ngModel]="timeframe()" (ngModelChange)="timeframe.set($event)">
                  @for (tf of timeframes; track tf) {
                    <option [value]="tf">{{ tf }}</option>
                  }
                </select>
              </label>
            </div>
            <datalist id="clone-strategy-symbols">
              @for (p of pairs(); track p.id) {
                @if (p.symbol) {
                  <option [value]="p.symbol">{{ p.symbol }}</option>
                }
              }
            </datalist>

            @if (sameTarget()) {
              <p class="hint">
                Same symbol and timeframe as the source — the copy is an independent draft you can
                edit without touching #{{ s.id }}.
              </p>
            }
            @if (htfConflict(); as tfs) {
              <p class="warn">
                The rules use higher-timeframe conditions on {{ tfs }}, which are not above
                {{ timeframe() }} — they would never fire on the copy until you change them.
              </p>
            }
            @if (error(); as err) {
              <p class="error" role="alert">⚠ {{ err }}</p>
            }
          </div>

          <footer class="foot">
            <button type="button" class="btn btn-secondary" (click)="close()" [disabled]="busy()">
              Cancel
            </button>
            <button
              type="button"
              class="btn btn-primary"
              (click)="submit()"
              [disabled]="busy() || !canSubmit()"
            >
              {{ busy() ? 'Cloning…' : 'Clone & open' }}
            </button>
          </footer>
        </div>
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: contents;
      }
      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.45);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1100;
        padding: var(--space-4, 16px);
      }
      .dialog {
        background: var(--bg-primary, #fff);
        border: 1px solid var(--border, #e5e5ea);
        border-radius: var(--radius-lg, 12px);
        box-shadow: var(--shadow-lg);
        width: 100%;
        max-width: 480px;
        display: flex;
        flex-direction: column;
      }
      .head {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        padding: 16px 20px 8px;
      }
      .head h3 {
        margin: 0;
        font-size: var(--text-lg, 17px);
      }
      .sub {
        margin: 4px 0 0;
        font-size: 12px;
        color: var(--text-secondary, #636366);
      }
      .close {
        background: none;
        border: none;
        font-size: 22px;
        line-height: 1;
        cursor: pointer;
        color: var(--text-secondary, #636366);
      }
      .body {
        padding: 8px 20px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 12px;
        color: var(--text-secondary, #636366);
      }
      .field input,
      .field select {
        height: 32px;
        padding: 0 10px;
        border: 1px solid var(--border, #e5e5ea);
        border-radius: var(--radius-sm, 6px);
        background: var(--bg-primary, #fff);
        color: var(--text-primary, #1d1d1f);
        font-size: 13px;
      }
      .hint,
      .warn,
      .error {
        margin: 0;
        font-size: 12px;
        padding: 6px 10px;
        border-radius: 4px;
      }
      .hint {
        color: var(--text-secondary, #636366);
        background: var(--bg-secondary, #f7f8fa);
      }
      .warn {
        color: #8a4b00;
        background: rgba(255, 149, 0, 0.1);
      }
      .error {
        color: #8e1010;
        background: rgba(255, 59, 48, 0.08);
      }
      .foot {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding: 12px 20px 16px;
      }
      .btn {
        height: 34px;
        padding: 0 16px;
        border: none;
        border-radius: 999px;
        font-size: 13px;
        cursor: pointer;
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .btn-secondary {
        background: var(--bg-tertiary, #f2f2f7);
        color: var(--text-primary, #1d1d1f);
      }
      .btn-primary {
        background: var(--accent, #0071e3);
        color: #fff;
      }
    `,
  ],
})
export class CloneStrategyDialogComponent {
  private readonly strategies = inject(StrategiesService);
  private readonly currencyPairs = inject(CurrencyPairsService);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);

  /** The strategy to clone; the dialog is open while this is non-null. */
  strategy = input<StrategyDto | null>(null);
  closed = output<void>();
  /** The new strategy's id — emitted just before navigating to it. */
  cloned = output<number>();

  readonly timeframes = ENGINE_TIMEFRAMES;
  readonly name = signal('');
  readonly symbol = signal('');
  readonly timeframe = signal<Timeframe>('H1');
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly pairs = signal<CurrencyPairDto[]>([]);
  private pairsLoaded = false;

  private readonly reset = effect(() => {
    const s = this.strategy();
    untracked(() => {
      this.error.set(null);
      this.busy.set(false);
      if (!s) return;
      this.name.set(`${s.name ?? 'Strategy'} (copy)`);
      this.symbol.set(s.symbol ?? '');
      this.timeframe.set(s.timeframe);
      this.loadPairs();
    });
  });

  readonly canSubmit = computed(() => {
    const sym = this.symbol().trim();
    return sym.length > 0 && sym.length <= 10 && timeframeRank(this.timeframe()) >= 0;
  });

  readonly sameTarget = computed(() => {
    const s = this.strategy();
    return (
      !!s &&
      this.symbol().trim().toUpperCase() === (s.symbol ?? '').toUpperCase() &&
      this.timeframe() === s.timeframe
    );
  });

  /** Higher-timeframe conditions that would not be above the copy's timeframe. */
  readonly htfConflict = computed<string | null>(() => {
    const s = this.strategy();
    if (!s?.parametersJson) return null;
    if (s.strategyType !== 'RuleBased' && s.strategyType !== 'LlmProposal') return null;
    const parsed = parseDsl(s.parametersJson);
    if (!parsed.ok) return null;
    const target = timeframeRank(this.timeframe());
    const bad = new Set<string>();
    forEachCondition(parsed.doc, (c) => {
      const htf = c.config['higherTimeframe'];
      if (
        c.type === 'HtfIndicatorThreshold' &&
        timeframeRank(htf) >= 0 &&
        timeframeRank(htf) <= target
      ) {
        bad.add(String(htf));
      }
    });
    return bad.size > 0 ? [...bad].join(', ') : null;
  });

  private loadPairs(): void {
    if (this.pairsLoaded) return;
    this.pairsLoaded = true;
    this.currencyPairs
      .list({ currentPage: 1, itemCountPerPage: 200, filter: { isActive: true } })
      .subscribe({
        next: (res) => this.pairs.set(res?.data?.data ?? []),
        error: () => this.pairs.set([]),
      });
  }

  close(): void {
    if (this.busy()) return;
    this.closed.emit();
  }

  submit(): void {
    const s = this.strategy();
    if (!s || this.busy() || !this.canSubmit()) return;
    this.busy.set(true);
    this.error.set(null);
    const name = this.name().trim();
    this.strategies
      .clone(
        s.id,
        {
          name: name || null,
          symbol: this.symbol().trim().toUpperCase(),
          timeframe: this.timeframe(),
        },
        { silent: true },
      )
      .subscribe({
        next: (res) => {
          this.busy.set(false);
          const id = res?.status ? Number(res.data) : NaN;
          if (!Number.isFinite(id) || id <= 0) {
            this.error.set(failureMessage(res, 'The engine did not clone the strategy.'));
            return;
          }
          this.notifications.success(`Cloned as #${id} — a Paused draft`);
          this.cloned.emit(id);
          this.closed.emit();
          this.router.navigate(['/strategies', id]);
        },
        error: (err) => {
          this.busy.set(false);
          this.error.set(failureMessage(err, 'Cloning failed.'));
        },
      });
  }
}
