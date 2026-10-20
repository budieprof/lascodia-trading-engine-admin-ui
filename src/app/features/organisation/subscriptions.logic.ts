import type {
  AccountRef,
  StrategyBinding,
  StrategyBindingInput,
  StrategySubscription,
} from './organisation.types';
import { accountLabel } from './terminals.logic';

// Strategy subscriptions (T7.4, engine R6R.4 opt-in signals): which of the organisation's accounts
// receive which strategies' signals. A subscription is a binding the organisation owns; the engine
// replaces the organisation's own set for one strategy at a time.

/** Upper bound the engine validates (`StrategyAccountRouting.MaxLotMultiplier`). */
export const MAX_LOT_MULTIPLIER = 10;

/** One strategy with the organisation's accounts subscribed to it. */
export interface SubscribedStrategy {
  strategyId: number;
  name: string;
  symbol: string;
  timeframe: string;
  status: string;
  isPlatform: boolean;
  isScript: boolean;
  accounts: StrategySubscription[];
}

/** The subscriptions grouped by strategy, in the engine's order (strategy name, then account). */
export function groupSubscriptions(subs: readonly StrategySubscription[]): SubscribedStrategy[] {
  const out = new Map<number, SubscribedStrategy>();
  for (const s of subs) {
    let g = out.get(s.strategyId);
    if (!g) {
      g = {
        strategyId: s.strategyId,
        name: s.strategyName,
        symbol: s.symbol,
        timeframe: s.timeframe,
        status: s.strategyStatus,
        isPlatform: s.isPlatform,
        isScript: s.isScript,
        accounts: [],
      };
      out.set(s.strategyId, g);
    }
    g.accounts.push(s);
  }
  return [...out.values()];
}

/** How the organisation's accounts receive signals, in words. */
export function subscriptionRule(requireSubscription: boolean): string {
  return requireSubscription
    ? "An account receives a strategy's signals only when it is subscribed to it here."
    : 'A strategy nobody here is subscribed to reaches every account of the organisation whose EA streams its symbol. Subscribing accounts to a strategy restricts it to those accounts.';
}

/** One account's row in the subscription editor. */
export interface BindingDraft {
  account: AccountRef;
  subscribed: boolean;
  /** As typed. */
  lotMultiplier: string;
  /** False = keep the subscription but pause delivery to this account. */
  isEnabled: boolean;
}

/** Every account of the organisation, with its current subscription to the strategy (if any). */
export function draftFrom(
  accounts: readonly AccountRef[],
  current: readonly StrategyBinding[],
): BindingDraft[] {
  const byId = new Map(current.map((b) => [b.tradingAccountId, b]));
  const rows = accounts.map((account) => {
    const b = byId.get(account.id);
    return {
      account,
      subscribed: !!b,
      lotMultiplier: String(b?.lotMultiplier ?? 1),
      isEnabled: b?.isEnabled ?? true,
    };
  });
  // A subscription of an account the console does not list (it cannot be re-sent without it).
  for (const b of current) {
    if (!accounts.some((a) => a.id === b.tradingAccountId)) {
      rows.push({
        account: {
          id: b.tradingAccountId,
          login: null,
          name: b.accountName || null,
          brokerServer: null,
          accountType: '',
          isPaper: false,
        },
        subscribed: true,
        lotMultiplier: String(b.lotMultiplier),
        isEnabled: b.isEnabled,
      });
    }
  }
  return rows;
}

export function draftErrors(drafts: readonly BindingDraft[]): string[] {
  const errors: string[] = [];
  for (const d of drafts) {
    if (!d.subscribed) continue;
    const m = Number(d.lotMultiplier.trim());
    if (!d.lotMultiplier.trim() || !Number.isFinite(m) || m <= 0 || m > MAX_LOT_MULTIPLIER) {
      errors.push(
        `${accountLabel(d.account)}: the lot multiplier is a number above 0 and at most ${MAX_LOT_MULTIPLIER}.`,
      );
    }
  }
  return errors;
}

/** The organisation's complete new set for the strategy (subscribed rows only). */
export function draftToInputs(drafts: readonly BindingDraft[]): StrategyBindingInput[] {
  return drafts
    .filter((d) => d.subscribed)
    .map((d) => ({
      tradingAccountId: d.account.id,
      lotMultiplier: Number(d.lotMultiplier.trim()),
      isEnabled: d.isEnabled,
    }));
}

export interface SubscriptionChange {
  added: AccountRef[];
  removed: AccountRef[];
  changed: AccountRef[];
  /** Real-money accounts the change touches. */
  realAccounts: AccountRef[];
  none: boolean;
}

/** What saving would change, account by account. */
export function changeSummary(
  current: readonly StrategyBinding[],
  drafts: readonly BindingDraft[],
): SubscriptionChange {
  const before = new Map(current.map((b) => [b.tradingAccountId, b]));
  const added: AccountRef[] = [];
  const removed: AccountRef[] = [];
  const changed: AccountRef[] = [];
  for (const d of drafts) {
    const b = before.get(d.account.id);
    if (d.subscribed && !b) added.push(d.account);
    else if (!d.subscribed && b) removed.push(d.account);
    else if (
      d.subscribed &&
      b &&
      (Number(d.lotMultiplier) !== b.lotMultiplier || d.isEnabled !== b.isEnabled)
    ) {
      changed.push(d.account);
    }
  }
  const touched = [...added, ...removed, ...changed];
  return {
    added,
    removed,
    changed,
    realAccounts: touched.filter((a) => a.accountType === 'Real' && !a.isPaper),
    none: touched.length === 0,
  };
}

/**
 * What the change does to who receives the strategy beyond the accounts listed — House's open
 * fan-out appears or disappears, or nobody receives it any more. Null when nothing like that changes.
 */
export function reachWarning(
  requireSubscription: boolean,
  strategy: { isScript: boolean; symbol: string },
  beforeCount: number,
  afterCount: number,
): string | null {
  if (!requireSubscription && !strategy.isScript) {
    if (beforeCount === 0 && afterCount > 0) {
      return `Today this strategy reaches every account of the organisation whose EA streams ${strategy.symbol}. After this it reaches only the subscribed accounts.`;
    }
    if (beforeCount > 0 && afterCount === 0) {
      return `With no subscription left it reaches every account of the organisation whose EA streams ${strategy.symbol} again.`;
    }
    return null;
  }
  if (beforeCount > 0 && afterCount === 0) {
    return strategy.isScript
      ? 'A script strategy with no subscription trades on no account at all.'
      : 'No account of the organisation will receive its signals any more.';
  }
  return null;
}
