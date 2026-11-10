import { computed, type WritableSignal } from '@angular/core';

import type { ScriptInputValues } from '@core/api/scripting.types';
import type { DrawingStore } from '../../drawings/drawing-store.service';
import type { ActiveIndicator } from '../../chart/chart-host.component';
import type { ChartScriptItem } from '../../scripts/chart-script.service';
import {
  UndoHistory,
  describeChange,
  sameUndoable,
  undoableOf,
  type UndoEntry,
  type UndoableChart,
} from '../../workspace/undo-history';
import { restoredScriptItem, type ChartWorkspaceState, type WorkspaceScript } from '../../workspace/workspace-state';
import type { ChartScriptRun } from './chart-analysis-page.component';

/** What the chart's one undo history reads and drives on the chart page. */
export interface ChartUndoDeps {
  /** The chart as a layout saves it — what undo covers of it is derived from this. */
  captureState: () => ChartWorkspaceState;
  symbol: () => string;
  drawings: Pick<DrawingStore, 'undo' | 'redo' | 'canUndo' | 'canRedo'>;
  /** The saved state (or the defaults) has been applied: nothing is a step before. */
  restored: () => boolean;
  /** A saved layout is being applied: not an edit. */
  applyingState: () => boolean;
  labelFor: (item: ActiveIndicator) => string;
  /** Put a layout's / a step's chart settings back (defaults for what it leaves out). */
  applyChartSettings: (s: UndoableChart['settings']) => void;
  active: WritableSignal<ActiveIndicator[]>;
  /** The scripts as a layout saves them. */
  workspaceScripts: () => WorkspaceScript[];
  removeScriptFromChart: (key: string) => void;
  scriptRuns: WritableSignal<ChartScriptRun[]>;
  /** Restored scripts whose run has not come back yet — still part of the layout. */
  restoringScripts: WritableSignal<WorkspaceScript[]>;
  runScript: (item: ChartScriptItem, values: ScriptInputValues, replace: boolean) => void;
  savedScripts: () => Parameters<typeof restoredScriptItem>[1];
}

/**
 * b10-ui — the chart's one undo history (CC-I11): studies, scripts and chart settings recorded as the operator
 * changes them (a burst within half a second is one step), drawing steps handed to the drawing store (this symbol's
 * only), undo / redo with their titles, and putting a step's chart back. Moved out of ChartAnalysisPageComponent
 * behaviour for behaviour; the template and the keyboard call it as `chartUndo`, the page's effect feeds it
 * {@link noteUndoable}, and applying a layout calls {@link rebase}.
 */
export class ChartUndoController {
  constructor(private readonly deps: ChartUndoDeps) {}

  readonly undoHistory = new UndoHistory();
  /** What undo covers of the chart as it stands (studies, scripts, settings), changing only when that changes. */
  readonly undoableState = computed(() => undoableOf(this.deps.captureState()), {
    equal: sameUndoable,
  });
  /** The chart as the last recorded step left it. */
  private undoBaseline: UndoableChart | null = null;
  /** The chart before a burst of changes still settling; recorded as one step when it settles. */
  private undoPending: UndoableChart | null = null;
  private undoTimer: ReturnType<typeof setTimeout> | undefined;
  /** True while an undo / redo puts the chart back: that is not a new step. */
  private undoing = false;

  /** A step of the history applies to the chart on screen: chart steps always, drawing steps of this symbol. */
  readonly undoApplies = (e: UndoEntry): boolean =>
    e.kind === 'chart' || e.symbol === this.deps.symbol();

  readonly undoTitle = computed(() => {
    this.undoHistory.revision();
    const e = this.undoHistory.peekUndo(this.undoApplies);
    return e ? `Undo ${this.undoEntryLabel(e)} (⌘Z)` : 'Nothing to undo';
  });
  readonly redoTitle = computed(() => {
    this.undoHistory.revision();
    const e = this.undoHistory.peekRedo(this.undoApplies);
    return e ? `Redo ${this.undoEntryLabel(e)} (⇧⌘Z)` : 'Nothing to redo';
  });
  readonly canUndo = computed(() => {
    this.undoHistory.revision();
    this.deps.drawings.canUndo();
    return this.undoHistory.peekUndo(this.undoApplies) !== null;
  });
  readonly canRedo = computed(() => {
    this.undoHistory.revision();
    this.deps.drawings.canRedo();
    return this.undoHistory.peekRedo(this.undoApplies) !== null;
  });

  private undoEntryLabel(e: UndoEntry): string {
    return e.kind === 'drawing' ? 'drawing' : e.label;
  }

  /** The undoable chart changed: a new step once the burst settles (not while a layout or an undo is applied). */
  noteUndoable(now: UndoableChart): void {
    if (!this.deps.restored() || this.deps.applyingState() || this.undoing) {
      if (!this.undoPending) this.undoBaseline = now;
      return;
    }
    if (!this.undoBaseline) {
      this.undoBaseline = now;
      return;
    }
    if (sameUndoable(now, this.undoBaseline)) return;
    this.undoPending ??= this.undoBaseline;
    this.undoBaseline = now;
    clearTimeout(this.undoTimer);
    this.undoTimer = setTimeout(() => this.commitUndoStep(), 500);
  }

  commitUndoStep(): void {
    clearTimeout(this.undoTimer);
    const before = this.undoPending;
    const after = this.undoBaseline;
    this.undoPending = null;
    if (!before || !after || sameUndoable(before, after)) return;
    this.undoHistory.record({
      kind: 'chart',
      before,
      after,
      label: describeChange(before, after, (i) => this.deps.labelFor(i)),
    });
  }

  /** Ctrl+Z, the toolbar and the context menu: the newest step that applies to this chart goes back. */
  undo(): void {
    this.commitUndoStep();
    const e = this.undoHistory.undo(this.undoApplies);
    if (!e) return;
    if (e.kind === 'drawing') this.deps.drawings.undo();
    else this.restoreUndoable(e.before);
  }

  redo(): void {
    this.commitUndoStep();
    const e = this.undoHistory.redo(this.undoApplies);
    if (!e) return;
    if (e.kind === 'drawing') this.deps.drawings.redo();
    else this.restoreUndoable(e.after);
  }

  /**
   * Another layout's chart was applied: its steps are not this one's to undo (drawing steps stay, they are per
   * symbol), and the chart as it now reads is the baseline.
   */
  rebase(): void {
    clearTimeout(this.undoTimer);
    this.undoPending = null;
    this.undoBaseline = this.undoableState();
    this.undoHistory.clearChart();
  }

  /** The page is going: a burst still settling is not recorded. */
  dispose(): void {
    clearTimeout(this.undoTimer);
  }

  /**
   * Put the chart's studies, scripts and settings back as `u` held them. Scripts that left come back (run again
   * with their inputs), scripts that came go, scripts whose inputs changed run again with the old ones; a change of
   * display only is applied in place.
   */
  private restoreUndoable(u: UndoableChart): void {
    const d = this.deps;
    this.undoing = true;
    try {
      d.applyChartSettings(u.settings);
      d.active.set(u.indicators.map((i) => ({ ...i, params: { ...i.params } })));
      const target = new Map(u.scripts.map((w) => [w.key, w]));
      for (const w of d.workspaceScripts()) if (!target.has(w.key)) d.removeScriptFromChart(w.key);
      for (const w of u.scripts) {
        const run = d.scriptRuns().find((r) => r.item.key === w.key);
        if (run && JSON.stringify(run.values) === JSON.stringify(w.values)) {
          if (JSON.stringify(run.display ?? {}) !== JSON.stringify(w.display ?? {}))
            d.scriptRuns.update((list) =>
              list.map((r) =>
                r === run ? { ...r, display: w.display ? { ...w.display } : undefined } : r,
              ),
            );
          continue;
        }
        if (!run) d.restoringScripts.update((l) => [...l.filter((x) => x.key !== w.key), w]);
        d.runScript(run?.item ?? restoredScriptItem(w, d.savedScripts()), { ...w.values }, true);
      }
    } finally {
      queueMicrotask(() => {
        this.undoBaseline = this.undoableState();
        this.undoing = false;
      });
    }
  }
}
