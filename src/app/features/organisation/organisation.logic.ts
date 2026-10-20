import { ApiError } from '@core/api/api.types';
import { errorText, reportable } from '@features/iam/iam.logic';

// Decisions shared by the organisation console's pages (multi-tenancy Phase 7, c7-tenant).

/**
 * A two-person action the engine accepted and parked for a second person (contract C3.3: HTTP 202,
 * `-202-approval`). Not a failure: the approval interceptor has already said "sent for approval".
 */
export function isApprovalPending(err: unknown): boolean {
  return err instanceof ApiError && err.isApprovalPending;
}

/**
 * What a page should tell the person about a failed write, or null when it is not the page's to
 * say: a step-up or sign-in (HTTP 401, the interceptor took over) or a request sent for approval.
 */
export function failureMessage(err: unknown, fallback: string): string | null {
  if (!reportable(err) || isApprovalPending(err)) return null;
  return errorText(err, fallback);
}

/** The engine could not find the endpoint: an engine older than the page (HTTP 404, no envelope code). */
export function isMissingEndpoint(err: unknown): boolean {
  const e = err as { status?: unknown; error?: { responseCode?: unknown } | null } | null;
  return e?.status === 404 && !(e.error && typeof e.error.responseCode === 'string');
}

/** The caller lacks the permission (HTTP 403, or an envelope `-403`). */
export function isForbidden(err: unknown): boolean {
  const e = err as { status?: unknown; code?: unknown } | null;
  return e?.status === 403 || e?.code === '-403';
}

/**
 * A typed confirmation matches when the person typed the phrase itself — surrounding spaces and
 * letter case aside. An empty phrase never matches (a confirmation must ask for something).
 */
export function confirmationMatches(typed: string, phrase: string): boolean {
  const want = phrase.trim().toLowerCase();
  return want.length > 0 && typed.trim().toLowerCase() === want;
}
