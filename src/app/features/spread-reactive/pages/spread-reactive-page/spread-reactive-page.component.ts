import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { catchError, of } from 'rxjs';

import { SpreadReactiveService } from '@core/services/spread-reactive.service';
import { createPolledResource } from '@core/polling/polled-resource';
import {
  DEFAULT_SPREAD_REACTIVE_CONFIG,
  SpreadCondition,
  SpreadReactiveConfig,
  SpreadStateEntry,
} from '@features/spread-reactive/spread-reactive.types';

/**
 * Spread-reactive subsystem: config + live state dashboard.
 *
 * The subsystem watches per-`(TradingAccount, Symbol)` spread, widens
 * SL away from the noise band when spread spikes (NY close, news,
 * weekend gaps), and reverts when spread normalises.  Off by default —
 * the master toggle is the panic-on, not just a UI hint.
 *
 * <p>The status section polls `/spread-reactive/state` every 5s and
 * shows the current condition per (account, symbol) so the operator
 * can see at a glance whether bumps are currently active anywhere.</p>
 */
@Component({
  selector: 'app-spread-reactive-page',
  standalone: true,
  imports: [DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Spread-Reactive</h1>
          <p class="muted">
            Opt-in stop-loss widening when broker spread spikes — protects open positions during NY
            close, news, and weekend gaps. Per-account baselines so Exness Raw vs Standard vs other
            brokers don't share one wrong number.
          </p>
        </div>
        @if (config(); as cfg) {
          <div class="head-actions">
            <button
              type="button"
              class="power-btn"
              [class.on]="cfg.enabled"
              [disabled]="saving()"
              (click)="toggleEnabled()"
            >
              {{ cfg.enabled ? '■ Disable' : '▶ Enable' }}
            </button>
          </div>
        }
      </header>

      @if (error(); as e) {
        <div class="banner error">{{ e }}</div>
      }
      @if (saved()) {
        <div class="banner ok">Saved.</div>
      }

      <!-- ───────── Live state ───────── -->
      <section class="card">
        <div class="status-head">
          <h2>Live state</h2>
          <span class="status-meta">
            <span class="muted small"
              >{{ stateRows().length }} pair{{ stateRows().length === 1 ? '' : 's' }} observed</span
            >
            @if (elevatedCount() > 0) {
              <span class="condition-pill elevated">{{ elevatedCount() }} elevated</span>
            }
            <button
              type="button"
              class="btn ghost"
              (click)="state.refresh()"
              [disabled]="state.loading()"
            >
              {{ state.loading() ? 'Refreshing…' : 'Refresh' }}
            </button>
          </span>
        </div>
        @if (stateRows().length === 0) {
          <p class="muted small">
            No telemetry yet. State warms up as ticks arrive from active EA instances.
          </p>
        } @else {
          <div class="state-table-wrap">
            <table class="state-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Symbol</th>
                  <th>Condition</th>
                  <th class="num">Spread</th>
                  <th class="num">Baseline</th>
                  <th class="num">×</th>
                  <th class="num">Samples</th>
                  <th class="num">Calm run</th>
                  <th>Last sample</th>
                </tr>
              </thead>
              <tbody>
                @for (r of stateRows(); track r.tradingAccountId + ':' + r.symbol) {
                  <tr [class.row-elevated]="r.condition === 'Elevated'">
                    <td class="mono small">{{ r.tradingAccountId }}</td>
                    <td class="mono">{{ r.symbol }}</td>
                    <td>
                      <span
                        class="condition-pill"
                        [class.warming]="r.condition === 'Warming'"
                        [class.normal]="r.condition === 'Normal'"
                        [class.elevated]="r.condition === 'Elevated'"
                        >{{ r.condition }}</span
                      >
                    </td>
                    <td class="num mono">{{ r.currentSpread | number: '1.5-5' }}</td>
                    <td class="num mono">
                      @if (r.baseline > 0) {
                        {{ r.baseline | number: '1.5-5' }}
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td class="num mono" [class.muted]="r.baseline === 0">
                      {{ ratioOf(r) }}
                    </td>
                    <td class="num mono">{{ r.sampleCount }}</td>
                    <td class="num mono">{{ r.consecutiveCalmSamples }}</td>
                    <td class="mono small" [class.muted]="staleRow(r)">
                      {{ sampleAge(r.lastSampleAt) }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>

      @if (config(); as cfg) {
        <section class="card">
          <h2>Detection</h2>
          <p class="muted small">How the worker decides a pair is in elevated-spread state.</p>
          <div class="grid-2">
            <label class="field">
              <span>Baseline window (minutes)</span>
              <input
                type="number"
                min="1"
                step="1"
                [value]="cfg.baselineWindowMinutes"
                (input)="patch({ baselineWindowMinutes: toInt($any($event.target).value, 1) })"
              />
              <small class="muted">Rolling window the worker uses for the median baseline.</small>
            </label>
            <label class="field">
              <span>Min samples before triggering</span>
              <input
                type="number"
                min="1"
                step="1"
                [value]="cfg.minSamplesBeforeTrigger"
                (input)="patch({ minSamplesBeforeTrigger: toInt($any($event.target).value, 1) })"
              />
              <small class="muted"
                >Warm-up gate — no bumps until this many samples collected.</small
              >
            </label>
            <label class="field">
              <span>Spread multiplier (k)</span>
              <input
                type="number"
                min="1"
                step="0.1"
                [value]="cfg.spreadMultiplier"
                (input)="patch({ spreadMultiplier: toFloat($any($event.target).value, 1) })"
              />
              <small class="muted">
                Condition flips to Elevated when
                <em>current ≥ baseline × {{ cfg.spreadMultiplier | number: '1.1-2' }}</em
                >.
              </small>
            </label>
          </div>
        </section>

        <section class="card">
          <h2>Action</h2>
          <p class="muted small">How far the SL is widened, and the hard cap.</p>
          <div class="grid-2">
            <label class="field">
              <span>Cushion multiplier</span>
              <input
                type="number"
                min="0"
                step="0.1"
                [value]="cfg.cushionMultiplier"
                (input)="patch({ cushionMultiplier: toFloat($any($event.target).value, 0) })"
              />
              <small class="muted">
                Bump amount =
                <em>current_spread × {{ cfg.cushionMultiplier | number: '1.1-2' }}</em>
                in price units.
              </small>
            </label>
            <label class="field">
              <span>Max bump distance (pips)</span>
              <input
                type="number"
                min="0"
                step="1"
                [value]="cfg.maxBumpDistancePips"
                (input)="patch({ maxBumpDistancePips: toFloat($any($event.target).value, 0) })"
              />
              <small class="muted">
                Hard floor — bump is clamped to this many pips × the symbol's PipSize.
              </small>
            </label>
          </div>
        </section>

        <section class="card">
          <h2>Revert</h2>
          <p class="muted small">When and how the worker restores the original SL.</p>
          <div class="grid-2">
            <label class="field">
              <span>Revert ratio</span>
              <input
                type="number"
                min="1"
                step="0.1"
                [value]="cfg.revertRatio"
                (input)="patch({ revertRatio: toFloat($any($event.target).value, 1) })"
              />
              <small class="muted">
                A sample counts as "calm" when
                <em>current ≤ baseline × {{ cfg.revertRatio | number: '1.1-2' }}</em
                >.
              </small>
            </label>
            <label class="field">
              <span>Consecutive calm samples to revert</span>
              <input
                type="number"
                min="1"
                step="1"
                [value]="cfg.consecutiveCalmSamplesToRevert"
                (input)="
                  patch({ consecutiveCalmSamplesToRevert: toInt($any($event.target).value, 1) })
                "
              />
              <small class="muted"
                >Hysteresis — prevents flickering reverts when spread oscillates.</small
              >
            </label>
          </div>
        </section>

        <section class="card">
          <h2>Safety</h2>
          <p class="muted small">Watchdog + tick cadence.</p>
          <div class="grid-2">
            <label class="field">
              <span>Telemetry freshness (seconds)</span>
              <input
                type="number"
                min="10"
                step="1"
                [value]="cfg.telemetryFreshnessSeconds"
                (input)="patch({ telemetryFreshnessSeconds: toInt($any($event.target).value, 10) })"
              />
              <small class="muted">
                If no ticks arrive for this long, bump/revert decisions freeze — uncertain = stay
                safe.
              </small>
            </label>
            <label class="field">
              <span>Loop interval (seconds)</span>
              <input
                type="number"
                min="2"
                step="1"
                [value]="cfg.loopIntervalSeconds"
                (input)="patch({ loopIntervalSeconds: toInt($any($event.target).value, 2) })"
              />
              <small class="muted">How often the worker re-evaluates conditions.</small>
            </label>
          </div>
        </section>

        <div class="actions-row">
          <button
            type="button"
            class="btn primary"
            [disabled]="saving() || !dirty()"
            (click)="save()"
          >
            {{ saving() ? 'Saving…' : 'Save' }}
          </button>
          <button
            type="button"
            class="btn ghost"
            [disabled]="saving() || !dirty()"
            (click)="reset()"
          >
            Reset
          </button>
        </div>
      } @else if (loading()) {
        <div class="muted">Loading…</div>
      }
    </div>
  `,
  styles: [
    `
      .page {
        max-width: 980px;
        margin: 0 auto;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .page-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 16px;
      }
      .page-head h1 {
        margin: 0 0 4px;
      }
      .muted {
        color: var(--text-muted, #888);
      }
      .small {
        font-size: 0.85em;
      }
      .head-actions {
        display: flex;
        gap: 8px;
      }
      .power-btn {
        padding: 8px 14px;
        border-radius: 6px;
        border: 1px solid var(--border, #ccc);
        background: var(--surface, #fff);
        cursor: pointer;
        font-weight: 600;
      }
      .power-btn.on {
        background: var(--success-bg, #e7f5ec);
        border-color: var(--success, #2c8a3f);
        color: var(--success, #2c8a3f);
      }
      .card {
        background: var(--card-bg, #fff);
        border: 1px solid var(--border, #e3e3e3);
        border-radius: 8px;
        padding: 14px 16px;
      }
      .card h2 {
        margin: 0 0 4px;
        font-size: 1.05em;
      }
      .grid-2 {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px 16px;
        margin-top: 10px;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .field > span {
        font-weight: 600;
        font-size: 0.9em;
      }
      .field input {
        padding: 6px 8px;
        border-radius: 4px;
        border: 1px solid var(--border, #ccc);
        background: var(--input-bg, #fff);
      }
      .actions-row {
        display: flex;
        gap: 10px;
      }
      .btn {
        padding: 8px 14px;
        border-radius: 6px;
        border: 1px solid var(--border, #ccc);
        background: var(--surface, #fff);
        cursor: pointer;
      }
      .btn.primary {
        background: var(--primary, #2070d6);
        color: #fff;
        border-color: var(--primary, #2070d6);
      }
      .btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      .banner {
        padding: 10px 14px;
        border-radius: 6px;
      }
      .banner.error {
        background: var(--error-bg, #fde2e1);
        color: var(--error, #a32928);
      }
      .banner.ok {
        background: var(--success-bg, #e7f5ec);
        color: var(--success, #2c8a3f);
      }
      .status-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
      }
      .status-head h2 {
        margin: 0;
      }
      .status-meta {
        display: inline-flex;
        align-items: center;
        gap: 10px;
      }
      .condition-pill {
        padding: 2px 8px;
        border-radius: 8px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.4px;
        background: var(--bg-tertiary, #eee);
        color: var(--text-secondary, #555);
      }
      .condition-pill.warming {
        background: color-mix(in srgb, #9aa0a6 22%, transparent);
        color: #555e66;
      }
      .condition-pill.normal {
        background: color-mix(in srgb, #1d8a3e 22%, transparent);
        color: #1d8a3e;
      }
      .condition-pill.elevated {
        background: color-mix(in srgb, #ff453a 22%, transparent);
        color: #c93631;
      }
      .state-table-wrap {
        overflow-x: auto;
        margin-top: 10px;
      }
      .state-table {
        width: 100%;
        border-collapse: collapse;
      }
      .state-table th,
      .state-table td {
        padding: 6px 10px;
        text-align: left;
        border-bottom: 1px solid var(--border, #eee);
      }
      .state-table th {
        font-size: 12px;
        font-weight: 600;
        color: var(--text-secondary, #555);
      }
      .state-table .num {
        text-align: right;
      }
      .state-table .mono {
        font-family: var(--font-mono, ui-monospace, monospace);
      }
      .state-table .small {
        font-size: 0.85em;
      }
      .row-elevated {
        background: color-mix(in srgb, #ff453a 6%, transparent);
      }
      .btn.ghost {
        background: transparent;
      }
    `,
  ],
})
export class SpreadReactivePageComponent {
  private readonly service = inject(SpreadReactiveService);

  protected readonly config = signal<SpreadReactiveConfig | null>(null);
  protected readonly serverConfig = signal<SpreadReactiveConfig | null>(null);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly saved = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly dirty = computed(() => {
    const c = this.config();
    const s = this.serverConfig();
    return c !== null && s !== null && JSON.stringify(c) !== JSON.stringify(s);
  });

  // Live spread-state polled from `/spread-reactive/state` every 5s.
  // In-memory store on the engine — cheap to poll, no DB round-trip.
  protected readonly state = createPolledResource<SpreadStateEntry[]>(
    () => this.service.getState(),
    { intervalMs: 5_000 },
  );
  protected readonly stateRows = computed<SpreadStateEntry[]>(() => {
    const rows = this.state.value() ?? [];
    // Surface elevated rows first, then by symbol — operator scans for trouble.
    return [...rows].sort((a, b) => {
      const ca = conditionWeight(a.condition);
      const cb = conditionWeight(b.condition);
      if (ca !== cb) return cb - ca;
      if (a.symbol !== b.symbol) return a.symbol.localeCompare(b.symbol);
      return a.tradingAccountId - b.tradingAccountId;
    });
  });
  protected readonly elevatedCount = computed(
    () => this.stateRows().filter((r) => r.condition === 'Elevated').length,
  );

  constructor() {
    this.load();
    // Clear the saved banner 2s after it appears.
    effect((onCleanup) => {
      if (this.saved()) {
        const t = setTimeout(() => this.saved.set(false), 2000);
        onCleanup(() => clearTimeout(t));
      }
    });
  }

  private load(): void {
    this.loading.set(true);
    this.service
      .getConfig()
      .pipe(
        catchError((e) => {
          this.error.set(this.toMessage(e));
          return of({ ...DEFAULT_SPREAD_REACTIVE_CONFIG });
        }),
      )
      .subscribe((c) => {
        this.config.set({ ...c });
        this.serverConfig.set({ ...c });
        this.loading.set(false);
      });
  }

  protected toggleEnabled(): void {
    const c = this.config();
    if (!c) return;
    const next = { ...c, enabled: !c.enabled };
    this.config.set(next);
    // Immediate save on the master switch — operator intent is unambiguous.
    this.save(next);
  }

  protected patch(p: Partial<SpreadReactiveConfig>): void {
    const c = this.config();
    if (!c) return;
    this.config.set({ ...c, ...p });
  }

  protected save(override?: SpreadReactiveConfig): void {
    const c = override ?? this.config();
    if (!c) return;
    this.saving.set(true);
    this.error.set(null);
    this.service
      .saveConfig(c)
      .pipe(
        catchError((e) => {
          this.error.set(this.toMessage(e));
          this.saving.set(false);
          return of(null);
        }),
      )
      .subscribe((res) => {
        if (res) {
          this.config.set({ ...res });
          this.serverConfig.set({ ...res });
          this.saved.set(true);
        }
        this.saving.set(false);
      });
  }

  protected reset(): void {
    const s = this.serverConfig();
    if (s) this.config.set({ ...s });
  }

  // Template input coercion — Angular templates can't call the global
  // parseInt / parseFloat reliably, so expose tolerant helpers on the
  // component instance.  Both return `fallback` on NaN / non-finite input.
  protected toInt(v: unknown, fallback: number): number {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
  }

  protected toFloat(v: unknown, fallback: number): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  /** current / baseline ratio for the table — "—" when baseline isn't ready. */
  protected ratioOf(r: SpreadStateEntry): string {
    if (r.baseline <= 0) return '—';
    return (r.currentSpread / r.baseline).toFixed(2);
  }

  /**
   * Rendered "last sample" age — "Xs" up to 60s, "Xm Ys" beyond.  Used
   * to flag stale rows where bumps will freeze in place (the engine
   * applies the TelemetryFreshnessSeconds gate at decision time).
   */
  protected sampleAge(iso: string): string {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return '—';
    const diffSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (diffSec < 60) return `${diffSec}s ago`;
    const m = Math.floor(diffSec / 60);
    const s = diffSec % 60;
    return s === 0 ? `${m}m ago` : `${m}m ${s}s ago`;
  }

  /** Heuristic stale-row tag — last sample older than 2× the default freshness budget. */
  protected staleRow(r: SpreadStateEntry): boolean {
    const t = new Date(r.lastSampleAt).getTime();
    if (!Number.isFinite(t)) return true;
    return Date.now() - t > 120 * 1_000;
  }

  private toMessage(e: unknown): string {
    if (e instanceof Error) return e.message;
    return 'Request failed';
  }
}

function conditionWeight(c: SpreadCondition): number {
  switch (c) {
    case 'Elevated':
      return 2;
    case 'Normal':
      return 1;
    case 'Warming':
      return 0;
  }
}
