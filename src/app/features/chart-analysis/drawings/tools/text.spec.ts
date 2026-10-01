import { describe, expect, it, vi } from 'vitest';
import { styleFor, type Drawing, type DrawingKind } from '../model';
import { BEHAVIORS, formatPrice, signpostBase, textBoxRect, type TextPaintCtx } from './text';
import { layoutText, wrapText } from './text-layout';
import { layoutTable, setTableCell, tableCellAt, tableCells } from './text-table';
import { optionsOf } from './types';

/** Each character is 10px wide — makes widths exact. */
function mockCtx(): CanvasRenderingContext2D {
  const calls: string[] = [];
  return {
    font: '',
    measureText: vi.fn((t: string) => ({ width: t.length * 10 })),
    save: vi.fn(),
    restore: vi.fn(),
    setLineDash: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arcTo: vi.fn(),
    arc: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    fillText: vi.fn((t: string) => calls.push(t)),
    calls,
  } as unknown as CanvasRenderingContext2D;
}

function drawing(kind: DrawingKind, text?: string, options?: Record<string, unknown>): Drawing {
  return {
    id: 'd',
    kind,
    symbol: 'EURUSD',
    resolution: '60',
    points: [{ time: 1000, price: 1.08765 }],
    style: styleFor(kind, text === undefined ? undefined : { text }),
    locked: false,
    createdAt: 0,
    options,
  };
}

function ctxFor(d: Drawing, ctx = mockCtx(), pts = [{ x: 100, y: 200 }]): TextPaintCtx {
  return {
    ctx,
    drawing: d,
    pts,
    width: 800,
    height: 400,
    priceAt: (y) => 2 - y / 1000,
    precision: 5,
    options: optionsOf(BEHAVIORS[d.kind], d),
  };
}

const measure = (t: string) => t.length * 10;

describe('wrapText', () => {
  it('keeps explicit newlines as lines', () => {
    expect(wrapText(measure, 'a\nbb\n\nc', null)).toEqual(['a', 'bb', '', 'c']);
  });
  it('word-wraps at the width', () => {
    expect(wrapText(measure, 'aaa bbb ccc', 75)).toEqual(['aaa bbb', 'ccc']);
  });
  it('breaks a word wider than the box by characters', () => {
    expect(wrapText(measure, 'abcdefgh', 30)).toEqual(['abc', 'def', 'gh']);
  });
});

describe('layoutText', () => {
  it('sizes the box from the widest line plus padding', () => {
    const l = layoutText(measure, 'ab\nabcd', 14, 'f', { padX: 8, padY: 6 });
    expect(l.width).toBe(40 + 16);
    expect(l.lineHeight).toBe(18);
    expect(l.height).toBe(2 * 18 + 12);
  });
  it('is exactly the wrap width when wrapping', () => {
    expect(layoutText(measure, 'hi', 14, 'f', { wrapWidth: 200 }).width).toBe(200);
  });
});

describe('text tool', () => {
  it('defaults to TradingView: "Text", 14px, #2962FF', () => {
    const s = styleFor('text');
    expect(s.text).toBe('Text');
    expect(s.fontSize).toBe(14);
    expect(s.textColor).toBe('#2962FF');
  });
  it('box starts at the anchor and is measured from the text', () => {
    const r = textBoxRect(ctxFor(drawing('text', 'Hello')))!;
    expect(r).toEqual({ x: 100, y: 200, w: 50, h: 18 });
  });
  it('hit-tests the box, not the empty chart beside it (null canvas ctx falls back)', () => {
    const b = BEHAVIORS.text!;
    const c = ctxFor(drawing('text', 'Hello'));
    expect(b.hitTest!(c, { x: 140, y: 210 }, 2)).toBe(true);
    expect(b.hitTest!(c, { x: 200, y: 210 }, 2)).toBe(false);
    const noCtx = { ...c, ctx: null as unknown as CanvasRenderingContext2D };
    expect(b.hitTest!(noCtx, { x: 102, y: 205 }, 2)).toBe(true);
  });
  it('paints every wrapped line', () => {
    const ctx = mockCtx();
    BEHAVIORS.text!.paint({ ...ctxFor(drawing('text', 'one two three', { wordWrap: true, wordWrapWidth: 70 }), ctx), selected: false });
    expect((ctx as unknown as { calls: string[] }).calls).toEqual(['one two', 'three']);
  });
});

describe('price label', () => {
  it('formats with the symbol precision', () => {
    expect(formatPrice(1.087654, 5)).toBe('1.08765');
    expect(formatPrice(150.1, 3)).toBe('150.100');
    expect(formatPrice(42, 0)).toBe('42');
  });
  it('paints the anchor price inside the tag above the point', () => {
    const ctx = mockCtx();
    const c = ctxFor(drawing('price-label'), ctx);
    BEHAVIORS['price-label']!.paint({ ...c, selected: false });
    expect((ctx as unknown as { calls: string[] }).calls).toContain('1.08765');
    const r = textBoxRect(c)!;
    expect(r.y + r.h).toBeLessThan(200);
  });
});

describe('callout', () => {
  it('has two anchors: tip and box; the tail is hittable', () => {
    const d = drawing('callout', 'Hi');
    const c = ctxFor(d, mockCtx(), [
      { x: 100, y: 200 },
      { x: 200, y: 100 },
    ]);
    expect(BEHAVIORS.callout!.points).toBe(2);
    expect(textBoxRect(c)).toMatchObject({ x: 200, y: 100 });
    expect(BEHAVIORS.callout!.hitTest!(c, { x: 120, y: 186 }, 3)).toBe(true);
    expect(BEHAVIORS.callout!.hitTest!(c, { x: 100, y: 120 }, 3)).toBe(false);
  });
});

describe('signpost', () => {
  const bars = [{ time: 1000, open: 1, high: 1.1, low: 0.9, close: 1, volume: 1 }];
  it('poles to the high when the label is above the bar, low when below', () => {
    expect(signpostBase(bars, 1000, 1.5)).toBe(1.1);
    expect(signpostBase(bars, 1000, 0.5)).toBe(0.9);
    expect(signpostBase([], 1000, 1)).toBeNull();
  });
});

describe('table', () => {
  it('normalises cells to rows × cols', () => {
    expect(tableCells({ rows: 2, cols: 2, cells: [['a']] })).toEqual([
      ['a', ''],
      ['', ''],
    ]);
  });
  it('lays out columns by widest cell and finds cells', () => {
    const d = drawing('table', '', { rows: 2, cols: 2, cells: [['Head', 'B'], ['longer cell', 'x']] });
    const t = layoutTable(ctxFor(d));
    expect(t.colX[0]).toBe(100);
    expect(t.colW[0]).toBe(110 + 16);
    expect(t.colW[1]).toBe(48);
    expect(t.bounds.w).toBe(126 + 48);
    expect(tableCellAt(t, { x: 230, y: 230 })).toMatchObject({ row: 1, col: 1 });
    expect(BEHAVIORS.table!.hitTest!(ctxFor(d), { x: 500, y: 500 }, 2)).toBe(false);
  });
  it('setTableCell writes immutably', () => {
    const d = drawing('table', '', { cells: [['a']] });
    const o = setTableCell(d, 1, 2, 'z');
    expect((o['cells'] as string[][])[1][2]).toBe('z');
    expect((d.options!['cells'] as string[][]).length).toBe(1);
  });
});

describe('every tool in the family', () => {
  it('paints and hit-tests at its anchor without throwing', () => {
    for (const kind of Object.keys(BEHAVIORS) as DrawingKind[]) {
      const pts = [
        { x: 100, y: 200 },
        { x: 200, y: 100 },
      ].slice(0, BEHAVIORS[kind]!.points ?? 1);
      const c = ctxFor(drawing(kind), mockCtx(), pts);
      expect(() => BEHAVIORS[kind]!.paint({ ...c, selected: true })).not.toThrow();
      expect(typeof BEHAVIORS[kind]!.hitTest!(c, pts[0], 6)).toBe('boolean');
    }
  });
});
