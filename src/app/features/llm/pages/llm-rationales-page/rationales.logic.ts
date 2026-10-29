import type { RationaleCoverageDto, RationaleCoverageEntryDto } from '@core/api/api.types';
import type {
  FeatureRequirement,
  FeatureStateKind,
} from '@shared/components/feedback/feature-state.component';

/** Plain-language names for the four lifecycle events the narrative layer explains. */
export const RATIONALE_EVENT_LABELS: Record<string, string> = {
  StrategyActivated: 'Strategy activated',
  OptimizationApproved: 'Optimisation approved',
  EmergencyFlatten: 'Emergency flatten',
  CompositeMLCatalogueDriftDropAlert: 'CompositeML drift alert',
};

export function eventLabel(eventType: string): string {
  return RATIONALE_EVENT_LABELS[eventType] ?? eventType;
}

/** "3 days ago", "5 h ago", "just now" — coarse on purpose; the exact time is in the tooltip. */
export function ageText(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'never';
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '—';
  if (ms < 60_000) return 'just now';
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(ms / 60_000)} min ago`;
  if (h < 48) return `${Math.round(h)} h ago`;
  const d = h / 24;
  if (d < 60) return `${Math.round(d)} days ago`;
  return `${Math.round(d / 30)} months ago`;
}

/** The most recent rationale across every type, from the all-time fields (null when the engine predates them). */
export function latestAnyType(c: RationaleCoverageDto | null): {
  at: string;
  eventType: string;
} | null {
  if (!c) return null;
  let best: { at: string; eventType: string } | null = null;
  for (const e of c.byEventType) {
    const at = e.allTimeLatestAt ?? e.latestAt;
    if (at && (!best || at > best.at)) best = { at, eventType: e.eventType };
  }
  return best;
}

/** Feature-state kind: off when the master switch is off, waiting when on but silent in the window. */
export function rationaleStateKind(c: RationaleCoverageDto | null): FeatureStateKind {
  if (!c) return 'waiting';
  if (c.layerEnabled === false) return 'off';
  if (c.byEventType.some((e) => e.enabled === false)) return 'partial';
  return c.totalRationales > 0 ? 'on' : 'waiting';
}

/** One requirement row per event-type handler, each with its real switch state and history. */
export function rationaleRequirements(c: RationaleCoverageDto): FeatureRequirement[] {
  const rows: FeatureRequirement[] = [
    {
      label: 'Narrative layer switched on',
      ok: c.layerEnabled ?? null,
      detail:
        c.layerEnabled == null
          ? 'switch state not reported by this engine build'
          : c.layerEnabled
            ? 'LifecycleRationaleOptions:Enabled = true (appsettings)'
            : 'LifecycleRationaleOptions:Enabled = false — no rationale is written',
    },
  ];
  for (const e of c.byEventType) {
    rows.push({
      label: `${eventLabel(e.eventType)} handler`,
      ok: e.enabled ?? null,
      detail: entryHistory(e),
    });
  }
  return rows;
}

export function entryHistory(e: RationaleCoverageEntryDto): string {
  const total = e.allTimeCount;
  const last = e.allTimeLatestAt ?? e.latestAt;
  if (total == null) return e.count > 0 ? `${e.count} in window` : 'none in window';
  if (total === 0) return 'never written — the event has not happened since the layer shipped';
  return `${total} written in all · last ${ageText(last)}`;
}
