import { signal } from '@angular/core';
import type { ActiveIndicator } from '../chart/chart-host.component';
import type { ChartWorkspaceState, WorkspaceScript } from './workspace-state';

/**
 * The chart's one undo / redo stack (CC-I11): drawings, studies, scripts and chart settings in the order the operator
 * made them. Drawings keep their own per-symbol snapshots in the drawing store (DR-05: Ctrl+Z on GBPUSD never undoes an
 * EURUSD edit) — this stack holds a marker per drawing step, and Ctrl+Z takes the newest entry that applies to the
 * chart on screen: any studies / scripts / settings step, or a drawing step of this symbol. Everything else waits for
 * its symbol.
 */

/** What of a layout undo covers: what the operator edits on the chart — not where it looks (symbol, zoom, panels). */
export interface UndoableChart {
  settings: Omit<
    ChartWorkspaceState,
    | 'v'
    | 'symbol'
    | 'resolution'
    | 'view'
    | 'panel'
    | 'dock'
    | 'split'
    | 'indicators'
    | 'scripts'
    | 'symbolMemory'
    | 'charts'
  >;
  indicators: ActiveIndicator[];
  scripts: WorkspaceScript[];
}

export type UndoEntry =
  | { kind: 'drawing'; symbol: string }
  | { kind: 'chart'; before: UndoableChart; after: UndoableChart; label: string };

/** Entries kept; older ones fall off. */
export const UNDO_LIMIT = 200;

/** The undoable part of a layout state. */
export function undoableOf(s: ChartWorkspaceState): UndoableChart {
  const {
    v: _v,
    symbol: _symbol,
    resolution: _resolution,
    view: _view,
    panel: _panel,
    dock: _dock,
    split: _split,
    symbolMemory: _symbolMemory,
    charts: _charts,
    indicators,
    scripts,
    ...settings
  } = s;
  return {
    settings,
    indicators: (indicators ?? []).map((i) => ({ ...i, params: { ...i.params } })),
    scripts: (scripts ?? []).map((w) => ({ ...w, values: { ...w.values } })),
  };
}

export function sameUndoable(a: UndoableChart, b: UndoableChart): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** What a change did, in a few words — the Undo / Redo buttons' tooltips. */
export function describeChange(
  before: UndoableChart,
  after: UndoableChart,
  studyName: (i: ActiveIndicator) => string,
): string {
  const ids = (l: ActiveIndicator[]) => new Set(l.map((i) => i.uid));
  const added = after.indicators.filter((i) => !ids(before.indicators).has(i.uid));
  const removed = before.indicators.filter((i) => !ids(after.indicators).has(i.uid));
  if (added.length === 1 && !removed.length) return `add ${studyName(added[0])}`;
  if (removed.length === 1 && !added.length) return `remove ${studyName(removed[0])}`;
  if (added.length || removed.length) return 'studies';
  if (JSON.stringify(before.indicators) !== JSON.stringify(after.indicators)) {
    const changed = after.indicators.find(
      (i) => JSON.stringify(i) !== JSON.stringify(before.indicators.find((b) => b.uid === i.uid)),
    );
    return changed ? `${studyName(changed)} settings` : 'studies';
  }
  const keys = (l: WorkspaceScript[]) => new Set(l.map((w) => w.key));
  const sAdded = after.scripts.filter((w) => !keys(before.scripts).has(w.key));
  const sRemoved = before.scripts.filter((w) => !keys(after.scripts).has(w.key));
  if (sAdded.length === 1 && !sRemoved.length) return `add ${sAdded[0].name}`;
  if (sRemoved.length === 1 && !sAdded.length) return `remove ${sRemoved[0].name}`;
  if (JSON.stringify(before.scripts) !== JSON.stringify(after.scripts)) {
    const changed = after.scripts.find(
      (w) => JSON.stringify(w) !== JSON.stringify(before.scripts.find((b) => b.key === w.key)),
    );
    return changed ? `${changed.name} settings` : 'scripts';
  }
  return 'chart settings';
}

export class UndoHistory {
  private undoList: UndoEntry[] = [];
  private redoList: UndoEntry[] = [];
  /** Bumped on every change, so computed views follow. */
  readonly revision = signal(0);

  /** A new step: it ends what Redo could bring back (of every symbol: the order is one history). */
  record(entry: UndoEntry): void {
    this.undoList.push(entry);
    if (this.undoList.length > UNDO_LIMIT) this.undoList.shift();
    this.redoList = [];
    this.bump();
  }

  /** The newest undo entry `applies` accepts, moved to the redo list; null when there is none. */
  undo(applies: (e: UndoEntry) => boolean): UndoEntry | null {
    return this.move(this.undoList, this.redoList, applies);
  }

  /** The newest redo entry `applies` accepts, moved back to the undo list. */
  redo(applies: (e: UndoEntry) => boolean): UndoEntry | null {
    return this.move(this.redoList, this.undoList, applies);
  }

  /** The entry Undo would take now (for its tooltip), without taking it. */
  peekUndo(applies: (e: UndoEntry) => boolean): UndoEntry | null {
    return this.peek(this.undoList, applies);
  }

  peekRedo(applies: (e: UndoEntry) => boolean): UndoEntry | null {
    return this.peek(this.redoList, applies);
  }

  /**
   * A drawing step the drawing store took back by itself (a gesture that changed nothing, a cancelled dialog): its
   * marker goes too, the newest one of that symbol.
   */
  dropDrawing(symbol: string): void {
    for (let i = this.undoList.length - 1; i >= 0; i--) {
      const e = this.undoList[i];
      if (e.kind === 'drawing' && e.symbol === symbol) {
        this.undoList.splice(i, 1);
        this.bump();
        return;
      }
    }
  }

  /** Forget the chart steps (another layout replaced the chart); drawing markers stay — drawings are per symbol. */
  clearChart(): void {
    this.undoList = this.undoList.filter((e) => e.kind === 'drawing');
    this.redoList = this.redoList.filter((e) => e.kind === 'drawing');
    this.bump();
  }

  private move(from: UndoEntry[], to: UndoEntry[], applies: (e: UndoEntry) => boolean): UndoEntry | null {
    for (let i = from.length - 1; i >= 0; i--) {
      if (!applies(from[i])) continue;
      const [e] = from.splice(i, 1);
      to.push(e);
      this.bump();
      return e;
    }
    return null;
  }

  private peek(list: UndoEntry[], applies: (e: UndoEntry) => boolean): UndoEntry | null {
    for (let i = list.length - 1; i >= 0; i--) if (applies(list[i])) return list[i];
    return null;
  }

  private bump(): void {
    this.revision.update((v) => v + 1);
  }
}
