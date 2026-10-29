import type { CmeContractDto } from './cme-microstructure.types';

const DAY_MS = 86_400_000;
/** Contracts expiring inside this window around today stay visible even with nothing ingested. */
const PAST_DAYS = 14;
const FUTURE_DAYS = 200;

export interface ContractSplit {
  /** Contracts with data, the front month, and the ones expiring near today. */
  shown: CmeContractDto[];
  /** Expired contracts with nothing ingested. */
  hiddenPast: number;
  /** Far-dated contracts with nothing ingested. */
  hiddenFuture: number;
  /** Contracts with hot- or warm-tier data. */
  withData: number;
}

/**
 * The contract calendar without its long tail of "nothing ingested" rows (pages program): a seeded calendar holds every
 * quarter of seven roots — ~100 rows — while only the current quarter and the ones with data say anything.
 */
export function splitContracts(
  contracts: readonly CmeContractDto[],
  warmTier: ReadonlySet<string>,
  nowMs: number,
): ContractSplit {
  const shown: CmeContractDto[] = [];
  let hiddenPast = 0;
  let hiddenFuture = 0;
  let withData = 0;
  for (const c of contracts) {
    const data = !!c.lastTradeEventTimestamp || warmTier.has(c.contractCode);
    if (data) withData++;
    const expiry = Date.parse(c.expiryDate);
    const near = expiry >= nowMs - PAST_DAYS * DAY_MS && expiry <= nowMs + FUTURE_DAYS * DAY_MS;
    if (data || c.isFrontMonth || near) shown.push(c);
    else if (expiry < nowMs) hiddenPast++;
    else hiddenFuture++;
  }
  return { shown, hiddenPast, hiddenFuture, withData };
}
