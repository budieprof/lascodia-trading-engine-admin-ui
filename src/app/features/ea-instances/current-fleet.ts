import type { EAInstanceStatus } from '@core/api/api.types';

/** The fields the "current fleet" rule reads — satisfied by both EAFleetItem and EAInstanceDto. */
export interface FleetRowLike {
  instanceId: string;
  tradingAccountId: number;
  status: EAInstanceStatus;
  lastHeartbeat: string;
}

/** A non-live instance stays "current" this long after its last heartbeat. */
export const RECENT_DISCONNECT_MS = 24 * 3_600_000;

/** The engine's liveness window (ObservabilityQueries, EAHealthMonitorWorker): 10 minutes. */
export const LIVE_HEARTBEAT_MS = 10 * 60_000;

/** The engine's status, with a finished deregistration told apart from a shutdown in flight. */
export type FleetStatus = EAInstanceStatus | 'Deregistered';

/**
 * ShuttingDown is what the engine sets on a clean deregister (EA OnDeinit), and it never moves on
 * from there (EAHealthMonitorWorker only ages Active rows) — four instances have sat in it since
 * May/June. One with no heartbeat inside the liveness window is a finished registration, not an EA
 * mid-shutdown: "Deregistered". Same rule as Fleet Health.
 */
export function fleetStatusOf(row: FleetRowLike, nowMs: number): FleetStatus {
  if (row.status !== 'ShuttingDown') return row.status;
  const hb = Date.parse(row.lastHeartbeat);
  return Number.isFinite(hb) && nowMs - hb <= LIVE_HEARTBEAT_MS ? 'ShuttingDown' : 'Deregistered';
}

/** Copy for a fleet status — the engine enum never reaches the screen. */
export const FLEET_STATUS_LABELS: Record<FleetStatus, string> = {
  Active: 'Active',
  ShuttingDown: 'Shutting down',
  Disconnected: 'Disconnected',
  Deregistered: 'Deregistered',
};

/**
 * The instances an operator needs to see, out of every registration the engine has ever recorded
 * (`GET /admin/ea` keeps them all: 57 rows for 5 live EAs):
 *
 * - every Active instance, and every ShuttingDown one still inside the liveness window;
 * - any instance that stopped heartbeating in the last 24 h (Disconnected or Deregistered);
 * - the newest instance of an ACTIVE account that has no live EA — an account that lost its EA a
 *   week ago is the most urgent row on the page, not history.
 *
 * Shared by the EA Instances and Brokers pages so both count "disconnected" the same way.
 */
export function currentFleetIds(
  fleet: readonly FleetRowLike[],
  isAccountActive: (accountId: number) => boolean,
  nowMs: number,
): Set<string> {
  const ids = new Set<string>();
  const liveAccounts = new Set(
    fleet.filter((i) => i.status === 'Active').map((i) => i.tradingAccountId),
  );
  const newestOrphan = new Map<number, FleetRowLike>();
  for (const i of fleet) {
    const status = fleetStatusOf(i, nowMs);
    if (status === 'Active' || status === 'ShuttingDown') {
      ids.add(i.instanceId);
      continue;
    }
    const hb = Date.parse(i.lastHeartbeat);
    if (Number.isFinite(hb) && nowMs - hb < RECENT_DISCONNECT_MS) ids.add(i.instanceId);
    if (!liveAccounts.has(i.tradingAccountId) && isAccountActive(i.tradingAccountId)) {
      const prev = newestOrphan.get(i.tradingAccountId);
      if (!prev || Date.parse(i.lastHeartbeat) > Date.parse(prev.lastHeartbeat)) {
        newestOrphan.set(i.tradingAccountId, i);
      }
    }
  }
  for (const i of newestOrphan.values()) ids.add(i.instanceId);
  return ids;
}
