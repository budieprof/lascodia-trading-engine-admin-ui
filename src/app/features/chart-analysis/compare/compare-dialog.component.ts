import {
  ChangeDetectionStrategy,
  Component,
  type ElementRef,
  afterNextRender,
  computed,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  COMPARE_COLOURS,
  MAX_BASKET,
  MAX_COMPARE_SERIES,
  compareTitle,
  specProblem,
  type CompareKind,
  type CompareSeriesSpec,
} from './compare-series';

/**
 * Compare and synthetic series (CC-I12): add another symbol as a percent overlay, a ratio or spread of two symbols, or
 * a weighted basket — and remove what is on the chart. Computed in the browser for display; the dialog says so.
 */
@Component({
  selector: 'app-compare-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dlg class="cd" tabindex="-1" aria-labelledby="cd-title" (keydown.escape)="$event.preventDefault(); closed.emit()">
      <header class="cd-head">
        <h2 id="cd-title">Compare</h2>
        <button type="button" class="cd-x" (click)="closed.emit()" aria-label="Close">×</button>
      </header>
      <div class="cd-body">
        @if (series().length) {
          <ul class="cd-list" aria-label="On the chart">
            @for (s of series(); track s.id) {
              <li>
                <span class="cd-swatch" [style.background]="s.color"></span>
                <span class="cd-name">{{ title(s) }}</span>
                <span class="cd-kind">{{ kindLabel(s.kind) }}</span>
                <button type="button" class="cd-link" (click)="remove.emit(s.id)" [attr.aria-label]="'Remove ' + title(s)">
                  Remove
                </button>
              </li>
            }
          </ul>
        }
        <label class="cd-row">
          <span>Add</span>
          <select [value]="kind()" (change)="kind.set($any($event.target).value)" aria-label="What to add">
            <option value="compare">Compare symbol (%, on the price)</option>
            <option value="ratio">Ratio A ÷ B</option>
            <option value="spread">Spread A − m × B</option>
            <option value="basket">Basket</option>
          </select>
        </label>
        @switch (kind()) {
          @case ('compare') {
            <label class="cd-row">
              <span>Symbol</span>
              <select [value]="symA()" (change)="symA.set($any($event.target).value)" aria-label="Symbol to compare">
                <option value="">Choose…</option>
                @for (s of others(); track s) {
                  <option [value]="s">{{ s }}</option>
                }
              </select>
            </label>
            <p class="cd-note">The price scale switches to Percent: every line starts at 0 % on the first bar on screen.</p>
          }
          @case ('basket') {
            @for (m of basket(); track $index; let i = $index) {
              <div class="cd-row">
                <select [value]="m.symbol" (change)="setMember(i, $any($event.target).value, m.weight)" [attr.aria-label]="'Member ' + (i + 1)">
                  <option value="">Choose…</option>
                  @for (s of symbols(); track s) {
                    <option [value]="s">{{ s }}</option>
                  }
                </select>
                <label class="cd-weight">
                  Weight
                  <input type="number" min="0.01" step="0.1" [value]="m.weight" (input)="setMember(i, m.symbol, +$any($event.target).value)" />
                </label>
                @if (basket().length > 2) {
                  <button type="button" class="cd-link" (click)="removeMember(i)">Remove</button>
                }
              </div>
            }
            @if (basket().length < maxBasket) {
              <button type="button" class="cd-link" (click)="addMember()">Add a symbol</button>
            }
            <p class="cd-note">Each symbol starts at 100 on the first bar they all have; the basket is their weighted average.</p>
          }
          @default {
            <label class="cd-row">
              <span>A</span>
              <select [value]="symA()" (change)="symA.set($any($event.target).value)" aria-label="Symbol A">
                @for (s of symbols(); track s) {
                  <option [value]="s">{{ s }}</option>
                }
              </select>
            </label>
            <label class="cd-row">
              <span>B</span>
              <select [value]="symB()" (change)="symB.set($any($event.target).value)" aria-label="Symbol B">
                <option value="">Choose…</option>
                @for (s of symbols(); track s) {
                  <option [value]="s">{{ s }}</option>
                }
              </select>
            </label>
            @if (kind() === 'spread') {
              <label class="cd-row">
                <span>Multiplier m</span>
                <input type="number" step="0.1" [value]="mult()" (input)="mult.set(+$any($event.target).value)" />
              </label>
            }
          }
        }
        @if (problem(); as why) {
          <p class="cd-warn" role="alert">{{ why }}</p>
        }
        <p class="cd-note">Computed in this browser from the chart's bars, for display — not an instrument scripts or orders can use.</p>
      </div>
      <footer class="cd-foot">
        <button type="button" class="cd-btn" (click)="closed.emit()">Close</button>
        <button type="button" class="cd-btn primary" [disabled]="!!problem() || full()" (click)="submit()">
          {{ full() ? 'At most ' + maxSeries + ' on a chart' : 'Add' }}
        </button>
      </footer>
    </dialog>
  `,
  styles: `
    .cd {
      width: min(480px, calc(100vw - 32px));
      padding: 0;
      border: 1px solid var(--border, #e0e3eb);
      border-radius: 8px;
      background: var(--surface, #fff);
      color: var(--text, #131722);
      font-size: 13px;
    }
    .cd::backdrop {
      background: rgba(0, 0, 0, 0.35);
    }
    .cd-head,
    .cd-foot {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 16px;
    }
    .cd-head h2 {
      flex: 1;
      margin: 0;
      font-size: 16px;
    }
    .cd-foot {
      justify-content: flex-end;
      border-top: 1px solid var(--border, #e0e3eb);
    }
    .cd-x {
      border: none;
      background: none;
      color: inherit;
      font-size: 20px;
      cursor: pointer;
    }
    .cd-body {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 12px 16px;
      border-top: 1px solid var(--border, #e0e3eb);
    }
    .cd-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .cd-list li {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .cd-swatch {
      width: 10px;
      height: 10px;
      border-radius: 2px;
    }
    .cd-name {
      flex: 1;
    }
    .cd-kind,
    .cd-note {
      color: var(--text-muted, #787b86);
      font-size: 12px;
    }
    .cd-note {
      margin: 0;
    }
    .cd-warn {
      margin: 0;
      color: var(--tv-orange, #f57c00);
    }
    .cd-row {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .cd-row > span {
      min-width: 90px;
    }
    .cd-weight {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .cd-weight input {
      width: 64px;
    }
    select,
    input {
      border: 1px solid var(--border, #e0e3eb);
      border-radius: 4px;
      background: transparent;
      color: inherit;
      font: inherit;
      padding: 3px 6px;
    }
    .cd-link {
      align-self: flex-start;
      border: none;
      background: none;
      padding: 0;
      color: var(--tv-blue, #2962ff);
      font: inherit;
      cursor: pointer;
    }
    .cd-btn {
      border: 1px solid var(--border, #e0e3eb);
      border-radius: 6px;
      background: transparent;
      color: inherit;
      font: inherit;
      padding: 5px 14px;
      cursor: pointer;
    }
    .cd-btn.primary {
      border-color: var(--tv-blue, #2962ff);
      background: var(--tv-blue, #2962ff);
      color: #fff;
    }
    .cd-btn:disabled {
      opacity: 0.5;
      cursor: default;
    }
  `,
})
export class CompareDialogComponent {
  /** What is on the chart now. */
  readonly series = input<readonly CompareSeriesSpec[]>([]);
  /** Every symbol the chart can load. */
  readonly symbols = input<readonly string[]>([]);
  readonly chartSymbol = input<string>('');
  readonly add = output<CompareSeriesSpec>();
  readonly remove = output<string>();
  readonly closed = output<void>();

  readonly maxBasket = MAX_BASKET;
  readonly maxSeries = MAX_COMPARE_SERIES;
  readonly kind = signal<CompareKind>('compare');
  readonly symA = signal('');
  readonly symB = signal('');
  readonly mult = signal(1);
  readonly basket = signal<{ symbol: string; weight: number }[]>([
    { symbol: '', weight: 1 },
    { symbol: '', weight: 1 },
  ]);
  private readonly dlg = viewChild<ElementRef<HTMLDialogElement>>('dlg');

  /** Symbols other than the chart's (what "compare" offers). */
  readonly others = computed(() => this.symbols().filter((s) => s !== this.chartSymbol()));
  readonly full = computed(() => this.series().length >= MAX_COMPARE_SERIES);
  readonly draft = computed<CompareSeriesSpec>(() => {
    const kind = this.kind();
    const used = new Set(this.series().map((s) => s.color));
    const color = COMPARE_COLOURS.find((c) => !used.has(c)) ?? COMPARE_COLOURS[this.series().length % COMPARE_COLOURS.length];
    const base = { id: '', kind, color };
    if (kind === 'compare') return { ...base, symbols: [this.symA()].filter(Boolean) };
    if (kind === 'basket') {
      const members = this.basket().filter((m) => m.symbol);
      return { ...base, symbols: members.map((m) => m.symbol), weights: members.map((m) => m.weight) };
    }
    const a = this.symA() || this.chartSymbol();
    return {
      ...base,
      symbols: [a, this.symB()].filter(Boolean),
      ...(kind === 'spread' ? { mult: this.mult() } : {}),
    };
  });
  readonly problem = computed(() => specProblem(this.draft()));

  constructor() {
    afterNextRender(() => {
      const el = this.dlg()?.nativeElement;
      if (el && !el.open) el.showModal?.();
    });
  }

  title(s: CompareSeriesSpec): string {
    return compareTitle(s);
  }

  kindLabel(k: CompareKind): string {
    return k === 'compare' ? 'compare %' : k;
  }

  setMember(i: number, symbol: string, weight: number): void {
    this.basket.update((l) => l.map((m, k) => (k === i ? { symbol, weight } : m)));
  }

  addMember(): void {
    this.basket.update((l) => (l.length < MAX_BASKET ? [...l, { symbol: '', weight: 1 }] : l));
  }

  removeMember(i: number): void {
    this.basket.update((l) => (l.length > 2 ? l.filter((_, k) => k !== i) : l));
  }

  submit(): void {
    if (this.problem() || this.full()) return;
    this.add.emit({ ...this.draft(), id: `c${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}` });
    this.symA.set('');
    this.symB.set('');
  }
}
