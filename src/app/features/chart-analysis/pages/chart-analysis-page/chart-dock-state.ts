import { computed, signal } from '@angular/core';

/** The part of a chart script run the dock reads (its key, and whether it is the strategy). */
export interface DockScriptRun {
  item: { key: string };
  result: { kind: string };
}

/** What the dock reads on the chart page (accessors, so it can be built before the page's fields). */
export interface ChartDockStateDeps<R extends DockScriptRun> {
  scriptRuns: () => readonly R[];
  strategyRun: () => R | null;
}

export type DockPanel = 'editor' | 'tester' | 'logs';

/**
 * U13 (fu-ui) — which panel the chart page's dock shows, moved out of the page unchanged: the Pine Editor, the
 * Strategy Tester (its report, or how to add a strategy) and Pine Logs (PC-I6), which of them is in front, and the
 * tester / logs open-close actions. The page keeps its old member names as aliases of these signals, so its template
 * and the rest of its code read the same state; opening the editor on a script stays the page's (it needs the
 * editor's source loading).
 */
export class ChartDockState<R extends DockScriptRun = DockScriptRun> {
  constructor(private readonly deps: ChartDockStateDeps<R>) {}

  readonly testerOpen = signal(true);
  /**
   * The operator opened the Strategy Tester with no strategy on the chart: it shows how to add
   * one. The tab used to be disabled then, explained only by a tooltip — which touch never shows.
   */
  readonly testerPrompt = signal(false);
  readonly testerShown = computed(
    () => this.testerOpen() && (!!this.deps.strategyRun() || this.testerPrompt()),
  );
  readonly editorOpen = signal(false);

  /** Which dock tab wins when both the editor and the tester are open. */
  readonly dockPreference = signal<'editor' | 'tester'>('tester');
  /**
   * Pine Logs (PC-I6) is the dock's front tab — opened, or its tab clicked — until the editor or
   * the tester is brought up ({@link frontDock}). Session only, as is which script's logs it shows:
   * a layout keeps the editor and the tester, not this.
   */
  readonly logsFront = signal(false);
  /** The script whose Pine Logs, trace and profiler the dock shows; null: closed. */
  readonly logsKey = signal<string | null>(null);
  /** That script's run on the chart (the dock closes with it). */
  readonly logsRun = computed(() => {
    const key = this.logsKey();
    return key === null ? null : (this.deps.scriptRuns().find((r) => r.item.key === key) ?? null);
  });
  readonly dockTab = computed<DockPanel | null>(() => {
    const editor = this.editorOpen();
    const tester = this.testerShown();
    if (this.logsRun() && (this.logsFront() || (!editor && !tester))) return 'logs';
    if (editor && tester) return this.dockPreference();
    return editor ? 'editor' : tester ? 'tester' : null;
  });
  /** The dock's tabs: the panels open in it (its strip shows when there are two or more). */
  readonly dockTabs = computed(() => {
    const out: { id: DockPanel; label: string }[] = [];
    if (this.editorOpen()) out.push({ id: 'editor', label: 'Pine Editor' });
    if (this.testerShown()) out.push({ id: 'tester', label: 'Strategy Tester' });
    if (this.logsRun()) out.push({ id: 'logs', label: 'Pine Logs' });
    return out;
  });

  /** Bring the editor or the tester to the dock's front (Pine Logs goes behind). */
  frontDock(which: 'editor' | 'tester'): void {
    this.logsFront.set(false);
    this.dockPreference.set(which);
  }

  /** A dock tab clicked. */
  showDock(id: DockPanel): void {
    if (id === 'logs') this.logsFront.set(true);
    else this.frontDock(id);
  }

  /** A script's Pine Logs, trace and profiler, in the dock's front (its chip or status line). */
  openLogs(key: string): void {
    this.logsKey.set(key);
    this.logsFront.set(true);
  }

  closeLogs(): void {
    this.logsKey.set(null);
    this.logsFront.set(false);
  }

  toggleTester(): void {
    if (this.dockTab() === 'tester') {
      this.closeTester();
    } else {
      this.testerOpen.set(true);
      // With no strategy on the chart it opens on how to add one, as TradingView's does.
      this.testerPrompt.set(!this.deps.strategyRun());
      this.frontDock('tester');
    }
  }

  closeTester(): void {
    this.testerOpen.set(false);
    this.testerPrompt.set(false);
  }
}
