import type { LlmProposalPineEnvelope } from '@core/api/api.types';

/** A proposal envelope that carries a Pine script. */
export type PineProposal = LlmProposalPineEnvelope & { script: string };

/**
 * Reads an LLM proposal's `proposalJson` as a Pine envelope
 * `{ name, description, symbol, timeframe, script }`. Keys may be camelCase or
 * PascalCase. Null for anything without a script — a legacy JSON-rules (DSL)
 * proposal or a malformed payload — which the page shows raw.
 */
export function parseProposalEnvelope(json: string | null | undefined): PineProposal | null {
  if (!json?.trim()) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const text = (k: string): string | null => {
    const v = o[k] ?? o[k.charAt(0).toUpperCase() + k.slice(1)];
    return typeof v === 'string' ? v : null;
  };
  const script = text('script');
  if (!script?.trim()) return null;
  return {
    name: text('name'),
    description: text('description'),
    symbol: text('symbol'),
    timeframe: text('timeframe'),
    script,
  };
}
