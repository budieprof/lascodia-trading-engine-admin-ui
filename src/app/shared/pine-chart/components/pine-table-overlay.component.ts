import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChildren,
} from '@angular/core';
import type { TableLayout } from '../render/render-model';
import { tableView, type TableView } from '../render/table-view';

/** The nine anchors, in the order their groups are laid out. */
const POSITIONS = [
  'top_left',
  'top_center',
  'top_right',
  'middle_left',
  'middle_center',
  'middle_right',
  'bottom_left',
  'bottom_center',
  'bottom_right',
] as const;

/** Tables sharing one anchor, stacked in the order they come (PC-I11). */
interface TableGroup {
  position: string;
  tables: (TableView & { key: string })[];
}

/** A table keyed for this overlay: its own `key` when several scripts share the pane, else its id. */
export type KeyedTable = TableLayout & { key?: string };

/**
 * Pine tables as an HTML overlay over one pane: tables float at one of nine anchors and do not move
 * with the bars, so they are DOM, not canvas. Borders between cells are the grid gap showing the
 * table's border color through; merged cells span grid tracks; widths and heights given in % of the
 * pane are resolved against the pane size.
 *
 * <p>Tables at the same anchor — two scripts' dashboards in the top-right corner — stack one under
 * the other instead of covering each other; a table the pointer is over fades so the bars under it
 * can be read; `topLeftOffset` keeps the top-left corner's tables below a status line there
 * (PC-I11).</p>
 */
@Component({
  selector: 'app-pine-table-overlay',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (g of groups(); track g.position) {
      <div
        class="pine-tables"
        [attr.data-position]="g.position"
        [style.top.px]="g.position === 'top_left' ? 4 + topLeftOffset() : null"
      >
        @for (t of g.tables; track t.key) {
          <div
            #table
            class="pine-table"
            [attr.data-key]="t.key"
            [class.faded]="faded().has(t.key)"
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
      .pine-tables {
        position: absolute;
        display: flex;
        flex-direction: column;
        gap: 4px;
        max-width: 100%;
        max-height: 100%;
      }
      .pine-tables[data-position^='top'] {
        top: 4px;
      }
      .pine-tables[data-position^='middle'] {
        top: 50%;
        transform: translateY(-50%);
      }
      .pine-tables[data-position^='bottom'] {
        bottom: 4px;
      }
      .pine-tables[data-position$='left'] {
        left: 4px;
        align-items: flex-start;
      }
      .pine-tables[data-position$='right'] {
        right: 4px;
        align-items: flex-end;
      }
      .pine-tables[data-position$='center'] {
        left: 50%;
        transform: translateX(-50%);
        align-items: center;
      }
      .pine-tables[data-position='middle_center'] {
        transform: translate(-50%, -50%);
      }
      .pine-table {
        display: grid;
        box-sizing: border-box;
        max-width: 100%;
        transition: opacity var(--dur-fast, 0.15s);
      }
      .pine-table.faded {
        opacity: 0.15;
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
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly tableEls = viewChildren<ElementRef<HTMLElement>>('table');

  readonly tables = input<readonly KeyedTable[]>([]);
  /** Pane size in px (cell width/height percentages resolve against it). */
  readonly paneWidth = input(0);
  readonly paneHeight = input(0);
  /** The pointer in the pane (pane px): the table under it fades. Null when it is elsewhere. */
  readonly pointer = input<{ x: number; y: number } | null>(null);
  /** Px kept free above the top-left corner's tables (a status line or legend sits there). */
  readonly topLeftOffset = input(0);

  /** A table with no cell is not drawn at all — its frame alone would be a speck on the pane. */
  readonly views = computed<(TableView & { key: string })[]>(() =>
    this.tables()
      .map((t) => ({
        ...tableView(t, this.paneWidth(), this.paneHeight()),
        key: t.key ?? String(t.id),
      }))
      .filter((v) => v.cells.length > 0),
  );

  /** One stack per anchor in use, in the anchors' order. */
  readonly groups = computed<TableGroup[]>(() => {
    const byPosition = new Map<string, TableGroup['tables']>();
    for (const v of this.views()) {
      const list = byPosition.get(v.position);
      if (list) list.push(v);
      else byPosition.set(v.position, [v]);
    }
    return POSITIONS.filter((p) => byPosition.has(p)).map((position) => ({
      position,
      tables: byPosition.get(position)!,
    }));
  });

  /** Keys of the tables the pointer is over. */
  readonly faded = signal<ReadonlySet<string>>(new Set());

  constructor() {
    effect(() => {
      const p = this.pointer();
      this.tableEls();
      untracked(() => this.fadeAt(p));
    });
  }

  private fadeAt(p: { x: number; y: number } | null): void {
    const origin = (this.host.nativeElement as HTMLElement).getBoundingClientRect();
    const next = tablesUnder(
      p,
      origin,
      this.tableEls().map((ref) => ({
        key: ref.nativeElement.getAttribute('data-key') ?? '',
        rect: ref.nativeElement.getBoundingClientRect(),
      })),
    );
    const cur = this.faded();
    if (next.size !== cur.size || [...next].some((k) => !cur.has(k))) this.faded.set(next);
  }
}

/**
 * The tables a pointer at `p` (px in the overlay) is over: each table's `rect` and the overlay's
 * `origin` are viewport rects.
 */
export function tablesUnder(
  p: { x: number; y: number } | null,
  origin: { left: number; top: number },
  tables: readonly { key: string; rect: { left: number; top: number; right: number; bottom: number } }[],
): ReadonlySet<string> {
  const out = new Set<string>();
  if (!p) return out;
  const x = p.x + origin.left;
  const y = p.y + origin.top;
  for (const { key, rect: r } of tables)
    if (key && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) out.add(key);
  return out;
}
