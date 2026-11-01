import { describe, expect, it } from 'vitest';

import { attentionItems, eventTypeLabel, overallTone } from './engine-overview.logic';

describe('eventTypeLabel', () => {
  it('turns an integration-event class name into words', () => {
    expect(eventTypeLabel('PositionClosedIntegrationEvent')).toBe('Position closed');
    expect(eventTypeLabel('OrderFilledEvent')).toBe('Order filled');
  });

  it('drops a namespace and keeps acronyms', () => {
    expect(eventTypeLabel('Lascodia.Events.EAHeartbeatEvent')).toBe('EA heartbeat');
    expect(eventTypeLabel('MLModelPromotedIntegrationEvent')).toBe('ML model promoted');
  });

  it('keeps a bare "Event" readable and handles missing names', () => {
    expect(eventTypeLabel('Event')).toBe('Event');
    expect(eventTypeLabel(null)).toBe('Unknown event');
    expect(eventTypeLabel('  ')).toBe('Unknown event');
  });
});

describe('attentionItems / overallTone', () => {
  const base = { running: true, failed: 0, degraded: 0, idle: 0, dlqTotal: 0 };

  it('is empty and ok when nothing needs a look', () => {
    const items = attentionItems(base);
    expect(items).toEqual([]);
    expect(overallTone(items)).toBe('ok');
  });

  it('lists worst first and treats idle workers as neutral', () => {
    const items = attentionItems({ ...base, failed: 2, idle: 4, dlqTotal: 1 });
    expect(items.map((x) => x.text)).toEqual([
      '2 failed workers',
      '1 unresolved dead letter',
      '4 idle workers',
    ]);
    expect(overallTone(items)).toBe('bad');
    expect(overallTone(attentionItems({ ...base, idle: 4 }))).toBe('ok');
    expect(overallTone(attentionItems({ ...base, dlqTotal: 3 }))).toBe('warn');
  });

  it('flags a stopped engine and skips the queue when it is hidden', () => {
    const items = attentionItems({ ...base, running: false, dlqTotal: null });
    expect(items).toEqual([{ text: 'Engine is not running', tone: 'bad', target: null }]);
  });
});
