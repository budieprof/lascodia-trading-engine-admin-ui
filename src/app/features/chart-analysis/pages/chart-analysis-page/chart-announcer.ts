/**
 * US05: what the chart says to a screen reader, politely (an `aria-live="polite"` status region): the symbol and its
 * market state when they change, and the price — never per tick (a live chart would talk over everything): at most
 * once per {@link PRICE_EVERY_MS}, and only when it moved. Pure: the page feeds it and shows the message.
 */
export const PRICE_EVERY_MS = 30_000;

export interface AnnounceInput {
  symbol: string;
  /** "1 hour". */
  interval: string;
  /** The market chip's words ("Market open", "Pre-market", "Market closed · opens in 2h"); null while unknown. */
  market: string | null;
  /** The last price, already formatted at the symbol's precision; null before a bar. */
  price: string | null;
}

export class ChartAnnouncer {
  private last: AnnounceInput | null = null;
  private priceAt = -Infinity;
  private spokenPrice: string | null = null;

  /** The message to show now, or null to leave the region as it is. */
  next(input: AnnounceInput, nowMs: number): string | null {
    const prev = this.last;
    this.last = input;
    if (!prev || prev.symbol !== input.symbol || prev.interval !== input.interval) {
      this.priceAt = nowMs;
      this.spokenPrice = input.price;
      return [
        `${input.symbol}, ${input.interval}.`,
        input.market ? `${input.market}.` : '',
        input.price ? `Last ${input.price}.` : '',
      ]
        .filter(Boolean)
        .join(' ');
    }
    if (input.market && input.market !== prev.market) return `${input.symbol}: ${input.market}.`;
    if (input.price && input.price !== this.spokenPrice && nowMs - this.priceAt >= PRICE_EVERY_MS) {
      this.priceAt = nowMs;
      this.spokenPrice = input.price;
      return `${input.symbol} ${input.price}.`;
    }
    return null;
  }
}
