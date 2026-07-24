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
 * apply immediately and hot-reload within ~30s (EngineConfigCache TTL).
 */
@Component({
  selector: 'app-ea-candle-source-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
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
            <select
              class="csp-select"
              [ngModel]="data()!.globalInstanceId ?? ''"
              [disabled]="saving()"
              (ngModelChange)="setGlobal($event)"
            >
              <option value="">— Unmanaged (every instance streams — causes duplicates)</option>
              @for (inst of fleet(); track inst.instanceId) {
                <option [value]="inst.instanceId">{{ instanceLabel(inst) }}</option>
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
                    class="csp-select csp-select-sm"
                    [ngModel]="ov.instanceId"
                    [disabled]="saving()"
                    (ngModelChange)="setOverride(ov.symbol, $event)"
                  >
                    @for (inst of fleet(); track inst.instanceId) {
                      <option [value]="inst.instanceId">{{ instanceLabel(inst) }}</option>
                    }
                  </select>
                  <button
                    type="button"
                    class="btn btn-ghost"
                    [disabled]="saving()"
                    (click)="setOverride(ov.symbol, '')"
                    title="Remove override (symbol falls back to the global default)"
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
              (click)="addOverride()"
            >
              Add override
            </button>
          </div>
        </div>

        @if (saving()) {
          <span class="csp-desc muted small">Saving…</span>
        }
      }
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
        border-left: 3px solid var(--accent);
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
        background: rgba(0, 0, 0, 0.06);
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
      .csp-select {
        flex: 1;
        min-width: 260px;
      }
      .csp-select-sm {
        min-width: 220px;
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
        color: #d70015;
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

  protected setGlobal(instanceId: string): void {
    this.apply(
      { instanceId: instanceId || '' },
      instanceId ? 'Global candle source set' : 'Global candle source cleared',
    );
  }

  protected setOverride(symbol: string, instanceId: string): void {
    this.apply(
      { symbol, instanceId: instanceId || '' },
      instanceId ? `Override set for ${symbol}` : `Override removed for ${symbol}`,
    );
  }

  protected addOverride(): void {
    const symbol = this.newSymbol.trim().toUpperCase();
    const instanceId = this.newInstanceId;
    if (!symbol || !instanceId) return;
    this.apply({ symbol, instanceId }, `Override added for ${symbol}`, () => {
      this.newSymbol = '';
      this.newInstanceId = '';
    });
  }

  private apply(
    body: { symbol?: string; instanceId: string },
    successMsg: string,
    onOk?: () => void,
  ): void {
    this.saving.set(true);
    this.admin
      .setCandleSource(body)
      .pipe(
        finalize(() => this.saving.set(false)),
        catchError((err) => {
          this.notify.error(err?.error?.message ?? 'Save failed.');
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
