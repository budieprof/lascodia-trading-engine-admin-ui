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
 * Portfolio-awareness controls for signal generation — the operator surface for the live
 * signal book that the sweep's analyses now consult. Reads/writes the `SignalExposure:*`
 * engine config (hot-reloadable): master switch, whether armed limits count, the in-play
 * window, tracker cadence, and the CROWDED threshold. Walk-derived and fully decoupled from
 * trading-account positions — it governs how the ANALYST sees its own concentration.
 */
@Component({
  selector: 'app-signal-exposure-controls',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <section class="card" aria-label="Portfolio awareness controls">
      <header class="head">
        <div>
          <h3>Portfolio awareness</h3>
          <p class="muted small">
            Feeds the engine's net cross-currency exposure (across not-yet-resolved signals,
            position-independent) into every analysis so the LLM won't blindly stack correlated
            same-direction bets. Governs signal generation, not execution.
          </p>
        </div>
      </header>

      @if (cfg(); as c) {
        <div class="grid">
          <label class="toggle-row">
            <input
              type="checkbox"
              [checked]="c.enabled"
              (change)="patch({ enabled: $any($event.target).checked })"
            />
            <span>
              <strong>Enable portfolio awareness</strong>
              <span class="muted small">
                Off = no exposure block injected and the tracker stops.
              </span>
            </span>
          </label>

          <label class="toggle-row" [class.disabled]="!c.enabled">
            <input
              type="checkbox"
              [checked]="c.includePending"
              [disabled]="!c.enabled"
              (change)="patch({ includePending: $any($event.target).checked })"
            />
            <span>
              <strong>Count armed (pending-fill) signals</strong>
              <span class="muted small">
                Include not-yet-filled limits as committed intent, not just open exposure.
              </span>
            </span>
          </label>

          <div class="num-row" [class.disabled]="!c.enabled">
            <label for="crowded">
              <strong>Crowded threshold</strong>
              <span class="muted small">|net| at/above this flags a currency leg CROWDED.</span>
            </label>
            <div class="num-input">
              <input
                id="crowded"
                type="number"
                min="1"
                max="50"
                [disabled]="!c.enabled"
                [ngModel]="c.crowdedThreshold"
                (ngModelChange)="patch({ crowdedThreshold: clampInt($event, 1, 50) })"
              />
              <span class="muted small">default {{ c.crowdedThresholdDefault }}</span>
            </div>
          </div>

          <div class="num-row" [class.disabled]="!c.enabled">
            <label for="window">
              <strong>In-play window (hours)</strong>
              <span class="muted small"
                >How long a signal stays in the book before it ages out.</span
              >
            </label>
            <div class="num-input">
              <input
                id="window"
                type="number"
                min="1"
                max="720"
                [disabled]="!c.enabled"
                [ngModel]="c.inPlayWindowHours"
                (ngModelChange)="patch({ inPlayWindowHours: clampInt($event, 1, 720) })"
              />
              <span class="muted small">default {{ c.inPlayWindowHoursDefault }}</span>
            </div>
          </div>

          <div class="num-row" [class.disabled]="!c.enabled">
            <label for="interval">
              <strong>Tracker refresh (seconds)</strong>
              <span class="muted small">How often the book is re-walked.</span>
            </label>
            <div class="num-input">
              <input
                id="interval"
                type="number"
                min="15"
                max="3600"
                [disabled]="!c.enabled"
                [ngModel]="c.intervalSeconds"
                (ngModelChange)="patch({ intervalSeconds: clampInt($event, 15, 3600) })"
              />
              <span class="muted small">default {{ c.intervalSecondsDefault }}</span>
            </div>
          </div>
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
        <p class="muted small">Loading portfolio-awareness settings…</p>
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
export class SignalExposureControlsComponent {
  private readonly marketData = inject(MarketDataService);
  private readonly notify = inject(NotificationService);

  /** Server truth (last loaded/saved). */
  private readonly persisted = signal<SignalExposureConfigDto | null>(null);
  /** Working copy the form edits. */
  readonly cfg = signal<SignalExposureConfigDto | null>(null);
  readonly saving = signal(false);

  readonly dirty = computed(() => {
    const a = this.persisted();
    const b = this.cfg();
    if (!a || !b) return false;
    return (
      a.enabled !== b.enabled ||
      a.includePending !== b.includePending ||
      a.inPlayWindowHours !== b.inPlayWindowHours ||
      a.intervalSeconds !== b.intervalSeconds ||
      a.crowdedThreshold !== b.crowdedThreshold
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

    // Only send changed fields (partial update).
    const body: UpdateSignalExposureConfigRequest = {};
    if (cur.enabled !== prev.enabled) body.enabled = cur.enabled;
    if (cur.includePending !== prev.includePending) body.includePending = cur.includePending;
    if (cur.inPlayWindowHours !== prev.inPlayWindowHours)
      body.inPlayWindowHours = cur.inPlayWindowHours;
    if (cur.intervalSeconds !== prev.intervalSeconds) body.intervalSeconds = cur.intervalSeconds;
    if (cur.crowdedThreshold !== prev.crowdedThreshold)
      body.crowdedThreshold = cur.crowdedThreshold;

    this.saving.set(true);
    this.marketData
      .updateSignalExposureConfig(body)
      .pipe(finalize(() => this.saving.set(false)))
      .subscribe({
        next: () => {
          this.persisted.set({ ...cur });
          this.notify.success('Portfolio-awareness settings saved.');
        },
        error: () => this.notify.error('Could not save portfolio-awareness settings.'),
      });
  }
}
