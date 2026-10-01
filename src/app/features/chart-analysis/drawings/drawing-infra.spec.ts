import { Injector, runInInjectionContext } from '@angular/core';
import { of } from 'rxjs';
import { ChartDrawingsService } from '@core/services/chart-drawings.service';
import { DrawingStore } from './drawing-store.service';
import {
  barStepMs,
  byZ,
  effectiveMagnet,
  intervalOf,
  isVisibleOn,
  reorder,
  snapAngle,
  visibilityFromList,
  visibilityToList,
} from './drawing-ops';
import { DrawingTemplates } from './drawing-templates';
import { styleFor, type Drawing } from './model';
import { formatColor, parseColor } from './ui/colors';

const RES = ['1', '5', '15', '30', '60', '240', '1D', '1W', '1M'];

function makeStore(remote: Partial<ChartDrawingsService> = {}): {
  store: DrawingStore;
  sent: unknown[];
} {
  const sent: unknown[] = [];
  const injector = Injector.create({
    providers: [
      {
        provide: ChartDrawingsService,
        useValue: {
          list: () => of({ status: true, data: [] }),
          replaceScope: (_s: string, _r: string, d: unknown[]) => {
            sent.push(...d);
            return of({ status: true, data: d.length });
          },
          ...remote,
        },
      },
    ],
  });
  localStorage.clear();
  const store = runInInjectionContext(injector, () => new DrawingStore());
  store.setScope('EURUSD', '60');
  return { store, sent };
}

const P = (time: number, price: number) => ({ time, price });

describe('snapAngle (Shift constrain)', () => {
  it('snaps near-horizontal to horizontal, keeping x', () => {
    expect(snapAngle({ x: 0, y: 0 }, { x: 100, y: 7 })).toEqual({ x: 100, y: 0 });
  });
  it('snaps near-vertical to vertical, keeping y', () => {
    expect(snapAngle({ x: 10, y: 10 }, { x: 14, y: -90 })).toEqual({ x: 10, y: -90 });
  });
  it('snaps near-diagonal onto the 45° line', () => {
    const p = snapAngle({ x: 0, y: 0 }, { x: 100, y: 90 });
    expect(p.x).toBeCloseTo(p.y, 6);
    expect(p.x).toBeCloseTo(95, 6);
  });
  it('leaves a zero-length segment alone', () => {
    expect(snapAngle({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 5, y: 5 });
  });
});

describe('magnet', () => {
  it('Ctrl/Cmd inverts the magnet', () => {
    expect(effectiveMagnet('off', true)).toBe('strong');
    expect(effectiveMagnet('weak', true)).toBe('off');
    expect(effectiveMagnet('strong', false)).toBe('strong');
  });
});

describe('visibility on intervals', () => {
  it('maps resolutions to TV units', () => {
    expect(intervalOf('15')).toEqual({ unit: 'minutes', value: 15 });
    expect(intervalOf('240')).toEqual({ unit: 'hours', value: 4 });
    expect(intervalOf('1D')).toEqual({ unit: 'days', value: 1 });
    expect(intervalOf('1M')).toEqual({ unit: 'months', value: 1 });
  });
  it('all checked → undefined (visible everywhere)', () => {
    expect(visibilityToList(visibilityFromList(undefined, RES), RES)).toBeUndefined();
  });
  it('unchecking Hours excludes 1h and 4h', () => {
    const v = visibilityFromList(undefined, RES);
    v.hours.on = false;
    const list = visibilityToList(v, RES)!;
    expect(list).not.toContain('60');
    expect(list).not.toContain('240');
    expect(list).toContain('15');
  });
  it('ranges narrow within a unit and round-trip', () => {
    const v = visibilityFromList(undefined, RES);
    v.minutes = { on: true, from: 5, to: 15 };
    const list = visibilityToList(v, RES)!;
    expect(list.filter((r) => ['1', '5', '15', '30'].includes(r))).toEqual(['5', '15']);
    expect(visibilityFromList(list, RES).minutes).toEqual({ on: true, from: 5, to: 15 });
  });
  it('filters hidden and excluded drawings', () => {
    expect(isVisibleOn({ hidden: true }, '60')).toBe(false);
    expect(isVisibleOn({ visibleOn: ['15'] }, '60')).toBe(false);
    expect(isVisibleOn({ visibleOn: ['60'] }, '60')).toBe(true);
    expect(isVisibleOn({}, '60')).toBe(true);
  });
});

describe('z order', () => {
  const ds = [
    { id: 'a', z: 0 },
    { id: 'b', z: 1 },
    { id: 'c', z: 2 },
  ] as Drawing[];
  it('sorts by z with creation order as tie-break', () => {
    expect(byZ([{ id: 'x' }, { id: 'y', z: -1 }, { id: 'z' }] as Drawing[]).map((d) => d.id)).toEqual(['y', 'x', 'z']);
  });
  it('front / back / forward / backward', () => {
    const order = (m: Map<string, number>) => [...m.entries()].sort((x, y) => x[1] - y[1]).map((e) => e[0]);
    expect(order(reorder(ds, 'a', 'front'))).toEqual(['b', 'c', 'a']);
    expect(order(reorder(ds, 'c', 'back'))).toEqual(['c', 'a', 'b']);
    expect(order(reorder(ds, 'a', 'forward'))).toEqual(['b', 'a', 'c']);
    expect(order(reorder(ds, 'c', 'backward'))).toEqual(['a', 'c', 'b']);
  });
});

describe('DrawingStore infrastructure', () => {
  it('new drawings land on top of the visual order', () => {
    const { store } = makeStore();
    const a = store.add('trend-line', [P(1, 1), P(2, 2)], styleFor('trend-line'));
    const b = store.add('rectangle', [P(1, 1), P(2, 2)], styleFor('rectangle'));
    expect((b.z ?? 0) > (a.z ?? 0)).toBe(true);
    store.reorder(b.id, 'back');
    expect(byZ(store.visible()).map((d) => d.id)).toEqual([b.id, a.id]);
  });

  it('clone copies style/options, unlocks, and goes on top; one undo removes it', () => {
    const { store } = makeStore();
    const a = store.add('trend-line', [P(1, 1), P(2, 2)], styleFor('trend-line'), undefined, { options: { extendRight: true } });
    store.toggleLock(a.id);
    const c = store.clone(a.id)!;
    expect(c.id).not.toBe(a.id);
    expect(c.locked).toBe(false);
    expect(c.options).toEqual({ extendRight: true });
    expect(c.points).toEqual(a.points);
    store.undo();
    expect(store.visible().map((d) => d.id)).toEqual([a.id]);
  });

  it('copy/paste offsets in the same chart and lands verbatim in another', () => {
    const { store } = makeStore();
    const a = store.add('trend-line', [P(1000, 1.1)], styleFor('trend-line'));
    expect(store.copy(a.id)).toBe(true);
    const p1 = store.paste({ symbol: 'EURUSD', resolution: '60' }, { dt: 10, dp: 0.01 })!;
    expect(p1.points[0].time).toBe(1010);
    expect(p1.points[0].price).toBeCloseTo(1.11);
    // A second paste steps further away rather than stacking.
    const p2 = store.paste({ symbol: 'EURUSD', resolution: '60' }, { dt: 10, dp: 0.01 })!;
    expect(p2.points[0].time).toBe(1020);
    const other = store.paste({ symbol: 'GBPUSD', resolution: '15' })!;
    expect(other.symbol).toBe('GBPUSD');
    expect(other.points[0]).toEqual({ time: 1020, price: expect.closeTo(1.12, 6) });
  });

  it('settings Cancel reverts every live-preview edit', () => {
    const { store } = makeStore();
    const a = store.add('trend-line', [P(1, 1), P(2, 2)], styleFor('trend-line'));
    store.beginGesture();
    store.updateStyle(a.id, { color: '#FF0000', width: 4 }, false);
    store.updateOptions(a.id, { extendLeft: true }, false);
    store.update(a.id, { visibleOn: ['15'], points: [P(5, 5), P(6, 6)] }, false);
    store.cancelGesture();
    const back = store.visible()[0];
    expect(back.style.color).toBe('#2962FF');
    expect(back.style.width).toBe(2);
    expect(back.options).toBeUndefined();
    expect(back.visibleOn).toBeUndefined();
    expect(back.points).toEqual([P(1, 1), P(2, 2)]);
  });

  it('settings Ok keeps the edits as one undo step', () => {
    const { store } = makeStore();
    const a = store.add('trend-line', [P(1, 1), P(2, 2)], styleFor('trend-line'));
    store.beginGesture();
    store.updateStyle(a.id, { color: '#FF0000' }, false);
    store.updateStyle(a.id, { width: 3 }, false);
    store.undo();
    expect(store.visible()[0].style).toMatchObject({ color: '#2962FF', width: 2 });
  });

  it('options / hidden / visibleOn / z round-trip through the engine payload', async () => {
    vi.useFakeTimers();
    const { store, sent } = makeStore();
    const a = store.add('fib-retracement', [P(1, 1), P(2, 2)], styleFor('fib-retracement'), undefined, {
      options: { levels: [{ value: 0.5, color: '#fff', visible: true }] },
    });
    store.update(a.id, { hidden: true, visibleOn: ['60', '240'] });
    vi.advanceTimersByTime(2000);
    vi.useRealTimers();
    const row = sent.at(-1) as Record<string, unknown>;
    expect(row['hidden']).toBe(true);
    expect(row['visibleOn']).toBe('60,240');
    expect(typeof row['zIndex']).toBe('number');
    expect(JSON.parse(row['optionsJson'] as string)).toEqual({ levels: [{ value: 0.5, color: '#fff', visible: true }] });

    // …and back in through hydrate.
    const { store: s2 } = makeStore({
      list: () =>
        of({
          status: true,
          data: [{ ...(row as object), id: 1, symbol: 'EURUSD', resolution: '60', updatedAt: '' }],
        }) as never,
    });
    const back = s2.visible()[0];
    expect(back.hidden).toBe(true);
    expect(back.visibleOn).toEqual(['60', '240']);
    expect(back.options).toEqual({ levels: [{ value: 0.5, color: '#fff', visible: true }] });
  });
});

describe('nudge step', () => {
  it('is the median bar spacing', () => {
    const bars = [0, 60, 120, 180, 600].map((t) => ({ time: t * 1000 }));
    expect(barStepMs(bars)).toBe(60_000);
  });
});

describe('templates', () => {
  it('saves, lists, overwrites by name, removes, and keeps a default', () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const t = new DrawingTemplates(storage);
    t.save('trend-line', { name: 'Red', style: { color: '#F23645' } });
    t.save('trend-line', { name: 'Blue', style: { color: '#2962FF' } });
    t.save('trend-line', { name: 'Red', style: { color: '#B22833', width: 3 } });
    expect(t.list('trend-line').map((x) => x.name)).toEqual(['Blue', 'Red']);
    expect(t.get('trend-line', 'Red')?.style.width).toBe(3);
    t.saveDefault('trend-line', { style: { color: '#000000' } });
    // Persisted: a fresh shelf over the same storage sees it all.
    const t2 = new DrawingTemplates(storage);
    expect(t2.getDefault('trend-line')?.style.color).toBe('#000000');
    t2.remove('trend-line', 'Blue');
    expect(t2.list('trend-line').map((x) => x.name)).toEqual(['Red']);
    expect(t2.list('rectangle')).toEqual([]);
  });

  it('a template overrides the tool defaults in styleFor', () => {
    expect(styleFor('trend-line')).toMatchObject({ color: '#2962FF', width: 2 });
    expect(styleFor('trend-line', { color: '#F23645', width: 4 })).toMatchObject({ color: '#F23645', width: 4 });
  });
});

describe('colours', () => {
  it('parses and formats hex/rgba with opacity', () => {
    expect(parseColor('rgba(41,98,255,0.2)')).toEqual({ hex: '#2962FF', alpha: 0.2 });
    expect(parseColor('#2962ff33').alpha).toBeCloseTo(0.2, 2);
    expect(formatColor('#2962FF', 1)).toBe('#2962FF');
    expect(formatColor('#2962FF', 0.5)).toBe('rgba(41,98,255,0.5)');
  });
});
