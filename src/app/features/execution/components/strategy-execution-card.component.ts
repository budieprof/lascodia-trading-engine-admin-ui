import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { LscCanDirective } from '@core/auth/can.directive';
import { errorText } from '@features/iam/iam.logic';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';

import { ExecutionApiService } from '../execution-api.service';
import { ALGORITHMS, ALGORITHM_HELP } from '../execution.logic';
import type { ExecutionAlgorithm } from '../execution.types';

/**
 * A strategy's execution algorithm (gaps program, execution): Direct (one order per signal and account, as always) or
 * TWAP / VWAP / Iceberg / Adaptive with its window, slices or display size. Saved through
 * `PUT execution/strategies/{id}/algorithm` (`strategies.edit`, audited). Script strategies stay Direct.
 */
@Component({
  selector: 'app-strategy-execution-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, LscCanDirective, ConfirmDialogComponent],
  styles: [
    `
      :host { display: block; margin: 12px 0; }
      .row { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; padding: 8px 16px; }
      label { display: flex; flex-direction: column; gap: 4px; font-size: 0.8rem; }
      .help { font-size: 0.8rem; color: var(--text-muted, #666); padding: 0 16px 8px; }
      .ok { color: #14532d; padding: 0 16px; }
      .bad { color: #8a1c14; padding: 0 16px; }
    `,
  ],
  template: `
    <section class="card">
      <div class="card-head"><h3>Execution algorithm</h3></div>
      <div class="row">
        <label
          >Algorithm
          <select class="input" [ngModel]="algorithm()" (ngModelChange)="algorithm.set($event)" [disabled]="isScript()">
            @for (a of algorithms; track a) {
              <option [value]="a">{{ a }}</option>
            }
          </select>
        </label>
        @if (algorithm() !== 'Direct') {
          <label>Window (min)<input class="input" type="number" min="1" [ngModel]="minutes()" (ngModelChange)="minutes.set($event === '' ? null : +$event)" /></label>
          @if (algorithm() === 'TWAP' || algorithm() === 'VWAP') {
            <label>Slices<input class="input" type="number" min="2" max="50" [ngModel]="slices()" (ngModelChange)="slices.set($event === '' ? null : +$event)" /></label>
          }
          @if (algorithm() === 'Iceberg') {
            <label>Show (lots)<input class="input" type="number" step="0.01" min="0.01" [ngModel]="display()" (ngModelChange)="display.set($event === '' ? null : +$event)" /></label>
          }
        }
        <button type="button" class="btn btn-sm btn-primary" *lscCan="'strategies.edit'" [disabled]="busy() || isScript()" (click)="confirm.set(true)">Save</button>
      </div>
      <p class="help">
        {{ help() }}
        @if (isScript()) {
          A script strategy's entries are its emulator's fills, so it always executes Direct.
        }
        Needs <code>Execution:Algo:Enabled</code>; while it is off the strategy executes Direct.
      </p>
      @if (message()) {
        <p class="ok" role="status">{{ message() }}</p>
      }
      @if (error()) {
        <p class="bad" role="alert">{{ error() }}</p>
      }
    </section>
    <app-confirm-dialog
      [open]="confirm()"
      title="Change how this strategy executes?"
      [message]="'From its next signal, strategy ' + strategyId() + ' executes ' + (algorithm() === 'Direct' ? 'Direct (one order per signal and account).' : 'through ' + algorithm() + ': each account gets a parent whose child orders each pass the account risk check and the EA gates.')"
      confirmLabel="Save"
      [loading]="busy()"
      (confirm)="save()"
      (cancelled)="confirm.set(false)"
    />
  `,
})
export class StrategyExecutionCardComponent {
  private readonly api = inject(ExecutionApiService);

  readonly strategyId = input.required<number>();
  readonly current = input<string | null | undefined>('Direct');
  readonly currentParamsJson = input<string | null | undefined>(null);
  readonly isScript = input(false);

  protected readonly algorithms = ALGORITHMS;
  readonly algorithm = signal<ExecutionAlgorithm>('Direct');
  readonly minutes = signal<number | null>(null);
  readonly slices = signal<number | null>(null);
  readonly display = signal<number | null>(null);
  readonly busy = signal(false);
  readonly confirm = signal(false);
  readonly message = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly help = computed(() => ALGORITHM_HELP[this.algorithm()]);

  constructor() {
    effect(() => {
      const cur = (this.current() ?? 'Direct') as ExecutionAlgorithm;
      this.algorithm.set(ALGORITHMS.includes(cur) ? cur : 'Direct');
      const raw = this.currentParamsJson();
      if (!raw) return;
      try {
        const p = JSON.parse(raw) as { durationSeconds?: number; slices?: number; displayQuantity?: number };
        this.minutes.set(p.durationSeconds ? Math.round(p.durationSeconds / 60) : null);
        this.slices.set(p.slices ?? null);
        this.display.set(p.displayQuantity ?? null);
      } catch {
        // Unreadable stored parameters: the form starts from the defaults.
      }
    });
  }

  save(): void {
    this.busy.set(true);
    this.error.set(null);
    this.message.set(null);
    const a = this.algorithm();
    this.api
      .setStrategyAlgorithm(this.strategyId(), {
        algorithm: a,
        durationSeconds: a !== 'Direct' && this.minutes() ? Math.round(this.minutes()! * 60) : null,
        slices: a === 'TWAP' || a === 'VWAP' ? this.slices() : null,
        displayQuantity: a === 'Iceberg' ? this.display() : null,
      })
      .subscribe({
        next: (res) => {
          this.busy.set(false);
          this.confirm.set(false);
          if (res?.status) this.message.set(res.message || 'Saved.');
          else if (res?.responseCode === '-202-approval') this.message.set('Sent for approval.');
          else this.error.set(res?.message || 'The change was refused.');
        },
        error: (e) => {
          this.busy.set(false);
          this.confirm.set(false);
          this.error.set(errorText(e, 'The change was not saved.'));
        },
      });
  }
}
