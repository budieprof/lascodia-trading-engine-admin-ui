import { describe, expect, it } from 'vitest';

import {
  alertRowsDiffer,
  buildAlertRows,
  checkWebhookUrl,
  extractAlertConditions,
  extractPlots,
  insertAt,
  placeholderGroupsFor,
  scanCalls,
  scriptKind,
  stringLiteral,
  toAlertBindings,
  unknownPlaceholders,
  validateRow,
  type AlertRow,
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
    });
    expect(alertRowsDiffer(rows, buildAlertRows([], scan.conditions, true))).toBe(true);
  });
});
