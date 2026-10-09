import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { SCRIPTING_UI_STYLES } from '../components/scripting-ui.styles';
import {
  FILTER_OPS,
  MAX_SCREEN_FILTERS,
  describeFilter,
  opNeedsRange,
  opNeedsValue,
  type FilterColumnOption,
} from './screens.model';
import type { ScreenFilter, ScreenFilterOp } from './screens.types';

let nextUid = 0;

/**
 * The conditions a symbol must meet to MATCH a saved screen (§6a): a plot, a strategy figure, the alert count or one
 * alertcondition, on the screen's own timeframe or one of its extra ones. Every filter must pass. The engine judges
 * the match on every run; this only edits the list.
 */
@Component({
  selector: 'app-screen-filters-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="filters" data-testid="screen-filters">
      <datalist [id]="listId">
        @for (c of columns(); track c.value) {
          <option [value]="c.value">{{ c.label }}</option>
        }
      </datalist>
      @for (f of filters(); track $index; let i = $index) {
        <div class="filter" [attr.data-filter]="i">
          <label class="col">
            <span class="sr-only">Filter {{ i + 1 }} column</span>
            <input
              class="field-input"
              type="text"
              [attr.list]="listId"
              placeholder="Plot, figure or alert…"
              [value]="f.column"
              [disabled]="disabled()"
              (change)="patch(i, { column: $any($event.target).value })"
            />
          </label>
          <label>
            <span class="sr-only">Filter {{ i + 1 }} timeframe</span>
            <select
              class="field-input"
              [disabled]="disabled()"
              (change)="patch(i, { timeframe: $any($event.target).value || null })"
            >
              <option value="" [selected]="!f.timeframe">{{ mainTimeframe() }}</option>
              @for (tf of extraTimeframes(); track tf) {
                <option [value]="tf" [selected]="f.timeframe === tf">{{ tf }}</option>
              }
            </select>
          </label>
          <label>
            <span class="sr-only">Filter {{ i + 1 }} condition</span>
            <select
              class="field-input"
              [disabled]="disabled()"
              (change)="setOp(i, $any($event.target).value)"
            >
              @for (o of ops; track o.op) {
                <option [value]="o.op" [selected]="f.op === o.op">{{ o.label }}</option>
              }
            </select>
          </label>
          @if (needsValue(f.op)) {
            <label>
              <span class="sr-only">Filter {{ i + 1 }} value</span>
              <input
                class="field-input num"
                type="number"
                step="any"
                [value]="f.value ?? ''"
                [disabled]="disabled()"
                (change)="patch(i, { value: toNumber($any($event.target).value) })"
              />
            </label>
          }
          @if (needsRange(f.op)) {
            <span class="muted small">and</span>
            <label>
              <span class="sr-only">Filter {{ i + 1 }} upper bound</span>
              <input
                class="field-input num"
                type="number"
                step="any"
                [value]="f.value2 ?? ''"
                [disabled]="disabled()"
                (change)="patch(i, { value2: toNumber($any($event.target).value) })"
              />
            </label>
          }
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            [disabled]="disabled()"
            [attr.aria-label]="'Remove filter ' + (i + 1) + ': ' + describe(f)"
            (click)="remove(i)"
          >
            Remove
          </button>
        </div>
      } @empty {
        <p class="muted small">
          No filters: every symbol that runs matches. Alerts need at least one.
        </p>
      }
      <div class="foot">
        <button
          type="button"
          class="btn btn-sm"
          data-testid="add-filter"
          [disabled]="disabled() || filters().length >= max"
          (click)="add()"
        >
          Add filter
        </button>
        @if (filters().length > 1) {
          <span class="muted small">A symbol matches when every filter passes.</span>
        }
      </div>
    </div>
  `,
  styles: [
    SCRIPTING_UI_STYLES,
    `
      :host {
        display: block;
      }
      .filters {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .filter {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
      }
      .filter label {
        display: flex;
        min-width: 0;
      }
      .col {
        flex: 1 1 180px;
      }
      .col input {
        width: 100%;
      }
      .num {
        width: 110px;
      }
      .foot {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      p {
        margin: 0;
      }
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }
    `,
  ],
})
export class ScreenFiltersEditorComponent {
  readonly filters = input<readonly ScreenFilter[]>([]);
  /** Suggested columns (the results on screen); a column typed by hand is fine too. */
  readonly columns = input<readonly FilterColumnOption[]>([]);
  readonly mainTimeframe = input('');
  /** The screen's extra timeframes (engine names). */
  readonly extraTimeframes = input<readonly string[]>([]);
  readonly disabled = input(false);
  readonly filtersChange = output<ScreenFilter[]>();

  readonly ops = FILTER_OPS;
  readonly max = MAX_SCREEN_FILTERS;
  readonly listId = `scr-filter-cols-${nextUid++}`;

  needsValue(op: ScreenFilterOp): boolean {
    return opNeedsValue(op);
  }

  needsRange(op: ScreenFilterOp): boolean {
    return opNeedsRange(op);
  }

  describe(f: ScreenFilter): string {
    return describeFilter(f);
  }

  toNumber(text: string): number | null {
    if (text === null || text === undefined || String(text).trim() === '') return null;
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }

  add(): void {
    const first = this.columns()[0]?.value ?? '';
    this.filtersChange.emit([
      ...this.filters(),
      { column: first, timeframe: null, op: 'gt', value: null },
    ]);
  }

  remove(i: number): void {
    this.filtersChange.emit(this.filters().filter((_, j) => j !== i));
  }

  setOp(i: number, op: ScreenFilterOp): void {
    this.patch(i, { op });
  }

  patch(i: number, change: Partial<ScreenFilter>): void {
    this.filtersChange.emit(this.filters().map((f, j) => (j === i ? { ...f, ...change } : f)));
  }
}
