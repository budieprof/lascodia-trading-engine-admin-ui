import { describe, expect, it } from 'vitest';

import { currentFleetIds, fleetStatusOf, type FleetRowLike } from './current-fleet';

const NOW = Date.parse('2026-10-19T15:00:00Z');
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function row(
  instanceId: string,
  tradingAccountId: number,
  status: FleetRowLike['status'],
  hoursAgo: number,
): FleetRowLike {
  return { instanceId, tradingAccountId, status, lastHeartbeat: ago(hoursAgo) };
}

describe('currentFleetIds', () => {
  const activeAccounts = new Set([17, 25]);
  const isActive = (id: number) => activeAccounts.has(id);

  it('keeps every live instance and a shutdown still in flight', () => {
    const ids = currentFleetIds(
      [row('a', 17, 'Active', 0), row('b', 99, 'ShuttingDown', 0.05)],
      isActive,
      NOW,
    );
    expect([...ids].sort()).toEqual(['a', 'b']);
  });

  it('treats a long-silent ShuttingDown row as a finished deregistration, i.e. history', () => {
    const old = row('dereg', 99, 'ShuttingDown', 500);
    expect(fleetStatusOf(old, NOW)).toBe('Deregistered');
    expect(fleetStatusOf(row('x', 99, 'ShuttingDown', 0.05), NOW)).toBe('ShuttingDown');
    expect(currentFleetIds([row('a', 17, 'Active', 0), old], isActive, NOW).has('dereg')).toBe(
      false,
    );
  });

  it('keeps a deregistered instance that left an active account without an EA', () => {
    const ids = currentFleetIds([row('left', 25, 'ShuttingDown', 300)], isActive, NOW);
    expect([...ids]).toEqual(['left']);
  });

  it('keeps an instance that dropped off within 24 h and hides older history', () => {
    const ids = currentFleetIds(
      [
        row('live', 17, 'Active', 0),
        row('recent', 17, 'Disconnected', 3),
        row('old', 17, 'Disconnected', 400),
      ],
      isActive,
      NOW,
    );
    expect(ids.has('recent')).toBe(true);
    expect(ids.has('old')).toBe(false);
  });

  it('keeps the newest instance of an active account that has no live EA', () => {
    const ids = currentFleetIds(
      [row('older', 25, 'Disconnected', 900), row('newest', 25, 'Disconnected', 300)],
      isActive,
      NOW,
    );
    expect([...ids]).toEqual(['newest']);
  });

  it('does not resurrect history for an inactive account', () => {
    const ids = currentFleetIds([row('gone', 22, 'Disconnected', 300)], isActive, NOW);
    expect(ids.size).toBe(0);
  });
});
