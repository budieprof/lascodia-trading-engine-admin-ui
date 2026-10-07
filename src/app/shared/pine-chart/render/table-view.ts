import type { TableCellLayout, TableLayout } from './render-model';

export interface TableCellView {
  key: string;
  text: string;
  tooltip: string | null;
  style: Record<string, string>;
}

export interface TableView {
  id: number;
  position: string;
  containerStyle: Record<string, string>;
  /** Empty when the table defines no cell — TradingView draws nothing for it, not even the frame. */
  cells: TableCellView[];
}

const JUSTIFY: Record<string, string> = { left: 'flex-start', center: 'center', right: 'flex-end' };
const ALIGN: Record<string, string> = { top: 'flex-start', center: 'center', bottom: 'flex-end' };

/**
 * CSS for one Pine table: a grid inside the table frame of the rows and columns that hold a cell.
 * TradingView collapses a row or column no cell touches — a dashboard declared with 14 rows that
 * fills 8 is 8 rows tall, not 8 rows and 6 empty bands — while a merge keeps every track it spans.
 * In the rows and columns that remain, every grid position not covered by a merge gets a cell
 * (undefined cells render empty, as Pine shows them), inner borders are per-cell right/bottom
 * borders so they stay correct around merged cells, and `width`/`height` in % of the pane become px
 * against the pane size.
 */
export function tableView(t: TableLayout, paneWidth: number, paneHeight: number): TableView {
  const usedRows = new Uint8Array(t.rows);
  const usedColumns = new Uint8Array(t.columns);
  const covered = new Uint8Array(t.columns * t.rows);
  const defined = new Map<string, TableCellLayout>();
  for (const c of t.cells) {
    defined.set(`${c.row}:${c.column}`, c);
    for (let r = c.row; r < c.row + c.rowSpan; r++) {
      usedRows[r] = 1;
      for (let k = c.column; k < c.column + c.columnSpan; k++) {
        usedColumns[k] = 1;
        if (r !== c.row || k !== c.column) covered[r * t.columns + k] = 1;
      }
    }
  }
  const { track: rowTrack, count: rowCount } = tracks(usedRows);
  const { track: columnTrack, count: columnCount } = tracks(usedColumns);
  /** Kept tracks a span from `start` over `span` grid positions covers. */
  const keptIn = (track: Int32Array, start: number, span: number) => {
    let n = 0;
    for (let i = start; i < start + span; i++) if (track[i]) n++;
    return n;
  };

  const containerStyle: Record<string, string> = {
    'grid-template-columns': `repeat(${columnCount}, auto)`,
    'grid-template-rows': `repeat(${rowCount}, auto)`,
    background: t.bgColor ?? 'transparent',
  };
  if (t.frameWidth > 0 && t.frameColor)
    containerStyle['border'] = `${t.frameWidth}px solid ${t.frameColor}`;

  const border =
    t.borderWidth > 0 && t.borderColor ? `${t.borderWidth}px solid ${t.borderColor}` : null;
  const cells: TableCellView[] = [];
  for (let row = 0; row < t.rows; row++) {
    if (!rowTrack[row]) continue;
    for (let col = 0; col < t.columns; col++) {
      if (!columnTrack[col] || covered[row * t.columns + col]) continue;
      const c = defined.get(`${row}:${col}`);
      const colSpan = keptIn(columnTrack, col, c?.columnSpan ?? 1);
      const rowSpan = keptIn(rowTrack, row, c?.rowSpan ?? 1);
      const gridCol = columnTrack[col];
      const gridRow = rowTrack[row];
      const style: Record<string, string> = {
        'grid-column': `${gridCol} / span ${colSpan}`,
        'grid-row': `${gridRow} / span ${rowSpan}`,
      };
      if (border && gridCol - 1 + colSpan < columnCount) style['border-right'] = border;
      if (border && gridRow - 1 + rowSpan < rowCount) style['border-bottom'] = border;
      if (c) {
        if (c.bgColor) style['background'] = c.bgColor;
        style['color'] = c.textColor;
        style['font-size'] = `${c.fontSize}px`;
        style['font-family'] = c.fontFamily;
        if (c.bold) style['font-weight'] = '700';
        if (c.italic) style['font-style'] = 'italic';
        style['justify-content'] = JUSTIFY[c.hAlign] ?? 'center';
        style['align-items'] = ALIGN[c.vAlign] ?? 'center';
        style['text-align'] = c.hAlign;
        if (c.widthPct > 0 && paneWidth > 0)
          style['width'] = `${Math.round((paneWidth * c.widthPct) / 100)}px`;
        if (c.heightPct > 0 && paneHeight > 0)
          style['height'] = `${Math.round((paneHeight * c.heightPct) / 100)}px`;
      }
      cells.push({
        key: `${t.id}:${row}:${col}`,
        text: c?.text ?? '',
        tooltip: c?.tooltip ?? null,
        style,
      });
    }
  }
  return { id: t.id, position: t.position, containerStyle, cells };
}

/** The grid track (1-based) of each used row or column, numbering only the used ones; 0 = collapsed. */
function tracks(used: Uint8Array): { track: Int32Array; count: number } {
  const track = new Int32Array(used.length);
  let count = 0;
  for (let i = 0; i < used.length; i++) if (used[i]) track[i] = ++count;
  return { track, count };
}
