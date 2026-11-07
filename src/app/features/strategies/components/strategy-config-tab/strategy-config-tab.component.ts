import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import type { StrategyDto } from '@core/api/api.types';
import { StatusBadgeComponent } from '@shared/components/status-badge/status-badge.component';
import { EnumLabelPipe } from '@shared/pipes/enum-label.pipe';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';
import { StrategyScriptCardComponent } from '@features/scripting/components/strategy-script-card/strategy-script-card.component';
import { FirstStrategyChecklistComponent } from '@features/scripting/onboarding/first-strategy-checklist.component';
import type { ChecklistAction } from '@features/scripting/onboarding/first-strategy-checklist';

/** Tabs the Config tab's KPI cards open. */
export type ConfigTabTarget = 'signals' | 'orders' | 'optimization' | 'backtests' | 'walkforward';

/**
 * U13 (fu-ui) — strategy-detail's Config tab, moved out of the page unchanged: first-strategy checklist (script), KPI
 * strip (the run-count cards open their tabs), strategy details, parameters, the Pine script card and the recent
 * signals / orders mini-feeds. Presentational: the page keeps loading the counts and recent rows (other tabs read
 * them too) and handles the actions this emits.
 */
@Component({
  selector: 'app-strategy-config-tab',
  standalone: true,
  imports: [
    StatusBadgeComponent,
    EnumLabelPipe,
    RelativeTimePipe,
    StrategyScriptCardComponent,
    FirstStrategyChecklistComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="detail-layout">
      <!-- PE-I9: a new script strategy's path to a demo account (hides itself when done). -->
      @if (isScript()) {
        <app-first-strategy-checklist
          [strategy]="strategy()"
          [backtests]="totalBacktests()"
          [canOperate]="canOperate()"
          [canStartPaper]="canStartPaper()"
          (actionRequested)="checklistAction.emit($event)"
        />
      }
      <!-- 8-card KPI strip — quick scan of life-to-date activity.
           The run-count cards double as nav shortcuts to the
           matching tabs further down. -->
      <div class="cfg-kpis">
        <button class="cfg-kpi clickable" (click)="openTab.emit('signals')">
          <span class="cfg-kpi-label">Signals</span>
          <span class="cfg-kpi-value">{{ totalSignals() ?? '—' }}</span>
        </button>
        <button class="cfg-kpi clickable" (click)="openTab.emit('orders')">
          <span class="cfg-kpi-label">Orders</span>
          <span class="cfg-kpi-value">{{ totalOrders() ?? '—' }}</span>
        </button>
        <button class="cfg-kpi clickable" (click)="openTab.emit('optimization')">
          <span class="cfg-kpi-label">Optim. runs</span>
          <span class="cfg-kpi-value">{{ totalOptimizations() ?? '—' }}</span>
        </button>
        <button class="cfg-kpi clickable" (click)="openTab.emit('backtests')">
          <span class="cfg-kpi-label">Backtests</span>
          <span class="cfg-kpi-value">{{ totalBacktests() ?? '—' }}</span>
        </button>
        <button class="cfg-kpi clickable" (click)="openTab.emit('walkforward')">
          <span class="cfg-kpi-label">Walk-fwd runs</span>
          <span class="cfg-kpi-value">{{ totalWalkForwards() ?? '—' }}</span>
        </button>
        <div class="cfg-kpi">
          <span class="cfg-kpi-label">Days alive</span>
          <span class="cfg-kpi-value">{{ daysAlive() }}</span>
        </div>
        <div class="cfg-kpi">
          <span class="cfg-kpi-label">Status</span>
          <span class="cfg-kpi-value">
            <app-status-badge [status]="strategy().status" type="strategy" />
          </span>
        </div>
        <div class="cfg-kpi">
          <span class="cfg-kpi-label">Risk profile</span>
          <span class="cfg-kpi-value">
            {{ strategy().riskProfileId ? '#' + strategy().riskProfileId : 'None' }}
          </span>
        </div>
      </div>

      <!-- Strategy details + Parameters side-by-side -->
      <div class="cfg-2col">
        <div class="detail-card">
          <h3 class="card-title">Strategy Details</h3>
          <div class="detail-grid">
            <div class="detail-item">
              <span class="detail-label">Name</span>
              <span class="detail-value">{{ strategy().name }}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">Symbol</span>
              <span class="detail-value">{{ strategy().symbol || '—' }}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">Timeframe</span>
              <span class="detail-value">{{
                strategy().timeframe | enumLabel: 'timeframe'
              }}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">Type</span>
              <span class="detail-value">{{ typeLabel(strategy().strategyType) }}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">Status</span>
              <span class="detail-value"
                ><app-status-badge [status]="strategy().status" type="strategy"
              /></span>
            </div>
            <div class="detail-item">
              <span class="detail-label">Risk Profile</span>
              <span class="detail-value">{{
                strategy().riskProfileId ? '#' + strategy().riskProfileId : 'None'
              }}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">Created</span>
              <span class="detail-value">{{ strategy().createdAt | relativeTime }}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">Strategy ID</span>
              <span class="detail-value mono">#{{ strategy().id }}</span>
            </div>
          </div>
        </div>

        @if (strategy().parametersJson) {
          <div class="detail-card">
            <h3 class="card-title">
              Parameters
              <span class="muted small">
                {{ parameterEntries().length }} set
                @if (nullParameterCount() > 0) {
                  · {{ nullParameterCount() }} unset hidden
                }
              </span>
            </h3>
            @if (parameterEntries().length > 0) {
              <dl class="param-grid">
                @for (kv of parameterEntries(); track kv.key) {
                  <div class="param-item">
                    <dt [title]="kv.key">{{ kv.key }}</dt>
                    <dd class="mono" [title]="kv.value">{{ kv.value }}</dd>
                  </div>
                }
              </dl>
            } @else {
              <p class="muted">
                Every parameter is unset — the strategy runs on code defaults.
              </p>
            }
            <details class="json-fold">
              <summary>View raw JSON</summary>
              <pre class="code-block">{{ formatJson(strategy().parametersJson!) }}</pre>
            </details>
          </div>
        } @else {
          <div class="detail-card">
            <h3 class="card-title">Parameters</h3>
            <p class="muted">No tunable parameters defined.</p>
          </div>
        }
      </div>

      <!-- Pine script: a script strategy's source, declaration and saved inputs,
           read-only; Edit opens the form in script mode, the policy / bindings chips
           open the Execution tab where they are changed. -->
      @if (isScript()) {
        <app-strategy-script-card
          [strategy]="strategy()"
          (editRequested)="editRequested.emit()"
          (executionRequested)="executionRequested.emit()"
        />
      }

      <!-- Recent signals + Recent orders mini-feed -->
      <div class="cfg-2col">
        <div class="detail-card">
          <h3 class="card-title">Recent signals</h3>
          @if (recentSignals().length > 0) {
            <table class="mini-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Dir</th>
                  <th class="num">Entry</th>
                  <th class="num">Conf %</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                @for (s of recentSignals(); track s.id) {
                  <tr>
                    <td class="mono">{{ s.generatedAt | relativeTime }}</td>
                    <td
                      class="mono"
                      [class.profit]="String(s.direction) === 'Buy'"
                      [class.loss]="String(s.direction) === 'Sell'"
                    >
                      {{ s.direction }}
                    </td>
                    <td class="num mono">{{ s.entryPrice.toFixed(5) }}</td>
                    <td class="num mono">
                      {{ (s.confidence * 100).toFixed(0) }}
                    </td>
                    <td>{{ s.status }}</td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <p class="muted">No signals generated yet.</p>
          }
        </div>

        <div class="detail-card">
          <h3 class="card-title">Recent orders</h3>
          @if (recentOrders().length > 0) {
            <table class="mini-table">
              <thead>
                <tr>
                  <th>Created</th>
                  <th>Type</th>
                  <th class="num">Qty</th>
                  <th class="num">Price</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                @for (o of recentOrders(); track o.id) {
                  <tr>
                    <td class="mono">{{ o.createdAt | relativeTime }}</td>
                    <td class="mono">{{ o.orderType }}</td>
                    <td class="num mono">{{ o.quantity.toFixed(2) }}</td>
                    <td class="num mono">{{ o.price.toFixed(5) }}</td>
                    <td>{{ o.status }}</td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <p class="muted">No orders placed yet.</p>
          }
        </div>
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .card-title .muted {
        margin-left: var(--space-2);
        font-weight: var(--font-regular);
      }
      .param-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(min(180px, 100%), 1fr));
        gap: var(--space-3) var(--space-4);
        margin: 0;
      }
      .param-item {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .param-item dt {
        font-size: 11px;
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .param-item dd {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .json-fold {
        margin-top: var(--space-4);
      }
      .json-fold summary {
        cursor: pointer;
        font-size: var(--text-xs);
        color: var(--accent);
      }
      .json-fold .code-block {
        margin-top: var(--space-2);
        max-height: 420px;
        overflow: auto;
      }
      .detail-layout {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }

      .detail-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
      }

      .card-title {
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        margin: 0 0 var(--space-4);
      }

      .detail-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(min(200px, 100%), 1fr));
        gap: var(--space-4);
      }

      .detail-item {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }

      .detail-label {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        font-weight: var(--font-medium);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .detail-value {
        font-size: var(--text-sm);
        color: var(--text-primary);
        font-weight: var(--font-medium);
      }

      .code-block {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: var(--space-4);
        font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
        font-size: 12px;
        color: var(--text-primary);
        overflow-x: auto;
        line-height: 1.6;
        margin: 0;
        white-space: pre-wrap;
        word-wrap: break-word;
      }

      /* Config-tab density additions */
      .cfg-kpis {
        display: grid;
        grid-template-columns: repeat(6, 1fr);
        gap: var(--space-2);
      }
      @media (max-width: 1100px) {
        .cfg-kpis {
          grid-template-columns: repeat(3, 1fr);
        }
      }
      @media (max-width: 600px) {
        .cfg-kpis {
          grid-template-columns: repeat(2, 1fr);
        }
      }
      .cfg-kpi {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-height: 64px;
        text-align: left;
        font-family: inherit;
      }
      .cfg-kpi.clickable {
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .cfg-kpi.clickable:hover {
        border-color: var(--accent);
        transform: translateY(-1px);
        box-shadow: var(--shadow-sm);
      }
      .cfg-kpi.clickable:active {
        transform: translateY(0);
      }
      .cfg-kpi-label {
        font-size: 10px;
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .cfg-kpi-value {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }

      .cfg-2col {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-4);
      }
      @media (max-width: 1100px) {
        .cfg-2col {
          grid-template-columns: 1fr;
        }
      }

      .mini-table {
        width: 100%;
        border-collapse: collapse;
      }
      .mini-table th,
      .mini-table td {
        padding: 6px var(--space-2);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .mini-table tbody tr:last-child td {
        border-bottom: none;
      }
      .mini-table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 10px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .mini-table th.num,
      .mini-table td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .mini-table .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .mini-table .profit {
        color: var(--profit);
      }
      .mini-table .loss {
        color: var(--loss);
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
        margin: 0;
      }
      .detail-value.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }

    `,
  ],
})
export class StrategyConfigTabComponent {
  readonly strategy = input.required<StrategyDto>();
  readonly isScript = input(false);
  readonly totalSignals = input<number | null>(null);
  readonly totalOrders = input<number | null>(null);
  readonly totalOptimizations = input<number | null>(null);
  readonly totalBacktests = input<number | null>(null);
  readonly totalWalkForwards = input<number | null>(null);
  readonly recentSignals = input<any[]>([]);
  readonly recentOrders = input<any[]>([]);
  readonly canOperate = input(false);
  readonly canStartPaper = input(false);

  /** A KPI card was clicked: open that tab. */
  readonly openTab = output<ConfigTabTarget>();
  readonly checklistAction = output<ChecklistAction>();
  readonly editRequested = output<void>();
  readonly executionRequested = output<void>();

  private readonly enumLabel = new EnumLabelPipe();

  // Exposed for template `[class.profit]="String(...)"` checks.
  readonly String = String;

  // Derived: how many days the strategy has existed.
  readonly daysAlive = computed(() => {
    const s = this.strategy();
    if (!s?.createdAt) return 0;
    const created = new Date(s.createdAt).getTime();
    return Math.max(0, Math.floor((Date.now() - created) / (1000 * 60 * 60 * 24)));
  });

  formatJson(json: string): string {
    try {
      return JSON.stringify(JSON.parse(json), null, 2);
    } catch {
      return json;
    }
  }

  /** Enum label with the acronym cases the generic pipe title-cases wrongly. */
  typeLabel(type: string | null | undefined): string {
    if (!type) return '—';
    if (type === 'LlmProposal') return 'LLM Proposal';
    return this.enumLabel.transform(type);
  }

  /**
   * Set (non-null) parameters as key/value pairs. The raw JSON for a
   * generated strategy carries ~60 keys of which most are null — rendering
   * it verbatim made the card ~2,800px tall and pushed everything below it.
   */
  readonly parameterEntries = computed<{ key: string; value: string }[]>(() => {
    const parsed = this.parsedParameters();
    if (!parsed) return [];
    return Object.entries(parsed)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([key, v]) => ({
        key,
        value: typeof v === 'object' ? JSON.stringify(v) : String(v),
      }));
  });

  readonly nullParameterCount = computed(() => {
    const parsed = this.parsedParameters();
    if (!parsed) return 0;
    return Object.values(parsed).filter((v) => v === null || v === undefined || v === '').length;
  });

  private readonly parsedParameters = computed<Record<string, unknown> | null>(() => {
    const json = this.strategy()?.parametersJson;
    if (!json) return null;
    try {
      const parsed = JSON.parse(json);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  });
}
