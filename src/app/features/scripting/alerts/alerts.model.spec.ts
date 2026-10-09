import { describe, expect, it } from 'vitest';

import type { AlertChannelStatusDto } from '@core/api/api.types';

import {
  ALERT_CHANNELS,
  MAX_TEST_MESSAGE_LENGTH,
  alertRowsDiffer,
  buildAlertRows,
  channelChip,
  channelWarnings,
  checkWebhookUrl,
  deliveryAlertTitle,
  deliveryStatusLabel,
  extractAlertConditions,
  extractPlots,
  insertAt,
  normaliseFrequency,
  placeholderGroupsFor,
  renderSampleMessage,
  scanCalls,
  scriptKind,
  stormGuardText,
  strategyConditionWarning,
  stringLiteral,
  toAlertBindings,
  unknownPlaceholders,
  validateRow,
  type AlertRow,
  type ScriptAlertBindingView,
} from './alerts.model';
import { BREAKOUT_SOURCE } from '../testing/pine-sources';

describe('source scanning', () => {
  it('reads string literals, escapes included', () => {
    expect(stringLiteral('"Long breakout"')).toBe('Long breakout');
    expect(stringLiteral(`'single'`)).toBe('single');
    expect(stringLiteral('"a \\"quoted\\" word"')).toBe('a "quoted" word');
    expect(stringLiteral('str.format("x")')).toBeNull();
    expect(stringLiteral(undefined)).toBeNull();
  });

  it('finds calls with nested parentheses and brackets, but not in comments or strings', () => {
    const calls = scanCalls(BREAKOUT_SOURCE, 'alertcondition');
    expect(calls).toHaveLength(4);
    expect(calls[0].args).toEqual([
      'ta.crossover(close, hi[1])',
      '"Long breakout"',
      '"Price broke above {{plot_0}}"',
    ]);
    expect(calls[0].line).toBe(10);
  });

  it('lists alertcondition titles and default messages, skipping dynamic and repeated titles', () => {
    const scan = extractAlertConditions(BREAKOUT_SOURCE);
    expect(scan.conditions.map((c) => [c.title, c.message])).toEqual([
      ['Long breakout', 'Price broke above {{plot_0}}'],
      ['Short breakout', 'Below {{plot("Lower")}}'],
    ]);
    expect(scan.untitled).toBe(1);
    expect(extractAlertConditions(null)).toEqual({ conditions: [], untitled: 0 });
  });

  it('numbers the plots in source order with their titles', () => {
    expect(extractPlots(BREAKOUT_SOURCE)).toEqual([
      { index: 0, title: 'Upper' },
      { index: 1, title: 'Lower' },
      { index: 2, title: 'Breakout up' },
    ]);
  });

  it('tells a strategy from an indicator', () => {
    expect(scriptKind(null, BREAKOUT_SOURCE)).toBe('strategy');
    expect(scriptKind(null, '//@version=6\nindicator("RSI")\nplot(ta.rsi(close, 14))')).toBe(
      'indicator',
    );
    expect(
      scriptKind({ declaration: { kind: 'indicator', title: 'x' } } as any, BREAKOUT_SOURCE),
    ).toBe('indicator');
  });
});

describe('placeholders', () => {
  const plots = extractPlots(BREAKOUT_SOURCE);

  it('offers bar and plot placeholders everywhere and order-fill ones on order fills only', () => {
    const condition = placeholderGroupsFor('condition', plots).flatMap((g) =>
      g.items.map((i) => i.token),
    );
    expect(condition).toEqual(
      expect.arrayContaining(['{{ticker}}', '{{timenow}}', '{{plot_2}}', '{{plot("Lower")}}']),
    );
    expect(condition).not.toContain('{{strategy.order.action}}');
    const fills = placeholderGroupsFor('order-fills', plots).flatMap((g) =>
      g.items.map((i) => i.token),
    );
    expect(fills).toEqual(
      expect.arrayContaining([
        '{{strategy.order.action}}',
        '{{strategy.order.contracts}}',
        '{{strategy.order.price}}',
        '{{strategy.order.id}}',
        '{{strategy.order.comment}}',
        '{{strategy.order.alert_message}}',
        '{{strategy.market_position}}',
        '{{strategy.market_position_size}}',
        '{{strategy.prev_market_position}}',
        '{{strategy.prev_market_position_size}}',
        '{{strategy.position_size}}',
        '{{syminfo.currency}}',
        '{{syminfo.basecurrency}}',
      ]),
    );
  });

  it('flags tokens a row does not offer', () => {
    const groups = placeholderGroupsFor('condition', plots);
    expect(
      unknownPlaceholders('{{close}} {{clsoe}} {{plot_9}} {{strategy.order.price}}', groups, true),
    ).toEqual(['{{clsoe}}', '{{plot_9}}', '{{strategy.order.price}}']);
    // Plot references cannot be checked when the plots are unknown.
    expect(unknownPlaceholders('{{plot_9}}', placeholderGroupsFor('condition', []), false)).toEqual(
      [],
    );
  });

  it('inserts at the caret, replacing a selection', () => {
    expect(insertAt('Buy  now', 4, 4, '{{ticker}}')).toEqual({
      text: 'Buy {{ticker}} now',
      caret: 14,
    });
    expect(insertAt('Buy XXX now', 4, 7, '{{ticker}}')).toEqual({
      text: 'Buy {{ticker}} now',
      caret: 14,
    });
    expect(insertAt('', 10, 10, '{{close}}')).toEqual({ text: '{{close}}', caret: 9 });
  });
});

describe('checkWebhookUrl', () => {
  it('accepts https and flags http', () => {
    expect(checkWebhookUrl('https://hooks.example.com/a?b=1')).toEqual({
      error: null,
      warning: null,
    });
    expect(checkWebhookUrl('http://10.0.0.5:8080/hook').warning).toMatch(/unencrypted/);
  });

  it('rejects what cannot be a webhook', () => {
    expect(checkWebhookUrl('').error).toMatch(/required/);
    expect(checkWebhookUrl('hooks.example.com').error).toMatch(/full URL/);
    expect(checkWebhookUrl('ftp://x.com/a').error).toMatch(/http/);
    expect(checkWebhookUrl('https://a b.com').error).toMatch(/spaces/);
    expect(checkWebhookUrl('https://user:pw@x.com/').error).toMatch(/credentials/);
  });
});

describe('rows', () => {
  const scan = extractAlertConditions(BREAKOUT_SOURCE);

  it('builds a row per condition, then alert() calls and order fills, keeping orphans', () => {
    const rows = buildAlertRows(
      [
        { alertKey: 'Short breakout', enabled: true, channels: ['Telegram'], messageTemplate: 'S' },
        {
          alertKey: 'order-fills',
          enabled: true,
          channels: ['Webhook'],
          webhookUrl: 'https://x.io/h',
        },
        { alertKey: 'Old condition', enabled: true, channels: ['Email'] },
      ],
      scan.conditions,
      true,
    );
    expect(rows.map((r) => [r.alertKey, r.kind, r.enabled, r.orphan])).toEqual([
      ['Long breakout', 'condition', false, false],
      ['Short breakout', 'condition', true, false],
      ['alert()', 'alert-calls', false, false],
      ['order-fills', 'order-fills', true, false],
      ['Old condition', 'condition', true, true],
    ]);
    expect(rows[0].defaultMessage).toBe('Price broke above {{plot_0}}');
  });

  it('leaves order fills out for an indicator script', () => {
    const rows = buildAlertRows([], scan.conditions, false);
    expect(rows.map((r) => r.alertKey)).toEqual(['Long breakout', 'Short breakout', 'alert()']);
  });

  it('validates channels, webhook and template', () => {
    const groups = placeholderGroupsFor('condition', []);
    const row = buildAlertRows([], scan.conditions, true)[0];
    expect(validateRow({ ...row, enabled: true }, groups, true).errors).toEqual([
      'Choose at least one channel.',
    ]);
    expect(
      validateRow({ ...row, enabled: true, channels: ['Webhook'], webhookUrl: '' }, groups, true)
        .errors[0],
    ).toMatch(/required/);
    expect(
      validateRow({ ...row, channels: ['Email'], messageTemplate: '{{clsoe}}' }, groups, true)
        .warnings[0],
    ).toMatch(/clsoe/);
    // A disabled row may be left without channels.
    expect(validateRow(row, groups, true).errors).toEqual([]);
  });

  it('sends every row, dropping the webhook URL when Webhook is not a channel', () => {
    const rows: AlertRow[] = buildAlertRows([], scan.conditions, true).map((r, i) =>
      i === 0
        ? {
            ...r,
            enabled: true,
            channels: ['Email'],
            webhookUrl: 'https://left.over',
            messageTemplate: '  ',
          }
        : r,
    );
    const body = toAlertBindings(rows);
    expect(body).toHaveLength(4);
    expect(body[0]).toEqual({
      alertKey: 'Long breakout',
      enabled: true,
      channels: ['Email'],
      messageTemplate: null,
      webhookUrl: null,
      frequency: 'once_per_bar',
    });
    expect(alertRowsDiffer(rows, buildAlertRows([], scan.conditions, true))).toBe(true);
  });

  it('keeps each binding’s trigger, In app channel and the engine’s reason for switching it off', () => {
    const rows = buildAlertRows(
      [
        {
          alertKey: 'Long breakout',
          enabled: false,
          channels: ['InApp', 'Email'],
          frequency: 'ONCE_PER_BAR_CLOSE',
          disabledReason: 'Storm guard: 16 fires in 3 minutes.',
          disabledAt: '2026-10-09T08:15:00Z',
          lastDeliveryError: 'SMTP timeout',
        },
        {
          alertKey: 'Short breakout',
          enabled: true,
          channels: ['Telegram'],
          frequency: 'bogus',
          disabledReason: 'stale — it is on again',
        },
      ] as ScriptAlertBindingView[],
      scan.conditions,
      true,
    );
    expect(rows[0]).toMatchObject({
      channels: ['InApp', 'Email'],
      frequency: 'once_per_bar_close',
      disabledReason: 'Storm guard: 16 fires in 3 minutes.',
      lastDeliveryError: 'SMTP timeout',
    });
    // An unknown frequency reads as the engine's default; a reason never shows on an enabled binding.
    expect(rows[1]).toMatchObject({ frequency: 'once_per_bar', disabledReason: null });
    // Changing only the trigger is a change to save.
    const changed = rows.map((r, i) => (i === 0 ? { ...r, frequency: 'all' as const } : r));
    expect(alertRowsDiffer(rows, changed)).toBe(true);
    expect(toAlertBindings(changed)[0].frequency).toBe('all');
  });

  it('flags alertcondition rows of a strategy, which the engine does not send', () => {
    const [row] = buildAlertRows([], scan.conditions, true);
    expect(strategyConditionWarning({ ...row, enabled: true }, true)).toMatch(/does not send/);
    expect(strategyConditionWarning({ ...row, enabled: true }, false)).toBeNull();
    expect(strategyConditionWarning(row, true)).toBeNull();
  });
});

describe('channels', () => {
  const statuses: AlertChannelStatusDto[] = [
    {
      channel: 'InApp',
      isConfigured: true,
      isEnabled: true,
      destinationPreview: 'Admin UI',
      timeoutSeconds: 0,
    },
    {
      channel: 'Email',
      isConfigured: true,
      isEnabled: false,
      destinationPreview: 'a•••@x.com',
      timeoutSeconds: 30,
    },
    {
      channel: 'Webhook',
      isConfigured: false,
      isEnabled: true,
      destinationPreview: null,
      timeoutSeconds: 10,
    },
  ];

  it('describes each channel’s state', () => {
    expect(ALERT_CHANNELS).toEqual(['InApp', 'Email', 'Webhook', 'Telegram']);
    expect(ALERT_CHANNELS.map((c) => channelChip(c, statuses).state)).toEqual([
      'ready',
      'off',
      'unset',
      'unknown',
    ]);
    expect(channelChip('InApp', statuses).label).toBe('In app: ready');
    expect(channelChip('Email', null).state).toBe('unknown');
  });

  it('warns about chosen channels that will not deliver — not about a binding’s own webhook', () => {
    const scan = extractAlertConditions(BREAKOUT_SOURCE);
    const row = { ...buildAlertRows([], scan.conditions, true)[0], enabled: true };
    expect(channelWarnings({ ...row, channels: ['Email', 'InApp'] }, statuses)).toEqual([
      'Email is switched off — its deliveries will be recorded as not sent.',
    ]);
    expect(
      channelWarnings({ ...row, channels: ['Webhook'], webhookUrl: 'https://x.io/h' }, statuses),
    ).toEqual([]);
    expect(channelWarnings({ ...row, channels: ['Webhook'], webhookUrl: null }, statuses)).toEqual([
      'Webhook is not set up — its deliveries will be recorded as not sent.',
    ]);
    // A disabled row, or unknown statuses, warn about nothing.
    expect(channelWarnings({ ...row, enabled: false, channels: ['Email'] }, statuses)).toEqual([]);
    expect(channelWarnings({ ...row, channels: ['Email'] }, null)).toEqual([]);
  });

  it('describes the storm guard', () => {
    expect(stormGuardText({ maxFires: 15, windowMinutes: 3 })).toContain(
      'more than 15 times in 3 minutes',
    );
    expect(stormGuardText({ maxFires: 15, windowMinutes: 1 })).toContain('in 1 minute is');
    expect(stormGuardText({ maxFires: 0, windowMinutes: 3 })).toMatch(/off/);
    expect(normaliseFrequency(' Once ')).toBe('once');
    expect(normaliseFrequency(null)).toBe('once_per_bar');
  });
});

describe('test messages', () => {
  const scan = extractAlertConditions(BREAKOUT_SOURCE);
  const rows = buildAlertRows([], scan.conditions, true);
  const ctx = {
    symbol: 'gbpjpy',
    timeframe: 'H1',
    now: new Date('2026-10-09T08:42:17Z'),
    plots: extractPlots(BREAKOUT_SOURCE),
  };

  it('fills the placeholders with sample values, marked as a test', () => {
    // No template: the alertcondition's own message.
    expect(renderSampleMessage(rows[0], ctx)).toBe('[TEST] Price broke above 1.08500');
    const custom = {
      ...rows[1],
      messageTemplate:
        '{{ ticker }} {{interval}} {{syminfo.basecurrency}}/{{syminfo.currency}} c={{close}} t={{time}} now={{timenow}} {{plot("Lower")}} {{nope}}',
    };
    expect(renderSampleMessage(custom, ctx)).toBe(
      '[TEST] GBPJPY H1 GBP/JPY c=1.08542 t=2026-10-09T08:00:00Z now=2026-10-09T08:42:17Z 1.08500 {{nope}}',
    );
  });

  it('uses the engine’s order-fill text when the binding sets none, and the script’s text for alert() calls', () => {
    const fills = rows.find((r) => r.kind === 'order-fills')!;
    expect(renderSampleMessage(fills, ctx)).toBe(
      '[TEST] Order buy @ 1 filled on GBPJPY. New strategy position is 1',
    );
    const calls = rows.find((r) => r.kind === 'alert-calls')!;
    expect(renderSampleMessage({ ...calls, messageTemplate: 'ignored {{close}}' }, ctx)).toBe(
      '[TEST] Text the script passes to alert() on GBPJPY',
    );
  });

  it('stays within what the test endpoint accepts', () => {
    const long = { ...rows[0], messageTemplate: 'x'.repeat(2000) };
    const text = renderSampleMessage(long, ctx);
    expect(text).toHaveLength(MAX_TEST_MESSAGE_LENGTH);
    expect(text.endsWith('…')).toBe(true);
  });
});

describe('delivery log', () => {
  it('names outcomes and alert keys as the tab does', () => {
    expect(deliveryStatusLabel({ status: 'Delivered', attempts: 1 })).toBe('sent');
    expect(deliveryStatusLabel({ status: 'Skipped', attempts: 1 })).toBe('not sent');
    expect(deliveryStatusLabel({ status: 'Pending', attempts: 0 })).toBe('sending');
    expect(deliveryStatusLabel({ status: 'Pending', attempts: 2 })).toBe('retrying (attempt 3)');
    expect(deliveryStatusLabel({ status: 'Expired', attempts: 8 })).toBe('expired');
    expect(deliveryAlertTitle('order-fills')).toBe('Order fills');
    expect(deliveryAlertTitle('alert()')).toBe('alert() calls');
    expect(deliveryAlertTitle('Long breakout')).toBe('Long breakout');
  });
});
