import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { catchError, finalize, of } from 'rxjs';

import { EAAdminService } from '@core/services/ea-admin.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { CandleStreamInstance, CandleStreamSource } from '@core/api/api.types';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';

/** A change the operator picked, held until they confirm it. */
interface PendingChange {
  body: { symbol?: string; instanceId: string };
  title: string;
  message: string;
  confirmLabel: string;
  successMsg: string;
  /** Puts the control that asked back to the saved value if the operator cancels. */
  revert?: () => void;
  onOk?: () => void;
}

/**
 * Operator control for the single-source candle-stream guard.
 *
 * The engine's `Candle` table is global per `(Symbol, Timeframe, Timestamp)`.
 * When several EA instances on different brokers own the same symbol, their
 * feeds overwrite each other in the shared slots and render as duplicate bars.
 * Designating one instance as the authoritative streamer makes the ingestion
 * handlers ignore candle writes for that symbol from every other instance.
 *
 * A global default covers all symbols; per-symbol overrides win over it (useful
 * when a symbol only exists on a broker that isn't the global source). Changes
 * hot-reload within ~30s (EngineConfigCache TTL).
 *
 * Every change asks first: picking the wrong source silently drops the candle feed of every other
 * broker for that symbol, and the selects and ✕ used to write on the click itself.
 */
@Component({
  selector: 'app-ea-candle-source-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ConfirmDialogComponent],
  template: `
    <section class="csp-panel">
      <div class="csp-head">
        <div class="csp-title-row">
          <span class="csp-label">Candle data source</span>
          <span class="csp-pill muted" title="Prevents cross-broker candle collisions.">
            single-source
          </span>
        </div>
        <span class="csp-desc muted small">
          Candles are stored globally per symbol. When more than one broker streams the same symbol
          their feeds collide into duplicate bars. Pick the one instance allowed to stream each
          symbol; every other instance's candle writes are ignored. Hot-reloads within ~30s.
        </span>
      </div>

      @if (loadError()) {
        <p class="csp-desc bad small">{{ loadError() }}</p>
      } @else if (!data()) {
        <p class="csp-desc muted small">Loading…</p>
      } @else {
        <!-- Global default -->
        <div class="csp-block">
          <label class="csp-block-label">Global default</label>
          <div class="csp-row">
            <!-- Plain (change) rather than ngModel: a cancelled confirm has to put the select
                 back, and ngModel never re-writes a value its binding did not change. -->
            <select
              #globalSel
              class="csp-select"
              [disabled]="saving()"
              (change)="askGlobal(globalSel)"
              aria-label="Global candle source"
            >
              <option value="" [selected]="!data()!.globalInstanceId">
                — Unmanaged (every instance streams — causes duplicates)
              </option>
              @if (data()!.globalInstanceId && !inFleet(data()!.globalInstanceId)) {
                <option [value]="data()!.globalInstanceId" selected>
                  {{ data()!.globalInstanceId }} · not in the fleet list
                </option>
              }
              @for (inst of fleet(); track inst.instanceId) {
                <option
                  [value]="inst.instanceId"
                  [selected]="inst.instanceId === data()!.globalInstanceId"
                >
                  {{ instanceLabel(inst) }}
                </option>
              }
            </select>
          </div>
          <span class="csp-desc muted small">
            Applies to any symbol without a per-symbol override below.
          </span>
        </div>

        <!-- Per-symbol overrides -->
        <div class="csp-block">
          <label class="csp-block-label">Per-symbol overrides</label>
          @if (data()!.perSymbol.length === 0) {
            <span class="csp-desc muted small"
              >None — the global default applies to all symbols.</span
            >
          } @else {
            <div class="csp-overrides">
              @for (ov of data()!.perSymbol; track ov.symbol) {
                <div class="csp-override">
                  <span class="csp-sym mono">{{ ov.symbol }}</span>
                  <select
                    #ovSel
                    class="csp-select csp-select-sm"
                    [disabled]="saving()"
                    (change)="askOverride(ov.symbol, ov.instanceId, ovSel)"
                    [attr.aria-label]="'Candle source for ' + ov.symbol"
                  >
                    @if (!inFleet(ov.instanceId)) {
                      <option [value]="ov.instanceId" selected>
                        {{ ov.instanceId }} · not in the fleet list
                      </option>
                    }
                    @for (inst of fleet(); track inst.instanceId) {
                      <option
                        [value]="inst.instanceId"
                        [selected]="inst.instanceId === ov.instanceId"
                      >
                        {{ instanceLabel(inst) }}
                      </option>
                    }
                  </select>
                  <button
                    type="button"
                    class="btn btn-ghost"
                    [disabled]="saving()"
                    (click)="askRemoveOverride(ov.symbol)"
                    [title]="
                      'Remove the ' + ov.symbol + ' override (falls back to the global default)'
                    "
                    [attr.aria-label]="'Remove the ' + ov.symbol + ' override'"
                  >
                    ✕
                  </button>
                </div>
              }
            </div>
          }

          <div class="csp-add">
            <input
              class="csp-input mono"
              placeholder="SYMBOL (e.g. EURUSD)"
              [(ngModel)]="newSymbol"
              [disabled]="saving()"
            />
            <select
              class="csp-select csp-select-sm"
              [(ngModel)]="newInstanceId"
              [disabled]="saving()"
            >
              <option value="">Select instance…</option>
              @for (inst of fleet(); track inst.instanceId) {
                <option [value]="inst.instanceId">{{ instanceLabel(inst) }}</option>
              }
            </select>
            <button
              type="button"
              class="btn btn-secondary"
              [disabled]="saving() || !newSymbol.trim() || !newInstanceId"
              (click)="askAddOverride()"
            >
              Add override
            </button>
          </div>
        </div>

        @if (saving()) {
          <span class="csp-desc muted small">Saving…</span>
        }
      }
      <app-confirm-dialog
        [open]="pending() !== null"
        [title]="pending()?.title ?? ''"
        [message]="pending()?.message ?? ''"
        [confirmLabel]="pending()?.confirmLabel ?? 'Confirm'"
        [loading]="saving()"
        (confirm)="confirmPending()"
        (cancelled)="cancelPending()"
      />
    </section>
  `,
  styles: [
    `
      .csp-panel {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        height: 100%;
      }
      .csp-head {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .csp-title-row {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .csp-label {
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .csp-pill {
        font-size: var(--text-xs);
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        background: var(--bg-tertiary);
        color: var(--text-tertiary);
      }
      .csp-desc {
        max-width: 70ch;
      }
      .csp-block {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 10px 12px;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
      }
      .csp-block-label {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
      }
      .csp-row {
        display: flex;
        gap: var(--space-2);
      }
      .csp-overrides {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .csp-override {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .csp-sym {
        min-width: 8ch;
        font-weight: var(--font-semibold);
      }
      .csp-add {
        display: flex;
        gap: var(--space-2);
        flex-wrap: wrap;
        align-items: center;
        margin-top: 4px;
      }
      .csp-select,
      .csp-input {
        height: 30px;
        padding: 0 10px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-family: inherit;
        font-size: 12px;
      }
      /* Instance labels are long ("acct · broker · LASC-MULTI-… · live") and
         the native select paints its chevron over the last ~24px of the
         box, so reserve that strip and clip the label with an ellipsis
         instead of letting it run under the arrow. */
      .csp-select {
        flex: 1;
        min-width: 0;
        max-width: 100%;
        padding-right: 32px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .csp-select-sm {
        flex: 1 1 220px;
      }
      .csp-input {
        width: 180px;
      }
      .mono {
        font-family: var(--font-mono, monospace);
      }
      .muted {
        color: var(--text-tertiary);
      }
      .bad {
        color: var(--tone-red);
      }
      .small {
        font-size: 12px;
      }
      .btn {
        height: 30px;
        padding: 0 12px;
        border-radius: var(--radius-sm);
        font-weight: var(--font-semibold);
        font-size: 12px;
        cursor: pointer;
        font-family: inherit;
      }
      .btn-secondary {
        background: var(--bg-primary);
        color: var(--text-primary);
        border: 1px solid var(--border);
      }
      .btn-ghost {
        background: transparent;
        color: var(--text-tertiary);
        border: 1px solid var(--border);
        width: 30px;
        padding: 0;
      }
      .btn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
    `,
  ],
})
export class EACandleSourcePanelComponent implements OnInit {
  private readonly admin = inject(EAAdminService);
  private readonly notify = inject(NotificationService);

  protected readonly data = signal<CandleStreamSource | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly saving = signal(false);

  protected newSymbol = '';
  protected newInstanceId = '';

  protected readonly fleet = computed(() => this.data()?.fleet ?? []);

  ngOnInit(): void {
    this.load();
  }

  private load(): void {
    this.admin
      .getCandleSource()
      .pipe(
        catchError((err) => {
          this.loadError.set(err?.error?.message ?? 'Failed to load candle-source selection.');
          return of(null);
        }),
      )
      .subscribe((res) => {
        if (res?.status && res.data) {
          this.data.set(res.data);
          this.loadError.set(null);
        }
      });
  }

  protected readonly pending = signal<PendingChange | null>(null);

  protected inFleet(instanceId: string | null | undefined): boolean {
    return !!instanceId && this.fleet().some((i) => i.instanceId === instanceId);
  }

  private labelFor(instanceId: string | null | undefined): string {
    if (!instanceId) return 'unmanaged (every instance streams)';
    const inst = this.fleet().find((i) => i.instanceId === instanceId);
    return inst ? this.instanceLabel(inst) : instanceId;
  }

  protected askGlobal(sel: HTMLSelectElement): void {
    const current = this.data()?.globalInstanceId ?? '';
    const next = sel.value;
    if (next === current) return;
    this.pending.set({
      body: { instanceId: next },
      title: next ? 'Change the global candle source?' : 'Stop managing the candle source?',
      message: next
        ? `${this.labelFor(next)} becomes the only instance whose candles are stored for every ` +
          `symbol without an override. Candle writes from every other instance are ignored ` +
          `within ~30 s.`
        : 'Every instance will stream candles again; where two brokers carry the same symbol ' +
          'their feeds collide into duplicate bars.',
      confirmLabel: next ? 'Change source' : 'Stop managing',
      successMsg: next ? 'Global candle source set' : 'Global candle source cleared',
      revert: () => (sel.value = current),
    });
  }

  protected askOverride(symbol: string, current: string, sel: HTMLSelectElement): void {
    const next = sel.value;
    if (next === current) return;
    this.pending.set({
      body: { symbol, instanceId: next },
      title: `Change the ${symbol} candle source?`,
      message:
        `${symbol} candles will be stored only from ${this.labelFor(next)}; writes from ` +
        `${this.labelFor(current)} and every other instance are ignored within ~30 s.`,
      confirmLabel: 'Change source',
      successMsg: `Override set for ${symbol}`,
      revert: () => (sel.value = current),
    });
  }

  protected askRemoveOverride(symbol: string): void {
    const global = this.data()?.globalInstanceId ?? null;
    this.pending.set({
      body: { symbol, instanceId: '' },
      title: `Remove the ${symbol} override?`,
      message: `${symbol} falls back to the global default: ${this.labelFor(global)}.`,
      confirmLabel: 'Remove override',
      successMsg: `Override removed for ${symbol}`,
    });
  }

  protected askAddOverride(): void {
    const symbol = this.newSymbol.trim().toUpperCase();
    const instanceId = this.newInstanceId;
    if (!symbol || !instanceId) return;
    this.pending.set({
      body: { symbol, instanceId },
      title: `Add a ${symbol} candle-source override?`,
      message:
        `${symbol} candles will be stored only from ${this.labelFor(instanceId)}, whatever the ` +
        `global default says. Takes effect within ~30 s.`,
      confirmLabel: 'Add override',
      successMsg: `Override added for ${symbol}`,
      onOk: () => {
        this.newSymbol = '';
        this.newInstanceId = '';
      },
    });
  }

  protected confirmPending(): void {
    const p = this.pending();
    if (!p) return;
    this.apply(
      p.body,
      p.successMsg,
      () => {
        p.onOk?.();
        this.pending.set(null);
      },
      () => {
        p.revert?.();
        this.pending.set(null);
      },
    );
  }

  protected cancelPending(): void {
    if (this.saving()) return;
    this.pending()?.revert?.();
    this.pending.set(null);
  }

  private apply(
    body: { symbol?: string; instanceId: string },
    successMsg: string,
    onOk?: () => void,
    onFail?: () => void,
  ): void {
    this.saving.set(true);
    this.admin
      .setCandleSource(body)
      .pipe(
        finalize(() => this.saving.set(false)),
        catchError((err) => {
          this.notify.error(err?.error?.message ?? 'Save failed.');
          onFail?.();
          return of(null);
        }),
      )
      .subscribe((res) => {
        if (res === null) return;
        if (res.status) {
          this.notify.success(successMsg);
          onOk?.();
          this.load();
        } else {
          this.notify.error(res.message ?? 'Save failed.');
          onFail?.();
        }
      });
  }

  protected instanceLabel(inst: CandleStreamInstance): string {
    const acct = inst.accountName || `acct ${inst.accountId}`;
    const broker = inst.brokerName ? ` · ${inst.brokerName}` : '';
    const hb = this.heartbeatAge(inst.lastHeartbeat);
    return `${acct}${broker} · ${inst.instanceId}${hb}`;
  }

  private heartbeatAge(iso: string | null): string {
    if (!iso) return ' · never';
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 90_000) return ' · live';
    const mins = Math.floor(ms / 60_000);
    if (mins < 60) return ` · ${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 48) return ` · ${hrs}h ago`;
    return ` · ${Math.floor(hrs / 24)}d ago`;
  }
}
