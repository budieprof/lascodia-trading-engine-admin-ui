import type {
  MarketAnalysisRecommendationDto,
  MarketAnalysisResultDto,
} from '@core/api/api.types';

import type { ChartMarker } from '../chart/chart-host.component';
import { resolutionMs, type EngineTimeframe } from '../datafeed/resolution';
import type {
  AnalysisOutcome,
  ChartAnalysisMonitors,
  ChartMonitor,
  ChartMonitorLevel,
} from './chart-analysis.types';

/**
 * The pure half of analysis on the chart (SP-I5): which timeframe an analysis runs on for the chart's resolution, what
 * an analysis decided, and the lines and markers drawn for it and for the symbol's watches. No Angular, no I/O.
 */

/** A horizontal line on the price pane, labelled. */
export interface AnalysisLine {
  /** Stable across redraws: "a:37445:0:stop", "w:1188:trigger:1.1495". */
  key: string;
  price: number;
  label: string;
  color: string;
  /** Dashed: a condition or a guard rather than an order level. */
  dashed: boolean;
}

/** Colours: the trade layer's language (green target, red stop) plus amber for watches. */
export const LEVEL_COLORS = {
  entryBuy: '#2962FF',
  entrySell: '#AB47BC',
  stop: '#E53935',
  target: '#26A69A',
  trigger: '#F59E0B',
  invalidation: '#B71C1C',
  fired: '#F59E0B',
  touched: '#FBBF24',
  step: '#64748B',
} as const;

/** The timeframes an analysis accepts, shortest first. */
const ANALYSIS_TIMEFRAMES: readonly { tf: EngineTimeframe; ms: number }[] = [
  { tf: 'M1', ms: 60_000 },
  { tf: 'M5', ms: 5 * 60_000 },
  { tf: 'M15', ms: 15 * 60_000 },
  { tf: 'H1', ms: 3_600_000 },
  { tf: 'H4', ms: 4 * 3_600_000 },
  { tf: 'D1', ms: 86_400_000 },
];

/**
 * The analysis timeframe for a chart resolution: the longest one the engine analyses that is not longer than the
 * chart's bar (30m → M15, 2h → H1, 1W → D1). Unknown resolutions analyse on H1.
 */
export function analysisTimeframe(resolution: string): EngineTimeframe {
  const ms = resolutionMs(resolution);
  if (ms === null) return 'H1';
  let pick: EngineTimeframe = 'M1';
  for (const t of ANALYSIS_TIMEFRAMES) if (t.ms <= ms) pick = t.tf;
  return pick;
}

/** Structure Watches run on these timeframes only (engine `ScriptWatchContract.Timeframes`). */
export const WATCH_TIMEFRAMES: readonly EngineTimeframe[] = ['M15', 'H1', 'H4'];

/** The Structure Watch timeframe nearest the chart's: shorter ones watch on M15, a day or longer on H4. */
export function watchTimeframe(resolution: string): EngineTimeframe {
  const tf = analysisTimeframe(resolution);
  if (tf === 'M1' || tf === 'M5') return 'M15';
  if (tf === 'D1') return 'H4';
  return tf;
}

/** The recommendations an analysis made, primary first. */
export function recommendationsOf(r: MarketAnalysisResultDto): MarketAnalysisRecommendationDto[] {
  if (r.recommendations?.length) return r.recommendations;
  return r.recommendation ? [r.recommendation] : [];
}

/** The trades an analysis proposed (Buy or Sell), with their index in the full set. */
export function tradesOf(
  r: MarketAnalysisResultDto,
): { rec: MarketAnalysisRecommendationDto; index: number }[] {
  return recommendationsOf(r)
    .map((rec, index) => ({ rec, index }))
    .filter((x) => x.rec.action === 'Buy' || x.rec.action === 'Sell');
}

/**
 * What the analysis decided: a trade (TRADE NOW), a watch it armed because price is not at its location yet
 * (WATCH), or neither (STAND ASIDE).
 */
export function analysisOutcome(r: MarketAnalysisResultDto): AnalysisOutcome {
  if (tradesOf(r).length > 0) return 'TRADE NOW';
  if ((r.armedMonitorIds?.length ?? 0) > 0) return 'WATCH';
  return 'STAND ASIDE';
}

const finite = (v: number | null | undefined): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * The analysis' plan as lines, labelled with its id: each proposed trade's entry, stop (where the idea is wrong) and
 * target. Holds draw nothing.
 */
export function planLines(r: MarketAnalysisResultDto): AnalysisLine[] {
  const out: AnalysisLine[] = [];
  const id = r.llmInvocationId;
  const many = tradesOf(r).length > 1;
  for (const { rec, index } of tradesOf(r)) {
    const tag = `#${id}${many ? `.${index + 1}` : ''} ${rec.action}`;
    if (finite(rec.entryPrice))
      out.push({
        key: `a:${id}:${index}:entry`,
        price: rec.entryPrice,
        label: `${tag} entry`,
        color: rec.action === 'Buy' ? LEVEL_COLORS.entryBuy : LEVEL_COLORS.entrySell,
        dashed: false,
      });
    if (finite(rec.stopLoss))
      out.push({
        key: `a:${id}:${index}:stop`,
        price: rec.stopLoss,
        label: `${tag} stop — idea wrong here`,
        color: LEVEL_COLORS.stop,
        dashed: false,
      });
    if (finite(rec.takeProfit))
      out.push({
        key: `a:${id}:${index}:target`,
        price: rec.takeProfit,
        label: `${tag} target`,
        color: LEVEL_COLORS.target,
        dashed: false,
      });
  }
  return out;
}

/** True while the engine still evaluates the watch. */
export function isLive(m: ChartMonitor): boolean {
  return m.status === 'Active' || m.status === 'Paused';
}

function levelColor(l: ChartMonitorLevel): string {
  switch (l.kind) {
    case 'trigger':
      return LEVEL_COLORS.trigger;
    case 'invalidation':
      return LEVEL_COLORS.invalidation;
    case 'stop':
      return LEVEL_COLORS.stop;
    case 'target':
      return LEVEL_COLORS.target;
    default:
      return LEVEL_COLORS.entryBuy;
  }
}

/** Short name for who armed a watch. */
export function originLabel(origin: string): string {
  switch (origin) {
    case 'spot-watch':
      return 'analysis watch';
    case 'hunter':
      return 'hunter watch';
    case 'patient-trader':
      return 'patient trader watch';
    case 'assistant':
      return 'assistant watch';
    default:
      return 'your watch';
  }
}

/**
 * Lines for the live watches: the prices each waits at (amber, dashed) or is called off at (dark red, dashed), and
 * its plan. A watch armed by the analysis on screen is labelled with that analysis' id too.
 */
export function watchLines(data: ChartAnalysisMonitors | null, analysisId: number | null): AnalysisLine[] {
  if (!data) return [];
  const out: AnalysisLine[] = [];
  for (const m of data.monitors) {
    if (!isLive(m)) continue;
    const kindTag = m.isStructureWatch ? 'Structure Watch' : 'Watch';
    const from = analysisId !== null && m.anchorLlmInvocationId === analysisId ? ` (#${analysisId})` : '';
    for (const l of m.levels) {
      out.push({
        key: `w:${m.id}:${l.kind}:${l.price}`,
        price: l.price,
        label: `${kindTag} W${m.id}${from}: ${l.label}`,
        color: levelColor(l),
        dashed: l.kind === 'trigger' || l.kind === 'invalidation',
      });
    }
  }
  return out;
}

/** "step 1→2" out of a Structure Watch step note, or null. */
export function stepChange(note: string | null | undefined): string | null {
  const m = /step\s+(\d+)\s*(?:→|->)\s*(\d+)/.exec(note ?? '');
  return m ? `step ${m[1]}→${m[2]}` : null;
}

/**
 * The watches' events as markers on the bar they happened in: a fire (amber arrow above), a touch waiting for the
 * candle to close (amber dot), a watch called off (red square) and a Structure Watch step (grey dot below).
 */
export function watchMarkers(data: ChartAnalysisMonitors | null): ChartMarker[] {
  if (!data) return [];
  const out: ChartMarker[] = [];
  for (const e of data.events) {
    const time = Date.parse(e.occurredAtUtc);
    if (!Number.isFinite(time)) continue;
    const tag = `W${e.monitorId}`;
    switch (e.kind) {
      case 'Fired':
        out.push({ time, position: 'aboveBar', shape: 'arrowDown', color: LEVEL_COLORS.fired, text: `${tag} fired` });
        break;
      case 'Touched':
        out.push({ time, position: 'aboveBar', shape: 'circle', color: LEVEL_COLORS.touched, text: `${tag} touched` });
        break;
      case 'Invalidated':
        out.push({ time, position: 'aboveBar', shape: 'square', color: LEVEL_COLORS.invalidation, text: `${tag} called off` });
        break;
      case 'ScriptStep':
        out.push({
          time,
          position: 'belowBar',
          shape: 'circle',
          color: LEVEL_COLORS.step,
          text: `${tag} ${stepChange(e.note) ?? 'step'}`,
        });
        break;
    }
  }
  return out;
}

/** One line per watch for the panel: what it is, where it stands. */
export function describeWatch(m: ChartMonitor): string {
  const what = m.isStructureWatch
    ? `Structure Watch${m.scriptStep !== null && m.scriptStep !== undefined ? ` on step ${m.scriptStep}` : ''}`
    : 'Watch';
  const side = m.plannedDirection ? ` for a ${m.plannedDirection.toLowerCase()}` : '';
  return `${what}${side} · ${originLabel(m.origin)} · ${m.status.toLowerCase()}`;
}
