import type { ActiveIndicator } from '../chart/chart-host.component';
import type { ScriptInputValues } from '@core/api/scripting.types';
import type { ChartScriptItem } from '../scripts/chart-script.service';
import type { ChartScriptResult } from '../scripts/chart-script.model';
import type { ChartScriptLayer } from '../scripts/script-layers';
import { defaultParams, type IndicatorDef } from '../indicators/registry';

/**
 * The other charts of a multi-chart layout (CC-I5), pure: their own studies and scripts, which script runs they can
 * share with the main chart, and which charts a link group ties together.
 */

/** A Pine indicator on one of the other charts, and its latest run there. */
export interface PanelScript {
  item: ChartScriptItem;
  values: ScriptInputValues;
  /** Its own run on this chart (null until it lands, or when the main chart's identical run is shown). */
  result: ChartScriptResult | null;
  /** Why its last run failed, in the engine's words; null when it did not. */
  error: string | null;
  /** The open of the chart's last bar when it last ran (a new bar runs it again). */
  ranTo: number | null;
}

/** A chart's studies with `def` added at its defaults. */
export function withStudy(studies: readonly ActiveIndicator[], def: IndicatorDef, uid: string): ActiveIndicator[] {
  return [...studies, { uid, defId: def.id, params: defaultParams(def), visible: true }];
}

/** A chart's studies without `uid`. */
export function withoutStudy(studies: readonly ActiveIndicator[], uid: string): ActiveIndicator[] {
  return studies.filter((s) => s.uid !== uid);
}

/** The studies another chart can take: those reading only its own bars (a multi-symbol study needs the main chart's feed). */
export function panelStudyChoices(defs: readonly IndicatorDef[]): IndicatorDef[] {
  return defs.filter((d) => !d.needsCompare);
}

/** A run on the main chart, as far as sharing reads it. */
export interface MainRun {
  item: { key: string };
  values: ScriptInputValues;
  symbol: string;
  resolution: string;
  result: ChartScriptResult;
  until?: number;
  chartType?: string;
}

/**
 * The main chart's run of the same script with the same inputs on the same series (to now, on standard bars), when
 * there is one: another chart showing it draws that run instead of asking the engine for a second identical one.
 */
export function sharedRun(
  main: readonly MainRun[],
  script: Pick<PanelScript, 'item' | 'values'>,
  symbol: string,
  resolution: string,
): MainRun | null {
  return (
    main.find(
      (r) =>
        r.item.key === script.item.key &&
        r.symbol.toUpperCase() === symbol.toUpperCase() &&
        r.resolution === resolution &&
        r.until === undefined &&
        (r.chartType ?? 'standard') === 'standard' &&
        JSON.stringify(r.values) === JSON.stringify(script.values),
    ) ?? null
  );
}

/** The layers another chart draws: each script's own run, or the main chart's identical one. */
export function panelLayers(
  scripts: readonly PanelScript[],
  main: readonly MainRun[],
  symbol: string,
  resolution: string,
): ChartScriptLayer[] {
  const out: ChartScriptLayer[] = [];
  for (const s of scripts) {
    const result = sharedRun(main, s, symbol, resolution)?.result ?? s.result;
    if (result) out.push({ key: s.item.key, result });
  }
  return out;
}

/** The ids of the charts in `link`'s group other than `self` ('main' is the main chart); none for group 0. */
export function linkedCharts(
  self: string,
  link: number,
  main: number,
  panels: readonly { id: string; link: number }[],
): string[] {
  if (!link) return [];
  const out: string[] = [];
  if (self !== 'main' && main === link) out.push('main');
  for (const p of panels) if (p.id !== self && p.link === link) out.push(p.id);
  return out;
}
