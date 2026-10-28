import type {
  FeatureRequirement,
  FeatureStateKind,
} from '@shared/components/feedback/feature-state.component';

import type {
  PropEnrollment,
  PropOverview,
  PropOverviewAccount,
  PropPayout,
  PropProgram,
  PropReplay,
  PropSetting,
  PropTrader,
} from './prop.types';

/** The engine's `Prop:*` settings and what each one does (the fallback when the overview endpoint is missing). */
export const PROP_SETTING_MEANINGS: Record<string, string> = {
  'Prop:Evaluation:Enabled': 'Running enrolments are judged against their rules.',
  'Prop:Evaluation:IntervalSeconds': 'Seconds between two evaluations of an enrolment.',
  'Prop:Evaluation:StaleAccountSeconds':
    'An account not synced for longer is not judged on equity (only the time limit runs).',
  'Prop:Enforcement:Enabled':
    "A breach (or a pass, when the program says so) engages the account's kill switch — halt only, nothing is closed.",
  'Prop:Evaluation:MaxEnrollmentsPerTenantPerCycle':
    'Most enrolments one organisation has judged per pass.',
  'Prop:Payouts:RequireDistinctApprover':
    'A payout statement is approved by someone other than the person who prepared it.',
};

/** Raw account row the fallback reads (`trading-account/list`). */
export interface AccountRow {
  id: number;
  accountId: string | null;
  accountName: string | null;
  brokerServer: string | null;
  accountType: string;
  currency: string | null;
  balance: number;
  equity: number;
  isActive: boolean;
  isPaper: boolean;
  lastSyncedAt: string;
}

const STATES = ['Active', 'Passed', 'Failed', 'Funded', 'Withdrawn'];
const PAYOUT_STATES = ['Draft', 'Approved', 'Rejected'];

function bool(v: string | null | undefined): boolean | null {
  if (v === null || v === undefined || v === '') return null;
  return v.trim().toLowerCase() === 'true';
}
function int(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The engine's account label (`PropEnrollmentReader.Label`). */
export function accountLabel(
  a: Pick<AccountRow, 'accountName' | 'accountId' | 'brokerServer'>,
): string {
  const name = a.accountName?.trim();
  const login = a.accountId ?? '?';
  return `${name ? `${name} · ` : ''}${login} @ ${a.brokerServer ?? '?'}`;
}

/**
 * The overview built in the console from the list endpoints, for an engine without `GET prop/overview`. Everything here
 * is counted from real rows; what the lists cannot tell (breach totals, EA equity reports, news count) stays null.
 */
export function overviewFromLists(input: {
  programs: PropProgram[];
  traders: PropTrader[];
  enrollments: PropEnrollment[];
  payouts: PropPayout[];
  accounts: AccountRow[];
  settings: Record<string, string | null>;
  now: Date;
}): PropOverview {
  const { programs, traders, enrollments, payouts, accounts, settings, now } = input;
  const s = (k: string) => settings[k] ?? null;
  const stale = int(s('Prop:Evaluation:StaleAccountSeconds'));
  const running = enrollments.filter((e) => e.state === 'Active' || e.state === 'Funded');
  const byState: Record<string, number> = {};
  for (const st of STATES) byState[st] = enrollments.filter((e) => e.state === st).length;
  const byPayout: Record<string, number> = {};
  for (const st of PAYOUT_STATES) byPayout[st] = payouts.filter((p) => p.status === st).length;
  const evaluated = enrollments
    .map((e) => e.lastEvaluatedAtUtc)
    .filter((x): x is string => !!x)
    .sort();
  const settingRows: PropSetting[] = Object.entries(PROP_SETTING_MEANINGS)
    .filter(([key]) => s(key) !== null)
    .map(([key, meaning]) => ({ key, value: s(key) ?? '', meaning }));
  return {
    source: 'lists',
    generatedAtUtc: now.toISOString(),
    evaluationEnabled: bool(s('Prop:Evaluation:Enabled')),
    enforcementEnabled: bool(s('Prop:Enforcement:Enabled')),
    evaluationIntervalSeconds: int(s('Prop:Evaluation:IntervalSeconds')),
    staleAccountSeconds: stale,
    requireDistinctPayoutApprover: bool(s('Prop:Payouts:RequireDistinctApprover')),
    settings: settingRows,
    activePrograms: programs.filter((p) => p.status === 'Active').length,
    archivedPrograms: programs.filter((p) => p.status !== 'Active').length,
    activeTraders: traders.filter((t) => t.isActive).length,
    traders: traders.length,
    linkedTraders: traders.filter((t) => t.adminUserId !== null).length,
    enrollmentsByState: byState,
    breaches24h: 0,
    warnings24h: 0,
    breaches7d: 0,
    breachesTotal: null,
    payoutsByStatus: byPayout,
    approvedNetPayouts: payouts
      .filter((p) => p.status === 'Approved')
      .reduce((sum, p) => sum + p.netPayout, 0),
    lastEvaluatedAtUtc: evaluated.length ? evaluated[evaluated.length - 1] : null,
    payoutApprovalPolicy: null,
    equityReportsLastHour: null,
    highImpactEventsNext7d: null,
    accounts: accounts
      .filter((a) => a.isActive && !a.isPaper)
      .map<PropOverviewAccount>((a) => {
        const r = running.find((e) => e.tradingAccountId === a.id);
        const age = (now.getTime() - new Date(a.lastSyncedAt).getTime()) / 1000;
        return {
          id: a.id,
          label: accountLabel(a),
          accountType: a.accountType,
          currency: a.currency ?? '',
          balance: a.balance,
          equity: a.equity,
          lastSyncedAtUtc: a.lastSyncedAt,
          fresh: Number.isFinite(age) && age <= (stale ?? 300),
          runningEnrollmentId: r?.id ?? null,
          runningProgram: r?.programName ?? null,
        };
      }),
  };
}

export function runningCount(o: PropOverview): number {
  return (o.enrollmentsByState['Active'] ?? 0) + (o.enrollmentsByState['Funded'] ?? 0);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The setup checklist with each step's REAL status (from the overview): the switches, then what the firm must create,
 * then the data the evaluator needs. `null` = the engine did not say.
 */
export function setupRequirements(o: PropOverview): FeatureRequirement[] {
  const running = runningCount(o);
  const fresh = o.accounts.filter((a) => a.fresh).length;
  const reqs: FeatureRequirement[] = [
    {
      label: 'Rule evaluation switched on',
      ok: o.evaluationEnabled,
      detail:
        o.evaluationEnabled === null
          ? 'Prop:Evaluation:Enabled could not be read.'
          : o.evaluationEnabled
            ? `Prop:Evaluation:Enabled = true — every running enrolment is judged every ${o.evaluationIntervalSeconds ?? 15} s.`
            : 'Prop:Evaluation:Enabled = false — nothing is judged.',
      route: '/engine-config',
      query: { search: 'Prop:' },
    },
    {
      label: 'Breaches halt the account',
      ok: o.enforcementEnabled,
      detail:
        o.enforcementEnabled === null
          ? 'Prop:Enforcement:Enabled could not be read.'
          : o.enforcementEnabled
            ? "Prop:Enforcement:Enabled = true — a breach engages the account's kill switch (no new orders; nothing is closed)."
            : 'Prop:Enforcement:Enabled = false — breaches are recorded only.',
      route: '/engine-config',
      query: { search: 'Prop:' },
    },
    {
      label: 'A challenge program defined',
      ok: o.activePrograms > 0,
      detail:
        o.activePrograms > 0
          ? `${plural(o.activePrograms, 'active program')}${o.archivedPrograms ? `, ${o.archivedPrograms} archived` : ''}.`
          : 'No program yet — define the phases and rules traders are judged against (start from a preset).',
      route: '/prop/programs',
    },
    {
      label: 'A trader registered',
      ok: o.traders > 0,
      detail:
        o.traders > 0
          ? `${plural(o.activeTraders, 'active trader')} of ${o.traders}; ${o.linkedTraders} linked to a console user.`
          : 'No trader yet — a trader is the person who holds the challenge account.',
      route: '/prop/traders',
    },
    {
      label: 'An account enrolled',
      ok: running > 0,
      detail:
        running > 0
          ? `${plural(running, 'running enrolment')}.`
          : o.accounts.length
            ? `None running — ${plural(o.accounts.length, 'active trading account')} could be enrolled.`
            : 'None running, and no active trading account to enrol.',
      route: '/prop/enrollments',
    },
    {
      label: 'Accounts report fresh balance and equity',
      ok: o.accounts.length ? fresh === o.accounts.length : null,
      detail: o.accounts.length
        ? `${fresh} of ${o.accounts.length} synced within ${o.staleAccountSeconds ?? 300} s — a stale account is judged on the time limit only.`
        : 'No active account.',
      route: '/ea-instances',
    },
  ];
  if (o.equityReportsLastHour !== null)
    reqs.push({
      label: 'Intraday equity lows reported by the EAs',
      ok: o.equityReportsLastHour > 0,
      detail:
        o.equityReportsLastHour > 0
          ? `${o.equityReportsLastHour.toLocaleString('en-US')} broker-account reports in the last hour: dips between two evaluations are seen.`
          : 'No broker-account report in the last hour: each evaluation sees the account’s latest equity only, so a dip that recovers within the interval is missed.',
    });
  reqs.push({
    label: 'Payouts approved by a second person',
    ok: o.requireDistinctPayoutApprover,
    detail:
      o.requireDistinctPayoutApprover === null
        ? 'Prop:Payouts:RequireDistinctApprover could not be read.'
        : `${o.requireDistinctPayoutApprover ? 'The preparer can never approve their own statement' : 'The preparer may approve their own statement'}${
            o.payoutApprovalPolicy === null
              ? '.'
              : o.payoutApprovalPolicy
                ? '; a four-eyes policy adds approvers.'
                : '; no four-eyes policy (one approver).'
          }`,
    route: '/organisation/approval-policies',
  });
  return reqs;
}

/** on = programs, traders and a running enrolment; partial = something is set up; waiting = nothing yet. */
export function setupKind(o: PropOverview): FeatureStateKind {
  if (o.evaluationEnabled === false) return 'off';
  const steps = [o.activePrograms > 0, o.traders > 0, runningCount(o) > 0];
  if (steps.every(Boolean)) return 'on';
  return steps.some(Boolean) ? 'partial' : 'waiting';
}

// ── Account fit ─────────────────────────────────────────────────────────────────────────────────────

export interface FitVerdict {
  label: string;
  tone: 'ok' | 'bad' | 'info' | '';
}

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '—';
}

/** The verdict of a replay in words. */
export function fitVerdict(r: PropReplay): FitVerdict {
  switch (r.outcome) {
    case 'Passed':
      return { label: `Would have passed on ${day(r.decidedAtUtc)}`, tone: 'ok' };
    case 'Failed':
      return { label: `Would have failed on ${day(r.decidedAtUtc)}`, tone: 'bad' };
    case 'Running':
      return { label: 'No decision yet', tone: 'info' };
    default:
      return { label: 'No equity record', tone: '' };
  }
}

/** How much of a limit a figure uses, in percent (0–100+), or null without a limit. */
export function limitUse(value: number, limit: number | null): number | null {
  if (limit === null || limit <= 0) return null;
  return Math.max(0, (value / limit) * 100);
}

export function useTone(use: number | null): 'ok' | 'warn' | 'bad' | '' {
  if (use === null) return '';
  return use >= 100 ? 'bad' : use >= 70 ? 'warn' : 'ok';
}

/** Counts of the verdicts across accounts (the panel's summary line). */
export function fitTally(rows: { replay: PropReplay }[]): Record<PropReplay['outcome'], number> {
  const t = { Passed: 0, Failed: 0, Running: 0, NoData: 0 };
  for (const r of rows) t[r.replay.outcome]++;
  return t;
}
