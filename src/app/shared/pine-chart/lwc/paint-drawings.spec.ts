import { describe, expect, it } from 'vitest';
import { FONT_DEFAULT } from '../render/build-render-model';
import type { BoxDrawing, DrawingSet, LabelDrawing, LineDrawing, PolylineDrawing } from '../render/render-model';
import { RecordingContext, pathPoints } from '../testing/recording-context';
import { extendedSegment, labelGeometry, paintDrawings, type HitRegion } from './paint-drawings';
import { linearProjection } from './projection';

const proj = () => linearProjection({ barSpacing: 10, y0: 100, pxPerUnit: -1, width: 400, height: 200, from: -1, to: 60, lastLogical: 50 });
const set = (d: Partial<DrawingSet>): DrawingSet => ({ labels: [], lines: [], boxes: [], polylines: [], linefills: [], ...d });
const bars = { high: () => 20, low: () => 10 };

function lbl(extra: Partial<LabelDrawing> = {}): LabelDrawing {
  return {
    id: 1,
    x: 5,
    y: 50,
    yloc: 'price',
    text: 'Hello',
    color: 'rgb(41, 98, 255)',
    style: 'label_down',
    textColor: 'rgb(255, 255, 255)',
    fontSize: 12,
    textAlign: 'center',
    tooltip: null,
    fontFamily: FONT_DEFAULT,
    bold: false,
    italic: false,
    ...extra,
  };
}

describe('extendedSegment', () => {
  const a = { x: 100, y: 100 };
  const b = { x: 200, y: 50 };

  it('keeps the segment for extend.none', () => {
    expect(extendedSegment(a, b, 'none', 400, 200)).toEqual([a, b]);
  });

  it('extend.right is the ray from point 1 through point 2', () => {
    const [p1, p2] = extendedSegment(a, b, 'right', 400, 200);
    expect(p1).toEqual(a);
    expect(p2.x).toBeGreaterThan(400);
    // Still on the same line: slope −0.5.
    expect((p2.y - a.y) / (p2.x - a.x)).toBeCloseTo(-0.5);
  });

  it('extend.left is the ray from point 2 back through point 1', () => {
    const [p1, p2] = extendedSegment(a, b, 'left', 400, 200);
    expect(p2).toEqual(b);
    expect(p1.x).toBeLessThan(0);
  });

  it('extend.both is the whole line, including vertical lines', () => {
    const [p1, p2] = extendedSegment({ x: 50, y: 80 }, { x: 50, y: 120 }, 'both', 400, 200);
    expect(p1.x).toBe(50);
    expect(Math.min(p1.y, p2.y)).toBeLessThan(0);
    expect(Math.max(p1.y, p2.y)).toBeGreaterThan(200);
  });
});

describe('labelGeometry', () => {
  const ax = 100;
  const ay = 100;

  it('label_down sits above its anchor with the pointer tip on it', () => {
    const g = labelGeometry('label_down', ax, ay, 40, 15, 12);
    expect(g.box.y + g.box.h).toBeLessThan(ay);
    expect(g.pointer![1]).toEqual({ x: ax, y: ay });
    expect(g.box.x + g.box.w / 2).toBeCloseTo(ax);
  });

  it('label_up sits below, label_left to the right, label_right to the left', () => {
    expect(labelGeometry('label_up', ax, ay, 40, 15, 12).box.y).toBeGreaterThan(ay);
    expect(labelGeometry('label_left', ax, ay, 40, 15, 12).box.x).toBeGreaterThan(ax);
    const right = labelGeometry('label_right', ax, ay, 40, 15, 12).box;
    expect(right.x + right.w).toBeLessThan(ax);
  });

  it('corner styles put the box in the named quadrant', () => {
    const ll = labelGeometry('label_lower_left', ax, ay, 40, 15, 12).box;
    expect(ll.x).toBeGreaterThan(ax);
    expect(ll.y + ll.h).toBeLessThan(ay);
    const ur = labelGeometry('label_upper_right', ax, ay, 40, 15, 12).box;
    expect(ur.x + ur.w).toBeLessThan(ax);
    expect(ur.y).toBeGreaterThan(ay);
  });

  it('label_center, none and text_outline centre on the anchor without a pointer', () => {
    for (const style of ['label_center', 'none', 'text_outline']) {
      const g = labelGeometry(style, ax, ay, 40, 15, 12);
      expect(g.pointer).toBeNull();
      expect(g.box.x + g.box.w / 2).toBeCloseTo(ax);
      expect(g.box.y + g.box.h / 2).toBeCloseTo(ay);
    }
    expect(labelGeometry('none', ax, ay, 40, 15, 12).bubble).toBe(false);
  });

  it('shape styles draw the shape on the anchor, text below (above for downward shapes)', () => {
    const circle = labelGeometry('circle', ax, ay, 40, 15, 12);
    expect(circle.shape).toMatchObject({ cx: ax, cy: ay });
    expect(circle.box.y).toBeGreaterThan(ay);
    const down = labelGeometry('arrowdown', ax, ay, 40, 15, 12);
    expect(down.box.y + down.box.h).toBeLessThan(ay);
  });
});

describe('paintDrawings', () => {
  it('draws a label bubble, its pointer and its text, and registers its tooltip', () => {
    const ctx = new RecordingContext();
    const hits: HitRegion[] = [];
    paintDrawings(ctx.asCtx(), proj(), set({ labels: [lbl({ tooltip: 'Tip' })] }), bars, hits);
    expect(ctx.fills('rgb(41, 98, 255)').length).toBe(2); // bubble + pointer
    expect(ctx.texts().map((t) => t.text)).toEqual(['Hello']);
    expect(hits).toHaveLength(1);
    expect(hits[0].tooltip).toBe('Tip');
    // The hit box covers the bubble above the anchor (x = 50, y = 50).
    expect(hits[0].x).toBeLessThan(50);
    expect(hits[0].y + hits[0].h).toBeLessThanOrEqual(50);
  });

  it('anchors yloc.abovebar at the bar high and flips label_down to label_up for belowbar', () => {
    const ctx = new RecordingContext();
    const hits: HitRegion[] = [];
    paintDrawings(ctx.asCtx(), proj(), set({ labels: [lbl({ yloc: 'abovebar', y: null, tooltip: 'a' }), lbl({ id: 2, yloc: 'belowbar', y: null, tooltip: 'b' })] }), bars, hits);
    // high 20 → y 80; low 10 → y 90.
    expect(hits[0].y + hits[0].h).toBeLessThanOrEqual(80);
    expect(hits[1].y).toBeGreaterThanOrEqual(90);
  });

  it('text_outline strokes the text in the label color', () => {
    const ctx = new RecordingContext();
    paintDrawings(ctx.asCtx(), proj(), set({ labels: [lbl({ style: 'text_outline' })] }), bars, []);
    expect(ctx.ops.some((o) => o.op === 'strokeText' && o.style === 'rgb(41, 98, 255)')).toBe(true);
    expect(ctx.fills().length).toBe(0);
  });

  it('draws lines with style, width and arrowheads', () => {
    const line: LineDrawing = { id: 1, x1: 0, y1: 10, x2: 10, y2: 20, extend: 'none', color: 'rgb(1, 2, 3)', style: 'arrow_both', width: 2 };
    const ctx = new RecordingContext();
    paintDrawings(ctx.asCtx(), proj(), set({ lines: [line] }), null, []);
    const s = ctx.strokes('rgb(1, 2, 3)')[0];
    expect(pathPoints(s.path)).toEqual([
      [0, 90],
      [100, 80],
    ]);
    expect(s.width).toBe(2);
    expect(ctx.fills('rgb(1, 2, 3)').length).toBe(2); // two arrowheads
  });

  it('extends boxes to the pane edge and clips wrapped text to the box', () => {
    const box: BoxDrawing = {
      id: 1,
      left: 2,
      right: 6,
      top: 40,
      bottom: 20,
      borderColor: 'rgb(0, 0, 255)',
      borderWidth: 1,
      borderStyle: 'dashed',
      extend: 'right',
      bgColor: 'rgba(0, 0, 255, 0.2)',
      text: 'a long piece of text that needs wrapping',
      fontSize: 10,
      textColor: 'rgb(0, 0, 0)',
      hAlign: 'left',
      vAlign: 'top',
      wrap: true,
      fontFamily: FONT_DEFAULT,
      bold: false,
      italic: false,
    };
    const ctx = new RecordingContext();
    paintDrawings(ctx.asCtx(), proj(), set({ boxes: [box] }), null, []);
    const bg = ctx.rects('rgba(0, 0, 255, 0.2)')[0];
    expect(bg.x).toBe(20);
    expect(bg.x + bg.w).toBeGreaterThan(400);

    const narrow = new RecordingContext();
    paintDrawings(narrow.asCtx(), proj(), set({ boxes: [{ ...box, extend: 'none' }] }), null, []);
    // 40 px wide: the text wraps onto several lines.
    expect(narrow.texts().length).toBeGreaterThan(3);
    const unwrapped = new RecordingContext();
    paintDrawings(unwrapped.asCtx(), proj(), set({ boxes: [{ ...box, extend: 'none', wrap: false }] }), null, []);
    expect(unwrapped.texts().length).toBe(1);
  });

  it('auto-sizes box text to fit', () => {
    const box: BoxDrawing = {
      id: 1, left: 0, right: 4, top: 60, bottom: 40, borderColor: null, borderWidth: 0, borderStyle: 'solid', extend: 'none',
      bgColor: null, text: 'AUTO', fontSize: 0, textColor: 'rgb(0, 0, 0)', hAlign: 'center', vAlign: 'center', wrap: false,
      fontFamily: FONT_DEFAULT, bold: false, italic: false,
    };
    const ctx = new RecordingContext();
    paintDrawings(ctx.asCtx(), proj(), set({ boxes: [box] }), null, []);
    const t = ctx.texts()[0];
    const size = +/(\d+)px/.exec(t.font)![1];
    // Box is 40 px wide: "AUTO" at 0.6em per char must fit in 34 px.
    expect(size * 0.6 * 4).toBeLessThanOrEqual(34);
    expect(size).toBeGreaterThan(6);
  });

  it('draws polylines: closed and filled, curved as Béziers', () => {
    const pl: PolylineDrawing = {
      id: 1,
      xs: Float64Array.of(1, 5, 9),
      ys: Float64Array.of(10, 30, 10),
      curved: true,
      closed: true,
      lineColor: 'rgb(9, 9, 9)',
      fillColor: 'rgba(9, 9, 9, 0.2)',
      lineStyle: 'solid',
      lineWidth: 1,
    };
    const ctx = new RecordingContext();
    paintDrawings(ctx.asCtx(), proj(), set({ polylines: [pl] }), null, []);
    const fill = ctx.fills('rgba(9, 9, 9, 0.2)')[0];
    expect(fill.path.filter((c) => c.c === 'B').length).toBe(3);
    expect(fill.path[fill.path.length - 1].c).toBe('Z');
    expect(ctx.strokes('rgb(9, 9, 9)').length).toBe(1);
  });

  it('fills a linefill between two lines', () => {
    const l1: LineDrawing = { id: 1, x1: 0, y1: 50, x2: 10, y2: 60, extend: 'none', color: 'rgb(0, 0, 0)', style: 'solid', width: 1 };
    const l2: LineDrawing = { ...l1, id: 2, y1: 30, y2: 35 };
    const ctx = new RecordingContext();
    paintDrawings(ctx.asCtx(), proj(), set({ lines: [l1, l2], linefills: [{ id: 3, line1: l1, line2: l2, color: 'rgba(0, 255, 0, 0.1)' }] }), null, []);
    const poly = pathPoints(ctx.fills('rgba(0, 255, 0, 0.1)')[0].path);
    expect(poly).toEqual([
      [0, 50],
      [100, 40],
      [100, 65],
      [0, 70],
    ]);
  });
});
