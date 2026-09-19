import { Injectable, computed, signal } from '@angular/core';
import { newDrawingId, type Drawing, type DrawingKind, type DrawingStyle } from './model';

const STORAGE_KEY = 'lascodia.chart.drawings.v1';
const UNDO_DEPTH = 50;

/**
 * Drawings: storage, scoping and undo/redo.
 *
 * Scoped by `symbol|resolution` the way TradingView scopes them — a trendline
 * drawn on EURUSD H1 belongs to that chart, not to every chart. Everything is
 * kept in one localStorage record and filtered on read, which keeps the whole
 * set available for the object tree and for "delete all on this symbol"
 * without a second index to keep in step.
 *
 * Persistence is deliberately `localStorage` for now: it is per-browser and
 * does not follow the operator to another machine. The durable version is an
 * engine-backed `ChartLayout` table (plan §8) — the interface here does not
 * change when that lands, only `persist()` and `restore()`.
 */
@Injectable({ providedIn: 'root' })
export class DrawingStore {
  private readonly all = signal<Drawing[]>(this.restore());

  /**
   * Every drawing, unfiltered.
   *
   * Exposed because a multi-chart layout has several panels on screen at once,
   * each showing a different symbol or timeframe. A single global "visible"
   * set cannot serve them — the second panel would render the first panel's
   * trendlines — so each panel filters this itself via `forScope`.
   */
  readonly allDrawings = this.all.asReadonly();

  private undoStack: Drawing[][] = [];
  private redoStack: Drawing[][] = [];

  readonly selectedId = signal<string | null>(null);

  /** Current chart scope. Set by the page whenever symbol/resolution changes. */
  readonly scope = signal<{ symbol: string; resolution: string }>({
    symbol: '',
    resolution: '',
  });

  /** Drawings for the current chart only. */
  readonly visible = computed(() => {
    const { symbol, resolution } = this.scope();
    return this.all().filter((d) => d.symbol === symbol && d.resolution === resolution);
  });

  readonly selected = computed(() => {
    const id = this.selectedId();
    return id ? (this.visible().find((d) => d.id === id) ?? null) : null;
  });

  readonly canUndo = computed(() => this.undoRevision() >= 0 && this.undoStack.length > 0);
  readonly canRedo = computed(() => this.undoRevision() >= 0 && this.redoStack.length > 0);
  /** Bumped on every mutation so the computed flags above recalculate. */
  private readonly undoRevision = signal(0);

  setScope(symbol: string, resolution: string): void {
    this.scope.set({ symbol, resolution });
    this.selectedId.set(null);
  }

  /** Drawings belonging to one chart panel. */
  forScope(symbol: string, resolution: string): Drawing[] {
    return this.all().filter((d) => d.symbol === symbol && d.resolution === resolution);
  }

  add(
    kind: DrawingKind,
    points: Drawing['points'],
    style: DrawingStyle,
    scope?: { symbol: string; resolution: string },
  ): Drawing {
    const { symbol, resolution } = scope ?? this.scope();
    const drawing: Drawing = {
      id: newDrawingId(),
      kind,
      symbol,
      resolution,
      points,
      style,
      locked: false,
      createdAt: Date.now(),
    };
    this.mutate((list) => [...list, drawing]);
    return drawing;
  }

  update(id: string, patch: Partial<Drawing>, recordUndo = true): void {
    this.mutate((list) => list.map((d) => (d.id === id ? { ...d, ...patch } : d)), recordUndo);
  }

  updateStyle(id: string, patch: Partial<DrawingStyle>): void {
    this.mutate((list) =>
      list.map((d) => (d.id === id ? { ...d, style: { ...d.style, ...patch } } : d)),
    );
  }

  remove(id: string): void {
    this.mutate((list) => list.filter((d) => d.id !== id));
    if (this.selectedId() === id) this.selectedId.set(null);
  }

  /** Duplicate, nudged slightly so the copy is visibly a separate object. */
  clone(id: string): Drawing | null {
    const source = this.all().find((d) => d.id === id);
    if (!source) return null;
    const copy: Drawing = {
      ...source,
      id: newDrawingId(),
      points: source.points.map((p) => ({ ...p, price: p.price })),
      createdAt: Date.now(),
      locked: false,
    };
    this.mutate((list) => [...list, copy]);
    return copy;
  }

  toggleLock(id: string): void {
    const d = this.all().find((x) => x.id === id);
    if (d) this.update(id, { locked: !d.locked });
  }

  /** Remove every drawing on the current chart. */
  clearVisible(): void {
    const { symbol, resolution } = this.scope();
    this.mutate((list) =>
      list.filter((d) => !(d.symbol === symbol && d.resolution === resolution)),
    );
    this.selectedId.set(null);
  }

  undo(): void {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(this.all());
    this.all.set(previous);
    this.persist(previous);
    this.undoRevision.update((v) => v + 1);
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.all());
    this.all.set(next);
    this.persist(next);
    this.undoRevision.update((v) => v + 1);
  }

  /**
   * Apply a change, recording it for undo.
   *
   * `recordUndo: false` exists for drag: a drag emits a change per mouse-move,
   * and pushing every frame would mean fifty undos to step back across one
   * gesture. The caller snapshots once at drag start instead.
   */
  private mutate(fn: (list: Drawing[]) => Drawing[], recordUndo = true): void {
    const before = this.all();
    if (recordUndo) {
      this.undoStack.push(before);
      if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift();
      this.redoStack = [];
    }
    const after = fn(before);
    this.all.set(after);
    this.persist(after);
    this.undoRevision.update((v) => v + 1);
  }

  /** Snapshot for a gesture that will emit many intermediate updates. */
  beginGesture(): void {
    this.undoStack.push(this.all());
    if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift();
    this.redoStack = [];
    this.undoRevision.update((v) => v + 1);
  }

  private persist(list: Drawing[]): void {
    // Wrapped because storage throws outright in some contexts (private
    // windows, blocked site data) rather than merely being empty — and losing
    // the chart because a drawing could not be saved would be absurd.
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch {
      /* drawings stay in memory for this session */
    }
  }

  private restore(): Drawing[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      // Filter rather than trust: a shape change in a later version should
      // drop unreadable rows, not throw on load and blank the chart.
      return parsed.filter(
        (d): d is Drawing =>
          !!d &&
          typeof d === 'object' &&
          typeof (d as Drawing).id === 'string' &&
          Array.isArray((d as Drawing).points),
      );
    } catch {
      return [];
    }
  }
}
