import { isForbidden, isMissingEndpoint } from './organisation.logic';
import type { Tone } from './terminals.logic';

// LLM usage & key (T7.6; engine r6-llm: GET /llm/usage, GET|PUT|DELETE /llm/tenant-key). The page is
// built against r6-llm's contract and checks the engine itself: an engine without these endpoints
// answers a plain 404 and the page says "not available yet" rather than showing an error.

/** Providers an organisation may store its own key for (engine `TenantLlmKeyRules`). */
export const LLM_KEY_PROVIDERS: readonly { id: string; label: string }[] = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'google', label: 'Google' },
  { id: 'deepseek', label: 'DeepSeek' },
];

export const KEY_MIN = 20;
export const KEY_MAX = 512;

/** Whether a section's endpoint answered, and if not, why — in words for the page. */
export type Availability = 'ok' | 'missing' | 'forbidden' | 'error';

export function availabilityOf(err: unknown): Availability {
  if (isMissingEndpoint(err)) return 'missing';
  if (isForbidden(err)) return 'forbidden';
  return 'error';
}

export function providerLabel(id: string): string {
  return LLM_KEY_PROVIDERS.find((p) => p.id === id.toLowerCase())?.label ?? id;
}

export function paidByLabel(paidBy: string): string {
  switch (paidBy) {
    case 'Platform':
      return 'The platform pays';
    case 'OwnKey':
      return "The organisation's own key";
    case 'Unknown':
      return 'Not recorded';
    default:
      return paidBy;
  }
}

/** "$1.23"; a few hundredths of a cent stay visible ("$0.0042") rather than reading as "$0.00". */
export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const digits = abs > 0 && abs < 0.01 ? 4 : 2;
  return `${n < 0 ? '-' : ''}$${abs.toFixed(digits)}`;
}

/** "950", "12.3k", "4.5M". */
export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export interface BudgetLine {
  /** "$3.20 of $50.00" or "$3.20 (no cap)". */
  text: string;
  /** Share of the point where calls stop (0–100), null without a cap. */
  percent: number | null;
  /** Where calls stop: cap × threshold. */
  stopsAt: number | null;
  tone: Tone;
}

/** Spend against a cap, judged against where calls actually stop (cap × threshold fraction). */
export function budgetLine(
  spent: number,
  cap: number | null,
  thresholdFraction: number,
): BudgetLine {
  if (cap === null || cap <= 0)
    return { text: `${usd(spent)} (no cap)`, percent: null, stopsAt: null, tone: '' };
  const fraction = thresholdFraction > 0 && thresholdFraction <= 1 ? thresholdFraction : 1;
  const stopsAt = cap * fraction;
  const percent = Math.min(100, Math.round((spent / stopsAt) * 100));
  return {
    text: `${usd(spent)} of ${usd(cap)}`,
    percent,
    stopsAt,
    tone: percent >= 100 ? 'bad' : percent >= 80 ? 'warn' : 'ok',
  };
}

/** Why a key cannot be stored, or null (mirrors the engine; never echoes the key). */
export function keyProblem(provider: string, apiKey: string): string | null {
  if (!LLM_KEY_PROVIDERS.some((p) => p.id === provider)) {
    return 'Choose the provider: Anthropic, OpenAI, Google or DeepSeek.';
  }
  const key = apiKey.trim();
  if (key.length < KEY_MIN || key.length > KEY_MAX) {
    return `An API key is ${KEY_MIN}–${KEY_MAX} characters. Paste the whole key your provider issued.`;
  }
  // Printable ASCII only, no spaces (what the engine accepts).
  if (!/^[!-~]+$/.test(key)) {
    return 'An API key has no spaces, line breaks or non-ASCII characters. Paste only the key.';
  }
  return null;
}
