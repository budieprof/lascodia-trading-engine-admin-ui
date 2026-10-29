import type { AlgoEngineerAuditRowDto, AlgoEngineerRunStateDto } from '@core/api/api.types';

import type { WorkOrderRow } from './agent-ops';

/** What the timeline recorded over one window (7 or 30 days). */
export interface WindowSummary {
  days: number;
  runsStarted: number;
  runsFinished: number;
  configWrites: number;
  changeSets: number;
  modelEvents: number;
  approvalsAsked: number;
  /** Spend of the work orders active in the window (all their runs), from run state. */
  spendUsd: number;
  /** How many work orders the spend figure covers — the page reads at most a dozen run states. */
  spendSessions: number;
  /** Work orders the timeline shows starting a run in the window. */
  sessionsInWindow: number;
  /** False when some of those work orders' run state was not read, so spend is a lower bound. */
  spendComplete: boolean;
}

function within(iso: string | null | undefined, sinceMs: number): boolean {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) && t >= sinceMs;
}

export function summariseWindow(
  audit: readonly AlgoEngineerAuditRowDto[],
  orders: readonly WorkOrderRow[],
  days: number,
  nowMs: number,
): WindowSummary {
  const since = nowMs - days * 86_400_000;
  const rows = audit.filter((r) => within(r.atUtc, since));
  const count = (kind: string) => rows.filter((r) => r.kind === kind).length;
  const active = orders.filter((o) => o.run && within(o.lastActivityAtUtc, since));
  const sessions = new Set(
    rows.filter((r) => r.kind === 'run_started').map((r) => r.sessionLlmInvocationId),
  );
  const covered = new Set(active.map((o) => o.sessionId));
  const spendComplete = [...sessions].every((id) => covered.has(id));
  return {
    days,
    runsStarted: count('run_started'),
    runsFinished: count('run_ended'),
    configWrites: count('config_change'),
    changeSets: count('change_set'),
    modelEvents: count('model_lifecycle'),
    approvalsAsked: count('approval_requested'),
    spendUsd: active.reduce((s, o) => s + (Number(o.run?.sessionCostUsd) || 0), 0),
    spendSessions: active.length,
    sessionsInWindow: sessions.size,
    spendComplete,
  };
}

/** The newest work orders, whatever their state — the history the idle board lacks. */
export function recentWorkOrders(orders: readonly WorkOrderRow[], limit = 10): WorkOrderRow[] {
  return [...orders]
    .sort((a, b) => Date.parse(b.lastActivityAtUtc) - Date.parse(a.lastActivityAtUtc))
    .slice(0, limit);
}

/** The permissions a work order ran with, as the host recorded them on its run. */
export interface AgentCapabilities {
  mlControl: boolean;
  configWrite: boolean;
  promote: boolean;
  readOnly: boolean;
  maxSteps: number | null;
  budgetUsd: number | null;
  approvalRequiredFor: string[];
  reads: string | null;
  writes: string | null;
  denied: string | null;
}

/** Parses `capabilitiesJson`; null when absent or unreadable. Host deployment details are ignored. */
export function parseCapabilities(json: string | null | undefined): AgentCapabilities | null {
  if (!json) return null;
  try {
    const c = JSON.parse(json) as Record<string, unknown>;
    const pa = (c['platformAccess'] ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return {
      mlControl: c['mlControl'] === true,
      configWrite: c['configWrite'] === true,
      promote: c['promote'] === true,
      readOnly: c['readOnly'] === true,
      maxSteps: num(c['maxSteps']),
      budgetUsd: num(c['budgetUsd']),
      approvalRequiredFor: Array.isArray(c['approvalRequiredFor'])
        ? (c['approvalRequiredFor'] as unknown[]).filter((x): x is string => typeof x === 'string')
        : [],
      reads: str(pa['reads']),
      writes: str(pa['writes']),
      denied: str(pa['denied']),
    };
  } catch {
    return null;
  }
}

/** The newest run that carries capabilities. */
export function latestCapabilities(
  runs: readonly (AlgoEngineerRunStateDto | null)[],
): { caps: AgentCapabilities; atUtc: string } | null {
  const sorted = runs
    .filter((r): r is AlgoEngineerRunStateDto => !!r && !!r.capabilitiesJson)
    .sort((a, b) => Date.parse(b.startedAtUtc) - Date.parse(a.startedAtUtc));
  for (const r of sorted) {
    const caps = parseCapabilities(r.capabilitiesJson);
    if (caps) return { caps, atUtc: r.startedAtUtc };
  }
  return null;
}

/** "ml_trigger_training" → "trigger training". */
export function toolLabel(tool: string): string {
  return tool.replace(/^ml_/, '').replace(/_/g, ' ');
}
