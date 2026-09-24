import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  linkedSignal,
  output,
  untracked,
} from '@angular/core';
import { formatBarTime } from '../core/format';
import type { PineTraceBar } from '../model/pine-outputs.types';
import type { PineLineJump } from './pine-logs-pane.component';
import { TraceNavigator, traceWindowAround } from './trace-model';

/**
 * "Why didn't it fire?": every traced expression of the script at one bar — its line and column,
 * source text and value (booleans colored), and what it was on the previous traced bar when that
 * differs. Pick the bar on the chart (the host binds the chart's bar clicks to `bar`) or step through
 * the trace window here; a row jumps the editor to its expression.
 */
@Component({
  selector: 'app-pine-trace-pane',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(keydown)': 'onKey($event)', tabindex: '0' },
  template: `
    <div class="toolbar">
      <button
        type="button"
        (click)="go(-1000000)"
        [disabled]="nav().empty"
        title="First traced bar"
      >
        ⏮
      </button>
      <button type="button" (click)="go(-1)" [disabled]="nav().empty" title="Previous bar (←)">
        ◀
      </button>
      <label class="bar">
        Bar
        <input
          type="number"
          [value]="current() ?? ''"
          (change)="pick(+$any($event.target).value)"
          aria-label="Bar index"
        />
      </label>
      <button type="button" (click)="go(1)" [disabled]="nav().empty" title="Next bar (→)">▶</button>
      <button type="button" (click)="go(1000000)" [disabled]="nav().empty" title="Last traced bar">
        ⏭
      </button>
      @if (current() !== null && nav().timeOf(current()!); as t) {
        <span class="time">{{ time(t) }}</span>
      }
      <span class="window">
        @if (nav().empty) {
          No trace
        } @else {
          Traced bars {{ nav().first }}–{{ nav().last }}
        }
      </span>
    </div>

    @if (rows(); as list) {
      <div class="table" role="table" aria-label="Traced expressions">
        <div class="head" role="row">
          <span role="columnheader">Line</span>
          <span role="columnheader">Expression</span>
          <span role="columnheader">Value</span>
          <span role="columnheader">Previous bar</span>
        </div>
        @for (r of list; track $index) {
          <div
            class="tr"
            role="row"
            tabindex="0"
            (click)="jump(r.line, r.column)"
            (keydown.enter)="jump(r.line, r.column)"
            [title]="'Go to line ' + r.line"
          >
            <span class="pos" role="cell">{{ r.line }}:{{ r.column }}</span>
            <code class="expr" role="cell">{{ r.text }}</code>
            <span class="val" role="cell" [class]="r.kind">{{ r.value }}</span>
            <span class="prev" role="cell">{{ r.previous ?? '' }}</span>
          </div>
        } @empty {
          <p class="note">Nothing was traced on this bar.</p>
        }
      </div>
    } @else {
      <div class="note">
        @if (current() === null) {
          Click a bar on the chart to see why the script's conditions did or did not fire there.
        } @else if (nav().empty) {
          This run has no trace.
          <button type="button" (click)="requestTrace.emit(windowFor(current()!))">
            Trace around bar {{ current() }}
          </button>
        } @else {
          Bar {{ current() }} is outside the traced window ({{ nav().first }}–{{ nav().last }}).
          <button type="button" (click)="requestTrace.emit(windowFor(current()!))">
            Trace around bar {{ current() }}
          </button>
        }
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
        outline: none;
        color: var(--text-primary, #1d1d1f);
      }
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        border-bottom: 1px solid var(--border, rgba(0, 0, 0, 0.08));
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
      button:disabled {
        opacity: 0.4;
        cursor: default;
      }
      .bar input {
        width: 80px;
        font: inherit;
        padding: 1px 4px;
        border-radius: 5px;
        border: 1px solid var(--border, rgba(0, 0, 0, 0.12));
        background: var(--bg-primary, #fff);
        color: inherit;
      }
      .time,
      .window {
        color: var(--text-secondary, #6e6e73);
      }
      .window {
        margin-left: auto;
      }
      .table {
        flex: 1 1 auto;
        overflow: auto;
      }
      .head,
      .tr {
        display: grid;
        grid-template-columns: 64px minmax(160px, 1fr) minmax(90px, 0.35fr) minmax(70px, 0.25fr);
        gap: 8px;
        align-items: baseline;
        padding: 3px 10px;
      }
      .head {
        position: sticky;
        top: 0;
        background: var(--bg-secondary, #f5f5f7);
        color: var(--text-secondary, #6e6e73);
        font-weight: 600;
        z-index: 1;
      }
      .tr {
        cursor: pointer;
        border-bottom: 1px solid var(--border, rgba(0, 0, 0, 0.04));
      }
      .tr:hover {
        background: var(--bg-secondary, #f5f5f7);
      }
      .pos {
        color: var(--text-tertiary, #86868b);
        font-variant-numeric: tabular-nums;
      }
      .expr {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .val {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-weight: 600;
        word-break: break-all;
      }
      .val.true {
        color: var(--profit, #248a3d);
      }
      .val.false {
        color: var(--loss, #d70015);
      }
      .val.na {
        color: var(--text-tertiary, #86868b);
        font-weight: 400;
      }
      .prev {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        color: var(--text-tertiary, #86868b);
        word-break: break-all;
      }
      .note {
        padding: 12px 10px;
        color: var(--text-secondary, #6e6e73);
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
      }
    `,
  ],
})
export class PineTracePaneComponent {
  readonly trace = input<readonly PineTraceBar[]>([]);
  /** The bar picked on the chart (bar_index). */
  readonly bar = input<number | null>(null);
  readonly timezone = input('UTC');
  /** Size of the trace window requested around a bar outside the current one. */
  readonly windowSize = input(100);

  /** The bar shown (stepping here moves the chart's highlight). */
  readonly barChange = output<number>();
  readonly lineJump = output<PineLineJump>();
  /** The picked bar is not traced: re-run with this trace window. */
  readonly requestTrace = output<{ fromBar: number; toBar: number }>();

  readonly nav = computed(() => new TraceNavigator(this.trace()));

  /** Follows the chart's pick; stepping here overrides it until the next pick. */
  readonly current = linkedSignal<number | null>(() => {
    const picked = this.bar();
    if (picked !== null) return picked;
    return untracked(this.nav).last;
  });

  readonly rows = computed(() => {
    const bar = this.current();
    return bar === null ? null : this.nav().rowsAt(bar);
  });

  constructor() {
    // A fresh trace with no pick yet shows its last bar.
    effect(() => {
      const nav = this.nav();
      untracked(() => {
        if (this.current() === null && nav.last !== null) this.current.set(nav.last);
      });
    });
  }

  go(delta: number): void {
    const nav = this.nav();
    const from = this.current() ?? nav.last;
    if (from === null) return;
    const next = nav.step(from, delta);
    if (next !== null) this.setBar(next);
  }

  pick(bar: number): void {
    if (Number.isFinite(bar)) this.setBar(Math.trunc(bar));
  }

  jump(line: number, column: number): void {
    this.lineJump.emit({ line, column });
  }

  protected windowFor(bar: number) {
    return traceWindowAround(bar, this.windowSize());
  }

  protected time(ms: number): string {
    return formatBarTime(ms, this.timezone());
  }

  protected onKey(e: KeyboardEvent): void {
    if ((e.target as HTMLElement | null)?.tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft') {
      this.go(-1);
      e.preventDefault();
    } else if (e.key === 'ArrowRight') {
      this.go(1);
      e.preventDefault();
    }
  }

  private setBar(bar: number): void {
    this.current.set(bar);
    this.barChange.emit(bar);
  }
}
