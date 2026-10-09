import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

import { formatBarTime } from '../core/format';
import type { PineDebugRequest, PineDebugResult } from '../model/pine-outputs.types';
import {
  MAX_WATCHES,
  debugProblems,
  debugRequest,
  emptyDraft,
  groupByScope,
  kindBadge,
  type DebugDraft,
} from './debugger-model';

/**
 * Pine debugger (PR-I11): watch expressions read after the script on every bar, a condition whose true bars are the hits
 * (a conditional breakpoint; none = every bar of the window), and the script's variables after a bar — the first hit's,
 * or the bar whose hit row is picked. A hit row moves the chart to its bar; "Trace" runs the expression trace there (the
 * "Why didn't it fire?" tab). The host runs the requests (`run`) and hands back the engine's findings (`result`).
 */
@Component({
  selector: 'app-pine-debugger-pane',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="controls" (submit)="submit($event)" aria-label="Debugger">
      <div class="watches">
        @for (w of draft().watches; track $index; let i = $index) {
          <label class="watch">
            <span class="sr-only">Watch {{ i + 1 }}</span>
            <input
              type="text"
              spellcheck="false"
              [placeholder]="i === 0 ? 'Watch, e.g. fast - slow' : 'Watch ' + (i + 1)"
              [value]="w"
              (input)="setWatch(i, $any($event.target).value)"
              [attr.data-testid]="'dbg-watch-' + i"
            />
            @if (draft().watches.length > 1) {
              <button
                type="button"
                class="icon"
                (click)="removeWatch(i)"
                [attr.aria-label]="'Remove watch ' + (i + 1)"
              >
                ×
              </button>
            }
          </label>
        }
        @if (draft().watches.length < maxWatches) {
          <button type="button" class="link" (click)="addWatch()">+ Watch</button>
        }
      </div>
      <div class="row">
        <label class="grow">
          <span>Stop where</span>
          <input
            type="text"
            spellcheck="false"
            placeholder="Condition, e.g. ta.crossover(fast, slow) — empty: every bar"
            [value]="draft().condition"
            (input)="patch({ condition: $any($event.target).value })"
            data-testid="dbg-condition"
          />
        </label>
        <label>
          <span>From bar</span>
          <input
            class="num"
            type="text"
            inputmode="numeric"
            placeholder="0"
            [value]="draft().fromBar"
            (input)="patch({ fromBar: $any($event.target).value })"
          />
        </label>
        <label>
          <span>To bar</span>
          <input
            class="num"
            type="text"
            inputmode="numeric"
            placeholder="last"
            [value]="draft().toBar"
            (input)="patch({ toBar: $any($event.target).value })"
          />
        </label>
        <button
          type="submit"
          class="run"
          [disabled]="!canRun() || running() || problems().length > 0"
          data-testid="dbg-run"
        >
          {{ running() ? 'Running…' : 'Run' }}
        </button>
      </div>
      @if (problems().length && touched()) {
        <p class="problem" role="status">{{ problems()[0] }}</p>
      }
      @if (!canRun()) {
        <p class="muted">
          Run the script first: the debugger runs the same script, symbol and timeframe.
        </p>
      }
    </form>

    @if (error(); as e) {
      <p class="error" role="alert" data-testid="dbg-error">{{ e }}</p>
    }

    @if (result(); as r) {
      <div class="results">
        <section class="hits" aria-label="Hits">
          <p class="summary" data-testid="dbg-summary">{{ summary() }}</p>
          @if (r.runtimeError; as err) {
            <p class="error">
              The script stopped on bar {{ err.barIndex ?? '?' }}: {{ err.message }}
            </p>
          }
          @if (r.hits.length) {
            <div class="table" role="table" aria-label="Bars where it stopped">
              <div class="head" role="row" [style.grid-template-columns]="columns()">
                <span role="columnheader">Bar</span>
                <span role="columnheader">Time</span>
                @for (w of r.watches; track $index) {
                  <span role="columnheader" class="mono" [title]="w">{{ w }}</span>
                }
                <span role="columnheader"></span>
              </div>
              @for (h of r.hits; track h.barIndex) {
                <div
                  class="tr"
                  role="row"
                  [class.active]="h.barIndex === r.stateBar"
                  [style.grid-template-columns]="columns()"
                  tabindex="0"
                  (click)="pick(h.barIndex)"
                  (keydown.enter)="pick(h.barIndex)"
                  data-testid="dbg-hit"
                >
                  <span class="num">{{ h.barIndex }}</span>
                  <span>{{ time(h.time) }}</span>
                  @for (v of h.watches; track $index) {
                    <span class="mono value" [title]="v">{{ v }}</span>
                  }
                  <button type="button" class="link" (click)="trace($event, h.barIndex)">
                    Trace
                  </button>
                </div>
              }
            </div>
          }
        </section>
        @if (r.stateBar !== null) {
          <section class="state" aria-label="Variables">
            <div class="state-head">
              <span data-testid="dbg-state-title"
                >Variables after bar {{ r.stateBar
                }}{{ r.stateTime !== null ? ' (' + time(r.stateTime) + ')' : '' }}</span
              >
              <input
                type="search"
                placeholder="Filter"
                [value]="filter()"
                (input)="filter.set($any($event.target).value)"
                aria-label="Filter variables"
              />
            </div>
            @for (g of groups(); track g.scope) {
              <div class="scope">{{ g.scope }}</div>
              @for (v of g.variables; track $index) {
                <div class="var" data-testid="dbg-var">
                  <span class="mono name">{{ v.name }}</span>
                  @if (badge(v.kind); as b) {
                    <span class="badge">{{ b }}</span>
                  }
                  <span class="type">{{ v.type }}</span>
                  <span class="mono value" [title]="v.value">{{ v.value }}</span>
                </div>
              }
            } @empty {
              <p class="muted">No variable matches.</p>
            }
          </section>
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
        color: var(--text-primary, #1d1d1f);
        overflow: auto;
      }
      .controls {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 6px 10px;
        border-bottom: 1px solid var(--border, rgba(0, 0, 0, 0.08));
      }
      .watches,
      .row {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        align-items: flex-end;
      }
      .watch {
        display: inline-flex;
        align-items: center;
        gap: 2px;
      }
      label > span:not(.sr-only) {
        display: block;
        color: var(--text-secondary, #6e6e73);
        font-size: 11px;
      }
      .grow {
        flex: 1 1 260px;
      }
      input {
        font: inherit;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        padding: 3px 6px;
        border: 1px solid var(--border, rgba(0, 0, 0, 0.15));
        border-radius: 6px;
        background: var(--bg-primary, #fff);
        color: inherit;
        min-width: 0;
        width: 100%;
        box-sizing: border-box;
      }
      .watch input {
        width: 200px;
      }
      input.num {
        width: 70px;
      }
      button {
        font: inherit;
        cursor: pointer;
      }
      .run {
        padding: 3px 12px;
        border-radius: 6px;
        border: 1px solid var(--accent, #0071e3);
        background: var(--accent, #0071e3);
        color: #fff;
      }
      .run:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .link,
      .icon {
        border: 0;
        background: transparent;
        color: var(--accent, #0071e3);
        padding: 0 4px;
      }
      .problem,
      .muted {
        margin: 0;
        color: var(--text-secondary, #6e6e73);
      }
      .error {
        margin: 6px 10px;
        color: var(--danger, #d70015);
      }
      .results {
        display: grid;
        grid-template-columns: minmax(0, 3fr) minmax(220px, 2fr);
        min-height: 0;
        flex: 1 1 auto;
      }
      @media (max-width: 720px) {
        .results {
          grid-template-columns: minmax(0, 1fr);
        }
      }
      .hits,
      .state {
        min-width: 0;
        overflow: auto;
      }
      .state {
        border-left: 1px solid var(--border, rgba(0, 0, 0, 0.08));
      }
      .summary {
        margin: 0;
        padding: 6px 10px;
        color: var(--text-secondary, #6e6e73);
      }
      .head,
      .tr {
        display: grid;
        gap: 8px;
        align-items: center;
        padding: 3px 10px;
      }
      .head {
        position: sticky;
        top: 0;
        background: var(--bg-secondary, #f5f5f7);
        font-weight: 600;
        color: var(--text-secondary, #6e6e73);
      }
      .head span,
      .value {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .tr {
        cursor: pointer;
        border-bottom: 1px solid var(--border, rgba(0, 0, 0, 0.04));
      }
      .tr:hover,
      .tr.active {
        background: var(--bg-secondary, #f5f5f7);
      }
      .num {
        font-variant-numeric: tabular-nums;
      }
      .mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .state-head {
        display: flex;
        gap: 8px;
        align-items: center;
        justify-content: space-between;
        padding: 6px 10px;
        font-weight: 600;
      }
      .state-head input {
        width: 120px;
      }
      .scope {
        padding: 4px 10px 2px;
        color: var(--text-secondary, #6e6e73);
        font-size: 11px;
      }
      .var {
        display: grid;
        grid-template-columns: minmax(70px, auto) auto minmax(50px, auto) minmax(0, 1fr);
        gap: 6px;
        align-items: center;
        padding: 2px 10px;
      }
      .badge {
        font-size: 10px;
        padding: 0 4px;
        border-radius: 4px;
        background: var(--bg-tertiary, #e8e8ed);
        color: var(--text-secondary, #6e6e73);
      }
      .type {
        color: var(--text-secondary, #6e6e73);
      }
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
      }
    `,
  ],
})
export class PineDebuggerPaneComponent {
  /** The engine's findings of the last debug run (null before one). */
  readonly result = input<PineDebugResult | null>(null);
  readonly running = input(false);
  /** Why the last debug run was refused or failed, in the engine's words. */
  readonly error = input<string | null>(null);
  /** False until there is a script run to debug. */
  readonly canRun = input(true);
  readonly timezone = input('UTC');

  /** A debug run to make (the host sends it with the chart's request). */
  readonly run = output<PineDebugRequest>();
  readonly barJump = output<number>();
  /** Run the expression trace on a bar. */
  readonly traceBar = output<number>();

  readonly maxWatches = MAX_WATCHES;
  readonly draft = signal<DebugDraft>(emptyDraft());
  readonly touched = signal(false);
  readonly filter = signal('');
  /** The request of the last run: a hit row reads the variables with exactly these watches. */
  private readonly lastRequest = signal<PineDebugRequest | null>(null);

  readonly problems = computed(() => debugProblems(this.draft()));
  readonly columns = computed(() => {
    const n = this.result()?.watches.length ?? 0;
    return `60px 130px ${'minmax(80px, 1fr) '.repeat(n)}50px`;
  });
  readonly groups = computed(() => groupByScope(this.result()?.state ?? [], this.filter()));
  readonly summary = computed(() => {
    const r = this.result();
    if (!r) return '';
    const where = r.condition ? ` where ${r.condition} was true` : '';
    const span = `between bar ${r.fromBar} and bar ${r.toBar}`;
    if (r.hitsTotal === 0) return `No bar ${span}${where}.`;
    const count = r.hitsTotal === 1 ? '1 bar' : `${r.hitsTotal.toLocaleString('en-US')} bars`;
    const listed = r.hits.length < r.hitsTotal ? ` The first ${r.hits.length} are listed.` : '';
    return `${count} ${span}${where}.${listed}`;
  });

  setWatch(i: number, value: string): void {
    this.draft.update((d) => ({ ...d, watches: d.watches.map((w, k) => (k === i ? value : w)) }));
  }

  addWatch(): void {
    this.draft.update((d) =>
      d.watches.length < MAX_WATCHES ? { ...d, watches: [...d.watches, ''] } : d,
    );
  }

  removeWatch(i: number): void {
    this.draft.update((d) => ({ ...d, watches: d.watches.filter((_, k) => k !== i) }));
  }

  patch(p: Partial<DebugDraft>): void {
    this.draft.update((d) => ({ ...d, ...p }));
  }

  submit(e: Event): void {
    e.preventDefault();
    this.touched.set(true);
    if (!this.canRun() || this.running() || this.problems().length > 0) return;
    const request = debugRequest(this.draft());
    this.lastRequest.set(request);
    this.run.emit(request);
  }

  /** A hit row: the chart goes to its bar and the variables are read there. */
  pick(bar: number): void {
    this.barJump.emit(bar);
    const last = this.lastRequest();
    if (!last || this.result()?.stateBar === bar || this.running()) return;
    this.run.emit({ ...last, stateAtBar: bar });
  }

  trace(e: Event, bar: number): void {
    e.stopPropagation();
    this.traceBar.emit(bar);
  }

  time(ms: number): string {
    return formatBarTime(ms, this.timezone());
  }

  badge(kind: string): string {
    return kindBadge(kind);
  }
}
