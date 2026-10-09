import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { ChartIconComponent } from '../../icons/chart-icon.component';
import { DrawingStore } from '../drawing-store.service';
import { byZ, isShownOn } from '../drawing-ops';
import { toolFor, type Drawing } from '../model';
import { formatResolution, type TvResolution } from '../../datafeed/resolution';

/**
 * TradingView's Object tree for the chart's drawings (DR-03, DR-I10).
 *
 * Lists every drawing of the symbol, top of the visual order first — including the ones its eye hides (marked, with
 * the eye to show them again: hiding used to be one-way) and the ones its Visibility tab keeps off this timeframe
 * (dimmed, with the timeframe it was made on). Each row: select, show / hide, lock / unlock, remove. Ctrl/Cmd-click
 * adds a row to the selection, Shift-click selects a range; with several selected, the header acts on all of them.
 */
@Component({
  selector: 'app-drawing-object-tree',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChartIconComponent],
  template: `
    <div class="ot" role="region" aria-label="Object tree" (pointerdown)="$event.stopPropagation()">
      <div class="ot-head">
        <span class="ot-title">Objects</span>
        <span class="ot-count">{{ rows().length }}</span>
        <button type="button" class="ot-icon" title="Close" (click)="closed.emit()">
          <app-chart-icon name="close" [size]="16" />
        </button>
      </div>
      @if (selection().length > 1) {
        <div class="ot-bulk" role="toolbar" aria-label="Selected drawings">
          <span>{{ selection().length }} selected</span>
          <button type="button" (click)="bulk('hide')">Hide</button>
          <button type="button" (click)="bulk('show')">Show</button>
          <button type="button" (click)="bulk('lock')">Lock</button>
          <button type="button" (click)="bulk('unlock')">Unlock</button>
          <button type="button" class="danger" (click)="bulk('remove')">Delete</button>
        </div>
      }
      <ul role="listbox" aria-multiselectable="true" aria-label="Drawings">
        @for (d of rows(); track d.id) {
          <li
            role="option"
            [attr.aria-selected]="selectedIds().has(d.id)"
            [class.selected]="selectedIds().has(d.id)"
            [class.off]="!shownHere(d)"
            [class.hidden]="d.hidden"
          >
            <button type="button" class="ot-row" (click)="pick($event, d.id)">
              <span class="ot-swatch" [style.background]="d.style.color"></span>
              <span class="ot-label">{{ label(d) }}</span>
              @if (!shownHere(d)) {
                <span
                  class="ot-note"
                  [title]="'Not shown on this timeframe (Visibility); drawn on ' + made(d)"
                >
                  {{ made(d) }}
                </span>
              }
            </button>
            <button
              type="button"
              class="ot-icon"
              [class.on]="d.hidden"
              [title]="d.hidden ? 'Show' : 'Hide'"
              [attr.aria-label]="(d.hidden ? 'Show ' : 'Hide ') + label(d)"
              (click)="store.setHidden(d.id, !d.hidden)"
            >
              <app-chart-icon [name]="d.hidden ? 'eye-off' : 'eye'" [size]="16" />
            </button>
            <button
              type="button"
              class="ot-icon"
              [class.on]="d.locked"
              [title]="d.locked ? 'Unlock' : 'Lock'"
              [attr.aria-label]="(d.locked ? 'Unlock ' : 'Lock ') + label(d)"
              (click)="store.toggleLock(d.id)"
            >
              <app-chart-icon [name]="d.locked ? 'lock' : 'unlock'" [size]="16" />
            </button>
            <button
              type="button"
              class="ot-icon danger"
              title="Remove"
              [attr.aria-label]="'Remove ' + label(d)"
              (click)="store.remove(d.id)"
            >
              <app-chart-icon name="trash" [size]="16" />
            </button>
          </li>
        }
      </ul>
    </div>
  `,
  styles: `
    .ot {
      position: absolute;
      top: 44px;
      right: 76px;
      z-index: 18;
      width: 280px;
      max-height: 360px;
      display: flex;
      flex-direction: column;
      background: var(--surface, #fff);
      border: 1px solid var(--border, #e6e9ef);
      border-radius: 8px;
      box-shadow: 0 8px 20px rgba(0, 0, 0, 0.16);
      font-size: 12px;
      overflow: hidden;
    }
    .ot-head {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 6px 4px 10px;
    }
    .ot-title {
      font-weight: 600;
      color: var(--text-muted, #787b86);
    }
    .ot-count {
      color: var(--text-muted, #787b86);
      flex: 1 1 auto;
    }
    .ot-bulk {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px;
      padding: 4px 10px 6px;
      border-bottom: 1px solid var(--border, #e6e9ef);
      span {
        margin-right: auto;
        color: var(--text-muted, #787b86);
      }
      button {
        border: 1px solid var(--border, #e6e9ef);
        border-radius: 4px;
        background: transparent;
        color: inherit;
        font: inherit;
        padding: 1px 6px;
        cursor: pointer;
      }
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 2px 0 6px;
      overflow-y: auto;
    }
    li {
      display: flex;
      align-items: center;
      &.selected {
        background: var(--accent-soft, rgba(41, 98, 255, 0.12));
      }
      &.off .ot-label,
      &.hidden .ot-label {
        color: var(--text-muted, #787b86);
      }
      &.hidden .ot-label {
        text-decoration: line-through;
      }
    }
    .ot-row {
      display: flex;
      align-items: center;
      gap: 7px;
      flex: 1 1 auto;
      min-width: 0;
      padding: 5px 4px 5px 10px;
      border: 0;
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .ot-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ot-note {
      margin-left: auto;
      font-size: 11px;
      color: var(--text-muted, #787b86);
    }
    .ot-swatch {
      width: 10px;
      height: 10px;
      border-radius: 2px;
      flex: 0 0 auto;
    }
    .ot-icon {
      display: inline-flex;
      align-items: center;
      border: 0;
      background: transparent;
      color: var(--text-muted, #787b86);
      cursor: pointer;
      padding: 4px 5px;
      &:hover,
      &.on {
        color: var(--text, #131722);
      }
      &.danger:hover {
        color: #ef5350;
      }
    }
    .danger {
      color: #ef5350;
    }
  `,
})
export class ObjectTreeComponent {
  readonly store = inject(DrawingStore);

  /** The chart's timeframe: drawings its Visibility keeps off it are dimmed. */
  readonly resolution = input.required<string>();
  /** The built-in studies' names by uid: a drawing in a study's pane says which (DR-I10). */
  readonly paneLabels = input<Readonly<Record<string, string>>>({});
  readonly closed = output<void>();

  /** The symbol's drawings, top of the visual order first (TradingView's tree order). */
  readonly rows = computed(() => byZ(this.store.symbolDrawings()).reverse());
  readonly selectedIds = this.store.selectedIds;
  readonly selection = computed(() => this.rows().filter((d) => this.selectedIds().has(d.id)));

  /** The row Shift-click ranges from. */
  private anchor: string | null = null;

  label(d: Drawing): string {
    const tool = toolFor(d.kind)?.label ?? d.kind;
    const text = d.style.text?.trim();
    const name = text ? `${tool} · ${text.length > 24 ? text.slice(0, 24) + '…' : text}` : tool;
    if (!d.pane) return name;
    // In a study's pane; the study gone, it is not drawn anywhere — said, so it can be found and removed.
    const study = this.paneLabels()[d.pane];
    return `${name} · ${study ? `in ${study}` : 'pane removed'}`;
  }

  shownHere(d: Drawing): boolean {
    return isShownOn(d, this.resolution());
  }

  made(d: Drawing): string {
    return d.resolution ? formatResolution(d.resolution as TvResolution) : '';
  }

  pick(ev: MouseEvent, id: string): void {
    if (ev.shiftKey && this.anchor) {
      const ids = this.rows().map((d) => d.id);
      const a = ids.indexOf(this.anchor);
      const b = ids.indexOf(id);
      if (a >= 0 && b >= 0) {
        const [from, to] = a < b ? [a, b] : [b, a];
        // The clicked row last, so it is the primary selection.
        const range = ids.slice(from, to + 1).filter((x) => x !== id);
        this.store.selectMany([...range, id]);
        return;
      }
    }
    this.anchor = id;
    if (ev.ctrlKey || ev.metaKey) this.store.toggleSelected(id);
    else this.store.selectedId.set(id);
  }

  bulk(action: 'hide' | 'show' | 'lock' | 'unlock' | 'remove'): void {
    const ids = this.selection().map((d) => d.id);
    if (!ids.length) return;
    if (action === 'remove') this.store.removeMany(ids);
    else if (action === 'hide' || action === 'show')
      this.store.setMany(ids, { hidden: action === 'hide' });
    else this.store.setMany(ids, { locked: action === 'lock' });
  }
}
