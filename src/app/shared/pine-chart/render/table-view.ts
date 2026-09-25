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
  cells: TableCellView[];
}

const JUSTIFY: Record<string, string> = { left: 'flex-start', center: 'center', right: 'flex-end' };
const ALIGN: Record<string, string> = { top: 'flex-start', center: 'center', bottom: 'flex-end' };

/**
 * CSS for one Pine table: a grid of `columns × rows` tracks inside the table frame. Every grid
 * position not covered by a merge gets a cell (undefined cells render empty, as Pine shows them),
 * inner borders are per-cell right/bottom borders so they stay correct around merged cells, and
 * `width`/`height` in % of the pane become px against the pane size.
 */
export function tableView(t: TableLayout, paneWidth: number, paneHeight: number): TableView {
  const containerStyle: Record<string, string> = {
    'grid-template-columns': `repeat(${t.columns}, auto)`,
    'grid-template-rows': `repeat(${t.rows}, auto)`,
    background: t.bgColor ?? 'transparent',
  };
  if (t.frameWidth > 0 && t.frameColor)
    containerStyle['border'] = `${t.frameWidth}px solid ${t.frameColor}`;

  const covered = new Uint8Array(t.columns * t.rows);
  const defined = new Map<string, TableCellLayout>();
  for (const c of t.cells) {
    defined.set(`${c.row}:${c.column}`, c);
    for (let r = c.row; r < c.row + c.rowSpan; r++)
      for (let k = c.column; k < c.column + c.columnSpan; k++)
        if (r !== c.row || k !== c.column) covered[r * t.columns + k] = 1;
  }

  const border =
    t.borderWidth > 0 && t.borderColor ? `${t.borderWidth}px solid ${t.borderColor}` : null;
  const cells: TableCellView[] = [];
  for (let row = 0; row < t.rows; row++) {
    for (let col = 0; col < t.columns; col++) {
      if (covered[row * t.columns + col]) continue;
      const c = defined.get(`${row}:${col}`);
      const colSpan = c?.columnSpan ?? 1;
      const rowSpan = c?.rowSpan ?? 1;
      const style: Record<string, string> = {
        'grid-column': `${col + 1} / span ${colSpan}`,
        'grid-row': `${row + 1} / span ${rowSpan}`,
      };
      if (border && col + colSpan < t.columns) style['border-right'] = border;
      if (border && row + rowSpan < t.rows) style['border-bottom'] = border;
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
