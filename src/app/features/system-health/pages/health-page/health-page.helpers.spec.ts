import { describe, expect, it } from 'vitest';

import { formatMs, humanizeEventType, idleReasonOf } from './health-page.helpers';

describe('humanizeEventType', () => {
  it('turns an integration-event class name into a sentence-case label', () => {
    expect(humanizeEventType('PositionClosedIntegrationEvent')).toBe('Position closed');
    expect(humanizeEventType('OrderFilledEvent')).toBe('Order filled');
  });

  it('keeps acronyms and mixed-case tokens', () => {
    expect(humanizeEventType('VaRBreachIntegrationEvent')).toBe('VaR breach');
    expect(humanizeEventType('EAHeartbeatMissedEvent')).toBe('EA heartbeat missed');
  });

  it('drops a namespace and generic arity', () => {
    expect(humanizeEventType('Lascodia.Events.TradeSignalCreatedIntegrationEvent')).toBe(
      'Trade signal created',
    );
    expect(humanizeEventType('Envelope`1')).toBe('Envelope');
  });

  it('handles blank and bare suffix names', () => {
    expect(humanizeEventType(null)).toBe('Unknown event');
    expect(humanizeEventType('  ')).toBe('Unknown event');
    expect(humanizeEventType('IntegrationEvent')).toBe('IntegrationEvent');
  });
});

describe('idleReasonOf', () => {
  it('is unknown until the switch row has been read', () => {
    expect(idleReasonOf('FooWorker', undefined)).toEqual({
      kind: 'unknown',
      key: 'Workers:FooWorker:Enabled',
      since: null,
    });
  });

  it('reports a worker switched off with the date of the change', () => {
    expect(idleReasonOf('FooWorker', { value: ' False ', at: '2026-08-23T10:00:00Z' })).toEqual({
      kind: 'off',
      key: 'Workers:FooWorker:Enabled',
      since: '2026-08-23',
    });
  });

  it('treats a missing row or any other value as switched on', () => {
    expect(idleReasonOf('FooWorker', null).kind).toBe('on');
    expect(idleReasonOf('FooWorker', { value: 'true', at: '' }).kind).toBe('on');
  });
});

describe('formatMs', () => {
  it('picks a readable unit', () => {
    expect(formatMs(166)).toBe('166 ms');
    expect(formatMs(12_340)).toBe('12.3 s');
    expect(formatMs(393_015)).toBe('6.6 min');
    expect(formatMs(5_040_000)).toBe('1.4 h');
    expect(formatMs(Number.NaN)).toBe('—');
  });
});
