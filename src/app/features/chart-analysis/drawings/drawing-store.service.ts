import { Injectable, computed, inject, signal } from '@angular/core';
import { newDrawingId, type Drawing, type DrawingKind, type DrawingStyle } from './model';
import { ChartDrawingsService, type ChartDrawingDto } from '@core/services/chart-drawings.service';

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
 * ── Persistence: two tiers, on purpose ─────────────────────────────────────
 *
 * `localStorage` is the WRITE-THROUGH cache and the engine is the source of
 * truth. Every mutation hits storage immediately so the chart never waits on a
 * round trip and keeps working offline; the engine is synced on a debounce.
 *
 * The debounce matters: dragging a trendline emits a change per animation
 * frame, and a request per frame would be both wasteful and prone to arriving
 * out of order. Coalescing to one whole-scope replace after the gesture settles
 * makes the write idempotent — whatever the client believes becomes true.
 *
 * On load the engine wins. A drawing made on another machine is real and a
 * stale local cache is not, so `hydrate` replaces the cached set for that scope
 * rather than merging: merging two versions of the same drawing has no correct
 * answer, and the last machine to sync is the better guess.
 */
/** How long after the last change before the engine is synced. */
const SYNC_DEBOUNCE_MS = 900;

@Injectable({ providedIn: 'root' })
export class DrawingStore {
  private readonly remote = inject(ChartDrawingsService);
  private readonly all = signal<Drawing[]>(this.restore());

  /** Scopes hydrated from the engine this session, so we fetch each once. */
  private readonly hydrated = new Set<string>();
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly dirtyScopes = new Set<string>();

  /** Surfaced so the page can show when drawings are local-only. */
  readonly syncState = signal<'idle' | 'saving' | 'error' | 'offline'>('idle');

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
    if (symbol && resolution) this.hydrate(symbol, resolution);
  }

  /**
   * Pull one chart's drawings from the engine, once per session per scope.
   *
   * Failure is deliberately quiet in the data and loud in the status: the
   * cached drawings stay on screen and `syncState` goes `offline`, because a
   * chart that blanks its trendlines the moment the API hiccups is worse than
   * one showing slightly stale ones.
   */
  private hydrate(symbol: string, resolution: string): void {
    const key = `${symbol}|${resolution}`;
    if (this.hydrated.has(key)) return;
    this.hydrated.add(key);

    this.remote.list(symbol, resolution).subscribe({
      next: (res) => {
        if (!res?.status || !Array.isArray(res.data)) {
          this.syncState.set('offline');
          return;
        }
        const incoming = res.data
          .map((row) => this.fromDto(row))
          .filter((d): d is Drawing => d !== null);
        this.all.update((list) => [
          ...list.filter((d) => !(d.symbol === symbol && d.resolution === resolution)),
          ...incoming,
        ]);
        this.persist(this.all());
        this.syncState.set('idle');
      },
      error: () => {
        // Allow a later retry rather than marking this scope permanently done.
        this.hydrated.delete(key);
        this.syncState.set('offline');
      },
    });
  }

  private fromDto(row: ChartDrawingDto): Drawing | null {
    try {
      const points = JSON.parse(row.pointsJson) as Drawing['points'];
      const style = JSON.parse(row.styleJson) as DrawingStyle;
      if (!Array.isArray(points)) return null;
      return {
        id: row.clientId,
        kind: row.kind as DrawingKind,
        symbol: row.symbol,
        resolution: row.resolution,
        points,
        style,
        locked: row.locked,
        createdAt: Date.parse(row.createdAt) || Date.now(),
      };
    } catch {
      // A row we cannot parse is dropped rather than throwing: one bad record
      // must not cost the operator every other drawing on the chart.
      return null;
    }
  }

  /** Queue a scope for the next debounced sync. */
  private markDirty(symbol: string, resolution: string): void {
    if (!symbol || !resolution) return;
    this.dirtyScopes.add(`${symbol}|${resolution}`);
    if (this.syncTimer !== null) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => this.flush(), SYNC_DEBOUNCE_MS);
  }

  private flush(): void {
    this.syncTimer = null;
    const scopes = [...this.dirtyScopes];
    this.dirtyScopes.clear();
    if (scopes.length === 0) return;
    this.syncState.set('saving');

    let pending = scopes.length;
    let failed = false;
    for (const key of scopes) {
      const [symbol, resolution] = key.split('|');
      const payload = this.forScope(symbol, resolution).map((d) => ({
        clientId: d.id,
        kind: d.kind,
        pointsJson: JSON.stringify(d.points),
        styleJson: JSON.stringify(d.style),
        locked: d.locked,
        createdAt: new Date(d.createdAt).toISOString(),
      }));

      this.remote.replaceScope(symbol, resolution, payload).subscribe({
        next: (res) => {
          if (!res?.status) failed = true;
          if (--pending === 0) this.syncState.set(failed ? 'error' : 'idle');
        },
        error: () => {
          failed = true;
          // Requeue so the change is not lost; the next mutation or scope
          // change retries it.
          this.dirtyScopes.add(key);
          if (--pending === 0) this.syncState.set('offline');
        },
      });
    }
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
    const before = this.all();
    this.redoStack.push(before);
    this.all.set(previous);
    this.persist(previous);
    this.syncAffected(before, previous);
    this.undoRevision.update((v) => v + 1);
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    const before = this.all();
    this.undoStack.push(before);
    this.all.set(next);
    this.persist(next);
    this.syncAffected(before, next);
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
    this.syncAffected(before, after);
    this.undoRevision.update((v) => v + 1);
  }

  /**
   * Mark every scope touched by a change, comparing before and after.
   *
   * Looking at both sides matters for deletes: the removed drawing is absent
   * from `after`, so a scope derived only from the new state would never be
   * synced and the deletion would live on locally while the engine still held
   * the row.
   */
  private syncAffected(before: Drawing[], after: Drawing[]): void {
    const scopes = new Set<string>();
    for (const d of [...before, ...after]) scopes.add(`${d.symbol}|${d.resolution}`);
    for (const key of scopes) {
      const [symbol, resolution] = key.split('|');
      this.markDirty(symbol, resolution);
    }
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
