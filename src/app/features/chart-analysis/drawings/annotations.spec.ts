import { describe, expect, it } from 'vitest';
import { arrowMarkerPolygon, cornerRect } from './tools/media';
import { anchorPt } from './tools/text';
import { behaviorFor } from './tools/registry';
import { fitDataUrl } from './ui/image-fit';
import { parseFavorites } from './drawing-favorites.service';
import { pointInPolygon } from './geometry';
import { RAIL_LAYOUT, TOOLS, styleFor, type Drawing, type DrawingKind } from './model';

/** The DR-I12 tools: Anchored Text, Note, Price Note, Image, Arrow Marker, Icon, and the favourites. */
describe('missing TradingView tools (DR-I12)', () => {
  const NEW: DrawingKind[] = [
    'anchored-text',
    'note',
    'price-note',
    'image',
    'arrow-marker',
    'icon',
  ];

  it('are tools with a behaviour, in their TradingView families', () => {
    for (const kind of NEW) {
      expect(
        TOOLS.some((t) => t.kind === kind),
        kind,
      ).toBe(true);
      expect(behaviorFor(kind), kind).toBeDefined();
    }
    const family = (id: string) =>
      RAIL_LAYOUT.find((g) => g.id === id)!.sections.flatMap((s) => s.kinds);
    expect(family('text')).toEqual(
      expect.arrayContaining(['anchored-text', 'note', 'price-note', 'image', 'icon']),
    );
    expect(family('shapes')[family('shapes').indexOf('arrow-marker') + 1]).toBe('arrow');
  });

  it('Anchored Text and Anchored Note are fixed to the pane; one made before stays on its anchor', () => {
    expect(behaviorFor('anchored-text')!.screenAnchored).toBe(true);
    expect(behaviorFor('anchored-note')!.screenAnchored).toBe(true);
    expect(behaviorFor('note')!.screenAnchored).toBeFalsy();
    const ctx = { pts: [{ x: 10, y: 20 }], width: 800, height: 400 };
    expect(anchorPt({ ...ctx, options: { ax: 0.5, ay: 0.25 } })).toEqual({ x: 400, y: 100 });
    expect(anchorPt({ ...ctx, options: {} })).toEqual({ x: 10, y: 20 });
  });

  it('the Arrow Marker is a block arrow from the tail to the tip, wider with the line', () => {
    const thin = arrowMarkerPolygon({ x: 0, y: 0 }, { x: 100, y: 0 }, 1);
    const thick = arrowMarkerPolygon({ x: 0, y: 0 }, { x: 100, y: 0 }, 4);
    expect(thin).toHaveLength(7);
    expect(thin[3]).toEqual({ x: 100, y: 0 });
    expect(pointInPolygon({ x: 50, y: 0 }, thin)).toBe(true);
    expect(pointInPolygon({ x: 50, y: 30 }, thin)).toBe(false);
    expect(Math.abs(thick[0].y)).toBeGreaterThan(Math.abs(thin[0].y));
    expect(arrowMarkerPolygon({ x: 1, y: 1 }, { x: 1, y: 1 }, 2)).toEqual([]);
  });

  it('an Image spans its two corners in any order and is hit inside them', () => {
    expect(cornerRect({ x: 50, y: 80 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, w: 40, h: 60 });
    const d: Drawing = {
      id: 'i',
      kind: 'image',
      symbol: 'EURUSD',
      resolution: '60',
      points: [
        { time: 1, price: 1 },
        { time: 2, price: 2 },
      ],
      style: styleFor('image'),
      locked: false,
      createdAt: 0,
    };
    const hit = behaviorFor('image')!.hitTest!(
      {
        pts: [
          { x: 10, y: 20 },
          { x: 50, y: 80 },
        ],
        drawing: d,
        options: {},
      } as never,
      { x: 30, y: 50 },
      3,
    );
    expect(hit).toBe(true);
  });

  it('fits a picture into what a drawing can store, largest first, PNG before JPEG', () => {
    const tried: string[] = [];
    const encoder = (side: number, type: string, q?: number) => {
      tried.push(`${side}:${type}:${q ?? ''}`);
      // 480 px never fits; 360 px fits as JPEG at quality 0.4 (11,520 characters) — before any smaller size.
      const len = type === 'image/png' ? side * 100 : side * (q ?? 1) * 80;
      return 'x'.repeat(Math.round(len));
    };
    const url = fitDataUrl(encoder, 15_000);
    expect(url?.length).toBeLessThanOrEqual(15_000);
    expect(tried[0]).toBe('480:image/png:');
    expect(tried.at(-1)).toBe('360:image/jpeg:0.4');
    expect(fitDataUrl(() => 'x'.repeat(50_000), 15_000)).toBeNull();
  });

  it('reads the favourites as known tools, once each, in order', () => {
    expect(parseFavorites(JSON.stringify(['ray', 'nope', 'ray', 'note']))).toEqual(['ray', 'note']);
    expect(parseFavorites('not json')).toEqual([]);
    expect(parseFavorites(null)).toEqual([]);
  });
});
