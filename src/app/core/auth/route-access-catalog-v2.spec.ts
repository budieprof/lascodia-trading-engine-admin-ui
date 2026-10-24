import { describe, expect, it } from 'vitest';

import { permissionsForLegacyRoles } from './legacy-role-permissions';
import { PERMISSION_CATALOG, Permission as P } from './permissions.generated';
import {
  ROUTE_ACCESS,
  canSee,
  type AccessSubject,
  type RouteRule,
  type RouteTable,
} from './route-access';

/**
 * Catalog v2 (multi-tenancy W3, a4-engine A4.1) moved 150 engine endpoints off the access tiers onto
 * specific keys (`EndpointPermissionMoveTests.Moves`). The pages whose first read moved now ask for
 * the new key. The engine proves every House ladder role reaches the same endpoints; these specs
 * prove they see the same pages.
 */

/** Keys catalog v2 added. A House bundle before it was today's bundle without them. */
const ADDED_BY_CATALOG_V2: readonly string[] = [
  P.PositionsManage,
  P.PositionsFlatten,
  P.EngineKillswitchRelease,
  P.RiskLoosen,
  P.AccountsConnect,
  P.DecisionsRead,
  P.DecisionsWrite,
  P.PlatformEngineManage,
  P.PlatformEngineSecrets,
  P.PlatformResearchRun,
  P.PlatformResearchManage,
  P.PlatformDataManage,
  P.PlatformInfrastructureManage,
  P.PlatformElevationRequest,
];

/** The pages that moved, with the rule each had before catalog v2. */
const BEFORE_CATALOG_V2: Record<string, RouteRule> = {
  'drawdown-recovery': { anyOf: [P.AccessOperator] },
  'operator-roles': { anyOf: [P.AccessAdmin] },
  'audit-trail': { anyOf: [P.AccessOperator] },
  'kill-switches': { anyOf: [P.AccessOperator] },
  'dead-letter': { anyOf: [P.AccessOperator] },
  'platform/elevations': { anyOf: [], staffOnly: true, bffOnly: true },
  // h8-harden moved these two engine reads to platform.infrastructure.manage the same way.
  'system-logs': { anyOf: [P.AccessOperator] },
  'worker-health': { anyOf: [P.AccessOperator] },
};
/**
 * Pages added after catalog v2 on a key it introduced: they had no "before", so the comparison leaves them out
 * (and checks below that the key they ask for is the one they read).
 */
const ADDED_AFTER_CATALOG_V2: readonly string[] = [
  // Market-data entitlements (market-data program C6): GET admin/md/entitlements needs platform.data.manage.
  'market-data/entitlements',
  // Market-data sources (engine enterprise onboarding): GET admin/md/sources needs platform.data.manage.
  'market-data/sources',
  // Subscriber declarations (multi-asset WS8 8.2).
  'market-data/declarations',
  'market-data/declarations-review',
];
const TABLE_NOW: RouteTable = Object.fromEntries(
  Object.entries(ROUTE_ACCESS).filter(([path]) => !ADDED_AFTER_CATALOG_V2.includes(path)),
);
const TABLE_BEFORE: RouteTable = { ...TABLE_NOW, ...BEFORE_CATALOG_V2 };

function subject(keys: readonly string[], bff: boolean, platformStaff: boolean): AccessSubject {
  const held = new Set(keys);
  return { hasPermission: (k) => held.has(k), bff, platformStaff };
}

/**
 * Every page of the table the person may open, signed in either way. Platform staff = holds
 * `platform.tenants.manage` in House: AuthService decides so in legacy mode, and the engine's
 * `/bff/session` reports `isPlatformStaff` by the same rule.
 */
function pages(keys: readonly string[], table: RouteTable): string[] {
  const out: string[] = [];
  const staff = keys.includes(P.PlatformTenantsManage);
  for (const bff of [false, true]) {
    const who = subject(keys, bff, staff);
    for (const path of Object.keys(table)) {
      if (canSee(`/${path}`, who, table))
        out.push(`${bff ? 'bff' : 'legacy'}${staff ? '+staff' : ''} ${path}`);
    }
  }
  return out.sort();
}

const without = (keys: readonly string[], drop: readonly string[]) =>
  keys.filter((k) => !drop.includes(k));

describe('route table after catalog v2', () => {
  it('asks each moved page for the key its read now needs', () => {
    const table = ROUTE_ACCESS as RouteTable;
    expect(table['kill-switches'].anyOf).toEqual([P.EngineKillswitch]);
    expect(table['drawdown-recovery'].anyOf).toEqual([P.RiskManage]);
    expect(table['audit-trail'].anyOf).toEqual([P.DecisionsRead]);
    expect(table['operator-roles'].anyOf).toEqual([P.IamMembersRead]);
    expect(table['dead-letter'].anyOf).toEqual([P.PlatformInfrastructureManage]);
    // h8-harden: engine-wide reads of every organisation's free text (process log, worker errors).
    expect(table['system-logs'].anyOf).toEqual([P.PlatformInfrastructureManage]);
    expect(table['worker-health'].anyOf).toEqual([P.PlatformInfrastructureManage]);
    expect(table['market-data/entitlements']).toEqual({
      anyOf: [P.PlatformDataManage],
      staffOnly: true,
    });
    expect(table['market-data/sources']).toEqual({
      anyOf: [P.PlatformDataManage],
      staffOnly: true,
    });
    expect(table['platform/elevations']).toEqual({
      anyOf: [P.PlatformElevationRequest],
      staffOnly: true,
      bffOnly: true,
    });
  });

  it.each(['Viewer', 'Trader', 'Analyst', 'Operator', 'Admin', 'EA'])(
    'shows House %s exactly the pages it saw before',
    (role) => {
      const now = permissionsForLegacyRoles([role]);
      expect(pages(now, TABLE_NOW)).toEqual(pages(without(now, ADDED_BY_CATALOG_V2), TABLE_BEFORE));
    },
  );

  it('shows the super admin (every key) exactly the pages it saw before', () => {
    const all = PERMISSION_CATALOG.map((p) => p.key);
    const seen = pages(all, TABLE_NOW);
    expect(seen).toEqual(pages(without(all, ADDED_BY_CATALOG_V2), TABLE_BEFORE));
    for (const page of Object.keys(BEFORE_CATALOG_V2)) {
      expect(
        seen.some((s) => s.endsWith(` ${page}`)),
        page,
      ).toBe(true);
    }
  });

  it('opens the moved pages to organisation roles built from the specific keys', () => {
    // Engine DefaultRoles.Organisation: RiskManager = Viewer + the risk keys; Billing = members only.
    const riskManager = subject(
      [
        ...permissionsForLegacyRoles(['Viewer']),
        P.RiskManage,
        P.RiskLoosen,
        P.EngineKillswitch,
        P.EngineKillswitchRelease,
        P.PositionsFlatten,
        P.PositionsManage,
        P.OrdersCancel,
        P.OrdersCancelBatch,
        P.DecisionsRead,
        P.IamApprovalsDecide,
      ],
      true,
      false,
    );
    for (const page of ['/kill-switches', '/drawdown-recovery', '/audit-trail']) {
      expect(canSee(page, riskManager), page).toBe(true);
    }
    expect(canSee('/engine-config', riskManager)).toBe(false);
    expect(canSee('/dead-letter', riskManager)).toBe(false);
    // h8-harden: an organisation's Operator (outside House the engine honours no platform.* key) no longer sees the
    // engine-wide log or the workers' error text; House's Operator still does (the House specs above).
    const orgOperator = subject(
      permissionsForLegacyRoles(['Operator']).filter((k) => !k.startsWith('platform.')),
      true,
      false,
    );
    expect(canSee('/system-logs', orgOperator)).toBe(false);
    expect(canSee('/worker-health', orgOperator)).toBe(false);
    expect(canSee('/operator-roles', subject([P.IamMembersRead], true, false))).toBe(true);
  });

  it('keeps platform machinery from another organisation’s Operator', () => {
    const customerOperator = subject(permissionsForLegacyRoles(['Operator'], 7), true, false);
    expect(canSee('/dead-letter', customerOperator)).toBe(false);
    expect(canSee('/kill-switches', customerOperator)).toBe(true);
    // Its read stayed on access.operator; only the writes moved to platform.engine.manage.
    expect(canSee('/engine-config', customerOperator)).toBe(true);
  });

  it('opens elevated access only to staff who may request it, signed in through the BFF', () => {
    expect(canSee('/platform/elevations', subject([], true, true))).toBe(false);
    expect(canSee('/platform/elevations', subject([P.PlatformElevationApprove], true, true))).toBe(
      false,
    );
    expect(canSee('/platform/elevations', subject([P.PlatformElevationRequest], true, true))).toBe(
      true,
    );
    expect(canSee('/platform/elevations', subject([P.PlatformElevationRequest], true, false))).toBe(
      false,
    );
    expect(canSee('/platform/elevations', subject([P.PlatformElevationRequest], false, true))).toBe(
      false,
    );
  });
});
