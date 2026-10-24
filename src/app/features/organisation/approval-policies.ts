import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import { ApiError, type ResponseData } from '@core/api/api.types';

/**
 * Four-eyes policies (engine `docs/api/four-eyes-approvals.md`, enterprise program fund-module): which of
 * the organisation's actions need how many approvers, with which roles, above which amount. No policy =
 * the action behaves as before.
 */
export interface ApprovalPolicy {
  id: number;
  enabled: boolean;
  approversRequired: number;
  approverRoles: string[];
  thresholdNotional: number | null;
  expiryMinutes: number | null;
  description: string | null;
  updatedBy: string;
  updatedAtUtc: string;
}

export interface ApprovalPolicyRow {
  kind: string;
  title: string;
  description: string;
  hasThreshold: boolean;
  platformWide: boolean;
  settable: boolean;
  policy: ApprovalPolicy | null;
}

export interface ApprovalPolicyDraft {
  enabled: boolean;
  approversRequired: number;
  approverRoles: string[];
  thresholdNotional: number | null;
  expiryMinutes: number | null;
  description: string | null;
  reason: string | null;
}

/** The draft an editor opens with: the policy as it is, or a one-approver policy. */
export function draftOf(row: ApprovalPolicyRow): ApprovalPolicyDraft {
  const p = row.policy;
  return {
    enabled: p?.enabled ?? true,
    approversRequired: p?.approversRequired ?? 1,
    approverRoles: [...(p?.approverRoles ?? [])],
    thresholdNotional: row.hasThreshold ? (p?.thresholdNotional ?? null) : null,
    expiryMinutes: p?.expiryMinutes ?? null,
    description: p?.description ?? null,
    reason: null,
  };
}

/**
 * True when the draft demands less than the current policy (the engine then needs a reason and, if the
 * organisation has a policy-change policy, its approvers): off or removed, fewer approvers, wider or no
 * roles, a threshold set or raised. Mirrors the engine's `ApprovalPolicyRules.IsLoosening`.
 */
export function isLoosening(
  current: ApprovalPolicy | null,
  draft: ApprovalPolicyDraft | null,
): boolean {
  if (!current || !current.enabled) return false;
  if (!draft || !draft.enabled) return true;
  if (draft.approversRequired < current.approversRequired) return true;
  const before = current.approverRoles.map((r) => r.toLowerCase());
  const after = draft.approverRoles.map((r) => r.toLowerCase());
  if (before.length > 0 && (after.length === 0 || after.some((r) => !before.includes(r))))
    return true;
  if (
    draft.thresholdNotional !== null &&
    (current.thresholdNotional === null || draft.thresholdNotional > current.thresholdNotional)
  )
    return true;
  return false;
}

/** "2 approvers (RiskManager) at or above 100,000" — or "Off". */
export function describePolicy(p: ApprovalPolicy | null): string {
  if (!p || !p.enabled) return p ? 'Off' : 'No policy (as before)';
  const who = `${p.approversRequired} approver${p.approversRequired === 1 ? '' : 's'}`;
  const roles = p.approverRoles.length ? ` (${p.approverRoles.join(' or ')})` : '';
  const threshold =
    p.thresholdNotional !== null
      ? ` at or above ${p.thresholdNotional.toLocaleString('en-GB')}`
      : '';
  return `${who}${roles}${threshold}`;
}

/** The envelope's data or an ApiError — a `-202-approval` refusal is an ApiError the page reports as "sent for approval". */
function settled<T>(source: Observable<ResponseData<T>>): Observable<T> {
  return source.pipe(
    map((res) => {
      if (!res || res.status !== true)
        throw new ApiError(res?.responseCode ?? 'UNKNOWN', res?.message ?? 'Request failed', res);
      return res.data as T;
    }),
  );
}

@Injectable({ providedIn: 'root' })
export class ApprovalPoliciesApiService {
  private readonly api = inject(ApiService);

  list(): Observable<ApprovalPolicyRow[]> {
    return settled(
      this.api.get<ResponseData<ApprovalPolicyRow[]>>('/iam/approval-policies', { silent: true }),
    );
  }

  set(kind: string, draft: ApprovalPolicyDraft): Observable<ApprovalPolicy> {
    return settled(
      this.api.put<ResponseData<ApprovalPolicy>>(
        `/iam/approval-policies/${encodeURIComponent(kind)}`,
        draft,
        { silent: true },
      ),
    );
  }

  remove(kind: string, reason: string | null): Observable<unknown> {
    const q = reason ? `?reason=${encodeURIComponent(reason)}` : '';
    return settled(
      this.api.delete<ResponseData<string>>(
        `/iam/approval-policies/${encodeURIComponent(kind)}${q}`,
        { silent: true },
      ),
    );
  }
}
