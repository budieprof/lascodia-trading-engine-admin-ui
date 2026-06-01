import {
  ChangeDetectionStrategy,
  Component,
  ChangeDetectorRef,
  ElementRef,
  Output,
  EventEmitter,
  ViewChild,
  ViewEncapsulation,
  inject,
  input,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { finalize } from 'rxjs';

import { EAAdminService } from '@core/services/ea-admin.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { Observable } from 'rxjs';
import type { AdminCommandQueueResult, ResponseData } from '@core/api/api.types';

/**
 * Per-instance operator control panel.  Surfaces all nine admin commands as
 * cards grouped into two intents: safety (stop/kill/flatten/clear/release) and
 * maintenance (breaker reset / retry-queue flush+purge).  Each action opens an
 * inline confirm dialog that gathers per-command fields (reason / category /
 * scope / etc.) and posts via EAAdminService.
 *
 * Destructive actions are styled red and require an explicit reason; the
 * purge-retry-queue dialog additionally requires the operator to type "PURGE"
 * since the action is unrecoverable.
 */
@Component({
  selector: 'app-ea-control-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  // None: ::backdrop on a top-layer <dialog> isn't reachable through
  // Angular's Emulated encapsulation scope attribute.  All selectors are
  // class-prefixed so global leakage is contained.
  encapsulation: ViewEncapsulation.None,
  imports: [FormsModule],
  template: `
    <section class="panel" aria-label="EA control panel">
      <header class="panel-head">
        <h3>Operator controls</h3>
        <span class="meta muted">
          Commands queue through /admin/ea/{{ instanceId() }} ; the EA dispatches on its next poll.
        </span>
      </header>

      <div class="group">
        <h4 class="group-title">Safety</h4>
        <div class="cards">
          @for (action of safetyActions; track action.key) {
            <button
              type="button"
              class="action"
              [attr.data-tone]="action.tone"
              (click)="openDialog(action.key)"
              [disabled]="submitting()"
            >
              <span class="action-label">{{ action.label }}</span>
              <span class="action-hint">{{ action.hint }}</span>
            </button>
          }
        </div>
      </div>

      <div class="group">
        <h4 class="group-title">Maintenance</h4>
        <div class="cards">
          @for (action of maintenanceActions; track action.key) {
            <button
              type="button"
              class="action"
              [attr.data-tone]="action.tone"
              (click)="openDialog(action.key)"
              [disabled]="submitting()"
            >
              <span class="action-label">{{ action.label }}</span>
              <span class="action-hint">{{ action.hint }}</span>
            </button>
          }
        </div>
      </div>

      <!--
        Native <dialog> + showModal() promotes the element into the browser's
        top layer regardless of ancestor transforms, filters, or CSS
        containment — common admin-layout shells stack one of these and would
        otherwise turn position:fixed into position:absolute relative to the
        transformed ancestor.
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
              <h2>{{ action.label }}</h2>
              <button type="button" class="close-btn" (click)="closeDialog()" aria-label="Close">
                ×
              </button>
            </header>

            <p class="modal-target">
              Target instance <strong class="mono">{{ instanceId() }}</strong>
            </p>
            <p class="modal-desc">{{ action.description }}</p>

            <!-- Per-action field collections -->
            @switch (currentKey()) {
              @case ('forceSafetyStop') {
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
                      CAS_EXHAUSTION — auto-clears when contention drops
                    </option>
                  </select>
                </label>
              }
              @case ('triggerKillSwitch') {
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
                      placeholder="EURUSD"
                      [(ngModel)]="resetSymbol"
                      autocomplete="off"
                      class="mono"
                    />
                  </label>
                }
              }
              @case ('purgeRetryQueue') {
                <p class="warning">
                  ⚠ Last-resort. Every pending file in the retry queue is deleted without replay.
                  Lost requests are unrecoverable. Type <code>PURGE</code> to enable the confirm
                  button.
                </p>
                <label class="field">
                  <span>Confirmation</span>
                  <input
                    type="text"
                    [(ngModel)]="purgeConfirm"
                    placeholder="Type PURGE"
                    class="mono"
                    autocomplete="off"
                  />
                </label>
              }
              @case ('spawn') {
                <label class="field">
                  <span>Symbol (required)</span>
                  <input
                    type="text"
                    [(ngModel)]="spawnSymbol"
                    placeholder="EURUSD"
                    class="mono"
                    autocomplete="off"
                  />
                </label>
                <label class="field">
                  <span>Timeframe</span>
                  <select [(ngModel)]="spawnTimeframe">
                    <option value="M1">M1</option>
                    <option value="M5">M5</option>
                    <option value="M15">M15</option>
                    <option value="M30">M30</option>
                    <option value="H1">H1 (default)</option>
                    <option value="H4">H4</option>
                    <option value="D1">D1</option>
                  </select>
                </label>
                <p class="hint muted">
                  Opens a new chart on the SAME MT5 terminal as this EA and attaches a sibling
                  instance. The new instance registers with the engine independently. To override
                  its config after attach, push a config update from the new instance's detail page.
                </p>
              }
            }

            <label class="field">
              <span>Reason {{ requiresReason() ? '(required)' : '(optional)' }}</span>
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
      .panel {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .panel-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--space-3);
        flex-wrap: wrap;
      }
      .panel-head h3 {
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
      .group {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .group-title {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.06em;
        font-weight: var(--font-semibold);
      }
      .cards {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: var(--space-2);
      }
      .action {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 4px;
        padding: 12px 14px;
        text-align: left;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-left-width: 3px;
        border-radius: var(--radius-sm);
        cursor: pointer;
        font-size: var(--text-sm);
        transition: background 0.12s ease;
      }
      .action:hover:not(:disabled) {
        background: var(--bg-tertiary, rgba(0, 113, 227, 0.04));
      }
      .action[data-tone='warn'] {
        border-left-color: #ff9500;
      }
      .action[data-tone='warn']:hover:not(:disabled) {
        background: rgba(255, 149, 0, 0.06);
      }
      .action[data-tone='bad'] {
        border-left-color: #ff3b30;
      }
      .action[data-tone='bad']:hover:not(:disabled) {
        background: rgba(255, 59, 48, 0.06);
      }
      .action[data-tone='ok'] {
        border-left-color: #34c759;
      }
      .action[data-tone='ok']:hover:not(:disabled) {
        background: rgba(52, 199, 89, 0.06);
      }
      .action[data-tone='info'] {
        border-left-color: #0071e3;
      }
      .action:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .action-label {
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .action-hint {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      /*
        Explicit fixed-position centring (mirrors fleet-actions-bar).
        UA defaults centre via position:fixed + inset:0 + margin:auto, but
        our earlier max-width:none / max-height:none removed the
        constraints that kept the dialog content-sized.  Re-state the
        sizing on the dialog itself so it can't anchor at top-left.
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
export class EAControlPanelComponent {
  readonly instanceId = input.required<string>();
  /** Emitted after a successful command so the parent can refresh the state envelope + audit list. */
  @Output() readonly commandQueued = new EventEmitter<string>();
  @ViewChild('dialog') private dialogRef!: ElementRef<HTMLDialogElement>;

  private readonly admin = inject(EAAdminService);
  private readonly notify = inject(NotificationService);
  private readonly cdr = inject(ChangeDetectorRef);

  protected readonly safetyActions: readonly Action[] = [
    {
      key: 'forceSafetyStop',
      label: 'Force safety stop',
      hint: 'Halt new orders; trailing stops still run. Default COMPLIANCE = manual recovery.',
      description:
        'Queue a SAFETY_STOP command. Use COMPLIANCE for operator-only recovery; INFRA/DAILY_RESET/CAS_EXHAUSTION auto-recover when their underlying condition clears.',
      confirmLabel: 'Force safety stop',
      tone: 'warn',
    },
    {
      key: 'clearSafetyStop',
      label: 'Clear safety stop',
      hint: 'Manually clear a COMPLIANCE safety stop. No-op if already RUNNING.',
      description:
        'Returns the EA to RUNNING from a COMPLIANCE safety stop. Auto-recoverable stops (INFRA/DAILY_RESET) clear themselves.',
      confirmLabel: 'Clear safety stop',
      tone: 'ok',
    },
    {
      key: 'triggerKillSwitch',
      label: 'Trigger kill switch',
      hint: 'Flatten everything + halt. Requires Release kill switch to resume.',
      description:
        'Closes every position the EA owns at market and halts new order placement. Recovery requires an explicit Release kill switch.',
      confirmLabel: 'Trigger kill switch',
      tone: 'bad',
    },
    {
      key: 'releaseKillSwitch',
      label: 'Release kill switch',
      hint: 'Lift the halt. Does not re-open closed positions.',
      description:
        'Lifts a previously triggered kill switch. The EA can take new orders again subject to remaining safety stops / circuit breakers. Closed positions are NOT re-opened.',
      confirmLabel: 'Release kill switch',
      tone: 'ok',
    },
    {
      key: 'flatten',
      label: 'Flatten positions',
      hint: 'Close every owned position at market. Kill/safety state unchanged.',
      description:
        'Closes every position this EA owns at market without changing kill-switch or safety-stop state. Use for "flatten and continue" — pre-news, end of session, before a config push.',
      confirmLabel: 'Flatten now',
      tone: 'bad',
    },
  ];

  protected readonly maintenanceActions: readonly Action[] = [
    {
      key: 'spawn',
      label: 'Launch instance',
      hint: 'Spawn a sibling EA on a new chart in the same MT5 terminal.',
      description:
        'Opens a new chart on the SAME MT5 terminal as this EA and applies the LascodiaSpawn template. The new chart auto-attaches the EA, which derives an independent instanceId from its chart-id and registers with the engine on its own. Use to scale this terminal across more symbols without VNCing into MT5.\n\nScope limit: this command spawns within the same broker login. For cross-broker spawning (different MT5 terminals), see the Terminals page (Phase-12 sidecar daemon).\n\nFirst-time-after-upgrade caveat: same as Restart — the EA must have saved the spawn template at OnInit. For an EA upgraded from a pre-Phase-11 build, the first launch acks with "spawn template not seeded".',
      confirmLabel: 'Launch now',
      tone: 'info',
    },
    {
      key: 'restart',
      label: 'Restart EA',
      hint: 'In-place restart via ChartApplyTemplate. Picks up a freshly-compiled binary.',
      description:
        'Triggers a remote restart of this EA instance. MT5 deinitalizes the current EA (REASON_TEMPLATE), reloads the .ex5 binary from disk, and runs OnInit on the fresh instance. Use after a deploy to pick up new code without VNCing into MT5.\n\nCaveat: the EA must have saved its chart template at OnInit — Phase-10+ does this automatically. For an EA upgraded from a pre-Phase-10 build, the FIRST restart command will ack "template not seeded; detach + re-attach manually once to bootstrap". Subsequent restarts work normally.',
      confirmLabel: 'Restart now',
      tone: 'warn',
    },
    {
      key: 'shutdown',
      label: 'Shutdown instance',
      hint: 'Close this EA’s chart — graceful OnDeinit, releases symbols, deregisters.',
      description:
        'Sends CMD_SHUTDOWN_INSTANCE to this instance. The EA schedules ChartClose(0) on its own chart; MT5 fires OnDeinit with REASON_CHARTCLOSE, the instance manager releases symbol ownership, the EA calls /ea/deregister, and the chart frame disappears entirely (no orphan empty chart).\n\nUse for siblings spawned via Launch instance when you no longer need them. Targeting the parent works too, but understand it takes down the whole fleet on this terminal until something attaches the EA again. The instance must already be running with a Phase-14+ build for the command to land — older builds will drop it as Unknown.',
      confirmLabel: 'Shutdown now',
      tone: 'bad',
    },
    {
      key: 'resetCircuitBreaker',
      label: 'Reset circuit breaker',
      hint: 'Clear tripped counters. Does NOT bypass the underlying loss / drawdown.',
      description:
        'Resets the tripped counter for the selected scope. If the loss streak or daily P&L threshold is still active the breaker re-trips immediately — pair with a kill-switch if trading should also pause.',
      confirmLabel: 'Reset breaker',
      tone: 'info',
    },
    {
      key: 'flushRetryQueue',
      label: 'Flush retry queue',
      hint: 'Drain the persistent HTTP retry queue ASAP. No-op when empty.',
      description:
        'Drops the inter-replay throttle so the next OnTimer cycle drains without rate limiting. Use after a downstream issue has been fixed (engine reboot, network restored).',
      confirmLabel: 'Flush queue',
      tone: 'ok',
    },
    {
      key: 'purgeRetryQueue',
      label: 'Purge retry queue',
      hint: 'Delete every pending file without replay. Unrecoverable.',
      description:
        'Last-resort recovery for a queue stuck on poisoned requests. Every pending file is deleted; lost requests are NOT reconstructible. Operators should only use this after Flush has demonstrably failed.',
      confirmLabel: 'Purge queue',
      tone: 'bad',
    },
  ];

  // Dialog state ------------------------------------------------------------
  protected readonly open = signal(false);
  protected readonly currentKey = signal<ActionKey | null>(null);
  protected readonly submitting = signal(false);

  // Per-action fields. Reset on open.
  protected reason = '';
  protected forceCategory: 'COMPLIANCE' | 'INFRA' | 'DAILY_RESET' | 'CAS_EXHAUSTION' = 'COMPLIANCE';
  protected killClosePositions = true;
  protected resetScope: 'symbol' | 'fleet' | 'both' = 'both';
  protected resetSymbol = '';
  protected purgeConfirm = '';
  // Phase-11 spawn fields
  protected spawnSymbol = '';
  protected spawnTimeframe = 'H1';

  protected currentAction(): Action | null {
    const key = this.currentKey();
    if (!key) return null;
    return this.findAction(key);
  }

  protected requiresReason(): boolean {
    const key = this.currentKey();
    if (!key) return false;
    const a = this.findAction(key);
    return a?.tone === 'bad' || key === 'forceSafetyStop';
  }

  protected canConfirm(): boolean {
    const key = this.currentKey();
    if (!key) return false;
    if (this.requiresReason() && !this.reason.trim()) return false;
    if (key === 'purgeRetryQueue' && this.purgeConfirm.trim() !== 'PURGE') return false;
    if (key === 'resetCircuitBreaker' && this.resetScope === 'symbol' && !this.resetSymbol.trim()) {
      return false;
    }
    // Spawn requires a non-empty symbol so the EA dispatcher's symbol-
    // existence check has something to chew on; timeframe defaults to H1
    // on the EA side when omitted, but the UI sets it explicitly.
    if (key === 'spawn' && !this.spawnSymbol.trim()) return false;
    return true;
  }

  protected openDialog(key: ActionKey): void {
    this.reason = '';
    this.forceCategory = 'COMPLIANCE';
    this.killClosePositions = true;
    this.resetScope = 'both';
    this.resetSymbol = '';
    this.purgeConfirm = '';
    this.spawnSymbol = '';
    this.spawnTimeframe = 'H1';
    this.currentKey.set(key);
    this.open.set(true);
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
    const id = this.instanceId();
    const reason = this.reason.trim() || null;
    this.submitting.set(true);

    const call = this.dispatch(key, id, reason);

    call
      .pipe(
        finalize(() => {
          this.submitting.set(false);
          this.cdr.markForCheck();
        }),
      )
      .subscribe({
        next: (res) => {
          if (res.status) {
            const action = this.findAction(key);
            this.notify.success(
              `${action?.label ?? 'Command'} queued (id ${this.formatCommandId(res.data)}).`,
            );
            this.commandQueued.emit(key);
            const el = this.dialogRef?.nativeElement;
            if (el?.open) el.close();
            else this.onDialogClose();
          } else {
            this.notify.error(res.message ?? 'Command queue failed.');
          }
        },
        error: () => this.notify.error('Command queue failed.'),
      });
  }

  private dispatch(
    key: ActionKey,
    instanceId: string,
    reason: string | null,
  ): Observable<ResponseData<AdminCommandQueueResult>> {
    switch (key) {
      case 'forceSafetyStop':
        return this.admin.forceSafetyStop(instanceId, { category: this.forceCategory, reason });
      case 'clearSafetyStop':
        return this.admin.clearSafetyStop(instanceId, { reason });
      case 'triggerKillSwitch':
        return this.admin.triggerKillSwitch(instanceId, {
          reason,
          closePositions: this.killClosePositions,
        });
      case 'releaseKillSwitch':
        return this.admin.releaseKillSwitch(instanceId, { reason });
      case 'flatten':
        return this.admin.flatten(instanceId, { reason });
      case 'restart':
        return this.admin.restart(instanceId, { reason });
      case 'shutdown':
        return this.admin.shutdown(instanceId, { reason });
      case 'spawn':
        return this.admin.spawn(instanceId, {
          symbol: this.spawnSymbol.trim().toUpperCase(),
          timeframe: this.spawnTimeframe,
          reason,
        });
      case 'resetCircuitBreaker':
        return this.admin.resetCircuitBreaker(instanceId, {
          scope: this.resetScope,
          symbol: this.resetScope === 'symbol' ? this.resetSymbol.trim() : null,
          reason,
        });
      case 'flushRetryQueue':
        return this.admin.flushRetryQueue(instanceId, { reason });
      case 'purgeRetryQueue':
        return this.admin.purgeRetryQueue(instanceId, { reason });
    }
  }

  private findAction(key: ActionKey): Action | null {
    return (
      this.safetyActions.find((a) => a.key === key) ??
      this.maintenanceActions.find((a) => a.key === key) ??
      null
    );
  }

  private formatCommandId(data: AdminCommandQueueResult | null): string {
    return data?.commandId != null ? String(data.commandId) : '?';
  }
}

type ActionTone = 'ok' | 'warn' | 'bad' | 'info';
type ActionKey =
  | 'forceSafetyStop'
  | 'clearSafetyStop'
  | 'triggerKillSwitch'
  | 'releaseKillSwitch'
  | 'flatten'
  | 'restart'
  | 'shutdown'
  | 'spawn'
  | 'resetCircuitBreaker'
  | 'flushRetryQueue'
  | 'purgeRetryQueue';

interface Action {
  key: ActionKey;
  label: string;
  hint: string;
  description: string;
  confirmLabel: string;
  tone: ActionTone;
}
