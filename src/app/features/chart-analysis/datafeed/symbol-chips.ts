import type { InstrumentDto } from '@core/instruments/instrument.types';
import { isExchangeTraded } from '@features/venues/venues.logic';
import { isVenueSource, volumeLabel, type ChartSource, type SymbolFacts } from './chart-facts';

/**
 * What a chart says about the bars it draws (multi-asset chart program UD07): where they come from (the candle source:
 * "MT5 broker feed", "Coinbase Advanced Trade"), the exchange, the futures contract with its expiry and whether it is
 * the front month, the perpetual badge, the volume unit and the corporate-action adjustment. Pure; built from C1 facts
 * (chart-bars) with the catalogue row (C2) filling in until a chart-bars answer has come.
 */

export interface SymbolChip {
  /** Stable identity for `@for` tracking. */
  id: 'kind' | 'source' | 'exchange' | 'contract' | 'perp' | 'volume' | 'adjustment' | 'synthetic';
  text: string;
  title: string;
  /** Draws attention (an expiring contract, a non-front month, unknown volume). */
  warn?: boolean;
}

const DAY = 86_400_000;

/** "Forex", "Index CFD", "Equity CFD", "Commodity CFD", "Crypto spot", "Crypto perpetual", "Future", "Stock", "ETF". */
export function instrumentKindLabel(
  inst:
    | Pick<InstrumentDto, 'assetClass' | 'crypto' | 'future' | 'equity' | 'symbol'>
    | null
    | undefined,
  assetClass?: string | null,
): string {
  const ac = (assetClass ?? inst?.assetClass ?? '').toString();
  const traded = inst ? isExchangeTraded(inst as InstrumentDto) : false;
  switch (ac) {
    case 'Fx':
    case 'FxMajor':
    case 'FxMinor':
    case 'FxExotic':
      return 'Forex';
    case 'Crypto':
      if (inst?.crypto?.kind === 'Perpetual') return 'Crypto perpetual';
      return inst?.crypto ? 'Crypto spot' : 'Crypto';
    case 'Future':
      return traded ? 'Future' : 'Futures CFD';
    case 'Equity':
      return traded ? 'Stock' : 'Equity CFD';
    case 'Etf':
      return traded ? 'ETF' : 'ETF CFD';
    case 'Index':
      return 'Index CFD';
    case 'Commodity':
      return /^X(AU|AG|PT|PD)/i.test(inst?.symbol ?? '') ? 'Metal CFD' : 'Commodity CFD';
    default:
      return ac || 'Instrument';
  }
}

/** The instrument's description, unless it only repeats the symbol or reads "USD / USD" (a CFD's pair row). */
export function instrumentDescription(
  inst:
    | Pick<InstrumentDto, 'symbol' | 'description' | 'baseCurrency' | 'quoteCurrency'>
    | null
    | undefined,
): string | null {
  const d = (inst?.description ?? '').trim();
  if (!d || d.toUpperCase() === (inst?.symbol ?? '').toUpperCase()) return null;
  const legs = /^\s*([A-Za-z]{3})\s*\/\s*([A-Za-z]{3})\s*$/.exec(d);
  if (legs && legs[1].toUpperCase() === legs[2].toUpperCase()) return null;
  return d;
}

export function symbolChips(
  facts: SymbolFacts | null,
  inst: InstrumentDto | null,
  nowMs: number,
): SymbolChip[] {
  const out: SymbolChip[] = [];
  out.push({
    id: 'kind',
    text: instrumentKindLabel(inst, facts?.assetClass),
    title: facts?.calendarCode ? `Trading calendar: ${facts.calendarCode}` : 'Asset class',
  });

  const source: ChartSource | null = facts?.source ?? inst?.candleSource ?? null;
  out.push(
    source
      ? {
          id: 'source',
          text: isVenueSource(source) ? source.label : 'MT5 broker',
          title: `Bars from ${source.label} (${source.id})${facts?.source ? '' : ' — pinned source, before the first chart answer'}`,
        }
      : {
          id: 'source',
          text: 'Source unknown',
          title: 'The engine has not said which feed these bars come from',
          warn: true,
        },
  );

  const exchange = (inst?.exchange ?? '').trim();
  if (inst && isExchangeTraded(inst) && exchange && exchange.toUpperCase() !== 'OTC')
    out.push({ id: 'exchange', text: exchange, title: `Listed on ${exchange}` });

  const fut = inst?.future;
  if (fut) {
    const expiry = fut.lastTradeDate ?? fut.expiry;
    const t = expiry ? Date.parse(expiry) : Number.NaN;
    const days = Number.isFinite(t) ? Math.ceil((t - nowMs) / DAY) : null;
    const when = expiry ? ` · exp ${expiry.slice(0, 10)}` : '';
    out.push({
      id: 'contract',
      text: `${fut.contractCode}${when}${fut.isFront ? ' · front' : ''}`,
      title:
        days === null
          ? 'Futures contract (expiry not published)'
          : days < 0
            ? 'This contract has expired'
            : `${days} day(s) to the last trade${fut.isFront ? '' : ' — not the front month'}${fut.continuousSymbol ? `; continuous: ${fut.continuousSymbol}` : ''}`,
      warn: days !== null && (days <= 3 || !fut.isFront),
    });
  }

  if (inst?.crypto?.kind === 'Perpetual')
    out.push({
      id: 'perp',
      text: inst.contractType === 'Inverse' ? 'PERP · inverse' : 'PERP',
      title: `Perpetual swap${inst.crypto.fundingIntervalHours ? `, funding every ${inst.crypto.fundingIntervalHours}h` : ''}${inst.crypto.settleAsset ? `, settled in ${inst.crypto.settleAsset}` : ''}`,
    });

  if (facts) {
    const base = inst?.baseCurrency ?? null;
    out.push({
      id: 'volume',
      text: volumeLabel(facts.volumeKind, base),
      title:
        facts.volumeKind === 'tick'
          ? 'MT5 tick volume: the number of price changes, not traded size'
          : facts.volumeKind
            ? 'Traded volume reported by the source'
            : 'The source does not say what its volume counts',
      warn: !facts.volumeKind,
    });
    const ac = facts.assetClass ?? inst?.assetClass;
    if ((ac === 'Equity' || ac === 'Etf') && facts.adjustment)
      out.push({
        id: 'adjustment',
        text:
          facts.adjustment === 'all'
            ? 'adj. splits + dividends'
            : facts.adjustment === 'splits'
              ? 'adj. splits'
              : 'unadjusted',
        title: 'Corporate-action adjustment the engine applied to these bars',
      });
  }
  return out;
}
