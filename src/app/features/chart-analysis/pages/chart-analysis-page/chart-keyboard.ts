import type { ChartHostComponent } from '../../chart/chart-host.component';
import type { ChartAnalysisPageComponent } from './chart-analysis-page.component';
import { CHART_HOTKEYS, DRAWING_HOTKEYS } from './chart-page.config';

/** The chart page's members the keyboard reads and drives (all public on the page). */
export type ChartKeyboardPage = Pick<
  ChartAnalysisPageComponent,
  | 'chartUndo'
  | 'dockTab'
  | 'drawingMenu'
  | 'drawings'
  | 'invertScale'
  | 'layoutActions'
  | 'layoutMenuOpen'
  | 'magnet'
  | 'magnetMenuOpen'
  | 'openMenu'
  | 'openStudiesDialog'
  | 'paletteOpen'
  | 'railFlyout'
  | 'replay'
  | 'replayActive'
  | 'resetScales'
  | 'scaleMode'
  | 'seasonalsOpen'
  | 'setDockMode'
  | 'symbolMenuOpen'
  | 'technicalsOpen'
  | 'tool'
>;

/** What the keyboard reads and drives on the chart page. */
export interface ChartKeyboardDeps {
  page: ChartKeyboardPage;
  /** The main chart's host (private on the page). */
  host: () =>
    | Pick<
        ChartHostComponent,
        'pasteDrawing' | 'finishDrawing' | 'cancelDrawing' | 'nudgeSelectedDrawing'
      >
    | undefined;
  /** The interval box, opened on a digit (private on the page). */
  openIntervalBox: (first: string) => void;
}

/**
 * b10-ui — the chart page's keyboard shortcuts (TradingView's where they exist): the dock, the command palette, undo /
 * redo, drawing copy / paste / finish / cancel / delete / nudge, Alt chart keys and drawing hotkeys, Bar Replay keys,
 * "/" for the indicators, the magnet and the interval box. Moved out of ChartAnalysisPageComponent behaviour for
 * behaviour; the page's host `(keydown)` binding calls `keyboard.onKeydown`.
 */
export class ChartKeyboard {
  constructor(private readonly deps: ChartKeyboardDeps) {}

  /**
   * Keyboard shortcuts, matching TradingView's where they exist.
   *
   * Bound on the host rather than on `document` so typing in the symbol search
   * or an indicator input never deletes the selected drawing.
   */
  onKeydown(ev: KeyboardEvent): void {
    const d = this.deps;
    const p = d.page;
    // Ctrl/Cmd+Shift+M: maximise ⇄ restore the Pine Editor / Tester dock — before the editable check, so it also
    // works while typing in the editor (CodeMirror binds nothing to it).
    if (
      p.dockTab() &&
      (ev.ctrlKey || ev.metaKey) &&
      ev.shiftKey &&
      !ev.altKey &&
      ev.key.toLowerCase() === 'm'
    ) {
      ev.preventDefault();
      p.setDockMode('max');
      return;
    }
    const target = ev.target as HTMLElement | null;
    // The Pine editor is a contenteditable, not a field: typing "m" there toggled the magnet, and
    // Backspace deleted the selected drawing.
    if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable))
      return;

    // The Technicals view covers the chart: Esc returns to it, and no chart shortcut acts
    // on drawings the operator cannot see.
    if (p.technicalsOpen() || p.seasonalsOpen()) {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        p.technicalsOpen.set(false);
        p.seasonalsOpen.set(false);
      }
      return;
    }

    const mod = ev.metaKey || ev.ctrlKey;
    // The chart's command palette (CC-I11): ⌘⇧K / Ctrl+Shift+K (⌘K alone is the console's page search).
    if (mod && ev.shiftKey && ev.key.toLowerCase() === 'k') {
      ev.preventDefault();
      // The console's palette listens on the document for ⌘K with or without Shift: not this one.
      ev.stopPropagation();
      p.paletteOpen.set(true);
      return;
    }
    if (mod && ev.key.toLowerCase() === 'z') {
      ev.preventDefault();
      if (ev.shiftKey) p.chartUndo.redo();
      else p.chartUndo.undo();
      return;
    }
    if (mod && ev.key.toLowerCase() === 'y') {
      ev.preventDefault();
      p.chartUndo.redo();
      return;
    }
    if (mod && ev.key.toLowerCase() === 'c' && !ev.shiftKey) {
      const id = p.drawings.selectedId();
      if (id && !window.getSelection()?.toString()) {
        ev.preventDefault();
        p.drawings.copy(id);
      }
      return;
    }
    if (mod && ev.key.toLowerCase() === 'v' && !ev.shiftKey) {
      if (p.drawings.hasClipboard) {
        ev.preventDefault();
        d.host()?.pasteDrawing();
      }
      return;
    }
    if (ev.key === 'Enter' && p.tool()) {
      if (d.host()?.finishDrawing()) ev.preventDefault();
      return;
    }
    if (ev.key === 'Escape') {
      // An Esc this branch acts on is consumed (preventDefault): the open order ticket
      // (appModalA11y, a document listener that skips handled keys) closes on the NEXT one.
      // An open toolbar menu (interval, style, templates, overlays, layouts) is what Esc closes
      // first; it used to stay open while Esc went to the drawings behind it.
      if (p.openMenu() !== null || p.layoutMenuOpen() || p.symbolMenuOpen()) {
        ev.preventDefault();
        p.openMenu.set(null);
        p.layoutMenuOpen.set(false);
        p.symbolMenuOpen.set(false);
        return;
      }
      // TV: Esc first abandons a drawing in progress and drops the tool, then
      // clears the selection.
      const acted =
        p.tool() !== null ||
        p.railFlyout() !== null ||
        p.magnetMenuOpen() ||
        p.drawingMenu() !== null ||
        p.drawings.selectedId() !== null;
      if (d.host()?.cancelDrawing() || acted) ev.preventDefault();
      p.railFlyout.set(null);
      p.magnetMenuOpen.set(false);
      p.drawingMenu.set(null);
      p.tool.set(null);
      p.drawings.selectedId.set(null);
      return;
    }
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      if (p.drawings.selectedIds().size) {
        ev.preventDefault();
        // Locked drawings stay: the lock is what stops a stray key deleting one (DR-06). Every other
        // selected drawing goes (a multi-selection, DR-I10).
        p.drawings.removeSelectedUnlocked();
      }
      return;
    }
    // TradingView's drawing hotkeys (DR-I12), by physical key so Alt's characters on a Mac
    // (Alt+T types "†") do not get in the way.
    if (ev.altKey && !mod) {
      // TradingView's chart keys (CC-I11): reset the view, invert / log / percent scale, snapshot.
      const action = CHART_HOTKEYS[ev.code];
      if (action) {
        ev.preventDefault();
        if (action === 'reset') p.resetScales();
        else if (action === 'invert') p.invertScale.set(!p.invertScale());
        else if (action === 'log')
          p.scaleMode.set(p.scaleMode() === 'log' ? 'normal' : 'log');
        else if (action === 'percent')
          p.scaleMode.set(p.scaleMode() === 'percent' ? 'normal' : 'percent');
        else p.layoutActions.takeSnapshot();
        return;
      }
      const kind = DRAWING_HOTKEYS[ev.code];
      if (kind) {
        ev.preventDefault();
        p.tool.set(kind);
        return;
      }
    }
    // Bar Replay, TradingView's keys: Shift+→ forward, Shift+← back, Shift+↓ play / pause (CC-I4).
    if (p.replayActive() && ev.shiftKey && !mod && !ev.altKey) {
      const replayKey =
        ev.key === 'ArrowRight'
          ? () => void p.replay.step(1)
          : ev.key === 'ArrowLeft'
            ? () => void p.replay.step(-1)
            : ev.key === 'ArrowDown'
              ? () => p.replay.togglePlay()
              : null;
      if (replayKey) {
        ev.preventDefault();
        replayKey();
        return;
      }
    }
    if (ev.key.startsWith('Arrow') && p.drawings.selectedId() && !mod) {
      // Nudge: one bar sideways / one pixel vertically; Shift ×10.
      const k = ev.shiftKey ? 10 : 1;
      const bars = ev.key === 'ArrowLeft' ? -k : ev.key === 'ArrowRight' ? k : 0;
      const px = ev.key === 'ArrowUp' ? -k : ev.key === 'ArrowDown' ? k : 0;
      if (d.host()?.nudgeSelectedDrawing(bars, px)) ev.preventDefault();
      return;
    }
    // TradingView: "/" opens the indicators.
    if (ev.key === '/' && !mod && !ev.altKey) {
      ev.preventDefault();
      p.openStudiesDialog();
      return;
    }
    if (ev.key.toLowerCase() === 'm' && !mod) {
      p.magnet.set(!p.magnet());
      return;
    }
    if (/^[0-9]$/.test(ev.key) && !mod && !ev.altKey) {
      ev.preventDefault();
      d.openIntervalBox(ev.key);
    }
  }
}
