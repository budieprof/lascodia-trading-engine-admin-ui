import { describe, expect, it } from 'vitest';
import { CHANNEL_DEFS, deliveryPolicyFields } from './alerts-page.component';

// The delivery policy (engine Alert:Delivery:{Channel}:*, 2026-10-29). The defaults shown here must match the engine's
// compiled defaults (AlertDeliveryPolicyDefaults) — an unset key behaves as the engine default, and the card says which.
describe('alert channel delivery policy fields', () => {
  const fields = (channel: string) => CHANNEL_DEFS.find((d) => d.channel === channel)!.fields;
  const byKey = (channel: string, key: string) =>
    fields(channel).find((f) => f.key === `Alert:Delivery:${channel}:${key}`);

  it('puts the policy on every outbound channel but not on in-app', () => {
    for (const ch of ['Email', 'Webhook', 'Telegram']) {
      expect(byKey(ch, 'MinSeverity')?.type).toBe('select');
      expect(byKey(ch, 'DigestMinutes')?.type).toBe('number');
      expect(byKey(ch, 'Reminders')?.type).toBe('checkbox');
    }
    expect(fields('InApp')).toEqual([]);
  });

  it('shows the engine defaults: e-mail critical-now + hourly digest, others everything now', () => {
    expect(byKey('Email', 'MinSeverity')?.defaultValue).toBe('Medium');
    expect(byKey('Email', 'ImmediateMinSeverity')?.defaultValue).toBe('Critical');
    expect(byKey('Email', 'DigestMinutes')?.defaultValue).toBe('60');
    expect(byKey('Email', 'MaxPerHour')?.defaultValue).toBe('6');
    expect(byKey('Telegram', 'DigestMinutes')?.defaultValue).toBe('0');
    expect(byKey('Webhook', 'ImmediateMinSeverity')?.defaultValue).toBe('Info');
  });

  it('offers the four severities and never marks a policy field required', () => {
    const policy = deliveryPolicyFields('Email', { min: 'Medium', immediate: 'Critical', digest: 60, perHour: 6 });
    expect(policy.find((f) => f.type === 'select')?.options).toEqual(['Info', 'Medium', 'High', 'Critical']);
    expect(policy.some((f) => f.required)).toBe(false);
  });

  it('tells the operator plainly where the webhook URL goes and offers the platform mail service', () => {
    const webhook = CHANNEL_DEFS.find((d) => d.channel === 'Webhook')!;
    expect(webhook.description).toContain('Add the URL that should receive alerts here');
    expect(webhook.description).not.toContain('X-Lascodia-Secret');
    expect(fields('Email').some((f) => f.key === 'EmailAlertOptions:UsePlatformMailRelay')).toBe(true);
  });
});
