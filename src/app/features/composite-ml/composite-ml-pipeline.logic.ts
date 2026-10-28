import type {
  FeatureRequirement,
  FeatureStateKind,
} from '@shared/components/feedback/feature-state.component';

/** Engine `GET composite-ml/pipeline-state` (CompositeMLPipelineStateDto). */
export interface PipelineSwitch {
  key: string;
  value: string | null;
  enabled: boolean | null;
  lastUpdatedAtUtc: string | null;
  description?: string | null;
}

export interface PipelineDataset {
  key: PipelineDatasetKey | string;
  label: string;
  producer: string;
  rows: number;
  oldestUtc: string | null;
  latestUtc: string | null;
}

export interface PipelineState {
  generatorEnabled: boolean | null;
  generatorSwitchChangedAtUtc: string | null;
  lastCycleAtUtc: string | null;
  lastCycleId: string | null;
  lastCycleLayerCount: number;
  lastCycleLayersEnabled: number;
  cyclesRecorded: number;
  strategiesLive: number;
  strategiesEverGenerated: number;
  strategiesByStatus: { status: string; count: number }[];
  switches: PipelineSwitch[];
  datasets: PipelineDataset[];
  generatedAtUtc: string;
}

/** Dataset keys the engine reports; pages name the ones they read. */
export type PipelineDatasetKey =
  | 'layerStates'
  | 'generationAudits'
  | 'decisionRejections'
  | 'policySnapshots'
  | 'layerSkill'
  | 'trainerSkill'
  | 'catalogueDrift'
  | 'rewardCalibrations'
  | 'rewardChangePoints'
  | 'thresholdObservations';

export const GENERATOR_SWITCH = 'Workers:CompositeMLGeneratorWorker:Enabled';
export const POLICY_TRAINER_SWITCH = 'Workers:CompositeMLPolicyTrainingWorker:Enabled';
export const CPC_SWITCH = 'MLCpc:Enabled';
/** Written by the generator at the end of every cycle — its `lastUpdatedAt` is the last cycle. */
export const LAST_CYCLE_MARKER_KEY = 'CompositeMLGenerator:Internal:RealDecisionRound';

/** One config row as `GET config/{key}` answers it (only the fields used here). */
export interface ConfigRowLite {
  key: string;
  value: string;
  lastUpdatedAt: string | null;
  description?: string | null;
}

/**
 * Builds the reduced state an engine without `pipeline-state` can still give: the three switches
 * and the last-cycle marker, read one key at a time. Datasets stay empty (unknown, never guessed),
 * so the panel shows switches and the last cycle only. `null` rows are keys with no config row.
 */
export function stateFromConfigRows(
  rows: Record<string, ConfigRowLite | null>,
  nowIso: string,
): PipelineState {
  const sw = (key: string): PipelineSwitch => {
    const r = rows[key];
    if (!r) return { key, value: null, enabled: null, lastUpdatedAtUtc: null };
    return {
      key,
      value: r.value,
      enabled: parseBool(r.value),
      lastUpdatedAtUtc: r.lastUpdatedAt,
      description: r.description ?? null,
    };
  };
  const generator = sw(GENERATOR_SWITCH);
  const marker = rows[LAST_CYCLE_MARKER_KEY];
  return {
    generatorEnabled: generator.enabled,
    generatorSwitchChangedAtUtc: generator.lastUpdatedAtUtc,
    lastCycleAtUtc: marker?.lastUpdatedAt ?? null,
    lastCycleId: null,
    lastCycleLayerCount: 0,
    lastCycleLayersEnabled: 0,
    cyclesRecorded: 0,
    strategiesLive: 0,
    strategiesEverGenerated: 0,
    strategiesByStatus: [],
    switches: [generator, sw(POLICY_TRAINER_SWITCH), sw(CPC_SWITCH)].filter(
      (s) => s.key === GENERATOR_SWITCH || s.value !== null,
    ),
    datasets: [],
    generatedAtUtc: nowIso,
  };
}

export function parseBool(v: string | null | undefined): boolean | null {
  const t = (v ?? '').trim().toLowerCase();
  if (t === 'true') return true;
  if (t === 'false') return false;
  return null;
}

export type DatasetStatus = 'updating' | 'stopped' | 'never';

/** A dataset still counts as updating while its newest row is at most this old. */
export const UPDATING_WITHIN_MS = 3 * 24 * 3600_000;

export function datasetStatus(d: PipelineDataset, nowMs: number): DatasetStatus {
  if (d.rows === 0 || !d.latestUtc) return 'never';
  return nowMs - Date.parse(d.latestUtc) <= UPDATING_WITHIN_MS ? 'updating' : 'stopped';
}

export const DATASET_STATUS_LABEL: Record<DatasetStatus, string> = {
  updating: 'Still updating',
  stopped: 'Stopped',
  never: 'Never written',
};

/** "26 days ago", "3 h ago", "just now". */
export function ageText(iso: string | null, nowMs: number): string {
  if (!iso) return '—';
  const ms = Math.max(0, nowMs - Date.parse(iso));
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

/** "2 Oct 2026 00:45 UTC" — fixed UTC so it matches the engine's timestamps. */
export function utcText(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

export interface PipelineSummary {
  kind: FeatureStateKind;
  stateLabel: string;
  detail: string;
  requirements: FeatureRequirement[];
  /** One sentence for the compact strip shown on tabs that do have data. */
  compactLine: string;
  /** Datasets other than the page's own that still receive rows — "what still runs". */
  stillRunning: PipelineDataset[];
  datasetRows: (PipelineDataset & { status: DatasetStatus; focus: boolean })[];
}

const CONFIG_ROUTE = '/engine-config';

/**
 * Everything the pipeline panel says, from the engine's real answer. `focus` = the datasets the
 * current page reads, listed first in the requirements so the page's own gap is named.
 */
export function summarisePipeline(
  s: PipelineState,
  focus: readonly string[],
  nowMs: number,
): PipelineSummary {
  const gen = s.switches.find((x) => x.key === GENERATOR_SWITCH);
  const genOn = s.generatorEnabled;
  const datasetRows = s.datasets.map((d) => ({
    ...d,
    status: datasetStatus(d, nowMs),
    focus: focus.includes(d.key),
  }));
  const stillRunning = datasetRows.filter((d) => !d.focus && d.status === 'updating');

  const kind: FeatureStateKind =
    genOn === false ? 'off' : genOn === true ? (s.lastCycleAtUtc ? 'on' : 'waiting') : 'partial';
  const stateLabel =
    genOn === false ? 'Generator off' : genOn === true ? 'Generator on' : 'Generator: no setting';

  const parts: string[] = [];
  if (genOn === false) {
    parts.push(
      s.generatorSwitchChangedAtUtc
        ? `The generator was switched off ${utcText(s.generatorSwitchChangedAtUtc)} (${ageText(s.generatorSwitchChangedAtUtc, nowMs)}), so no new cycles, decisions or policies are produced.`
        : 'The generator is switched off, so no new cycles, decisions or policies are produced.',
    );
  } else if (genOn === null) {
    parts.push('No row exists for the generator switch, so the worker runs on its code default.');
  }
  if (s.lastCycleAtUtc) {
    const layers =
      s.lastCycleLayerCount > 0
        ? ` and recorded ${s.lastCycleLayerCount} layers (${s.lastCycleLayersEnabled} enabled)`
        : '';
    parts.push(`The last cycle ran ${utcText(s.lastCycleAtUtc)}${layers}.`);
  } else {
    parts.push('No generator cycle has been recorded.');
  }
  if (stillRunning.length) {
    parts.push(
      `Still running without new cycles: ${stillRunning.map((d) => d.label.toLowerCase()).join(', ')}.`,
    );
  }

  const requirements: FeatureRequirement[] = [];
  requirements.push({
    label: 'Generator worker switched on',
    ok: genOn,
    detail:
      genOn === false
        ? `${GENERATOR_SWITCH} = false since ${utcText(gen?.lastUpdatedAtUtc ?? null)} (operator's choice — it creates trading strategies)`
        : genOn === true
          ? `${GENERATOR_SWITCH} = true`
          : 'no config row — code default applies',
    route: CONFIG_ROUTE,
    query: { search: 'CompositeMLGenerator' },
  });
  const trainer = s.switches.find((x) => x.key === POLICY_TRAINER_SWITCH);
  if (trainer) {
    requirements.push({
      label: 'Policy trainer worker switched on',
      ok: trainer.enabled,
      detail: `${trainer.key} = ${trainer.value ?? 'default'}${trainer.enabled ? ' — it trains only from decisions the generator records' : ''}`,
      route: CONFIG_ROUTE,
      query: { search: 'CompositeMLPolicyTraining' },
    });
  }
  const audits = s.datasets.find((d) => d.key === 'generationAudits');
  if (audits) {
    requirements.push({
      label: 'Generation decisions to learn from',
      ok: audits.rows > 0,
      detail:
        audits.rows > 0
          ? `${audits.rows.toLocaleString('en-US')} recorded, newest ${utcText(audits.latestUtc)}`
          : 'none recorded — the generator writes one per strategy it proposes',
    });
  }
  for (const d of datasetRows.filter((r) => r.focus && r.key !== 'generationAudits')) {
    requirements.push({
      label: d.label,
      ok: d.rows > 0 ? (d.status === 'updating' ? true : null) : false,
      detail:
        d.rows > 0
          ? `${d.rows.toLocaleString('en-US')} rows, newest ${utcText(d.latestUtc)} (${ageText(d.latestUtc, nowMs)})`
          : `never written — produced by ${d.producer}`,
    });
  }
  const cpc = s.switches.find((x) => x.key === CPC_SWITCH);
  if (cpc && cpc.enabled === false) {
    requirements.push({
      label: 'CPC encoder (MLCpc)',
      ok: false,
      detail: `off since ${utcText(cpc.lastUpdatedAtUtc)} (operator's choice) — models train without the CPC encoder features`,
      route: CONFIG_ROUTE,
      query: { search: 'MLCpc' },
    });
  }

  const compact: string[] = [stateLabel];
  if (genOn === false && s.generatorSwitchChangedAtUtc)
    compact[0] += ` since ${utcText(s.generatorSwitchChangedAtUtc).replace(/ \d\d:\d\d UTC$/, '')}`;
  if (s.lastCycleAtUtc) compact.push(`last cycle ${ageText(s.lastCycleAtUtc, nowMs)}`);
  if (s.strategiesEverGenerated > 0)
    compact.push(`${s.strategiesLive} of ${s.strategiesEverGenerated} generated strategies remain`);
  if (stillRunning.length)
    compact.push(`still updating: ${stillRunning.map((d) => d.label.toLowerCase()).join(', ')}`);

  return {
    kind,
    stateLabel,
    detail: parts.join(' '),
    requirements,
    compactLine: compact.join(' · '),
    stillRunning,
    datasetRows,
  };
}

/**
 * Layer Health asks the engine for a lookback window (clamped 1–90 days). When the window the page
 * opened with is empty, it tries the next wider one until data appears or the engine's 90-day limit
 * is reached. Returns the next window, or null when there is none.
 */
export function nextWiderLookback(
  current: number,
  options: readonly number[] = [1, 7, 30, 90],
): number | null {
  return options.find((d) => d > current) ?? null;
}

/** Plain-language names for the generator's layers (engine `CompositeMLCycleLayerStateBuilder`). */
export const LAYER_DESCRIPTIONS: Record<string, string> = {
  input_ks_gate: 'Input-drift gate — holds back pairs whose model inputs drifted (KS test)',
  output_ks_gate: 'Output-drift gate — penalises pairs whose model predictions drifted (KS test)',
  information_gain: 'Information-gain bonus — favours candidates that would teach the most',
  meta_bandit: 'Meta-bandit — chooses which exploration method to trust',
  diversity_backfill: 'Diversity backfill — fills spare slots with unlike candidates',
  approval_rate_boost: 'Approval-rate boost — explores more where few candidates pass screening',
  regime_transition: 'Regime-transition prediction — boosts pairs likely to change regime',
  sobol_fallback: 'Sobol fallback — even parameter sampling while nothing is learned yet',
  inverse_propensity: 'Inverse-propensity weighting — corrects for which candidates were tried',
  doubly_robust: 'Doubly-robust outcome estimate',
  cycle_param_dedup: 'Parameter dedup — drops near-identical candidates within a cycle',
  outcome_per_pair: 'Per-pair outcome model buckets',
  cross_pair_regime_match:
    'Cross-pair regime match — borrows evidence from pairs in the same regime',
  thompson_sampling: 'Thompson-sampling exploration',
  pair_prioritization: 'Pair prioritisation — orders pairs by expected approval',
};
