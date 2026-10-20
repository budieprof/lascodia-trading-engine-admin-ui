import { Permission as P, type PermissionKey } from './permissions.generated';

/**
 * Permissions of a legacy ROLE-ONLY session — the trading-account web login (the Operator tab,
 * `POST /auth/login`), whose token carries role claims but which has no `/admin/auth/me` to ask.
 *
 * Mirrors the engine's `DefaultRoles` bundles for the six ladder roles (engine master,
 * `Application/Common/Security/DefaultRoles.cs`) so such a session sees the pages its roles reach
 * and nothing else. Admin-user sessions never use this: the engine reports their permissions. A
 * session with no roles gets nothing (no "roleless = full access" fallback).
 *
 * Retire with the trading-account web login (`Auth:LegacyWebAccountLogin:Enabled`, i3-engine I3.10);
 * with `bffAuth` on that login is not offered at all.
 */
const READS: readonly PermissionKey[] = [
  P.OrdersRead,
  P.SignalsRead,
  P.StrategiesRead,
  P.MlRead,
  P.MarketdataRead,
  P.RiskRead,
  P.AccountsRead,
];

const VIEWER: readonly PermissionKey[] = [P.AccessViewer, ...READS];

const TRADER: readonly PermissionKey[] = [
  ...VIEWER,
  P.AccessTrader,
  P.OrdersCreate,
  P.OrdersModify,
  P.OrdersCancel,
  P.OrdersApprove,
  P.SignalsApprove,
  P.SignalsReject,
  P.StrategiesLifecycle,
];

const ANALYST: readonly PermissionKey[] = [
  ...VIEWER,
  P.AccessAnalyst,
  P.MlTrain,
  P.MlEvaluate,
  P.LlmbacktestView,
  P.LlmbacktestLaunch,
  P.PrompttemplateView,
  P.PrompttemplateEdit,
];

const OPERATOR: readonly PermissionKey[] = [
  ...TRADER,
  ...ANALYST,
  P.AccessOperator,
  P.OrdersCancelBatch,
  P.MlRollback,
  P.EngineConfig,
  P.EngineKillswitch,
  P.EnginePaper,
  P.RiskManage,
  P.AccountsManage,
  P.StrategiesEdit,
  P.LlmbacktestCancel,
  P.PrompttemplatePromote,
];

const ADMIN: readonly PermissionKey[] = [
  ...OPERATOR,
  P.AccessAdmin,
  P.UsersManage,
  P.RolesManage,
  P.AuditRead,
  P.PlatformTenantsManage,
  P.TenantMembersManage,
  P.IamMembersRead,
  P.IamInvitationsManage,
  P.IamGrantsManage,
  P.IamSecurityManage,
  P.IamSsoManage,
  P.IamSessionsManage,
  P.IamTokensCreate,
  P.IamApprovalsDecide,
  P.IamAccessReview,
  P.PlatformElevationApprove,
  P.PlatformImpersonate,
];

const EA: readonly PermissionKey[] = [
  P.AccessViewer,
  P.AccessEaingest,
  P.OrdersIngest,
  P.MarketdataIngest,
  P.OrdersRead,
  P.MarketdataRead,
];

const BUNDLES: Readonly<Record<string, readonly PermissionKey[]>> = {
  Viewer: VIEWER,
  Trader: TRADER,
  Analyst: ANALYST,
  Operator: OPERATOR,
  Admin: ADMIN,
  EA: EA,
};

/** Union of the bundles of the given role names; unknown role names contribute nothing. */
export function permissionsForLegacyRoles(roles: readonly string[]): PermissionKey[] {
  const out = new Set<PermissionKey>();
  for (const r of roles) for (const k of BUNDLES[r] ?? []) out.add(k);
  return [...out].sort();
}
