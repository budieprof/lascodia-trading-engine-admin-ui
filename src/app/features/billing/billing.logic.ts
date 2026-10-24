import type { FeedPrice, Invoice, PriceBook, PriceBookBody } from './billing.types';

/** "1,234.50 USD" — invariant two decimals with grouping. */
export function money(amount: number | null | undefined, currency: string): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return '—';
  return `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

/** Quantities: integers as is, otherwise up to 4 decimals. */
export function quantity(q: number): string {
  return Number.isInteger(q) ? String(q) : q.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

/** The current UTC month as YYYY-MM. */
export function currentMonth(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The last `count` UTC months, newest first (YYYY-MM). */
export function recentMonths(count: number, now: Date = new Date()): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/** The previous (finished) UTC month — the one invoices are drafted for. */
export function previousMonth(now: Date = new Date()): string {
  return recentMonths(2, now)[1];
}

/** "2026-10" → "October 2026". */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  if (!y || !m) return month;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** "2026-10-03T00:00:00Z" → "3 Oct". */
export function dayLabel(dayUtc: string): string {
  const d = new Date(dayUtc);
  return Number.isNaN(d.getTime())
    ? dayUtc
    : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export type Tone = 'ok' | 'warn' | 'bad' | 'muted';

/** Chip tone of an invoice status. */
export function statusTone(status: Invoice['status']): Tone {
  return status === 'Finalised' ? 'ok' : status === 'Void' ? 'bad' : 'warn';
}

/** Chip tone of a payment status. */
export function paymentTone(status: Invoice['paymentStatus']): Tone {
  return status === 'Paid'
    ? 'ok'
    : status === 'Failed'
      ? 'bad'
      : status === 'Submitted'
        ? 'warn'
        : 'muted';
}

/** "Not submitted" etc. */
export function paymentLabel(status: Invoice['paymentStatus']): string {
  return status === 'NotSubmitted' ? 'Not submitted' : status;
}

/** Which actions staff can take on an invoice. */
export function invoiceActions(invoice: Invoice): {
  finalise: boolean;
  void: boolean;
  collect: boolean;
  refresh: boolean;
} {
  const final = invoice.status === 'Finalised';
  return {
    finalise: invoice.status === 'Draft',
    void: invoice.status !== 'Void' && invoice.paymentStatus !== 'Paid',
    collect:
      final &&
      (invoice.paymentStatus === 'NotSubmitted' || invoice.paymentStatus === 'Failed') &&
      invoice.total > 0,
    refresh: final && invoice.paymentReference !== null,
  };
}

/** Totals across invoices, per currency ("1,200.00 USD · 300.00 EUR"). */
export function totalsByCurrency(invoices: readonly Invoice[]): string {
  const sums = new Map<string, number>();
  for (const i of invoices)
    if (i.status !== 'Void') sums.set(i.currency, (sums.get(i.currency) ?? 0) + i.total);
  if (sums.size === 0) return '—';
  return [...sums.entries()].map(([c, v]) => money(v, c)).join(' · ');
}

// ── Price-book form ────────────────────────────────────────────────────────

/** The editor's state: numbers as entered (strings), so a half-typed value is not coerced. */
export interface PriceBookForm {
  planId: number | null;
  currency: string;
  effectiveFrom: string; // YYYY-MM-DD
  platformFeeMonthly: string;
  perTerminalMonthly: string;
  includedTerminals: string;
  perUserMonthly: string;
  includedUsers: string;
  propModuleMonthly: string;
  brokerModuleMonthly: string;
  fundModuleMonthly: string;
  /** One line per feed: `feedId, monthly cost, per display user, margin %`. */
  feedPrices: string;
  /** Blank = LLM spend is not invoiced. */
  llmMarginPct: string;
  notes: string;
}

export function emptyPriceBookForm(planId: number | null, today: Date = new Date()): PriceBookForm {
  const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
  return {
    planId,
    currency: 'USD',
    effectiveFrom: first.toISOString().slice(0, 10),
    platformFeeMonthly: '0',
    perTerminalMonthly: '0',
    includedTerminals: '0',
    perUserMonthly: '0',
    includedUsers: '0',
    propModuleMonthly: '0',
    brokerModuleMonthly: '0',
    fundModuleMonthly: '0',
    feedPrices: '',
    llmMarginPct: '',
    notes: '',
  };
}

/** A form from an existing version (editing a draft, or starting the next version from it). */
export function formFrom(book: PriceBook, effectiveFrom?: string): PriceBookForm {
  return {
    planId: book.planId,
    currency: book.currency,
    effectiveFrom: effectiveFrom ?? book.effectiveFromUtc.slice(0, 10),
    platformFeeMonthly: String(book.platformFeeMonthly),
    perTerminalMonthly: String(book.perTerminalMonthly),
    includedTerminals: String(book.includedTerminals),
    perUserMonthly: String(book.perUserMonthly),
    includedUsers: String(book.includedUsers),
    propModuleMonthly: String(book.propModuleMonthly),
    brokerModuleMonthly: String(book.brokerModuleMonthly),
    fundModuleMonthly: String(book.fundModuleMonthly),
    feedPrices: formatFeedPrices(book.feedPrices),
    llmMarginPct: book.llmMarginPct === null ? '' : String(book.llmMarginPct),
    notes: book.notes ?? '',
  };
}

export function formatFeedPrices(prices: readonly FeedPrice[]): string {
  return prices
    .map((p) => `${p.feedId}, ${p.monthlyCost}, ${p.perDisplayUserCost}, ${p.marginPct}`)
    .join('\n');
}

const FEED_ID =
  /^(broker-ticks|broker-dom|cme-l2|cme-trades|venue:[a-z0-9][a-z0-9._-]*|source:[a-z0-9][a-z0-9._:-]*)$/;

/** Parses the feed lines; errors name the line. */
export function parseFeedPrices(text: string): { prices: FeedPrice[]; errors: string[] } {
  const prices: FeedPrice[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  text
    .split('\n')
    .map((l) => l.trim())
    .forEach((line, i) => {
      if (!line) return;
      const parts = line.split(',').map((p) => p.trim());
      const id = (parts[0] ?? '').toLowerCase();
      const [monthly, perUser, margin] = [parts[1], parts[2], parts[3]].map((p) =>
        p === undefined || p === '' ? 0 : Number(p),
      );
      if (!FEED_ID.test(id)) errors.push(`Feed line ${i + 1}: '${parts[0]}' is not a feed id.`);
      else if (seen.has(id)) errors.push(`Feed line ${i + 1}: '${id}' is listed twice.`);
      if ([monthly, perUser, margin].some((n) => !Number.isFinite(n) || n < 0))
        errors.push(`Feed line ${i + 1}: costs and margin must be numbers ≥ 0.`);
      seen.add(id);
      prices.push({
        feedId: id,
        monthlyCost: monthly,
        perDisplayUserCost: perUser,
        marginPct: margin,
      });
    });
  return { prices, errors };
}

/** The request body, or the problems that stop it (mirrors the engine's checks). */
export function priceBookBody(form: PriceBookForm): {
  body: PriceBookBody | null;
  errors: string[];
} {
  const errors: string[] = [];
  const num = (label: string, value: string, integer = false): number => {
    const n = Number(value);
    if (value.trim() === '' || !Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) {
      errors.push(`${label} must be ${integer ? 'a whole number' : 'a number'} ≥ 0.`);
      return 0;
    }
    return n;
  };
  const currency = form.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) errors.push('Currency is a three-letter code (USD, EUR, GBP).');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.effectiveFrom))
    errors.push('Choose the first day the prices apply.');
  if (form.planId === null) errors.push('Choose the plan.');
  const feeds = parseFeedPrices(form.feedPrices);
  errors.push(...feeds.errors);
  let llm: number | null = null;
  if (form.llmMarginPct.trim() !== '') llm = num('LLM margin', form.llmMarginPct);
  const body: PriceBookBody = {
    planId: form.planId ?? undefined,
    currency,
    effectiveFromUtc: `${form.effectiveFrom}T00:00:00Z`,
    platformFeeMonthly: num('Platform fee', form.platformFeeMonthly),
    perTerminalMonthly: num('Per-terminal fee', form.perTerminalMonthly),
    includedTerminals: num('Included terminals', form.includedTerminals, true),
    perUserMonthly: num('Per-user fee', form.perUserMonthly),
    includedUsers: num('Included users', form.includedUsers, true),
    propModuleMonthly: num('Prop module', form.propModuleMonthly),
    brokerModuleMonthly: num('Broker module', form.brokerModuleMonthly),
    fundModuleMonthly: num('Fund module', form.fundModuleMonthly),
    feedPrices: feeds.prices,
    llmMarginPct: llm,
    notes: form.notes.trim() || null,
  };
  return errors.length ? { body: null, errors } : { body, errors };
}
