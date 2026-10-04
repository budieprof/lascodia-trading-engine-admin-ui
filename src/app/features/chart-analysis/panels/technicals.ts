/**
 * Technicals summary — a TradingView-style Buy/Sell rating computed from a
 * standard set of moving averages and oscillators over the bars the chart is
 * showing. Pure: no Angular, no renderer, so it is unit-tested directly.
 *
 * Method (TradingView's published "Technical Ratings" rules, help-centre article
 * 43000614331, condition for condition):
 * - Each MA votes BUY when the last close is above it, SELL when below; Ichimoku
 *   votes on its whole conversion / base / cloud stack.
 * - Each oscillator votes by its own documented rule (see `oscVotes`). Stoch RSI
 *   and Bull Bear Power are trend-gated; the trend is close vs SMA 50, the one
 *   input TradingView does not document (see `trendOf`).
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

/** The chart study (registry id + inputs) that draws exactly what a vote read. */
export interface StudyRef {
  id: string;
  params: Record<string, number>;
}

export interface IndicatorVote {
  /** TradingView's name for the row, e.g. "Relative Strength Index (14)". */
  name: string;
  value: number | null;
  vote: Vote;
  /** Why it voted that way, in plain words — the rule that fired, or why none did. */
  reason: string;
  study: StudyRef;
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

/** The edges of `ratingLabel`'s five bands, low to high. */
const BAND_EDGES = [-1, -0.5, -0.1, 0.1, 0.5, 1];

/**
 * Where the gauge needle points: 0 = the Strong-sell end of the dial, 1 = the
 * Strong-buy end. Piecewise-linear per label band, so the needle always lands
 * on the segment its label names. The dial's five segments are equal but the
 * bands are not (Neutral is ±0.1, Sell spans 0.4), so a straight linear map
 * would show "Sell" with the needle on the Neutral segment for −0.2…−0.1.
 */
export function gaugePosition(rating: number): number {
  if (!Number.isFinite(rating)) return 0.5;
  const r = Math.max(-1, Math.min(1, rating));
  let i = 0;
  while (i < 4 && r > BAND_EDGES[i + 1]) i++;
  return (i + (r - BAND_EDGES[i]) / (BAND_EDGES[i + 1] - BAND_EDGES[i])) / 5;
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

// The rules below are TradingView's, as its help centre documents them for the
// Technical Ratings (support article 43000614331), condition for condition.

export type Verdict = { vote: Vote; reason: string };

const NO_DATA: Verdict = { vote: 'neutral', reason: 'Not enough history to compute' };

/** Why a row shows no value: its lookback is longer than the history loaded. */
const warmUp = (bars: Ohlc[]): string =>
  `Not enough history to compute (${bars.length} bar${bars.length === 1 ? '' : 's'} loaded)`;

const ICHIMOKU = 'Ichimoku Base Line (9, 26, 52, 26)';

/** Moving averages vote on where the last close sits against them; Ichimoku on its whole stack. */
function maVotes(bars: Ohlc[]): IndicatorVote[] {
  const closes = bars.map((b) => b.close);
  const price = closes[closes.length - 1];
  const mas: { name: string; series: Maybe[]; study: StudyRef }[] = [];
  for (const p of [10, 20, 30, 50, 100, 200]) {
    mas.push({
      name: `Exponential Moving Average (${p})`,
      series: ema(closes, p),
      study: { id: 'ema', params: { length: p } },
    });
    mas.push({
      name: `Simple Moving Average (${p})`,
      series: sma(closes, p),
      study: { id: 'sma', params: { length: p } },
    });
  }
  mas.push({
    name: ICHIMOKU,
    series: ichimoku(bars).base,
    study: { id: 'ichimoku', params: { conversion: 9, base: 26, spanB: 52, displacement: 26 } },
  });
  mas.push({
    name: 'Volume Weighted Moving Average (20)',
    series: vwma(bars, 20),
    study: { id: 'vwma', params: { length: 20 } },
  });
  mas.push({
    name: 'Hull Moving Average (9)',
    series: hma(closes, 9),
    study: { id: 'hma', params: { length: 9 } },
  });
  return mas.map(({ name, series, study }) => {
    const v = last(series);
    if (v === null) return { name, value: null, vote: 'neutral', reason: warmUp(bars), study };
    if (name === ICHIMOKU) return { name, value: v, ...ichimokuVote(bars, price), study };
    const vote: Vote = price === v ? 'neutral' : price > v ? 'buy' : 'sell';
    const reason =
      vote === 'buy'
        ? 'Price is above the average'
        : vote === 'sell'
          ? 'Price is below the average'
          : 'Price is on the average';
    return { name, value: v, vote, reason, study };
  });
}

/**
 * Ichimoku votes on the whole stack, not price against the base line: Buy when
 * span A > span B, base > span A, conversion > base and price > conversion;
 * Sell is the mirror. The spans are the cloud UNDER the current bar (displaced)
 * — undisplaced, span A is the mean of conversion and base, so "base > span A"
 * and "conversion > base" could never both hold and the row could never vote.
 */
function ichimokuVote(bars: Ohlc[], price: number): Verdict {
  const s = ichimoku(bars);
  const conv = last(s.conversion);
  const base = last(s.base);
  const a = last(s.spanA);
  const b = last(s.spanB);
  if (conv === null || base === null || a === null || b === null) {
    return { vote: 'neutral', reason: warmUp(bars) };
  }
  return ichimokuVerdict(price, conv, base, a, b);
}

/** Ichimoku's rule on the latest values; `a` / `b` are the displaced spans under the current bar. */
export function ichimokuVerdict(
  price: number,
  conv: number,
  base: number,
  a: number,
  b: number,
): Verdict {
  if (a > b && base > a && conv > base && price > conv) {
    return { vote: 'buy', reason: 'Price > conversion > base > a bullish cloud' };
  }
  if (a < b && base < a && conv < base && price < conv) {
    return { vote: 'sell', reason: 'Price < conversion < base < a bearish cloud' };
  }
  return { vote: 'neutral', reason: 'Price, conversion, base and cloud are not stacked one way' };
}

/**
 * The trend that gates Stochastic RSI and Bull Bear Power. TradingView's help
 * names the gate but not its definition; close against SMA(50) is the reading of
 * its script, and it agrees with TradingView's own page (EURUSD 1D, 2026-10-04:
 * close under SMA 50, and Stoch RSI voting Buy, which needs a downtrend).
 */
export type Trend = 'up' | 'down' | null;

function trendOf(closes: number[]): Trend {
  const ma = last(sma(closes, 50));
  const price = closes[closes.length - 1];
  if (ma === null || price === ma) return null;
  return price > ma ? 'up' : 'down';
}

const TREND_TEXT: Record<'up' | 'down', string> = {
  up: 'uptrend (close above SMA 50)',
  down: 'downtrend (close below SMA 50)',
};

/**
 * A level oscillator's vote: Buy when below `low` and turning up, Sell when above
 * `high` and turning down — RSI, CCI and Williams %R all use this shape.
 */
function bandVote(
  v: number | null,
  p: number | null,
  low: number,
  high: number,
  fmt: (n: number) => string,
): Verdict {
  if (v === null || p === null) return NO_DATA;
  if (v < low && v > p) return { vote: 'buy', reason: `Below ${fmt(low)} and rising` };
  if (v > high && v < p) return { vote: 'sell', reason: `Above ${fmt(high)} and falling` };
  if (v < low) return { vote: 'neutral', reason: `Below ${fmt(low)} but not rising yet` };
  if (v > high) return { vote: 'neutral', reason: `Above ${fmt(high)} but not falling yet` };
  return { vote: 'neutral', reason: `Between ${fmt(low)} and ${fmt(high)}` };
}

/** %K against %D inside the oversold / overbought zones — Stochastic, and Stoch RSI with its trend gate. */
export function crossVote(k: number | null, d: number | null, trend?: Trend): Verdict {
  if (k === null || d === null) return NO_DATA;
  const gated = trend !== undefined;
  if (k < 20 && d < 20 && k > d) {
    if (!gated || trend === 'down') {
      return {
        vote: 'buy',
        reason: `%K and %D below 20, %K above %D${gated ? ', in a ' + TREND_TEXT.down : ''}`,
      };
    }
    return {
      vote: 'neutral',
      reason: 'Oversold turn, but Buy needs a downtrend (close below SMA 50)',
    };
  }
  if (k > 80 && d > 80 && k < d) {
    if (!gated || trend === 'up') {
      return {
        vote: 'sell',
        reason: `%K and %D above 80, %K below %D${gated ? ', in an ' + TREND_TEXT.up : ''}`,
      };
    }
    return {
      vote: 'neutral',
      reason: 'Overbought turn, but Sell needs an uptrend (close above SMA 50)',
    };
  }
  if (k < 20 && d < 20) return { vote: 'neutral', reason: 'Oversold, but %K is still below %D' };
  if (k > 80 && d > 80) return { vote: 'neutral', reason: 'Overbought, but %K is still above %D' };
  return { vote: 'neutral', reason: 'Not inside the 20 / 80 zones' };
}

/**
 * ADX: Buy when +DI > −DI, ADX > 20 and ADX RISING; Sell when +DI < −DI, ADX > 20
 * and ADX FALLING. The asymmetry is TradingView's own — a strengthening downtrend
 * is Neutral, not Sell.
 */
export function adxVerdict(
  v: number | null,
  p: number | null,
  plusDi: number | null,
  minusDi: number | null,
): Verdict {
  if (v === null || p === null || plusDi === null || minusDi === null) return NO_DATA;
  if (v <= 20) return { vote: 'neutral', reason: 'Weak trend: ADX at or below 20' };
  if (plusDi > minusDi && v > p)
    return { vote: 'buy', reason: '+DI above −DI, ADX above 20 and rising' };
  if (plusDi < minusDi && v < p)
    return { vote: 'sell', reason: '−DI above +DI, ADX above 20 and falling' };
  if (plusDi > minusDi) return { vote: 'neutral', reason: '+DI leads, but Buy needs ADX rising' };
  if (plusDi < minusDi) return { vote: 'neutral', reason: '−DI leads, but Sell needs ADX falling' };
  return { vote: 'neutral', reason: '+DI and −DI are level' };
}

/**
 * Awesome Oscillator: Buy on a cross over zero, or when it has been above zero
 * for two bars and turns up (the bullish saucer); Sell is the mirror. `p2` is
 * the value two bars back.
 */
export function aoVerdict(v: number | null, p: number | null, p2: number | null): Verdict {
  if (v === null || p === null) return NO_DATA;
  if (p <= 0 && v > 0) return { vote: 'buy', reason: 'Crossed above zero' };
  if (p >= 0 && v < 0) return { vote: 'sell', reason: 'Crossed below zero' };
  if (p2 !== null && v > 0 && p > 0 && v > p && p2 > p) {
    return { vote: 'buy', reason: 'Above zero and turned up (bullish saucer)' };
  }
  if (p2 !== null && v < 0 && p < 0 && v < p && p2 < p) {
    return { vote: 'sell', reason: 'Below zero and turned down (bearish saucer)' };
  }
  return { vote: 'neutral', reason: `${v > 0 ? 'Above' : 'Below'} zero, no cross and no turn` };
}

/**
 * Bull Bear Power: Buy in an uptrend when bear power is below zero and rising;
 * Sell in a downtrend when bull power is above zero and falling.
 */
export function bbpVerdict(
  trend: Trend,
  bull: number | null,
  bear: number | null,
  bullPrev: number | null,
  bearPrev: number | null,
): Verdict {
  if (bull === null || bear === null || bullPrev === null || bearPrev === null) return NO_DATA;
  if (trend === 'up' && bear < 0 && bear > bearPrev) {
    return { vote: 'buy', reason: `Bear power below zero and rising, in an ${TREND_TEXT.up}` };
  }
  if (trend === 'down' && bull > 0 && bull < bullPrev) {
    return { vote: 'sell', reason: `Bull power above zero and falling, in a ${TREND_TEXT.down}` };
  }
  if (trend === null) return { vote: 'neutral', reason: 'No trend to gate on (needs SMA 50)' };
  return {
    vote: 'neutral',
    reason:
      trend === 'up'
        ? `In an ${TREND_TEXT.up}, but bear power is not below zero and rising`
        : `In a ${TREND_TEXT.down}, but bull power is not above zero and falling`,
  };
}

const fixed0 = (n: number) => n.toFixed(0);

function oscVotes(bars: Ohlc[]): IndicatorVote[] {
  const closes = bars.map((b) => b.close);
  const trend = trendOf(closes);
  const out: IndicatorVote[] = [];
  const push = (name: string, value: number | null, verdict: Verdict, study: StudyRef) =>
    out.push({ name, value, ...verdict, study });

  // RSI: Buy < 30 and rising; Sell > 70 and falling.
  {
    const s = rsi(closes, 14);
    push('Relative Strength Index (14)', last(s), bandVote(last(s), prev(s), 30, 70, fixed0), {
      id: 'rsi',
      params: { length: 14 },
    });
  }
  // Stochastic: Buy %K, %D < 20 and %K > %D; Sell %K, %D > 80 and %K < %D.
  {
    const s = stochastic(bars, 14, 3, 3);
    push('Stochastic %K (14, 3, 3)', last(s.k), crossVote(last(s.k), last(s.d)), {
      id: 'stochastic',
      params: { length: 14, smoothK: 3, smoothD: 3 },
    });
  }
  // CCI: Buy < −100 and rising; Sell > 100 and falling.
  {
    const s = cci(bars, 20);
    push('Commodity Channel Index (20)', last(s), bandVote(last(s), prev(s), -100, 100, fixed0), {
      id: 'cci',
      params: { length: 20 },
    });
  }
  // ADX: Buy +DI > −DI, ADX > 20 and RISING; Sell +DI < −DI, ADX > 20 and FALLING. The
  // asymmetry is TradingView's own.
  {
    const s = adx(bars, 14);
    const v = last(s.adx);
    push(
      'Average Directional Index (14)',
      v,
      adxVerdict(v, prev(s.adx), last(s.plusDi), last(s.minusDi)),
      { id: 'adx', params: { length: 14 } },
    );
  }
  // Awesome Oscillator: Buy on a cross over 0, or two bars above 0 that turn up (a saucer);
  // Sell is the mirror.
  {
    const s = awesome(bars);
    const n = s.length;
    const at = (i: number) => (i >= 0 && s[i] !== undefined ? s[i] : null);
    push('Awesome Oscillator', last(s), aoVerdict(last(s), prev(s), at(n - 3)), {
      id: 'awesome',
      params: { fast: 5, slow: 34 },
    });
  }
  // Momentum: Buy rising; Sell falling.
  {
    const s = momentum(closes, 10);
    const v = last(s);
    const p = prev(s);
    push(
      'Momentum (10)',
      v,
      v === null || p === null
        ? NO_DATA
        : v > p
          ? { vote: 'buy', reason: 'Rising' }
          : v < p
            ? { vote: 'sell', reason: 'Falling' }
            : { vote: 'neutral', reason: 'Flat' },
      { id: 'momentum', params: { length: 10 } },
    );
  }
  // MACD: Buy line > signal; Sell line < signal.
  {
    const s = macd(closes, 12, 26, 9);
    const m = last(s.macd);
    const g = last(s.signal);
    push(
      'MACD Level (12, 26)',
      m,
      m === null || g === null
        ? NO_DATA
        : m > g
          ? { vote: 'buy', reason: 'MACD line above its signal line' }
          : m < g
            ? { vote: 'sell', reason: 'MACD line below its signal line' }
            : { vote: 'neutral', reason: 'MACD line on its signal line' },
      { id: 'macd', params: { fast: 12, slow: 26, signal: 9 } },
    );
  }
  // Stochastic RSI: as Stochastic, but Buy only in a downtrend and Sell only in an uptrend.
  {
    const s = stochRsi(closes, 14, 14, 3, 3);
    push('Stochastic RSI Fast (3, 3, 14, 14)', last(s.k), crossVote(last(s.k), last(s.d), trend), {
      id: 'stoch-rsi',
      params: { rsiPeriod: 14, stochPeriod: 14, smoothK: 3, smoothD: 3 },
    });
  }
  // Williams %R: Buy < −80 and rising; Sell > −20 and falling.
  {
    const s = williamsR(bars, 14);
    push('Williams Percent Range (14)', last(s), bandVote(last(s), prev(s), -80, -20, fixed0), {
      id: 'williams-r',
      params: { length: 14 },
    });
  }
  // Bull Bear Power (shown as bull + bear power): Buy in an uptrend when bear power is below
  // zero and rising; Sell in a downtrend when bull power is above zero and falling.
  {
    const s = elderRay(bars, 13);
    const n = bars.length;
    const at = (xs: Maybe[], i: number): number | null => {
      const x = i >= 0 ? xs[i] : null;
      return x === null || x === undefined || !Number.isFinite(x) ? null : x;
    };
    const bull = at(s.bull, n - 1);
    const bear = at(s.bear, n - 1);
    push(
      'Bull Bear Power',
      bull === null || bear === null ? null : bull + bear,
      bbpVerdict(trend, bull, bear, at(s.bull, n - 2), at(s.bear, n - 2)),
      { id: 'elder-ray', params: { length: 13 } },
    );
  }
  // Ultimate Oscillator: Buy > 70; Sell < 30.
  {
    const v = last(ultimate(bars, 7, 14, 28));
    push(
      'Ultimate Oscillator (7, 14, 28)',
      v,
      v === null
        ? NO_DATA
        : v > 70
          ? { vote: 'buy', reason: 'Above 70' }
          : v < 30
            ? { vote: 'sell', reason: 'Below 30' }
            : { vote: 'neutral', reason: 'Between 30 and 70' },
      { id: 'ultimate', params: { p1: 7, p2: 14, p3: 28 } },
    );
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
