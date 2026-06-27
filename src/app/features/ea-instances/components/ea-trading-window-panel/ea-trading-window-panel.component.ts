import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { catchError, of } from 'rxjs';
import { EAFleetService } from '@core/services/ea-fleet.service';
import { TradingWindowConfig } from '@core/api/api.types';

const ALL_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/**
 * Fleet-wide trading-window editor — when enabled, the engine auto-rejects
 * any TradeSignal generated outside the configured UTC window and, if
 * `flattenOnExit` is on, closes every open position + cancels every pending
 * order at the moment the window ends each day.
 *
 * Lives on the EA Instances page because that's the operator's EA control
 * surface, but the policy itself is fleet-wide (single set of times applies
 * to every EA). Per-EA overrides can layer on later if needed.
 */
@Component({
  selector: 'app-ea-trading-window-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, DatePipe],
  template: `
    <section class="panel">
      <header class="panel-head">
        <div>
          <h3>Trading window</h3>
          <p class="muted small">
            Fleet-wide policy. When enabled, signals generated outside the window are auto-rejected
            and (optionally) open positions + pending orders are flattened at window exit. UTC
            clock.
          </p>
        </div>
        <span class="status-pill" [class.on]="cfg().enabled" [class.off]="!cfg().enabled">
          {{ cfg().enabled ? 'ENFORCED' : 'OFF' }}
        </span>
      </header>

      @if (loading()) {
        <p class="muted small">Loading…</p>
      } @else {
        <div class="form-row">
          <label class="inline-check">
            <input
              type="checkbox"
              [checked]="cfg().enabled"
              (change)="patch({ enabled: $any($event.target).checked })"
            />
            <span>Enable trading window</span>
          </label>
          <label class="inline-check">
            <input
              type="checkbox"
              [checked]="cfg().flattenOnExit"
              (change)="patch({ flattenOnExit: $any($event.target).checked })"
              [disabled]="!cfg().enabled"
            />
            <span>Flatten positions + cancel pending orders at window exit</span>
          </label>
        </div>

        <div class="form-row">
          <div class="field">
            <label>Start (UTC)</label>
            <input
              type="time"
              [value]="cfg().startUtc"
              (change)="patch({ startUtc: $any($event.target).value })"
              [disabled]="!cfg().enabled"
            />
          </div>
          <div class="field">
            <label>End (UTC)</label>
            <input
              type="time"
              [value]="cfg().endUtc"
              (change)="patch({ endUtc: $any($event.target).value })"
              [disabled]="!cfg().enabled"
            />
            <p class="muted xs">End before start = wraps midnight (e.g. 22:00 → 06:00).</p>
          </div>
        </div>

        <div class="field">
          <label>Active days</label>
          <ul class="day-grid">
            @for (d of allDays; track d) {
              <li>
                <label class="inline-check">
                  <input
                    type="checkbox"
                    [checked]="cfg().days.includes(d)"
                    (change)="toggleDay(d, $any($event.target).checked)"
                    [disabled]="!cfg().enabled"
                  />
                  <span>{{ d }}</span>
                </label>
              </li>
            }
          </ul>
          <p class="muted xs">
            Defaults to Mon–Fri (forex market days). Untick all to soft-disable without flipping the
            master toggle.
          </p>
        </div>

        <div class="actions">
          <button type="button" class="btn" (click)="save()" [disabled]="saving() || !dirty()">
            {{ saving() ? 'Saving…' : 'Save' }}
          </button>
          @if (savedAt()) {
            <span class="muted small">Saved {{ savedAt() | date: 'HH:mm:ss' }}</span>
          }
          @if (error()) {
            <span class="error small">{{ error() }}</span>
          }
        </div>
      }
    </section>
  `,
  styles: [
    `
      .panel {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-4);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        height: 100%;
      }
      .panel-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: var(--space-3);
      }
      .panel-head h3 {
        margin: 0 0 4px;
        font-size: var(--text-base);
      }
      .status-pill {
        padding: 3px 10px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        letter-spacing: 0.04em;
      }
      .status-pill.on {
        background: rgba(255, 149, 0, 0.16);
        color: #b45309;
      }
      .status-pill.off {
        background: rgba(142, 142, 147, 0.18);
        color: var(--text-secondary);
      }
      .form-row {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-4);
        align-items: flex-start;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .field label {
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-tertiary);
        font-weight: var(--font-semibold);
      }
      .field input[type='time'] {
        height: 30px;
        padding: 0 8px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
      }
      .inline-check {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .inline-check input[disabled] + span {
        opacity: 0.55;
      }
      .day-grid {
        list-style: none;
        margin: 4px 0 0;
        padding: 6px 10px;
        display: grid;
        grid-template-columns: repeat(7, 1fr);
        gap: 6px 12px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
      }
      .day-grid li {
        display: flex;
      }
      .actions {
        display: flex;
        align-items: center;
        gap: var(--space-3);
      }
      .btn {
        height: 32px;
        padding: 0 14px;
        border-radius: var(--radius-sm);
        background: var(--accent);
        color: #fff;
        border: 1px solid var(--accent);
        font-weight: var(--font-semibold);
        font-size: 12px;
        cursor: pointer;
        font-family: inherit;
      }
      .btn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .muted {
        color: var(--text-tertiary);
      }
      .small {
        font-size: 11.5px;
      }
      .xs {
        font-size: 10.5px;
        margin: 4px 0 0;
      }
      .error {
        color: #b91c1c;
      }
    `,
  ],
})
export class EATradingWindowPanelComponent implements OnInit {
  private readonly svc = inject(EAFleetService);

  readonly allDays = [...ALL_DAYS];
  readonly cfg = signal<TradingWindowConfig>(this.defaultCfg());
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly dirty = signal(false);
  readonly error = signal<string | null>(null);
  readonly savedAt = signal<Date | null>(null);

  ngOnInit(): void {
    this.svc
      .getTradingWindow()
      .pipe(
        catchError((err) => {
          this.error.set(err?.message ?? 'Failed to load policy');
          return of(null);
        }),
      )
      .subscribe((res) => {
        this.loading.set(false);
        if (res?.data) this.cfg.set(this.normalise(res.data));
      });
  }

  patch(partial: Partial<TradingWindowConfig>): void {
    this.cfg.update((c) => ({ ...c, ...partial }));
    this.dirty.set(true);
  }

  toggleDay(day: string, on: boolean): void {
    const cur = this.cfg().days;
    const next = on ? Array.from(new Set([...cur, day])) : cur.filter((d) => d !== day);
    // Re-order to canonical Mon..Sun so persistence reads predictably.
    const canonical = ALL_DAYS.filter((d) => next.includes(d));
    this.patch({ days: canonical });
  }

  save(): void {
    if (this.saving()) return;
    this.saving.set(true);
    this.error.set(null);
    this.svc
      .updateTradingWindow(this.cfg())
      .pipe(
        catchError((err) => {
          this.error.set(err?.message ?? 'Save failed');
          return of(null);
        }),
      )
      .subscribe((res) => {
        this.saving.set(false);
        if (res?.data) {
          this.cfg.set(this.normalise(res.data));
          this.dirty.set(false);
          this.savedAt.set(new Date());
        }
      });
  }

  /** Defensive normalisation — server might omit fields on a fresh install. */
  private normalise(raw: TradingWindowConfig): TradingWindowConfig {
    return {
      enabled: !!raw.enabled,
      startUtc: raw.startUtc ?? '00:00',
      endUtc: raw.endUtc ?? '17:00',
      days:
        Array.isArray(raw.days) && raw.days.length > 0
          ? ALL_DAYS.filter((d) => raw.days.includes(d))
          : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
      flattenOnExit: raw.flattenOnExit ?? true,
    };
  }

  private defaultCfg(): TradingWindowConfig {
    return {
      enabled: false,
      startUtc: '00:00',
      endUtc: '17:00',
      days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
      flattenOnExit: true,
    };
  }
}
