import { defaultRules, newPhase } from './prop.logic';
import type { PropPhaseRules, PropProgramRules } from './prop.types';

/**
 * Starting points for a new prop program (multi-asset WS7 7.8). Rules stay percentages of the account and day /
 * drawdown references exactly as the engine evaluates them; the SIZE rules (`maxLotsPerPosition`,
 * `maxTotalOpenLots`) are judged by the engine per quantity unit (risk-models: lots, contracts, shares and coins are
 * never summed together) — so a futures preset's "5" means five contracts. The FX preset is exactly the editor's
 * existing default (unchanged). Every number is a starting point the firm edits, not a quote of any firm's rules.
 */
export type PropPresetId = 'fx-two-step' | 'futures-one-step' | 'crypto-two-step';

export interface PropPreset {
  id: PropPresetId;
  label: string;
  /** The quantity unit the size rules are read in. */
  unit: 'lots' | 'contracts' | 'coins';
  description: string;
  rules: () => PropProgramRules;
}

function phase(base: PropPhaseRules, patch: Partial<PropPhaseRules>): PropPhaseRules {
  return { ...base, ...patch, weekend: { ...base.weekend, ...(patch.weekend ?? {}) } };
}

/** CME futures, one step: 6 % target, 2 % daily loss, 4 % trailing drawdown locking at the start balance, contracts. */
function futuresOneStep(): PropProgramRules {
  const futuresWeekend = { startDay: 'Friday' as const, startTime: '16:00', endDay: 'Sunday' as const, endTime: '17:00' };
  const evaluation = phase(newPhase('Evaluation'), {
    profitTargetPct: 6,
    maxDailyLossPct: 2,
    dailyLossReference: 'StartOfDayBalance',
    dailyLossAmountOf: 'InitialBalance',
    maxOverallDrawdownPct: 4,
    drawdownMode: 'Trailing',
    trailingBasis: 'Equity',
    trailingLocksAtInitialBalance: true,
    minTradingDays: 5,
    maxLotsPerPosition: 5,
    maxTotalOpenLots: 5,
    lotsAction: 'Fail',
    newsTradingAllowed: true,
    weekendHoldingAllowed: false,
    weekend: futuresWeekend,
    weekendAction: 'Fail',
    consistencyMaxBestDayPct: 50,
    timeLimitDays: null,
  });
  const funded = phase(newPhase('Funded'), {
    maxDailyLossPct: 2,
    maxOverallDrawdownPct: 4,
    drawdownMode: 'Trailing',
    trailingBasis: 'Equity',
    trailingLocksAtInitialBalance: true,
    maxLotsPerPosition: 5,
    maxTotalOpenLots: 5,
    weekendHoldingAllowed: false,
    weekend: futuresWeekend,
  });
  return {
    phases: [evaluation, funded],
    // The CME trading day rolls at 17:00 Chicago.
    tradingDay: { resetTime: '17:00', timeZone: 'America/Chicago' },
    profitSplit: { traderSharePct: 90 },
    haltOnBreach: true,
    haltOnPass: false,
  };
}

/** Crypto perpetuals, two steps: 24/7 (weekend holding allowed), UTC day, size rules in coins left to the firm. */
function cryptoTwoStep(): PropProgramRules {
  const common: Partial<PropPhaseRules> = {
    maxDailyLossPct: 4,
    dailyLossReference: 'HigherOfBalanceAndEquity',
    maxOverallDrawdownPct: 8,
    drawdownMode: 'Static',
    weekendHoldingAllowed: true,
    newsTradingAllowed: true,
    // Coins differ per market (1 BTC ≠ 1 ETH): no default size cap — set one per program.
    maxLotsPerPosition: null,
    maxTotalOpenLots: null,
  };
  return {
    phases: [
      phase(newPhase('Evaluation'), { ...common, profitTargetPct: 8, minTradingDays: 5, timeLimitDays: 30 }),
      phase(newPhase('Verification'), { ...common, profitTargetPct: 5, minTradingDays: 5, timeLimitDays: 60 }),
      phase(newPhase('Funded'), { ...common }),
    ],
    tradingDay: { resetTime: '00:00', timeZone: 'UTC' },
    profitSplit: { traderSharePct: 80 },
    haltOnBreach: true,
    haltOnPass: false,
  };
}

export const PROP_PRESETS: readonly PropPreset[] = [
  {
    id: 'fx-two-step',
    label: 'FX two-step (lots)',
    unit: 'lots',
    description: 'Evaluation 10 %, verification 5 %, funded 80/20, New York 17:00 day — the usual FX challenge.',
    rules: defaultRules,
  },
  {
    id: 'futures-one-step',
    label: 'Futures one-step (contracts)',
    unit: 'contracts',
    description:
      'CME day (17:00 Chicago), 6 % target, 2 % daily loss, 4 % trailing drawdown locking at the start balance, 5 contracts, no weekend holding, 50 % consistency, 90/10.',
    rules: futuresOneStep,
  },
  {
    id: 'crypto-two-step',
    label: 'Crypto two-step (coins)',
    unit: 'coins',
    description:
      '24/7 UTC day, 8 % then 5 % targets, 4 % daily loss on the higher of balance and equity, 8 % static drawdown, weekends allowed; size caps per market are left to the firm.',
    rules: cryptoTwoStep,
  },
];

export function presetById(id: string | null | undefined): PropPreset {
  return PROP_PRESETS.find((p) => p.id === id) ?? PROP_PRESETS[0];
}

/** The size-rule labels in the preset's unit (the FX wording is the editor's existing text). */
export function sizeLabels(unit: PropPreset['unit']): { perPosition: string; total: string } {
  return unit === 'lots'
    ? { perPosition: 'Max lots per position', total: 'Max total open lots' }
    : { perPosition: `Max ${unit} per position`, total: `Max total open ${unit}` };
}
