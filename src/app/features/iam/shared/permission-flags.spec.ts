import { describe, expect, it } from 'vitest';

import { PERMISSION_CATALOG } from '@core/auth/permissions.generated';
import { permissionFlags } from './permission-flags.component';

const labels = (...args: Parameters<typeof permissionFlags>) =>
  permissionFlags(...args).map((f) => f.label);

describe('permissionFlags', () => {
  it('marks the catalog’s step-up and two-person keys', () => {
    expect(labels('engine.killswitch.release')).toEqual(['MFA', '2-person']);
    expect(labels('risk.loosen')).toEqual(['MFA', '2-person', 'org-wide']);
    expect(labels('roles.manage')).toEqual(['MFA', 'org-wide']);
    expect(labels('accounts.connect')).toEqual(['MFA']);
    expect(labels('access.operator')).toEqual(['org-wide', 'deprecated']);
    expect(labels('orders.read')).toEqual([]);
  });

  it('flags every step-up and two-person key in the catalog', () => {
    for (const p of PERMISSION_CATALOG) {
      expect(labels(p.key).includes('MFA'), p.key).toBe(p.stepUp);
      expect(labels(p.key).includes('2-person'), p.key).toBe(p.twoPerson);
    }
  });

  it('leaves out org-wide where every grant is organisation-wide', () => {
    expect(labels('risk.loosen', { scope: false })).toEqual(['MFA', '2-person']);
    expect(labels('access.viewer', { scope: false })).toEqual(['deprecated']);
  });

  it('uses a catalog entry as given (the engine’s copy may be newer than the console’s)', () => {
    const entry = { stepUp: false, twoPerson: true, scopeable: true, deprecated: false };
    expect(labels(entry)).toEqual(['2-person']);
    expect(permissionFlags(entry)[0]).toMatchObject({ tone: 'warn' });
  });

  it('has nothing for an unknown key or no entry', () => {
    expect(labels('nope.nope')).toEqual([]);
    expect(labels(null)).toEqual([]);
    expect(labels(undefined)).toEqual([]);
  });
});
