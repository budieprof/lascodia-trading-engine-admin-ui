import { describe, expect, it } from 'vitest';

import { approvalProgress } from '@features/iam/iam.logic';

import {
  describePolicy,
  draftOf,
  isLoosening,
  type ApprovalPolicy,
  type ApprovalPolicyRow,
} from './approval-policies';

const policy = (p: Partial<ApprovalPolicy> = {}): ApprovalPolicy => ({
  id: 1,
  enabled: true,
  approversRequired: 2,
  approverRoles: ['RiskManager'],
  thresholdNotional: 100_000,
  expiryMinutes: null,
  description: null,
  updatedBy: 'admin-user:5',
  updatedAtUtc: '2026-10-24T10:00:00Z',
  ...p,
});

const row = (p: ApprovalPolicy | null, hasThreshold = true): ApprovalPolicyRow => ({
  kind: 'order.manual.live',
  title: 'Live manual orders',
  description: '',
  hasThreshold,
  platformWide: false,
  settable: true,
  policy: p,
});

describe('approval policies', () => {
  it('opens the editor with the policy as it is, or one approver', () => {
    expect(draftOf(row(null))).toMatchObject({
      enabled: true,
      approversRequired: 1,
      approverRoles: [],
      thresholdNotional: null,
    });
    expect(draftOf(row(policy()))).toMatchObject({
      approversRequired: 2,
      approverRoles: ['RiskManager'],
      thresholdNotional: 100_000,
    });
    expect(draftOf(row(policy(), false)).thresholdNotional).toBeNull();
  });

  it('judges loosening like the engine', () => {
    const base = draftOf(row(policy()));
    expect(isLoosening(null, { ...base, approversRequired: 1 })).toBe(false);
    expect(isLoosening(policy(), base)).toBe(false);
    expect(
      isLoosening(policy(), { ...base, approversRequired: 3, thresholdNotional: 50_000 }),
    ).toBe(false);
    expect(isLoosening(policy(), { ...base, approversRequired: 1 })).toBe(true);
    expect(isLoosening(policy(), { ...base, enabled: false })).toBe(true);
    expect(isLoosening(policy(), { ...base, approverRoles: [] })).toBe(true);
    expect(isLoosening(policy(), { ...base, approverRoles: ['RiskManager', 'Admin'] })).toBe(true);
    expect(isLoosening(policy(), { ...base, thresholdNotional: 200_000 })).toBe(true);
    expect(
      isLoosening(policy({ thresholdNotional: null }), { ...base, thresholdNotional: 1 }),
    ).toBe(true);
    expect(isLoosening(policy(), null)).toBe(true);
    expect(isLoosening(policy({ enabled: false }), null)).toBe(false);
  });

  it('describes a policy in words', () => {
    expect(describePolicy(null)).toBe('No policy (as before)');
    expect(describePolicy(policy({ enabled: false }))).toBe('Off');
    expect(describePolicy(policy())).toBe('2 approvers (RiskManager) at or above 100,000');
  });

  it('shows k-of-n progress on approvals only where a policy shaped them', () => {
    expect(approvalProgress({ id: 1, actionKey: 'x', status: 'Pending' })).toBeNull();
    expect(
      approvalProgress({
        id: 1,
        actionKey: 'x',
        status: 'Pending',
        requiredApprovals: 2,
        approverRoles: ['RiskManager'],
        approvals: [
          { decidedBy: 'Ada', decidedAtUtc: null, note: null, qualifyingRole: 'RiskManager' },
        ],
      }),
    ).toBe('1 of 2 approvals · RiskManager');
  });
});
