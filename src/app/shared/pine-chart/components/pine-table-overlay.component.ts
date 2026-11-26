import {
  afterRenderEffect,
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
 *
 * <p>A cell with a `tooltip` shows it at once, styled like the chart's label tooltips, on hover or
 * on a tap (touch has no hover; a second tap closes it). The table under such a cell does not fade
 * while its tooltip is open — a dashboard that explains itself on hover has to stay readable.</p>
 */
@Component({
  selector: 'app-pine-table-overlay',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (g of groups(); track g.position) {
      <div
        #group
        class="pine-tables"
        [attr.data-position]="g.position"
        [style.top.px]="
          g.position === 'top_left' || underLegend().has(g.position) ? 4 + topLeftOffset() : null
        "
      >
        @for (t of g.tables; track t.key) {
          <div
            #table
            class="pine-table"
            [attr.data-key]="t.key"
            [class.faded]="faded().has(t.key) && tip()?.table !== t.key"
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
                [class.tip-open]="tip()?.cell === c.key && tip()?.table === t.key"
                [attr.aria-description]="c.tooltip"
                (mouseenter)="c.tooltip && showTip(t.key, c.key, c.tooltip, $event, false)"
                (mousemove)="c.tooltip && moveTip($event)"
                (mouseleave)="hideTip(false)"
                (click)="c.tooltip && toggleTip(t.key, c.key, c.tooltip, $event)"
                [attr.tabindex]="c.tooltip ? 0 : null"
                (focus)="c.tooltip && focusTip(t.key, c.key, c.tooltip, $event)"
                (blur)="hideTip(true)"
                (keydown.escape)="hideTip(true)"
              >
                {{ c.text }}
              </div>
            }
          </div>
        }
      </div>
    }
    @if (tip(); as t) {
      <div
        class="cell-tip"
        role="tooltip"
        [class.flip-x]="t.flipX"
        [class.flip-y]="t.flipY"
        [style.left.px]="t.left"
        [style.top.px]="t.top"
      >
        {{ t.text }}
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
      .cell.has-tip:focus-visible {
        outline: 1px solid rgba(255, 255, 255, 0.5);
        outline-offset: -1px;
      }
      .cell.has-tip:hover,
      .cell.tip-open {
        box-shadow: inset 0 0 0 999px rgba(255, 255, 255, 0.08);
      }
      .cell-tip {
        position: absolute;
        z-index: 5;
        max-width: 340px;
        padding: 6px 8px;
        border-radius: 6px;
        border: 1px solid rgba(255, 255, 255, 0.14);
        background: rgba(19, 23, 34, 0.96);
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
        color: #fff;
        font-size: 12px;
        line-height: 1.4;
        white-space: pre-wrap;
        pointer-events: none;
      }
      .cell-tip.flip-x {
        transform: translateX(-100%);
      }
      .cell-tip.flip-y {
        transform: translateY(-100%);
      }
      .cell-tip.flip-x.flip-y {
        transform: translate(-100%, -100%);
      }
    `,
  ],
})
export class PineTableOverlayComponent {
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly tableEls = viewChildren<ElementRef<HTMLElement>>('table');
  private readonly groupEls = viewChildren<ElementRef<HTMLElement>>('group');

  readonly tables = input<readonly KeyedTable[]>([]);
  /** Pane size in px (cell width/height percentages resolve against it). */
  readonly paneWidth = input(0);
  readonly paneHeight = input(0);
  /** The pointer in the pane (pane px): the table under it fades. Null when it is elsewhere. */
  readonly pointer = input<{ x: number; y: number } | null>(null);
  /** Px kept free above the top-left corner's tables (a status line or legend sits there). */
  readonly topLeftOffset = input(0);
  /**
   * Px from the overlay's left where that top-left content ends (the chart's legend). A top-center or top-right
   * stack that would reach left of it goes below it too, so a wide legend never runs under a dashboard. 0: none.
   */
  readonly topLeftExtent = input(0);
  /** The top anchors (other than top_left) whose stacks are kept below the top-left content. */
  readonly underLegend = signal<ReadonlySet<string>>(new Set());

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

  /** The open cell tooltip: whose (table + cell key), its text and where (overlay px). */
  readonly tip = signal<CellTip | null>(null);
  /** The open tooltip came from a tap: the pointer leaving does not close it. */
  private pinned = false;

  showTip(table: string, cell: string, text: string, ev: MouseEvent, pin: boolean): void {
    this.pinned = pin;
    this.tip.set({ table, cell, text, ...this.placeAt(ev) });
  }

  moveTip(ev: MouseEvent): void {
    const cur = this.tip();
    if (cur && !this.pinned) this.tip.set({ ...cur, ...this.placeAt(ev) });
  }

  hideTip(force: boolean): void {
    if (force || !this.pinned) {
      this.pinned = false;
      this.tip.set(null);
    }
  }

  /** A tap opens the cell's tooltip and keeps it; a second tap on the same cell closes it. */
  toggleTip(table: string, cell: string, text: string, ev: MouseEvent): void {
    const cur = this.tip();
    if (cur && this.pinned && cur.table === table && cur.cell === cell) this.hideTip(true);
    else this.showTip(table, cell, text, ev, true);
  }

  /** Keyboard focus on a cell opens its tooltip under the cell (Escape or leaving it closes it). */
  focusTip(table: string, cell: string, text: string, ev: FocusEvent): void {
    const el = ev.target as HTMLElement | null;
    if (!el) return;
    const r = (this.host.nativeElement as HTMLElement).getBoundingClientRect();
    const c = el.getBoundingClientRect();
    this.pinned = true;
    this.tip.set({
      table,
      cell,
      text,
      ...placeCellTip(c.left - r.left, c.bottom - r.top, r.width, r.height),
    });
  }

  private placeAt(ev: MouseEvent): Pick<CellTip, 'left' | 'top' | 'flipX' | 'flipY'> {
    const r = (this.host.nativeElement as HTMLElement).getBoundingClientRect();
    return placeCellTip(ev.clientX - r.left, ev.clientY - r.top, r.width, r.height);
  }

  constructor() {
    // After each render: measure where the top-center / top-right stacks start across (moving one down does not
    // change that, so this settles in one pass) and keep the ones that would cover the legend below it.
    afterRenderEffect({
      earlyRead: () => {
        const extent = this.topLeftExtent();
        const offset = this.topLeftOffset();
        this.groups();
        return topStacksUnderLegend(
          this.groupEls().map((ref) => ({
            position: ref.nativeElement.getAttribute('data-position') ?? '',
            left: ref.nativeElement.offsetLeft,
          })),
          extent,
          offset,
        );
      },
      write: (next) => {
        const set = next();
        const cur = untracked(() => this.underLegend());
        if (set.size !== cur.size || [...set].some((p) => !cur.has(p))) this.underLegend.set(set);
      },
    });
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

/** Gap kept between the top-left content and a top stack beside it before the stack has to go below, px. */
const LEGEND_GAP = 8;

/**
 * The top-center / top-right stacks that would cover the top-left content (the legend): those starting less than
 * {@link LEGEND_GAP} px right of where it ends. None when nothing sits there (`offset` 0) or its extent is unknown.
 */
export function topStacksUnderLegend(
  stacks: readonly { position: string; left: number }[],
  extent: number,
  offset: number,
): ReadonlySet<string> {
  const out = new Set<string>();
  if (extent <= 0 || offset <= 0) return out;
  for (const s of stacks)
    if ((s.position === 'top_center' || s.position === 'top_right') && s.left < extent + LEGEND_GAP)
      out.add(s.position);
  return out;
}

/** A table cell's tooltip as the overlay shows it. */
export interface CellTip {
  table: string;
  cell: string;
  text: string;
  left: number;
  top: number;
  /** Anchored by its right / bottom edge (opens toward the free side near the edges). */
  flipX: boolean;
  flipY: boolean;
}

/** Room a tooltip needs before it flips to the other side of the pointer, px. */
const TIP_ROOM_X = 360;
const TIP_ROOM_Y = 160;
/** Gap between the pointer and the tooltip, px. */
const TIP_GAP = 14;

/**
 * Where a cell tooltip goes for a pointer at (x, y) in a `width` × `height` overlay: beside it,
 * toward the free side, so a dashboard in the right or bottom corner keeps its tooltips on screen.
 */
export function placeCellTip(
  x: number,
  y: number,
  width: number,
  height: number,
): Pick<CellTip, 'left' | 'top' | 'flipX' | 'flipY'> {
  const flipX = x > width - TIP_ROOM_X;
  const flipY = y > height - TIP_ROOM_Y;
  return {
    left: x + (flipX ? -TIP_GAP : TIP_GAP),
    top: y + (flipY ? -TIP_GAP : TIP_GAP),
    flipX,
    flipY,
  };
}

/**
 * The tables a pointer at `p` (px in the overlay) is over: each table's `rect` and the overlay's
 * `origin` are viewport rects.
 */
export function tablesUnder(
  p: { x: number; y: number } | null,
  origin: { left: number; top: number },
  tables: readonly {
    key: string;
    rect: { left: number; top: number; right: number; bottom: number };
  }[],
): ReadonlySet<string> {
  const out = new Set<string>();
  if (!p) return out;
  const x = p.x + origin.left;
  const y = p.y + origin.top;
  for (const { key, rect: r } of tables)
    if (key && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) out.add(key);
  return out;
}
