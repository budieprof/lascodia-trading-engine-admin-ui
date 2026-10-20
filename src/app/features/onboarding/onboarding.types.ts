/**
 * Self-serve sign-up and onboarding (engine multi-tenancy Phase 7, LC.1; contract in the engine's
 * `docs/api/tenant-lifecycle.md`). DTOs as the engine sends them (camelCase, enums by name).
 */

/** `GET onboarding/signup` (public; 404 while sign-up is off). */
export interface PublicSignupAvailability {
  available: boolean;
  requiresApproval: boolean;
  linkHours: number;
}

/** `POST onboarding/signup` (public). */
export interface SignupBody {
  email: string;
  displayName: string;
  organisationName: string;
  /** Optional: made from the organisation's name when empty. */
  organisationSlug: string | null;
}

/** The same answer whether the address was new, already pending or already known. */
export interface SignupResult {
  message: string;
  requiresApproval: boolean;
  linkHours: number;
}

export type TenantSignupStatus = 'Pending' | 'Approved' | 'Provisioned' | 'Rejected' | 'Expired';

/** A sign-up as platform staff review it (`GET platform/signups`). */
export interface TenantSignup {
  id: number;
  email: string;
  displayName: string;
  organisationName: string;
  organisationSlug: string;
  status: TenantSignupStatus;
  requiresApproval: boolean;
  requestedAtUtc: string;
  requestIp: string | null;
  expiresAtUtc: string;
  expired: boolean;
  emailVerifiedAtUtc: string | null;
  verificationEmailsSent: number;
  approvedAtUtc: string | null;
  rejectedAtUtc: string | null;
  decisionNote: string | null;
  tenantId: number | null;
  provisionedAtUtc: string | null;
}

/** Whether sign-up can run and why not (`GET platform/signups/status`). */
export interface SignupStatus {
  enabled: boolean;
  available: boolean;
  requiresApproval: boolean;
  linkHours: number;
  reasons: string[];
  pending: number;
}

/** One step of the onboarding checklist (`GET tenant/onboarding`). */
export interface OnboardingItem {
  key: 'connect-terminal' | 'choose-strategies' | 'require-mfa' | 'invite-people' | string;
  title: string;
  description: string;
  done: boolean;
  detail: string | null;
  route: string;
  permission: string;
}

export interface TenantOnboarding {
  tenantId: number;
  name: string;
  createdAtUtc: string;
  selfServe: boolean;
  items: OnboardingItem[];
  completed: number;
  total: number;
  landOnSignIn: boolean;
}
