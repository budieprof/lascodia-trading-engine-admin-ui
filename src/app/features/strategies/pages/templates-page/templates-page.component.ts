import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, finalize, map, of } from 'rxjs';

import { StrategiesService } from '@core/services/strategies.service';
import { AuditTrailService } from '@core/services/audit-trail.service';
import { RiskProfilesService } from '@core/services/risk-profiles.service';
import { NotificationService } from '@core/notifications/notification.service';
import type {
  ApplyStrategyTemplateResult,
  CreateStrategyTemplateRequest,
  RiskProfileDto,
  StrategyTemplateDto,
  StrategyType,
  Timeframe,
} from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';
import { DslBuilderComponent } from '../../components/dsl-builder/dsl-builder.component';
import { DslIssue, validateDslJson } from '../../dsl/dsl-model';
import { failureMessage, failureMessages } from '../../util/api-failure';

const TIMEFRAMES: readonly Timeframe[] = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'] as const;

const TEMPLATE_STRATEGY_TYPES: readonly StrategyType[] = [
  'MovingAverageCrossover',
  'RSIReversion',
  'BreakoutScalper',
  'BollingerBandReversion',
  'MACDDivergence',
  'SessionBreakout',
  'MomentumTrend',
  'CompositeML',
  'StatisticalArbitrage',
  'VwapReversion',
  'CalendarEffect',
  'NewsFade',
  'CarryTrade',
  'WeekendGapFade',
  'RoundNumberFade',
  'WedgeBreakout',
  'CrossAssetLeadLag',
  'OrderFlowImbalance',
  'SubMinuteEvent',
  'RuleBased',
  'LlmProposal',
  'Custom',
];

type SubConfigKey =
  | 'riskOverridesJson'
  | 'sizingConfigJson'
  | 'sessionFilterJson'
  | 'regimeGateJson'
  | 'multiTimeframeGateJson';

/** The editable copy of a template while its edit dialog is open. */
interface TemplateDraft {
  name: string;
  description: string;
  strategyType: string;
  parametersJson: string;
  riskProfileId: number | null;
  riskOverridesJson: string;
  sizingConfigJson: string;
  sessionFilterJson: string;
  regimeGateJson: string;
  multiTimeframeGateJson: string;
}

const SUB_CONFIG_FIELDS: ReadonlyArray<{ key: SubConfigKey; label: string; placeholder: string }> =
  [
    {
      key: 'riskOverridesJson',
      label: 'Risk overrides',
      placeholder: '{"slMode":"Atr","slMultiplier":1.5,"tpMode":"Atr","tpMultiplier":2.5}',
    },
    {
      key: 'sizingConfigJson',
      label: 'Sizing',
      placeholder: '{"mode":"PercentEquity","value":0.01}',
    },
    {
      key: 'sessionFilterJson',
      label: 'Session filter',
      placeholder: '{"sessionStartUtc":"08:00","sessionEndUtc":"17:00"}',
    },
    { key: 'regimeGateJson', label: 'Regime gate', placeholder: '{"allowedRegimes":["Trending"]}' },
    {
      key: 'multiTimeframeGateJson',
      label: 'Multi-timeframe gate',
      placeholder: '{"timeframe":"D1","indicator":"EMA","period":200,"comparator":"PriceAbove"}',
    },
  ];

const DSL_TYPES: readonly string[] = ['RuleBased', 'LlmProposal'];

@Component({
  selector: 'app-templates-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    FormsModule,
    RouterLink,
    PageHeaderComponent,
    MetricCardComponent,
    CardSkeletonComponent,
    ErrorStateComponent,
    EmptyStateComponent,
    ConfirmDialogComponent,
    DslBuilderComponent,
    RelativeTimePipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Strategies — Templates"
        subtitle="Saved strategy templates. Apply across multiple symbols in a single round-trip."
      >
        <a routerLink="/strategies" class="btn btn-secondary">← Strategies</a>
        <button
          type="button"
          class="btn btn-secondary"
          (click)="resource.refresh()"
          [disabled]="resource.loading()"
        >
          Refresh
        </button>
      </app-page-header>

      @if (loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (resource.error()) {
        <app-error-state
          title="Could not load templates"
          message="Engine returned an error fetching the template list."
          (retry)="resource.refresh()"
        />
      } @else {
        <section class="kpis">
          <app-metric-card
            label="Templates"
            [value]="templates().length"
            format="number"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="Total applications"
            [value]="totalApplied()"
            format="number"
            dotColor="#34C759"
          />
          <div class="tile tile--text">
            <span class="tile-label">Most-used template</span>
            <span class="tile-value" [title]="mostUsed()?.name ?? ''">
              @if (mostUsed(); as m) {
                {{ m.name || '#' + m.id }}
                <span class="tile-sub"
                  >{{ m.appliedCount }} application{{ m.appliedCount === 1 ? '' : 's' }}</span
                >
              } @else {
                —
              }
            </span>
          </div>
        </section>

        @if (templates().length === 0) {
          <app-empty-state
            title="No templates saved yet"
            description="Save a strategy as a template from the strategy detail page to start a reusable library."
          />
        } @else {
          <section class="card">
            <table class="templates-table">
              <thead>
                <tr>
                  <th>Template</th>
                  <th>Type</th>
                  <th class="num">Applied</th>
                  <th>Risk profile</th>
                  <th>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                @for (t of templates(); track t.id) {
                  <tr>
                    <td>
                      <div class="tmpl-name">{{ t.name ?? '(unnamed)' }}</div>
                      @if (t.description) {
                        <div class="muted small">{{ t.description }}</div>
                      }
                    </td>
                    <td class="mono small">{{ t.strategyType }}</td>
                    <td class="num mono">{{ t.appliedCount }}</td>
                    <td class="mono small muted">
                      {{ t.riskProfileId === null ? '—' : '#' + t.riskProfileId }}
                    </td>
                    <td class="time" [title]="t.createdAt | date: 'yyyy-MM-dd HH:mm:ss UTC'">
                      {{ t.createdAt | relativeTime }}
                    </td>
                    <td class="row-actions">
                      <button
                        type="button"
                        class="action"
                        (click)="askApply(t)"
                        [disabled]="submitting()"
                      >
                        Apply →
                      </button>
                      <button
                        type="button"
                        class="action action--quiet"
                        (click)="openEdit(t)"
                        [title]="'Edit ' + (t.name ?? 'this template')"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        class="action action--danger"
                        (click)="askDelete(t)"
                        [title]="'Delete ' + (t.name ?? 'this template')"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        }
      }

      @if (pending(); as p) {
        <div class="modal-overlay" (click)="cancel()">
          <div class="modal" (click)="$event.stopPropagation()" role="dialog" aria-modal="true">
            <header class="modal-head">
              <h2>Apply template</h2>
              <button type="button" class="close-btn" (click)="cancel()" aria-label="Close">
                ×
              </button>
            </header>
            <p class="modal-target">
              <strong>{{ p.name ?? '(unnamed)' }}</strong>
              <span class="muted small"> · {{ p.strategyType }}</span>
            </p>
            <p class="modal-desc">
              This will create one Paused Strategy per symbol below, all on the chosen timeframe.
              Duplicates (template already applied to that pair) are skipped.
            </p>

            <label class="field">
              <span>Symbols (comma- or space-separated)</span>
              <textarea
                rows="2"
                [(ngModel)]="symbolsText"
                placeholder="EURUSD, GBPUSD, USDJPY"
              ></textarea>
            </label>

            <div class="row">
              <label class="field grow">
                <span>Timeframe</span>
                <select [(ngModel)]="timeframePick">
                  @for (tf of TIMEFRAMES; track tf) {
                    <option [ngValue]="tf">{{ tf }}</option>
                  }
                </select>
              </label>
              <label class="field grow">
                <span>Name prefix (optional)</span>
                <input type="text" [(ngModel)]="namePrefix" placeholder="e.g. v3-rollout" />
              </label>
            </div>

            @if (lastResult(); as r) {
              <div class="result-banner" [class.has-skipped]="r.skippedCount > 0">
                Created <strong>{{ r.createdCount }}</strong> strategy{{
                  r.createdCount === 1 ? '' : 'ies'
                }}
                @if (r.skippedCount > 0) {
                  , skipped <strong>{{ r.skippedCount }}</strong>
                }
                .
                @if (r.skippedReasons.length > 0) {
                  <ul class="skipped-list">
                    @for (reason of r.skippedReasons; track reason) {
                      <li>{{ reason }}</li>
                    }
                  </ul>
                }
              </div>
            }

            <footer class="modal-foot">
              <button type="button" class="btn btn-secondary" (click)="cancel()">
                {{ lastResult() ? 'Close' : 'Cancel' }}
              </button>
              @if (!lastResult()) {
                <button
                  type="button"
                  class="btn btn-primary"
                  (click)="confirmApply()"
                  [disabled]="!canApply()"
                >
                  {{
                    submitting()
                      ? 'Applying…'
                      : 'Apply to ' +
                        parsedSymbols().length +
                        ' symbol' +
                        (parsedSymbols().length === 1 ? '' : 's')
                  }}
                </button>
              }
            </footer>
          </div>
        </div>
      }

      @if (draft(); as d) {
        <div
          class="modal-overlay"
          role="presentation"
          tabindex="-1"
          (click)="closeEdit()"
          (keydown.escape)="closeEdit()"
        >
          <div
            class="modal modal--wide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="template-edit-title"
            tabindex="-1"
            (click)="$event.stopPropagation()"
            (keydown.escape)="closeEdit()"
            (keydown)="$event.stopPropagation()"
          >
            <header class="modal-head">
              <h2 id="template-edit-title">Edit template</h2>
              <button type="button" class="close-btn" (click)="closeEdit()" aria-label="Close">
                ×
              </button>
            </header>
            <p class="modal-desc muted small">
              Changes apply to strategies created from this template from now on — strategies
              already created from it keep their own copy.
            </p>

            <div class="row">
              <label class="field grow">
                <span>Name *</span>
                <input
                  type="text"
                  maxlength="120"
                  [ngModel]="d.name"
                  (ngModelChange)="patchDraft('name', $event)"
                />
              </label>
              <label class="field grow">
                <span>Strategy type</span>
                <select
                  [ngModel]="d.strategyType"
                  (ngModelChange)="patchDraft('strategyType', $event)"
                >
                  @for (st of strategyTypeOptions(d.strategyType); track st) {
                    <option [value]="st">{{ st }}</option>
                  }
                </select>
              </label>
            </div>
            <label class="field">
              <span>Description</span>
              <textarea
                rows="2"
                [ngModel]="d.description"
                (ngModelChange)="patchDraft('description', $event)"
              ></textarea>
            </label>
            <label class="field">
              <span>Risk profile</span>
              <select
                [ngModel]="d.riskProfileId"
                (ngModelChange)="patchDraft('riskProfileId', $event)"
              >
                <option [ngValue]="null">— None —</option>
                @for (p of riskProfiles(); track p.id) {
                  <option [ngValue]="p.id">{{ p.name ?? '#' + p.id }}</option>
                }
                @if (d.riskProfileId !== null && !hasRiskProfile(d.riskProfileId)) {
                  <option [ngValue]="d.riskProfileId">#{{ d.riskProfileId }}</option>
                }
              </select>
            </label>

            <div class="field">
              <span>{{ draftIsDsl() ? 'Rules (DSL JSON)' : 'Parameters JSON' }}</span>
              @if (draftIsDsl()) {
                <app-dsl-builder
                  [parametersJson]="d.parametersJson"
                  [issues]="draftDslIssues()"
                  (parametersJsonChange)="patchDraft('parametersJson', $event)"
                />
              }
              <textarea
                class="mono"
                rows="8"
                [ngModel]="d.parametersJson"
                (ngModelChange)="patchDraft('parametersJson', $event)"
              ></textarea>
              @if (draftJsonErrors()['parametersJson']; as err) {
                <span class="field-error">Invalid JSON: {{ err }}</span>
              }
              @if (draftDslIssues().length > 0) {
                <ul class="issue-list">
                  @for (i of draftDslIssues(); track $index) {
                    <li [class.warning]="i.severity === 'warning'">
                      {{ i.message }}
                      @if (i.path) {
                        <code>{{ i.path }}</code>
                      }
                    </li>
                  }
                </ul>
              }
            </div>

            <details class="subconfigs" [open]="hasSubConfigs(d)">
              <summary>Risk, sizing, session and gate overrides</summary>
              @for (f of subConfigFields; track f.key) {
                <label class="field">
                  <span>{{ f.label }} JSON</span>
                  <textarea
                    class="mono"
                    rows="3"
                    [placeholder]="f.placeholder"
                    [ngModel]="d[f.key]"
                    (ngModelChange)="patchDraft(f.key, $event)"
                  ></textarea>
                  @if (draftJsonErrors()[f.key]; as err) {
                    <span class="field-error">Invalid JSON: {{ err }}</span>
                  }
                </label>
              }
            </details>

            @if (editErrors().length > 0) {
              <div class="save-errors" role="alert">
                <strong>The engine refused the change:</strong>
                <ul>
                  @for (e of editErrors(); track $index) {
                    <li>{{ e }}</li>
                  }
                </ul>
              </div>
            }

            <footer class="modal-foot">
              <button
                type="button"
                class="btn btn-secondary"
                (click)="closeEdit()"
                [disabled]="editSaving()"
              >
                Cancel
              </button>
              <button
                type="button"
                class="btn btn-primary"
                (click)="saveEdit()"
                [disabled]="!canSaveDraft()"
              >
                {{ editSaving() ? 'Saving…' : 'Save template' }}
              </button>
            </footer>
          </div>
        </div>
      }

      <app-confirm-dialog
        [open]="deleting() !== null"
        title="Delete template"
        [message]="deleteMessage()"
        confirmLabel="Delete"
        confirmVariant="destructive"
        [loading]="deleteBusy()"
        (confirm)="confirmDelete()"
        (cancelled)="cancelDelete()"
      >
        @if (deleteError(); as err) {
          <p class="field-error" role="alert">{{ err }}</p>
        }
      </app-confirm-dialog>
    </div>
  `,
  styles: [
    `
      /* Header actions were \`.btn btn-secondary\` with no matching rule on
         this page, so they rendered as bare text links. */
      .btn {
        height: 36px;
        padding: 0 var(--space-4);
        border-radius: var(--radius-full);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        font-family: inherit;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: var(--space-2);
        text-decoration: none;
        border: none;
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .btn-secondary {
        background: var(--bg-secondary);
        color: var(--text-primary);
        border: 1px solid var(--border);
      }
      .btn-secondary:hover:not(:disabled) {
        background: var(--bg-tertiary);
      }
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .kpis {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: var(--space-3);
        align-items: start;
      }
      .tile--text {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        min-width: 0;
      }
      .tile-label {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
        line-height: 1.3;
        min-height: 2.6em;
      }
      .tile-value {
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        line-height: 1.2;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .tile-sub {
        display: block;
        font-size: var(--text-xs);
        font-weight: var(--font-regular);
        color: var(--text-tertiary);
        margin-top: 2px;
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        box-shadow: var(--shadow-sm);
        overflow-x: auto;
      }
      .templates-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .templates-table th,
      .templates-table td {
        padding: 10px 12px;
        text-align: left;
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }
      .templates-table th {
        color: var(--text-secondary);
        font-weight: var(--font-medium);
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .templates-table td.num,
      .templates-table th.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .tmpl-name {
        font-weight: var(--font-semibold);
      }
      .mono {
        font-family: var(--font-mono);
      }
      .muted {
        color: var(--text-tertiary);
      }
      .small {
        font-size: var(--text-xs);
      }
      .time {
        color: var(--text-secondary);
        font-size: var(--text-xs);
      }
      .action {
        padding: 4px 10px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        cursor: pointer;
        color: var(--accent);
      }
      .action:hover:not(:disabled) {
        background: var(--accent);
        color: #fff;
      }
      .action:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .modal-overlay {
        position: fixed;
        inset: 0;
        background: var(--backdrop-scrim, rgba(0, 0, 0, 0.45));
        display: grid;
        place-items: center;
        z-index: 1000;
      }
      .modal {
        background: var(--bg-primary);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        max-width: 560px;
        width: 90%;
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
        line-height: 1;
      }
      .modal-target {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .modal-target strong {
        color: var(--text-primary);
      }
      .modal-desc {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .field span {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .field textarea,
      .field input,
      .field select {
        padding: 8px 12px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-family: var(--font-sans);
      }
      .row {
        display: flex;
        gap: var(--space-3);
      }
      .grow {
        flex: 1;
      }
      .result-banner {
        font-size: var(--text-sm);
        background: rgba(52, 199, 89, 0.08);
        border: 1px solid rgba(52, 199, 89, 0.3);
        padding: var(--space-3);
        border-radius: var(--radius-sm);
      }
      .result-banner.has-skipped {
        background: rgba(255, 149, 0, 0.08);
        border-color: rgba(255, 149, 0, 0.4);
      }
      .skipped-list {
        margin: var(--space-2) 0 0;
        padding-left: var(--space-4);
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .modal-foot {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-3);
      }
      .btn-primary {
        padding: 8px 18px;
        border-radius: var(--radius-sm);
        background: var(--accent);
        color: #fff;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        border: none;
        cursor: pointer;
      }
      .btn-primary:disabled {
        background: var(--bg-tertiary, #d1d1d6);
        cursor: not-allowed;
      }
      .row-actions {
        display: flex;
        gap: 6px;
        justify-content: flex-end;
        white-space: nowrap;
      }
      .action--quiet {
        color: var(--text-primary);
      }
      .action--quiet:hover:not(:disabled) {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .action--danger {
        color: var(--loss);
      }
      .action--danger:hover:not(:disabled) {
        background: var(--loss);
        color: #fff;
      }
      .modal--wide {
        max-width: 760px;
        max-height: 90vh;
        overflow-y: auto;
      }
      .field textarea.mono {
        font-family: var(--font-mono);
        font-size: var(--text-xs);
      }
      .field-error {
        font-size: var(--text-xs);
        color: var(--loss);
      }
      .issue-list {
        margin: 0;
        padding-left: var(--space-4);
        font-size: var(--text-xs);
        color: var(--loss);
      }
      .issue-list li.warning {
        color: #c93400;
      }
      .issue-list code {
        margin-left: 6px;
        color: var(--text-tertiary);
      }
      .subconfigs {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .subconfigs summary {
        cursor: pointer;
        font-size: var(--text-sm);
        color: var(--text-secondary);
        margin-bottom: var(--space-2);
      }
      .save-errors {
        font-size: var(--text-sm);
        color: #8e1010;
        background: rgba(255, 59, 48, 0.08);
        border: 1px solid rgba(255, 59, 48, 0.3);
        border-radius: var(--radius-sm);
        padding: var(--space-3);
      }
      .save-errors ul {
        margin: var(--space-1) 0 0;
        padding-left: var(--space-4);
      }
    `,
  ],
})
export class TemplatesPageComponent {
  private readonly strategies = inject(StrategiesService);
  private readonly auditTrail = inject(AuditTrailService);
  private readonly riskProfilesService = inject(RiskProfilesService);
  private readonly notifications = inject(NotificationService);

  protected readonly TIMEFRAMES = TIMEFRAMES;
  protected readonly subConfigFields = SUB_CONFIG_FIELDS;

  // Edit dialog -------------------------------------------------------------
  /** Template being edited; the dialog is open while set. */
  protected readonly editing = signal<StrategyTemplateDto | null>(null);
  protected readonly draft = signal<TemplateDraft | null>(null);
  protected readonly editSaving = signal(false);
  /** The engine's reasons for refusing the last save. */
  protected readonly editErrors = signal<string[]>([]);
  protected readonly riskProfiles = signal<RiskProfileDto[]>([]);
  private riskProfilesLoaded = false;

  protected readonly draftIsDsl = computed(() =>
    DSL_TYPES.includes(this.draft()?.strategyType ?? ''),
  );

  /** JSON syntax errors per field — the engine refuses unparseable sub-configs. */
  protected readonly draftJsonErrors = computed<Record<string, string>>(() => {
    const d = this.draft();
    const out: Record<string, string> = {};
    if (!d) return out;
    for (const key of ['parametersJson', ...SUB_CONFIG_FIELDS.map((f) => f.key)] as const) {
      const raw = d[key];
      if (!raw || !raw.trim()) continue;
      try {
        JSON.parse(raw);
      } catch (e) {
        out[key] = (e as Error).message;
      }
    }
    return out;
  });

  /**
   * The console's checks of a RuleBased / LlmProposal template's rules —
   * advisory here: a template has no timeframe of its own, and the engine's
   * answer to the save is what counts.
   */
  protected readonly draftDslIssues = computed<DslIssue[]>(() => {
    const d = this.draft();
    if (!d || !this.draftIsDsl() || !d.parametersJson.trim()) return [];
    if (this.draftJsonErrors()['parametersJson']) return [];
    return validateDslJson(d.parametersJson);
  });

  protected readonly canSaveDraft = computed(() => {
    const d = this.draft();
    return (
      !!d &&
      d.name.trim().length > 0 &&
      Object.keys(this.draftJsonErrors()).length === 0 &&
      !this.editSaving()
    );
  });

  protected openEdit(t: StrategyTemplateDto): void {
    this.editErrors.set([]);
    this.editing.set(t);
    this.draft.set({
      name: t.name ?? '',
      description: t.description ?? '',
      strategyType: t.strategyType,
      parametersJson: t.parametersJson ?? '',
      riskProfileId: t.riskProfileId,
      riskOverridesJson: t.riskOverridesJson ?? '',
      sizingConfigJson: t.sizingConfigJson ?? '',
      sessionFilterJson: t.sessionFilterJson ?? '',
      regimeGateJson: t.regimeGateJson ?? '',
      multiTimeframeGateJson: t.multiTimeframeGateJson ?? '',
    });
    this.loadRiskProfiles();
  }

  protected closeEdit(): void {
    if (this.editSaving()) return;
    this.editing.set(null);
    this.draft.set(null);
    this.editErrors.set([]);
  }

  protected patchDraft<K extends keyof TemplateDraft>(key: K, value: TemplateDraft[K]): void {
    const d = this.draft();
    if (!d) return;
    this.draft.set({ ...d, [key]: value ?? (key === 'riskProfileId' ? null : '') });
  }

  protected strategyTypeOptions(current: string): readonly string[] {
    return TEMPLATE_STRATEGY_TYPES.includes(current as StrategyType)
      ? TEMPLATE_STRATEGY_TYPES
      : [...TEMPLATE_STRATEGY_TYPES, current];
  }

  protected hasRiskProfile(id: number): boolean {
    return this.riskProfiles().some((p) => p.id === id);
  }

  protected hasSubConfigs(d: TemplateDraft): boolean {
    return SUB_CONFIG_FIELDS.some((f) => d[f.key].trim().length > 0);
  }

  private loadRiskProfiles(): void {
    if (this.riskProfilesLoaded) return;
    this.riskProfilesLoaded = true;
    this.riskProfilesService.list({ currentPage: 1, itemCountPerPage: 200 }).subscribe({
      next: (res) => this.riskProfiles.set(res?.data?.data ?? []),
      error: () => {
        this.riskProfilesLoaded = false;
        this.riskProfiles.set([]);
      },
    });
  }

  /** PUT /strategy/templates/{id}; a refusal keeps the dialog open with the engine's reasons. */
  protected saveEdit(): void {
    const t = this.editing();
    const d = this.draft();
    if (!t || !d || !this.canSaveDraft()) return;
    const body: CreateStrategyTemplateRequest = {
      name: d.name.trim(),
      description: d.description.trim() || null,
      strategyType: d.strategyType,
      parametersJson: d.parametersJson.trim() || '{}',
      riskProfileId: d.riskProfileId,
      riskOverridesJson: d.riskOverridesJson.trim() || null,
      sizingConfigJson: d.sizingConfigJson.trim() || null,
      sessionFilterJson: d.sessionFilterJson.trim() || null,
      regimeGateJson: d.regimeGateJson.trim() || null,
      multiTimeframeGateJson: d.multiTimeframeGateJson.trim() || null,
    };
    this.editSaving.set(true);
    this.editErrors.set([]);
    this.strategies.updateTemplate(t.id, body, { silent: true }).subscribe({
      next: (res) => {
        this.editSaving.set(false);
        if (!res?.status) {
          this.editErrors.set(failureMessages(res, 'The engine did not save the template.'));
          return;
        }
        this.notifications.success(`Template '${body.name}' saved`);
        this.recordDecision(t, 'StrategyTemplateUpdated', 'Updated', { name: body.name });
        this.editing.set(null);
        this.draft.set(null);
        this.resource.refresh();
      },
      error: (err) => {
        this.editSaving.set(false);
        this.editErrors.set(failureMessages(err, 'Saving the template failed.'));
      },
    });
  }

  // Delete confirmation ------------------------------------------------------
  protected readonly deleting = signal<StrategyTemplateDto | null>(null);
  protected readonly deleteBusy = signal(false);
  protected readonly deleteError = signal<string | null>(null);
  protected readonly deleteMessage = computed(() => {
    const t = this.deleting();
    if (!t) return '';
    const uses =
      t.appliedCount > 0
        ? ` It has been applied ${t.appliedCount} time${t.appliedCount === 1 ? '' : 's'}; those strategies keep running unchanged.`
        : '';
    return `Delete the template '${t.name ?? '#' + t.id}'? This cannot be undone.${uses}`;
  });

  protected askDelete(t: StrategyTemplateDto): void {
    this.deleteError.set(null);
    this.deleting.set(t);
  }

  protected cancelDelete(): void {
    if (this.deleteBusy()) return;
    this.deleting.set(null);
    this.deleteError.set(null);
  }

  protected confirmDelete(): void {
    const t = this.deleting();
    if (!t || this.deleteBusy()) return;
    this.deleteBusy.set(true);
    this.deleteError.set(null);
    this.strategies.deleteTemplate(t.id, { silent: true }).subscribe({
      next: (res) => {
        this.deleteBusy.set(false);
        if (!res?.status) {
          this.deleteError.set(failureMessage(res, 'The engine did not delete the template.'));
          return;
        }
        this.notifications.success(`Template '${t.name ?? '#' + t.id}' deleted`);
        this.recordDecision(t, 'StrategyTemplateDeleted', 'Deleted', {});
        this.deleting.set(null);
        this.resource.refresh();
      },
      error: (err) => {
        this.deleteBusy.set(false);
        this.deleteError.set(failureMessage(err, 'Deleting the template failed.'));
      },
    });
  }

  private recordDecision(
    t: StrategyTemplateDto,
    decisionType: string,
    outcome: string,
    extra: Record<string, unknown>,
  ): void {
    this.auditTrail
      .create({
        entityType: 'StrategyTemplate',
        entityId: t.id,
        decisionType,
        outcome,
        reason: null,
        contextJson: JSON.stringify({ templateName: t.name, ...extra }),
        source: 'AdminUI',
      })
      .subscribe({ error: () => undefined });
  }

  protected readonly resource = createPolledResource(
    () =>
      this.strategies.listTemplates().pipe(
        map((res) => res.data ?? []),
        catchError(() => of<StrategyTemplateDto[]>([])),
      ),
    {
      // Push-driven: the interval is only a fallback for a missed
      // push or a reconnect gap.
      intervalMs: 120_000,
      refreshOn: [
        'strategyUpdated',
        'strategyActivated',
        'strategyRetired',
        'strategyVariantPromoted',
      ],
    },
  );

  protected readonly templates = computed(() => this.resource.value() ?? []);
  protected readonly loading = computed(
    () => this.resource.loading() && this.templates().length === 0,
  );
  protected readonly totalApplied = computed(() =>
    this.templates().reduce((s, t) => s + t.appliedCount, 0),
  );
  /** The template applied most often — a name, not a count; null until one has been applied. */
  protected readonly mostUsed = computed<StrategyTemplateDto | null>(() => {
    const top = this.templates().reduce<StrategyTemplateDto | null>(
      (m, t) => (t.appliedCount > 0 && (m === null || t.appliedCount > m.appliedCount) ? t : m),
      null,
    );
    return top;
  });

  // Apply modal -----------------------------------------------------------
  protected readonly pending = signal<StrategyTemplateDto | null>(null);
  protected symbolsText = '';
  protected timeframePick: Timeframe = 'H1';
  protected namePrefix = '';
  protected readonly submitting = signal(false);
  protected readonly lastResult = signal<ApplyStrategyTemplateResult | null>(null);

  protected askApply(t: StrategyTemplateDto): void {
    this.symbolsText = '';
    this.namePrefix = '';
    this.timeframePick = 'H1';
    this.lastResult.set(null);
    this.pending.set(t);
  }

  protected cancel(): void {
    if (this.submitting()) return;
    this.pending.set(null);
    this.lastResult.set(null);
  }

  protected parsedSymbols = computed(() => {
    // Use template literal split for both commas and whitespace.
    return this.symbolsText
      .split(/[\s,]+/)
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length > 0);
  });

  protected canApply = (): boolean => {
    if (this.submitting()) return false;
    return this.parsedSymbols().length > 0;
  };

  protected confirmApply(): void {
    const p = this.pending();
    if (!p || !this.canApply()) return;
    const symbols = this.parsedSymbols();
    this.submitting.set(true);
    this.strategies
      .applyTemplate({
        templateId: p.id,
        symbols,
        timeframe: this.timeframePick,
        namePrefix: this.namePrefix.trim() || null,
      })
      .pipe(
        finalize(() => {
          this.submitting.set(false);
          this.resource.refresh();
        }),
      )
      .subscribe({
        next: (res) => {
          if (res.status && res.data) {
            this.lastResult.set(res.data);
            this.auditTrail
              .create({
                entityType: 'StrategyTemplate',
                entityId: p.id,
                decisionType: 'StrategyTemplateApplied',
                outcome: 'Applied',
                reason: null,
                contextJson: JSON.stringify({
                  templateName: p.name,
                  symbols,
                  timeframe: this.timeframePick,
                  result: res.data,
                }),
                source: 'AdminUI',
              })
              .subscribe({ error: () => undefined });
          }
        },
        error: () => undefined,
      });
  }
}
