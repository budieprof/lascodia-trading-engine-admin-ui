import { DiffRow, diffTextField } from './json-diff';

/** The strategy fields a captured version records (and the edit form can change). */
export interface StrategyVersionFields {
  name: string | null;
  description: string | null;
  parametersJson: string | null;
  riskProfileId: number | null;
  riskOverridesJson: string | null;
  sizingConfigJson: string | null;
  sessionFilterJson: string | null;
  regimeGateJson: string | null;
  multiTimeframeGateJson: string | null;
}

const FIELDS: ReadonlyArray<{ key: keyof StrategyVersionFields; label: string; json: boolean }> = [
  { key: 'name', label: 'Name', json: false },
  { key: 'description', label: 'Description', json: false },
  { key: 'parametersJson', label: 'Parameters / rules', json: true },
  { key: 'riskProfileId', label: 'Risk profile', json: false },
  { key: 'riskOverridesJson', label: 'Risk overrides', json: true },
  { key: 'sizingConfigJson', label: 'Sizing', json: true },
  { key: 'sessionFilterJson', label: 'Session filter', json: true },
  { key: 'regimeGateJson', label: 'Regime gate', json: true },
  { key: 'multiTimeframeGateJson', label: 'Multi-timeframe gate', json: true },
];

export interface VersionDiffRow extends DiffRow {
  /** Path inside the field, e.g. `entryConditionsRoot.children[0].leaf`; '' = the whole field. */
  relPath: string;
}

export interface VersionDiffGroup {
  field: keyof StrategyVersionFields;
  label: string;
  rows: VersionDiffRow[];
}

/** Every change between a captured version and the current values, grouped by field. */
export function diffStrategyVersion(
  before: StrategyVersionFields,
  after: StrategyVersionFields,
): VersionDiffGroup[] {
  const groups: VersionDiffGroup[] = [];
  for (const f of FIELDS) {
    const rows = diffTextField(f.key, before[f.key], after[f.key], { json: f.json }).map((r) => ({
      ...r,
      relPath: r.path === f.key ? '' : r.path.slice(f.key.length + 1),
    }));
    if (rows.length > 0) groups.push({ field: f.key, label: f.label, rows });
  }
  return groups;
}
