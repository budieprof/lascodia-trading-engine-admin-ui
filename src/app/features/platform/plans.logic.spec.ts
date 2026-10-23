import { describe, expect, it } from 'vitest';

import {
  ageText,
  attentionFirst,
  blobErrorText,
  credentialLabel,
  draftFromPlan,
  emptyPlanDraft,
  exportMonths,
  featureList,
  fleetRows,
  limitText,
  monthKey,
  monthLabel,
  overLimitOn,
  parseLimit,
  planBody,
  planErrors,
  usagePercent,
  usageText,
  usageTone,
  usdText,
} from './plans.logic';
import type { FleetInstance, FleetOrganisation, PlanDto, TenantUsage } from './plans.types';

const plan = (over: Partial<PlanDto> = {}): PlanDto => ({
  id: 5,
  slug: 'pro',
  name: 'Pro',
  description: null,
  maxTradingAccounts: 10,
  maxActiveEaInstances: 20,
  maxMembers: 25,
  maxConcurrentResearchJobs: 5,
  maxStrategies: 100,
  maxScripts: 200,
  maxMonthlyLlmUsd: 250,
  logRetentionDays: 180,
  allowsSso: true,
  allowsScim: false,
  allowsPersonalAccessTokens: true,
  isDefault: false,
  isHousePlan: false,
  organisations: 0,
  ...over,
});

const usage = (items: { key: string; used: number; limit: number | null }[]): TenantUsage => ({
  tenantId: 7,
  tenantSlug: 'acme',
  tenantName: 'Acme',
  kind: 'Customer',
  status: 'Active',
  unlimited: false,
  plan: { id: 2, slug: 'trial', name: 'Trial', viaDefault: true },
  items: items.map((i) => ({
    ...i,
    label: i.key,
    remaining: i.limit === null ? null : Math.max(0, i.limit - i.used),
    overLimit: i.limit !== null && i.used > i.limit,
  })),
  features: { sso: false, scim: false, personalAccessTokens: false },
  llm: { available: false, monthlyLimitUsd: 10, monthToDateUsd: null },
  logRetention: { days: 30, applied: false },
  generatedAtUtc: '2026-10-20T09:00:00Z',
});

describe('plan form', () => {
  it('a new plan starts unlimited with no features', () => {
    const d = emptyPlanDraft();
    expect(d.maxTradingAccounts).toBeNull();
    expect(d.allowsSso || d.allowsScim || d.allowsPersonalAccessTokens || d.isDefault).toBe(false);
  });

  it('edits a plan without its permanent slug', () => {
    const d = draftFromPlan(plan({ description: 'For desks' }));
    expect(d.slug).toBeUndefined();
    expect(d.description).toBe('For desks');
    expect(d.maxMonthlyLlmUsd).toBe(250);
  });

  it('reads an empty box as unlimited', () => {
    expect(parseLimit('')).toBeNull();
    expect(parseLimit(null)).toBeNull();
    expect(parseLimit(' 7 ')).toBe(7);
    expect(Number.isNaN(parseLimit('lots') as number)).toBe(true);
  });

  it('checks slug, name and every limit like the engine does', () => {
    const ok = { ...emptyPlanDraft(), slug: 'pro', name: 'Pro' };
    expect(planErrors(ok, true)).toEqual([]);
    expect(planErrors({ ...ok, slug: 'P' }, true)[0]).toContain('Slug must be');
    expect(planErrors({ ...ok, slug: 'house' }, true)).toEqual(['That slug is reserved.']);
    expect(planErrors({ ...ok, slug: 'P' }, false)).toEqual([]); // slugs are not edited
    expect(planErrors({ ...ok, name: ' ' }, true)).toEqual(['Give the plan a name.']);
    expect(planErrors({ ...ok, maxTradingAccounts: -1 }, true)[0]).toContain('Trading accounts');
    expect(planErrors({ ...ok, maxStrategies: 2.5 }, true)[0]).toContain('Strategies');
    expect(planErrors({ ...ok, maxMembers: 0 }, true)[0]).toContain(
      "from 1 (the organisation's Owner)",
    );
    expect(planErrors({ ...ok, maxScripts: 0 }, true)).toEqual([]); // zero = none allowed
    expect(planErrors({ ...ok, maxMonthlyLlmUsd: Number.NaN }, true)[0]).toContain('LLM budget');
    expect(planErrors({ ...ok, logRetentionDays: 0 }, true)[0]).toContain('Log retention');
    expect(planErrors({ ...ok, description: 'x'.repeat(1001) }, true)[0]).toContain('1,000');
  });

  it('starts a new plan on the broker feeds, checks feed ids and sends blank as every feed', () => {
    const ok = { ...emptyPlanDraft(), slug: 'pro', name: 'Pro' };
    expect(ok.marketDataFeeds).toBe('broker-ticks,broker-dom');
    expect(planErrors({ ...ok, marketDataFeeds: 'broker-ticks, cme-l2 venue:*' }, true)).toEqual(
      [],
    );
    expect(planErrors({ ...ok, marketDataFeeds: 'broker-ticks, cme' }, true)[0]).toContain(
      'Unknown market-data feed(s): cme',
    );
    expect(planBody({ ...ok, marketDataFeeds: '  ' }, true).marketDataFeeds).toBeNull();
    expect(draftFromPlan(plan({ marketDataFeeds: 'cme-l2' })).marketDataFeeds).toBe('cme-l2');
  });

  it('sends a trimmed body; the slug only on create', () => {
    const d = { ...emptyPlanDraft(), slug: ' Pro-Desk ', name: ' Pro ', description: '  ' };
    expect(planBody(d, true)).toMatchObject({ slug: 'pro-desk', name: 'Pro', description: null });
    expect('slug' in planBody(d, false)).toBe(false);
  });
});

describe('display', () => {
  it('limits, dollars and features in words', () => {
    expect(limitText(null)).toBe('Unlimited');
    expect(limitText(1500)).toBe('1,500');
    expect(usdText(null)).toBe('Unlimited');
    expect(usdText(10)).toBe('$10.00');
    expect(featureList(plan())).toBe('Single sign-on, Access tokens');
    expect(featureList(plan({ allowsSso: false, allowsPersonalAccessTokens: false }))).toBe('None');
  });

  it('meters: share, tone and text', () => {
    expect(usagePercent({ limit: null, used: 9 })).toBeNull();
    expect(usagePercent({ limit: 4, used: 1 })).toBe(25);
    expect(usagePercent({ limit: 2, used: 3 })).toBe(100);
    expect(usagePercent({ limit: 0, used: 0 })).toBe(0);
    expect(usagePercent({ limit: 0, used: 1 })).toBe(100);
    expect(usageTone({ limit: null, used: 99, overLimit: false })).toBe('ok');
    expect(usageTone({ limit: 10, used: 7, overLimit: false })).toBe('ok');
    expect(usageTone({ limit: 10, used: 8, overLimit: false })).toBe('warn');
    expect(usageTone({ limit: 10, used: 10, overLimit: false })).toBe('bad');
    expect(usageTone({ limit: 2, used: 3, overLimit: true })).toBe('bad');
    expect(usageText({ limit: 4, used: 2 })).toBe('2 of 4');
    expect(usageText({ limit: null, used: 3 })).toBe('3 (unlimited)');
  });

  it("lists what would be over a target plan's limits", () => {
    const current = usage([
      { key: 'tradingAccounts', used: 3, limit: 10 },
      { key: 'members', used: 6, limit: 25 },
      { key: 'scripts', used: 1, limit: null },
    ]);
    const small = plan({ name: 'Trial', maxTradingAccounts: 2, maxMembers: 5, maxScripts: 20 });
    expect(overLimitOn(small, current)).toEqual([
      'Trading accounts: 3 in use, Trial allows 2',
      'People (members + pending invitations): 6 in use, Trial allows 5',
    ]);
    expect(overLimitOn(plan({ maxTradingAccounts: null }), current)).toEqual([]);
    expect(overLimitOn(small, null)).toEqual([]);
    expect(overLimitOn(plan({ isHousePlan: true, maxTradingAccounts: 0 }), current)).toEqual([]);
  });
});

describe('monthly export', () => {
  it('offers this month and the eleven before it, newest first', () => {
    const months = exportMonths(new Date(Date.UTC(2026, 0, 15)));
    expect(months).toHaveLength(12);
    expect(months.slice(0, 3)).toEqual(['2026-01', '2025-12', '2025-11']);
    expect(monthKey(new Date(Date.UTC(2026, 9, 31, 23, 59)))).toBe('2026-10');
    expect(monthLabel('2026-09')).toBe('September 2026');
    expect(monthLabel('nonsense')).toBe('nonsense');
  });

  it("reads the engine's refusal out of a failed file download", async () => {
    const envelope = { status: false, message: 'Give the month as YYYY-MM.', responseCode: '-11' };
    const err = {
      status: 400,
      error: new Blob([JSON.stringify(envelope)], { type: 'application/json' }),
    };
    expect(await blobErrorText(err, 'fallback')).toBe('Give the month as YYYY-MM.');
    expect(await blobErrorText({ status: 500, error: new Blob(['<html>']) }, 'fallback')).toBe(
      'fallback',
    );
    expect(await blobErrorText(null, 'fallback')).toBe('fallback');
  });
});

describe('fleet', () => {
  const instance = (over: Partial<FleetInstance>): FleetInstance => ({
    id: 1,
    instanceId: 'EA-1',
    tenantId: 7,
    tenantSlug: 'acme',
    tradingAccountId: 10,
    accountLogin: '5001',
    brokerServer: 'Broker-Demo',
    status: 'Active',
    health: 'Healthy',
    stateMachine: 'RUNNING',
    eaKillSwitchActive: false,
    eaVersion: '8.47.253',
    lastHeartbeatUtc: '2026-10-20T09:00:00Z',
    heartbeatAgeSeconds: 5,
    credentialOrigin: 'Enrollment',
    credentialLastUsedUtc: null,
    ...over,
  });
  const fleet = [
    instance({ id: 1, instanceId: 'EA-1' }),
    instance({ id: 2, instanceId: 'EA-2', health: 'Stale', heartbeatAgeSeconds: 600 }),
    instance({ id: 3, instanceId: 'EA-3', health: 'Disconnected', status: 'Disconnected' }),
    instance({
      id: 4,
      instanceId: 'EA-4',
      tenantId: 1,
      tenantSlug: 'house',
      stateMachine: 'SAFE_MODE',
      eaVersion: '8.47.252',
    }),
    instance({ id: 5, instanceId: 'EA-5', health: 'ShuttingDown', status: 'ShuttingDown' }),
  ];

  it('puts stale terminals first and filters', () => {
    expect(fleetRows(fleet, 'all', null, '').map((i) => i.instanceId)).toEqual([
      'EA-2',
      'EA-1',
      'EA-4',
      'EA-5',
      'EA-3',
    ]);
    expect(fleetRows(fleet, 'stale', null, '').map((i) => i.instanceId)).toEqual(['EA-2']);
    expect(fleetRows(fleet, 'disconnected', null, '').map((i) => i.instanceId)).toEqual([
      'EA-5',
      'EA-3',
    ]);
    expect(fleetRows(fleet, 'attention', null, '').map((i) => i.instanceId)).toEqual([
      'EA-2',
      'EA-4',
    ]);
    expect(fleetRows(fleet, 'all', 1, '').map((i) => i.instanceId)).toEqual(['EA-4']);
    expect(fleetRows(fleet, 'all', null, '8.47.252').map((i) => i.instanceId)).toEqual(['EA-4']);
    expect(fleetRows(fleet, 'all', null, 'HOUSE').map((i) => i.instanceId)).toEqual(['EA-4']);
  });

  it('lists organisations needing attention first', () => {
    const org = (slug: string, needsAttention: boolean, stale = 0): FleetOrganisation => ({
      tenantId: slug.length,
      slug,
      name: slug,
      kind: 'Customer',
      status: 'Active',
      instances: 1,
      healthy: 1,
      stale,
      disconnected: 0,
      killSwitches: [],
      needsAttention,
    });
    expect(
      attentionFirst([org('alpha', false), org('beta', true, 1), org('gamma', true, 3)]).map(
        (o) => o.slug,
      ),
    ).toEqual(['gamma', 'beta', 'alpha']);
  });

  it('ages and credentials in words', () => {
    expect(ageText(42)).toBe('42 s');
    expect(ageText(600)).toBe('10 min');
    expect(ageText(7200)).toBe('2 h');
    expect(ageText(172_800)).toBe('2 d');
    expect(credentialLabel('Enrollment')).toBe('Own credential (enrolled)');
    expect(credentialLabel('LegacyApiKey')).toBe('Shared account API key (legacy)');
    expect(credentialLabel('Unknown')).toBe('Unknown');
  });
});
