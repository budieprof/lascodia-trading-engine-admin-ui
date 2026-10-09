import { DiffRow, diffTextField } from './json-diff';
import { parseSavedInputs } from '@features/scripting/pine/pine-saved-inputs';
import { diffInputValues, diffLines, type InputChange } from '@features/scripting/shared/text-diff';

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
  /** Pine script at this version (script strategies, ADR-0027 §3.7); null for other types. */
  scriptSource?: string | null;
  /** Its input overrides. */
  scriptInputs?: Readonly<Record<string, unknown>> | null;
}

const FIELDS: ReadonlyArray<{
  key: Exclude<keyof StrategyVersionFields, 'scriptSource' | 'scriptInputs'>;
  label: string;
  json: boolean;
}> = [
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

/** Every settings change between a captured version and the current values, grouped by field. */
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

/** What a version changed in the Pine script (PE-02). */
export interface ScriptVersionChange {
  before: string;
  after: string;
  sourceChanged: boolean;
  added: number;
  removed: number;
  inputChanges: InputChange[];
}

/**
 * The script side of a version comparison: source lines and input overrides. Null when neither
 * side is a script — or when both carry the same script and inputs.
 */
export function diffScriptVersion(
  before: Pick<StrategyVersionFields, 'scriptSource' | 'scriptInputs'>,
  after: Pick<StrategyVersionFields, 'scriptSource' | 'scriptInputs'>,
  /** Puts both input sets in the form they run in (defaults dropped), when the inputs are known. */
  normalizeInputs: (v: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>> = (
    v,
  ) => v,
): ScriptVersionChange | null {
  const b = before.scriptSource ?? null;
  const a = after.scriptSource ?? null;
  if (b === null && a === null) return null;
  const sourceChanged = (b ?? '') !== (a ?? '');
  const inputChanges = diffInputValues(
    normalizeInputs(before.scriptInputs ?? {}),
    normalizeInputs(after.scriptInputs ?? {}),
  );
  if (!sourceChanged && inputChanges.length === 0) return null;
  const lines = sourceChanged ? diffLines(b ?? '', a ?? '') : null;
  return {
    before: b ?? '',
    after: a ?? '',
    sourceChanged,
    added: lines?.added ?? 0,
    removed: lines?.removed ?? 0,
    inputChanges,
  };
}

/** A captured version's script fields as the diff reads them (inputs parsed from their JSON). */
export function versionScriptFields(v: {
  scriptSource?: string | null;
  scriptInputsJson?: string | null;
}): Pick<StrategyVersionFields, 'scriptSource' | 'scriptInputs'> {
  return {
    scriptSource: v.scriptSource ?? null,
    scriptInputs: v.scriptInputsJson ? parseSavedInputs(v.scriptInputsJson) : null,
  };
}
