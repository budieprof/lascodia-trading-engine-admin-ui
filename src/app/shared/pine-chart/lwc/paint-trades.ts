import { formatUnits } from '../core/quantity';
import { TRADE_COLORS, FONT_DEFAULT } from '../render/build-render-model';
import type { TradeDrawing } from '../render/render-model';
import { cssFont, drawArrow, drawTextBlock, measureBlock, type Ctx } from './canvas-kit';
import type { HitRegion } from './paint-drawings';
import type { BarLookup, MarkerStacks } from './paint-markers';
import type { Projection } from './projection';

/**
 * Strategy trades as TradingView draws them: an arrow per fill — orders that buy (long entries,
 * short exits) point up from under the bar, orders that sell point down from over it — labelled with
 * the order's signal and signed quantity, a tick at the exact fill price, and a dashed line from entry
 * to exit colored by the trade's profit. Quantities are Pine units ("+100,000 units"), never lots.
 */

export interface TradeMarker {
  logical: number;
  price: number;
  /** An order that buys draws under the bar pointing up. */
  side: 'buy' | 'sell';
  kind: 'entry' | 'exit';
  color: string;
  text: string;
  tooltip: string;
}

/** The size without its sign: "100,000 units". */
function qtyText(q: number): string {
  return formatUnits(Math.abs(q));
}

/** The fill markers of one trade (entry, plus exit when closed). */
export function tradeMarkers(t: TradeDrawing, currency = ''): (TradeMarker & { qty: number })[] {
  const long = t.direction === 'long';
  const profit = `${t.profit >= 0 ? '+' : ''}${t.profit.toFixed(2)}${currency ? ' ' + currency : ''}${
    t.profitPercent !== null
      ? ` (${t.profitPercent >= 0 ? '+' : ''}${t.profitPercent.toFixed(2)}%)`
      : ''
  }`;
  const out: (TradeMarker & { qty: number })[] = [
    {
      qty: t.qty,
      logical: t.entryX,
      price: t.entryPrice,
      side: long ? 'buy' : 'sell',
      kind: 'entry',
      color: long ? TRADE_COLORS.longEntry : TRADE_COLORS.shortEntry,
      text: `${t.entrySignal}\n${long ? '+' : '-'}${qtyText(t.qty)}`,
      tooltip: `Trade #${t.number} · ${long ? 'Long' : 'Short'} entry "${t.entrySignal}" · ${qtyText(t.qty)} @ ${t.entryPrice}${
        t.isOpen ? ` · open P/L ${profit}` : ''
      }`,
    },
  ];
  if (t.exitX !== null && t.exitPrice !== null) {
    const signal = t.exitSignal ?? 'Close';
    out.push({
      qty: t.qty,
      logical: t.exitX,
      price: t.exitPrice,
      side: long ? 'sell' : 'buy',
      kind: 'exit',
      color: TRADE_COLORS.exit,
      text: `${signal}\n${long ? '-' : '+'}${qtyText(t.qty)}`,
      tooltip: `Trade #${t.number} · ${long ? 'Long' : 'Short'} exit "${signal}" · ${qtyText(t.qty)} @ ${t.exitPrice} · P/L ${profit}`,
    });
  }
  return out;
}

/**
 * TradingView draws one arrow per ORDER, not per trade leg: a reversal (close the short and open
 * the long on the same bar) is a single "Long +20,000" order. Merge fills that share a bar,
 * direction and price; the entry's signal names the order and the quantities add up.
 */
export function mergeFills(markers: readonly (TradeMarker & { qty: number })[]): TradeMarker[] {
  const groups = new Map<string, (TradeMarker & { qty: number })[]>();
  for (const m of markers) {
    const key = `${Math.round(m.logical)}|${m.side}|${m.price.toPrecision(10)}`;
    const g = groups.get(key);
    if (g) g.push(m);
    else groups.set(key, [m]);
  }
  const out: TradeMarker[] = [];
  for (const g of groups.values()) {
    if (g.length === 1) {
      out.push(g[0]);
      continue;
    }
    const lead = g.find((m) => m.kind === 'entry') ?? g[0];
    const qty = g.reduce((s, m) => s + Math.abs(m.qty), 0);
    const signal = lead.text.split('\n')[0];
    out.push({
      ...lead,
      text: `${signal}\n${lead.side === 'buy' ? '+' : '-'}${qtyText(qty)}`,
      tooltip: g.map((m) => m.tooltip).join('\n'),
    });
  }
  return out;
}

const ARROW_LEN = 12;
const TEXT_PX = 11;

export function paintTrades(
  ctx: Ctx,
  p: Projection,
  trades: readonly TradeDrawing[],
  bars: BarLookup,
  lastClose: number,
  stacks: MarkerStacks,
  hits: HitRegion[],
): void {
  if (!trades.length) return;
  ctx.save();
  // Connecting lines first, so markers draw over them.
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  for (const t of trades) {
    const endX = t.exitX ?? p.lastLogical;
    const endPrice = t.exitPrice ?? lastClose;
    if (Math.max(t.entryX, endX) < p.from || Math.min(t.entryX, endX) > p.to) continue;
    if (!Number.isFinite(endPrice)) continue;
    ctx.strokeStyle = t.lineColor;
    ctx.beginPath();
    ctx.moveTo(p.x(t.entryX), p.y(t.entryPrice));
    ctx.lineTo(p.x(endX), p.y(endPrice));
    ctx.stroke();
  }
  ctx.setLineDash([]);

  const headW = Math.max(7, Math.min(12, p.barSpacing * 0.9));
  const tickW = Math.max(4, Math.min(16, p.barSpacing * 0.8));
  ctx.font = cssFont(TEXT_PX, FONT_DEFAULT);
  const inView = (x: number | null) => x !== null && x >= p.from && x <= p.to;
  const fills = mergeFills(
    trades.filter((t) => inView(t.entryX) || inView(t.exitX)).flatMap((t) => tradeMarkers(t)),
  );
  {
    for (const m of fills) {
      if (m.logical < p.from || m.logical > p.to) continue;
      const bar = Math.round(m.logical);
      const x = p.x(m.logical);
      const block = measureBlock(ctx, m.text.split('\n'), TEXT_PX);
      const footprint = ARROW_LEN + 2 + block.height + 4;
      // Fill-price tick.
      const py = p.y(m.price);
      ctx.fillStyle = m.color;
      if (Number.isFinite(py)) ctx.fillRect(x - tickW / 2, Math.round(py) - 1, tickW, 2);
      let region: Omit<HitRegion, 'tooltip'>;
      if (m.side === 'buy') {
        const lo = bars.low(bar);
        const base = (lo === lo ? p.y(lo) : py) + 4 + stacks.take('below', bar, footprint);
        drawArrow(ctx, x, base, base + ARROW_LEN, headW, m.color);
        const textTop = base + ARROW_LEN + 2;
        drawTextBlock(
          ctx,
          block,
          x - block.width / 2,
          textTop,
          block.width,
          block.height,
          'center',
          'top',
          m.color,
        );
        region = {
          x: x - Math.max(headW, block.width) / 2,
          y: base,
          w: Math.max(headW, block.width),
          h: footprint,
        };
      } else {
        const hi = bars.high(bar);
        const base = (hi === hi ? p.y(hi) : py) - 4 - stacks.take('above', bar, footprint);
        drawArrow(ctx, x, base, base - ARROW_LEN, headW, m.color);
        const textTop = base - ARROW_LEN - 2 - block.height;
        drawTextBlock(
          ctx,
          block,
          x - block.width / 2,
          textTop,
          block.width,
          block.height,
          'center',
          'top',
          m.color,
        );
        region = {
          x: x - Math.max(headW, block.width) / 2,
          y: textTop,
          w: Math.max(headW, block.width),
          h: footprint,
        };
      }
      hits.push({ ...region, tooltip: m.tooltip });
    }
  }
  ctx.restore();
}
