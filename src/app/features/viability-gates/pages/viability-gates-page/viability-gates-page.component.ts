import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { catchError, of } from 'rxjs';

import { ViabilityGatesService } from '@core/services/viability-gates.service';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import {
  GateThresholdKind,
  UpdateViabilityGateThresholdItem,
  VIABILITY_GATE_MODES,
  ViabilityGate,
  ViabilityGateMode,
  ViabilityGateThreshold,
} from '../../viability-gates.types';

/**
 * Viability Gates cockpit — operator surface for the 7 structural-conviction
 * gates (E4e..E4j + E4h).  Each gate renders as a card with the current
 * mode, an inline threshold editor, today's firing count, and the ghost-
 * outcome breakdown (resolved by GhostOutcomeWorker for rejected/advisory
 * signals).  Writes hit the engine's PUT endpoint which upserts EngineConfig
 * rows and invalidates the cache — changes take effect on the very next
 * analysis without a restart.
 *
 * Editing model: each card owns a local draft (mode + threshold values).
 * Save sends only the keys whose value differs from the server snapshot.
 * Reset reverts to the compile-time defaults the engine emits.
 */
@Component({
  selector: 'app-viability-gates-page',
  standalone: true,
  imports: [CommonModule, FormsModule, DecimalPipe, PageHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="page">
      <app-page-header
        title="Viability Gates"
        subtitle="Configure and operate the 7 structural-conviction gates (E4e..E4j + E4h). Changes hot-reload — they apply to the next analysis without a restart."
      >
        <button
          class="btn btn-ghost"
          type="button"
          (click)="runGhostCycle()"
          [disabled]="ghostRunning()"
          title="Replay rejected signals against subsequent candles to refresh per-gate ghost stats"
        >
          @if (ghostRunning()) {
            Running ghost cycle…
          } @else {
            Run ghost-outcome cycle
          }
        </button>
        <button class="btn btn-ghost" type="button" (click)="reload()">Reload</button>
      </app-page-header>

      @if (ghostResultMessage(); as msg) {
        <div class="state-row" [class.error]="ghostError()">{{ msg }}</div>
      }

      @if (loading()) {
        <div class="state-row muted">Loading gate config…</div>
      } @else if (error()) {
        <div class="state-row error">{{ error() }}</div>
      } @else if (gates().length === 0) {
        <div class="state-row muted">No gates returned by the engine.</div>
      } @else {
        <p class="window-note muted">
          Firing/ghost stats cover the trailing 24h (window starts
          {{ windowStartUtc() }} UTC).
        </p>

        <div class="gate-grid">
          @for (gate of gates(); track gate.name) {
            <article class="gate-card">
              <header class="gate-head">
                <div>
                  <h2>{{ gate.displayName }}</h2>
                  <p class="muted">{{ gate.description }}</p>
                </div>
                <span class="mode-badge" [class]="'mode-' + gate.mode.toLowerCase()">{{
                  gate.mode
                }}</span>
              </header>

              <!-- Stats strip ------------------------------------------------ -->
              <div class="stats">
                <div class="stat">
                  <span class="stat-label">24h rejected</span>
                  <span class="stat-value">{{ gate.stats.todayRejectionCount }}</span>
                </div>
                <div class="stat">
                  <span class="stat-label">24h advisory</span>
                  <span class="stat-value">{{ gate.stats.todayAdvisoryCount }}</span>
                </div>
                <div class="stat">
                  <span class="stat-label">Ghost: would-win</span>
                  <span class="stat-value pos">{{ gate.stats.ghostWouldHaveWon }}</span>
                </div>
                <div class="stat">
                  <span class="stat-label">Ghost: would-lose</span>
                  <span class="stat-value neg">{{ gate.stats.ghostWouldHaveLost }}</span>
                </div>
                <div class="stat">
                  <span class="stat-label">Ghost: no fill</span>
                  <span class="stat-value">{{ gate.stats.ghostEntryNotReached }}</span>
                </div>
                <div class="stat">
                  <span class="stat-label">Ghost: expired</span>
                  <span class="stat-value">{{ gate.stats.ghostWouldHaveExpired }}</span>
                </div>
                @if (gate.stats.avgWinPips !== null) {
                  <div class="stat">
                    <span class="stat-label">Avg win pips</span>
                    <span class="stat-value pos">
                      +{{ gate.stats.avgWinPips | number: '1.1-1' }}
                    </span>
                  </div>
                }
                @if (gate.stats.avgLossPips !== null) {
                  <div class="stat">
                    <span class="stat-label">Avg loss pips</span>
                    <span class="stat-value neg">
                      {{ gate.stats.avgLossPips | number: '1.1-1' }}
                    </span>
                  </div>
                }
              </div>

              <!-- Editor ----------------------------------------------------- -->
              <div class="editor">
                <label class="field">
                  <span class="field-label">Mode</span>
                  <select
                    class="control"
                    [ngModel]="draftMode(gate.name)"
                    (ngModelChange)="setDraftMode(gate.name, $event)"
                  >
                    @for (m of modes; track m) {
                      <option [value]="m">{{ m }}</option>
                    }
                  </select>
                </label>

                @for (t of gate.thresholds; track t.key) {
                  <label class="field">
                    <span class="field-label">
                      {{ t.label }}
                      <span class="kind-tag">{{ kindSuffix(t.kind) }}</span>
                    </span>
                    <input
                      class="control"
                      type="number"
                      [ngModel]="draftThreshold(gate.name, t.key)"
                      (ngModelChange)="setDraftThreshold(gate.name, t.key, $event)"
                      [min]="t.minValue"
                      [max]="t.maxValue"
                      [step]="stepFor(t.kind)"
                    />
                    @if (t.helpText) {
                      <span class="field-help muted">{{ t.helpText }}</span>
                    }
                    <span class="field-default muted">
                      default {{ t.defaultValue | number: '1.0-4' }} · range [{{ t.minValue }},
                      {{ t.maxValue }}]
                    </span>
                  </label>
                }
              </div>

              <!-- Actions ---------------------------------------------------- -->
              <footer class="actions">
                @if (savingGate() === gate.name) {
                  <span class="muted">Saving…</span>
                } @else if (savedGate() === gate.name) {
                  <span class="ok">Saved.</span>
                } @else if (saveError(gate.name); as err) {
                  <span class="err">{{ err }}</span>
                } @else if (isDirty(gate.name)) {
                  <span class="muted">Unsaved changes.</span>
                }
                <button
                  class="btn btn-ghost"
                  type="button"
                  (click)="resetGate(gate.name)"
                  [disabled]="!isDirty(gate.name) || savingGate() === gate.name"
                >
                  Revert
                </button>
                <button
                  class="btn btn-ghost"
                  type="button"
                  (click)="resetToDefaults(gate.name)"
                  [disabled]="savingGate() === gate.name"
                  title="Set every knob to its compile-time default"
                >
                  Reset to defaults
                </button>
                <button
                  class="btn btn-primary"
                  type="button"
                  (click)="save(gate.name)"
                  [disabled]="!isDirty(gate.name) || savingGate() === gate.name"
                >
                  Save changes
                </button>
              </footer>
            </article>
          }
        </div>
      }
    </section>
  `,
  styles: [
    `
      .page {
        padding: var(--space-6);
      }
      .state-row {
        padding: var(--space-4);
        border-radius: 8px;
        background: var(--surface-2);
      }
      .state-row.error {
        color: var(--danger);
        background: rgba(255, 80, 80, 0.08);
      }
      .window-note {
        margin: 0 0 var(--space-4);
      }
      .gate-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
        gap: var(--space-4);
      }
      .gate-card {
        background: var(--surface-1);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: var(--space-4);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .gate-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: var(--space-3);
      }
      .gate-head h2 {
        margin: 0 0 var(--space-1);
        font-size: var(--text-md);
        font-weight: var(--font-semibold);
      }
      .gate-head .muted {
        margin: 0;
        font-size: var(--text-xs);
      }
      .mode-badge {
        padding: 2px 8px;
        border-radius: 999px;
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        white-space: nowrap;
      }
      .mode-enforce {
        background: rgba(10, 132, 255, 0.15);
        color: var(--accent);
      }
      .mode-advisory {
        background: rgba(255, 184, 0, 0.18);
        color: var(--warning, #b08800);
      }
      .mode-off {
        background: rgba(150, 150, 150, 0.18);
        color: var(--text-secondary);
      }
      .stats {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
        gap: var(--space-2);
        padding: var(--space-2);
        background: var(--surface-2);
        border-radius: 6px;
      }
      .stat {
        display: flex;
        flex-direction: column;
      }
      .stat-label {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-secondary);
      }
      .stat-value {
        font-size: var(--text-md);
        font-weight: var(--font-semibold);
      }
      .stat-value.pos {
        color: var(--success, #2e8d4a);
      }
      .stat-value.neg {
        color: var(--danger, #cc3a3a);
      }
      .editor {
        display: grid;
        grid-template-columns: 1fr;
        gap: var(--space-3);
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .field-label {
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        color: var(--text-secondary);
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .kind-tag {
        font-size: 9px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-secondary);
        background: var(--surface-2);
        border-radius: 4px;
        padding: 1px 6px;
      }
      .field-help {
        font-size: var(--text-xs);
      }
      .field-default {
        font-size: 11px;
      }
      .control {
        padding: 6px 8px;
        border-radius: 6px;
        border: 1px solid var(--border);
        background: var(--surface-2);
        color: var(--text-primary);
        font-size: var(--text-sm);
      }
      .actions {
        display: flex;
        gap: var(--space-2);
        justify-content: flex-end;
        align-items: center;
        flex-wrap: wrap;
        border-top: 1px solid var(--border);
        padding-top: var(--space-3);
      }
      .actions .muted,
      .actions .ok,
      .actions .err {
        margin-right: auto;
        font-size: var(--text-xs);
      }
      .ok {
        color: var(--success, #2e8d4a);
      }
      .err {
        color: var(--danger, #cc3a3a);
      }
      .btn {
        padding: 6px 12px;
        border-radius: 6px;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        cursor: pointer;
        border: 1px solid transparent;
      }
      .btn[disabled] {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .btn-ghost {
        background: transparent;
        border-color: var(--border);
        color: var(--text-primary);
      }
      .btn-primary {
        background: var(--accent);
        color: white;
      }
    `,
  ],
})
export class ViabilityGatesPageComponent {
  private readonly svc = inject(ViabilityGatesService);

  readonly modes = VIABILITY_GATE_MODES;

  readonly loading = signal<boolean>(true);
  readonly error = signal<string | null>(null);
  readonly savingGate = signal<string | null>(null);
  readonly savedGate = signal<string | null>(null);
  private readonly saveErrors = signal<Record<string, string>>({});
  readonly windowStartUtc = signal<string>('');

  readonly ghostRunning = signal<boolean>(false);
  readonly ghostResultMessage = signal<string | null>(null);
  readonly ghostError = signal<boolean>(false);

  /**
   * Source of truth from the server.  Card edits write to {@link drafts}
   * keyed by gate name; dirty-detection compares drafts to this snapshot.
   */
  private readonly serverGates = signal<ViabilityGate[]>([]);
  readonly gates = computed(() => this.serverGates());

  /**
   * Per-gate draft state.  Stored as a record keyed by gate name; each
   * draft holds the current mode + a map of `thresholdKey → number`.
   */
  private readonly drafts = signal<Record<string, GateDraft>>({});

  constructor() {
    this.reload();
  }

  /**
   * Trigger an on-demand ghost-outcome resolution cycle on the engine.
   * Engine returns the count of signals resolved; we surface it as a
   * banner and then refresh the gate list so the new ghost-stats land
   * in the cards without a manual Reload click.
   */
  runGhostCycle(): void {
    if (this.ghostRunning()) return;
    this.ghostRunning.set(true);
    this.ghostError.set(false);
    this.ghostResultMessage.set(null);
    this.svc
      .runGhostOutcomeCycle()
      .pipe(
        catchError((err) => {
          this.ghostError.set(true);
          this.ghostResultMessage.set(
            err?.error?.message ?? err?.message ?? 'Ghost-outcome cycle failed.',
          );
          this.ghostRunning.set(false);
          return of(null);
        }),
      )
      .subscribe((resolved) => {
        if (resolved === null) return;
        this.ghostError.set(false);
        this.ghostResultMessage.set(
          resolved === 0
            ? 'Ghost-outcome cycle ran — no unresolved candidates this pass (most likely the worker already picked them up in its last 5-min poll).'
            : `Ghost-outcome cycle resolved ${resolved} signal(s). Stats refreshed below.`,
        );
        this.ghostRunning.set(false);
        this.reload();
      });
  }

  reload(): void {
    this.loading.set(true);
    this.error.set(null);
    this.savedGate.set(null);
    this.svc
      .list()
      .pipe(
        catchError((err) => {
          this.error.set(err?.message ?? 'Failed to load gate config.');
          return of(null);
        }),
      )
      .subscribe((res) => {
        this.loading.set(false);
        if (!res) return;
        this.serverGates.set(res.gates);
        this.windowStartUtc.set(this.formatWindowStart(res.statsWindowStartUtc));
        this.drafts.set(this.buildDrafts(res.gates));
      });
  }

  saveError(name: string): string | null {
    return this.saveErrors()[name] ?? null;
  }

  draftMode(name: string): ViabilityGateMode {
    return this.drafts()[name]?.mode ?? 'Enforce';
  }

  draftThreshold(name: string, key: string): number {
    const v = this.drafts()[name]?.thresholds[key];
    return typeof v === 'number' ? v : 0;
  }

  setDraftMode(name: string, mode: ViabilityGateMode): void {
    const cur = this.drafts();
    if (!cur[name]) return;
    this.drafts.set({ ...cur, [name]: { ...cur[name], mode } });
    this.savedGate.set(null);
  }

  setDraftThreshold(name: string, key: string, value: number): void {
    const cur = this.drafts();
    if (!cur[name]) return;
    const draft = cur[name];
    this.drafts.set({
      ...cur,
      [name]: { ...draft, thresholds: { ...draft.thresholds, [key]: value } },
    });
    this.savedGate.set(null);
  }

  isDirty(name: string): boolean {
    const gate = this.serverGates().find((g) => g.name === name);
    const draft = this.drafts()[name];
    if (!gate || !draft) return false;
    if (draft.mode !== gate.mode) return true;
    for (const t of gate.thresholds) {
      if (draft.thresholds[t.key] !== t.value) return true;
    }
    return false;
  }

  /** Revert the draft back to the latest server snapshot. */
  resetGate(name: string): void {
    const gate = this.serverGates().find((g) => g.name === name);
    if (!gate) return;
    this.drafts.set({
      ...this.drafts(),
      [name]: this.buildDraftForGate(gate),
    });
    this.clearSaveError(name);
    this.savedGate.set(null);
  }

  /** Stage every threshold at its compile-time default (mode unchanged). */
  resetToDefaults(name: string): void {
    const gate = this.serverGates().find((g) => g.name === name);
    if (!gate) return;
    const draft = this.drafts()[name];
    const thresholds: Record<string, number> = {};
    for (const t of gate.thresholds) thresholds[t.key] = t.defaultValue;
    this.drafts.set({
      ...this.drafts(),
      [name]: { mode: draft?.mode ?? gate.mode, thresholds },
    });
    this.clearSaveError(name);
    this.savedGate.set(null);
  }

  /** Persist the diff vs the server snapshot. */
  save(name: string): void {
    const gate = this.serverGates().find((g) => g.name === name);
    const draft = this.drafts()[name];
    if (!gate || !draft) return;

    const body: {
      mode?: ViabilityGateMode | null;
      thresholds?: UpdateViabilityGateThresholdItem[];
    } = {};
    if (draft.mode !== gate.mode) body.mode = draft.mode;

    const changes: UpdateViabilityGateThresholdItem[] = [];
    for (const t of gate.thresholds) {
      const v = draft.thresholds[t.key];
      if (typeof v === 'number' && v !== t.value) {
        if (v < t.minValue || v > t.maxValue) {
          this.setSaveError(name, `${t.label} must be between ${t.minValue} and ${t.maxValue}.`);
          return;
        }
        changes.push({ key: t.key, value: v });
      }
    }
    if (changes.length > 0) body.thresholds = changes;

    if (!body.mode && (!body.thresholds || body.thresholds.length === 0)) {
      this.savedGate.set(name);
      return;
    }

    this.clearSaveError(name);
    this.savingGate.set(name);
    this.svc
      .update(name, body)
      .pipe(
        catchError((err) => {
          this.savingGate.set(null);
          this.setSaveError(name, err?.error?.message ?? err?.message ?? 'Save failed.');
          return of(null);
        }),
      )
      .subscribe((written) => {
        this.savingGate.set(null);
        if (written === null) return;
        this.savedGate.set(name);
        // Refresh from server so stats counts and any server-side clamping
        // surface immediately, instead of waiting for a manual reload.
        this.reload();
      });
  }

  kindSuffix(kind: GateThresholdKind): string {
    switch (kind) {
      case 'Percent':
        return '%';
      case 'Confidence':
        return '0..1';
      case 'Ratio':
        return 'ratio';
      case 'Pips':
        return 'pips';
      case 'AbsoluteVolume':
        return 'vol';
      case 'Integer':
        return 'int';
      default:
        return '';
    }
  }

  stepFor(kind: GateThresholdKind): number {
    switch (kind) {
      case 'Confidence':
      case 'Ratio':
        return 0.01;
      case 'Percent':
      case 'Pips':
        return 1;
      case 'AbsoluteVolume':
        return 100;
      case 'Integer':
        return 1;
      default:
        return 0.01;
    }
  }

  private buildDrafts(gates: ViabilityGate[]): Record<string, GateDraft> {
    const out: Record<string, GateDraft> = {};
    for (const g of gates) out[g.name] = this.buildDraftForGate(g);
    return out;
  }

  private buildDraftForGate(g: ViabilityGate): GateDraft {
    const thresholds: Record<string, number> = {};
    for (const t of g.thresholds) thresholds[t.key] = t.value;
    return { mode: g.mode, thresholds };
  }

  private setSaveError(name: string, msg: string): void {
    this.saveErrors.set({ ...this.saveErrors(), [name]: msg });
  }

  private clearSaveError(name: string): void {
    const cur = { ...this.saveErrors() };
    delete cur[name];
    this.saveErrors.set(cur);
  }

  private formatWindowStart(iso: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toISOString().replace('T', ' ').slice(0, 16);
  }
}

interface GateDraft {
  mode: ViabilityGateMode;
  thresholds: Record<string, number>;
}

// Local helper for the threshold input: each draft.threshold[key] is a number
// (matches the input[type=number] (ngModelChange) signature).
export type ViabilityGateThresholdRow = ViabilityGateThreshold;
