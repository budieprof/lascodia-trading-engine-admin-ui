import { describe, expect, it } from 'vitest';
import { onTick, priceText, proposeGate } from './propose-gate';
import type { InstrumentFacts } from '../datafeed/instrument-facts';

const facts = (over: Partial<InstrumentFacts>): InstrumentFacts =>
  ({
    symbol: 'X',
    origin: 'pair',
    route: { kind: 'mt5' },
    precision: 5,
    tickSize: 0.00001,
    ...over,
  }) as InstrumentFacts;
const NOW = Date.parse('2026-11-07T12:00:00Z');

describe('AI directed proposals only where tradable (UA09)', () => {
  it('MT5 pair rows (FX, CFDs) keep them; without facts nothing changes', () => {
    expect(proposeGate(facts({ symbol: 'EURUSD' }), NOW)).toEqual({ allowed: true, reason: null });
    expect(proposeGate(null, NOW).allowed).toBe(true);
  });

  it('venue instruments while active; expired or halted ones and unknown symbols do not', () => {
    const inst = { status: 'Active', future: { lastTradeDate: '2026-12-18T14:30:00Z' } };
    const venue = (i: object) =>
      facts({
        symbol: 'ESZ6',
        origin: 'catalogue',
        route: { kind: 'venue', name: 'CME', instrument: i as never },
      });
    expect(proposeGate(venue(inst), NOW).allowed).toBe(true);
    expect(
      proposeGate(venue({ ...inst, future: { lastTradeDate: '2026-09-18T14:30:00Z' } }), NOW)
        .reason,
    ).toBe('ESZ6 has expired: it cannot be traded.');
    expect(proposeGate(venue({ status: 'Halted' }), NOW).reason).toBe(
      'ESZ6 is halted on CME: no orders.',
    );
    expect(proposeGate(facts({ symbol: 'SOL-USD', origin: 'catalogue' }), NOW).allowed).toBe(false);
    expect(proposeGate(facts({ symbol: 'FOO', origin: 'guess' }), NOW).allowed).toBe(false);
    expect(proposeGate(facts({ route: { kind: 'resolving' } }), NOW).allowed).toBe(false);
  });

  it('prices sit on the tick: ES 0.25, EURUSD unchanged', () => {
    const es = facts({ precision: 2, tickSize: 0.25 });
    expect(onTick(6012.37, es)).toBe(6012.25);
    expect(priceText(6012.4, es, '—')).toBe('6012.50');
    expect(priceText(null, es, 'at market')).toBe('at market');
    expect(onTick(1.085123, facts({}))).toBe(1.08512);
  });
});
