import { HOUSE_TENANT_ID } from '../storage/app-storage';
import { Permission as P, type PermissionKey } from './permissions.generated';

/**
 * Permissions of a legacy ROLE-ONLY session — the trading-account web login (the Operator tab,
 * `POST /auth/login`), whose token carries role claims but which has no `/admin/auth/me` to ask.
 *
 * Mirrors the engine's `DefaultRoles` bundles for the six ladder roles (engine master,
 * `Application/Common/Security/DefaultRoles.cs`, catalog v2) so such a session sees the pages its
 * roles reach and nothing else. Admin-user sessions never use this: the engine reports their
 * permissions. A session with no roles gets nothing (no "roleless = full access" fallback).
 *
 * The engine bundles list every key their deprecated tier key implies (`PermissionCatalog.Implies`)
 * explicitly, so the union below is already what the engine's expansion produces.
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
  // Broker module (enterprise program wave 2): the dealing desk's reads (the plan feature still gates it).
  P.DealingRead,
];

const VIEWER: readonly PermissionKey[] = [
  P.AccessViewer,
  ...READS,
  // Multi-tenancy Phase 7 (c7-lifecycle): every member's console shows the organisation's look.
  P.TenantBrandingRead,
  // Prop module: the person's (or account session's) own challenge dashboard.
  P.PropSelf,
  // security-controls: the platform's release notes.
  P.ReleasesRead,
];

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
  P.PositionsManage,
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
  P.PlatformResearchRun,
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
  // Broker module: the organisation's own trade-feed registrations.
  P.DealingManage,
  P.RiskManage,
  P.AccountsManage,
  P.StrategiesEdit,
  P.LlmbacktestCancel,
  P.PrompttemplatePromote,
  P.PositionsFlatten,
  P.EngineKillswitchRelease,
  P.RiskLoosen,
  P.AccountsConnect,
  P.DecisionsRead,
  P.DecisionsWrite,
  P.PlatformEngineManage,
  P.PlatformResearchManage,
  P.PlatformDataManage,
  P.PlatformInfrastructureManage,
  // Multi-tenancy Phase 7: the organisation's plan and usage.
  P.TenantUsageRead,
  // Billing (enterprise program billing-metering): metered usage, estimate and invoices.
  P.TenantBillingRead,
  // Prop module: run the organisation's programs.
  P.PropRead,
  P.PropManage,
];

const ADMIN: readonly PermissionKey[] = [
  ...OPERATOR,
  P.AccessAdmin,
  P.UsersManage,
  P.RolesManage,
  P.AuditRead,
  P.PlatformEngineSecrets,
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
  P.PlatformElevationRequest,
  P.PlatformElevationApprove,
  P.PlatformImpersonate,
  // Plans, usage, fleet health (Phase 7; platform keys — House only, as above).
  P.PlatformPlansManage,
  P.PlatformUsageRead,
  P.PlatformFleetRead,
  // Billing (enterprise program billing-metering): price books and invoices (platform key — House only).
  P.PlatformBillingManage,
  // An organisation's life cycle (Phase 7, c7-lifecycle): its console look; deleting closed organisations is a
  // platform key (House only, as above).
  P.TenantBrandingManage,
  P.PlatformTenantsPurge,
  // Prop module: approve payout statements.
  P.PropPayoutsApprove,
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

/**
 * Union of the bundles of the given role names; unknown role names contribute nothing.
 *
 * `tenantId` is the organisation the token belongs to (its `tid` claim). Like the engine's access
 * evaluator, platform keys (`platform.*`) from role claims count only in House: another
 * organisation's account session holds its ladder role's organisation keys and no platform keys.
 * A token without `tid` predates organisations and belongs to House.
 */
export function permissionsForLegacyRoles(
  roles: readonly string[],
  tenantId: number | null = null,
): PermissionKey[] {
  const platformKeysCount = tenantId === null || tenantId === HOUSE_TENANT_ID;
  const out = new Set<PermissionKey>();
  for (const r of roles) {
    for (const k of BUNDLES[r] ?? []) {
      if (platformKeysCount || !k.startsWith('platform.')) out.add(k);
    }
  }
  return [...out].sort();
}
