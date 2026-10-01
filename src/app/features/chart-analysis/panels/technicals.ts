/**
 * Technicals summary — a TradingView-style Buy/Sell rating computed from a
 * standard set of moving averages and oscillators over the bars the chart is
 * showing. Pure: no Angular, no renderer, so it is unit-tested directly.
 *
 * Method (TradingView's published "Technical Ratings" recipe, simplified where
 * noted):
 * - Each MA votes BUY when the last close is above it, SELL when below.
 * - Each oscillator votes by its own rule (see `OSCILLATORS`).
 * - A group's rating = (buys − sells) / voters, in [−1, 1].
 * - Summary = mean of the two group ratings.
 * - Label bands: ≤ −0.5 Strong sell · < −0.1 Sell · ≤ 0.1 Neutral · < 0.5 Buy · ≥ 0.5 Strong buy.
 *
 * Indicators still in warm-up (null) do not vote — they are not counted as
 * neutral, which would dilute the rating on short histories.
 */
import {
  adx,
  awesome,
  cci,
  ema,
  hma,
  ichimoku,
  macd,
  momentum,
  rsi,
  sma,
  stochRsi,
  stochastic,
  ultimate,
  vwma,
  williamsR,
  elderRay,
  type Maybe,
  type Ohlc,
} from '../indicators/math';

export type Vote = 'buy' | 'neutral' | 'sell';
export type RatingLabel = 'Strong sell' | 'Sell' | 'Neutral' | 'Buy' | 'Strong buy';

export interface IndicatorVote {
  name: string;
  value: number | null;
  vote: Vote;
}

export interface GroupRating {
  buy: number;
  neutral: number;
  sell: number;
  /** (buy − sell) / voters, in [−1, 1]; 0 when nothing voted. */
  rating: number;
  label: RatingLabel;
  votes: IndicatorVote[];
}

export interface TechnicalRating {
  summary: { rating: number; label: RatingLabel; buy: number; neutral: number; sell: number };
  movingAverages: GroupRating;
  oscillators: GroupRating;
}

export function ratingLabel(r: number): RatingLabel {
  if (r <= -0.5) return 'Strong sell';
  if (r < -0.1) return 'Sell';
  if (r <= 0.1) return 'Neutral';
  if (r < 0.5) return 'Buy';
  return 'Strong buy';
}

const last = (xs: Maybe[]): number | null => {
  const v = xs.length ? xs[xs.length - 1] : null;
  return v === null || v === undefined || !Number.isFinite(v) ? null : v;
};
const prev = (xs: Maybe[]): number | null => {
  const v = xs.length > 1 ? xs[xs.length - 2] : null;
  return v === null || v === undefined || !Number.isFinite(v) ? null : v;
};

function group(votes: IndicatorVote[]): GroupRating {
  const counted = votes.filter((v) => v.value !== null);
  const buy = counted.filter((v) => v.vote === 'buy').length;
  const sell = counted.filter((v) => v.vote === 'sell').length;
  const neutral = counted.length - buy - sell;
  const rating = counted.length ? (buy - sell) / counted.length : 0;
  return { buy, neutral, sell, rating, label: ratingLabel(rating), votes };
}

function maVotes(bars: Ohlc[]): IndicatorVote[] {
  const closes = bars.map((b) => b.close);
  const price = closes[closes.length - 1];
  const mas: [string, Maybe[]][] = [];
  for (const p of [10, 20, 30, 50, 100, 200]) {
    mas.push([`EMA (${p})`, ema(closes, p)]);
    mas.push([`SMA (${p})`, sma(closes, p)]);
  }
  mas.push(['Ichimoku base (9, 26, 52, 26)', ichimoku(bars).base]);
  mas.push(['VWMA (20)', vwma(bars, 20)]);
  mas.push(['Hull MA (9)', hma(closes, 9)]);
  return mas.map(([name, series]) => {
    const v = last(series);
    const vote: Vote = v === null || price === v ? 'neutral' : price > v ? 'buy' : 'sell';
    return { name, value: v, vote };
  });
}

function oscVotes(bars: Ohlc[]): IndicatorVote[] {
  const closes = bars.map((b) => b.close);
  const out: IndicatorVote[] = [];
  const push = (name: string, value: number | null, vote: Vote) => out.push({ name, value, vote });

  // RSI: oversold & rising → buy; overbought & falling → sell.
  {
    const s = rsi(closes, 14);
    const v = last(s);
    const p = prev(s);
    push(
      'RSI (14)',
      v,
      v !== null && p !== null && v < 30 && v > p
        ? 'buy'
        : v !== null && p !== null && v > 70 && v < p
          ? 'sell'
          : 'neutral',
    );
  }
  // Stochastic: %K below 20 crossing above %D → buy; above 80 below %D → sell.
  {
    const s = stochastic(bars, 14, 3, 3);
    const k = last(s.k);
    const d = last(s.d);
    push(
      'Stochastic %K (14, 3, 3)',
      k,
      k !== null && d !== null && k < 20 && d < 20 && k > d
        ? 'buy'
        : k !== null && d !== null && k > 80 && d > 80 && k < d
          ? 'sell'
          : 'neutral',
    );
  }
  // CCI: below −100 & rising → buy; above 100 & falling → sell.
  {
    const s = cci(bars, 20);
    const v = last(s);
    const p = prev(s);
    push(
      'CCI (20)',
      v,
      v !== null && p !== null && v < -100 && v > p
        ? 'buy'
        : v !== null && p !== null && v > 100 && v < p
          ? 'sell'
          : 'neutral',
    );
  }
  // ADX: trend strength > 20 with +DI over −DI and ADX rising → buy; mirror → sell.
  {
    const s = adx(bars, 14);
    const v = last(s.adx);
    const p = prev(s.adx);
    const pl = last(s.plusDi);
    const mi = last(s.minusDi);
    const ok = v !== null && p !== null && pl !== null && mi !== null && v > 20 && v > p;
    push('ADX (14)', v, ok && pl! > mi! ? 'buy' : ok && pl! < mi! ? 'sell' : 'neutral');
  }
  // Awesome oscillator: above zero & rising → buy; below zero & falling → sell (saucer simplified).
  {
    const s = awesome(bars);
    const v = last(s);
    const p = prev(s);
    push(
      'Awesome oscillator',
      v,
      v !== null && p !== null && v > 0 && v > p
        ? 'buy'
        : v !== null && p !== null && v < 0 && v < p
          ? 'sell'
          : 'neutral',
    );
  }
  // Momentum: rising → buy, falling → sell.
  {
    const s = momentum(closes, 10);
    const v = last(s);
    const p = prev(s);
    push(
      'Momentum (10)',
      v,
      v !== null && p !== null && v > p ? 'buy' : v !== null && p !== null && v < p ? 'sell' : 'neutral',
    );
  }
  // MACD: line above signal → buy, below → sell.
  {
    const s = macd(closes, 12, 26, 9);
    const m = last(s.macd);
    const g = last(s.signal);
    push(
      'MACD level (12, 26)',
      m,
      m !== null && g !== null && m > g ? 'buy' : m !== null && g !== null && m < g ? 'sell' : 'neutral',
    );
  }
  // Stoch RSI: like Stochastic, gated on the trend (TV uses a downtrend/uptrend filter; omitted).
  {
    const s = stochRsi(closes, 14, 14, 3, 3);
    const k = last(s.k);
    const d = last(s.d);
    push(
      'Stoch RSI fast (3, 3, 14, 14)',
      k,
      k !== null && d !== null && k < 20 && d < 20 && k > d
        ? 'buy'
        : k !== null && d !== null && k > 80 && d > 80 && k < d
          ? 'sell'
          : 'neutral',
    );
  }
  // Williams %R: below −80 & rising → buy; above −20 & falling → sell.
  {
    const s = williamsR(bars, 14);
    const v = last(s);
    const p = prev(s);
    push(
      'Williams %R (14)',
      v,
      v !== null && p !== null && v < -80 && v > p
        ? 'buy'
        : v !== null && p !== null && v > -20 && v < p
          ? 'sell'
          : 'neutral',
    );
  }
  // Bull/bear power: net power (bull + bear) above zero & rising → buy; below & falling → sell.
  {
    const s = elderRay(bars, 13);
    const net = (i: number): number | null => {
      const b = s.bull[i];
      const r = s.bear[i];
      return b === null || r === null || b === undefined || r === undefined ? null : b + r;
    };
    const n = bars.length;
    const v = n ? net(n - 1) : null;
    const p = n > 1 ? net(n - 2) : null;
    push(
      'Bull bear power',
      v,
      v !== null && p !== null && v > 0 && v > p
        ? 'buy'
        : v !== null && p !== null && v < 0 && v < p
          ? 'sell'
          : 'neutral',
    );
  }
  // Ultimate oscillator: above 70 → buy, below 30 → sell.
  {
    const v = last(ultimate(bars, 7, 14, 28));
    push('Ultimate oscillator (7, 14, 28)', v, v !== null && v > 70 ? 'buy' : v !== null && v < 30 ? 'sell' : 'neutral');
  }
  return out;
}

/** The rating over ascending bars. Empty input → everything neutral with zero voters. */
export function technicalRating(bars: readonly Ohlc[]): TechnicalRating {
  const b = bars.slice();
  const movingAverages = group(b.length ? maVotes(b) : []);
  const oscillators = group(b.length ? oscVotes(b) : []);
  const rating = (movingAverages.rating + oscillators.rating) / 2;
  return {
    summary: {
      rating,
      label: ratingLabel(rating),
      buy: movingAverages.buy + oscillators.buy,
      neutral: movingAverages.neutral + oscillators.neutral,
      sell: movingAverages.sell + oscillators.sell,
    },
    movingAverages,
    oscillators,
  };
}
