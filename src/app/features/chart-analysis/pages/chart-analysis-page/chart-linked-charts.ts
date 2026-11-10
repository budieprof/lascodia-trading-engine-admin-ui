import { computed, type DestroyRef, type WritableSignal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import type { ChartHostComponent } from '../../chart/chart-host.component';
import type { ComparePanel } from '../../compare/split-panels.controller';
import type { TvResolution } from '../../datafeed/resolution';
import { INDICATORS, indicatorById } from '../../indicators/registry';
import type { ChartScriptCatalog, ChartScriptService } from '../../scripts/chart-script.service';
import { isBusy } from '../../scripts/script-run-state';
import { sameLayers, type ChartScriptLayer } from '../../scripts/script-layers';
import {
  linkedCharts,
  panelLayers,
  panelStudyChoices,
  withStudy,
  withoutStudy,
  type MainRun,
  type PanelScript,
} from '../../workspace/chart-panels';
import { linkGroupOf, type ChartSync } from '../../workspace/workspace-state';
import { MAX_SCRIPT_BARS, PAGE_BARS } from './chart-page.config';

/** What the linked charts and the other charts' studies / scripts read and drive on the chart page. */
export interface ChartLinkedChartsDeps {
  /** The split view's other charts (the split controller's `panels`). */
  comparePanels: WritableSignal<ComparePanel[]>;
  /** The main chart's link group (0 = none). */
  mainLink: WritableSignal<number>;
  /** Which switches the linked charts share. */
  chartSync: WritableSignal<Required<ChartSync>>;
  symbol: () => string;
  resolution: () => string;
  /** The main chart's host. */
  host: () => Pick<ChartHostComponent, 'syncCrosshair' | 'syncRange'> | undefined;
  /** The split panels' chart hosts, in panel order. */
  panelHosts: () => ReadonlyArray<Pick<ChartHostComponent, 'syncCrosshair' | 'syncRange'> | undefined>;
  /** The main chart's symbol / interval switches; `propagate` false — a linked switch is not passed on again. */
  selectSymbol: (symbol: string, propagate: boolean) => void;
  selectResolution: (r: TvResolution, propagate: boolean) => void;
  /** A panel's symbol / interval switches (the split controller's). */
  setPanelSymbol: (id: string, symbol: string, propagate: boolean) => void;
  setPanelResolution: (id: string, resolution: string, propagate: boolean) => void;
  scriptCatalog: () => ChartScriptCatalog | null;
  /** The main chart's script runs — a panel draws a run the main chart already has from there. */
  scriptRuns: () => readonly MainRun[];
  chartScripts: Pick<ChartScriptService, 'runOnChart'>;
  destroyRef: DestroyRef;
}

/**
 * b10-ui — the split view's charts beyond the main one (CC-I5): their link groups and the sync between them (symbol,
 * interval, crosshair, time range), and each other chart's own studies and Pine indicators (added, removed, run on its
 * own series — or drawn from the main chart's run when it is the same). Moved out of ChartAnalysisPageComponent
 * behaviour for behaviour; the template and the page's effects call it as `linked`.
 */
export class ChartLinkedCharts {
  constructor(private readonly deps: ChartLinkedChartsDeps) {}

  // ── Linked charts (CC-I5) ──────────────────────────────────────────────────

  /** A chart's link group ('main' is the main chart). */
  private linkOf(id: string): number {
    const d = this.deps;
    return id === 'main' ? d.mainLink() : (d.comparePanels().find((p) => p.id === id)?.link ?? 0);
  }

  /** The charts in `id`'s link group besides it. */
  private linkedTo(id: string): string[] {
    return linkedCharts(id, this.linkOf(id), this.deps.mainLink(), this.deps.comparePanels());
  }

  private hostOf(id: string) {
    const d = this.deps;
    if (id === 'main') return d.host();
    return d.panelHosts()[d.comparePanels().findIndex((p) => p.id === id)];
  }

  /** The operator's crosshair on one chart: the linked charts put theirs on the same bar (crosshair sync). */
  onChartCrosshair(id: string, utcMs: number | null): void {
    if (!this.deps.chartSync().crosshair) return;
    for (const t of this.linkedTo(id)) this.hostOf(t)?.syncCrosshair(utcMs);
  }

  /** The operator panned or zoomed one chart: the linked charts show the same span (time sync). */
  onChartRange(id: string, range: { fromMs: number; toMs: number }): void {
    if (!this.deps.chartSync().time) return;
    for (const t of this.linkedTo(id)) this.hostOf(t)?.syncRange(range.fromMs, range.toMs);
  }

  /** A chart switched symbol: with symbol sync on, the charts linked to it follow. */
  linkSymbol(source: string, symbol: string): void {
    const d = this.deps;
    if (!d.chartSync().symbol) return;
    for (const t of this.linkedTo(source)) {
      if (t === 'main') {
        if (d.symbol() !== symbol) d.selectSymbol(symbol, false);
      } else if (d.comparePanels().find((p) => p.id === t)?.symbol !== symbol)
        d.setPanelSymbol(t, symbol, false);
    }
  }

  /** A chart switched timeframe: with interval sync on, the charts linked to it follow. */
  linkInterval(source: string, resolution: string): void {
    const d = this.deps;
    if (!d.chartSync().interval) return;
    for (const t of this.linkedTo(source)) {
      if (t === 'main') {
        if (d.resolution() !== resolution) d.selectResolution(resolution as TvResolution, false);
      } else if (d.comparePanels().find((p) => p.id === t)?.resolution !== resolution)
        d.setPanelResolution(t, resolution, false);
    }
  }

  setPanelLink(id: string, link: number): void {
    this.deps.comparePanels.update((list) =>
      list.map((p) => (p.id === id ? { ...p, link: linkGroupOf(link) } : p)),
    );
  }

  setMainLink(link: number): void {
    this.deps.mainLink.set(linkGroupOf(link));
  }

  /** The sync switches the layout menu offers. */
  readonly syncKeys: ReadonlyArray<{ key: keyof ChartSync; label: string; title: string }> = [
    {
      key: 'symbol',
      label: 'symbol',
      title: 'A symbol switch on one linked chart switches the others',
    },
    {
      key: 'interval',
      label: 'interval',
      title: 'A timeframe switch on one linked chart switches the others',
    },
    { key: 'crosshair', label: 'crosshair', title: 'The crosshair moves on every linked chart' },
    {
      key: 'time',
      label: 'time range',
      title: 'Panning or zooming one linked chart shows the same span on the others',
    },
  ];

  setSync(key: keyof ChartSync, on: boolean): void {
    this.deps.chartSync.update((s) => ({ ...s, [key]: on }));
  }

  // ── The other charts' studies and scripts (CC-I5) ─────────────────────────

  /** The studies another chart offers (those reading its own bars only). */
  readonly panelStudyDefs = panelStudyChoices(INDICATORS);
  /** The Pine indicators another chart offers: My scripts and the examples. */
  readonly panelScriptChoices = computed(() => {
    const c = this.deps.scriptCatalog();
    return c ? [...c.mine, ...c.examples].filter((i) => i.kind === 'indicator') : [];
  });

  /** "+ Study" on another chart: a built-in (`study:<id>`) or a Pine indicator (`script:<key>`). */
  panelAdd(id: string, choice: string): void {
    const d = this.deps;
    if (choice.startsWith('study:')) {
      const def = indicatorById(choice.slice(6));
      if (!def) return;
      const uid = `${def.id}-${Date.now().toString(36)}`;
      d.comparePanels.update((list) =>
        list.map((p) =>
          p.id === id ? { ...p, indicators: withStudy(p.indicators, def, uid) } : p,
        ),
      );
    } else if (choice.startsWith('script:')) {
      const item = this.panelScriptChoices().find((i) => i.key === choice.slice(7));
      if (!item) return;
      d.comparePanels.update((list) =>
        list.map((p) =>
          p.id === id && !p.scripts.some((s) => s.item.key === item.key)
            ? {
                ...p,
                scripts: [
                  ...p.scripts,
                  { item, values: {}, result: null, error: null, ranTo: null },
                ],
              }
            : p,
        ),
      );
    }
  }

  removePanelStudy(id: string, uid: string): void {
    this.deps.comparePanels.update((list) =>
      list.map((p) => (p.id === id ? { ...p, indicators: withoutStudy(p.indicators, uid) } : p)),
    );
  }

  removePanelScript(id: string, key: string): void {
    this.deps.comparePanels.update((list) =>
      list.map((p) =>
        p.id === id ? { ...p, scripts: p.scripts.filter((s) => s.item.key !== key) } : p,
      ),
    );
  }

  /** Runs of the other charts' scripts in flight, by `panel|key`. */
  private readonly panelRuns = new Set<string>();

  /**
   * Run one of another chart's scripts on its series, to now. A run the main chart already has (same script, inputs
   * and series) is drawn from there instead — a second chart never doubles the engine's work for it.
   */
  runPanelScript(id: string, key: string): void {
    const d = this.deps;
    const panel = d.comparePanels().find((p) => p.id === id);
    const script = panel?.scripts.find((s) => s.item.key === key);
    const last = panel?.bars.at(-1);
    if (!panel || !script || !last) return;
    const flight = `${id}|${key}`;
    if (this.panelRuns.has(flight)) return;
    this.panelRuns.add(flight);
    const { symbol, resolution } = panel;
    const land = (patch: Partial<PanelScript>): void => {
      this.panelRuns.delete(flight);
      d.comparePanels.update((list) =>
        list.map((p) =>
          p.id === id && p.symbol === symbol && p.resolution === resolution
            ? {
                ...p,
                scripts: p.scripts.map((s) =>
                  s.item.key === key ? { ...s, ...patch, ranTo: last.time } : s,
                ),
              }
            : p,
        ),
      );
    };
    const bars = Math.min(Math.max(panel.bars.length, PAGE_BARS), MAX_SCRIPT_BARS);
    d.chartScripts
      .runOnChart(script.item, symbol, resolution, script.values, bars, { chartType: 'standard' })
      .pipe(takeUntilDestroyed(d.destroyRef))
      .subscribe({
        next: (result) => land(result.error ? { error: result.error } : { result, error: null }),
        error: (e: unknown) =>
          land({
            error: isBusy(e)
              ? 'The engine is busy: it runs again at the next bar.'
              : e instanceof Error
                ? e.message
                : 'The run failed.',
          }),
      });
  }

  /** Each other chart's script layers, the same array while nothing it draws changed (no redraw per tick). */
  private readonly panelLayerCache = new Map<string, ChartScriptLayer[]>();
  readonly panelLayerMap = computed(() => {
    const main = this.deps.scriptRuns();
    const out = new Map<string, ChartScriptLayer[]>();
    for (const p of this.deps.comparePanels()) {
      const next = panelLayers(p.scripts, main, p.symbol, p.resolution);
      const prev = this.panelLayerCache.get(p.id);
      const layers = prev && sameLayers(prev, next) ? prev : next;
      this.panelLayerCache.set(p.id, layers);
      out.set(p.id, layers);
    }
    return out;
  });
  readonly noLayers: ChartScriptLayer[] = [];
}
