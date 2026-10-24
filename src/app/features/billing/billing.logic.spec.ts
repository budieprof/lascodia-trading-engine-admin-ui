import { describe, expect, it } from 'vitest';

import {
  emptyPriceBookForm,
  formFrom,
  invoiceActions,
  money,
  monthLabel,
  parseFeedPrices,
  previousMonth,
  priceBookBody,
  recentMonths,
  totalsByCurrency,
} from './billing.logic';
import type { Invoice, PriceBook } from './billing.types';

const invoice = (over: Partial<Invoice> = {}): Invoice => ({
  id: 1,
  tenantId: 7,
  tenantSlug: 'acme',
  tenantName: 'Acme',
  month: '2026-10',
  periodStartUtc: '2026-10-01T00:00:00Z',
  periodEndUtc: '2026-11-01T00:00:00Z',
  number: null,
  status: 'Draft',
  currency: 'USD',
  subtotal: 100,
  total: 100,
  daysMetered: 31,
  daysInPeriod: 31,
  warnings: [],
  generatedAtUtc: '2026-11-02T00:00:00Z',
  generatedBy: null,
  finalisedAtUtc: null,
  finalisedBy: null,
  reviewNote: null,
  voidedAtUtc: null,
  voidedBy: null,
  voidReason: null,
  paymentStatus: 'NotSubmitted',
  paymentProvider: null,
  paymentReference: null,
  paymentMessage: null,
  paymentUpdatedAtUtc: null,
  lines: null,
  ...over,
});

describe('billing.logic', () => {
  it('formats money with two decimals and the currency', () => {
    expect(money(1234.5, 'USD')).toBe('1,234.50 USD');
    expect(money(null, 'USD')).toBe('—');
  });

  it('lists recent months newest first and the previous month across a year boundary', () => {
    const jan = new Date(Date.UTC(2027, 0, 15));
    expect(recentMonths(3, jan)).toEqual(['2027-01', '2026-12', '2026-11']);
    expect(previousMonth(jan)).toBe('2026-12');
    expect(monthLabel('2026-10')).toBe('October 2026');
  });

  it('offers only the actions the invoice state allows', () => {
    expect(invoiceActions(invoice())).toEqual({
      finalise: true,
      void: true,
      collect: false,
      refresh: false,
    });
    expect(invoiceActions(invoice({ status: 'Finalised', number: 'LSC-202610-000001' }))).toEqual({
      finalise: false,
      void: true,
      collect: true,
      refresh: false,
    });
    expect(
      invoiceActions(
        invoice({ status: 'Finalised', paymentStatus: 'Paid', paymentReference: 'lt_1' }),
      ),
    ).toEqual({ finalise: false, void: false, collect: false, refresh: true });
    expect(invoiceActions(invoice({ status: 'Finalised', total: 0 })).collect).toBe(false);
    expect(invoiceActions(invoice({ status: 'Void' })).void).toBe(false);
  });

  it('totals live invoices per currency, leaving void ones out', () => {
    expect(
      totalsByCurrency([
        invoice({ total: 10 }),
        invoice({ total: 5, currency: 'EUR' }),
        invoice({ total: 99, status: 'Void' }),
      ]),
    ).toBe('10.00 USD · 5.00 EUR');
    expect(totalsByCurrency([])).toBe('—');
  });

  it('parses feed price lines and names bad ones', () => {
    const ok = parseFeedPrices('cme-l2, 120, 15, 20\n\nvenue:lmax, 50');
    expect(ok.errors).toEqual([]);
    expect(ok.prices).toEqual([
      { feedId: 'cme-l2', monthlyCost: 120, perDisplayUserCost: 15, marginPct: 20 },
      { feedId: 'venue:lmax', monthlyCost: 50, perDisplayUserCost: 0, marginPct: 0 },
    ]);
    const bad = parseFeedPrices('nope, 1\ncme-l2, -1\ncme-l2, 1');
    expect(bad.errors).toEqual([
      "Feed line 1: 'nope' is not a feed id.",
      'Feed line 2: costs and margin must be numbers ≥ 0.',
      "Feed line 3: 'cme-l2' is listed twice.",
    ]);
  });

  it('builds the request body or the problems that stop it', () => {
    const form = {
      ...emptyPriceBookForm(2, new Date(Date.UTC(2026, 9, 24))),
      platformFeeMonthly: '99',
      currency: 'eur',
    };
    expect(form.effectiveFrom).toBe('2026-11-01');
    const { body, errors } = priceBookBody(form);
    expect(errors).toEqual([]);
    expect(body).toMatchObject({
      planId: 2,
      currency: 'EUR',
      effectiveFromUtc: '2026-11-01T00:00:00Z',
      platformFeeMonthly: 99,
      llmMarginPct: null,
    });

    const broken = priceBookBody({
      ...form,
      planId: null,
      includedTerminals: '1.5',
      currency: 'EURO',
      llmMarginPct: 'x',
    });
    expect(broken.body).toBeNull();
    expect(broken.errors).toEqual(
      expect.arrayContaining([
        'Choose the plan.',
        'Included terminals must be a whole number ≥ 0.',
        'Currency is a three-letter code (USD, EUR, GBP).',
        'LLM margin must be a number ≥ 0.',
      ]),
    );
  });

  it('starts a new version from a published one with a fresh effective day', () => {
    const book = {
      id: 3,
      planId: 2,
      planSlug: 'pro',
      planName: 'Pro',
      version: 1,
      status: 'Published',
      currency: 'USD',
      effectiveFromUtc: '2026-09-01T00:00:00Z',
      platformFeeMonthly: 300,
      perTerminalMonthly: 20,
      includedTerminals: 2,
      perUserMonthly: 0,
      includedUsers: 0,
      propModuleMonthly: 0,
      brokerModuleMonthly: 0,
      fundModuleMonthly: 50,
      feedPrices: [{ feedId: 'cme-l2', monthlyCost: 120, perDisplayUserCost: 15, marginPct: 20 }],
      llmMarginPct: 10,
      notes: null,
      inForce: true,
      createdAtUtc: '',
      updatedAtUtc: null,
      publishedAtUtc: null,
      createdBy: null,
      publishedBy: null,
    } satisfies PriceBook;
    const f = formFrom(book, '2026-12-01');
    expect(f).toMatchObject({
      effectiveFrom: '2026-12-01',
      platformFeeMonthly: '300',
      feedPrices: 'cme-l2, 120, 15, 20',
      llmMarginPct: '10',
    });
    expect(priceBookBody(f).body?.feedPrices).toEqual(book.feedPrices);
  });
});

describe('exchange fees (engine WS8 8.5)', () => {
  it('parses, validates and round-trips exchange fee lines', async () => {
    const { parseExchangeFees, formatExchangeFees } = await import('./billing.logic');
    const ok = parseExchangeFees('CME-Group, 105, 3, 0, 10\n\nnasdaq, 76');
    expect(ok.errors).toEqual([]);
    expect(ok.fees[0]).toEqual({
      family: 'cme-group',
      professionalMonthly: 105,
      nonProfessionalMonthly: 3,
      nonDisplayMonthly: 0,
      marginPct: 10,
    });
    expect(formatExchangeFees(ok.fees)).toBe('cme-group, 105, 3, 0, 10\nnasdaq, 76, 0, 0, 0');
    expect(parseExchangeFees('crypto:binance, 1').errors).toHaveLength(1);
    expect(parseExchangeFees('ice, 1\nice, 2').errors).toHaveLength(1);
    expect(parseExchangeFees('eurex, -1').errors).toHaveLength(1);
  });
});
