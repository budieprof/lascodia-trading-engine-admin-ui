import type { StrategyDto, StrategyVersionDto } from '@core/api/api.types';
import { diffStrategyVersion, type StrategyVersionFields } from '../../util/version-diff';

export type EditTab = 'inputs' | 'risk' | 'sizing' | 'filters' | 'gates';

type SubConfigKey =
  | 'riskOverridesJson'
  | 'sizingConfigJson'
  | 'sessionFilterJson'
  | 'regimeGateJson'
  | 'multiTimeframeGateJson';

/** The saved sub-configs each form tab edits. */
export const TAB_FIELDS: Record<EditTab, { key: SubConfigKey; label: string }[]> = {
  inputs: [],
  risk: [{ key: 'riskOverridesJson', label: 'Risk overrides' }],
  sizing: [{ key: 'sizingConfigJson', label: 'Sizing' }],
  filters: [{ key: 'sessionFilterJson', label: 'Session filter' }],
  gates: [
    { key: 'regimeGateJson', label: 'Regime gate' },
    { key: 'multiTimeframeGateJson', label: 'Multi-timeframe gate' },
  ],
};

/** One saved setting, flattened to "path = value". */
export interface SavedEntry {
  path: string;
  value: string;
}

/** The set values of a saved JSON sub-config, flattened; [] for blank / "{}" / unparseable. */
export function savedEntries(json: string | null | undefined): SavedEntry[] {
  if (!json || !json.trim()) return [];
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return [{ path: '(raw)', value: json }];
  }
  const out: SavedEntry[] = [];
  const walk = (node: unknown, path: string) => {
    if (node === null || node === undefined || node === '') return;
    if (Array.isArray(node)) {
      if (node.length)
        out.push({
          path,
          value: node
            .map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x)))
            .join(', '),
        });
      return;
    }
    if (typeof node === 'object') {
      for (const [k, child] of Object.entries(node as Record<string, unknown>))
        walk(child, path ? `${path}.${k}` : k);
      return;
    }
    out.push({ path, value: String(node) });
  };
  walk(v, '');
  return out;
}

export function versionFields(v: StrategyVersionDto | StrategyDto): StrategyVersionFields {
  return {
    name: v.name,
    description: v.description,
    parametersJson: v.parametersJson,
    riskProfileId: v.riskProfileId,
    riskOverridesJson: v.riskOverridesJson,
    sizingConfigJson: v.sizingConfigJson,
    sessionFilterJson: v.sessionFilterJson,
    regimeGateJson: v.regimeGateJson,
    multiTimeframeGateJson: v.multiTimeframeGateJson,
  };
}

export interface VersionChange {
  version: StrategyVersionDto;
  /** Labels of the settings this version changed relative to the one before it ([] for the first). */
  changed: string[];
}

/** Versions newest first, each with what it changed vs the previous (older) one. */
export function versionChanges(versions: readonly StrategyVersionDto[]): VersionChange[] {
  const sorted = [...versions].sort((a, b) => b.versionNumber - a.versionNumber);
  return sorted.map((v, i) => {
    const older = sorted[i + 1];
    return {
      version: v,
      changed: older
        ? diffStrategyVersion(versionFields(older), versionFields(v)).map((g) => g.label)
        : [],
    };
  });
}
