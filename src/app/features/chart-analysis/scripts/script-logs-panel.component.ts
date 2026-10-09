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
} from '@angular/core';
import type { Subscription } from 'rxjs';

import type { ScriptInputValues } from '@core/api/scripting.types';
import type { PineRunResult } from '@shared/pine-chart/model/pine-outputs.types';
import {
  PineLogsPaneComponent,
  type PineLineJump,
} from '@shared/pine-chart/panes/pine-logs-pane.component';
import { PineProfilerPaneComponent } from '@shared/pine-chart/panes/pine-profiler-pane.component';
import { PineTracePaneComponent } from '@shared/pine-chart/panes/pine-trace-pane.component';
import type { TvResolution } from '../datafeed/resolution';
import { ChartIconComponent } from '../icons/chart-icon.component';
import type { ChartScriptResult } from './chart-script.model';
import {
  ChartScriptService,
  type ChartRunOptions,
  type ChartScriptItem,
} from './chart-script.service';
import { busyWaitMs, isBusy } from './script-run-state';

type LogsTab = 'logs' | 'trace' | 'profiler';

/** How the script on the chart was run — what a trace or a profile run repeats (PC-I6). */
export interface LogsRunRequest {
  item: ChartScriptItem;
  symbol: string;
  resolution: TvResolution;
  values: ScriptInputValues;
  lastBars: number;
  /** The run's chart type and end (a Bar Replay head); trace and profile are added here. */
  opts: ChartRunOptions;
}

/** The trace window a profile run keeps: the one on screen, else this many bars before the end. */
const PROFILE_TRACE_BARS = 100;

/**
 * Pine Logs for a script on the chart (PC-I6), as TradingView's dock has them: its `log.*()`
 * messages (the chart's own run — they follow its re-runs), "Why didn't it fire?" (every traced
 * expression at a bar) and the Profiler — the shared panes. A trace or a profile is a run of its
 * own, made here and kept here: the chart is not touched. A bar jump pans the chart to that bar,
 * a line jump opens the editor there.
 */
@Component({
  selector: 'app-script-logs-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChartIconComponent, PineLogsPaneComponent, PineTracePaneComponent, PineProfilerPaneComponent],
  template: `
    <section class="lp" aria-label="Pine Logs">
      <header class="lp__bar">
        <strong class="lp__title" [title]="title()">{{ title() }}</strong>
        <nav class="lp__tabs" role="tablist">
          <button
            type="button"
            role="tab"
            [class.active]="tab() === 'logs'"
            [attr.aria-selected]="tab() === 'logs'"
            (click)="tab.set('logs')"
          >
            Pine Logs
            @if (logs().length) {
              <span class="lp__badge" [class.err]="hasErrors()">{{ logs().length }}</span>
            }
          </button>
          <button
            type="button"
            role="tab"
            [class.active]="tab() === 'trace'"
            [attr.aria-selected]="tab() === 'trace'"
            (click)="tab.set('trace')"
          >
            Why didn't it fire?
          </button>
          <button
            type="button"
            role="tab"
            [class.active]="tab() === 'profiler'"
            [attr.aria-selected]="tab() === 'profiler'"
            (click)="tab.set('profiler')"
          >
            Profiler
          </button>
        </nav>
        <span class="lp__spacer"></span>
        @if (running()) {
          <span class="lp__muted" role="status">Running…</span>
        }
        @if (tab() === 'profiler') {
          <button
            type="button"
            class="lp__btn"
            data-testid="logs-profile"
            [disabled]="running() || !request()"
            (click)="runProfile()"
          >
            Profile run
          </button>
        }
        <button type="button" class="lp__icon" aria-label="Close Pine Logs" (click)="closed.emit()">
          <app-chart-icon name="close" [size]="18" />
        </button>
      </header>
      @if (error(); as e) {
        <div class="lp__error" role="alert">{{ e }}</div>
      }
      <div class="lp__body">
        @switch (tab()) {
          @case ('logs') {
            <app-pine-logs-pane
              [logs]="logs()"
              [droppedLogs]="chartRun()?.outputs?.droppedLogs ?? 0"
              [runtimeError]="chartRun()?.runtimeError ?? null"
              [timezone]="timezone()"
              (barJump)="jumpTo($event, chartRun())"
              (lineJump)="lineJump.emit($event)"
            />
          }
          @case ('trace') {
            <app-pine-trace-pane
              [trace]="debug()?.trace ?? []"
              [bar]="traceBar()"
              [timezone]="timezone()"
              (barChange)="onTraceBar($event)"
              (lineJump)="lineJump.emit($event)"
              (requestTrace)="runTrace($event)"
            />
          }
          @case ('profiler') {
            @if (debug()?.profile?.length) {
              <app-pine-profiler-pane
                [profile]="debug()!.profile"
                [source]="source()"
                [elapsedMs]="debug()!.elapsedMs"
                (lineJump)="lineJump.emit($event)"
              />
            } @else {
              <p class="lp__muted lp__hint">
                “Profile run” runs the script once more, timing every line — the chart keeps its run.
              </p>
            }
          }
        }
      </div>
    </section>
  `,
  styles: `
    :host {
      display: block;
      min-height: 0;
    }
    .lp {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--surface);
      border-top: 1px solid var(--border);
      font-size: 12px;
    }
    .lp__bar {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 4px 10px;
      border-bottom: 1px solid var(--border);
    }
    .lp__title {
      max-width: 240px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .lp__tabs {
      display: flex;
      gap: 2px;
    }
    .lp__tabs button,
    .lp__icon,
    .lp__btn {
      background: none;
      border: 0;
      color: var(--text-muted);
      padding: 4px 8px;
      border-radius: 4px;
      cursor: pointer;
      font: inherit;
    }
    .lp__tabs button:hover,
    .lp__icon:hover,
    .lp__btn:hover:not(:disabled) {
      background: var(--surface-hover);
    }
    .lp__tabs button.active {
      color: var(--accent);
      background: var(--accent-soft);
    }
    .lp__btn {
      border: 1px solid var(--border);
      color: inherit;
    }
    .lp__btn:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .lp__badge {
      margin-left: 4px;
      padding: 0 6px;
      border-radius: 9px;
      font-size: 10px;
      background: var(--bg-tertiary, #e8e8ed);
    }
    .lp__badge.err {
      background: color-mix(in srgb, var(--loss, #ff3b30) 20%, transparent);
    }
    .lp__spacer {
      flex: 1;
    }
    .lp__muted {
      color: var(--text-muted);
    }
    .lp__hint {
      margin: 0;
      padding: 10px;
    }
    .lp__error {
      padding: 6px 10px;
      color: var(--loss);
      border-bottom: 1px solid var(--border);
    }
    .lp__body {
      flex: 1;
      min-height: 0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .lp__body > * {
      flex: 1;
      min-height: 0;
    }
    @media (pointer: coarse) {
      .lp__tabs button,
      .lp__btn,
      .lp__icon {
        min-height: 40px;
      }
    }
  `,
})
export class ScriptLogsPanelComponent {
  private readonly scripts = inject(ChartScriptService);
  private readonly destroyRef = inject(DestroyRef);

  /** The script's name. */
  readonly title = input('');
  /** The script's run on the chart: its logs and runtime error. */
  readonly result = input<ChartScriptResult | null>(null);
  /** How it was run: a trace or a profile run repeats it with those added. Null: none can be made. */
  readonly request = input<LogsRunRequest | null>(null);
  /** Its Pine source, for the profiler's code column (null: lines without their text). */
  readonly source = input<string | null>(null);
  readonly timezone = input('UTC');

  readonly closed = output<void>();
  /** A bar to see on the chart: its open, UTC ms. */
  readonly barJump = output<number>();
  /** A source line to see in the editor. */
  readonly lineJump = output<PineLineJump>();

  readonly tab = signal<LogsTab>('logs');
  /** The latest trace or profile run (this panel's own, never on the chart). */
  readonly debug = signal<PineRunResult | null>(null);
  readonly running = signal(false);
  readonly error = signal<string | null>(null);
  readonly traceBar = signal<number | null>(null);
  private sub: Subscription | null = null;

  protected readonly chartRun = computed(() => this.result()?.run ?? null);
  protected readonly logs = computed(() => this.chartRun()?.outputs?.logs ?? []);
  protected readonly hasErrors = computed(() => this.logs().some((l) => l.level === 'error'));

  constructor() {
    // Another script, or the same one with other inputs: its trace and profile are another run's.
    let shown: string | null = null;
    effect(() => {
      const req = this.request();
      const key = req ? `${req.item.key}|${JSON.stringify(req.values)}|${req.symbol}|${req.resolution}` : null;
      untracked(() => {
        if (key === shown) return;
        shown = key;
        this.sub?.unsubscribe();
        this.running.set(false);
        this.debug.set(null);
        this.error.set(null);
        this.traceBar.set(null);
      });
    });
    this.destroyRef.onDestroy(() => this.sub?.unsubscribe());
  }

  /** Trace a bar window ("Why didn't it fire?" asks when the bar picked is not traced). */
  runTrace(window: { fromBar: number; toBar: number }): void {
    this.run({ trace: window, profile: (this.debug()?.profile.length ?? 0) > 0 });
  }

  /** Time every line — and trace the window on screen, or the last bars, alongside. */
  runProfile(): void {
    const t = this.debug()?.trace;
    const bars = this.chartRun()?.bars.length ?? 0;
    const trace =
      t && t.length
        ? { fromBar: t[0].bar, toBar: t[t.length - 1].bar }
        : bars
          ? { fromBar: Math.max(0, bars - PROFILE_TRACE_BARS), toBar: bars - 1 }
          : undefined;
    this.run({ profile: true, ...(trace ? { trace } : {}) });
  }

  protected onTraceBar(bar: number): void {
    this.traceBar.set(bar);
    this.jumpTo(bar, this.debug());
  }

  /** The bar `barIndex` of `run` on the chart. */
  protected jumpTo(barIndex: number, run: PineRunResult | null): void {
    const t = run?.bars[barIndex]?.t;
    if (typeof t === 'number') this.barJump.emit(t);
  }

  private run(extra: Pick<ChartRunOptions, 'trace' | 'profile'>): void {
    const req = this.request();
    if (!req) return;
    this.sub?.unsubscribe();
    this.running.set(true);
    this.error.set(null);
    this.sub = this.scripts
      .runOnChart(req.item, req.symbol, req.resolution, req.values, req.lastBars, {
        ...req.opts,
        liveBar: null,
        ...extra,
      })
      .subscribe({
        next: (result) => {
          this.running.set(false);
          if (result.error && !result.run) {
            this.error.set(result.error);
            return;
          }
          this.debug.set(result.run);
          if (extra.trace && this.traceBar() === null) this.traceBar.set(extra.trace.toBar);
        },
        error: (err: unknown) => {
          this.running.set(false);
          // C5: a busy engine is no failure of the script — try again.
          this.error.set(
            isBusy(err)
              ? `The engine is busy with other runs: try again in ${Math.ceil(busyWaitMs(err, 0) / 1000)} s.`
              : err instanceof Error
                ? err.message
                : 'The run failed.',
          );
        },
      });
  }
}
