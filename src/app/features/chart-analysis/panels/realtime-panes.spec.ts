import { describe, expect, it } from 'vitest';

import type { UpcomingEconomicEvent } from '@core/services/economic-calendar.service';
import { FAST_REFRESH_MS, SLOW_REFRESH_MS, refreshInterval, upsertEvent } from './economic-calendar';
import { concernsPane } from './news-pane';

/** EV-1: the calendar and news panes follow the engine's pushes instead of polling for them. */

const NOW = Date.UTC(2026, 9, 9, 12, 30);

function event(over: Partial<UpcomingEconomicEvent> = {}): UpcomingEconomicEvent {
  return {
    id: 1,
    title: 'Non-Farm Payrolls',
    currency: 'USD',
    impact: 'High',
    scheduledAt: new Date(NOW - 60_000).toISOString(),
    forecast: '120K',
    previous: '98K',
    actual: null,
    forecastProvenance: 'PreRelease',
    polarity: 'Direct',
    result: null,
    ...over,
  };
}

describe('upsertEvent (economicEventActualRecorded)', () => {
  const filter = { currencies: ['EUR', 'USD'], minImpact: 'Low' };

  it('folds the pushed actual into its row in place, with its Beat/Miss', () => {
    const list = [event(), event({ id: 2, currency: 'EUR', title: 'CPI' })];
    const next = upsertEvent(list, event({ actual: '150K', result: 'Beat' }), filter);
    expect(next).not.toBe(list);
    expect(next[0]).toMatchObject({ id: 1, actual: '150K', result: 'Beat' });
    expect(next[1]).toBe(list[1]);
  });

  it('adds an event the pane does not list yet only when it passes the pane’s filter', () => {
    const list = [event()];
    expect(upsertEvent(list, event({ id: 3, currency: 'JPY', actual: '1' }), filter)).toBe(list);
    expect(upsertEvent(list, event({ id: 4, impact: 'Low', actual: '1' }), { ...filter, minImpact: 'High' })).toBe(list);
    expect(upsertEvent(list, event({ id: 5, currency: 'usd', actual: '1' }), filter)).toHaveLength(2);
    // All currencies: anything passes the currency side.
    expect(upsertEvent(list, event({ id: 6, currency: 'JPY', actual: '1' }), { currencies: [], minImpact: 'Low' })).toHaveLength(2);
  });
});

describe('refreshInterval with the push', () => {
  it('re-reads fast around a due release only while the push is not connected', () => {
    const due = [event()];
    expect(refreshInterval(due, NOW)).toBe(FAST_REFRESH_MS);
    expect(refreshInterval(due, NOW, true)).toBe(SLOW_REFRESH_MS);
  });
});

describe('concernsPane (newsArticleIngested)', () => {
  it('re-reads the news pane only for an article labelled for one of the pair’s currencies', () => {
    expect(concernsPane({ currencies: ['USD', 'JPY'] }, ['EUR', 'USD'])).toBe(true);
    expect(concernsPane({ currencies: ['jpy'] }, ['EUR', 'USD'])).toBe(false);
    expect(concernsPane({ currencies: ['eur'] }, ['EUR', 'USD'])).toBe(true);
    expect(concernsPane(null, ['EUR'])).toBe(false);
    expect(concernsPane({ currencies: ['EUR'] }, [])).toBe(false);
  });
});
