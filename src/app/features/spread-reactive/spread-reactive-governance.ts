import type { SpreadReactiveConfig, SpreadReactiveSettingChange } from './spread-reactive.types';

/**
 * Which spread-reactive settings the engine's risk-change rules govern (RiskSensitiveConfigCatalog,
 * `GovernedSpreadReactiveKeys`). A bump widens a LIVE stop past what the position was sized for, so
 * raising the bump size loosens risk: the save then needs a reason and is held for the cooling-off
 * period unless break-glass is used. Mirrors the engine so the form can ask for the reason before
 * saving; the engine still decides (it refuses a loosening save with no reason, writing nothing).
 */
type Rule = 'increase' | 'cap';
const GOVERNED: ReadonlyArray<{ field: keyof SpreadReactiveConfig; label: string; rule: Rule }> = [
  { field: 'cushionMultiplier', label: 'Cushion multiplier', rule: 'increase' },
  { field: 'maxBumpSpreadMultiple', label: 'Max bump (× floor spread)', rule: 'increase' },
  { field: 'maxBumpSlDistanceFraction', label: 'Max bump (% of stop distance)', rule: 'cap' },
  { field: 'preEmptiveSpreadMultiple', label: 'Pre-emptive bump size', rule: 'increase' },
  { field: 'maxBumpDistancePips', label: 'Max bump distance (pips, legacy)', rule: 'increase' },
];

export interface LooseningChange {
  field: keyof SpreadReactiveConfig;
  label: string;
  from: number;
  to: number;
}

/** The draft's changes that loosen risk compared with what is saved. */
export function looseningChanges(
  saved: SpreadReactiveConfig | null,
  draft: SpreadReactiveConfig | null,
): LooseningChange[] {
  if (!saved || !draft) return [];
  const out: LooseningChange[] = [];
  for (const g of GOVERNED) {
    const from = Number(saved[g.field]);
    const to = Number(draft[g.field]);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) continue;
    // A cap: 0 means no cap at all (the loosest), so going to 0 — or raising it — loosens.
    const loosens = g.rule === 'cap' ? (to <= 0 && from > 0) || (from > 0 && to > from) : to > from;
    if (loosens) out.push({ field: g.field, label: g.label, from, to });
  }
  return out;
}

const SHORT: Record<string, string> = Object.fromEntries(
  GOVERNED.map((g) => [
    `SpreadReactive:${g.field === 'preEmptiveSpreadMultiple' ? 'PreEmptive:SpreadMultiple' : g.field.charAt(0).toUpperCase() + g.field.slice(1)}`,
    g.label,
  ]),
);

/** The setting's console label for an engine key, or the key itself. */
export function governedLabel(key: string): string {
  return SHORT[key] ?? key.replace(/^SpreadReactive:/, '');
}

/**
 * One sentence about the governed part of a save, or null when there is nothing to say (no governed
 * change, or every governed change applied as a tightening).
 */
export function governedSummary(
  changes: SpreadReactiveSettingChange[] | null | undefined,
): string | null {
  const list = changes ?? [];
  const held = list.filter((c) => c.outcome === 'QueuedForCoolingOff');
  const refused = list.filter((c) => c.outcome === 'Refused' || c.outcome === 'NotWritten');
  const applied = list.filter((c) => c.outcome === 'Applied' && c.direction === 'Loosening');
  const parts: string[] = [];
  if (held.length) {
    const when = held
      .map((c) => c.effectiveAt)
      .filter((x): x is string => !!x)
      .sort()[0];
    parts.push(
      `${held.map((c) => governedLabel(c.key)).join(', ')} ${held.length === 1 ? 'is' : 'are'} held for the cooling-off period` +
        (when ? ` until ${new Date(when).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '') +
        ' — the current value stays in force until then.',
    );
  }
  if (applied.length)
    parts.push(`${applied.map((c) => governedLabel(c.key)).join(', ')} applied now (break-glass).`);
  if (refused.length)
    parts.push(`${refused.map((c) => governedLabel(c.key)).join(', ')} not saved.`);
  return parts.length ? parts.join(' ') : null;
}
