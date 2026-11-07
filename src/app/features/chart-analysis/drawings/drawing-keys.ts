import { newDrawingId, type Drawing } from './model';

/**
 * US07: drawings belong to the INSTRUMENT (`workspace/instrument-key.ts`): a futures contract's to its continuous
 * root. Drawings saved under an older key (a bare contract symbol, `ESZ6`) move to the instrument's key (`ES1!`).
 *
 * The engine never moves a drawing to another symbol (it answers `-11`), so a move is a NEW drawing under the key — a
 * new id, everything else as it was — and a delete of the old one. Pure.
 */
export interface DrawingMove {
  from: Drawing;
  to: Drawing;
}

export function rekeyDrawings(
  list: readonly Drawing[],
  keyOf: (symbol: string) => string,
  newId: () => string = newDrawingId,
): { drawings: Drawing[]; moved: DrawingMove[] } {
  const moved: DrawingMove[] = [];
  const drawings = list.map((d) => {
    const key = keyOf(d.symbol);
    if (!key || key === d.symbol) return d;
    const to: Drawing = { ...d, id: newId(), symbol: key };
    moved.push({ from: d, to });
    return to;
  });
  return { drawings, moved };
}
