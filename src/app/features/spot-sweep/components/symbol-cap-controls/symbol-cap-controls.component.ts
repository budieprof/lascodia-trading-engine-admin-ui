import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { finalize } from 'rxjs';

import { MarketDataService } from '@core/services/market-data.service';
import { NotificationService } from '@core/notifications/notification.service';
import type {
  SignalExposureConfigDto,
  UpdateSignalExposureConfigRequest,
} from '@core/api/api.types';

/**
 * Per-symbol generation cap for the sweep. When set (>0), the sweep will NOT run a fresh
 * analysis or generate a signal for a symbol that already has that many not-yet-resolved
 * signals in the live book (walk-derived, position-independent). 0 = off (the sweep's
 * default: analyse every configured pair every tick). Shares the SignalExposure config
 * endpoint with the Portfolio-awareness card but edits only these two keys.
 */
@Component({
  selector: 'app-symbol-cap-controls',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <section class="card" aria-label="Per-symbol open-signal cap">
      <header class="head">
        <div>
          <h3>Per-symbol signal cap</h3>
          <p class="muted small">
            Stop the sweep from analysing &amp; generating for a symbol that already has this many
            <strong>not-yet-resolved</strong> signals open. Saves LLM spend and prevents piling more
            correlated signals onto an already-loaded symbol. Set to 0 to disable.
          </p>
        </div>
      </header>

      @if (cfg(); as c) {
        <div class="grid">
          <div class="num-row">
            <label for="cap">
              <strong>Max open signals per symbol</strong>
              <span class="muted small">
                @if (c.maxOpenSignalsPerSymbol > 0) {
                  Sweep skips a symbol once it has {{ c.maxOpenSignalsPerSymbol }} open signal(s).
                } @else {
                  Off — no per-symbol cap (analyse every configured pair every tick).
                }
              </span>
            </label>
            <div class="num-input">
              <input
                id="cap"
                type="number"
                min="0"
                max="100"
                [ngModel]="c.maxOpenSignalsPerSymbol"
                (ngModelChange)="patch({ maxOpenSignalsPerSymbol: clampInt($event, 0, 100) })"
              />
              <span class="muted small">0 = off</span>
            </div>
          </div>

          <label class="toggle-row" [class.disabled]="c.maxOpenSignalsPerSymbol === 0">
            <input
              type="checkbox"
              [checked]="c.symbolCapIncludesPending"
              [disabled]="c.maxOpenSignalsPerSymbol === 0"
              (change)="patch({ symbolCapIncludesPending: $any($event.target).checked })"
            />
            <span>
              <strong>Count armed (pending-fill) signals too</strong>
              <span class="muted small">
                Include not-yet-filled limits in the count, not just filled/open ones.
              </span>
            </span>
          </label>
        </div>

        <footer class="actions">
          @if (dirty()) {
            <span class="muted small">unsaved changes</span>
          }
          <button type="button" class="btn" (click)="revert()" [disabled]="!dirty() || saving()">
            Revert
          </button>
          <button
            type="button"
            class="btn btn-primary"
            (click)="save()"
            [disabled]="!dirty() || saving()"
          >
            {{ saving() ? 'Saving…' : 'Save' }}
          </button>
        </footer>
      } @else {
        <p class="muted small">Loading per-symbol cap settings…</p>
      }
    </section>
  `,
  styles: [
    `
      .card {
        border: 1px solid var(--border-color, #e5e5ea);
        border-radius: 12px;
        padding: 1rem 1.15rem;
        background: var(--surface, #fff);
      }
      .head h3 {
        margin: 0 0 0.2rem;
        font-size: 1rem;
      }
      .head p {
        margin: 0 0 0.6rem;
        max-width: 60ch;
      }
      .muted {
        color: var(--text-muted, #8e8e93);
      }
      .small {
        font-size: 0.8rem;
      }
      .grid {
        display: flex;
        flex-direction: column;
        gap: 0.85rem;
      }
      .num-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
      }
      .num-row label {
        display: flex;
        flex-direction: column;
      }
      .num-input {
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }
      .num-input input {
        width: 5.5rem;
        padding: 0.35rem 0.5rem;
        border: 1px solid var(--border-color, #e5e5ea);
        border-radius: 8px;
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .toggle-row {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 0.6rem;
        align-items: start;
        cursor: pointer;
      }
      .toggle-row span {
        display: flex;
        flex-direction: column;
      }
      .toggle-row input {
        margin-top: 0.2rem;
      }
      .disabled {
        opacity: 0.5;
      }
      .actions {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 0.7rem;
        margin-top: 1rem;
      }
      .btn {
        border: 1px solid var(--border-color, #e5e5ea);
        background: transparent;
        border-radius: 8px;
        padding: 0.4rem 0.9rem;
        cursor: pointer;
        font-size: 0.9rem;
      }
      .btn-primary {
        background: #0071e3;
        color: #fff;
        border-color: #0071e3;
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: default;
      }
    `,
  ],
})
export class SymbolCapControlsComponent {
  private readonly marketData = inject(MarketDataService);
  private readonly notify = inject(NotificationService);

  private readonly persisted = signal<SignalExposureConfigDto | null>(null);
  readonly cfg = signal<SignalExposureConfigDto | null>(null);
  readonly saving = signal(false);

  readonly dirty = computed(() => {
    const a = this.persisted();
    const b = this.cfg();
    if (!a || !b) return false;
    return (
      a.maxOpenSignalsPerSymbol !== b.maxOpenSignalsPerSymbol ||
      a.symbolCapIncludesPending !== b.symbolCapIncludesPending
    );
  });

  constructor() {
    this.load();
  }

  private load(): void {
    this.marketData.getSignalExposureConfig().subscribe({
      next: (res) => {
        if (res.data) {
          this.persisted.set({ ...res.data });
          this.cfg.set({ ...res.data });
        }
      },
    });
  }

  patch(part: Partial<SignalExposureConfigDto>): void {
    const cur = this.cfg();
    if (!cur) return;
    this.cfg.set({ ...cur, ...part });
  }

  clampInt(v: unknown, min: number, max: number): number {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  revert(): void {
    const p = this.persisted();
    if (p) this.cfg.set({ ...p });
  }

  save(): void {
    const cur = this.cfg();
    const prev = this.persisted();
    if (!cur || !prev || this.saving()) return;

    const body: UpdateSignalExposureConfigRequest = {};
    if (cur.maxOpenSignalsPerSymbol !== prev.maxOpenSignalsPerSymbol)
      body.maxOpenSignalsPerSymbol = cur.maxOpenSignalsPerSymbol;
    if (cur.symbolCapIncludesPending !== prev.symbolCapIncludesPending)
      body.symbolCapIncludesPending = cur.symbolCapIncludesPending;

    this.saving.set(true);
    this.marketData
      .updateSignalExposureConfig(body)
      .pipe(finalize(() => this.saving.set(false)))
      .subscribe({
        next: () => {
          this.persisted.set({ ...cur });
          this.notify.success('Per-symbol signal cap saved.');
        },
        error: () => this.notify.error('Could not save the per-symbol cap.'),
      });
  }
}
