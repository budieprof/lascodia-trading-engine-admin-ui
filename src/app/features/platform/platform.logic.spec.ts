import { describe, expect, it } from 'vitest';

import type { AccessElevation, TenantDto } from '@features/iam/iam.types';
import { elevationActions, elevationErrors, slugErrors, tenantErrors, tenantStatusAction } from './platform.logic';

describe('organisations', () => {
  it('applies the engine slug rule and reserved names', () => {
    expect(slugErrors('acme-capital')).toEqual([]);
    expect(slugErrors('ab')).toHaveLength(1);
    expect(slugErrors('-acme')).toHaveLength(1);
    expect(slugErrors('Acme')).toEqual([]); // normalised to lowercase, as the engine does
    expect(slugErrors('acme_capital')).toHaveLength(1);
    expect(slugErrors('house')).toEqual(['That slug is reserved.']);
  });

  it('validates a new organisation', () => {
    expect(tenantErrors({ slug: 'acme', name: 'Acme', kind: 'Customer', contributesToPlatformLearning: false })).toEqual([]);
    expect(
      tenantErrors({ slug: 'acme', name: ' ', kind: 'House' as never, contributesToPlatformLearning: false }),
    ).toEqual(['Give the organisation a name.', 'An organisation is a Customer or a Canary.']);
  });

  it('never offers to suspend House or touch a closed organisation', () => {
    const t = (over: Partial<TenantDto>) => ({ id: 1, slug: 's', name: 'n', kind: 'Customer', status: 'Active', ...over }) as TenantDto;
    expect(tenantStatusAction(t({}))).toBe('suspend');
    expect(tenantStatusAction(t({ status: 'Suspended' }))).toBe('reactivate');
    expect(tenantStatusAction(t({ kind: 'House' }))).toBeNull();
    expect(tenantStatusAction(t({ status: 'Closed' }))).toBeNull();
  });
});

describe('elevated access', () => {
  it('needs an organisation, a real reason, at most 240 minutes and some permissions', () => {
    expect(elevationErrors(3, 'Support ticket 4411', 60, ['orders.read'])).toEqual([]);
    expect(elevationErrors(null, 'short', 241, [])).toHaveLength(4);
  });

  it('lets another approver approve, the requester end or open their own', () => {
    const e = { id: 1, staffUserId: 7, tenantId: 3, reason: 'x', permissions: [], status: 'Pending' } as AccessElevation;
    expect(elevationActions(e, 8, true)).toEqual({ approve: true, end: false, open: false });
    expect(elevationActions(e, 7, true)).toEqual({ approve: false, end: true, open: false });
    expect(elevationActions(e, 8, false).approve).toBe(false);
    expect(elevationActions({ ...e, status: 'Active' }, 7, true)).toEqual({ approve: false, end: true, open: true });
    expect(elevationActions({ ...e, status: 'Ended' }, 7, true)).toEqual({ approve: false, end: false, open: false });
  });
});
