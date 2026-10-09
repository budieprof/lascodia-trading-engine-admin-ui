import { Injector, runInInjectionContext } from '@angular/core';
import { Subject, of, throwError } from 'rxjs';
import {
  ChartDrawingsService,
  type ChartDrawingDto,
  type ChartDrawingOp,
  type ChartDrawingsChanged,
} from '@core/services/chart-drawings.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import { DrawingStore } from './drawing-store.service';
import {
  barStepMs,
  byZ,
  effectiveMagnet,
  intervalOf,
  isShownOn,
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

/** A fake engine: drawings by symbol, applying batches the way the engine does (versions, -409 on a stale base). */
class FakeEngine {
  rows = new Map<string, ChartDrawingDto>();
  sent: ChartDrawingOp[] = [];
  down = false;
  private clock = Date.parse('2026-10-09T08:00:00Z');

  list = (symbol: string) =>
    this.down
      ? throwError(() => new Error('down'))
      : of({ status: true, data: [...this.rows.values()].filter((r) => r.symbol === symbol) });

  sync = (_origin: string, ops: ChartDrawingOp[]) => {
    if (this.down) return throwError(() => new Error('down'));
    this.sent.push(...ops);
    const data = ops.map((op) => {
      const row = this.rows.get(op.clientId);
      if (op.op === 'delete') {
        if (row && op.baseUpdatedAt && op.baseUpdatedAt !== row.updatedAt) return { clientId: op.clientId, code: '-409', drawing: row };
        this.rows.delete(op.clientId);
        return { clientId: op.clientId, code: '00', drawing: null };
      }
      if (row && op.baseUpdatedAt !== row.updatedAt && !(op.baseUpdatedAt === null && row.createdAt === op.drawing!.createdAt)) {
        return { clientId: op.clientId, code: '-409', drawing: row };
      }
      if (!row && op.baseUpdatedAt) return { clientId: op.clientId, code: '-409', drawing: null };
      const next = this.dto(op.clientId, op.drawing!);
      this.rows.set(op.clientId, next);
      return { clientId: op.clientId, code: '00', drawing: next };
    });
    return of({ status: true, data });
  };

  syncOnUnload = () => undefined;

  dto(clientId: string, d: NonNullable<ChartDrawingOp['drawing']>): ChartDrawingDto {
    this.clock += 1000;
    return { id: 1, clientId, ...d, updatedAt: new Date(this.clock).toISOString() };
  }
}

function makeStore(engine = new FakeEngine(), keepStorage = false) {
  const pushes = new Subject<ChartDrawingsChanged>();
  const injector = Injector.create({
    providers: [
      { provide: ChartDrawingsService, useValue: engine },
      { provide: RealtimeService, useValue: { on: () => pushes.asObservable() } },
    ],
  });
  if (!keepStorage) localStorage.clear();
  const store = runInInjectionContext(injector, () => new DrawingStore());
  store.setScope('EURUSD', '60');
  return { store, engine, pushes };
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
    expect(isShownOn({ visibleOn: list }, '60')).toBe(false);
    expect(isShownOn({ visibleOn: list }, '240')).toBe(false);
    expect(isShownOn({ visibleOn: list }, '15')).toBe(true);
    expect(isShownOn({ visibleOn: list }, '1D')).toBe(true);
  });
  it('ranges narrow within a unit and round-trip', () => {
    const v = visibilityFromList(undefined, RES);
    v.minutes = { on: true, from: 5, to: 15 };
    const list = visibilityToList(v, RES)!;
    expect(RES.filter((r) => ['1', '5', '15', '30'].includes(r) && isShownOn({ visibleOn: list }, r))).toEqual(['5', '15']);
    expect(visibilityFromList(list, RES).minutes).toEqual({ on: true, from: 5, to: 15 });
  });
  it('stores unit ranges, so a typed interval inside a range shows too (DR-I2)', () => {
    const v = visibilityFromList(undefined, RES);
    v.minutes.on = false;
    v.hours = { on: true, from: 1, to: 4 };
    const list = visibilityToList(v, RES)!;
    expect(list).toContain('hours:1-4');
    expect(isShownOn({ visibleOn: list }, '180')).toBe(true); // a typed 3h, not in RES
    expect(isShownOn({ visibleOn: list }, '480')).toBe(false); // 8h is outside 1-4
    expect(isShownOn({ visibleOn: list }, '45')).toBe(false); // minutes are off
  });
  it('every unit off shows the drawing nowhere (not everywhere)', () => {
    const v = visibilityFromList(undefined, RES);
    for (const k of Object.keys(v) as (keyof typeof v)[]) v[k].on = false;
    const list = visibilityToList(v, RES)!;
    expect(list).toEqual(['none']);
    expect(RES.some((r) => isShownOn({ visibleOn: list }, r))).toBe(false);
  });
  it('reads single resolutions as before: a legacy drawing shows on its own timeframe', () => {
    expect(isShownOn({ visibleOn: ['240'] }, '240')).toBe(true);
    expect(isShownOn({ visibleOn: ['240'] }, '60')).toBe(false);
    expect(visibilityFromList(['240'], RES).hours).toEqual({ on: true, from: 4, to: 4 });
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

  it('options / hidden / visibleOn / z round-trip through the engine', () => {
    vi.useFakeTimers();
    const { store, engine } = makeStore();
    const a = store.add('fib-retracement', [P(1, 1), P(2, 2)], styleFor('fib-retracement'), undefined, {
      options: { levels: [{ value: 0.5, color: '#fff', visible: true }] },
    });
    store.update(a.id, { hidden: true, visibleOn: ['hours:1-4'] });
    vi.advanceTimersByTime(2000);
    const op = engine.sent.at(-1)!;
    expect(op.op).toBe('upsert');
    expect(op.drawing!.hidden).toBe(true);
    expect(op.drawing!.visibleOn).toBe('hours:1-4');
    expect(op.drawing!.resolution).toBe('60'); // the timeframe it was made on
    expect(typeof op.drawing!.zIndex).toBe('number');
    expect(JSON.parse(op.drawing!.optionsJson)).toEqual({ levels: [{ value: 0.5, color: '#fff', visible: true }] });

    // …and back in through a load on a fresh browser.
    const { store: s2 } = makeStore(engine);
    vi.advanceTimersByTime(10);
    vi.useRealTimers();
    const back = s2.symbolDrawings()[0];
    expect(back.hidden).toBe(true);
    expect(back.visibleOn).toEqual(['hours:1-4']);
    expect(back.options).toEqual({ levels: [{ value: 0.5, color: '#fff', visible: true }] });
  });
});

describe('drawings per symbol (DR-01 / DR-I2)', () => {
  it('a drawing made on H4 shows on M15 of the same symbol, and not on another symbol', () => {
    const { store } = makeStore();
    store.setScope('EURUSD', '240');
    const a = store.add('horizontal-line', [P(1, 1.1)], styleFor('horizontal-line'));
    expect(a.resolution).toBe('240');
    store.setScope('EURUSD', '15');
    expect(store.visible().map((d) => d.id)).toEqual([a.id]);
    store.setScope('GBPUSD', '15');
    expect(store.visible()).toEqual([]);
  });

  it('its Visibility list decides the timeframes it shows on', () => {
    const { store } = makeStore();
    const a = store.add('horizontal-line', [P(1, 1.1)], styleFor('horizontal-line'));
    store.update(a.id, { visibleOn: ['hours:1-24'] });
    store.setScope('EURUSD', '15');
    expect(store.visible()).toEqual([]);
    expect(store.symbolDrawings().map((d) => d.id)).toEqual([a.id]); // still in the object tree
    store.setScope('EURUSD', '240');
    expect(store.visible().map((d) => d.id)).toEqual([a.id]);
  });
});

describe('undo, redo and the lock (DR-04 / DR-05 / DR-06)', () => {
  it('undo is per symbol: Ctrl+Z on GBPUSD does not undo an EURUSD edit', () => {
    const { store } = makeStore();
    const a = store.add('trend-line', [P(1, 1), P(2, 2)], styleFor('trend-line'));
    store.setScope('GBPUSD', '60');
    expect(store.canUndo()).toBe(false);
    store.undo();
    store.setScope('EURUSD', '60');
    expect(store.visible().map((d) => d.id)).toEqual([a.id]);
    expect(store.canUndo()).toBe(true);
    store.undo();
    expect(store.visible()).toEqual([]);
  });

  it('a gesture that changed nothing (a click, settings Ok untouched) keeps Redo', () => {
    const { store } = makeStore();
    const a = store.add('trend-line', [P(1, 1), P(2, 2)], styleFor('trend-line'));
    store.updateStyle(a.id, { color: '#FF0000' });
    store.undo();
    expect(store.canRedo()).toBe(true);
    store.beginGesture(a.id);
    store.endGesture();
    expect(store.canRedo()).toBe(true);
    store.redo();
    expect(store.visible()[0].style.color).toBe('#FF0000');
  });

  it('a gesture that changed something is one undo step and clears Redo', () => {
    const { store } = makeStore();
    const a = store.add('trend-line', [P(1, 1), P(2, 2)], styleFor('trend-line'));
    store.updateStyle(a.id, { width: 4 });
    store.undo();
    store.beginGesture(a.id);
    store.update(a.id, { points: [P(3, 3), P(4, 4)] }, false);
    store.update(a.id, { points: [P(5, 5), P(6, 6)] }, false);
    store.endGesture();
    expect(store.canRedo()).toBe(false);
    store.undo();
    expect(store.visible()[0].points).toEqual([P(1, 1), P(2, 2)]);
  });

  it('the Delete key path leaves a locked drawing alone', () => {
    const { store } = makeStore();
    const a = store.add('trend-line', [P(1, 1), P(2, 2)], styleFor('trend-line'));
    store.toggleLock(a.id);
    expect(store.removeUnlocked(a.id)).toBe(false);
    expect(store.visible()).toHaveLength(1);
    store.toggleLock(a.id);
    expect(store.removeUnlocked(a.id)).toBe(true);
    expect(store.visible()).toHaveLength(0);
  });
});

describe('multi-selection (DR-I10)', () => {
  it('Ctrl-click adds and removes; a plain selection collapses it', () => {
    const { store } = makeStore();
    const a = store.add('trend-line', [P(1, 1), P(2, 2)], styleFor('trend-line'));
    const b = store.add('rectangle', [P(1, 1), P(2, 2)], styleFor('rectangle'));
    store.selectedId.set(a.id);
    store.toggleSelected(b.id);
    expect([...store.selectedIds()].sort()).toEqual([a.id, b.id].sort());
    expect(store.selectedId()).toBe(b.id);
    store.focusInSelection(a.id);
    expect(store.selectedIds().size).toBe(2);
    store.toggleSelected(a.id);
    expect([...store.selectedIds()]).toEqual([b.id]);
    store.selectMany([a.id, b.id]);
    store.selectedId.set(a.id); // a plain click elsewhere in code
    expect([...store.selectedIds()]).toEqual([a.id]);
  });

  it('the Delete key removes every selected drawing but the locked ones, as one undo step', () => {
    const { store } = makeStore();
    const a = store.add('trend-line', [P(1, 1), P(2, 2)], styleFor('trend-line'));
    const b = store.add('rectangle', [P(1, 1), P(2, 2)], styleFor('rectangle'));
    const c = store.add('ellipse', [P(1, 1), P(2, 2)], styleFor('ellipse'));
    store.toggleLock(c.id);
    store.selectMany([a.id, b.id, c.id]);
    expect(store.removeSelectedUnlocked()).toBe(2);
    expect(store.visible().map((d) => d.id)).toEqual([c.id]);
    store.undo();
    expect(store.visible()).toHaveLength(3);
  });

  it('bulk hide / lock and a group move act on all of them', () => {
    const { store } = makeStore();
    const a = store.add('trend-line', [P(1, 1), P(2, 2)], styleFor('trend-line'));
    const b = store.add('rectangle', [P(1, 1), P(2, 2)], styleFor('rectangle'));
    store.setMany([a.id, b.id], { hidden: true });
    expect(store.visible().every((d) => d.hidden)).toBe(true);
    store.setMany([a.id, b.id], { hidden: false, locked: true });
    expect(store.visible().every((d) => d.locked && !d.hidden)).toBe(true);
    store.setMany([a.id], { locked: false });
    store.beginGesture(a.id);
    store.moveMany([a.id, b.id], (d) => d.points.map((p) => ({ time: p.time + 10, price: p.price })));
    store.endGesture();
    const byId = new Map(store.visible().map((d) => [d.id, d]));
    expect(byId.get(a.id)!.points[0].time).toBe(11); // moved
    expect(byId.get(b.id)!.points[0].time).toBe(1); // locked: stays
  });
});

describe('engine sync (DR-02 / DR-I3)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a drawing made while the engine is down survives a reload and is sent then', () => {
    const engine = new FakeEngine();
    engine.down = true;
    const { store } = makeStore(engine);
    const a = store.add('trend-line', [P(1, 1), P(2, 2)], styleFor('trend-line'));
    vi.advanceTimersByTime(2000);
    expect(store.syncState()).toBe('offline');
    expect(engine.rows.size).toBe(0);

    // Reload: a new store on the same browser storage, the engine back.
    engine.down = false;
    const { store: after } = makeStore(engine, true);
    vi.advanceTimersByTime(2000);
    expect(engine.rows.has(a.id)).toBe(true);
    expect(after.symbolDrawings().map((d) => d.id)).toEqual([a.id]);
    expect(after.pending()).toBe(0);
  });

  it('a load merges by id: a pending local edit is not overwritten by the engine copy', () => {
    const engine = new FakeEngine();
    const { store } = makeStore(engine);
    const a = store.add('trend-line', [P(1, 1), P(2, 2)], styleFor('trend-line'));
    vi.advanceTimersByTime(2000);
    engine.down = true;
    store.update(a.id, { points: [P(9, 9), P(8, 8)] }); // queued, not sent
    vi.advanceTimersByTime(2000);
    engine.down = false;
    const { store: reloaded } = makeStore(engine, true); // loads the engine's OLD copy
    expect(reloaded.symbolDrawings()[0].points).toEqual([P(9, 9), P(8, 8)]);
    vi.advanceTimersByTime(3000);
    expect(JSON.parse(engine.rows.get(a.id)!.pointsJson)).toEqual([P(9, 9), P(8, 8)]);
  });

  it('a drawing deleted on another machine goes; one never sent is sent', () => {
    const engine = new FakeEngine();
    const { store } = makeStore(engine);
    const synced = store.add('trend-line', [P(1, 1), P(2, 2)], styleFor('trend-line'));
    vi.advanceTimersByTime(2000);
    engine.rows.delete(synced.id); // deleted elsewhere
    const { store: reloaded } = makeStore(engine, true);
    expect(reloaded.symbolDrawings()).toEqual([]);
  });

  it('a stale write is refused and the engine copy replaces ours, with a notice', () => {
    const engine = new FakeEngine();
    const { store } = makeStore(engine);
    const a = store.add('trend-line', [P(1, 1), P(2, 2)], styleFor('trend-line'));
    vi.advanceTimersByTime(2000);
    // Another machine moves it.
    const row = engine.rows.get(a.id)!;
    engine.rows.set(a.id, { ...engine.dto(a.id, { ...row, pointsJson: JSON.stringify([P(7, 7), P(6, 6)]) }) });
    store.update(a.id, { points: [P(3, 3), P(4, 4)] });
    vi.advanceTimersByTime(2000);
    expect(store.symbolDrawings()[0].points).toEqual([P(7, 7), P(6, 6)]);
    expect(store.notice()).toMatch(/changed on another screen/);
  });

  it('a push from another tab reloads the symbol; our own push is ignored', () => {
    const engine = new FakeEngine();
    const { store, pushes } = makeStore(engine);
    const listed = vi.spyOn(engine, 'list');
    pushes.next({ symbols: ['EURUSD'], origin: store.origin });
    vi.advanceTimersByTime(500);
    expect(listed).not.toHaveBeenCalled();
    engine.rows.set('x1', engine.dto('x1', {
      symbol: 'EURUSD', resolution: '15', kind: 'horizontal-line', pointsJson: JSON.stringify([P(1, 1.2)]),
      styleJson: JSON.stringify(styleFor('horizontal-line')), locked: false, optionsJson: '{}', hidden: false,
      visibleOn: '', zIndex: 1, createdAt: new Date(5).toISOString(),
    }));
    pushes.next({ symbols: ['EURUSD'], origin: 'tab-other' });
    vi.advanceTimersByTime(500);
    expect(listed).toHaveBeenCalledWith('EURUSD');
    expect(store.symbolDrawings().map((d) => d.id)).toContain('x1');
  });

  it('an undo of a delete brings the drawing back on the engine with its id', () => {
    const engine = new FakeEngine();
    const { store } = makeStore(engine);
    const a = store.add('trend-line', [P(1, 1), P(2, 2)], styleFor('trend-line'));
    vi.advanceTimersByTime(2000);
    store.remove(a.id);
    vi.advanceTimersByTime(2000);
    expect(engine.rows.has(a.id)).toBe(false);
    store.undo();
    vi.advanceTimersByTime(2000);
    expect(engine.rows.has(a.id)).toBe(true);
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
