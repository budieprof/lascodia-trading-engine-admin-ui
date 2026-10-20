import { Permission as P, type PermissionKey } from './permissions.generated';

/**
 * What a console page needs, in one place: the route guards AND the sidebar read this table, so a
 * page the guard would refuse is never offered in the navigation (and vice versa).
 */
export interface RouteRule {
  /** Hold at least ONE of these keys. Empty = any signed-in person. */
  readonly anyOf: readonly PermissionKey[];
  /** Only with `bffAuth` on: the page's API presupposes organisations / console sessions (W3). */
  readonly bffOnly?: boolean;
  /** Only for platform staff (`/bff/session` → `isPlatformStaff`). */
  readonly staffOnly?: boolean;
}

const rule = (...anyOf: PermissionKey[]): RouteRule => ({ anyOf });
const bff = (...anyOf: PermissionKey[]): RouteRule => ({ anyOf, bffOnly: true });

/**
 * Keyed by URL path without the leading slash. A nested path ADDS to its parents: `/positions/deltas`
 * needs what `positions` needs AND what `positions/deltas` needs — exactly what the router's nested
 * guards enforce.
 *
 * Each key is the permission of the engine endpoint the page reads first (evidence:
 * `p0-authz-endpoint-map.csv`). Where the sidebar used to require a role ladder policy, that policy's
 * access-tier key is kept (Operator → `access.operator`, Analyst → `access.analyst`), so nobody gains
 * or loses a page in the move from roles to permissions.
 *
 * Catalog v2 (multi-tenancy W3, engine `EndpointPermissionMoveTests.Moves`) moved some of those reads
 * off the tiers onto specific keys; their pages follow the key the read now needs (marked "A4.1"
 * below). The House ladder roles hold every moved key their tier implied, so they see the same
 * pages; the move lets an organisation role built from specific keys (e.g. RiskManager:
 * `engine.killswitch`, `risk.manage`, `decisions.read`) reach the pages for them. Writes that moved
 * are gated where the page offers them (`*lscCan` / `hasPermission`), not here.
 */
export const ROUTE_ACCESS = {
  dashboard: rule(P.AccessViewer),
  orders: rule(P.OrdersRead),
  positions: rule(P.OrdersRead),
  'positions/deltas': rule(P.AccessOperator), // POST position/lifecycle/list
  'positions/event-exposure': rule(P.AccessOperator), // GET position/event-exposure
  strategies: rule(P.StrategiesRead),
  'strategies/settings': rule(P.AccessOperator), // GET strategy/promotion-settings
  'strategies/llm-proposals': rule(P.AccessOperator), // GET strategy/llm-proposals
  'strategies/libraries': rule(P.AccessViewer), // GET scripting/libraries
  'strategies/templates': rule(P.StrategiesRead),
  'strategies/rejections': rule(P.StrategiesRead),
  'strategies/compare': rule(P.StrategiesRead),
  'trade-signals': rule(P.SignalsRead),
  'trade-signals/internals': rule(P.AccessTrader), // GET trade-signal/internals
  'trade-signals/feedback': rule(P.SignalsRead),
  rejections: rule(P.AccessTrader), // GET signal-rejection
  'trade-recommendations': rule(P.AccessOperator),
  'pending-signal-recs': rule(P.AccessOperator),
  'trading-accounts': rule(P.AccountsRead),
  brokers: rule(P.AccountsRead),
  'risk-profiles': rule(P.RiskRead),
  'currency-pairs': rule(P.MarketdataRead),
  'market-data': rule(P.MarketdataRead),
  'chart-analysis': rule(P.MarketdataRead),
  watchlist: rule(P.MarketdataRead),
  'spot-analysis': rule(P.AccessOperator),
  conversations: rule(P.AccessOperator),
  'analysis-monitors': rule(P.AccessOperator),
  'algo-engineer/operations': rule(P.AccessOperator),
  'algo-engineer/scorecard': rule(P.AccessOperator),
  'spot-sweep': rule(P.AccessOperator),
  'patient-trader': rule(P.AccessOperator),
  'news-intel': rule(P.AccessOperator),
  'spread-reactive': rule(P.AccessOperator),
  'viability-gates': rule(P.AccessOperator),
  'analyser-comparison': rule(P.AccessOperator),
  'analyser-comparison/audit': rule(P.AccessOperator),
  'signal-sensitivity': rule(P.SignalsRead),
  'llm-backtest': rule(P.LlmbacktestView),
  'prompt-templates': rule(P.PrompttemplateView),
  'ml-models': rule(P.MlRead),
  'composite-ml': rule(P.MlRead),
  llm: rule(P.AccessOperator, P.StrategiesRead), // each child decides
  'llm/invocations': rule(P.AccessOperator),
  'llm/rationales': rule(P.StrategiesRead),
  'llm/settings': rule(P.AccessOperator),
  backtests: rule(P.AccessAnalyst),
  'walk-forward': rule(P.AccessAnalyst),
  'portfolio-backtests': rule(P.AccessAnalyst),
  'pine-screener': rule(P.AccessAnalyst),
  'strategy-ensemble': rule(P.StrategiesRead),
  'strategy-portfolio': rule(P.AccessOperator),
  'strategy-generation': rule(P.AccessOperator),
  'engine-overview': rule(P.AccessOperator),
  'cme-microstructure': rule(P.AccessOperator),
  'fleet-health': rule(P.AccessOperator),
  alerts: rule(P.AccessViewer),
  'execution-quality': rule(P.AccessOperator),
  sentiment: rule(P.MarketdataRead),
  performance: rule(P.StrategiesRead),
  'drawdown-recovery': rule(P.RiskManage), // A4.1: GET drawdown-recovery/latest, /by-account
  martingale: rule(P.AccessOperator),
  'drift-report': rule(P.MlRead),
  'operator-roles': rule(P.IamMembersRead), // A4.1: GET admin/operator-roles
  'paper-trading': rule(P.AccessOperator),
  'engine-config': rule(P.AccessOperator),
  'economic-events': rule(P.MarketdataRead),
  'audit-trail': rule(P.DecisionsRead), // A4.1: POST audit-trail/list
  'system-health': rule(P.AccessViewer),
  // h8-harden: GET system/logs is the whole process's log (every organisation's text) — platform staff / House only.
  'system-logs': rule(P.PlatformInfrastructureManage),
  'kill-switches': rule(P.EngineKillswitch), // A4.1: GET admin/kill-switch/global, /strategy/{id}
  // h8-harden: GET health/workers carries every worker's last error text — platform staff / House only.
  'worker-health': rule(P.PlatformInfrastructureManage),
  'ea-instances': rule(P.AccessOperator),
  terminals: rule(P.AccessOperator),
  'dead-letter': rule(P.PlatformInfrastructureManage), // A4.1: POST dead-letter/list
  'alert-triage': rule(P.AccessViewer),
  calibration: rule(P.AccessOperator),
  optimizations: rule(P.AccessAnalyst),
  'automation-monitor': rule(P.AccessOperator),
  'auto-tune': rule(P.AccessOperator),
  'admin/users': rule(P.UsersManage),
  'admin/roles': rule(P.RolesManage),
  'admin/audit': rule(P.AuditRead),
  'pine-chart-lab': rule(P.AccessAnalyst),

  // ── Your account (personal: any signed-in person) ──
  account: rule(),
  'account/sessions': bff(),
  'account/tokens': bff(P.IamTokensCreate),

  // ── Organisation administration (U3.4, contract C3.5) ──
  iam: bff(
    P.IamMembersRead,
    P.IamInvitationsManage,
    P.IamGrantsManage,
    P.RolesManage,
    P.IamSecurityManage,
    P.IamSsoManage,
    P.IamApprovalsDecide,
    P.IamAccessReview,
    P.TenantUsageRead,
  ),
  'iam/members': bff(P.IamMembersRead),
  'iam/invitations': bff(P.IamMembersRead, P.IamInvitationsManage),
  'iam/roles': bff(P.IamMembersRead, P.RolesManage),
  'iam/grants': bff(P.IamMembersRead, P.IamGrantsManage),
  'iam/teams': bff(P.IamMembersRead, P.IamGrantsManage),
  'iam/account-groups': bff(P.IamMembersRead, P.IamGrantsManage),
  'iam/security': bff(P.IamSecurityManage),
  'iam/sso': bff(P.IamSsoManage),
  'iam/approvals': bff(P.IamApprovalsDecide),
  'iam/access-review': bff(P.IamAccessReview),
  'iam/plan': bff(P.TenantUsageRead), // GET tenant/usage (multi-tenancy Phase 7)

  // ── Organisation console (multi-tenancy Phase 7, c7-tenant) ──
  // What an organisation administers of its own. Their APIs act in the acting organisation with
  // either sign-in (legacy sessions act in House), so they are not BFF-only.
  organisation: rule(
    P.AccountsRead,
    P.EngineConfig,
    P.EngineKillswitch,
    P.PositionsFlatten,
    P.AccessOperator,
    P.AlertsManage,
    P.LlmUsageRead,
    P.LlmKeysManage,
    // c7-lifecycle pages under /organisation
    P.TenantBrandingRead,
    P.TenantDataExport,
    P.TenantClose,
  ),
  'organisation/terminals': rule(P.AccountsRead), // GET machine/enrollments, machine/credentials
  'organisation/settings': rule(P.EngineConfig), // GET config/effective, config/overrides
  // GET admin/kill-switch/tenant + account/{id}; flatten and TenantRisk:* limits are sections by their keys.
  'organisation/risk': rule(P.EngineKillswitch, P.PositionsFlatten, P.EngineConfig),
  // GET strategy/subscriptions and strategy/{id}/account-bindings (the strategy lists need strategies.read).
  'organisation/strategies': rule(P.AccessOperator),
  'organisation/alerts': rule(P.AlertsManage), // GET alerts/channels
  'organisation/llm': rule(P.LlmUsageRead, P.LlmKeysManage), // GET llm/usage, llm/tenant-key
  // ── An organisation's life cycle (multi-tenancy Phase 7, c7-lifecycle) ──
  'organisation/branding': rule(P.TenantBrandingRead), // GET tenant/branding
  'organisation/data-export': rule(P.TenantDataExport), // GET tenant/exports
  'organisation/close': rule(P.TenantClose), // GET tenant/closure
  onboarding: rule(P.TenantUsageRead), // GET tenant/onboarding

  // ── Platform console (U3.6) ──
  // Organisations use the tenant API that is live today, so they work in both modes (legacy: House
  // administrators holding platform.tenants.manage). Elevation and impersonation live in the BFF session.
  platform: { anyOf: [], staffOnly: true },
  'platform/organisations': { anyOf: [P.PlatformTenantsManage], staffOnly: true },
  // Plans, quotas and fleet health (multi-tenancy Phase 7): their APIs work with either sign-in.
  'platform/plans': { anyOf: [P.PlatformPlansManage], staffOnly: true },
  'platform/fleet': { anyOf: [P.PlatformFleetRead], staffOnly: true },
  // Self-serve sign-ups and closed organisations (Phase 7, c7-lifecycle): their APIs work with either sign-in.
  'platform/signups': { anyOf: [P.PlatformTenantsManage], staffOnly: true },
  'platform/closures': {
    anyOf: [P.PlatformTenantsManage, P.PlatformTenantsPurge],
    staffOnly: true,
  },
  // GET + POST platform/elevations (approving one also needs platform.elevation.approve, per row).
  'platform/elevations': { anyOf: [P.PlatformElevationRequest], staffOnly: true, bffOnly: true },
  'platform/impersonation': { anyOf: [P.PlatformImpersonate], staffOnly: true, bffOnly: true },
} as const satisfies Record<string, RouteRule>;

export type AccessPath = keyof typeof ROUTE_ACCESS;

/** What the checks need to know about the person. */
export interface AccessSubject {
  hasPermission(key: string): boolean;
  readonly bff: boolean;
  readonly platformStaff: boolean;
}

/** One rule against one person. */
export function satisfies(r: RouteRule, who: AccessSubject): boolean {
  if (r.bffOnly && !who.bff) return false;
  if (r.staffOnly && !who.platformStaff) return false;
  return r.anyOf.length === 0 || r.anyOf.some((k) => who.hasPermission(k));
}

/** A route table: {@link ROUTE_ACCESS}, or another one a spec compares it with. */
export type RouteTable = Readonly<Record<string, RouteRule>>;

/**
 * The rules that apply to a URL: one per table entry that is the path or a parent of it, outermost
 * first. Empty when no entry matches — an unknown page, which {@link canSee} refuses.
 */
export function rulesFor(url: string, table: RouteTable = ROUTE_ACCESS): RouteRule[] {
  const path = url.split(/[?#]/)[0].replace(/^\/+/, '').replace(/\/+$/, '');
  if (!path) return [];
  const segments = path.split('/');
  const out: RouteRule[] = [];
  for (let i = 1; i <= segments.length; i++) {
    const prefix = segments.slice(0, i).join('/');
    const r = table[prefix];
    if (r) out.push(r);
  }
  return out;
}

/** Whether the person may open the page at `url` (fails closed for a page not in the table). */
export function canSee(url: string, who: AccessSubject, table: RouteTable = ROUTE_ACCESS): boolean {
  const rules = rulesFor(url, table);
  return rules.length > 0 && rules.every((r) => satisfies(r, who));
}

/** Where to send someone a page refused: the dashboard if they may see it, else their account. */
export function landingFor(who: AccessSubject): string {
  return canSee('/dashboard', who) ? '/dashboard' : '/account/profile';
}
