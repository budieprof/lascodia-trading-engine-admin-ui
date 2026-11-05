import { describe, expect, it } from 'vitest';

import { quotaRefusalLink, quotaRefusalMessage } from '@core/plans/quota-refusal';
import {
  addOnAction,
  addOnBody,
  addOnFormFrom,
  addOnReturn,
  grantsLabel,
  heldLabel,
  planAllowancesBody,
  unitFormFrom,
  usageTone,
  usd,
  usedLabel,
  usedPercent,
} from './add-ons.logic';
import type { AddOn } from './add-ons.types';

const addOn = (over: Partial<AddOn> = {}): AddOn => ({
  id: 2,
  slug: 'signals',
  name: 'Platform signals',
  description: null,
  priceUsdMonthly: 5,
  trialDays: 14,
  isActive: true,
  grants: { 'signals.symbols': 3 },
  ...over,
});

describe('usage units', () => {
  it('labels used against the allowance, fractional follow-ups included', () => {
    expect(usedLabel({ used: 2.25, allowance: 3 })).toBe('2.25 of 3');
    expect(usedLabel({ used: 4, allowance: null })).toBe('4 (unlimited)');
  });

  it('fills the bar and turns amber at the 80% mark and red when used up', () => {
    expect(usedPercent({ used: 2.25, allowance: 3 })).toBe(75);
    expect(usedPercent({ used: 0, allowance: 0 })).toBe(100);
    expect(usedPercent({ used: 9, allowance: null })).toBe(0);
    expect(usageTone({ used: 2.25, allowance: 3, nearLimit: false })).toBe('ok');
    expect(usageTone({ used: 2.5, allowance: 3, nearLimit: true })).toBe('warn');
    expect(usageTone({ used: 3, allowance: 3, nearLimit: true })).toBe('bad');
    expect(usageTone({ used: 99, allowance: null, nearLimit: false })).toBe('ok');
  });
});

describe('add-on cards', () => {
  it('describes what an add-on grants', () => {
    expect(grantsLabel({ 'ai.analysis': 30, 'watches.active': 10 })).toBe('+30 AI analyses, +10 watches');
    expect(grantsLabel({})).toBe('Nothing yet');
  });

  it('offers Manage when paying by card, Buy when it can be bought, the trial otherwise, else contact', () => {
    expect(addOnAction(addOn({ held: true, manageAvailable: true }))).toBe('manage');
    expect(addOnAction(addOn({ held: true, heldVia: 'trial', checkoutAvailable: true }))).toBe('buy');
    expect(addOnAction(addOn({ held: true, heldVia: 'staff', checkoutAvailable: false }))).toBe('held');
    expect(addOnAction(addOn({ checkoutAvailable: true, trialAvailable: true }))).toBe('buy');
    expect(addOnAction(addOn({ checkoutAvailable: false, trialAvailable: true }))).toBe('trial');
    expect(addOnAction(addOn({ checkoutAvailable: false, trialAvailable: false }))).toBe('contact');
  });

  it('says how and until when it is held', () => {
    const fmt = (iso: string) => iso.slice(0, 10);
    expect(heldLabel(addOn({ held: true, heldVia: 'trial', heldUntilUtc: '2026-11-19T09:00:00Z' }), fmt)).toBe(
      'On until 2026-11-19 (trial)',
    );
    expect(heldLabel(addOn({ held: true, heldVia: 'stripe' }), fmt)).toBe('On (paid by card)');
    expect(heldLabel(addOn({ held: false }), fmt)).toBe('');
  });

  it('reads only the known return values', () => {
    expect(addOnReturn('success')).toBe('success');
    expect(addOnReturn('paystack')).toBe('paystack');
    expect(addOnReturn('evil')).toBeNull();
    expect(addOnReturn(null)).toBeNull();
  });
});

describe('staff editors', () => {
  it('turns an add-on form into its body, empty grants left out', () => {
    const form = addOnFormFrom(addOn());
    form.grants['ai.analysis'] = '';
    form.grants['watches.active'] = '5';
    const { slug, body, error } = addOnBody(form);
    expect(error).toBeNull();
    expect(slug).toBe('signals');
    expect(body).toEqual({
      name: 'Platform signals',
      description: null,
      priceUsdMonthly: 5,
      trialDays: 14,
      isActive: true,
      grants: { 'signals.symbols': 3, 'watches.active': 5 },
    });
  });

  it('refuses a bad slug, a negative grant or a trial past 90 days in plain words', () => {
    expect(addOnBody({ ...addOnFormFrom(addOn()), slug: 'Bad Slug' }).error).toMatch(/Slug/);
    expect(addOnBody({ ...addOnFormFrom(addOn()), trialDays: '120' }).error).toMatch(/Trial days/);
    const neg = addOnFormFrom(addOn());
    neg.grants['ai.analysis'] = '-1';
    expect(addOnBody(neg).error).toMatch(/AI analyses a month/);
  });

  it('sends an empty plan allowance as unlimited (null)', () => {
    const form = unitFormFrom({ 'ai.analysis': 3, 'research.backtest': null });
    expect(planAllowancesBody(form).body).toEqual({
      'ai.analysis': 3,
      'research.backtest': null,
      'signals.symbols': null,
      'watches.active': null,
    });
  });

  it('shows small unit costs with four decimals', () => {
    expect(usd(0.007)).toBe('$0.0070');
    expect(usd(12.4)).toBe('$12.40');
    expect(usd(null)).toBe('—');
  });
});

describe('plan-limit refusals', () => {
  const refusal = (quota: string, message: string) => ({
    error: {
      status: false,
      responseCode: '-403-quota',
      message,
      data: { quota, limit: 3, used: 3, requested: 1, plan: 'Trial', planSlug: 'trial' },
    },
  });

  it("shows the engine's own sentence for a priced unit and links to usage & add-ons", () => {
    const err = refusal(
      'ai.analysis',
      "Your organisation's plan and add-ons allow 3 AI analyses a month; 3 used. Add the AI analyst add-on, or wait until 1 December when the allowance starts again.",
    );
    expect(quotaRefusalMessage(err)).toContain('AI analyst add-on');
    expect(quotaRefusalLink(err)).toEqual({ label: 'See usage & add-ons', route: '/organisation/billing' });
  });

  it('keeps the built sentence for a plan limit, with the same link', () => {
    const err = refusal('tradingAccounts', 'ignored');
    expect(quotaRefusalMessage(err)).toBe(
      "Your organisation's plan (Trial) allows 3 trading accounts; 3 are in use. Free one up, or see Usage & billing for a larger plan.",
    );
    expect(quotaRefusalLink(err)).not.toBeNull();
  });
});
