import { describe, expect, it } from 'vitest';

import { tenantFromPayload } from './jwt';
import { permissionsForLegacyRoles } from './legacy-role-permissions';
import { Permission as P } from './permissions.generated';

/**
 * What each deprecated tier implies (engine `PermissionCatalog.Implies`, catalog v2). The engine
 * expands a role's keys by these at runtime; the ladder bundles list them explicitly, so a mirror
 * that misses one would show a ladder role less than the engine lets it do.
 */
const TIER_IMPLIES: Record<string, readonly string[]> = {
  [P.AccessTrader]: [P.OrdersCreate, P.OrdersModify, P.OrdersCancel, P.PositionsManage],
  [P.AccessAnalyst]: [P.PlatformResearchRun],
  [P.AccessOperator]: [
    P.OrdersCancelBatch,
    P.PositionsFlatten,
    P.EngineKillswitch,
    P.EngineKillswitchRelease,
    P.RiskManage,
    P.RiskLoosen,
    P.AccountsManage,
    P.AccountsConnect,
    P.DecisionsRead,
    P.DecisionsWrite,
    P.PlatformEngineManage,
    P.PlatformResearchManage,
    P.PlatformDataManage,
    P.PlatformInfrastructureManage,
  ],
  [P.AccessAdmin]: [P.IamMembersRead, P.IamGrantsManage, P.PlatformEngineSecrets],
  [P.AccessEaingest]: [P.OrdersIngest],
};

describe('permissionsForLegacyRoles (catalog v2)', () => {
  it.each(['Viewer', 'Trader', 'Analyst', 'Operator', 'Admin', 'EA'])(
    '%s holds every key its tier keys imply',
    (role) => {
      const held = new Set<string>(permissionsForLegacyRoles([role]));
      for (const [tier, implied] of Object.entries(TIER_IMPLIES)) {
        if (!held.has(tier)) continue;
        for (const k of implied) expect(held.has(k), `${role}: ${tier} → ${k}`).toBe(true);
      }
    },
  );

  it('gives secrets and elevation requests to Admin only', () => {
    const operator = permissionsForLegacyRoles(['Operator']);
    const admin = permissionsForLegacyRoles(['Admin']);
    expect(operator).not.toContain(P.PlatformEngineSecrets);
    expect(operator).not.toContain(P.PlatformElevationRequest);
    expect(admin).toContain(P.PlatformEngineSecrets);
    expect(admin).toContain(P.PlatformElevationRequest);
  });

  it('counts platform keys only for a House account (or a token from before organisations)', () => {
    const before = permissionsForLegacyRoles(['Admin']);
    expect(permissionsForLegacyRoles(['Admin'], 1)).toEqual(before);
    expect(before).toContain(P.PlatformEngineManage);

    const other = permissionsForLegacyRoles(['Admin'], 7);
    expect(other.filter((k) => k.startsWith('platform.'))).toEqual([]);
    expect(other).toEqual(before.filter((k) => !k.startsWith('platform.')));
    expect(other).toContain(P.EngineKillswitch);
  });
});

describe('tenantFromPayload', () => {
  it('reads the tid claim, numeric or string', () => {
    expect(tenantFromPayload({ tid: 7 })).toBe(7);
    expect(tenantFromPayload({ tid: '1' })).toBe(1);
  });

  it('is null when the token carries no usable tid', () => {
    expect(tenantFromPayload(null)).toBeNull();
    expect(tenantFromPayload({})).toBeNull();
    expect(tenantFromPayload({ tid: 'house' })).toBeNull();
    expect(tenantFromPayload({ tid: 0 })).toBeNull();
    expect(tenantFromPayload({ tid: 2.5 })).toBeNull();
  });
});
