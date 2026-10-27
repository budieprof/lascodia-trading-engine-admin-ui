import type { ResponseData } from '@core/api/api.types';
import type {
  ExecutionAccount,
  VenueTicketPreview,
  VenueTicketResult,
  VenueTicketSendRequest,
} from '@features/venues/venues.types';

import { previewRequestOf, type VenueTicketState } from './venue-ticket-model';

/**
 * Sending the exchange-traded ticket (multi-asset ticket-send; engine `POST trade-signal/venue-ticket`, exec-polish item
 * 5) as pure decisions. The engine judges everything again — these rules only disable the button early, in the engine's
 * own words, so a refusal is never the first thing the operator learns. FX / CFD tickets never reach this module.
 */

/** The adapter kind of an MT5-EA execution account (engine `ExecutionAdapterKinds.Mt5Ea`): never a venue route. */
export const MT5_ADAPTER_KIND = 'mt5-ea';

/** The three switches a venue ticket needs (engine `SubmitVenueTicketCommandHandler` step 1). */
export const VENUE_TICKET_SWITCHES = [
  'Execution:Router:Enabled',
  'Execution:Entries:Enabled',
  'Risk:MultiAsset:Enabled',
] as const;

/** The engine's refusal when a switch is off — word for word. */
export const SWITCHED_OFF_MESSAGE =
  'Venue tickets are switched off: they need Execution:Router:Enabled, Execution:Entries:Enabled and Risk:MultiAsset:Enabled.';

/** A venue execution account: not MT5, linked to an engine trading account. */
export function isVenueRoute(a: ExecutionAccount): boolean {
  return a.adapterKind.trim().toLowerCase() !== MT5_ADAPTER_KIND && a.tradingAccountId !== null;
}

/** The engine's bool parse (`bool.TryParse` of the trimmed value; a missing row is off). */
export function switchOn(value: string | null | undefined): boolean {
  return (value ?? '').trim().toLowerCase() === 'true';
}

/** The trading accounts that have at least one venue execution account, in first-seen order. */
export function venueTradingAccountIds(accounts: readonly ExecutionAccount[]): number[] {
  const ids: number[] = [];
  for (const a of accounts)
    if (isVenueRoute(a) && !ids.includes(a.tradingAccountId!)) ids.push(a.tradingAccountId!);
  return ids;
}

/** The venue execution accounts of one trading account (null = none chosen → none offered). */
export function venueAccountsOf(
  accounts: readonly ExecutionAccount[],
  tradingAccountId: number | null,
): ExecutionAccount[] {
  if (tradingAccountId === null) return [];
  return accounts.filter((a) => isVenueRoute(a) && a.tradingAccountId === tradingAccountId);
}

/**
 * The trading account the ticket starts on: the console's scope selection when it has venue accounts, else the only
 * trading account that has any, else none (the operator picks).
 */
export function defaultTradingAccount(
  accounts: readonly ExecutionAccount[],
  scopeSelectedId: number | null,
): number | null {
  const ids = venueTradingAccountIds(accounts);
  if (scopeSelectedId !== null && ids.includes(scopeSelectedId)) return scopeSelectedId;
  return ids.length === 1 ? ids[0] : null;
}

/** The execution account the ticket starts on: the only Active venue account of the trading account, else none. */
export function defaultExecutionAccount(
  accounts: readonly ExecutionAccount[],
  tradingAccountId: number | null,
): number | null {
  const active = venueAccountsOf(accounts, tradingAccountId).filter((a) => a.status === 'Active');
  return active.length === 1 ? active[0].id : null;
}

/**
 * Which of the three switches are known to be off. `switches` = `execution-console/health` (null = not read: then the
 * Execution switches are unknown and only the engine says); `multiAssetRisk` = the preview's `multiAssetRiskEnabled`
 * (null = no preview yet).
 */
export function switchesOff(
  switches: Record<string, string> | null,
  multiAssetRisk: boolean | null,
): string[] {
  const off: string[] = [];
  if (switches) {
    if (!switchOn(switches['Execution:Router:Enabled'])) off.push('Execution:Router:Enabled');
    if (!switchOn(switches['Execution:Entries:Enabled'])) off.push('Execution:Entries:Enabled');
  }
  if (multiAssetRisk === false) off.push('Risk:MultiAsset:Enabled');
  return off;
}

export interface SendGateInput {
  canSend: boolean;
  off: readonly string[];
  account: ExecutionAccount | null;
  problems: readonly string[];
  preview: VenueTicketPreview | null;
  loading: boolean;
  submitting: boolean;
}

/** Why the Send button is disabled (null = it may be pressed); the first reason wins, worded as the engine words it. */
export function sendBlockedReason(g: SendGateInput): string | null {
  if (!g.canSend) return 'Sending a venue ticket needs the access.trader permission.';
  if (g.off.length > 0) return `${SWITCHED_OFF_MESSAGE} Off: ${g.off.join(', ')}.`;
  if (!g.account) return 'Choose a venue execution account.';
  if (g.account.status !== 'Active')
    return `Execution account ${g.account.id} is ${g.account.status}: activate and verify it first.`;
  if (g.problems.length > 0) return g.problems[0];
  if (g.submitting) return 'Sending…';
  if (!g.preview)
    return g.loading
      ? 'Waiting for the engine to check the ticket.'
      : 'The engine has not checked this ticket yet.';
  if (!g.preview.valid) {
    const failed = g.preview.checks.filter((c) => c.blocking && !c.ok).map((c) => c.message);
    return failed.length > 0 ? failed.join(' ') : 'The engine judged the ticket invalid.';
  }
  if (!(g.preview.referencePrice !== null && g.preview.referencePrice > 0))
    return 'The ticket has no price to be valued at.';
  return null;
}

/** The send body: the preview request with the execution account required (null when none is chosen). */
export function sendRequestOf(symbol: string, s: VenueTicketState): VenueTicketSendRequest | null {
  if (s.executionAccountId === null || !(s.executionAccountId > 0)) return null;
  const p = previewRequestOf(symbol, s);
  return {
    executionAccountId: s.executionAccountId,
    symbol: p.symbol,
    side: p.side,
    orderType: p.orderType,
    quantity: p.quantity,
    price: p.price,
    stopPrice: p.stopPrice,
    timeInForce: p.timeInForce,
    postOnly: p.postOnly,
    reduceOnly: p.reduceOnly,
    leverage: p.leverage,
    marginMode: p.marginMode,
    stopLossTicks: p.stopLossTicks,
    takeProfitTicks: p.takeProfitTicks,
  };
}

export type SendOutcome =
  | {
      kind: 'placed';
      message: string;
      tradeSignalId: number | null;
      preview: VenueTicketPreview | null;
    }
  | { kind: 'approval'; message: string; approvalId: string | null }
  | { kind: 'refused'; message: string; code: string | null; preview: VenueTicketPreview | null };

/** The engine's answer, read from the envelope (never the transport alone). */
export function sendOutcome(res: ResponseData<VenueTicketResult> | null | undefined): SendOutcome {
  if (res?.responseCode === '-202-approval') {
    const d = res.data as unknown as { approvalId?: number | string } | null;
    const id = d?.approvalId ?? null;
    return {
      kind: 'approval',
      approvalId: id === null ? null : String(id),
      message: `Sent for approval${id === null ? '' : ` (request #${id})`}: the ticket waits for a second authorised person, and the engine judges it again when it is approved.`,
    };
  }
  if (res?.status === true && res.data?.placed) {
    return {
      kind: 'placed',
      message: res.data.message || res.message || 'Venue ticket sent.',
      tradeSignalId: res.data.tradeSignalId ?? null,
      preview: res.data.preview ?? null,
    };
  }
  return {
    kind: 'refused',
    message: res?.data?.message || res?.message || 'The ticket was refused.',
    code: res?.responseCode ?? null,
    preview: res?.data?.preview ?? null,
  };
}

export interface ConfirmLine {
  label: string;
  value: string;
}

function num(v: number | null | undefined, digits = 2): string {
  return v === null || v === undefined || !Number.isFinite(v)
    ? '—'
    : v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

/** What the confirm step shows: the order exactly as it will be sent, valued by the engine's last dry run. */
export function confirmLines(
  symbol: string,
  unit: string,
  s: VenueTicketState,
  pv: VenueTicketPreview,
  account: ExecutionAccount,
): ConfirmLine[] {
  const d = Math.max(0, pv.priceDecimals);
  const lines: ConfirmLine[] = [
    { label: 'Order', value: `${s.side} ${num(s.quantity, 8)} ${unit} ${symbol}` },
    {
      label: 'Type',
      value: `${s.orderType === 'StopLimit' ? 'Stop limit' : s.orderType} · ${s.tif.toUpperCase()}`,
    },
  ];
  if (s.orderType === 'Limit' || s.orderType === 'StopLimit')
    lines.push({ label: 'Limit', value: num(s.price, d) });
  if (s.orderType === 'Stop' || s.orderType === 'StopLimit')
    lines.push({ label: 'Trigger', value: num(s.stopPrice, d) });
  const flags = [s.postOnly ? 'post-only' : null, s.reduceOnly ? 'reduce-only' : null].filter(
    Boolean,
  );
  if (flags.length) lines.push({ label: 'Flags', value: flags.join(', ') });
  lines.push({
    label: 'Stop / target',
    value: `${pv.stopLossPrice === null ? 'none' : `${num(pv.stopLossPrice, d)} (${s.stopLossTicks} ticks)`} / ${
      pv.takeProfitPrice === null
        ? 'none'
        : `${num(pv.takeProfitPrice, d)} (${s.takeProfitTicks} ticks)`
    }`,
  });
  lines.push({
    label: 'Reference',
    value: `${num(pv.referencePrice, d)} (${pv.referencePriceSource})`,
  });
  lines.push({
    label: 'Notional',
    value:
      pv.notionalAccount !== null
        ? `${num(pv.notionalAccount)} ${pv.accountCurrency}`
        : `${num(pv.notionalQuote)} ${pv.quoteCurrency}`,
  });
  if (pv.margin && !pv.margin.refusal)
    lines.push({
      label: 'Margin',
      value: `${num(pv.margin.initialMargin)} initial ${pv.accountCurrency}`,
    });
  if (pv.riskMoney !== null)
    lines.push({
      label: 'Risk at stop',
      value: `${num(pv.riskMoney)} ${pv.accountCurrency}${pv.riskPctOfEquity !== null ? ` (${num(pv.riskPctOfEquity)} % of equity)` : ''}`,
    });
  if (pv.feeEstimate !== null) lines.push({ label: 'Fees', value: num(pv.feeEstimate, 4) });
  lines.push({
    label: 'Account',
    value: `${account.name} · ${account.venue} · ${account.mode} (#${account.id})`,
  });
  return lines;
}

/** The four-eyes notice of the confirm step (the policy is the organisation's `ManualLiveOrder` threshold). */
export function fourEyesNotice(pv: VenueTicketPreview): string {
  const n =
    pv.notionalAccount !== null ? ` (${num(pv.notionalAccount)} ${pv.accountCurrency})` : '';
  return (
    `Four-eyes: if your organisation's approval policy for manual live orders covers this notional${n}, the engine holds ` +
    'the ticket for a second authorised person and judges it again when it is approved. Nothing reaches the venue before that.'
  );
}

/** The trade-signal page of a placed ticket. */
export function signalLink(tradeSignalId: number): string {
  return `/trade-signals/${tradeSignalId}`;
}
