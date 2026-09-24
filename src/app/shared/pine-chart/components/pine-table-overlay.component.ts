import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { TableLayout } from '../render/render-model';
import { tableView, type TableView } from '../render/table-view';

/**
 * Pine tables as an HTML overlay over one pane: tables float at one of nine anchors and do not move
 * with the bars, so they are DOM, not canvas. Borders between cells are the grid gap showing the
 * table's border color through; merged cells span grid tracks; widths and heights given in % of the
 * pane are resolved against the pane size.
 */
@Component({
  selector: 'app-pine-table-overlay',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (t of views(); track t.id) {
      <div
        class="pine-table"
        [attr.data-position]="t.position"
        [style]="t.containerStyle"
        role="table"
        [attr.aria-label]="'Script table ' + t.id"
      >
        @for (c of t.cells; track c.key) {
          <div
            class="cell"
            role="cell"
            [style]="c.style"
            [class.has-tip]="!!c.tooltip"
            [attr.title]="c.tooltip"
          >
            {{ c.text }}
          </div>
        }
      </div>
    }
  `,
  styles: [
    `
      :host {
        position: absolute;
        inset: 0;
        pointer-events: none;
        overflow: hidden;
      }
      .pine-table {
        position: absolute;
        display: grid;
        box-sizing: border-box;
        max-width: 100%;
        max-height: 100%;
      }
      .pine-table[data-position^='top'] {
        top: 4px;
      }
      .pine-table[data-position^='middle'] {
        top: 50%;
        transform: translateY(-50%);
      }
      .pine-table[data-position^='bottom'] {
        bottom: 4px;
      }
      .pine-table[data-position$='left'] {
        left: 4px;
      }
      .pine-table[data-position$='right'] {
        right: 4px;
      }
      .pine-table[data-position$='center'] {
        left: 50%;
        transform: translateX(-50%);
      }
      .pine-table[data-position='middle_center'] {
        transform: translate(-50%, -50%);
      }
      .cell {
        box-sizing: border-box;
        display: flex;
        padding: 2px 6px;
        white-space: pre;
        line-height: 1.25;
        overflow: hidden;
        min-width: 0;
        min-height: 0;
      }
      .cell.has-tip {
        pointer-events: auto;
        cursor: help;
      }
    `,
  ],
})
export class PineTableOverlayComponent {
  readonly tables = input<readonly TableLayout[]>([]);
  /** Pane size in px (cell width/height percentages resolve against it). */
  readonly paneWidth = input(0);
  readonly paneHeight = input(0);

  readonly views = computed<TableView[]>(() =>
    this.tables().map((t) => tableView(t, this.paneWidth(), this.paneHeight())),
  );
}
