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
import { filterActions, type PaletteAction } from './chart-palette';

/**
 * The chart's command palette (CC-I11, ⌘⇧K / Ctrl+Shift+K): type to find a chart command — a timeframe, a style, an
 * indicator to add, a tool, an overlay — ↑ ↓ to choose, Enter to run, Esc to close. The page runs the chosen entry
 * through its chart command and says what happened.
 */
@Component({
  selector: 'app-chart-palette',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog
      #dlg
      class="cp"
      aria-label="Chart commands"
      tabindex="-1"
      (keydown.escape)="$event.preventDefault(); closed.emit()"
      (click)="onBackdrop($event)"
    >
      <div class="cp-box">
        <input
          #field
          class="cp-input"
          type="text"
          placeholder="Search chart commands — timeframe, style, indicator, tool…"
          autocomplete="off"
          spellcheck="false"
          aria-label="Search chart commands"
          role="combobox"
          aria-controls="cp-list"
          [attr.aria-activedescendant]="matches().length ? 'cp-' + active() : null"
          [value]="query()"
          (input)="onQuery($any($event.target).value)"
          (keydown)="onKey($event)"
        />
        <ul id="cp-list" class="cp-list" role="listbox">
          @for (a of matches(); track a.id; let i = $index) {
            <li
              [id]="'cp-' + i"
              role="option"
              class="cp-item"
              [class.on]="i === active()"
              [attr.aria-selected]="i === active()"
              tabindex="-1"
              (mouseenter)="active.set(i)"
              (click)="choose(a)"
              (keydown.enter)="choose(a)"
            >
              <span class="cp-title">{{ a.title }}</span>
              @if (a.confirm) {
                <span class="cp-warn">asks first</span>
              }
            </li>
          } @empty {
            <li class="cp-empty">No chart command matches “{{ query() }}”.</li>
          }
        </ul>
        <div class="cp-hint">↑ ↓ to choose · Enter to run · Esc to close</div>
      </div>
    </dialog>
  `,
  styles: `
    .cp {
      width: min(560px, calc(100vw - 32px));
      margin-top: 12vh;
      padding: 0;
      border: 1px solid var(--border, #e0e3eb);
      border-radius: 8px;
      background: var(--surface, #fff);
      color: var(--text, #131722);
    }
    .cp::backdrop {
      background: rgba(0, 0, 0, 0.3);
    }
    .cp-box {
      display: flex;
      flex-direction: column;
    }
    .cp-input {
      border: none;
      border-bottom: 1px solid var(--border, #e0e3eb);
      background: transparent;
      color: inherit;
      font: inherit;
      font-size: 15px;
      padding: 12px 16px;
      outline: none;
    }
    .cp-list {
      list-style: none;
      margin: 0;
      padding: 4px 0;
      max-height: 50vh;
      overflow-y: auto;
    }
    .cp-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 16px;
      cursor: pointer;
      font-size: 13px;
    }
    .cp-item.on {
      background: var(--surface-hover, rgba(41, 98, 255, 0.1));
    }
    .cp-title {
      flex: 1;
    }
    .cp-warn {
      color: var(--tv-orange, #f57c00);
      font-size: 11px;
    }
    .cp-empty {
      padding: 10px 16px;
      color: var(--text-muted, #787b86);
    }
    .cp-hint {
      padding: 6px 16px;
      border-top: 1px solid var(--border, #e0e3eb);
      color: var(--text-muted, #787b86);
      font-size: 11px;
    }
  `,
})
export class ChartPaletteComponent {
  readonly actions = input.required<readonly PaletteAction[]>();
  /** Entries run lately (ids), offered first on an empty search. */
  readonly recent = input<readonly string[]>([]);
  readonly run = output<PaletteAction>();
  readonly closed = output<void>();

  readonly query = signal('');
  readonly active = signal(0);
  readonly matches = computed(() => filterActions(this.actions(), this.query(), this.recent()));
  private readonly dlg = viewChild<ElementRef<HTMLDialogElement>>('dlg');
  private readonly field = viewChild<ElementRef<HTMLInputElement>>('field');

  constructor() {
    afterNextRender(() => {
      const el = this.dlg()?.nativeElement;
      if (el && !el.open) el.showModal?.();
      this.field()?.nativeElement.focus();
    });
  }

  onQuery(value: string): void {
    this.query.set(value);
    this.active.set(0);
  }

  onKey(ev: KeyboardEvent): void {
    const n = this.matches().length;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (n) this.active.set((this.active() + (ev.key === 'ArrowDown' ? 1 : n - 1)) % n);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const a = this.matches()[this.active()];
      if (a) this.choose(a);
    }
  }

  choose(a: PaletteAction): void {
    this.run.emit(a);
  }

  /** A click on the backdrop (the dialog element itself, outside its box) closes it. */
  onBackdrop(ev: MouseEvent): void {
    if (ev.target === this.dlg()?.nativeElement) this.closed.emit();
  }
}
