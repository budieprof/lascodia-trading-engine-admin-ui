import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { catchError, of, switchMap } from 'rxjs';

import { LlmService } from '@core/services/llm.service';
import {
  LlmConfigEntryDto,
  ConfigDataType,
  TestLlmProviderResult,
  PerSymbolShrinkageOverrideDto,
} from '@core/api/api.types';
import { NotificationService } from '@core/notifications/notification.service';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

interface EditableEntry extends LlmConfigEntryDto {
  /** Mutable copy of `value` the operator is editing. Saved separately on submit. */
  editedValue: string;
  isDirty: boolean;
  /** Group bucket: "Anthropic", "OpenAi", "Google", "DeepSeek", "Top-level", "Strategy proposer". */
  group: string;
}

/**
 * Enumeration catalog for config keys with a fixed, validated value set.
 * Kept in lockstep with the engine-side accepted values:
 *
 *   - DeepProvider / QuickProvider           → LlmClientFactory's provider switch
 *   - Anthropic.Effort                       → "high | medium | low | off"
 *   - OpenAi.ReasoningEffort                 → "high | medium | low"
 *   - Google.ThinkingLevel                   → "high | medium | minimal"
 *   - DeepSeek.ReasoningEffort               → "high | medium | low" (placeholder)
 *
 * Anything not in this map renders as a free-text input.
 */
const OPTION_CATALOG: Record<string, readonly string[]> = {
  'Llm:DeepProvider': ['anthropic', 'openai', 'google', 'deepseek'],
  'Llm:QuickProvider': ['anthropic', 'openai', 'google', 'deepseek'],
  'Llm:Anthropic:Effort': ['high', 'medium', 'low', 'off'],
  'Llm:OpenAi:ReasoningEffort': ['high', 'medium', 'low'],
  'Llm:Google:ThinkingLevel': ['high', 'medium', 'minimal'],
  'Llm:DeepSeek:ReasoningEffort': ['high', 'medium', 'low'],
};

@Component({
  selector: 'app-llm-settings-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, DatePipe, FormsModule, PageHeaderComponent],
  template: `
    <div class="page">
      <app-page-header
        title="LLM Settings"
        subtitle="Provider keys, model choices, daily caps and pricing. Every value lives in EngineConfig and (where flagged) hot-reloads without a restart."
      >
        <button type="button" class="btn-refresh" (click)="reload()">↻ Reload</button>
        <button type="button" class="btn-test" [disabled]="testing()" (click)="testProviders()">
          {{ testing() ? 'Testing…' : '🔌 Test connection' }}
        </button>
        <button type="button" class="btn-save" [disabled]="dirtyCount() === 0" (click)="save()">
          💾 Save {{ dirtyCount() ? '(' + dirtyCount() + ')' : '' }}
        </button>
      </app-page-header>

      <!-- ── Connectivity probe result ─────────────────────────────── -->
      @if (testResult(); as tr) {
        <section class="card test-result">
          <header class="card-head">
            <h3>Connectivity test</h3>
            <button type="button" class="btn-dismiss" (click)="testResult.set(null)">
              Dismiss
            </button>
          </header>
          <div class="test-grid">
            @for (t of tr.tiers; track t.tier) {
              <article class="tier" [class.ok]="t.ok" [class.fail]="!t.ok">
                <header class="tier-head">
                  <span class="tier-badge" [class.ok]="t.ok" [class.fail]="!t.ok">
                    {{ t.tier }} · {{ t.ok ? 'OK' : 'FAILED' }}
                  </span>
                  <span class="muted small">{{ t.latencyMs }} ms</span>
                </header>
                <dl class="tier-meta">
                  <div>
                    <dt>Provider</dt>
                    <dd class="mono">{{ t.provider }}</dd>
                  </div>
                  <div>
                    <dt>Model</dt>
                    <dd class="mono">{{ t.model }}</dd>
                  </div>
                  @if (t.llmInvocationId) {
                    <div>
                      <dt>Audit row</dt>
                      <dd class="mono">#{{ t.llmInvocationId }}</dd>
                    </div>
                  }
                </dl>
                @if (t.ok && t.responseSnippet) {
                  <p class="response">"{{ t.responseSnippet }}"</p>
                } @else if (!t.ok && t.errorMessage) {
                  <p class="error">{{ t.errorMessage }}</p>
                }
              </article>
            }
          </div>
        </section>
      }

      <!-- ── Per-symbol shrinkage overrides ─────────────────────── -->
      <section class="card">
        <header class="card-head">
          <h3>Per-symbol shrinkage overrides</h3>
          <div class="card-head-actions">
            <button type="button" class="btn-refresh" (click)="psoLoad()" [disabled]="psoLoading()">
              {{ psoLoading() ? '…' : '↻ Refresh' }}
            </button>
            <button
              type="button"
              class="btn-clear-all"
              (click)="psoClearAll()"
              [disabled]="psoBusy() || psoRows().length === 0"
              title="Soft-delete every active per-symbol override and fall back to the global"
            >
              {{ psoClearing() ? 'Clearing…' : '🗑 Clear all' }}
            </button>
          </div>
        </header>
        @if (psoLoading()) {
          <div class="note">Loading…</div>
        } @else if (psoLoadError()) {
          <div class="note error">{{ psoLoadError() }}</div>
        } @else if (psoRows().length === 0) {
          <div class="note">
            No active per-symbol overrides — every SpotAnalysis signal uses the engine-wide global
            TP / SL shrinkage. Set per-symbol values from the Signal Sensitivity page if you want to
            override per pair.
          </div>
        } @else {
          <table class="table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>TP shrinkage</th>
                <th>SL shrinkage</th>
                <th>Last updated</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              @for (row of psoRows(); track row.symbol) {
                <tr>
                  <td class="mono">{{ row.symbol }}</td>
                  <td class="mono">
                    @if (row.tpShrinkage !== null) {
                      {{ row.tpShrinkage }}
                    } @else {
                      <span class="muted">— (global {{ row.globalTpShrinkage }})</span>
                    }
                  </td>
                  <td class="mono">
                    @if (row.slShrinkage !== null) {
                      {{ row.slShrinkage }}
                    } @else {
                      <span class="muted">— (global {{ row.globalSlShrinkage }})</span>
                    }
                  </td>
                  <td class="mono nowrap">{{ row.lastUpdatedAt | date: 'MMM d, HH:mm' }}</td>
                  <td>
                    <button
                      type="button"
                      class="btn-delete"
                      (click)="psoDeleteSymbol(row.symbol)"
                      [disabled]="psoSymbolBusy(row.symbol)"
                      [title]="'Delete override for ' + row.symbol"
                    >
                      {{ psoSymbolBusy(row.symbol) ? '…' : '✕ Delete' }}
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
          <p class="muted small note-inline">
            Deletions soft-delete the EngineConfig rows (<code>IsDeleted = true</code>) so an
            operator can restore them with a single SQL UPDATE if needed. The engine reloads
            LlmOptions in-place after each clear — no restart.
          </p>
        }
      </section>

      @if (loading()) {
        <div class="note">Loading settings…</div>
      } @else if (entries().length === 0) {
        <div class="note">
          No <code>Llm:</code> or <code>LlmStrategyProposal:</code> rows in EngineConfig yet. Save a
          value below to create the first row — the engine will pick up the new key on its next
          hot-reload tick.
        </div>
      } @else {
        @for (group of groupedEntries(); track group.label) {
          <section class="card">
            <header class="card-head">
              <h3>{{ group.label }}</h3>
              <span class="muted">{{ group.entries.length }} key(s)</span>
            </header>
            <table class="table">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Value</th>
                  <th>Type</th>
                  <th>Hot-reload?</th>
                  <th>Last updated</th>
                </tr>
              </thead>
              <tbody>
                @for (e of group.entries; track e.key) {
                  <tr [class.dirty]="e.isDirty">
                    <td class="mono key">
                      {{ e.key }}
                      @if (e.isSecret) {
                        <span class="secret-badge">SECRET</span>
                      }
                    </td>
                    <td>
                      @if (e.dataType === 'Bool') {
                        <select
                          class="value-input"
                          [(ngModel)]="e.editedValue"
                          (ngModelChange)="markDirty(e)"
                        >
                          <option value="true">true</option>
                          <option value="false">false</option>
                        </select>
                      } @else if (optionsFor(e.key); as opts) {
                        <select
                          class="value-input"
                          [(ngModel)]="e.editedValue"
                          (ngModelChange)="markDirty(e)"
                        >
                          @for (opt of opts; track opt) {
                            <option [value]="opt">{{ opt }}</option>
                          }
                        </select>
                      } @else {
                        <input
                          class="value-input"
                          [type]="e.isSecret ? 'password' : 'text'"
                          [(ngModel)]="e.editedValue"
                          (ngModelChange)="markDirty(e)"
                        />
                      }
                      @if (e.description) {
                        <div class="description">{{ e.description }}</div>
                      }
                    </td>
                    <td class="mono">{{ typeLabel(e.dataType) }}</td>
                    <td>
                      @if (e.isHotReloadable) {
                        <span class="badge hot">hot</span>
                      } @else {
                        <span class="badge cold">restart</span>
                      }
                    </td>
                    <td class="mono nowrap">{{ e.lastUpdatedAt | date: 'MMM d, HH:mm' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        }

        <div class="note info">
          Secrets (anything containing <code>ApiKey</code>, <code>Secret</code>, or
          <code>Token</code>) are masked on read as <code>***SET</code> / <code>***UNSET</code>.
          Saving a row whose value still equals one of those sentinels is a no-op — you have to type
          a real string to overwrite a secret.
        </div>
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .btn-refresh,
      .btn-save,
      .btn-test {
        height: 32px;
        padding: 0 var(--space-3);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        cursor: pointer;
      }
      .btn-test:hover:not(:disabled) {
        background: var(--bg-tertiary);
      }
      .btn-test:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      .btn-save {
        background: #0071e3;
        color: #fff;
        border-color: #0071e3;
      }
      .btn-save:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      /* ── Per-symbol shrinkage card actions ─────────────────────── */
      .card-head-actions {
        display: flex;
        gap: var(--space-2);
        align-items: center;
      }
      .btn-clear-all {
        height: 28px;
        padding: 0 var(--space-3);
        border-radius: var(--radius-sm);
        border: 1px solid #6e2424;
        background: transparent;
        color: #f87171;
        font-size: var(--text-xs);
        cursor: pointer;
      }
      .btn-clear-all:hover:not(:disabled) {
        background: #4d1e1e;
      }
      .btn-clear-all:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .btn-delete {
        height: 24px;
        padding: 0 var(--space-2);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: transparent;
        color: #f87171;
        font-size: var(--text-xs);
        cursor: pointer;
      }
      .btn-delete:hover:not(:disabled) {
        background: #4d1e1e;
        border-color: #6e2424;
      }
      .btn-delete:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .note.error {
        color: #f87171;
      }
      .note-inline {
        padding: var(--space-2) var(--space-5);
        margin: 0;
      }
      /* ── Test result card ─────────────────────────────────────── */
      .test-result .btn-dismiss {
        height: 26px;
        padding: 0 var(--space-2);
        font-size: var(--text-xs);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: transparent;
        color: var(--text-tertiary);
        cursor: pointer;
      }
      .test-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: var(--space-3);
        padding: var(--space-4) var(--space-5);
      }
      .tier {
        padding: var(--space-3) var(--space-4);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .tier.ok {
        border-color: rgba(52, 199, 89, 0.4);
        background: rgba(52, 199, 89, 0.04);
      }
      .tier.fail {
        border-color: rgba(255, 59, 48, 0.4);
        background: rgba(255, 59, 48, 0.04);
      }
      .tier-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .tier-badge {
        padding: 3px 8px;
        border-radius: 3px;
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        letter-spacing: 0.04em;
        text-transform: uppercase;
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .tier-badge.ok {
        background: rgba(52, 199, 89, 0.14);
        color: #34c759;
      }
      .tier-badge.fail {
        background: rgba(255, 59, 48, 0.14);
        color: #ff3b30;
      }
      .small {
        font-size: var(--text-xs);
      }
      .tier-meta {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: var(--space-2);
        margin: 0;
      }
      .tier-meta div {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .tier-meta dt {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .tier-meta dd {
        font-size: var(--text-sm);
        color: var(--text-primary);
        margin: 0;
      }
      .tier-meta dd.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
      }
      .response {
        margin: 0;
        padding: var(--space-2) var(--space-3);
        background: rgba(0, 0, 0, 0.04);
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
        font-style: italic;
        color: var(--text-secondary);
      }
      .error {
        margin: 0;
        padding: var(--space-2) var(--space-3);
        background: rgba(255, 59, 48, 0.08);
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
        color: #ff3b30;
        word-break: break-word;
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .card-head {
        padding: var(--space-3) var(--space-5);
        border-bottom: 1px solid var(--border);
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--space-3);
      }
      .card-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .table {
        width: 100%;
        border-collapse: collapse;
      }
      .table th,
      .table td {
        padding: var(--space-2) var(--space-4);
        font-size: var(--text-sm);
        border-bottom: 1px solid var(--border);
        text-align: left;
        vertical-align: top;
      }
      .table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
      }
      .table td.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
      }
      .table tr.dirty {
        background: rgba(255, 149, 0, 0.06);
      }
      .key {
        max-width: 320px;
        word-break: break-all;
      }
      .secret-badge {
        margin-left: var(--space-2);
        padding: 1px 6px;
        border-radius: 3px;
        background: rgba(255, 59, 48, 0.14);
        color: #ff3b30;
        font-size: 10px;
        font-weight: var(--font-semibold);
        letter-spacing: 0.04em;
      }
      .value-input {
        width: 100%;
        height: 30px;
        padding: 0 var(--space-2);
        font-size: var(--text-sm);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .description {
        margin-top: 4px;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        line-height: 1.4;
      }
      .badge {
        padding: 2px 6px;
        border-radius: 3px;
        font-size: 10px;
        font-weight: var(--font-semibold);
        letter-spacing: 0.04em;
        text-transform: uppercase;
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .badge.hot {
        background: rgba(52, 199, 89, 0.14);
        color: #34c759;
      }
      .badge.cold {
        background: rgba(142, 142, 147, 0.18);
        color: #6e6e73;
      }
      .nowrap {
        white-space: nowrap;
      }
      .note {
        padding: var(--space-4) var(--space-5);
        font-size: var(--text-sm);
        color: var(--text-secondary);
        background: var(--bg-secondary);
        border: 1px dashed var(--border);
        border-radius: var(--radius-md);
      }
      .note.info {
        background: rgba(0, 113, 227, 0.04);
        border-color: rgba(0, 113, 227, 0.2);
      }
    `,
  ],
})
export class LlmSettingsPageComponent implements OnInit {
  private readonly llm = inject(LlmService);
  private readonly notifications = inject(NotificationService);
  private readonly destroyRef = inject(DestroyRef);

  readonly entries = signal<EditableEntry[]>([]);
  readonly loading = signal(true);
  readonly testing = signal(false);
  readonly testResult = signal<TestLlmProviderResult | null>(null);

  // ── Per-symbol shrinkage overrides card ────────────────────────────
  readonly psoRows = signal<PerSymbolShrinkageOverrideDto[]>([]);
  readonly psoLoading = signal(false);
  readonly psoLoadError = signal<string | null>(null);
  readonly psoClearing = signal(false);
  readonly psoBusySymbols = signal<Set<string>>(new Set());
  readonly psoBusy = computed(() => this.psoClearing() || this.psoBusySymbols().size > 0);

  readonly dirtyCount = computed(() => this.entries().filter((e) => e.isDirty).length);

  readonly groupedEntries = computed(() => {
    const buckets = new Map<string, EditableEntry[]>();
    for (const e of this.entries()) {
      const list = buckets.get(e.group) ?? [];
      list.push(e);
      buckets.set(e.group, list);
    }
    // Stable group order — top-level Llm: knobs first, then provider blocks,
    // then the strategy-proposer cluster.
    const order = [
      'Llm (top-level)',
      'Anthropic',
      'OpenAI',
      'Google',
      'DeepSeek',
      'Strategy proposer',
      'Other',
    ];
    return order
      .filter((label) => buckets.has(label))
      .map((label) => ({ label, entries: buckets.get(label)! }));
  });

  ngOnInit(): void {
    this.reload();
    this.psoLoad();
  }

  // ── Per-symbol shrinkage overrides ────────────────────────────────

  psoSymbolBusy(symbol: string): boolean {
    return this.psoBusySymbols().has(symbol);
  }

  psoLoad(): void {
    this.psoLoading.set(true);
    this.psoLoadError.set(null);
    this.llm
      .getPerSymbolShrinkageOverrides()
      .pipe(
        catchError((err) => {
          this.psoLoadError.set(err?.error?.message ?? 'Failed to load per-symbol overrides.');
          return of(null);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        this.psoLoading.set(false);
        if (res === null) {
          this.psoRows.set([]);
          return;
        }
        if (!res.status) {
          this.psoLoadError.set(res.message ?? 'Failed to load per-symbol overrides.');
          this.psoRows.set([]);
          return;
        }
        this.psoRows.set(res.data ?? []);
      });
  }

  psoDeleteSymbol(symbol: string): void {
    if (!confirm(`Delete the per-symbol shrinkage override for ${symbol}?`)) return;
    this.psoMarkBusy(symbol, true);
    this.llm
      .clearPerSymbolShrinkage({ symbols: [symbol] })
      .pipe(
        catchError((err) => {
          this.notifications.error(err?.error?.message ?? `Delete failed for ${symbol}.`);
          return of(null);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        this.psoMarkBusy(symbol, false);
        if (res === null) return;
        if (!res.status) {
          this.notifications.error(res.message ?? `Delete failed for ${symbol}.`);
          return;
        }
        this.notifications.success(`Cleared override for ${symbol}.`);
        this.psoLoad();
      });
  }

  psoClearAll(): void {
    const count = this.psoRows().length;
    if (count === 0) return;
    if (
      !confirm(
        `Soft-delete every active per-symbol shrinkage override (${count} symbol${
          count === 1 ? '' : 's'
        })? They can be restored via SQL.`,
      )
    )
      return;
    this.psoClearing.set(true);
    this.llm
      .clearPerSymbolShrinkage({})
      .pipe(
        catchError((err) => {
          this.notifications.error(err?.error?.message ?? 'Clear-all failed.');
          return of(null);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        this.psoClearing.set(false);
        if (res === null) return;
        if (!res.status) {
          this.notifications.error(res.message ?? 'Clear-all failed.');
          return;
        }
        this.notifications.success(
          `Cleared ${res.data?.symbolsCleared.length ?? 0} symbol(s) (${
            res.data?.rowsDeleted ?? 0
          } rows).`,
        );
        this.psoLoad();
      });
  }

  private psoMarkBusy(symbol: string, busy: boolean): void {
    const next = new Set(this.psoBusySymbols());
    if (busy) next.add(symbol);
    else next.delete(symbol);
    this.psoBusySymbols.set(next);
  }

  reload(): void {
    this.loading.set(true);
    this.llm
      .getSettings()
      .pipe(
        catchError(() => of(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        this.loading.set(false);
        const rows = res?.data ?? [];
        this.entries.set(
          rows.map((r) => ({
            ...r,
            editedValue: r.value,
            isDirty: false,
            group: groupFor(r.key),
          })),
        );
      });
  }

  markDirty(entry: EditableEntry): void {
    // Trigger signal change so dirtyCount() recomputes (mutating in place doesn't).
    entry.isDirty = entry.editedValue !== entry.value;
    this.entries.set([...this.entries()]);
  }

  save(): void {
    const dirty = this.entries().filter((e) => e.isDirty);
    if (dirty.length === 0) return;
    // Two-step: write EngineConfig rows, then hot-reload the live LlmOptions
    // singleton so the new values take effect WITHOUT an engine restart.
    // Every service that captured LlmOptions by reference (SignalShrinkagePolicy,
    // the viability gate's high-conf bypass threshold, etc.) sees the change
    // on its next read. If the reload call itself fails (network blip, etc.)
    // the operator gets a graceful warning — the rows are still written, just
    // not yet live, so a manual reload (or restart) recovers.
    this.llm
      .updateSettings(dirty.map((e) => ({ key: e.key, value: e.editedValue })))
      .pipe(
        switchMap((writeRes) => {
          if (!writeRes?.status) return of({ writeRes, reloadRes: null });
          return this.llm.reloadSettings().pipe(
            catchError(() => of(null)),
            switchMap((reloadRes) => of({ writeRes, reloadRes })),
          );
        }),
        catchError((err) => {
          this.notifications.error?.(`Save failed: ${err?.message ?? err}`);
          return of(null);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((bundle) => {
        if (!bundle) return;
        const { writeRes, reloadRes } = bundle;
        if (writeRes?.status) {
          const wrote = writeRes.data ?? 0;
          if (reloadRes?.status) {
            this.notifications.success?.(
              `Saved ${wrote} setting(s) and reloaded live config — active now.`,
            );
          } else {
            this.notifications.success?.(
              `Saved ${wrote} setting(s). Hot-reload failed — engine restart required to activate.`,
            );
          }
          this.reload();
        } else if (writeRes) {
          this.notifications.error?.(writeRes.message ?? 'Save refused.');
        }
      });
  }

  typeLabel(t: ConfigDataType): string {
    return t.toLowerCase();
  }

  testProviders(): void {
    if (this.testing()) return;
    this.testing.set(true);
    this.testResult.set(null);
    this.llm
      .testProviders()
      .pipe(
        catchError((err) => {
          this.notifications.error?.(`Connectivity test failed: ${err?.message ?? err}`);
          return of(null);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        this.testing.set(false);
        if (res?.status && res.data) {
          this.testResult.set(res.data);
          const tiers = res.data.tiers;
          const allOk = tiers.every((t) => t.ok);
          if (allOk) {
            this.notifications.success?.(
              `Both tiers responded — ${tiers.map((t) => `${t.tier}: ${t.provider} (${t.latencyMs}ms)`).join(', ')}.`,
            );
          } else {
            const failed = tiers
              .filter((t) => !t.ok)
              .map((t) => t.tier)
              .join(' + ');
            this.notifications.error?.(
              `Connectivity probe surfaced failures on ${failed}. See the card below for details.`,
            );
          }
        } else if (res) {
          this.notifications.error?.(res.message ?? 'Test refused.');
        }
      });
  }

  /** Returns the allowed enumeration for a key, or undefined when the key
   *  is free-text. Used by the template to switch input → select for the
   *  small set of constrained-value keys (provider routing, reasoning
   *  effort knobs). Returning a readonly array is fine for `@for`. */
  optionsFor(key: string): readonly string[] | undefined {
    return OPTION_CATALOG[key];
  }
}

function groupFor(key: string): string {
  if (key.startsWith('LlmStrategyProposal:')) return 'Strategy proposer';
  if (key.startsWith('Llm:Anthropic:')) return 'Anthropic';
  if (key.startsWith('Llm:OpenAi:')) return 'OpenAI';
  if (key.startsWith('Llm:Google:')) return 'Google';
  if (key.startsWith('Llm:DeepSeek:')) return 'DeepSeek';
  if (key.startsWith('Llm:')) return 'Llm (top-level)';
  return 'Other';
}
