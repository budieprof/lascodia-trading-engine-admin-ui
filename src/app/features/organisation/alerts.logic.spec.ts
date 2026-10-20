import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import type { AlertChannelSettings } from './organisation.types';
import {
  RECEIVER_NODE,
  RECEIVER_PYTHON,
  channelErrors,
  draftFor,
  houseTakeoverNotice,
  recipients,
  saveBody,
  sourceText,
  testText,
} from './alerts.logic';

const row = (over: Partial<AlertChannelSettings> = {}): AlertChannelSettings => ({
  channel: 'Webhook',
  source: 'organisation',
  id: 1,
  enabled: true,
  destination: 'https://hooks.example.com',
  emailTo: null,
  telegramChatId: null,
  telegramBotTokenSet: false,
  webhookUrl: 'https://hooks.example.com',
  webhookSecretSet: true,
  webhookLegacySecretHeader: false,
  webhookSecretSetAtUtc: null,
  updatedAtUtc: null,
  updatedBy: null,
  ...over,
});

describe('channel sources', () => {
  it('says whose channel it is, and warns House before it takes a channel over', () => {
    expect(sourceText(row())).toBe("The organisation's own channel");
    expect(sourceText(row({ enabled: false }))).toContain('switched off');
    expect(sourceText(row({ source: 'platform-default' }))).toContain("platform's channel");
    expect(sourceText(undefined)).toContain('Not set up');
    expect(houseTakeoverNotice(row({ source: 'platform-default' }))).toContain(
      'sends them here instead',
    );
    expect(houseTakeoverNotice(row())).toBeNull();
  });

  it('never prefills the platform’s values or any secret', () => {
    expect(draftFor(row({ source: 'platform-default', emailTo: 'ops@house.test' })).emailTo).toBe(
      '',
    );
    const own = draftFor(
      row({ channel: 'Telegram', telegramChatId: '@desk_alerts', telegramBotTokenSet: true }),
    );
    expect(own).toMatchObject({ chatId: '@desk_alerts', botToken: '', url: '', secret: '' });
  });
});

describe('validation (mirrors the engine)', () => {
  it('checks e-mail recipients', () => {
    expect(recipients('a@x.io; b@y.io, a@x.io')).toEqual(['a@x.io', 'b@y.io']);
    const d = draftFor(undefined);
    expect(channelErrors('Email', { ...d, emailTo: '' }, undefined)).toEqual([
      'Enter at least one e-mail address.',
    ]);
    expect(channelErrors('Email', { ...d, emailTo: 'a@x.io, nope' }, undefined)).toEqual([
      "'nope' is not an e-mail address.",
    ]);
    expect(
      channelErrors(
        'Email',
        { ...d, emailTo: 'a@x.io,b@x.io,c@x.io,d@x.io,e@x.io,f@x.io' },
        undefined,
      ),
    ).toEqual(['At most 5 e-mail addresses.']);
  });

  it('checks the Telegram chat and needs a token unless one is stored', () => {
    const d = draftFor(undefined);
    expect(channelErrors('Telegram', { ...d, chatId: 'desk' }, undefined)).toEqual([
      'Enter the chat id (e.g. -1001234567890) or the channel name (e.g. @my_alerts).',
      'Enter the bot token @BotFather issued.',
    ]);
    expect(
      channelErrors('Telegram', { ...d, chatId: '-1001234567890', botToken: 'abc' }, undefined),
    ).toEqual([
      'That is not a Telegram bot token (it looks like 123456789:AA…, as @BotFather issued it).',
    ]);
    expect(
      channelErrors(
        'Telegram',
        { ...d, chatId: '@desk_alerts' },
        row({ channel: 'Telegram', telegramBotTokenSet: true }),
      ),
    ).toEqual([]);
  });

  it('checks the webhook: https only, a URL unless one is stored, a secret of 32–256', () => {
    const d = draftFor(undefined);
    expect(channelErrors('Webhook', d, undefined)).toEqual(['Enter the webhook URL.']);
    expect(
      channelErrors('Webhook', { ...d, url: 'http://hooks.example.com' }, undefined)[0],
    ).toContain('https URL');
    expect(
      channelErrors('Webhook', { ...d, url: 'https://user:pw@hooks.example.com' }, undefined)[0],
    ).toContain('without a user name');
    expect(channelErrors('Webhook', { ...d, secret: 'short' }, row())[0]).toContain('32–256');
    expect(channelErrors('Webhook', d, row())).toEqual([]);
  });
});

describe('request bodies', () => {
  it('sends secrets only when typed, and normalised recipients', () => {
    const d = draftFor(undefined);
    expect(saveBody('Email', { ...d, emailTo: 'a@x.io;b@y.io' })).toEqual({
      enabled: true,
      emailTo: 'a@x.io, b@y.io',
    });
    expect(saveBody('Telegram', { ...d, chatId: ' @desk_alerts ' })).toEqual({
      enabled: true,
      telegramChatId: '@desk_alerts',
    });
    expect(
      saveBody('Webhook', { ...d, url: ' https://h.example.com/x ', legacyHeader: false }),
    ).toEqual({
      enabled: true,
      webhookUrl: 'https://h.example.com/x',
      webhookLegacySecretHeader: false,
    });
  });

  it('reports a test in one sentence', () => {
    const base = { channel: 'Email', destination: 'a@x.io', message: 'm', attemptedAt: '' };
    expect(testText({ ...base, delivered: true, reason: null })).toBe('Test alert sent to a@x.io.');
    expect(testText({ ...base, delivered: false, reason: 'switched off' })).toBe(
      'Not sent: switched off.',
    );
  });
});

describe('receiver samples', () => {
  it('compute the documented signature (test vector of WebhookSignatureTests)', () => {
    const secret = 'whsec-test-0123456789abcdefghijklmnop';
    const body = '{"alertId":7,"symbol":"EURUSD","alertType":"PriceLevel","message":"m"}';
    const ts = '1760000000';
    const sig = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
    expect(sig).toBe('e0fcbc3365c4de1ba9ba0bfdc5dee783ec73846b0bffd9e0b6270140b3903a9f');
  });

  it('the Node sample accepts a fresh, correctly signed delivery and nothing else', () => {
    const verify = new Function('require', `${RECEIVER_NODE}; return verify;`)(
      createRequire(import.meta.url),
    ) as (secret: string, ts: string, header: string, body: Buffer, tolerance?: number) => boolean;
    const secret = 'whsec-test-0123456789abcdefghijklmnop';
    const body = Buffer.from(
      '{"alertId":7,"symbol":"EURUSD","alertType":"PriceLevel","message":"m"}',
    );
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac('sha256', secret)
      .update(Buffer.concat([Buffer.from(`${ts}.`), body]))
      .digest('hex');
    expect(verify(secret, ts, `v1=${sig}`, body)).toBe(true);
    expect(verify(secret, ts, `v1=deadbeef, v1=${sig}`, body)).toBe(true); // rotation: any value
    expect(verify(secret, ts, `v1=${sig.replace(/^./, sig[0] === 'a' ? 'b' : 'a')}`, body)).toBe(
      false,
    );
    expect(verify(secret, '1760000000', `v1=${sig}`, body)).toBe(false); // outside five minutes
    expect(verify(secret, ts, '', body)).toBe(false);
  });

  it('the Python sample uses the same construction', () => {
    expect(RECEIVER_PYTHON).toContain('timestamp.encode() + b"." + raw_body, hashlib.sha256');
    expect(RECEIVER_PYTHON).toContain('compare_digest');
    expect(RECEIVER_PYTHON).toContain('tolerance=300');
  });
});
