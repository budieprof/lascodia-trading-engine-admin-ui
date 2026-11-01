import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  computed,
  input,
  output,
  signal,
} from '@angular/core';

import { isValidSymbolName } from './ea-config-fields';

export interface SymbolOption {
  symbol: string;
  /** Section heading in the list, e.g. "FX majors". */
  group: string;
  /** Sort position of the group (FX majors before indices, …). */
  groupRank: number;
  /** Another live EA on the same account already owns it ("LASC-EURUSD-…"). */
  takenBy: string | null;
}

interface ListRow {
  kind: 'head' | 'opt' | 'custom';
  text: string;
  opt?: SymbolOption;
  index: number;
}

/**
 * Pick symbols from a list instead of typing a CSV. Chips show the change
 * against what the EA owns now: new ones are marked, removed ones stay
 * visible (struck through) until the change is pushed, so a slip is one
 * click to undo.
 */
@Component({
  selector: 'app-ea-symbol-picker',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sp" [class.disabled]="disabled()">
      <div class="chips">
        @for (c of chips(); track c.symbol) {
          <span
            class="chip"
            [class.added]="c.state === 'added'"
            [class.removed]="c.state === 'removed'"
            [title]="
              c.state === 'added'
                ? 'New — added when you save'
                : c.state === 'removed'
                  ? 'Removed when you save'
                  : 'Owned now'
            "
          >
            @if (c.state === 'added') {
              <span class="mark" aria-hidden="true">+</span>
            }
            {{ c.symbol }}
            @if (c.state === 'removed') {
              <button
                type="button"
                class="chip-btn undo"
                (click)="add(c.symbol)"
                [disabled]="disabled()"
              >
                Undo
              </button>
            } @else {
              <button
                type="button"
                class="chip-btn"
                (click)="remove(c.symbol)"
                [disabled]="disabled() || value().length <= 1"
                [attr.aria-label]="'Remove ' + c.symbol"
                [title]="value().length <= 1 ? 'An EA needs at least one symbol' : 'Remove'"
              >
                ×
              </button>
            }
          </span>
        }
        <div class="add">
          <input
            #q
            type="text"
            class="add-input"
            placeholder="+ Add symbol"
            autocomplete="off"
            spellcheck="false"
            role="combobox"
            aria-label="Add a symbol"
            [attr.aria-expanded]="open()"
            [value]="query()"
            [disabled]="disabled()"
            (input)="onQuery($any($event.target).value)"
            (focus)="open.set(true)"
            (blur)="closeSoon()"
            (keydown)="onKey($event)"
          />
          @if (open()) {
            <div class="menu" role="listbox" (mousedown)="$event.preventDefault()">
              @if (rows().length === 0) {
                <div class="empty">
                  @if (query()) {
                    No instrument matches “{{ query() }}”.
                  } @else {
                    Every instrument is already added.
                  }
                </div>
              }
              @for (r of rows(); track r.kind + r.text) {
                @switch (r.kind) {
                  @case ('head') {
                    <div class="head">{{ r.text }}</div>
                  }
                  @case ('custom') {
                    <button
                      type="button"
                      class="opt custom"
                      [class.hl]="hl() === r.index"
                      (mouseenter)="hl.set(r.index)"
                      (click)="add(r.text)"
                    >
                      <span>Add “{{ r.text }}” anyway</span>
                      <span class="why">not an engine instrument — check the spelling</span>
                    </button>
                  }
                  @default {
                    <button
                      type="button"
                      class="opt"
                      role="option"
                      [class.hl]="hl() === r.index"
                      [disabled]="!!r.opt!.takenBy"
                      (mouseenter)="hl.set(r.index)"
                      (click)="add(r.opt!.symbol)"
                    >
                      <span class="sym">{{ r.opt!.symbol }}</span>
                      @if (r.opt!.takenBy) {
                        <span class="why" [title]="r.opt!.takenBy"
                          >owned by {{ shortId(r.opt!.takenBy) }}</span
                        >
                      }
                    </button>
                  }
                }
              }
            </div>
          }
        </div>
      </div>
      <div class="foot">
        {{ value().length }} symbol{{ value().length === 1 ? '' : 's' }}
        @if (addedCount() > 0) {
          · <span class="plus">+{{ addedCount() }} new</span>
        }
        @if (removedCount() > 0) {
          · <span class="minus">−{{ removedCount() }} removed</span>
        }
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .sp.disabled {
        opacity: 0.6;
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
        padding: 6px;
        min-height: 40px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
      }
      .chips:focus-within {
        border-color: var(--accent);
      }
      .chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        height: 26px;
        padding: 0 4px 0 9px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        font-family: var(--font-mono);
        font-size: 12px;
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .chip.added {
        background: rgba(52, 199, 89, 0.14);
        color: var(--tone-green, #1f9d55);
      }
      .chip.removed {
        background: transparent;
        border: 1px dashed var(--border);
        color: var(--text-tertiary);
        text-decoration: line-through;
      }
      .mark {
        font-weight: 700;
      }
      .chip-btn {
        border: none;
        background: transparent;
        color: inherit;
        cursor: pointer;
        font: inherit;
        font-size: 14px;
        line-height: 1;
        width: 20px;
        height: 20px;
        border-radius: 50%;
        opacity: 0.6;
        text-decoration: none;
      }
      .chip-btn:hover:not(:disabled) {
        opacity: 1;
        background: rgba(0, 0, 0, 0.07);
      }
      .chip-btn:disabled {
        cursor: default;
        opacity: 0.25;
      }
      .chip-btn.undo {
        width: auto;
        padding: 0 7px;
        border-radius: var(--radius-full);
        font-family: var(--font-sans, inherit);
        font-size: 11px;
        font-weight: var(--font-semibold);
        color: var(--accent);
        opacity: 1;
      }
      .add {
        position: relative;
        flex: 1 0 130px;
      }
      .add-input {
        width: 100%;
        height: 26px;
        border: none;
        outline: none;
        background: transparent;
        color: var(--text-primary);
        font-size: var(--text-sm);
        text-transform: uppercase;
      }
      .add-input::placeholder {
        text-transform: none;
        color: var(--accent);
        font-weight: var(--font-medium);
      }
      .menu {
        position: absolute;
        z-index: 20;
        top: calc(100% + 6px);
        left: -6px;
        width: 290px;
        max-height: 300px;
        overflow-y: auto;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg, 0 12px 32px rgba(0, 0, 0, 0.16));
        padding: 4px;
      }
      .head {
        padding: 8px 8px 3px;
        font-size: 10px;
        font-weight: var(--font-semibold);
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--text-tertiary);
      }
      .opt {
        display: flex;
        width: 100%;
        align-items: baseline;
        justify-content: space-between;
        gap: 8px;
        padding: 6px 8px;
        border: none;
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--text-primary);
        cursor: pointer;
        text-align: left;
        font: inherit;
      }
      .opt.hl:not(:disabled) {
        background: color-mix(in srgb, var(--accent, #0071e3) 12%, transparent);
      }
      .opt:disabled {
        cursor: not-allowed;
        color: var(--text-tertiary);
      }
      .sym {
        font-family: var(--font-mono);
        font-size: 12.5px;
        font-weight: var(--font-semibold);
      }
      .why {
        font-size: 11px;
        color: var(--text-tertiary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 170px;
      }
      .opt.custom {
        flex-direction: column;
        gap: 2px;
        border-top: 1px solid var(--border);
        border-radius: 0;
        margin-top: 4px;
        padding-top: 8px;
        font-size: var(--text-sm);
      }
      .opt.custom .why {
        color: var(--tone-amber, #b25000);
        max-width: none;
      }
      .empty {
        padding: 10px 8px;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .foot {
        margin-top: 5px;
        font-size: 11px;
        color: var(--text-tertiary);
      }
      .plus {
        color: var(--tone-green, #1f9d55);
        font-weight: var(--font-semibold);
      }
      .minus {
        color: var(--loss, #d70015);
        font-weight: var(--font-semibold);
      }
    `,
  ],
})
export class EaSymbolPickerComponent {
  readonly value = input.required<readonly string[]>();
  readonly original = input<readonly string[]>([]);
  readonly options = input<readonly SymbolOption[]>([]);
  readonly disabled = input(false);
  readonly valueChange = output<string[]>();

  protected readonly query = signal('');
  protected readonly open = signal(false);
  protected readonly hl = signal(0);
  @ViewChild('q') private qInput?: ElementRef<HTMLInputElement>;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly chips = computed(() => {
    const now = new Set(this.value());
    const orig = this.original();
    const out: { symbol: string; state: 'kept' | 'added' | 'removed' }[] = [];
    for (const s of orig) out.push({ symbol: s, state: now.has(s) ? 'kept' : 'removed' });
    for (const s of this.value()) if (!orig.includes(s)) out.push({ symbol: s, state: 'added' });
    return out;
  });
  protected readonly addedCount = computed(
    () => this.chips().filter((c) => c.state === 'added').length,
  );
  protected readonly removedCount = computed(
    () => this.chips().filter((c) => c.state === 'removed').length,
  );

  /** Grouped, filtered menu rows; `index` numbers the selectable rows for the keyboard. */
  protected readonly rows = computed<ListRow[]>(() => {
    const q = this.query().trim().toUpperCase();
    const chosen = new Set(this.value());
    const matches = this.options().filter(
      (o) => !chosen.has(o.symbol) && (!q || o.symbol.includes(q)),
    );
    // Exact / prefix matches first, available before taken, then A→Z.
    matches.sort(
      (a, b) =>
        (q ? 0 : a.groupRank - b.groupRank) ||
        rank(a.symbol, q) - rank(b.symbol, q) ||
        Number(!!a.takenBy) - Number(!!b.takenBy) ||
        a.symbol.localeCompare(b.symbol),
    );
    const out: ListRow[] = [];
    let i = 0;
    if (q) {
      for (const o of matches)
        out.push({ kind: 'opt', text: o.symbol, opt: o, index: o.takenBy ? -1 : i++ });
    } else {
      const groups = new Map<string, SymbolOption[]>();
      for (const o of matches) {
        const g = groups.get(o.group) ?? [];
        g.push(o);
        groups.set(o.group, g);
      }
      for (const [g, list] of groups) {
        out.push({ kind: 'head', text: g, index: -1 });
        for (const o of list)
          out.push({ kind: 'opt', text: o.symbol, opt: o, index: o.takenBy ? -1 : i++ });
      }
    }
    const known = this.options().some((o) => o.symbol === q);
    // Off-list entry only when nothing on the list matches — a typo then stands out.
    if (q && !known && matches.length === 0 && !chosen.has(q) && isValidSymbolName(q)) {
      out.push({ kind: 'custom', text: q, index: i++ });
    }
    return out;
  });

  private selectable(): ListRow[] {
    return this.rows().filter((r) => r.index >= 0);
  }

  protected onQuery(v: string): void {
    this.query.set(v.toUpperCase());
    this.hl.set(0);
    this.open.set(true);
  }

  protected onKey(ev: KeyboardEvent): void {
    const sel = this.selectable();
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      this.open.set(true);
      this.hl.set(Math.min(this.hl() + 1, Math.max(sel.length - 1, 0)));
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      this.hl.set(Math.max(this.hl() - 1, 0));
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      ev.stopPropagation();
      const row = sel.find((r) => r.index === this.hl()) ?? sel[0];
      if (row) this.add(row.text);
    } else if (ev.key === 'Escape') {
      ev.stopPropagation();
      this.open.set(false);
      this.query.set('');
    }
  }

  protected add(symbol: string): void {
    if (this.disabled() || this.value().includes(symbol)) return;
    // Keep the EA's current order; new symbols go at the end.
    this.valueChange.emit([...this.value(), symbol]);
    this.query.set('');
    this.hl.set(0);
    this.qInput?.nativeElement.focus();
  }

  protected remove(symbol: string): void {
    if (this.disabled() || this.value().length <= 1) return;
    this.valueChange.emit(this.value().filter((s) => s !== symbol));
  }

  protected closeSoon(): void {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => this.open.set(false), 120);
  }

  /** "LASC-EURUSD-1342…-A4369" → "LASC-EURUSD-…" — enough to recognise the sibling. */
  protected shortId(id: string): string {
    const parts = id.split('-');
    return parts.length > 2 ? `${parts[0]}-${parts[1]}-…` : id;
  }
}

function rank(symbol: string, q: string): number {
  if (!q) return 0;
  if (symbol === q) return 0;
  if (symbol.startsWith(q)) return 1;
  return 2;
}
