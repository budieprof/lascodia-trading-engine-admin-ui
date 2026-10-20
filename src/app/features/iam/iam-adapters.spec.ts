import { describe, expect, it } from 'vitest';

import {
  actorUserId,
  toAccessReview,
  toApproval,
  toElevation,
  toGrant,
  toRole,
  toSession,
  toSso,
  toToken,
} from './iam-adapters';

describe('engine DTO adapters', () => {
  it('reads a4 roles (permissionKeys, userCount)', () => {
    expect(
      toRole({
        id: 3,
        name: 'Owner',
        description: 'All',
        isSystem: true,
        platform: false,
        permissionKeys: ['orders.read'],
        userCount: 2,
      }),
    ).toEqual({
      id: 3,
      name: 'Owner',
      description: 'All',
      permissions: ['orders.read'],
      isSystem: true,
      platform: false,
      assignmentCount: 2,
    });
    expect(toRole({ id: 4, name: 'Desk', permissions: ['a.b'] }).permissions).toEqual(['a.b']);
  });

  it('reads grants and names the granter when only an id is known', () => {
    const g = toGrant({
      id: 9,
      principalType: 'Team',
      principalId: 2,
      roleId: 3,
      roleName: 'Trader',
      scopeType: 'TradingAccount',
      scopeId: 18,
      grantedByAdminUserId: 1,
      grantedAtUtc: 't',
    });
    expect(g).toMatchObject({
      id: 9,
      principalType: 'Team',
      scopeId: 18,
      grantedBy: 'User #1',
      scopeName: null,
      expiresAtUtc: null,
    });
  });

  it('unwraps access-review entries ({ grant, stale, idleDays })', () => {
    const r = toAccessReview({
      generatedAtUtc: 'now',
      staleAfterDays: 90,
      grants: [
        {
          grant: {
            id: 7,
            principalType: 'User',
            principalId: 5,
            principalName: 'Ada',
            roleName: 'Viewer',
            scopeType: 'Tenant',
            scopeId: null,
          },
          stale: true,
          idleDays: 120,
        },
      ],
    });
    expect(r).toEqual({
      generatedAtUtc: 'now',
      staleAfterDays: 90,
      grants: [
        {
          grantId: 7,
          principalType: 'User',
          principalId: 5,
          principalName: 'Ada',
          roleName: 'Viewer',
          scopeType: 'Tenant',
          scopeId: null,
          scopeName: null,
          grantedAtUtc: null,
          lastUsedAtUtc: null,
          stale: true,
          idleDays: 120,
        },
      ],
    });
    expect(toAccessReview(null).grants).toEqual([]);
  });

  it('reads the requester of an approval from the actor id', () => {
    expect(actorUserId('7')).toBe(7);
    expect(actorUserId('admin:12')).toBe(12);
    expect(actorUserId('svc-wire')).toBeNull();
    expect(actorUserId(null)).toBeNull();
    expect(
      toApproval({
        id: 1,
        actionKey: 'risk.loosen',
        requestedBy: '7',
        requestedByDisplay: 'Ada',
        status: 'Pending',
      }),
    ).toMatchObject({
      requestedBy: 'Ada',
      requestedByUserId: 7,
    });
  });

  it('reads SSO (clientSecretSet) and treats "none configured" as null', () => {
    expect(
      toSso({
        protocol: 'SAML',
        displayName: 'x',
        clientSecretSet: true,
        domains: ['a.com'],
        enabled: true,
      }),
    ).toMatchObject({
      protocol: 'saml',
      hasClientSecret: true,
      domains: ['a.com'],
    });
    expect(toSso(null)).toBeNull();
  });

  it('reads tokens, sessions and elevations', () => {
    expect(
      toToken({
        id: 1,
        name: 'CI',
        prefix: 'ab',
        permissions: [],
        expiresAtUtc: 'x',
        revokedAtUtc: 'y',
      }).status,
    ).toBe('Revoked');
    expect(toToken({ id: 1, name: 'CI', prefix: 'ab', status: 'Expired' }).status).toBe('Expired');
    expect(toSession({ id: 's1', createdAtUtc: 't', current: true })).toMatchObject({
      id: 's1',
      current: true,
      ipAddress: null,
    });
    expect(
      toElevation({
        id: 2,
        staffAdminUserId: 9,
        tenantId: 3,
        reason: 'r',
        permissions: ['orders.read'],
        minutes: 60,
        status: 'Active',
        approvedByAdminUserId: 4,
      }),
    ).toMatchObject({
      staffUserId: 9,
      staffName: 'Staff #9',
      approvedBy: 'Staff #4',
      minutes: 60,
    });
  });
});
