import { Injectable, computed, inject, signal } from '@angular/core';
import { newDrawingId, type Drawing, type DrawingKind, type DrawingStyle } from './model';
import { isShownOn, reorder, shiftPoints, topZ, type ZOrderOp } from './drawing-ops';
import { behaviorFor } from './tools/registry';
import {
  ChartDrawingsService,
  type ChartDrawingDto,
  type ChartDrawingOp,
  type ChartDrawingOpResult,
  type ChartDrawingsChanged,
} from '@core/services/chart-drawings.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import {
  coalesce,
  isTransient,
  readSyncState,
  sameContent,
  writeSyncState,
  type OutboxEntry,
} from './drawing-sync';

const STORAGE_KEY = 'lascodia.chart.drawings.v1';
const UNDO_DEPTH = 50;
/** How long after the last change before the engine is written. */
const SYNC_DEBOUNCE_MS = 900;
/** Writes per request (the engine takes 500). */
const BATCH = 200;
/** Retry delay after a failed write, doubling to a ceiling. */
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 60_000;

/**
 * Drawings: storage, scoping, undo/redo and sync with the engine.
 *
 * ── Scope: per symbol (DR-01 / DR-I2) ───────────────────────────────────────
 *
 * A drawing belongs to its SYMBOL and remembers the timeframe it was made on, as on TradingView: a level drawn on
 * EURUSD H4 shows on M15 too, unless its Visibility tab lists the timeframes it shows on (`visibleOn`). The chart
 * shows a symbol's drawings filtered by its own timeframe (`visible`); the object tree lists all of the symbol's
 * (`symbolDrawings`). Undo and redo are per symbol (DR-05): Ctrl+Z on GBPUSD never undoes an EURUSD edit.
 *
 * ── Persistence: local first, then the engine, one drawing at a time (DR-02 / DR-I3) ──
 *
 * `localStorage` holds the drawings (written through on every change) AND the outbox of writes the engine has not
 * acknowledged, so a drawing made while the engine is down, or in the second before a reload, survives the reload
 * and is sent then. Each write names the server version it was made from; a drawing changed on another machine
 * since comes back `-409` with the engine's copy, which replaces ours (the engine wins, and `notice` says so). Loads
 * MERGE by id rather than replace: a drawing with a write still in the outbox keeps the local copy. Other tabs and
 * machines learn of a change from the `chartDrawingsChanged` push and reload that symbol.
 */
@Injectable({ providedIn: 'root' })
export class DrawingStore {
  private readonly remote = inject(ChartDrawingsService);
  private readonly realtime = inject(RealtimeService, { optional: true });

  /** This tab, for the realtime push: a change it made itself is not reloaded. */
  readonly origin = `tab-${Math.random().toString(36).slice(2, 10)}`;

  private readonly all = signal<Drawing[]>(this.restore());

  /** The engine's version (`updatedAt`) of each drawing it has acknowledged. */
  private readonly versions = new Map<string, string>();
  /** Writes not yet acknowledged, latest per drawing. */
  private readonly outbox = new Map<string, OutboxEntry>();
  /** Outbox entries acknowledged since the last persist: removed from storage only if unchanged there. */
  private readonly acked = new Map<string, string>();
  /** Drawings whose version went (deleted) since the last persist. */
  private readonly forgotten = new Set<string>();
  private seq = 0;

  /** Symbols loaded from the engine this session (and those being loaded). */
  private readonly hydrated = new Set<string>();
  private readonly reloadTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private retryMs = RETRY_MIN_MS;

  /** Surfaced so the page can show when drawings are local-only. */
  readonly syncState = signal<'idle' | 'saving' | 'error' | 'offline'>('idle');
  /** Writes waiting for the engine (shown with the sync state). */
  readonly pending = signal(0);
  /**
   * The last thing the operator should know about the sync: drawings changed elsewhere replaced ours, or the
   * engine refused one. Null when there is nothing to say.
   */
  readonly notice = signal<string | null>(null);

  constructor() {
    const stored = readSyncState();
    for (const [id, v] of Object.entries(stored.versions)) this.versions.set(id, v);
    for (const [id, e] of Object.entries(stored.outbox)) this.outbox.set(id, e);
    this.pending.set(this.outbox.size);

    // `pagehide` fires on close, reload and bfcache; `visibilitychange` covers mobile tab kills.
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => this.flushOnHide());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.flushOnHide();
      });
    }
    this.realtime
      ?.on<ChartDrawingsChanged>('chartDrawingsChanged')
      .subscribe((e) => this.onRemoteChange(e));

    // Writes left from an earlier session (the engine was down, or the tab closed first) go now.
    if (this.outbox.size) this.scheduleSync(0);
  }

  /**
   * Every drawing, unfiltered.
   *
   * Exposed because a multi-chart layout has several panels on screen at once, each showing a different symbol or
   * timeframe; each panel filters this itself.
   */
  readonly allDrawings = this.all.asReadonly();

  /** The selected drawing: the one the floating toolbar and Settings act on (the last one clicked). */
  readonly selectedId = signal<string | null>(null);
  /**
   * A multi-selection (Ctrl/Cmd-click, DR-I10) and the primary drawing it was made with. It holds only while
   * `selectedId` is still that primary: any other `selectedId.set(...)` — a plain click, Esc, a delete — is a single
   * selection again, with no bookkeeping at the call sites.
   */
  private readonly multi = signal<{ primary: string | null; ids: ReadonlySet<string> }>({
    primary: null,
    ids: new Set(),
  });

  /** Every selected drawing: the primary one and those selected with it. */
  readonly selectedIds = computed<ReadonlySet<string>>(() => {
    const id = this.selectedId();
    const m = this.multi();
    if (m.ids.size > 1 && m.primary === id) return m.ids;
    return id ? new Set([id]) : new Set();
  });

  /** Current chart: the symbol whose drawings are edited, and the timeframe new drawings are made on. */
  readonly scope = signal<{ symbol: string; resolution: string }>({ symbol: '', resolution: '' });

  /** Every drawing of the current symbol, whatever timeframe it shows on (the object tree). */
  readonly symbolDrawings = computed(() => {
    const { symbol } = this.scope();
    return this.all().filter((d) => d.symbol === symbol);
  });

  /**
   * The drawings ON the current chart: the symbol's drawings its Visibility list shows on this timeframe —
   * including ones hidden with the eye (they stay on the chart, just not painted).
   */
  readonly visible = computed(() => {
    const { symbol, resolution } = this.scope();
    return this.all().filter((d) => d.symbol === symbol && isShownOn(d, resolution));
  });

  readonly selected = computed(() => {
    const id = this.selectedId();
    return id ? (this.symbolDrawings().find((d) => d.id === id) ?? null) : null;
  });

  /** Bumped on every mutation so the undo flags recalculate. */
  private readonly undoRevision = signal(0);
  private readonly undoStacks = new Map<string, Drawing[][]>();
  private readonly redoStacks = new Map<string, Drawing[][]>();

  readonly canUndo = computed(
    () => this.undoRevision() >= 0 && (this.undoStacks.get(this.scope().symbol)?.length ?? 0) > 0,
  );
  readonly canRedo = computed(
    () => this.undoRevision() >= 0 && (this.redoStacks.get(this.scope().symbol)?.length ?? 0) > 0,
  );

  setScope(symbol: string, resolution: string): void {
    const prev = this.scope();
    this.scope.set({ symbol, resolution });
    if (prev.symbol !== symbol) this.selectedId.set(null);
    if (symbol) this.ensureSymbol(symbol);
  }

  /** Load a symbol's drawings from the engine once per session (a split panel's symbol too). */
  ensureSymbol(symbol: string): void {
    if (!symbol || this.hydrated.has(symbol)) return;
    this.hydrated.add(symbol);
    this.load(symbol);
  }

  /**
   * Pull one symbol's drawings from the engine and MERGE them by id.
   *
   * Failure is deliberately quiet in the data and loud in the status: the cached drawings stay on screen and
   * `syncState` goes `offline`, because a chart that blanks its trendlines the moment the API hiccups is worse
   * than one showing slightly stale ones.
   */
  private load(symbol: string): void {
    this.remote.list(symbol).subscribe({
      next: (res) => {
        if (!res?.status || !Array.isArray(res.data)) {
          this.syncState.set('offline');
          return;
        }
        this.mergeFromEngine(symbol, res.data);
        if (this.syncState() === 'offline')
          this.syncState.set(this.outbox.size ? 'saving' : 'idle');
      },
      error: () => {
        // Allow a later retry rather than marking this symbol permanently done.
        this.hydrated.delete(symbol);
        this.syncState.set('offline');
      },
    });
  }

  /**
   * The engine's copy of a symbol, merged into ours by id:
   * <ul>
   *   <li>a drawing with a write still in the outbox keeps the local copy (the write goes out against its base);</li>
   *   <li>any other drawing the engine has is taken from the engine (another machine may have moved it);</li>
   *   <li>a local drawing the engine does not have is dropped when the engine had acknowledged it before (it was
   *       deleted elsewhere) and sent when it never had been (made before this outbox existed, or the engine never
   *       got it).</li>
   * </ul>
   */
  private mergeFromEngine(symbol: string, rows: ChartDrawingDto[]): void {
    const incoming = new Map<string, Drawing>();
    for (const row of rows) {
      const d = fromDto(row);
      if (!d) continue;
      incoming.set(d.id, d);
      if (!this.outbox.has(d.id)) this.setVersion(d.id, row.updatedAt);
    }
    const local = this.all().filter((d) => d.symbol === symbol);
    const unsent: Drawing[] = [];
    const next: Drawing[] = [];
    for (const d of local) {
      if (isTransient(d)) {
        next.push(d);
        continue;
      }
      const server = incoming.get(d.id);
      if (this.outbox.has(d.id)) {
        next.push(d);
      } else if (server) {
        next.push(sameContent(d, server) ? d : server);
      } else if (!this.versions.has(d.id)) {
        next.push(d);
        unsent.push(d);
      } // else: acknowledged once, gone now — deleted elsewhere.
      incoming.delete(d.id);
    }
    next.push(...incoming.values());
    for (const d of local)
      if (!next.includes(d) && this.selectedId() === d.id) this.selectedId.set(null);
    for (const id of [...this.versions.keys()]) {
      if (!next.some((d) => d.id === id) && local.some((d) => d.id === id)) this.forgetVersion(id);
    }
    this.replaceSymbol(symbol, next);
    for (const d of unsent) this.enqueue({ op: 'upsert', drawing: d });
    this.persistSync();
  }

  /** A change pushed from elsewhere: reload the symbols this tab shows (debounced per symbol). */
  private onRemoteChange(e: ChartDrawingsChanged): void {
    if (!e || e.origin === this.origin) return;
    for (const symbol of e.symbols ?? []) {
      if (!this.hydrated.has(symbol)) continue;
      clearTimeout(this.reloadTimers.get(symbol));
      this.reloadTimers.set(
        symbol,
        setTimeout(() => {
          this.reloadTimers.delete(symbol);
          this.load(symbol);
        }, 300),
      );
    }
  }

  /** Drawings of one symbol. */
  forSymbol(symbol: string): Drawing[] {
    return this.all().filter((d) => d.symbol === symbol);
  }

  /** Drawings on one chart: the symbol's drawings shown on `resolution` (eye-hidden ones included). */
  forScope(symbol: string, resolution: string): Drawing[] {
    return this.all().filter((d) => d.symbol === symbol && isShownOn(d, resolution));
  }

  add(
    kind: DrawingKind,
    points: Drawing['points'],
    style: DrawingStyle,
    scope?: { symbol: string; resolution: string },
    extra?: Pick<Drawing, 'options'>,
  ): Drawing {
    const { symbol, resolution } = scope ?? this.scope();
    const drawing: Drawing = {
      id: newDrawingId(),
      kind,
      symbol,
      // The timeframe it is made on; it shows on every timeframe until its Visibility tab says otherwise.
      resolution,
      points,
      style,
      locked: false,
      createdAt: Date.now(),
      z: topZ(this.forSymbol(symbol)),
      ...(extra?.options ? { options: extra.options } : {}),
    };
    this.mutate(symbol, (list) => [...list, drawing]);
    return drawing;
  }

  update(id: string, patch: Partial<Drawing>, recordUndo = true): void {
    this.mutateById(id, (d) => ({ ...d, ...patch }), recordUndo);
  }

  updateStyle(id: string, patch: Partial<DrawingStyle>, recordUndo = true): void {
    this.mutateById(id, (d) => ({ ...d, style: { ...d.style, ...patch } }), recordUndo);
  }

  remove(id: string, recordUndo = true): void {
    const d = this.byId(id);
    if (!d) return;
    this.mutate(d.symbol, (list) => list.filter((x) => x.id !== id), recordUndo);
    if (this.selectedId() === id) this.selectedId.set(null);
  }

  /**
   * Delete a drawing unless it is locked — what the Delete key does (DR-06: it deleted locked drawings).
   * Returns whether it went. The menu's and the object tree's Remove are explicit and use {@link remove}.
   */
  removeUnlocked(id: string): boolean {
    const d = this.byId(id);
    if (!d || d.locked) return false;
    this.remove(id);
    return true;
  }

  /**
   * Duplicate a drawing on top of the stack (TV "Clone"). `points` lets a Ctrl-drag clone land where the pointer
   * took it; otherwise the copy sits exactly over the source, as TradingView's Clone does.
   */
  clone(id: string, points?: Drawing['points'], recordUndo = true): Drawing | null {
    const source = this.byId(id);
    if (!source) return null;
    const copy: Drawing = {
      ...structuredCloneDrawing(source),
      id: newDrawingId(),
      points: points ?? source.points.map((p) => ({ ...p })),
      createdAt: Date.now(),
      locked: false,
      hidden: false,
      z: topZ(this.forSymbol(source.symbol)),
    };
    this.mutate(source.symbol, (list) => [...list, copy], recordUndo);
    return copy;
  }

  // ── Clipboard (Cmd/Ctrl+C, Cmd/Ctrl+V) ──────────────────────────────────

  private clipboard: Drawing | null = null;

  copy(id: string): boolean {
    const d = this.byId(id);
    if (!d) return false;
    this.clipboard = structuredCloneDrawing(d);
    return true;
  }

  get hasClipboard(): boolean {
    return this.clipboard !== null;
  }

  /**
   * Paste the copied drawing into `scope`. Pasted onto the symbol it was copied from, it is offset by `offset`
   * (time, price) so it does not hide the original — TradingView shifts a paste the same way.
   */
  paste(scope: { symbol: string; resolution: string }, offset = { dt: 0, dp: 0 }): Drawing | null {
    const src = this.clipboard;
    if (!src) return null;
    const same = src.symbol === scope.symbol;
    const pasted: Drawing = {
      ...structuredCloneDrawing(src),
      id: newDrawingId(),
      symbol: scope.symbol,
      resolution: scope.resolution,
      points: same
        ? shiftPoints(src.points, offset.dt, offset.dp)
        : src.points.map((p) => ({ ...p })),
      createdAt: Date.now(),
      locked: false,
      hidden: false,
      z: topZ(this.forSymbol(scope.symbol)),
    };
    this.mutate(scope.symbol, (list) => [...list, pasted]);
    // Successive pastes keep stepping away from the last one.
    if (same) this.clipboard = structuredCloneDrawing(pasted);
    return pasted;
  }

  /** TV "Visual order": bring to front / send to back / forward / backward, among the symbol's drawings. */
  reorder(id: string, op: ZOrderOp): void {
    const d = this.byId(id);
    if (!d) return;
    const zs = reorder(this.forSymbol(d.symbol), id, op);
    this.mutate(d.symbol, (list) =>
      list.map((x) => (zs.has(x.id) ? { ...x, z: zs.get(x.id)! } : x)),
    );
  }

  // ── Multi-selection (DR-I10) ──────────────────────────────────────────────

  /** Ctrl/Cmd-click: add a drawing to the selection, or take it out. The last one added becomes the primary. */
  toggleSelected(id: string): void {
    const all = new Set(this.selectedIds());
    if (all.has(id)) all.delete(id);
    else all.add(id);
    this.selectMany([...all]);
  }

  /** Select exactly these drawings (Shift-click a range in the object tree); the last one is the primary. */
  selectMany(ids: readonly string[]): void {
    const primary = ids.at(-1) ?? null;
    this.multi.set({ primary, ids: new Set(ids) });
    this.selectedId.set(primary);
  }

  /** Make `id` — one of the multi-selection — the primary, keeping the others selected. */
  focusInSelection(id: string): void {
    const m = this.multi();
    if (!this.selectedIds().has(id)) return;
    if (m.ids.size > 1) this.multi.set({ primary: id, ids: m.ids });
    this.selectedId.set(id);
  }

  /** Delete every selected drawing that is not locked (the Delete key); returns how many went. */
  removeSelectedUnlocked(): number {
    const ids = [...this.selectedIds()].filter((id) => !this.byId(id)?.locked);
    if (!ids.length) return 0;
    const symbol = this.byId(ids[0])?.symbol ?? this.scope().symbol;
    const gone = new Set(ids);
    this.mutate(symbol, (list) => list.filter((d) => !gone.has(d.id)));
    this.selectedId.set(null);
    return ids.length;
  }

  /** Hide / show, lock / unlock several drawings as one undo step (the object tree's bulk actions). */
  setMany(ids: readonly string[], patch: Pick<Partial<Drawing>, 'hidden' | 'locked'>): void {
    const set = new Set(ids);
    const first = ids.length ? this.byId(ids[0]) : undefined;
    if (!first) return;
    this.mutate(first.symbol, (list) => list.map((d) => (set.has(d.id) ? { ...d, ...patch } : d)));
  }

  /** Remove several drawings as one undo step (the object tree's Delete — explicit, so locks do not stop it). */
  removeMany(ids: readonly string[]): void {
    const set = new Set(ids);
    const first = ids.length ? this.byId(ids[0]) : undefined;
    if (!first) return;
    this.mutate(first.symbol, (list) => list.filter((d) => !set.has(d.id)));
    if (this.selectedId() && set.has(this.selectedId()!)) this.selectedId.set(null);
  }

  /**
   * Move several drawings by the same change (a drag of one of a multi-selection), without an undo step of its
   * own — the drag's gesture is the step. `move` maps one drawing's points to their new place.
   */
  moveMany(ids: readonly string[], move: (d: Drawing) => Drawing['points']): void {
    const set = new Set(ids);
    const first = ids.length ? this.byId(ids[0]) : undefined;
    if (!first) return;
    this.mutate(
      first.symbol,
      (list) => list.map((d) => (set.has(d.id) && !d.locked ? { ...d, points: move(d) } : d)),
      false,
    );
  }

  /** Hide or show one drawing (TV's eye); it stays in the object tree either way. */
  setHidden(id: string, hidden: boolean): void {
    this.update(id, { hidden });
  }

  updateOptions(id: string, patch: Record<string, unknown>, recordUndo = true): void {
    this.mutateById(id, (d) => ({ ...d, options: { ...(d.options ?? {}), ...patch } }), recordUndo);
  }

  toggleLock(id: string): void {
    const d = this.byId(id);
    if (d) this.update(id, { locked: !d.locked });
  }

  /** Whether every drawing on the current chart is locked. */
  readonly allLocked = computed(() => {
    const v = this.visible();
    return v.length > 0 && v.every((d) => d.locked);
  });

  /** Lock or unlock every drawing on the current chart (one undo step). */
  setLockAll(locked: boolean): void {
    const ids = new Set(this.visible().map((d) => d.id));
    this.mutate(this.scope().symbol, (list) =>
      list.map((d) => (ids.has(d.id) ? { ...d, locked } : d)),
    );
  }

  /** Hide all drawings without deleting them — a view toggle, not an edit. */
  readonly hidden = signal(false);

  /** Remove every drawing on the current chart (the symbol's drawings shown on this timeframe). */
  clearVisible(): void {
    const ids = new Set(this.visible().map((d) => d.id));
    this.mutate(this.scope().symbol, (list) => list.filter((d) => !ids.has(d.id)));
    this.selectedId.set(null);
  }

  undo(): void {
    const symbol = this.scope().symbol;
    const previous = this.undoStacks.get(symbol)?.pop();
    if (!previous) return;
    this.stack(this.redoStacks, symbol).push(this.forSymbol(symbol));
    this.restoreSymbol(symbol, previous);
  }

  redo(): void {
    const symbol = this.scope().symbol;
    const next = this.redoStacks.get(symbol)?.pop();
    if (!next) return;
    this.stack(this.undoStacks, symbol).push(this.forSymbol(symbol));
    this.restoreSymbol(symbol, next);
  }

  // ── Gestures: a drag, or the settings dialog's live preview ──────────────

  private gesture: { symbol: string; snapshot: Drawing[]; redo: Drawing[][] } | null = null;

  /**
   * Snapshot for a gesture that will emit many intermediate updates (a drag, the settings dialog). It is one
   * undo step; `drawingId` names the symbol (a split panel's drawing is not on the current symbol).
   */
  beginGesture(drawingId?: string): void {
    const symbol = (drawingId && this.byId(drawingId)?.symbol) || this.scope().symbol;
    const snapshot = this.forSymbol(symbol);
    this.gesture = { symbol, snapshot, redo: [...(this.redoStacks.get(symbol) ?? [])] };
    this.pushUndo(symbol, snapshot);
    this.undoRevision.update((v) => v + 1);
  }

  /**
   * End a gesture. One that changed nothing — a click on a drawing, settings opened and closed with Ok untouched
   * — leaves no undo step and gives Redo back (DR-04: every click wiped it).
   */
  endGesture(): void {
    const g = this.gesture;
    this.gesture = null;
    if (!g) return;
    const now = this.forSymbol(g.symbol);
    const unchanged =
      now.length === g.snapshot.length &&
      now.every((d, i) => d === g.snapshot[i] || sameContent(d, g.snapshot[i]));
    if (!unchanged) {
      // A real edit: like any other, it ends what Redo could bring back.
      this.redoStacks.delete(g.symbol);
      this.undoRevision.update((v) => v + 1);
      return;
    }
    const undo = this.undoStacks.get(g.symbol);
    if (undo?.at(-1) === g.snapshot) undo.pop();
    this.redoStacks.set(g.symbol, g.redo);
    this.undoRevision.update((v) => v + 1);
  }

  /** Abandon the gesture opened by `beginGesture` and restore its snapshot — the settings dialog's Cancel. */
  cancelGesture(): void {
    const g = this.gesture;
    this.gesture = null;
    const symbol = g?.symbol ?? this.scope().symbol;
    const undo = this.undoStacks.get(symbol);
    const snapshot = g ? (undo?.at(-1) === g.snapshot ? undo.pop() : g.snapshot) : undo?.pop();
    if (!snapshot) return;
    if (g) this.redoStacks.set(symbol, g.redo);
    this.restoreSymbol(symbol, snapshot);
  }

  // ── Mutation, undo and the outbox ────────────────────────────────────────

  private byId(id: string): Drawing | undefined {
    return this.all().find((d) => d.id === id);
  }

  private mutateById(id: string, fn: (d: Drawing) => Drawing, recordUndo = true): void {
    const d = this.byId(id);
    if (!d) return;
    this.mutate(d.symbol, (list) => list.map((x) => (x.id === id ? fn(x) : x)), recordUndo);
  }

  /**
   * Apply a change to one symbol's drawings, recording it for that symbol's undo and queueing the engine writes.
   *
   * `recordUndo: false` exists for drag: a drag emits a change per mouse-move, and pushing every frame would mean
   * fifty undos to step back across one gesture. The caller snapshots once at the gesture's start instead.
   */
  private mutate(symbol: string, fn: (list: Drawing[]) => Drawing[], recordUndo = true): void {
    const before = this.forSymbol(symbol);
    if (recordUndo) {
      this.pushUndo(symbol, before);
      this.redoStacks.delete(symbol);
    }
    const after = fn(before);
    this.replaceSymbol(symbol, after);
    this.queueDiff(before, after);
    this.undoRevision.update((v) => v + 1);
  }

  /** Undo / redo / cancel: put a symbol back as `snapshot`, writing the difference to the engine. */
  private restoreSymbol(symbol: string, snapshot: Drawing[]): void {
    const before = this.forSymbol(symbol);
    this.replaceSymbol(symbol, snapshot);
    this.queueDiff(before, snapshot);
    if (this.selectedId() && !snapshot.some((d) => d.id === this.selectedId()))
      this.selectedId.set(null);
    this.undoRevision.update((v) => v + 1);
  }

  private pushUndo(symbol: string, snapshot: Drawing[]): void {
    const s = this.stack(this.undoStacks, symbol);
    s.push(snapshot);
    if (s.length > UNDO_DEPTH) s.shift();
  }

  private stack(map: Map<string, Drawing[][]>, symbol: string): Drawing[][] {
    let s = map.get(symbol);
    if (!s) map.set(symbol, (s = []));
    return s;
  }

  /** Replace one symbol's drawings in the full list (order of the rest kept), and cache it locally. */
  private replaceSymbol(symbol: string, drawings: Drawing[]): void {
    const others = this.all().filter((d) => d.symbol !== symbol);
    const next = [...others, ...drawings];
    this.all.set(next);
    this.persist(next);
  }

  /** The engine writes a change makes: an upsert per drawing added or changed, a delete per drawing gone. */
  private queueDiff(before: Drawing[], after: Drawing[]): void {
    const was = new Map(before.map((d) => [d.id, d]));
    const now = new Set(after.map((d) => d.id));
    for (const d of after) {
      const prev = was.get(d.id);
      if (prev === d || isTransient(d)) continue;
      if (prev && sameContent(prev, d)) continue;
      this.enqueue({ op: 'upsert', drawing: d });
    }
    for (const d of before)
      if (!now.has(d.id) && !isTransient(d)) this.enqueue({ op: 'delete', drawing: d });
    this.persistSync();
  }

  private enqueue(w: { op: 'upsert' | 'delete'; drawing: Drawing }): void {
    const entry: OutboxEntry = {
      op: w.op,
      id: w.drawing.id,
      drawing: w.drawing,
      seq: `${this.origin}:${++this.seq}`,
    };
    this.outbox.set(entry.id, coalesce(this.outbox.get(entry.id), entry));
    this.pending.set(this.outbox.size);
    this.scheduleSync(SYNC_DEBOUNCE_MS);
  }

  private scheduleSync(delay: number): void {
    if (this.syncTimer !== null) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => this.flush(), delay);
  }

  private opsFor(entries: OutboxEntry[]): ChartDrawingOp[] {
    return entries.map((e) => toOp(e, this.versions.get(e.id) ?? null));
  }

  /**
   * Tab closing / reloading: send what is still waiting, with a request that outlives the page. The outbox is in
   * storage as well, so whatever this misses goes on the next load.
   */
  private readonly flushOnHide = (): void => {
    if (this.syncTimer !== null) clearTimeout(this.syncTimer);
    this.syncTimer = null;
    this.persistSync();
    if (!this.outbox.size) return;
    this.remote.syncOnUnload(this.origin, this.opsFor([...this.outbox.values()].slice(0, BATCH)));
  };

  private flush(): void {
    this.syncTimer = null;
    if (this.inFlight || this.outbox.size === 0) {
      if (!this.outbox.size && !this.inFlight) this.syncState.set('idle');
      return;
    }
    const sent = [...this.outbox.values()].slice(0, BATCH);
    this.inFlight = true;
    this.syncState.set('saving');
    this.remote.sync(this.origin, this.opsFor(sent)).subscribe({
      next: (res) => {
        this.inFlight = false;
        if (!res?.status || !Array.isArray(res.data)) {
          // The whole request was refused (a concurrent create, a validation failure): try again later.
          this.retryLater('error');
          return;
        }
        this.retryMs = RETRY_MIN_MS;
        this.applyResults(sent, res.data);
        this.syncState.set(this.outbox.size ? 'saving' : 'idle');
        if (this.outbox.size) this.scheduleSync(0);
      },
      error: () => {
        this.inFlight = false;
        this.retryLater('offline');
      },
    });
  }

  private retryLater(state: 'error' | 'offline'): void {
    this.syncState.set(state);
    this.scheduleSync(this.retryMs);
    this.retryMs = Math.min(RETRY_MAX_MS, this.retryMs * 2);
  }

  /** Take the engine's answers: versions for what landed, the engine's copy where ours was stale. */
  private applyResults(sent: OutboxEntry[], results: ChartDrawingOpResult[]): void {
    const byId = new Map(results.map((r) => [r.clientId, r]));
    let replaced = 0;
    let refused: string | null = null;
    for (const entry of sent) {
      const r = byId.get(entry.id);
      if (!r) continue;
      const current = this.outbox.get(entry.id);
      const unchangedSince = current?.seq === entry.seq;
      if (r.code === '00') {
        if (r.drawing) this.setVersion(entry.id, r.drawing.updatedAt);
        else this.forgetVersion(entry.id);
      } else if (r.code === '-409') {
        // The engine's copy wins; ours is dropped (unless it already says the same thing).
        const server = r.drawing ? fromDto(r.drawing) : null;
        if (!(server && entry.op === 'upsert' && sameContent(server, entry.drawing))) replaced++;
        if (server) this.setVersion(entry.id, r.drawing!.updatedAt);
        else this.forgetVersion(entry.id);
        this.outbox.delete(entry.id);
        this.acked.set(entry.id, entry.seq);
        this.takeServerCopy(entry.drawing.symbol, entry.id, server);
        continue;
      } else {
        refused = r.message ?? 'The engine refused a drawing.';
      }
      if (unchangedSince) {
        this.outbox.delete(entry.id);
        this.acked.set(entry.id, entry.seq);
      }
    }
    this.pending.set(this.outbox.size);
    if (replaced) {
      this.notice.set(
        replaced === 1
          ? 'A drawing was changed on another screen; it now shows that version.'
          : `${replaced} drawings were changed on another screen; they now show those versions.`,
      );
    } else if (refused) {
      this.notice.set(refused);
    }
    this.persistSync();
  }

  /** Put the engine's copy of one drawing in place of ours (or remove ours) — no undo step, no write. */
  private takeServerCopy(symbol: string, id: string, server: Drawing | null): void {
    const list = this.forSymbol(symbol);
    const at = list.findIndex((d) => d.id === id);
    let next: Drawing[];
    if (server) next = at >= 0 ? list.map((d) => (d.id === id ? server : d)) : [...list, server];
    else next = list.filter((d) => d.id !== id);
    this.replaceSymbol(symbol, next);
    if (!server && this.selectedId() === id) this.selectedId.set(null);
  }

  private setVersion(id: string, updatedAt: string): void {
    const cur = this.versions.get(id);
    // ISO times of one format compare as strings; never step a version back.
    if (!cur || updatedAt > cur) this.versions.set(id, updatedAt);
  }

  private persistSync(): void {
    writeSyncState(this.versions, this.outbox, this.acked, this.forgotten);
    this.acked.clear();
    this.forgotten.clear();
  }

  private forgetVersion(id: string): void {
    this.versions.delete(id);
    this.forgotten.add(id);
  }

  private persist(list: Drawing[]): void {
    // Wrapped because storage throws outright in some contexts (private windows, blocked site data) rather than
    // merely being empty — and losing the chart because a drawing could not be saved would be absurd.
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list.filter((d) => !isTransient(d))));
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
      // Filter rather than trust: a shape change in a later version should drop unreadable rows, not throw on load
      // and blank the chart.
      return parsed.filter(
        (d): d is Drawing =>
          !!d &&
          typeof d === 'object' &&
          typeof (d as Drawing).id === 'string' &&
          Array.isArray((d as Drawing).points) &&
          !behaviorFor((d as Drawing).kind)?.transient,
      );
    } catch {
      return [];
    }
  }
}

function structuredCloneDrawing(d: Drawing): Drawing {
  return JSON.parse(JSON.stringify(d)) as Drawing;
}

/** An outbox entry as the engine's write. */
function toOp(e: OutboxEntry, base: string | null): ChartDrawingOp {
  const d = e.drawing;
  if (e.op === 'delete') {
    return {
      op: 'delete',
      clientId: e.id,
      baseUpdatedAt: base,
      createdAt: new Date(d.createdAt).toISOString(),
    };
  }
  return {
    op: 'upsert',
    clientId: e.id,
    baseUpdatedAt: base,
    drawing: {
      symbol: d.symbol,
      resolution: d.resolution,
      kind: d.kind,
      pointsJson: JSON.stringify(d.points),
      styleJson: JSON.stringify(d.style),
      locked: d.locked,
      optionsJson: JSON.stringify(d.options ?? {}),
      hidden: !!d.hidden,
      visibleOn: (d.visibleOn ?? []).join(','),
      zIndex: d.z ?? 0,
      createdAt: new Date(d.createdAt).toISOString(),
    },
  };
}

/** A drawing from an engine row; null when the row cannot be read (one bad row must not cost the rest). */
export function fromDto(row: ChartDrawingDto): Drawing | null {
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
      ...extrasFromDto(row),
    };
  } catch {
    return null;
  }
}

/** Options / visibility / z from an engine row; absent on engines without them. */
function extrasFromDto(row: ChartDrawingDto): Partial<Drawing> {
  const out: Partial<Drawing> = {};
  if (row.optionsJson) {
    try {
      const o: unknown = JSON.parse(row.optionsJson);
      if (o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length) {
        out.options = o as Record<string, unknown>;
      }
    } catch {
      /* bad options: fall back to the tool's defaults */
    }
  }
  if (row.hidden) out.hidden = true;
  if (row.visibleOn) out.visibleOn = row.visibleOn.split(',').filter(Boolean);
  if (typeof row.zIndex === 'number') out.z = row.zIndex;
  return out;
}
