import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { firstValueFrom } from 'rxjs';

import type {
  ScriptDiagnostic,
  ScriptInputValues,
  ScriptKind,
  ScriptRunResult,
} from '@core/api/scripting.types';
import { ScriptingService, toScriptingError } from '@core/services/scripting.service';
import { SCRIPTING_UI_STYLES } from '../scripting-ui.styles';

const BAR_CHOICES = [500, 1000, 2000, 5000, 10000] as const;

/**
 * "Preview": runs the script over recent history through `POST scripting/run` and summarises
 * what came back — compile and runtime errors (click to jump to the line), the Strategy Tester's
 * headline numbers and the log count.
 *
 * The chart itself is the chart-overlay stream's: it receives every result through `result`,
 * and renders into the `[scriptChartOverlay]` slot projected here.
 */
@Component({
  selector: 'app-script-preview',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe],
  template: `
    <div class="preview">
      <div class="controls">
        <label class="ctl">
          <span class="muted small">Bars</span>
          <select
            class="field-input"
            [value]="bars()"
            (change)="bars.set(+$any($event.target).value)"
          >
            @for (b of barChoices; track b) {
              <option [value]="b" [selected]="b === bars()">{{ b | number }}</option>
            }
          </select>
        </label>
        <span class="muted small target">{{ symbol() || '—' }} · {{ timeframe() || '—' }}</span>
        <span class="spacer"></span>
        <button
          type="button"
          class="btn btn-primary btn-sm"
          (click)="run()"
          [disabled]="running() || !canRun()"
          [title]="canRun() ? 'Run the script over the last ' + bars() + ' bars' : blockedReason()"
        >
          @if (running()) {
            <span class="spinner"></span> Running…
          } @else {
            Preview
          }
        </button>
      </div>

      @if (error(); as e) {
        <div class="error-box" role="alert">{{ e }}</div>
      }

      @if (lastResult(); as r) {
        @if (compileErrors().length) {
          <div class="section">
            <h5 class="section-title">Compile errors</h5>
            <ul class="issues">
              @for (d of compileErrors(); track $index) {
                <li>
                  <button
                    type="button"
                    class="issue"
                    (click)="reveal.emit({ line: d.line, column: d.column })"
                  >
                    <span class="code">{{ d.code }}</span> {{ d.message }}
                    <span class="pos">Ln {{ d.line }}</span>
                  </button>
                </li>
              }
            </ul>
          </div>
        }
        @if (r.runtimeError; as rt) {
          <div class="section">
            <h5 class="section-title">Runtime error</h5>
            <button
              type="button"
              class="issue is-runtime"
              [disabled]="!rt.line"
              (click)="reveal.emit({ line: rt.line ?? 1, column: rt.column ?? 1 })"
            >
              <span class="code">{{ rt.code }}</span> {{ rt.message }}
              @if (rt.line) {
                <span class="pos">Ln {{ rt.line }}</span>
              }
              @if (rt.barIndex !== null && rt.barIndex !== undefined) {
                <span class="pos">bar {{ rt.barIndex }}</span>
              }
            </button>
          </div>
        }
        @if (report(); as rep) {
          <div class="kpis">
            <div class="kpi">
              <span class="kpi-label">Net profit</span>
              <span
                class="kpi-value"
                [class.pos]="rep.netProfit > 0"
                [class.neg]="rep.netProfit < 0"
              >
                {{ rep.netProfit | number: '1.2-2' }}
                @if (rep.netProfitPercent !== null && rep.netProfitPercent !== undefined) {
                  <small>({{ rep.netProfitPercent | number: '1.2-2' }}%)</small>
                }
              </span>
            </div>
            <div class="kpi">
              <span class="kpi-label">Closed trades</span>
              <span class="kpi-value">{{ rep.totalClosedTrades }}</span>
            </div>
            <div class="kpi">
              <span class="kpi-label">Profitable</span>
              <span class="kpi-value">
                @if (rep.percentProfitable !== null && rep.percentProfitable !== undefined) {
                  {{ rep.percentProfitable | number: '1.1-1' }}%
                } @else {
                  —
                }
              </span>
            </div>
            <div class="kpi">
              <span class="kpi-label">Profit factor</span>
              <span class="kpi-value">
                @if (rep.profitFactor !== null && rep.profitFactor !== undefined) {
                  {{ rep.profitFactor | number: '1.2-2' }}
                } @else {
                  —
                }
              </span>
            </div>
            <div class="kpi">
              <span class="kpi-label">Max drawdown</span>
              <span class="kpi-value neg">
                {{ rep.maxDrawdown | number: '1.2-2' }}
                @if (rep.maxDrawdownPercent !== undefined) {
                  <small>({{ rep.maxDrawdownPercent | number: '1.2-2' }}%)</small>
                }
              </span>
            </div>
            <div class="kpi">
              <span class="kpi-label">Sharpe</span>
              <span class="kpi-value">
                @if (rep.sharpe !== null && rep.sharpe !== undefined) {
                  {{ rep.sharpe | number: '1.2-2' }}
                } @else {
                  —
                }
              </span>
            </div>
          </div>
          @if (rep.warnings.length) {
            <ul class="warnings">
              @for (w of rep.warnings; track $index) {
                <li>{{ w }}</li>
              }
            </ul>
          }
        }
        <p class="meta muted small">
          {{ barCount() | number }} bars · {{ logCount() }} log{{ logCount() === 1 ? '' : 's' }} ·
          {{ alertCount() }} alert{{ alertCount() === 1 ? '' : 's' }}
          @if (r.elapsedMs !== undefined) {
            · {{ r.elapsedMs | number }} ms
          }
        </p>
      }

      <!-- Chart overlay slot: the chart stream projects its renderer here and reads (result). -->
      <div class="chart-slot" data-slot="script-chart-overlay">
        <ng-content select="[scriptChartOverlay]" />
      </div>
    </div>
  `,
  styles: [
    SCRIPTING_UI_STYLES,
    `
      :host {
        display: block;
      }
      .preview {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .controls {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .ctl {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .spacer {
        flex: 1;
      }
      .section-title {
        margin: 0 0 4px;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-secondary);
      }
      .issues {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .issue {
        width: 100%;
        display: flex;
        gap: 6px;
        align-items: baseline;
        padding: 4px 6px;
        border: none;
        border-radius: 6px;
        background: rgba(255, 59, 48, 0.07);
        color: var(--text-primary);
        font: inherit;
        font-size: 12px;
        text-align: left;
        cursor: pointer;
        margin-bottom: 2px;
      }
      .issue:disabled {
        cursor: default;
      }
      .code,
      .pos {
        font-family: ui-monospace, 'SF Mono', Menlo, monospace;
        font-size: 11px;
        color: var(--text-tertiary);
      }
      .pos {
        margin-left: auto;
      }
      .kpis {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
        gap: 6px;
      }
      .kpi {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 6px 8px;
        border-radius: 8px;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
      }
      .kpi-label {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary);
      }
      .kpi-value {
        font-size: 14px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .kpi-value small {
        font-size: 11px;
        font-weight: 500;
        color: var(--text-secondary);
      }
      .kpi-value.pos {
        color: #1f8a3b;
      }
      .kpi-value.neg {
        color: var(--loss);
      }
      .warnings {
        margin: 0;
        padding-left: 18px;
        font-size: 12px;
        color: #b25e00;
      }
      .meta {
        margin: 0;
      }
      .chart-slot:empty {
        display: none;
      }
    `,
  ],
})
export class ScriptPreviewComponent {
  readonly source = input('');
  readonly inputs = input<ScriptInputValues>({});
  readonly symbol = input<string | null>(null);
  readonly timeframe = input<string | null>(null);
  /** The declaration kind: strategies run in backtest mode (the report is what matters). */
  readonly kind = input<ScriptKind | null>(null);
  readonly disabled = input(false);

  /** Every run result — the chart overlay renders from it. */
  readonly result = output<ScriptRunResult>();
  /** Jump the editor to a line. */
  readonly reveal = output<{ line: number; column: number }>();

  private readonly scripting = inject(ScriptingService);
  readonly barChoices = BAR_CHOICES;
  readonly bars = signal<number>(2000);
  readonly running = signal(false);
  readonly error = signal<string | null>(null);
  readonly lastResult = signal<ScriptRunResult | null>(null);

  readonly canRun = computed(
    () => !this.disabled() && !!this.source().trim() && !!this.symbol() && !!this.timeframe(),
  );
  readonly blockedReason = computed(() =>
    !this.source().trim()
      ? 'Write a script first'
      : !this.symbol() || !this.timeframe()
        ? 'Pick a symbol and timeframe first'
        : 'Preview unavailable',
  );
  readonly compileErrors = computed<ScriptDiagnostic[]>(() =>
    (this.lastResult()?.compile?.diagnostics ?? [])
      .filter((d) => d.severity === 'error')
      .slice(0, 20),
  );
  readonly report = computed(() => {
    const r = this.lastResult()?.report;
    if (!r) return null;
    const all = r.performance?.all ?? {};
    return {
      netProfit: all.netProfit ?? 0,
      netProfitPercent: all.netProfitPercent ?? null,
      totalClosedTrades: all.totalClosedTrades ?? 0,
      percentProfitable: all.percentProfitable ?? null,
      profitFactor: all.profitFactor ?? null,
      maxDrawdown: r.equity?.maxDrawdown ?? 0,
      maxDrawdownPercent: r.equity?.maxDrawdownPercent,
      sharpe: r.returns?.sharpeRatio ?? null,
      warnings: r.warnings ?? [],
    };
  });
  readonly barCount = computed(
    () => this.lastResult()?.bars?.length ?? this.lastResult()?.report?.meta?.bars ?? 0,
  );
  readonly logCount = computed(() => {
    const logs = this.lastResult()?.outputs?.logs;
    return Array.isArray(logs) ? logs.length : 0;
  });
  readonly alertCount = computed(() => {
    const alerts = this.lastResult()?.outputs?.alerts;
    return Array.isArray(alerts) ? alerts.length : 0;
  });

  async run(): Promise<void> {
    if (!this.canRun() || this.running()) return;
    this.running.set(true);
    this.error.set(null);
    try {
      const r = await firstValueFrom(
        this.scripting.run({
          source: this.source(),
          symbol: this.symbol()!,
          timeframe: this.timeframe()!,
          lastBars: this.bars(),
          inputs: this.inputs(),
          mode: this.kind() === 'strategy' ? 'backtest' : 'preview',
        }),
      );
      this.lastResult.set(r);
      this.result.emit(r);
    } catch (err) {
      this.error.set(toScriptingError(err, 'The preview failed.').message);
    } finally {
      this.running.set(false);
    }
  }
}
