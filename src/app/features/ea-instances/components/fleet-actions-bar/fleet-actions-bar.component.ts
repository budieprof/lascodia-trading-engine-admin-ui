import {
  ChangeDetectionStrategy,
  Component,
  ChangeDetectorRef,
  ElementRef,
  EventEmitter,
  Output,
  ViewChild,
  ViewEncapsulation,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { finalize, type Observable } from 'rxjs';

import { EAAdminService } from '@core/services/ea-admin.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { AdminFleetCommandResult, ResponseData } from '@core/api/api.types';

/**
 * Fleet-bulk operations bar for the EA-instances list page.  Renders six
 * actions that fan out across every live EA instance (same liveness filter
 * the engine uses: Active + heartbeat within 10 min).  Each action opens an
 * inline confirm dialog with a required reason on destructive variants and
 * an explicit "type FLEET" gate on the kill-switch + flatten + safety-stop
 * actions — the blast radius is the entire fleet, so accidental clicks
 * must be impossible.
 *
 * Mirrors the structure of EAControlPanelComponent but pointed at the
 * /admin/ea/all/... endpoints; result envelope reports targeted/queued
 * counts so the dashboard can show "Queued for N instances".
 */
@Component({
  selector: 'app-fleet-actions-bar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  // None: Angular's Emulated encapsulation tags selectors with a scope
  // attribute, but ::backdrop attaches to the browser's top-layer rendering
  // surface (not a DOM child) and never receives that attribute — so the
  // scrim silently vanishes.  All our selectors are class-prefixed
  // (.modal-dialog, .modal, .action, …) so global leakage is contained.
  encapsulation: ViewEncapsulation.None,
  imports: [FormsModule],
  template: `
    <section class="bar" aria-label="Fleet bulk operations">
      <div class="bar-head">
        <h3>Fleet ops</h3>
        <span class="meta muted">
          Targets every live instance (Active · heartbeat within 10 min).
        </span>
      </div>

      <div class="actions">
        @for (action of actions; track action.key) {
          <button
            type="button"
            class="action"
            [attr.data-tone]="action.tone"
            (click)="openDialog(action.key)"
            [disabled]="submitting()"
          >
            {{ action.label }}
          </button>
        }
      </div>

      <!--
        Native <dialog> + showModal() promotes the element into the browser's
        top layer regardless of ancestor transforms, filters, or CSS
        containment — common admin-layout shells stack one of these and would
        otherwise turn position:fixed into position:absolute relative to the
        transformed ancestor.  cancel.preventDefault() lets us route ESC
        through the same close handler so submitting() can suppress dismissal.
      -->
      <dialog
        #dialog
        class="modal-dialog"
        (close)="onDialogClose()"
        (cancel)="$event.preventDefault(); closeDialog()"
      >
        @let action = currentAction();
        <div class="modal" role="dialog" aria-modal="true">
          @if (action) {
            <header class="modal-head">
              <h2>Fleet · {{ action.label }}</h2>
              <button type="button" class="close-btn" (click)="closeDialog()" aria-label="Close">
                ×
              </button>
            </header>

            <p class="modal-target">
              <strong>Fleet-wide action.</strong> Will queue
              <code>{{ action.commandType }}</code> for every live EA instance.
            </p>
            <p class="modal-desc">{{ action.description }}</p>

            @switch (currentKey()) {
              @case ('safetyStop') {
                <label class="field">
                  <span>Category</span>
                  <select [(ngModel)]="forceCategory">
                    <option value="COMPLIANCE">COMPLIANCE — manual recovery only (default)</option>
                    <option value="INFRA">
                      INFRA — auto-recovers when engine + broker healthy
                    </option>
                    <option value="DAILY_RESET">
                      DAILY_RESET — auto-clears on next trading day
                    </option>
                    <option value="CAS_EXHAUSTION">
                      CAS_EXHAUSTION — auto-clears with contention
                    </option>
                  </select>
                </label>
              }
              @case ('killSwitch') {
                <label class="field check">
                  <input type="checkbox" [(ngModel)]="killClosePositions" />
                  <span>Close every position at market (uncheck for halt-only)</span>
                </label>
              }
              @case ('resetCircuitBreaker') {
                <label class="field">
                  <span>Scope</span>
                  <select [(ngModel)]="resetScope">
                    <option value="both">both (default)</option>
                    <option value="symbol">symbol-only</option>
                    <option value="fleet">fleet-only</option>
                  </select>
                </label>
                @if (resetScope === 'symbol') {
                  <label class="field">
                    <span>Symbol (required for symbol-scope)</span>
                    <input
                      type="text"
                      [(ngModel)]="resetSymbol"
                      placeholder="EURUSD"
                      class="mono"
                      autocomplete="off"
                    />
                  </label>
                }
              }
            }

            @if (action.tone === 'bad') {
              <p class="warning">
                ⚠ Fleet-wide destructive action. Type <code>FLEET</code> to enable.
              </p>
              <label class="field">
                <span>Confirmation</span>
                <input
                  type="text"
                  [(ngModel)]="confirmWord"
                  placeholder="Type FLEET"
                  class="mono"
                  autocomplete="off"
                />
              </label>
            }

            <label class="field">
              <span>Reason {{ action.tone === 'bad' ? '(required)' : '(optional)' }}</span>
              <textarea
                rows="2"
                [(ngModel)]="reason"
                placeholder="What prompted this action? (audit trail)"
              ></textarea>
            </label>

            <footer class="modal-foot">
              <button
                type="button"
                class="btn btn-secondary"
                (click)="closeDialog()"
                [disabled]="submitting()"
              >
                Cancel
              </button>
              <button
                type="button"
                class="btn"
                [attr.data-tone]="action.tone"
                (click)="confirm()"
                [disabled]="submitting() || !canConfirm()"
              >
                {{ submitting() ? 'Queuing…' : action.confirmLabel }}
              </button>
            </footer>
          }
        </div>
      </dialog>
    </section>
  `,
  styles: [
    `
      .bar {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .bar-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--space-3);
      }
      .bar-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .meta {
        font-size: var(--text-xs);
      }
      .muted {
        color: var(--text-tertiary);
      }
      .actions {
        display: flex;
        gap: var(--space-2);
        flex-wrap: wrap;
      }
      .action {
        padding: 6px 12px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        cursor: pointer;
      }
      .action:hover:not(:disabled) {
        background: var(--bg-tertiary, rgba(0, 113, 227, 0.06));
      }
      .action[data-tone='warn'] {
        color: #c93400;
        border-color: rgba(255, 149, 0, 0.5);
      }
      .action[data-tone='warn']:hover:not(:disabled) {
        background: #ff9500;
        color: #fff;
      }
      .action[data-tone='bad'] {
        color: #d70015;
        border-color: rgba(255, 59, 48, 0.5);
      }
      .action[data-tone='bad']:hover:not(:disabled) {
        background: #ff3b30;
        color: #fff;
      }
      .action[data-tone='ok'] {
        color: #248a3d;
      }
      .action[data-tone='ok']:hover:not(:disabled) {
        background: #34c759;
        color: #fff;
      }
      .action:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      /*
        <dialog> + showModal() promotes the element into the browser's top
        layer.  UA defaults centre via position:fixed + inset:0 + margin:auto
        + width:fit-content + max-width:calc(...) — but our earlier override
        of max-width/max-height removed those constraints and the dialog
        anchored at top-left.  This block re-states centring explicitly so
        we're not at the mercy of which UA defaults we accidentally clobber.
      */
      .modal-dialog {
        position: fixed;
        inset: 0;
        margin: auto;
        width: min(92vw, 520px);
        height: fit-content;
        max-width: 95vw;
        max-height: 90vh;
        padding: 0;
        border: none;
        background: transparent;
        overflow: visible;
        color: inherit;
      }
      .modal-dialog::backdrop {
        background: rgba(0, 0, 0, 0.45);
      }
      .modal {
        background: var(--bg-primary);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg, 0 10px 30px rgba(0, 0, 0, 0.18));
        width: 100%;
        max-height: 90vh;
        overflow-y: auto;
        padding: var(--space-5);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .modal-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .modal-head h2 {
        margin: 0;
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
      }
      .close-btn {
        background: none;
        border: none;
        font-size: 24px;
        color: var(--text-secondary);
        cursor: pointer;
      }
      .modal-target {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .modal-desc {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .warning {
        margin: 0;
        padding: 10px 12px;
        background: rgba(255, 59, 48, 0.08);
        border-left: 3px solid #ff3b30;
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
        color: #d70015;
      }
      .warning code {
        background: rgba(0, 0, 0, 0.08);
        padding: 1px 4px;
        border-radius: 3px;
        font-family: var(--font-mono);
      }
      code {
        background: rgba(0, 0, 0, 0.05);
        padding: 1px 4px;
        border-radius: 3px;
        font-family: var(--font-mono);
        font-size: var(--text-xs);
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .field.check {
        flex-direction: row;
        align-items: center;
      }
      .field > span {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .field input,
      .field select,
      .field textarea {
        padding: 6px 10px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
      }
      .field textarea {
        resize: vertical;
        min-height: 48px;
        font-family: inherit;
      }
      .mono {
        font-family: var(--font-mono);
      }
      .modal-foot {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-3);
      }
      .btn {
        padding: 8px 18px;
        border-radius: var(--radius-sm);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        cursor: pointer;
        border: 1px solid transparent;
      }
      .btn[data-tone='warn'] {
        background: #ff9500;
        color: #fff;
        border-color: #ff9500;
      }
      .btn[data-tone='bad'] {
        background: #ff3b30;
        color: #fff;
        border-color: #ff3b30;
      }
      .btn[data-tone='ok'] {
        background: #34c759;
        color: #fff;
        border-color: #34c759;
      }
      .btn[data-tone='info'] {
        background: var(--accent);
        color: #fff;
        border-color: var(--accent);
      }
      .btn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .btn-secondary {
        background: var(--bg-primary);
        color: var(--text-primary);
        border: 1px solid var(--border);
      }
    `,
  ],
})
export class FleetActionsBarComponent {
  @Output() readonly commandQueued = new EventEmitter<string>();
  @ViewChild('dialog') private dialogRef!: ElementRef<HTMLDialogElement>;

  private readonly admin = inject(EAAdminService);
  private readonly notify = inject(NotificationService);
  private readonly cdr = inject(ChangeDetectorRef);

  protected readonly actions: readonly FleetAction[] = [
    {
      key: 'safetyStop',
      label: 'Safety stop (all)',
      commandType: 'ForceSafetyStop',
      description:
        'Force every live EA instance into SAFETY_STOP. Default COMPLIANCE category requires manual recovery; other categories auto-clear when their condition lifts.',
      confirmLabel: 'Safety stop fleet',
      tone: 'warn',
    },
    {
      key: 'clearSafetyStop',
      label: 'Clear safety stop (all)',
      commandType: 'ClearSafetyStop',
      description:
        'Clear COMPLIANCE safety stops across every live EA instance. No-op on instances that are already RUNNING.',
      confirmLabel: 'Clear all',
      tone: 'ok',
    },
    {
      key: 'killSwitch',
      label: 'Kill switch (all)',
      commandType: 'TriggerKillSwitch',
      description:
        'Trigger kill-switch on every live EA. Flattens positions and halts. Requires explicit Release kill switch per instance to resume.',
      confirmLabel: 'Kill fleet',
      tone: 'bad',
    },
    {
      key: 'releaseKillSwitch',
      label: 'Release kill switch (all)',
      commandType: 'ReleaseKillSwitch',
      description:
        'Lift the kill-switch across every live EA. Does NOT re-open positions that were closed.',
      confirmLabel: 'Release all',
      tone: 'ok',
    },
    {
      key: 'flatten',
      label: 'Flatten (all)',
      commandType: 'FlattenInstance',
      description:
        'Close every position on every live EA at market. Kill / safety state unchanged. Use for fleet-wide flat-and-continue (news event, scheduled flatten).',
      confirmLabel: 'Flatten fleet',
      tone: 'bad',
    },
    {
      key: 'resetCircuitBreaker',
      label: 'Reset breakers (all)',
      commandType: 'ResetCircuitBreaker',
      description:
        'Reset tripped circuit-breaker counters across every live EA. Does NOT bypass the underlying loss / drawdown — re-trip is immediate if the cause is still active.',
      confirmLabel: 'Reset all breakers',
      tone: 'info',
    },
  ];

  protected readonly open = signal(false);
  protected readonly currentKey = signal<FleetKey | null>(null);
  protected readonly submitting = signal(false);

  protected reason = '';
  protected forceCategory: 'COMPLIANCE' | 'INFRA' | 'DAILY_RESET' | 'CAS_EXHAUSTION' = 'COMPLIANCE';
  protected killClosePositions = true;
  protected resetScope: 'symbol' | 'fleet' | 'both' = 'both';
  protected resetSymbol = '';
  protected confirmWord = '';

  protected currentAction(): FleetAction | null {
    const key = this.currentKey();
    return key ? (this.actions.find((a) => a.key === key) ?? null) : null;
  }

  protected canConfirm(): boolean {
    const action = this.currentAction();
    if (!action) return false;
    if (action.tone === 'bad') {
      if (this.confirmWord.trim() !== 'FLEET') return false;
      if (!this.reason.trim()) return false;
    }
    if (
      action.key === 'resetCircuitBreaker' &&
      this.resetScope === 'symbol' &&
      !this.resetSymbol.trim()
    ) {
      return false;
    }
    return true;
  }

  protected openDialog(key: FleetKey): void {
    this.reason = '';
    this.forceCategory = 'COMPLIANCE';
    this.killClosePositions = true;
    this.resetScope = 'both';
    this.resetSymbol = '';
    this.confirmWord = '';
    this.currentKey.set(key);
    this.open.set(true);
    // Defer until *ngIf binding renders the <dialog>; showModal() needs the
    // element to be in the DOM and not already open.
    queueMicrotask(() => {
      const el = this.dialogRef?.nativeElement;
      if (el && !el.open) el.showModal();
    });
  }

  protected closeDialog(): void {
    if (this.submitting()) return;
    const el = this.dialogRef?.nativeElement;
    if (el?.open) el.close();
    else this.onDialogClose();
  }

  /** Fires when the dialog closes for any reason (button, ESC, programmatic). */
  protected onDialogClose(): void {
    this.open.set(false);
    this.currentKey.set(null);
  }

  protected confirm(): void {
    const key = this.currentKey();
    if (!key || !this.canConfirm()) return;
    const reason = this.reason.trim() || null;
    this.submitting.set(true);
    this.dispatch(key, reason)
      .pipe(
        finalize(() => {
          this.submitting.set(false);
          this.cdr.markForCheck();
        }),
      )
      .subscribe({
        next: (res) => {
          if (res.status) {
            const queued = res.data?.queued ?? 0;
            const targeted = res.data?.targeted ?? 0;
            this.notify.success(
              `Fleet ${key}: queued for ${queued} of ${targeted} live instance(s).`,
            );
            this.commandQueued.emit(key);
            const el = this.dialogRef?.nativeElement;
            if (el?.open) el.close();
            else this.onDialogClose();
          } else {
            this.notify.error(res.message ?? 'Fleet command failed.');
          }
        },
        error: () => this.notify.error('Fleet command failed.'),
      });
  }

  private dispatch(
    key: FleetKey,
    reason: string | null,
  ): Observable<ResponseData<AdminFleetCommandResult>> {
    switch (key) {
      case 'safetyStop':
        return this.admin.fleetSafetyStop({ category: this.forceCategory, reason });
      case 'clearSafetyStop':
        return this.admin.fleetClearSafetyStop({ reason });
      case 'killSwitch':
        return this.admin.fleetKillSwitch({ reason, closePositions: this.killClosePositions });
      case 'releaseKillSwitch':
        return this.admin.fleetReleaseKillSwitch({ reason });
      case 'flatten':
        return this.admin.fleetFlatten({ reason });
      case 'resetCircuitBreaker':
        return this.admin.fleetResetCircuitBreaker({
          scope: this.resetScope,
          symbol: this.resetScope === 'symbol' ? this.resetSymbol.trim() : null,
          reason,
        });
    }
  }
}

type FleetTone = 'ok' | 'warn' | 'bad' | 'info';
type FleetKey =
  | 'safetyStop'
  | 'clearSafetyStop'
  | 'killSwitch'
  | 'releaseKillSwitch'
  | 'flatten'
  | 'resetCircuitBreaker';

interface FleetAction {
  key: FleetKey;
  label: string;
  commandType: string;
  description: string;
  confirmLabel: string;
  tone: FleetTone;
}
