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
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { ViabilityGatePendingChangesService } from '@features/viability-gates/viability-gates-pending.service';
import type { PendingConfigChange } from '@features/viability-gates/viability-gates.types';

import {
  LlmSettingsSaveService,
  isLlmRiskLoosening,
  readLlmSaveOutcome,
  type LlmSaveOutcome,
} from '../../llm-settings-save';

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
 *   - ClaudeCode.DeepEffort / QuickEffort    → the CLI's --effort levels (ClaudeCodeLlmClient.EffortLevels)
 *
 * Anything not in this map renders as a free-text input.
 */
const CLAUDE_CODE_EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

const OPTION_CATALOG: Record<string, readonly string[]> = {
  'Llm:DeepProvider': ['anthropic', 'openai', 'google', 'deepseek', 'claudecode'],
  'Llm:QuickProvider': ['anthropic', 'openai', 'google', 'deepseek', 'claudecode'],
  'Llm:Anthropic:Effort': ['high', 'medium', 'low', 'off'],
  'Llm:OpenAi:ReasoningEffort': ['high', 'medium', 'low'],
  'Llm:Google:ThinkingLevel': ['high', 'medium', 'minimal'],
  'Llm:DeepSeek:ReasoningEffort': ['high', 'medium', 'low'],
  'Llm:ClaudeCode:DeepEffort': CLAUDE_CODE_EFFORT,
  'Llm:ClaudeCode:QuickEffort': CLAUDE_CODE_EFFORT,
};

/**
 * Keys the engine stores but does not read. Rendering them as a live select
 * invited operators to "tune" a knob that changes nothing; they are shown
 * read-only with an explicit "not consumed" badge instead.
 */
const INERT_KEYS: ReadonlySet<string> = new Set(['Llm:DeepSeek:ReasoningEffort']);

/** Descriptions longer than this are clamped to two lines with a "more" toggle. */
const DESCRIPTION_CLAMP_CHARS = 160;

@Component({
  selector: 'app-llm-settings-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, DatePipe, FormsModule, PageHeaderComponent, ConfirmDialogComponent],
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
        @if (dirtyCount() > 0) {
          <span class="dirty-pill">{{ dirtyCount() }} unsaved</span>
        }
        <button
          type="button"
          class="btn-save"
          [disabled]="dirtyCount() === 0 || saving()"
          (click)="openSaveConfirm()"
        >
          @if (saving()) {
            Saving…
          } @else {
            {{ dirtyCount() > 0 ? 'Save ' + dirtyCount() + ' change(s)' : 'No changes to save' }}
          }
        </button>
      </app-page-header>

      <p class="secrets-hint">
        Secrets (keys containing <code>ApiKey</code>, <code>Secret</code> or <code>Token</code>)
        read back as <code>***SET</code> / <code>***UNSET</code>. Saving a row that still holds one
        of those sentinels is a no-op — type a real value to overwrite a secret. Rows marked
        <span class="badge cold">restart</span> only take effect after an engine restart.
      </p>

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
              (click)="psoConfirm.set({ symbol: null })"
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
          <div class="table-scroll">
            <table class="table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>TP shrinkage</th>
                  <th>SL shrinkage</th>
                  <th>Last updated (UTC)</th>
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
                    <td class="mono nowrap">
                      @if (isNeverUpdated(row.lastUpdatedAt)) {
                        <span class="muted">never</span>
                      } @else {
                        {{ row.lastUpdatedAt | date: 'yyyy-MM-dd HH:mm' : 'UTC' }}
                      }
                    </td>
                    <td>
                      <button
                        type="button"
                        class="btn-delete"
                        (click)="psoConfirm.set({ symbol: row.symbol })"
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
          </div>
          <p class="muted small note-inline">
            Deletions soft-delete the EngineConfig rows (<code>IsDeleted = true</code>) so an
            operator can restore them with a single SQL UPDATE if needed. The engine reloads
            LlmOptions in-place after each clear — no restart.
          </p>
        }
      </section>

      @if (loading()) {
        <div class="note">Loading settings…</div>
      } @else if (loadError(); as err) {
        <!-- A failed read used to fall through to the "no rows yet — save a value to
             create the first row" hint, inviting the operator to recreate live keys. -->
        <div class="note error">
          Could not load the LLM settings: {{ err }}
          <button type="button" class="btn-refresh" (click)="reload()">Retry</button>
        </div>
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
            <div class="table-scroll">
              <!--
                Fixed column widths shared by every section. With auto layout each
                section sized its own key column from its longest key, so short
                sections wrapped "Llm:Enabled" into three fragments while others
                got 300px — the same table rendered four different ways.
              -->
              <table class="table">
                <colgroup>
                  <col class="col-key" />
                  <col class="col-value" />
                  <col class="col-type" />
                  <col class="col-hot" />
                  <col class="col-updated" />
                </colgroup>
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>Value</th>
                    <th>Type</th>
                    <th>Reload</th>
                    <th>Last updated (UTC)</th>
                  </tr>
                </thead>
                <tbody>
                  @for (e of group.entries; track e.key) {
                    <tr [class.dirty]="e.isDirty" [class.inert]="isInert(e.key)">
                      <td class="mono key">
                        <span class="key-text">{{ e.key }}</span>
                        @if (e.isSecret) {
                          <span class="secret-badge">secret</span>
                        }
                        @if (isInert(e.key)) {
                          <span
                            class="inert-badge"
                            title="Stored in EngineConfig but not read by any engine code path"
                          >
                            not consumed
                          </span>
                        }
                      </td>
                      <td>
                        @if (e.dataType === 'Bool') {
                          <select
                            class="value-input"
                            [(ngModel)]="e.editedValue"
                            (ngModelChange)="markDirty(e)"
                            [disabled]="isInert(e.key)"
                          >
                            <option value="true">true</option>
                            <option value="false">false</option>
                          </select>
                        } @else if (optionsFor(e.key); as opts) {
                          <select
                            class="value-input"
                            [(ngModel)]="e.editedValue"
                            (ngModelChange)="markDirty(e)"
                            [disabled]="isInert(e.key)"
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
                            [disabled]="isInert(e.key)"
                          />
                        }
                        <!-- A loosening save held for cooling-off leaves the row on its old
                             value; without this the next visit showed nothing pending. -->
                        @for (p of pendingFor(e.key); track p.id) {
                          <div class="queued-note">
                            <strong>Queued (cooling-off):</strong>
                            {{ p.oldValue ?? '—' }} → {{ p.newValue ?? '—' }} · takes effect
                            {{ p.effectiveAt | date: 'yyyy-MM-dd HH:mm' : 'UTC' }} UTC
                            @if (p.reason) {
                              · “{{ p.reason }}”
                            }
                          </div>
                        }
                        @if (e.description) {
                          <div
                            class="description"
                            [class.clamped]="isLongDescription(e) && !isDescExpanded(e.key)"
                          >
                            {{ e.description }}
                          </div>
                          @if (isLongDescription(e)) {
                            <button type="button" class="desc-toggle" (click)="toggleDesc(e.key)">
                              {{ isDescExpanded(e.key) ? 'less' : 'more' }}
                            </button>
                          }
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
                      <td class="mono nowrap">
                        @if (isNeverUpdated(e.lastUpdatedAt)) {
                          <span class="muted">never</span>
                        } @else {
                          {{ e.lastUpdatedAt | date: 'yyyy-MM-dd HH:mm' : 'UTC' }}
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        }
      }

      <!-- Show exactly what is about to change before it does. Risk-loosening entries go
           through the engine's governed path (2026-10-19): they need a reason and are held
           for the cooling-off period unless break-glass is ticked; everything else is
           written and hot-reloaded at once. -->
      <app-confirm-dialog
        [open]="confirmSave()"
        title="Save LLM settings?"
        [message]="
          hasLoosening()
            ? 'Risk-loosening changes need a reason and are held for the cooling-off period unless applied now (break-glass). The other changes are written to EngineConfig and hot-reloaded immediately:'
            : 'These ' +
              pendingChanges().length +
              ' value(s) are written to EngineConfig and hot-reloaded immediately:'
        "
        [confirmLabel]="
          hasLoosening() && !breakGlass() ? 'Save (hold loosening)' : 'Save and apply'
        "
        [loading]="saving()"
        (confirm)="save()"
        (cancelled)="closeSaveConfirm()"
      >
        <ul class="change-list">
          @for (c of pendingChanges(); track c.key) {
            <li>
              <code>{{ c.key }}</code>
              <span class="change-values">{{ c.from }} → {{ c.to }}</span>
              @if (c.loosening) {
                <span class="loosening">
                  Risk-loosening —
                  {{
                    breakGlass()
                      ? 'applied now (break-glass, flagged in the audit log)'
                      : 'held for the cooling-off period'
                  }}
                </span>
              }
            </li>
          }
        </ul>
        <div class="save-governance">
          <label class="reason-label" for="llm-save-reason">
            Reason
            <span class="muted">
              {{
                hasLoosening()
                  ? '(required — recorded on every audit row)'
                  : '(optional — recorded on every audit row)'
              }}
            </span>
          </label>
          <textarea
            id="llm-save-reason"
            class="reason-input"
            rows="2"
            maxlength="1000"
            [required]="hasLoosening()"
            [attr.aria-invalid]="reasonMissing() ? 'true' : null"
            [disabled]="saving()"
            [ngModel]="saveReason()"
            (ngModelChange)="saveReason.set($event)"
          ></textarea>
          @if (hasLoosening()) {
            <label class="break-glass">
              <input
                type="checkbox"
                [disabled]="saving()"
                [ngModel]="breakGlass()"
                (ngModelChange)="breakGlass.set($event)"
              />
              Apply the loosening now (break-glass) — skips the cooling-off period
            </label>
          }
          @if (saveError(); as err) {
            <p class="save-error" role="alert">{{ err }}</p>
          }
        </div>
      </app-confirm-dialog>

      <app-confirm-dialog
        [open]="psoConfirm() !== null"
        [title]="
          psoConfirm()?.symbol
            ? 'Delete the ' + psoConfirm()?.symbol + ' override?'
            : 'Clear every per-symbol override?'
        "
        [message]="
          psoConfirm()?.symbol
            ? psoConfirm()?.symbol +
              ' falls back to the global TP / SL shrinkage on its next signal.'
            : 'Soft-deletes all ' +
              psoRows().length +
              ' active override(s); every symbol falls back to the global TP / SL shrinkage. They can be restored via SQL.'
        "
        [confirmLabel]="psoConfirm()?.symbol ? 'Delete' : 'Clear all'"
        confirmVariant="destructive"
        [loading]="psoBusy()"
        (confirm)="confirmPso()"
        (cancelled)="psoConfirm.set(null)"
      />
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
      .change-list {
        margin: var(--space-3) 0 0;
        padding: 0;
        list-style: none;
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        max-height: 40vh;
        overflow-y: auto;
        font-size: var(--text-sm);
      }
      .change-list code {
        font-size: var(--text-xs);
        word-break: break-all;
      }
      .change-values {
        display: block;
        color: var(--text-primary);
        font-family: ui-monospace, SFMono-Regular, monospace;
        font-size: var(--text-xs);
        word-break: break-all;
      }
      .loosening {
        display: block;
        color: var(--warning);
        font-size: var(--text-xs);
      }
      .save-governance {
        margin-top: var(--space-3);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        font-size: var(--text-sm);
      }
      .reason-label {
        font-weight: var(--font-medium);
        color: var(--text-primary);
      }
      .reason-input {
        width: 100%;
        box-sizing: border-box;
        resize: vertical;
        padding: var(--space-2);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font: inherit;
        font-size: var(--text-sm);
      }
      .reason-input[aria-invalid='true'] {
        border-color: var(--loss);
      }
      .break-glass {
        display: inline-flex;
        align-items: center;
        gap: var(--space-2);
        color: var(--warning);
        cursor: pointer;
      }
      .save-error {
        margin: 0;
        color: var(--loss);
        font-size: var(--text-xs);
      }
      .queued-note {
        margin-top: 4px;
        color: var(--warning);
        font-size: var(--text-xs);
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
      .dirty-pill {
        padding: 3px 10px;
        border-radius: var(--radius-full);
        background: rgba(255, 149, 0, 0.16);
        color: #b25000;
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        white-space: nowrap;
      }
      .secrets-hint {
        margin: 0;
        padding: var(--space-2) var(--space-4);
        border-radius: var(--radius-sm);
        background: rgba(0, 113, 227, 0.05);
        border: 1px solid rgba(0, 113, 227, 0.18);
        color: var(--text-secondary);
        font-size: var(--text-xs);
        line-height: 1.5;
      }
      .secrets-hint code {
        font-family: 'SF Mono', 'Fira Code', monospace;
        color: var(--text-primary);
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
      .table-scroll {
        overflow-x: auto;
      }
      .table {
        width: 100%;
        border-collapse: collapse;
        /* Fixed layout + <colgroup> so every section renders identical column
           widths regardless of its longest key. */
        table-layout: fixed;
        min-width: 860px;
      }
      .col-key {
        width: 30%;
      }
      .col-type {
        width: 80px;
      }
      .col-hot {
        width: 84px;
      }
      .col-updated {
        width: 150px;
      }
      .table th,
      .table td {
        padding: var(--space-2) var(--space-4);
        font-size: var(--text-sm);
        border-bottom: 1px solid var(--border);
        text-align: left;
        vertical-align: top;
      }
      .table tr.inert .value-input {
        opacity: 0.55;
      }
      .key-text {
        overflow-wrap: anywhere;
      }
      .inert-badge {
        margin-left: var(--space-2);
        padding: 1px 6px;
        border-radius: 3px;
        background: rgba(142, 142, 147, 0.18);
        color: var(--text-secondary);
        font-size: 10px;
        font-weight: var(--font-semibold);
        letter-spacing: 0.04em;
        text-transform: uppercase;
        white-space: nowrap;
      }
      .description.clamped {
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .desc-toggle {
        margin-top: 2px;
        padding: 0;
        border: none;
        background: none;
        color: var(--accent);
        font-size: var(--text-xs);
        cursor: pointer;
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
        overflow-wrap: anywhere;
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
        text-transform: uppercase;
        white-space: nowrap;
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
  private readonly saver = inject(LlmSettingsSaveService);
  private readonly pendingSvc = inject(ViabilityGatePendingChangesService);
  private readonly notifications = inject(NotificationService);
  private readonly destroyRef = inject(DestroyRef);

  readonly entries = signal<EditableEntry[]>([]);
  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly saving = signal(false);
  readonly confirmSave = signal(false);

  // ── Governed save (reason / break-glass) ────────────────────────────
  readonly saveReason = signal('');
  readonly breakGlass = signal(false);
  /** Why the last attempt in the open dialog did not go through (engine refusal or missing reason). */
  readonly saveError = signal<string | null>(null);
  /**
   * The engine refused for want of a reason although the local mirror flagged nothing — it
   * classifies more than this page knows. From then on the dialog treats the save as loosening.
   */
  private readonly reasonDemanded = signal(false);
  /** Cooling-off queue entries for the keys on this page (empty when none or unreadable). */
  private readonly pendingQueue = signal<PendingConfigChange[]>([]);
  /** Per-symbol override delete awaiting confirmation; `symbol: null` = clear all. */
  readonly psoConfirm = signal<{ symbol: string | null } | null>(null);
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

  /** The rows Save would write, as the confirm dialog lists them (secrets never echoed). */
  readonly pendingChanges = computed(() =>
    this.entries()
      .filter((e) => e.isDirty)
      .map((e) => ({
        key: e.key,
        from: e.isSecret ? '(secret)' : e.value === '' ? '(empty)' : e.value,
        to: e.isSecret ? '(new secret)' : e.editedValue === '' ? '(empty)' : e.editedValue,
        loosening: !e.isSecret && isLlmRiskLoosening(e.key, e.value, e.editedValue),
      })),
  );

  /** The save carries a risk-loosening change: a reason is required and it is held unless break-glass. */
  readonly hasLoosening = computed(
    () => this.reasonDemanded() || this.pendingChanges().some((c) => c.loosening),
  );
  readonly reasonMissing = computed(
    () => this.saveError() !== null && this.hasLoosening() && !this.saveReason().trim(),
  );

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
      'Claude Code',
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

  /** Run the delete the operator just confirmed in the dialog. */
  confirmPso(): void {
    const target = this.psoConfirm();
    if (!target) return;
    if (target.symbol) this.psoDeleteSymbol(target.symbol);
    else this.psoClearAll();
  }

  psoDeleteSymbol(symbol: string): void {
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
        this.psoConfirm.set(null);
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
    if (this.psoRows().length === 0) return;
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
        this.psoConfirm.set(null);
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
    this.loadError.set(null);
    this.reloadPendingQueue();
    this.llm
      .getSettings()
      .pipe(
        catchError((err) => {
          this.loadError.set(err?.error?.message ?? err?.message ?? 'Request failed.');
          return of(null);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        this.loading.set(false);
        if (res && !res.status) {
          this.loadError.set(res.message ?? 'The engine refused the settings query.');
          return;
        }
        if (!res) return;
        const rows = res.data ?? [];
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

  openSaveConfirm(): void {
    this.saveReason.set('');
    this.breakGlass.set(false);
    this.saveError.set(null);
    this.reasonDemanded.set(false);
    this.confirmSave.set(true);
  }

  closeSaveConfirm(): void {
    if (this.saving()) return;
    this.confirmSave.set(false);
  }

  save(): void {
    const dirty = this.entries().filter((e) => e.isDirty);
    if (dirty.length === 0 || this.saving()) return;
    const reason = this.saveReason().trim();
    const loosening = this.hasLoosening();
    if (loosening && !reason) {
      this.saveError.set(
        'A reason is required: this save loosens a risk-sensitive setting, and the engine refuses it without one.',
      );
      return;
    }
    this.saveError.set(null);
    this.saving.set(true);
    // Two-step: write EngineConfig rows, then hot-reload the live LlmOptions
    // singleton so the new values take effect WITHOUT an engine restart.
    // Every service that captured LlmOptions by reference (SignalShrinkagePolicy,
    // the viability gate's high-conf bypass threshold, etc.) sees the change
    // on its next read. If the reload call itself fails (network blip, etc.)
    // the operator gets a graceful warning — the rows are still written, just
    // not yet live, so a manual reload (or restart) recovers. Nothing to
    // hot-reload when the engine applied nothing (refused, or all held).
    this.saver
      .save({
        entries: dirty.map((e) => ({ key: e.key, value: e.editedValue })),
        reason: reason || undefined,
        immediate: loosening && this.breakGlass() ? true : undefined,
      })
      .pipe(
        switchMap((writeRes) => {
          const outcome = readLlmSaveOutcome(writeRes);
          if (outcome.applied === 0) return of({ outcome, reloadRes: null });
          return this.llm.reloadSettings().pipe(
            catchError(() => of(null)),
            switchMap((reloadRes) => of({ outcome, reloadRes })),
          );
        }),
        catchError((err) => {
          // A transport failure: the engine may or may not have written. Say so, and re-read.
          const detail =
            err?.error?.message ??
            (err?.status === 0 ? 'the engine could not be reached' : (err?.message ?? err));
          this.saving.set(false);
          this.saveError.set(`Save failed: ${detail}. Reload to see what the engine has.`);
          return of(null);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((bundle) => {
        this.saving.set(false);
        if (!bundle) return;
        this.reportSave(bundle.outcome, bundle.reloadRes?.status === true);
      });
  }

  /** Say what the engine did — applied, held for cooling-off, refused — never "Saved" for all three. */
  private reportSave(o: LlmSaveOutcome, reloaded: boolean): void {
    // Refused outright: nothing was written. Keep the dialog (and the operator's edits) open.
    if (!o.ok && o.applied === 0 && o.failed === 0) {
      if (o.needsReason) this.reasonDemanded.set(true);
      this.saveError.set(o.message);
      return;
    }
    this.confirmSave.set(false);
    const parts: string[] = [];
    if (o.applied > 0) {
      parts.push(
        reloaded
          ? `Applied ${o.applied} setting(s) — live now.`
          : `Applied ${o.applied} setting(s); hot-reload failed — an engine restart activates them.`,
      );
    }
    if (o.held > 0) {
      parts.push(
        `${o.held} risk-loosening change(s) held for the cooling-off period — not live yet (see the row).`,
      );
    }
    if (o.failed > 0) parts.push(`${o.failed} risk-loosening change(s) failed: ${o.message}`);
    if (parts.length === 0) parts.push(o.message);
    const text = parts.join(' ');
    if (o.failed > 0) this.notifications.error(text);
    else if (o.held > 0 || !reloaded) this.notifications.warning(text);
    else this.notifications.success(text);
    this.reload();
  }

  private reloadPendingQueue(): void {
    this.pendingSvc
      .listPending()
      .pipe(
        catchError(() => of([] as PendingConfigChange[])),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((rows) =>
        this.pendingQueue.set(
          (rows ?? []).filter((p) => {
            const k = p.key?.toLowerCase() ?? '';
            return k.startsWith('llm:') || k.startsWith('llmstrategyproposal:');
          }),
        ),
      );
  }

  /** Queued (cooling-off) changes for one key. */
  pendingFor(key: string): PendingConfigChange[] {
    const k = key.toLowerCase();
    return this.pendingQueue().filter((p) => p.key?.toLowerCase() === k);
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
          // HttpClient's message ("Http failure response for …: 0 Unknown Error") names
          // a URL, not the problem; status 0 means the request never reached the engine.
          const detail =
            err?.error?.message ??
            (err?.status === 0 ? 'the engine could not be reached' : (err?.message ?? err));
          this.notifications.error?.(`Connectivity test failed: ${detail}`);
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

  isInert(key: string): boolean {
    return INERT_KEYS.has(key);
  }

  /**
   * Rows the engine seeded but nobody has ever saved carry the epoch
   * sentinel (0001-01-01 / 1970-01-01) as their timestamp. Rendering that
   * as "Jan 1, 00:00" reads like a real edit; show "never" instead.
   */
  isNeverUpdated(iso: string | null | undefined): boolean {
    if (!iso) return true;
    const t = new Date(iso).getTime();
    return !Number.isFinite(t) || t <= 0 || new Date(iso).getUTCFullYear() < 2000;
  }

  // ── Description clamp ────────────────────────────────────────────────
  private readonly expandedDescriptions = signal<ReadonlySet<string>>(new Set());

  isLongDescription(e: EditableEntry): boolean {
    return (e.description?.length ?? 0) > DESCRIPTION_CLAMP_CHARS;
  }

  isDescExpanded(key: string): boolean {
    return this.expandedDescriptions().has(key);
  }

  toggleDesc(key: string): void {
    const next = new Set(this.expandedDescriptions());
    if (!next.delete(key)) next.add(key);
    this.expandedDescriptions.set(next);
  }
}

function groupFor(key: string): string {
  if (key.startsWith('LlmStrategyProposal:')) return 'Strategy proposer';
  if (key.startsWith('Llm:Anthropic:')) return 'Anthropic';
  if (key.startsWith('Llm:OpenAi:')) return 'OpenAI';
  if (key.startsWith('Llm:Google:')) return 'Google';
  if (key.startsWith('Llm:DeepSeek:')) return 'DeepSeek';
  if (key.startsWith('Llm:ClaudeCode:')) return 'Claude Code';
  if (key.startsWith('Llm:')) return 'Llm (top-level)';
  return 'Other';
}
