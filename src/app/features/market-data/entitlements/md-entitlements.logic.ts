import type {
  EntitlementStatus,
  GrantDraft,
  GrantEntitlementBody,
  MarketDataEntitlementDto,
  UpdateEntitlementBody,
  UsageFeedRow,
  DeclarationQuestion,
  SubmitDeclarationBody,
} from './md-entitlements.types';

/** The fixed feeds, in the engine's order (`MdFeedCatalog.FixedFeeds`). */
export const FIXED_FEEDS = ['broker-ticks', 'broker-dom', 'cme-l2', 'cme-trades'] as const;

/** The exchange catalog's fixed feeds (engine WS8 8.1, `ExchangeFeedCatalog.FixedFeeds`). */
export const EXCHANGE_FEEDS = [
  'cme-l1',
  'ice-l1',
  'ice-l2',
  'ice-trades',
  'eurex-l1',
  'eurex-l2',
  'eurex-trades',
  'us-equities-nbbo',
] as const;

const PREFIXED =
  /^(?:venue|source|crypto):[a-z0-9](?:[a-z0-9._-]{0,46}[a-z0-9])?$|^us-equities-depth:[a-z0-9]{2,8}$/;

/** The engine's rule (`MdFeedCatalog.IsValidFeedId`) on a normalised id. */
export function isValidFeedId(feedId: string): boolean {
  return (
    (FIXED_FEEDS as readonly string[]).includes(feedId) ||
    (EXCHANGE_FEEDS as readonly string[]).includes(feedId) ||
    PREFIXED.test(feedId)
  );
}

/** Trimmed, lower-cased. */
export function normaliseFeed(feedId: string | null | undefined): string {
  return (feedId ?? '').trim().toLowerCase();
}

/** A plan feed entry may also be a wildcard. */
export function isValidPlanEntry(entry: string): boolean {
  return (
    entry === 'venue:*' ||
    entry === 'source:*' ||
    entry === 'crypto:*' ||
    entry === 'us-equities-depth:*' ||
    isValidFeedId(entry)
  );
}

/** The entries of a plan's market-data feed list the engine would refuse ('' / null = every feed). */
export function invalidPlanFeeds(raw: string | null | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  const bad = raw
    .split(/[,\s;]+/)
    .map(normaliseFeed)
    .filter((f) => f && !isValidPlanEntry(f));
  return [...new Set(bad)];
}

/** "Every feed" or the list, for a plan row. */
export function planFeedsText(raw: string | null | undefined): string {
  return raw && raw.trim() ? raw.split(',').join(', ') : 'Every feed';
}

/** A blank grant form. */
export function emptyGrantDraft(tenantId: number | null = null): GrantDraft {
  return {
    tenantId,
    feedId: '',
    display: true,
    nonDisplay: false,
    delayed: false,
    validFrom: '',
    validTo: '',
    reason: '',
  };
}

/** The edit form of an existing grant. */
export function draftFromEntitlement(e: MarketDataEntitlementDto): GrantDraft {
  return {
    tenantId: e.tenantId,
    feedId: e.feedId,
    display: e.display,
    nonDisplay: e.nonDisplay,
    delayed: e.delayed ?? false,
    validFrom: e.validFromUtc ? e.validFromUtc.slice(0, 10) : '',
    validTo: e.validToUtc ? e.validToUtc.slice(0, 10) : '',
    reason: e.reason ?? '',
  };
}

/** `yyyy-mm-dd` → midnight UTC ISO; '' → null. */
export function dayToUtc(day: string): string | null {
  const d = day.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00Z` : null;
}

/** Problems before sending (`creating` = a new grant, which needs an organisation and a feed). */
export function grantErrors(d: GrantDraft, creating: boolean): string[] {
  const errors: string[] = [];
  if (creating) {
    if (!d.tenantId || d.tenantId <= 0) errors.push('Choose an organisation.');
    if (!isValidFeedId(normaliseFeed(d.feedId)))
      errors.push(
        'Choose a feed: broker-ticks, broker-dom, cme-l1/l2/trades, ice-*, eurex-*, us-equities-nbbo, us-equities-depth:<venue>, venue:<id>, crypto:<exchange> or source:<id>.',
      );
  }
  if (!d.display && !d.nonDisplay)
    errors.push('A licence covers display use, non-display use or both — choose at least one.');
  const from = dayToUtc(d.validFrom);
  const to = dayToUtc(d.validTo);
  if (d.validFrom.trim() && !from) errors.push('The start is a date (yyyy-mm-dd).');
  if (d.validTo.trim() && !to) errors.push('The end is a date (yyyy-mm-dd).');
  if (from && to && to <= from) errors.push('The licence must end after it starts.');
  if (!d.reason.trim())
    errors.push('Say why (the contract, order form or trial this licence comes from).');
  else if (d.reason.trim().length > 512) errors.push('The reason is at most 512 characters.');
  return errors;
}

export function grantBody(d: GrantDraft): GrantEntitlementBody {
  return {
    tenantId: d.tenantId ?? 0,
    feedId: normaliseFeed(d.feedId),
    display: d.display,
    nonDisplay: d.nonDisplay,
    delayed: d.delayed,
    validFromUtc: dayToUtc(d.validFrom),
    validToUtc: dayToUtc(d.validTo),
    reason: d.reason.trim(),
  };
}

export function updateBody(d: GrantDraft): UpdateEntitlementBody {
  const { display, nonDisplay, delayed, validFromUtc, validToUtc, reason } = grantBody(d);
  return { display, nonDisplay, delayed, validFromUtc, validToUtc, reason };
}

/** "Display + non-display", "Display only", "Non-display only"; ", delayed 15 min" for a delayed-only licence. */
export function usagesText(
  e: Pick<MarketDataEntitlementDto, 'display' | 'nonDisplay' | 'delayed' | 'delayMinutes'>,
): string {
  const base =
    e.display && e.nonDisplay
      ? 'Display + non-display'
      : e.display
        ? 'Display only'
        : e.nonDisplay
          ? 'Non-display only'
          : 'None';
  return e.delayed ? `${base}, delayed ${e.delayMinutes ?? 15} min` : base;
}

/** "Professional", "Non-professional", "Undeclared (counted as professional)", "Non-display". */
export function subscriberTypeLabel(type: string): string {
  switch (type) {
    case 'professional':
    case 'Professional':
      return 'Professional';
    case 'nonProfessional':
    case 'NonProfessional':
      return 'Non-professional';
    case 'undeclared':
      return 'Undeclared (counted as professional)';
    case 'nonDisplay':
      return 'Non-display';
    default:
      return type;
  }
}

/**
 * The engine's classification (`SubscriberQuestionnaire.Classify`): non-professional only when every question is
 * answered and none is a professional answer; null while a question is unanswered.
 */
export function classifyAnswers(
  questions: readonly DeclarationQuestion[],
  answers: Readonly<Record<string, boolean | null | undefined>>,
  selfDeclaredProfessional: boolean,
): 'Professional' | 'NonProfessional' | null {
  let professional = selfDeclaredProfessional;
  for (const q of questions) {
    const a = answers[q.key];
    if (a === null || a === undefined) return null;
    if (a === q.professionalWhen) professional = true;
  }
  return professional ? 'Professional' : 'NonProfessional';
}

/** Problems before signing a declaration. */
export function declarationErrors(
  questions: readonly DeclarationQuestion[],
  draft: {
    answers: Record<string, boolean | null>;
    selfDeclaredProfessional: boolean;
    signedName: string;
    attest: boolean;
  },
): string[] {
  const errors: string[] = [];
  if (classifyAnswers(questions, draft.answers, draft.selfDeclaredProfessional) === null)
    errors.push('Answer every question.');
  const name = draft.signedName.trim();
  if (name.length < 2 || name.length > 200) errors.push('Type your full name as your signature.');
  if (!draft.attest) errors.push('Confirm that the answers are true.');
  return errors;
}

/** The body of `POST md/declarations` (answers must be complete — check `declarationErrors` first). */
export function declarationBody(
  family: string,
  questions: readonly DeclarationQuestion[],
  draft: {
    answers: Record<string, boolean | null>;
    selfDeclaredProfessional: boolean;
    signedName: string;
    attest: boolean;
  },
): SubmitDeclarationBody {
  const answers: Record<string, boolean> = {};
  for (const q of questions) answers[q.key] = draft.answers[q.key] === true;
  return {
    exchangeFamily: family,
    answers,
    selfDeclaredProfessional: draft.selfDeclaredProfessional,
    signedName: draft.signedName.trim(),
    attest: draft.attest,
  };
}

/** "Always", "From 2026-11-01", "Until 2027-01-01", "2026-11-01 → 2027-01-01". */
export function validityText(
  e: Pick<MarketDataEntitlementDto, 'validFromUtc' | 'validToUtc'>,
): string {
  const from = e.validFromUtc?.slice(0, 10);
  const to = e.validToUtc?.slice(0, 10);
  if (from && to) return `${from} → ${to}`;
  if (from) return `From ${from}`;
  if (to) return `Until ${to}`;
  return 'No end';
}

/** Chip tone of a status. */
export function statusTone(status: EntitlementStatus): 'ok' | 'info' | 'warn' | 'bad' {
  switch (status) {
    case 'Active':
      return 'ok';
    case 'Scheduled':
      return 'info';
    case 'Expired':
      return 'warn';
    default:
      return 'bad';
  }
}

/** The list filtered by a search over organisation and feed. */
export function filterEntitlements(
  rows: readonly MarketDataEntitlementDto[],
  search: string,
): MarketDataEntitlementDto[] {
  const q = search.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter((r) =>
    [r.tenantName, r.tenantSlug, r.feedId, r.feedName, String(r.tenantId)].some((v) =>
      v.toLowerCase().includes(q),
    ),
  );
}

/** "Display" / "Non-display". */
export function usageLabel(usage: string): string {
  return usage === 'nonDisplay' ? 'Non-display' : 'Display';
}

/** Exchange feeds first (what a declaration is about), then the broker feeds. */
export function declarationOrder(rows: readonly UsageFeedRow[]): UsageFeedRow[] {
  return [...rows].sort((a, b) => Number(b.exchangeFeed) - Number(a.exchangeFeed));
}
