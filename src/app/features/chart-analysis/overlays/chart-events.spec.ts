import { describe, expect, it, vi } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { of } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import { EconomicEventsService } from '@core/services/economic-events.service';
import {
  blackoutBands,
  eventCard,
  eventCountdown,
  eventsWindow,
  formatEventTime,
  markOf,
  mergeMarks,
  missingOnTheLeft,
  passesImpact,
  type EconomicEventRow,
  type EventMark,
} from './chart-events';
import { ChartEventsService } from './chart-events.service';

const H = 3_600_000;
const NOW = Date.parse('2026-10-09T09:00:00Z');

const row = (over: Partial<EconomicEventRow> = {}): EconomicEventRow => ({
  id: 1,
  title: 'Non-Farm Payrolls',
  currency: 'USD',
  impact: 'High',
  scheduledAt: '2026-10-09T12:30:00Z',
  forecast: '180K',
  previous: '142K',
  actual: null,
  source: 'Manual' as EconomicEventRow['source'],
  ...over,
});
const mark = (over: Partial<EconomicEventRow> = {}): EventMark => markOf(row(over))!;

describe('chart events — what the chart draws on its time axis (CC-07, CC-I2, SP-08)', () => {
  it('turns a list row into a mark the calendar modal can open', () => {
    const m = mark({ polarity: 'Direct', result: null, forecastProvenance: 'PreRelease' });
    expect(m).toMatchObject({
      id: 1,
      time: Date.parse('2026-10-09T12:30:00Z'),
      currency: 'USD',
      impact: 'High',
    });
    expect(m.event).toMatchObject({
      id: 1,
      forecast: '180K',
      forecastProvenance: 'PreRelease',
      polarity: 'Direct',
    });
    expect(markOf(row({ scheduledAt: 'not a date' }))).toBeNull();
  });

  it('asks for the loaded bars through two weeks ahead', () => {
    expect(eventsWindow(NOW - 10 * 24 * H, NOW)).toEqual({
      from: NOW - 10 * 24 * H,
      to: NOW + 14 * 24 * H,
    });
  });

  it('scroll-back asks only for what the held window does not cover', () => {
    const held = { from: 1_000, to: 9_000 };
    expect(missingOnTheLeft(held, { from: 400, to: 9_500 })).toEqual({ from: 400, to: 999 });
    expect(missingOnTheLeft(held, { from: 1_000, to: 9_500 })).toBeNull();
    expect(missingOnTheLeft(null, { from: 1, to: 2 })).toEqual({ from: 1, to: 2 });
  });

  it('merges by id, the newer copy winning (an actual landed), in time order', () => {
    const a = mark({ id: 1 });
    const b = mark({ id: 2, scheduledAt: '2026-10-08T12:30:00Z' });
    const released = mark({ id: 1, actual: '254K', result: 'Beat' });
    const merged = mergeMarks([a, b], [released]);
    expect(merged.map((m) => m.id)).toEqual([2, 1]);
    expect(merged[1].event.actual).toBe('254K');
  });

  it('shades the blackout around High events of the pair only, merging overlaps', () => {
    const w = { active: true, minutesBefore: 30, minutesAfter: 15 };
    const nfp = mark({ id: 1, scheduledAt: '2026-10-09T12:30:00Z' });
    const claims = mark({ id: 2, scheduledAt: '2026-10-09T12:40:00Z' });
    const jpy = mark({ id: 3, currency: 'JPY', scheduledAt: '2026-10-09T01:00:00Z' });
    const medium = mark({ id: 4, impact: 'Medium', scheduledAt: '2026-10-09T15:00:00Z' });
    const bands = blackoutBands([nfp, claims, jpy, medium], w, ['EUR', 'USD']);
    expect(bands).toEqual([
      { from: Date.parse('2026-10-09T12:00:00Z'), to: Date.parse('2026-10-09T12:55:00Z') },
    ]);
    expect(blackoutBands([nfp], { ...w, active: false }, ['USD'])).toEqual([]);
    expect(blackoutBands([nfp], null, ['USD'])).toEqual([]);
  });

  it('counts down to an upcoming event', () => {
    expect(eventCountdown(NOW, NOW + 3 * H + 5 * 60_000)).toBe('in 3h 05m');
    expect(eventCountdown(NOW, NOW + 52 * H)).toBe('in 2d 4h');
    expect(eventCountdown(NOW, NOW + 12 * 60_000)).toBe('in 12m');
    expect(eventCountdown(NOW, NOW + 10_000)).toBe('now');
    expect(eventCountdown(NOW, NOW - 2 * 60_000)).toBeNull();
  });

  it('cards the event: when on the chart clock, the numbers, the engine’s beat / miss', () => {
    const upcoming = eventCard(mark(), 'Fri 9 Oct 08:30 UTC−4', NOW);
    expect(upcoming.rows[0]).toEqual({ label: 'Due', value: 'in 3h 30m' });
    expect(upcoming.rows.find((r) => r.label === 'Actual')?.value).toBe('—');
    expect(upcoming.surprise).toBeNull();
    const released = eventCard(mark({ actual: '254K', result: 'Beat' }), 'x', NOW + 5 * H);
    expect(released.rows.map((r) => r.label)).toEqual(['Actual', 'Forecast', 'Previous']);
    expect(released.surprise).toBe('Beat — better than forecast for USD');
  });

  it('prints the time on the chart clock with its offset', () => {
    const t = Date.parse('2026-10-09T12:30:00Z');
    expect(formatEventTime(t, 0)).toBe('Fri 9 Oct 12:30 UTC');
    expect(formatEventTime(t, -240)).toBe('Fri 9 Oct 08:30 UTC−4');
    expect(formatEventTime(t, 330)).toBe('Fri 9 Oct 18:00 UTC+5:30');
  });

  it('filters by the minimum importance', () => {
    expect(passesImpact('High', 'Medium')).toBe(true);
    expect(passesImpact('Low', 'Medium')).toBe(false);
  });
});

describe('ChartEventsService — the pair’s events filtered on the engine (contract C3)', () => {
  function setup(pages: EconomicEventRow[][]) {
    const list = vi.fn((req: { currentPage: number }) =>
      of({ status: true, data: { data: pages[req.currentPage - 1] ?? [], pager: {} } }),
    );
    const getEnvelope = vi.fn(() =>
      of({ active: true, minutesBefore: 30, minutesAfter: 15, explanation: 'x' }),
    );
    const injector = Injector.create({
      providers: [
        { provide: EconomicEventsService, useValue: { list } },
        { provide: ApiService, useValue: { getEnvelope } },
        { provide: ChartEventsService, useClass: ChartEventsService },
      ],
    });
    const svc = runInInjectionContext(injector, () => injector.get(ChartEventsService));
    return { svc, list, getEnvelope };
  }

  it('sends the currencies and minimum importance in the nested filter, newest first', async () => {
    const { svc, list } = setup([[row()]]);
    const marks = await svc.load({
      currencies: ['EUR', 'USD'],
      minImpact: 'Medium',
      from: 0,
      to: NOW,
    });
    expect(marks?.length).toBe(1);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0][0]).toMatchObject({
      currentPage: 1,
      sortBy: 'scheduledAt',
      sortDirection: 'desc',
      filter: { currencies: 'EUR,USD', minImpact: 'Medium', from: new Date(0).toISOString() },
    });
  });

  it('reads every page of a long window, and stops at a short one', async () => {
    const full = Array.from({ length: 500 }, (_, i) => row({ id: i + 1 }));
    const { svc, list } = setup([full, [row({ id: 999 })]]);
    const marks = await svc.load({ currencies: ['USD'], minImpact: 'High', from: 0, to: NOW });
    expect(list).toHaveBeenCalledTimes(2);
    expect(marks?.length).toBe(501);
  });

  it('answers null when the engine refuses, so the chart keeps what it has', async () => {
    const injector = Injector.create({
      providers: [
        { provide: EconomicEventsService, useValue: { list: () => of({ status: false }) } },
        { provide: ApiService, useValue: {} },
        { provide: ChartEventsService, useClass: ChartEventsService },
      ],
    });
    const svc = runInInjectionContext(injector, () => injector.get(ChartEventsService));
    expect(await svc.load({ currencies: [], minImpact: 'Low', from: 0, to: 1 })).toBeNull();
  });

  it('reads the blackout window', async () => {
    const { svc, getEnvelope } = setup([]);
    expect(await svc.blackout()).toMatchObject({
      active: true,
      minutesBefore: 30,
      minutesAfter: 15,
    });
    expect(getEnvelope).toHaveBeenCalledWith('/economic-event/news-blackout', { silent: true });
  });
});
