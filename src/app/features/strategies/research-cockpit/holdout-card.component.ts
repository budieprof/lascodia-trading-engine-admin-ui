import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { describeFailure } from '@features/scripting/shared/api-error';

import { COCKPIT_CARD_STYLES } from './cockpit.styles';
import { ResearchCockpitApiService } from './research-cockpit-api.service';
import { holdoutView, shortHash } from './research-cockpit.model';
import type { StrategyHoldoutDto } from './research-cockpit.types';

/**
 * U12 / V03 — the lineage's final-test holdout: its window, Locked or Spent, Record or Enforce, and the single score.
 * Evaluate SPENDS a locked holdout (once, immutable); re-carve retires a spent one and carves fresh months. Both are
 * operator actions behind a confirm dialog that says exactly that.
 */
@Component({
  selector: 'app-holdout-card',
  standalone: true,
  imports: [ConfirmDialogComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" aria-labelledby="ho-title" data-testid="holdout-card">
      <header class="head">
        <h3 id="ho-title" class="title">Lineage holdout</h3>
        @if (holdout(); as h) {
          <span class="chip" [attr.data-tone]="h.status === 'Spent' ? 'warn' : 'ok'">{{
            h.status
          }}</span>
          <span class="chip">{{ h.mode }}</span>
        }
        <span class="spacer"></span>
        @if (canOperate() && view(); as v) {
          @if (v.canEvaluate) {
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              [disabled]="busy()"
              (click)="confirm.set('evaluate')"
            >
              Evaluate now
            </button>
          }
          @if (v.canRecarve) {
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              [disabled]="busy()"
              (click)="confirm.set('recarve')"
            >
              Re-carve
            </button>
          }
        }
      </header>
      @if (error(); as e) {
        <p class="error-box" role="alert">{{ e }}</p>
      }
      @if (holdout(); as h) {
        @if (view(); as v) {
          <p class="small">
            <strong>{{ v.window }}</strong>
          </p>
          <p class="small" data-testid="ho-status">{{ v.statusLine }}</p>
          <p class="muted small">{{ v.modeLine }}</p>
          @if (h.spentConfigHash) {
            <p class="muted small">
              Spent on configuration <span class="mono">{{ short(h.spentConfigHash) }}</span
              >.
            </p>
          }
          @if (v.result.length > 0) {
            <table aria-label="Holdout score">
              <tbody>
                @for (row of v.result; track row.label) {
                  <tr>
                    <th scope="row">{{ row.label }}</th>
                    <td>{{ row.value }}</td>
                  </tr>
                }
              </tbody>
            </table>
          }
        }
      } @else if (missing(); as m) {
        <p class="muted">{{ m }}</p>
      } @else if (loading()) {
        <p class="muted">Loading…</p>
      }
    </section>

    <app-confirm-dialog
      [open]="confirm() === 'evaluate'"
      title="Spend the lineage holdout?"
      message="Scores the holdout window ONCE for the strategy's current configuration. The result is final: another configuration of this lineage can no longer be judged on these months until the holdout is re-carved."
      confirmLabel="Evaluate and spend"
      confirmVariant="destructive"
      [loading]="busy()"
      (confirm)="act('evaluate')"
      (cancelled)="confirm.set(null)"
    />
    <app-confirm-dialog
      [open]="confirm() === 'recarve'"
      title="Re-carve the holdout?"
      message="Retires the spent holdout and carves a fresh window over the latest months. Automatic evidence runs of new lineages then stop before the new window."
      confirmLabel="Re-carve"
      [loading]="busy()"
      (confirm)="act('recarve')"
      (cancelled)="confirm.set(null)"
    />
  `,
  styles: [COCKPIT_CARD_STYLES],
})
export class HoldoutCardComponent {
  private readonly api = inject(ResearchCockpitApiService);
  private readonly auth = inject(AuthService);

  readonly strategyId = input.required<number>();

  readonly holdout = signal<StrategyHoldoutDto | null>(null);
  readonly missing = signal<string | null>(null);
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly confirm = signal<'evaluate' | 'recarve' | null>(null);

  readonly canOperate = computed(() => this.auth.hasPermission(Permission.AccessOperator));
  readonly view = computed(() => {
    const h = this.holdout();
    return h ? holdoutView(h) : null;
  });

  constructor() {
    effect(() => {
      const id = this.strategyId();
      untracked(() => void this.load(id));
    });
  }

  async load(id = this.strategyId()): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const res = await firstValueFrom(this.api.holdout(id));
      if (id !== this.strategyId()) return;
      if (res?.status && res.data) {
        this.holdout.set(res.data);
        this.missing.set(null);
      } else {
        this.holdout.set(null);
        // -14: the lineage has no holdout yet — the engine's own sentence says when it is carved.
        this.missing.set(res?.message || 'This lineage has no holdout yet.');
      }
    } catch (err) {
      if (id === this.strategyId())
        this.error.set(describeFailure(err, 'The holdout could not be read.'));
    } finally {
      this.loading.set(false);
    }
  }

  async act(kind: 'evaluate' | 'recarve'): Promise<void> {
    if (!this.canOperate()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const call =
        kind === 'evaluate'
          ? this.api.evaluateHoldout(this.strategyId())
          : this.api.recarveHoldout(this.strategyId());
      const res = await firstValueFrom(call);
      if (res?.status && res.data) this.holdout.set(res.data);
      else
        this.error.set(
          describeFailure(
            res,
            kind === 'evaluate'
              ? 'The holdout could not be evaluated.'
              : 'The holdout could not be re-carved.',
          ),
        );
    } catch (err) {
      this.error.set(describeFailure(err, 'The engine refused the holdout action.'));
    } finally {
      this.busy.set(false);
      this.confirm.set(null);
    }
  }

  short(h: string | null | undefined): string {
    return shortHash(h);
  }
}
