import {
  INDICATORS,
  defaultParams,
  indicatorById,
  indicatorLabel,
  type IndicatorInput,
} from './indicators/registry';
import { PROFILE_STUDIES, type ProfileStudyId } from './profiles/profile-studies';
import { CANDLESTICK_PATTERNS } from './patterns/candlestick-patterns';
import { CHART_PATTERNS } from './patterns/chart-patterns';
import type { DialogItem } from './dialog/dialog-items';
import { FUNDAMENTAL_PANES, type FundamentalPaneId } from './panels/fx-fundamentals';

/**
 * One namespace for everything that can sit in the page's active-studies list.
 *
 * Built-in indicators keep their bare registry id (so saved layouts and study
 * templates from before this existed still load); profiles and patterns are
 * prefixed. The chart host routes each active entry by `studyKind(defId)`, so
 * layouts, templates, the studies bar and the legend handle all three alike.
 */

export const PROFILE_PREFIX = 'profile:';
export const CANDLE_PREFIX = 'candle:';
export const CHART_PATTERN_PREFIX = 'chartpattern:';
export const FUND_PREFIX = 'fund:';
/** Every candlestick pattern / every chart pattern in one study. */
export const ALL_PATTERNS = 'all';

export type StudyKind = 'indicator' | 'profile' | 'candle-pattern' | 'chart-pattern' | 'fundamental';

/** Inputs that may be numeric, a select or a symbol — the studies bar renders all three. */
export type StudyInput = IndicatorInput;

export interface StudyMeta {
  kind: StudyKind;
  name: string;
  inputs: readonly StudyInput[];
}

const TREND_INPUT: StudyInput = {
  key: 'trend',
  label: 'Trend filter',
  type: 'select',
  default: 'sma50',
  options: ['sma50', 'none'],
};
const CHART_PATTERN_INPUTS: readonly StudyInput[] = [
  { key: 'pivotDepth', label: 'Pivot depth', type: 'number', default: 5, min: 2, max: 50 },
  { key: 'tolerance', label: 'Tolerance', type: 'number', default: 0.1, min: 0.01, max: 0.5 },
  { key: 'maxPerType', label: 'Max per type', type: 'number', default: 3, min: 1, max: 20 },
];

export function studyKind(defId: string): StudyKind {
  if (defId.startsWith(PROFILE_PREFIX)) return 'profile';
  if (defId.startsWith(CANDLE_PREFIX)) return 'candle-pattern';
  if (defId.startsWith(CHART_PATTERN_PREFIX)) return 'chart-pattern';
  if (defId.startsWith(FUND_PREFIX)) return 'fundamental';
  return 'indicator';
}

export function studySubId(defId: string): string {
  const i = defId.indexOf(':');
  return i < 0 ? defId : defId.slice(i + 1);
}

export function studyMeta(defId: string): StudyMeta | null {
  const sub = studySubId(defId);
  switch (studyKind(defId)) {
    case 'indicator': {
      const def = indicatorById(defId);
      return def ? { kind: 'indicator', name: def.name, inputs: def.inputs } : null;
    }
    case 'profile': {
      const def = PROFILE_STUDIES.find((p) => p.id === sub);
      return def ? { kind: 'profile', name: def.name, inputs: def.inputs as readonly StudyInput[] } : null;
    }
    case 'candle-pattern': {
      const name =
        sub === ALL_PATTERNS
          ? 'All Candlestick Patterns'
          : CANDLESTICK_PATTERNS.find((p) => p.id === sub)?.name;
      return name ? { kind: 'candle-pattern', name, inputs: [TREND_INPUT] } : null;
    }
    case 'chart-pattern': {
      const name =
        sub === ALL_PATTERNS ? 'All Chart Patterns' : CHART_PATTERNS.find((p) => p.id === sub)?.name;
      return name ? { kind: 'chart-pattern', name, inputs: CHART_PATTERN_INPUTS } : null;
    }
    case 'fundamental': {
      const pane = FUNDAMENTAL_PANES.find((p) => p.id === sub && p.available);
      if (!pane) return null;
      return { kind: 'fundamental', name: pane.title, inputs: FUNDAMENTAL_INPUTS[pane.id] ?? [] };
    }
  }
}

const FUNDAMENTAL_INPUTS: Partial<Record<FundamentalPaneId, readonly StudyInput[]>> = {
  'economic-surprise': [
    { key: 'side', label: 'Series', type: 'select', default: 'base − quote', options: ['base − quote', 'base', 'quote'] },
    { key: 'halfLifeDays', label: 'Half-life (days)', type: 'number', default: 30, min: 1, max: 365 },
  ],
};

export function fundamentalIdOf(defId: string): FundamentalPaneId {
  return studySubId(defId) as FundamentalPaneId;
}

export function studyDefaults(defId: string): Record<string, number | string> {
  const def = indicatorById(defId);
  if (def) return defaultParams(def);
  const out: Record<string, number | string> = {};
  for (const i of studyMeta(defId)?.inputs ?? []) out[i.key] = i.default;
  return out;
}

export function studyLabel(defId: string, params: Record<string, number | string>): string {
  const def = indicatorById(defId);
  if (def) return indicatorLabel(def, params);
  const meta = studyMeta(defId);
  if (!meta) return defId;
  const values = meta.inputs.map((i) => params[i.key]).filter((v) => v !== undefined && v !== '');
  return values.length ? `${meta.name} ${values.join(' ')}` : meta.name;
}

export function profileIdOf(defId: string): ProfileStudyId {
  return studySubId(defId) as ProfileStudyId;
}

/** The dialog catalogue for every chart-local study family. */
export function studyDialogItems(): DialogItem[] {
  const items: DialogItem[] = INDICATORS.map((d) => ({
    kind: 'indicator',
    id: d.id,
    name: d.name,
    description: d.description,
    category: d.category,
    tag: d.target,
    keywords: d.keywords,
  }));
  for (const p of PROFILE_STUDIES) {
    items.push({
      kind: 'profile',
      id: PROFILE_PREFIX + p.id,
      name: p.name,
      description: p.description,
      category: p.id === 'tpo' ? 'Market profile' : 'Volume profile',
    });
  }
  items.push({
    kind: 'chart-pattern',
    id: CHART_PATTERN_PREFIX + ALL_PATTERNS,
    name: 'All Chart Patterns',
    description: 'Detects every chart pattern on swing pivots and draws its outline, breakout and target.',
    category: 'Chart patterns',
  });
  for (const p of CHART_PATTERNS) {
    items.push({
      kind: 'chart-pattern',
      id: CHART_PATTERN_PREFIX + p.id,
      name: `${p.name} chart pattern`,
      description: `Auto-detected ${p.name.toLowerCase()} (${p.group}).`,
      category: 'Chart patterns',
      tag: p.direction,
    });
  }
  items.push({
    kind: 'candle-pattern',
    id: CANDLE_PREFIX + ALL_PATTERNS,
    name: 'All Candlestick Patterns',
    description: 'Marks every candlestick pattern, optionally filtered by the SMA50 trend.',
    category: 'Candlestick patterns',
  });
  for (const p of CANDLESTICK_PATTERNS) {
    items.push({
      kind: 'candle-pattern',
      id: CANDLE_PREFIX + p.id,
      name: p.name,
      description: `${p.bars}-bar candlestick pattern, marked "${p.abbr}".`,
      category: 'Candlestick patterns',
      tag: p.abbr,
    });
  }
  for (const f of FUNDAMENTAL_PANES) {
    items.push({
      kind: 'fundamental',
      id: FUND_PREFIX + f.id,
      name: f.title,
      description: f.description,
      category: f.available ? 'FX fundamentals' : 'Unavailable',
      tag: f.available ? 'pane' : 'no data',
    });
  }
  return items;
}
