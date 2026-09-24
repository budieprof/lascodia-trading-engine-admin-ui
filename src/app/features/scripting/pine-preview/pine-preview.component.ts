import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import type { Subscription } from 'rxjs';
import { ApiError } from '@core/api/api.types';
import { ScriptingRunApiService } from '@shared/pine-chart/api/scripting-run-api.service';
import { PineChartComponent, type PineBarRef } from '@shared/pine-chart/components/pine-chart.component';
import type { PineChartData } from '@shared/pine-chart/model/chart-data';
import { normalizeRunResult } from '@shared/pine-chart/model/normalize';
import type { PineRunRequest, PineRunResult } from '@shared/pine-chart/model/pine-outputs.types';
import { PineLogsPaneComponent, type PineLineJump } from '@shared/pine-chart/panes/pine-logs-pane.component';
import { PineProfilerPaneComponent } from '@shared/pine-chart/panes/pine-profiler-pane.component';
import { PineTracePaneComponent } from '@shared/pine-chart/panes/pine-trace-pane.component';
import { PineReplayComponent } from '@shared/pine-chart/replay/pine-replay.component';
import type { ReplayApi } from '@shared/pine-chart/replay/replay-session';

type DockTab = 'logs' | 'trace' | 'profiler';

/**
 * Pine preview: the chart of a run with its debugging dock (Pine Logs, "why didn't it fire?" trace,
 * profiler) and Bar Replay — what the Pine editor's Preview slot hosts.
 *
 * Two ways to feed it:
 * - bind `result` to a run the host already made (the editor's `ScriptingService.run()` result, the
 *   §3 `data`, or the envelope); or
 * - leave `result` unbound and give it a `request` (or `source` + `symbol` + `timeframe`): it runs
 *   `POST scripting/run` itself and re-runs on change.
 * Either way it re-runs by itself when the operator asks for a trace window or a profile, and it
 * reports every result it makes through `resultChange`. Jumps to source lines come out of
 * `jumpToLine` (1-based line/column) for the editor to reveal.
 */
@Component({
  selector: 'app-pine-preview',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PineChartComponent, PineLogsPaneComponent, PineTracePaneComponent, PineProfilerPaneComponent, PineReplayComponent],
  template: `
    <div class="chart-bar">
      <span class="meta">
        @if (symbol() || effectiveRequest()?.symbol) {
          <b>{{ symbol() || effectiveRequest()?.symbol }}</b>
        }
        @if (timeframe() || effectiveRequest()?.timeframe) {
          <span>{{ timeframe() || effectiveRequest()?.timeframe }}</span>
        }
        @if (current(); as r) {
          <span>{{ r.bars.length.toLocaleString() }} bars</span>
          @if (r.elapsedMs !== null) {
            <span>· {{ r.elapsedMs }} ms</span>
          }
        }
        @if (running()) {
          <span class="running">Running…</span>
        }
      </span>
      <app-pine-replay
        [request]="effectiveRequest()"
        [declaration]="current()?.compile?.declaration ?? null"
        [pickedBar]="lastClick()"
        [api]="replayApi()"
        (dataChange)="replayData.set($event)"
        (armedChange)="armed.set($event)"
        (barChange)="replayBar.set($event)"
      />
    </div>

    @if (error(); as e) {
      <div class="banner error" role="alert">{{ e }}</div>
    }
    @if (compileError(); as d) {
      <div class="banner error" role="alert">
        The script does not compile — {{ d.message }}
        @if (d.line) {
          <button type="button" (click)="jumpToLine.emit({ line: d.line, column: d.column })">Line {{ d.line }}:{{ d.column }}</button>
        }
      </div>
    }
    @if (current()?.runtimeError; as err) {
      <div class="banner runtime" role="alert">
        <b>{{ err.code || 'Runtime error' }}</b> {{ err.message }}
        @if (err.line) {
          <button type="button" (click)="jumpToLine.emit({ line: err.line, column: err.column })">Line {{ err.line }}</button>
        }
        @if (err.barIndex !== null && err.barIndex !== undefined) {
          <button type="button" (click)="goToBar(err.barIndex)">Bar {{ err.barIndex }}</button>
        }
      </div>
    }
    @if (armed()) {
      <div class="banner hint">Click the bar to start the replay from.</div>
    }

    <app-pine-chart
      class="chart"
      [class.armed]="armed()"
      [result]="chartData()"
      [symbol]="symbol() || effectiveRequest()?.symbol || ''"
      [timeframe]="timeframe() || effectiveRequest()?.timeframe || ''"
      [timezone]="timezone()"
      [highlightBar]="highlight()"
      [emptyText]="running() ? 'Running the script…' : 'Run the script to see its outputs on the chart.'"
      (barClick)="onBarClick($event)"
    />

    <div class="resizer" (pointerdown)="startResize($event)" title="Drag to resize" aria-hidden="true"></div>

    <div class="dock" [style.height.px]="dockOpen() ? dockHeight() : 32">
      <div class="tabs" role="tablist">
        <button type="button" role="tab" [attr.aria-selected]="tab() === 'logs'" [class.active]="tab() === 'logs'" (click)="selectTab('logs')">
          Pine Logs
          @if (logCount()) {
            <span class="badge" [class.err]="hasErrors()">{{ logCount() }}</span>
          }
        </button>
        <button type="button" role="tab" [attr.aria-selected]="tab() === 'trace'" [class.active]="tab() === 'trace'" (click)="selectTab('trace')">
          Why didn't it fire?
        </button>
        <button type="button" role="tab" [attr.aria-selected]="tab() === 'profiler'" [class.active]="tab() === 'profiler'" (click)="selectTab('profiler')">
          Profiler
        </button>
        <span class="spacer"></span>
        @if (tab() === 'profiler' && effectiveRequest()) {
          <button type="button" class="action" (click)="runProfile()" [disabled]="running()">Profile run</button>
        }
        <button type="button" class="action" (click)="dockOpen.set(!dockOpen())" [attr.aria-label]="dockOpen() ? 'Collapse panel' : 'Expand panel'">
          {{ dockOpen() ? '▾' : '▴' }}
        </button>
      </div>
      @if (dockOpen()) {
        <div class="tab-body" role="tabpanel">
          @switch (tab()) {
            @case ('logs') {
              <app-pine-logs-pane
                [logs]="current()?.outputs?.logs ?? []"
                [droppedLogs]="current()?.outputs?.droppedLogs ?? 0"
                [runtimeError]="current()?.runtimeError ?? null"
                [timezone]="timezone()"
                (barJump)="goToBar($event)"
                (lineJump)="jumpToLine.emit($event)"
              />
            }
            @case ('trace') {
              <app-pine-trace-pane
                [trace]="current()?.trace ?? []"
                [bar]="traceBar()"
                [timezone]="timezone()"
                (barChange)="onTraceBar($event)"
                (lineJump)="jumpToLine.emit($event)"
                (requestTrace)="runTrace($event)"
              />
            }
            @case ('profiler') {
              <app-pine-profiler-pane
                [profile]="current()?.profile ?? []"
                [source]="effectiveSource()"
                [elapsedMs]="current()?.elapsedMs ?? null"
                (lineJump)="jumpToLine.emit($event)"
              />
            }
          }
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        min-height: 420px;
        height: 100%;
        background: var(--bg-primary, #fff);
        border: 1px solid var(--border, rgba(0, 0, 0, 0.08));
        border-radius: var(--radius-md, 12px);
        overflow: hidden;
      }
      .chart-bar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 6px 12px;
        padding: 6px 10px;
        border-bottom: 1px solid var(--border, rgba(0, 0, 0, 0.08));
        font-size: 12px;
      }
      .meta {
        display: inline-flex;
        gap: 6px;
        align-items: baseline;
        color: var(--text-secondary, #6e6e73);
      }
      .meta b {
        color: var(--text-primary, #1d1d1f);
      }
      .running {
        color: var(--accent, #0071e3);
      }
      .banner {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        padding: 5px 10px;
        font-size: 12px;
      }
      .banner.error,
      .banner.runtime {
        background: color-mix(in srgb, var(--loss, #ff3b30) 11%, transparent);
        color: var(--text-primary, #1d1d1f);
      }
      .banner.hint {
        background: color-mix(in srgb, var(--accent, #0071e3) 10%, transparent);
      }
      .banner button,
      .tabs button {
        font: inherit;
        font-size: 11px;
        padding: 1px 8px;
        border-radius: 5px;
        border: 1px solid var(--border, rgba(0, 0, 0, 0.12));
        background: var(--bg-primary, #fff);
        color: inherit;
        cursor: pointer;
      }
      .chart {
        flex: 1 1 auto;
        min-height: 220px;
      }
      .chart.armed {
        cursor: crosshair;
        outline: 2px solid color-mix(in srgb, var(--accent, #0071e3) 45%, transparent);
        outline-offset: -2px;
      }
      .resizer {
        height: 5px;
        flex: none;
        cursor: row-resize;
        background: var(--bg-secondary, #f5f5f7);
        border-top: 1px solid var(--border, rgba(0, 0, 0, 0.08));
      }
      .dock {
        display: flex;
        flex-direction: column;
        flex: none;
        min-height: 32px;
        overflow: hidden;
      }
      .tabs {
        display: flex;
        align-items: center;
        gap: 4px;
        height: 32px;
        flex: none;
        padding: 0 8px;
        border-bottom: 1px solid var(--border, rgba(0, 0, 0, 0.08));
      }
      .tabs button[role='tab'] {
        border-color: transparent;
        background: transparent;
        font-size: 12px;
        padding: 3px 10px;
      }
      .tabs button[role='tab'].active {
        background: var(--bg-secondary, #f5f5f7);
        font-weight: 600;
      }
      .spacer {
        flex: 1;
      }
      .badge {
        margin-left: 4px;
        padding: 0 6px;
        border-radius: 9px;
        font-size: 10px;
        background: var(--bg-tertiary, #e8e8ed);
      }
      .badge.err {
        background: color-mix(in srgb, var(--loss, #ff3b30) 20%, transparent);
      }
      .tab-body {
        flex: 1 1 auto;
        min-height: 0;
        overflow: hidden;
      }
    `,
  ],
})
export class PinePreviewComponent {
  private readonly api = inject(ScriptingRunApiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly chart = viewChild(PineChartComponent);

  /** A run the host made (any run-result shape); leave unbound to let the preview run `request`. */
  readonly result = input<PineRunResult | null | undefined, unknown>(undefined, {
    transform: (v: unknown) => (v === undefined ? undefined : normalizeRunResult(v)),
  });
  /** The §3 request (runs it when `result` is unbound; replay and re-runs use it). */
  readonly request = input<PineRunRequest | null>(null);
  /** Script source (profiler code column; builds a request with symbol + timeframe). */
  readonly source = input<string | null>(null);
  readonly symbol = input('');
  readonly timeframe = input('');
  readonly timezone = input('UTC');
  /** Run `request` whenever it changes (when `result` is unbound). */
  readonly autoRun = input(true);
  /** Replay transport override (tests, fixtures); defaults to the engine. */
  readonly replayApi = input<ReplayApi | null>(null);

  readonly jumpToLine = output<PineLineJump>();
  /** Every result the preview produced itself (its own runs and trace/profile re-runs). */
  readonly resultChange = output<PineRunResult>();

  private readonly ownResult = signal<PineRunResult | null>(null);
  readonly running = signal(false);
  readonly error = signal<string | null>(null);
  readonly tab = signal<DockTab>('logs');
  readonly dockOpen = signal(true);
  readonly dockHeight = signal(240);
  readonly replayData = signal<PineChartData | null>(null);
  readonly replayBar = signal<number | null>(null);
  readonly armed = signal(false);
  readonly lastClick = signal<PineBarRef | null>(null);
  readonly traceBar = signal<number | null>(null);
  readonly highlight = signal<number | null>(null);
  private runSub: Subscription | null = null;

  readonly effectiveSource = computed(() => this.source() ?? this.request()?.source ?? null);
  readonly effectiveRequest = computed<PineRunRequest | null>(() => {
    const req = this.request();
    if (req) return req;
    const source = this.source();
    const symbol = this.symbol();
    const timeframe = this.timeframe();
    return source && symbol && timeframe ? { source, symbol, timeframe, mode: 'preview' } : null;
  });

  /** The run on screen: the preview's own latest run, else the host's. */
  readonly current = computed<PineRunResult | null>(() => this.ownResult() ?? this.result() ?? null);
  readonly chartData = computed<PineChartData | PineRunResult | null>(() => this.replayData() ?? this.current());
  readonly logCount = computed(() => this.current()?.outputs?.logs.length ?? 0);
  readonly hasErrors = computed(() => (this.current()?.outputs?.logs ?? []).some((l) => l.level === 'error'));
  readonly compileError = computed(() => {
    const c = this.current()?.compile;
    if (!c || c.success) return null;
    return c.diagnostics.find((d) => d.severity === 'error') ?? { message: 'Compilation failed', line: 0, column: 0 };
  });

  constructor() {
    // A new host result replaces whatever the preview ran itself.
    effect(() => {
      this.result();
      untracked(() => this.ownResult.set(null));
    });
    // No bound result: run the request whenever it changes.
    effect(() => {
      const req = this.effectiveRequest();
      const auto = this.autoRun();
      untracked(() => {
        if (req && auto && this.result() === undefined) this.run(req);
      });
    });
    this.destroyRef.onDestroy(() => this.runSub?.unsubscribe());
  }

  run(request: PineRunRequest): void {
    this.runSub?.unsubscribe();
    this.running.set(true);
    this.error.set(null);
    this.runSub = this.api.run(request).subscribe({
      next: (res) => {
        this.running.set(false);
        this.ownResult.set(res);
        this.resultChange.emit(res);
      },
      error: (e: unknown) => {
        this.running.set(false);
        this.error.set(runErrorMessage(e));
      },
    });
  }

  /** Re-run with a trace window (the trace pane asks when the picked bar is not traced). */
  runTrace(window: { fromBar: number; toBar: number }): void {
    const req = this.effectiveRequest();
    if (!req) return;
    this.run({ ...req, trace: window, profile: req.profile || (this.current()?.profile.length ?? 0) > 0 });
  }

  runProfile(): void {
    const req = this.effectiveRequest();
    if (!req) return;
    const t = this.current()?.trace;
    const trace = t && t.length ? { fromBar: t[0].bar, toBar: t[t.length - 1].bar } : req.trace;
    this.run({ ...req, profile: true, ...(trace ? { trace } : {}) });
  }

  selectTab(tab: DockTab): void {
    this.tab.set(tab);
    this.dockOpen.set(true);
  }

  onBarClick(ref: PineBarRef): void {
    this.lastClick.set(ref);
    if (this.armed()) return;
    this.traceBar.set(ref.barIndex);
    this.highlight.set(ref.barIndex);
  }

  onTraceBar(bar: number): void {
    this.highlight.set(bar);
    this.chart()?.scrollToBar(bar);
  }

  goToBar(bar: number): void {
    this.highlight.set(bar);
    this.traceBar.set(bar);
    this.chart()?.scrollToBar(bar);
  }

  startResize(e: PointerEvent): void {
    const startY = e.clientY;
    const start = this.dockHeight();
    const host = (e.target as HTMLElement).parentElement;
    const max = Math.max(160, (host?.clientHeight ?? 800) * 0.7);
    const move = (ev: PointerEvent) => this.dockHeight.set(Math.max(96, Math.min(max, start + (startY - ev.clientY))));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    this.dockOpen.set(true);
    e.preventDefault();
  }
}

function runErrorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message || 'The engine could not run the script.';
  if (e instanceof HttpErrorResponse) {
    if (e.status === 0) return 'The engine is unreachable.';
    const body = e.error as { message?: string } | null;
    return body?.message ? `${body.message} (HTTP ${e.status})` : `The run failed (HTTP ${e.status}).`;
  }
  return e instanceof Error ? e.message : 'The run failed.';
}
