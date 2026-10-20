import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { Permission } from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';
import { MfaHintComponent } from '@features/iam/shared/mfa-hint.component';
import { OrganisationApiService } from '../organisation-api.service';
import { failureMessage, isApprovalPending } from '../organisation.logic';
import type {
  EffectiveConfigEntry,
  OverrideScopeType,
  OverrideWriteResult,
} from '../organisation.types';
import {
  governanceText,
  outcomeMessage,
  planRemove,
  planSet,
  sourceLabel,
  valueText,
  type ChangePlan,
} from '../settings.logic';

/** Longest reason the engine keeps. */
export const REASON_MAX = 1000;

/** What to change: one setting, at the organisation's layer or one account's. */
export interface ConfigChangeRequest {
  entry: EffectiveConfigEntry;
  mode: 'set' | 'remove';
  layer: OverrideScopeType;
  tradingAccountId: number | null;
  /** "The organisation" or the account's name. */
  scopeName: string;
}

/**
 * Change one layered setting at one scope (the organisation, or one account) — or remove the scope's
 * own value so it inherits again. Says beforehand what the engine will ask for: a valid value, a
 * tighten-only key kept tighter than what it inherits, and for a risk-loosening change the governed
 * path (reason, `risk.loosen`, second factor, two-person, cooling-off; break-glass on request). A
 * change sent for a second person's approval closes the dialog without reporting a failure.
 */
@Component({
  selector: 'app-config-change-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ModalA11yDirective, MfaHintComponent],
  styleUrl: '../../iam/shared/iam-page.scss',
  styles: [
    `
      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        backdrop-filter: blur(6px);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
      }
      .dialog {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        width: min(560px, calc(100vw - 32px));
        max-height: calc(100vh - 48px);
        overflow: auto;
      }
      .dialog h3 {
        margin: 0;
        font-size: var(--text-base);
        word-break: break-all;
      }
      dl {
        margin: 0;
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 4px var(--space-3);
        font-size: var(--text-sm);
      }
      dt {
        color: var(--text-secondary);
      }
      dd {
        margin: 0;
        word-break: break-all;
      }
    `,
  ],
  template: `
    @if (entry(); as e) {
      <div class="overlay" role="presentation" (click)="cancel()">
        <div
          class="dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="config-change-title"
          tabindex="-1"
          appModalA11y
          (dismiss)="cancel()"
          (click)="$event.stopPropagation()"
          (keydown)="$event.stopPropagation()"
        >
          <form class="card-body" (ngSubmit)="save()">
            <h3 id="config-change-title">
              {{ mode() === 'remove' ? 'Remove the value of' : 'Change' }} {{ e.key }}
            </h3>
            <p class="muted small">{{ e.description }}</p>
            <dl>
              <dt>For</dt>
              <dd>{{ scopeName() }}</dd>
              <dt>Now</dt>
              <dd>
                {{ valueText(e, e.value) }} <span class="chip">{{ sourceLabel(e.source) }}</span>
              </dd>
              @if (e.inheritedValue !== undefined) {
                <dt>Inherits</dt>
                <dd>{{ valueText(e, e.inheritedValue) }}</dd>
              }
            </dl>

            @if (mode() === 'set') {
              <label class="field">
                <span class="label">New value</span>
                @if (e.secret) {
                  <input
                    class="input"
                    type="password"
                    name="value"
                    autocomplete="new-password"
                    data-autofocus
                    [ngModel]="value()"
                    (ngModelChange)="value.set($event)"
                  />
                } @else if (e.valueKind === 'Bool') {
                  <select
                    class="select"
                    name="value"
                    data-autofocus
                    [ngModel]="value()"
                    (ngModelChange)="value.set($event)"
                  >
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                } @else if (e.valueKind === 'Enum' && e.allowedValues.length) {
                  <select
                    class="select"
                    name="value"
                    data-autofocus
                    [ngModel]="value()"
                    (ngModelChange)="value.set($event)"
                  >
                    @for (v of e.allowedValues; track v) {
                      <option [value]="v">{{ v }}</option>
                    }
                  </select>
                } @else if (e.valueKind === 'Json') {
                  <textarea
                    class="textarea"
                    name="value"
                    data-autofocus
                    [ngModel]="value()"
                    (ngModelChange)="value.set($event)"
                  ></textarea>
                } @else {
                  <input
                    class="input"
                    name="value"
                    data-autofocus
                    [attr.inputmode]="
                      e.valueKind === 'Int' || e.valueKind === 'Decimal' ? 'decimal' : null
                    "
                    [ngModel]="value()"
                    (ngModelChange)="value.set($event)"
                  />
                }
              </label>
              <p class="muted small">{{ hint() }}</p>
            } @else {
              <p class="note">
                {{ scopeName() }} will run with the inherited value
                {{ e.inheritedValue === undefined ? '' : valueText(e, e.inheritedValue) }} again.
              </p>
            }

            @if (plan().governed) {
              <p class="note warn">{{ governance() }}</p>
              <div class="row">
                <app-mfa-hint [permission]="P.RiskLoosen" />
              </div>
            }

            <label class="field">
              <span class="label">
                Reason{{
                  plan().governed || immediate()
                    ? ' (required)'
                    : ' (optional, kept in the audit trail)'
                }}
              </span>
              <textarea
                class="textarea"
                name="reason"
                rows="2"
                [maxlength]="reasonMax"
                [ngModel]="reason()"
                (ngModelChange)="reason.set($event)"
              ></textarea>
            </label>

            @if (plan().governed) {
              <label class="check">
                <input
                  type="checkbox"
                  name="immediate"
                  [ngModel]="immediate()"
                  (ngModelChange)="immediate.set($event)"
                />
                Apply now, skipping the cooling-off period (break-glass)
              </label>
            }

            @if (problems().length && submitted()) {
              <ul class="errors" role="alert">
                @for (p of problems(); track p) {
                  <li>{{ p }}</li>
                }
              </ul>
            }
            @if (error(); as err) {
              <p class="errors" role="alert">{{ err }}</p>
            }

            <div class="actions-row">
              <button
                type="button"
                class="btn btn-secondary"
                (click)="cancel()"
                [disabled]="busy()"
              >
                Cancel
              </button>
              <button
                type="submit"
                class="btn"
                [class.btn-primary]="mode() === 'set'"
                [class.btn-danger]="mode() === 'remove'"
                [disabled]="busy()"
              >
                {{ busy() ? 'Sending…' : mode() === 'remove' ? 'Remove value' : 'Save' }}
              </button>
            </div>
          </form>
        </div>
      </div>
    }
  `,
})
export class ConfigChangeDialogComponent {
  private readonly api = inject(OrganisationApiService);
  private readonly notify = inject(NotificationService);

  protected readonly P = Permission;
  protected readonly valueText = valueText;
  protected readonly sourceLabel = sourceLabel;
  protected readonly reasonMax = REASON_MAX;

  /** The setting being changed; the dialog is open while it is set (see {@link open}). */
  readonly entry = signal<EffectiveConfigEntry | null>(null);
  readonly mode = signal<'set' | 'remove'>('set');
  readonly layer = signal<OverrideScopeType>('Tenant');
  readonly tradingAccountId = signal<number | null>(null);
  /** "The organisation" or the account's name. */
  readonly scopeName = signal('The organisation');
  /** Closed; `true` when the engine took the change (applied, queued or sent for approval). */
  readonly closed = output<boolean>();

  readonly value = signal('');
  readonly reason = signal('');
  readonly immediate = signal(false);
  readonly submitted = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  readonly plan = computed<ChangePlan>(() => {
    const e = this.entry();
    if (!e) return { before: null, after: null, refusal: null, loosening: false, governed: false };
    return this.mode() === 'remove' ? planRemove(e) : planSet(e, this.value(), this.layer());
  });
  readonly governance = computed(() => {
    const e = this.entry();
    return e ? governanceText(e, this.plan()) : '';
  });
  readonly problems = computed(() => {
    const out: string[] = [];
    const plan = this.plan();
    if (plan.refusal) out.push(plan.refusal);
    const reason = this.reason().trim();
    if ((plan.governed || this.immediate()) && !reason) {
      out.push(
        this.immediate()
          ? 'Give a reason: applying a risk change now is recorded with it.'
          : 'Give a reason: a change that may loosen a risk setting is recorded with it.',
      );
    }
    return out;
  });
  readonly hint = computed(() => {
    const e = this.entry();
    if (!e) return '';
    const parts: string[] = [];
    if (e.min !== null || e.max !== null) {
      parts.push(`Allowed: ${e.min ?? '…'} to ${e.max ?? '…'}.`);
    }
    if (e.tightness === 'LowerIsTighterZeroUnlimited') parts.push('0 means no limit.');
    if (e.tightenOnly) {
      parts.push(
        `Tighten-only: it may only be stricter than the inherited value${
          e.inheritedValue !== undefined ? ` (${valueText(e, e.inheritedValue)})` : ''
        }.`,
      );
    }
    if (e.secret) parts.push('Write-only: the stored value is never shown.');
    return parts.join(' ');
  });

  /** Opens on one setting at one scope, prefilled with its current value (never a secret's). */
  open(request: ConfigChangeRequest): void {
    const e = request.entry;
    this.mode.set(request.mode);
    this.layer.set(request.layer);
    this.tradingAccountId.set(request.layer === 'Account' ? request.tradingAccountId : null);
    this.scopeName.set(request.scopeName);
    this.value.set(e.secret ? '' : (e.value ?? ''));
    this.reason.set('');
    this.immediate.set(false);
    this.submitted.set(false);
    this.busy.set(false);
    this.error.set(null);
    this.entry.set(e);
  }

  cancel(): void {
    if (this.busy()) return;
    this.entry.set(null);
    this.closed.emit(false);
  }

  private done(): void {
    this.entry.set(null);
    this.closed.emit(true);
  }

  save(): void {
    const e = this.entry();
    this.submitted.set(true);
    if (!e || this.busy() || this.problems().length) return;
    const plan = this.plan();
    const reason = this.reason().trim() || undefined;
    const immediate = plan.governed && this.immediate() ? true : undefined;
    const accountId =
      this.layer() === 'Account' ? (this.tradingAccountId() ?? undefined) : undefined;
    this.busy.set(true);
    this.error.set(null);
    const write$ =
      this.mode() === 'remove'
        ? this.api.removeOverride({
            scopeType: this.layer(),
            tradingAccountId: accountId ?? null,
            key: e.key,
            reason: reason ?? null,
            immediate: immediate === true,
          })
        : this.api.setOverride({
            scopeType: this.layer(),
            ...(accountId ? { tradingAccountId: accountId } : {}),
            key: e.key,
            value: plan.after ?? '',
            ...(reason ? { reason } : {}),
            ...(immediate ? { immediate } : {}),
          });
    write$.subscribe({
      next: (r: OverrideWriteResult) => {
        this.busy.set(false);
        this.notify.success(outcomeMessage(e.key, r));
        this.done();
      },
      error: (err: unknown) => {
        this.busy.set(false);
        if (isApprovalPending(err)) {
          // Two-person (C3.3): the interceptor said "sent for approval"; nothing failed.
          this.done();
          return;
        }
        this.error.set(failureMessage(err, 'The change was not saved.'));
      },
    });
  }
}
