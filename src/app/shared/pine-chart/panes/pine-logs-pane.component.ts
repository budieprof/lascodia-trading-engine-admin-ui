import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  afterNextRender,
  computed,
  effect,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { PineLogOutput, PineRuntimeError } from '../model/pine-outputs.types';
import {
  DEFAULT_LOG_FILTER,
  filterLogs,
  type LogFilter,
  type LogLevel,
  type LogRow,
} from './logs-filter';

/** Where in the script a pane wants the editor to go (1-based). */
export interface PineLineJump {
  line: number;
  column?: number | null;
}

const ROW_H = 24;
const OVERSCAN = 12;

/**
 * Pine Logs: every log.info/warning/error message of the run, prefixed with its bar time, filterable
 * by level, start time and search (match case / whole word / regex), with "scroll to bar" and — when
 * the engine reports the call's line — "source code" actions. A runtime error shows as a banner with
 * its line and bar. The list is virtualised: 10,000 logs render as a screenful of rows.
 */
@Component({
  selector: 'app-pine-logs-pane',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (runtimeError(); as err) {
      <div class="runtime-error" role="alert">
        <span class="code">{{ err.code || 'Runtime error' }}</span>
        <span class="msg">{{ err.message }}</span>
        @if (err.line) {
          <button type="button" (click)="lineJump.emit({ line: err.line, column: err.column })">
            Line {{ err.line }}{{ err.column ? ':' + err.column : '' }}
          </button>
        }
        @if (err.barIndex !== null && err.barIndex !== undefined) {
          <button type="button" (click)="barJump.emit(err.barIndex)">Bar {{ err.barIndex }}</button>
        }
      </div>
    }

    <div class="toolbar">
      @for (lvl of levels; track lvl) {
        <label class="level" [class]="lvl" [class.off]="!filter().levels[lvl]">
          <input type="checkbox" [checked]="filter().levels[lvl]" (change)="toggleLevel(lvl)" />
          {{ levelLabel(lvl) }} <span class="count">{{ result().counts[lvl] }}</span>
        </label>
      }
      <div class="search" [class.invalid]="!!result().error">
        <input
          type="search"
          placeholder="Search logs"
          aria-label="Search logs"
          [value]="filter().query"
          (input)="patch({ query: $any($event.target).value })"
        />
        <button
          type="button"
          [class.on]="filter().matchCase"
          (click)="patch({ matchCase: !filter().matchCase })"
          title="Match case"
        >
          Aa
        </button>
        <button
          type="button"
          [class.on]="filter().wholeWord"
          (click)="patch({ wholeWord: !filter().wholeWord })"
          title="Whole word"
        >
          ab
        </button>
        <button
          type="button"
          [class.on]="filter().regex"
          (click)="patch({ regex: !filter().regex })"
          title="Regex"
        >
          .*
        </button>
      </div>
      <label class="from" title="Only logs from this time on">
        From
        <input
          type="datetime-local"
          [value]="fromInput()"
          (change)="setFrom($any($event.target).value)"
        />
      </label>
      <span class="summary">
        @if (result().error; as e) {
          <span class="err">{{ e }}</span>
        } @else {
          {{ result().rows.length }} of {{ logs().length }}
        }
        @if (droppedLogs() > 0) {
          · {{ droppedLogs() }} older dropped
        }
      </span>
    </div>

    <div
      class="viewport"
      #viewport
      (scroll)="onScroll()"
      tabindex="0"
      aria-label="Pine logs"
      role="list"
    >
      <div class="spacer" [style.height.px]="window().total">
        <div class="rows" [style.transform]="'translateY(' + window().offset + 'px)'">
          @for (r of window().rows; track r.index) {
            <div
              class="row"
              role="listitem"
              [class]="r.level"
              [class.selected]="selected() === r.index"
              tabindex="0"
              (click)="select(r)"
              (keydown.enter)="select(r)"
            >
              <span class="dot"></span>
              <span class="time">{{ r.timeText }}</span>
              <span class="message">
                @for (s of r.segments; track $index) {
                  @if (s.match) {
                    <mark>{{ s.text }}</mark>
                  } @else {
                    {{ s.text }}
                  }
                }
                @if (r.multiline) {
                  <span class="more">…</span>
                }
              </span>
              <span class="actions">
                @if (r.barIndex >= 0) {
                  <button
                    type="button"
                    (click)="$event.stopPropagation(); barJump.emit(r.barIndex)"
                    title="Scroll to bar"
                  >
                    Bar {{ r.barIndex }}
                  </button>
                }
                @if (r.line) {
                  <button
                    type="button"
                    (click)="$event.stopPropagation(); lineJump.emit({ line: r.line })"
                    title="Source code"
                  >
                    Line {{ r.line }}
                  </button>
                }
              </span>
            </div>
          }
        </div>
      </div>
      @if (!result().rows.length) {
        <div class="empty">
          {{
            logs().length
              ? 'No logs match the filters.'
              : 'No logs. Call log.info(), log.warning() or log.error() to log.'
          }}
        </div>
      }
    </div>

    @if (selectedRow(); as r) {
      <div class="detail" [class]="r.level">
        <div class="detail-head">
          <span>{{ r.timeText }} · bar {{ r.barIndex }}{{ r.realtime ? ' · realtime' : '' }}</span>
          <button type="button" (click)="selected.set(null)" aria-label="Close">×</button>
        </div>
        <pre>{{ r.message }}</pre>
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        min-height: 0;
        height: 100%;
        font-size: 12px;
        color: var(--text-primary, #1d1d1f);
      }
      .runtime-error {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        background: color-mix(in srgb, var(--loss, #ff3b30) 12%, transparent);
        border-bottom: 1px solid color-mix(in srgb, var(--loss, #ff3b30) 35%, transparent);
      }
      .runtime-error .code {
        font-weight: 600;
        color: var(--loss, #ff3b30);
      }
      .runtime-error .msg {
        flex: 1 1 auto;
      }
      button {
        font: inherit;
        font-size: 11px;
        padding: 1px 7px;
        border-radius: 5px;
        border: 1px solid var(--border, rgba(0, 0, 0, 0.12));
        background: var(--bg-primary, #fff);
        color: inherit;
        cursor: pointer;
      }
      button.on {
        border-color: var(--accent, #0071e3);
        color: var(--accent, #0071e3);
      }
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px 10px;
        padding: 6px 10px;
        border-bottom: 1px solid var(--border, rgba(0, 0, 0, 0.08));
      }
      .level {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        cursor: pointer;
        user-select: none;
      }
      .level.off {
        opacity: 0.5;
      }
      .count {
        color: var(--text-tertiary, #86868b);
      }
      .search {
        display: inline-flex;
        gap: 3px;
        align-items: center;
      }
      .search input {
        width: 180px;
        font: inherit;
        padding: 2px 6px;
        border-radius: 5px;
        border: 1px solid var(--border, rgba(0, 0, 0, 0.12));
        background: var(--bg-primary, #fff);
        color: inherit;
      }
      .search.invalid input {
        border-color: var(--loss, #ff3b30);
      }
      .from input {
        font: inherit;
        font-size: 11px;
        border: 1px solid var(--border, rgba(0, 0, 0, 0.12));
        border-radius: 5px;
        background: var(--bg-primary, #fff);
        color: inherit;
      }
      .summary {
        margin-left: auto;
        color: var(--text-secondary, #6e6e73);
      }
      .summary .err {
        color: var(--loss, #ff3b30);
      }
      .viewport {
        position: relative;
        flex: 1 1 auto;
        min-height: 60px;
        overflow: auto;
        outline: none;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 8px;
        height: 24px;
        padding: 0 10px;
        white-space: nowrap;
        cursor: default;
      }
      .row:hover,
      .row.selected {
        background: var(--bg-secondary, #f5f5f7);
      }
      .dot {
        flex: none;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #787b86;
      }
      .warning .dot {
        background: var(--warning, #ff9500);
      }
      .error .dot {
        background: var(--loss, #ff3b30);
      }
      .time {
        flex: none;
        color: var(--text-tertiary, #86868b);
        font-variant-numeric: tabular-nums;
      }
      .message {
        flex: 1 1 auto;
        overflow: hidden;
        text-overflow: ellipsis;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .info .message {
        color: var(--text-secondary, #6e6e73);
      }
      .warning .message {
        color: var(--warning, #c93400);
      }
      .error .message {
        color: var(--loss, #d70015);
      }
      mark {
        background: color-mix(in srgb, var(--accent, #0071e3) 25%, transparent);
        color: inherit;
        border-radius: 2px;
      }
      .more {
        color: var(--text-tertiary, #86868b);
      }
      .actions {
        flex: none;
        display: none;
        gap: 4px;
      }
      .row:hover .actions,
      .row.selected .actions {
        display: inline-flex;
      }
      .empty {
        position: absolute;
        inset: 0;
        display: grid;
        place-items: center;
        color: var(--text-tertiary, #86868b);
      }
      .detail {
        border-top: 1px solid var(--border, rgba(0, 0, 0, 0.08));
        max-height: 40%;
        overflow: auto;
        padding: 6px 10px;
      }
      .detail-head {
        display: flex;
        justify-content: space-between;
        color: var(--text-tertiary, #86868b);
      }
      .detail pre {
        margin: 4px 0 0;
        white-space: pre-wrap;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
    `,
  ],
})
export class PineLogsPaneComponent implements OnDestroy {
  readonly logs = input<readonly PineLogOutput[]>([]);
  readonly droppedLogs = input(0);
  readonly runtimeError = input<PineRuntimeError | null>(null);
  readonly timezone = input('UTC');

  /** "Scroll to bar": a bar_index. */
  readonly barJump = output<number>();
  /** "Source code": a script line. */
  readonly lineJump = output<PineLineJump>();

  protected readonly levels: readonly LogLevel[] = ['info', 'warning', 'error'];
  readonly filter = signal<LogFilter>({
    ...DEFAULT_LOG_FILTER,
    levels: { ...DEFAULT_LOG_FILTER.levels },
  });
  readonly selected = signal<number | null>(null);
  private readonly scrollTop = signal(0);
  private readonly viewportHeight = signal(240);
  private readonly viewport = viewChild<ElementRef<HTMLDivElement>>('viewport');
  private resizeObserver: ResizeObserver | null = null;

  readonly result = computed(() => filterLogs(this.logs(), this.filter(), this.timezone()));

  readonly window = computed(() => {
    const rows = this.result().rows;
    const start = Math.max(0, Math.floor(this.scrollTop() / ROW_H) - OVERSCAN);
    const end = Math.min(
      rows.length,
      Math.ceil((this.scrollTop() + this.viewportHeight()) / ROW_H) + OVERSCAN,
    );
    return { rows: rows.slice(start, end), offset: start * ROW_H, total: rows.length * ROW_H };
  });

  readonly selectedRow = computed<LogRow | null>(() => {
    const i = this.selected();
    return i === null ? null : (this.result().rows.find((r) => r.index === i) ?? null);
  });

  readonly fromInput = computed(() => {
    const t = this.filter().fromTime;
    return t === null ? '' : new Date(t).toISOString().slice(0, 16);
  });

  constructor() {
    afterNextRender(() => {
      const el = this.viewport()?.nativeElement;
      if (!el) return;
      this.viewportHeight.set(el.clientHeight || 240);
      if (typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver(() =>
          this.viewportHeight.set(el.clientHeight || 240),
        );
        this.resizeObserver.observe(el);
      }
      this.scrollToEnd();
    });
    // New logs arrive at the bottom (Pine Logs shows the newest last): follow them.
    effect(() => {
      this.logs();
      untracked(() => {
        this.selected.set(null);
        queueMicrotask(() => this.scrollToEnd());
      });
    });
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
  }

  protected levelLabel(l: LogLevel): string {
    return l === 'info' ? 'Info' : l === 'warning' ? 'Warning' : 'Error';
  }

  toggleLevel(level: LogLevel): void {
    this.filter.update((f) => ({ ...f, levels: { ...f.levels, [level]: !f.levels[level] } }));
  }

  patch(p: Partial<LogFilter>): void {
    this.filter.update((f) => ({ ...f, ...p }));
  }

  setFrom(value: string): void {
    const t = value ? Date.parse(`${value}:00Z`) : NaN;
    this.patch({ fromTime: Number.isFinite(t) ? t : null });
  }

  select(r: LogRow): void {
    this.selected.set(this.selected() === r.index ? null : r.index);
  }

  protected onScroll(): void {
    this.scrollTop.set(this.viewport()?.nativeElement.scrollTop ?? 0);
  }

  private scrollToEnd(): void {
    const el = this.viewport()?.nativeElement;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    this.scrollTop.set(el.scrollTop);
  }
}
