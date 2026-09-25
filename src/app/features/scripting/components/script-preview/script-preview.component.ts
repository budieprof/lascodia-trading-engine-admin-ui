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
  ScriptRunRequest,
  ScriptRunResult,
} from '@core/api/scripting.types';
import { ScriptingService, toScriptingError } from '@core/services/scripting.service';
import type { PineLineJump } from '@shared/pine-chart/panes/pine-logs-pane.component';
import { PinePreviewComponent } from '../../pine-preview/pine-preview.component';
import { StrategyReportComponent } from '../../report/strategy-report.component';
import { normalizeStrategyReport } from '../../report/strategy-report.model';
import { SCRIPTING_UI_STYLES } from '../scripting-ui.styles';

const BAR_CHOICES = [500, 1000, 2000, 5000, 10000] as const;

/** What the result area shows: the chart, or (strategy scripts) the Strategy report. */
export type PreviewView = 'chart' | 'report';

/**
 * "Preview": runs the script over recent history through `POST scripting/run` and shows the run —
 * the Pine chart with every output, Pine Logs, the "why didn't it fire?" trace, the profiler and
 * Bar Replay (`app-pine-preview`) and, for a strategy, the Strategy report of the same run.
 *
 * A script that does not compile lists its errors instead of a chart. Every jump to a source line
 * (a compile error, a log, a traced expression, a profiled line, a runtime error) comes out of
 * `reveal` for the editor.
 */
@Component({
  selector: 'app-script-preview',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, PinePreviewComponent, StrategyReportComponent],
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
        @if (lastResult(); as r) {
          <span class="muted small meta">
            {{ barCount() | number }} bars · {{ logCount() }} log{{ logCount() === 1 ? '' : 's' }} ·
            {{ alertCount() }} alert{{ alertCount() === 1 ? '' : 's' }}
            @if (r.elapsedMs !== undefined && r.elapsedMs !== null) {
              · {{ r.elapsedMs | number }} ms
            }
          </span>
        }
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
            {{ lastResult() ? 'Run again' : 'Preview' }}
          }
        </button>
      </div>

      @if (error(); as e) {
        <div class="error-box" role="alert">{{ e }}</div>
      }

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

      @if (!lastResult() && !running() && !error()) {
        <p class="hint muted small">
          Runs the script over recent bars of the strategy's symbol and timeframe: the chart shows
          every plot, shape, drawing and table, with Pine Logs, the "why didn't it fire?" trace, the
          profiler and Bar Replay{{ kind() === 'strategy' ? ' — and the Strategy report' : '' }}.
        </p>
      }

      @if (hasReport()) {
        <div class="result-tabs" role="tablist" aria-label="Preview result">
          <button
            type="button"
            role="tab"
            class="result-tab"
            [class.is-active]="view() === 'chart'"
            [attr.aria-selected]="view() === 'chart'"
            (click)="showView('chart')"
          >
            Chart
          </button>
          <button
            type="button"
            role="tab"
            class="result-tab"
            [class.is-active]="view() === 'report'"
            [attr.aria-selected]="view() === 'report'"
            (click)="showView('report')"
          >
            Strategy report
            <span class="count">{{ tradeCount() }}</span>
          </button>
        </div>
      }

      <!-- The chart slot: the run on the Pine chart. Kept alive (hidden) while the report shows,
           so switching back keeps the chart's zoom and the dock's state. -->
      @if (chartRun(); as run) {
        <div class="chart-slot" data-slot="script-chart-overlay" [hidden]="view() !== 'chart'">
          <app-pine-preview
            [result]="run"
            [request]="lastRequest()"
            [source]="lastRequest()?.source ?? null"
            [symbol]="symbol() ?? ''"
            [timeframe]="timeframe() ?? ''"
            (jumpToLine)="onJump($event)"
          />
        </div>
      }
      @if (hasReport() && view() === 'report') {
        <div class="report-slot" role="tabpanel">
          <app-strategy-report [report]="chartRun()!.report" />
        </div>
      }
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
      .hint {
        margin: 0;
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
      .code,
      .pos {
        font-family: ui-monospace, 'SF Mono', Menlo, monospace;
        font-size: 11px;
        color: var(--text-tertiary);
      }
      .pos {
        margin-left: auto;
      }
      .result-tabs {
        display: flex;
        gap: 2px;
        border-bottom: 1px solid var(--border);
      }
      .result-tab {
        padding: 6px 12px;
        border: none;
        border-bottom: 2px solid transparent;
        background: transparent;
        color: var(--text-secondary);
        font: inherit;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
      }
      .result-tab.is-active {
        color: var(--accent);
        border-bottom-color: var(--accent);
      }
      .count {
        font-size: 10px;
        padding: 0 5px;
        border-radius: 999px;
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .chart-slot {
        height: 560px;
        min-width: 0;
      }
      .chart-slot[hidden] {
        display: none;
      }
      .report-slot {
        min-width: 0;
      }
    `,
  ],
})
export class ScriptPreviewComponent {
  readonly source = input('');
  readonly inputs = input<ScriptInputValues>({});
  readonly symbol = input<string | null>(null);
  readonly timeframe = input<string | null>(null);
  /** The declaration kind: strategies run in backtest mode (their report comes with the run). */
  readonly kind = input<ScriptKind | null>(null);
  readonly disabled = input(false);

  /** Jump the editor to a line. */
  readonly reveal = output<{ line: number; column: number }>();

  private readonly scripting = inject(ScriptingService);
  readonly barChoices = BAR_CHOICES;
  readonly bars = signal<number>(2000);
  readonly running = signal(false);
  readonly error = signal<string | null>(null);
  readonly lastResult = signal<ScriptRunResult | null>(null);
  /** The request behind `lastResult` — the chart re-runs it for a trace window, a profile or a replay. */
  readonly lastRequest = signal<ScriptRunRequest | null>(null);
  private readonly selectedView = signal<PreviewView>('chart');

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
  /** The run on the chart — null until a run compiles (a compile failure lists its errors instead). */
  readonly chartRun = computed<ScriptRunResult | null>(() => {
    const r = this.lastResult();
    return r && r.compile?.success !== false ? r : null;
  });
  readonly hasReport = computed(() => !!this.chartRun()?.report);
  /** Chart unless the run has a report and the operator picked it. */
  readonly view = computed<PreviewView>(() => (this.hasReport() ? this.selectedView() : 'chart'));
  readonly tradeCount = computed(
    () => normalizeStrategyReport(this.chartRun()?.report)?.trades.length ?? 0,
  );
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
    const request: ScriptRunRequest = {
      source: this.source(),
      symbol: this.symbol()!,
      timeframe: this.timeframe()!,
      lastBars: this.bars(),
      inputs: this.inputs(),
      mode: this.kind() === 'strategy' ? 'backtest' : 'preview',
    };
    this.running.set(true);
    this.error.set(null);
    try {
      const r = await firstValueFrom(this.scripting.run(request));
      this.lastRequest.set(request);
      this.lastResult.set(r);
    } catch (err) {
      this.error.set(toScriptingError(err, 'The preview failed.').message);
    } finally {
      this.running.set(false);
    }
  }

  showView(view: PreviewView): void {
    this.selectedView.set(view);
  }

  onJump(jump: PineLineJump): void {
    this.reveal.emit({ line: jump.line, column: jump.column ?? 1 });
  }
}
