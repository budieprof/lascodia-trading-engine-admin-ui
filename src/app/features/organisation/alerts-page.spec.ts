import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '@core/auth/auth.service';
import { NotificationService } from '@core/notifications/notification.service';
import { ensureTestBed } from '@core/testing/zoneless-test-bed';
import { OrganisationApiService } from './organisation-api.service';
import type { AlertChannelSettings } from './organisation.types';
import { AlertsPageComponent } from './pages/alerts-page.component';

ensureTestBed();

const channel = (c: string, over: Partial<AlertChannelSettings> = {}): AlertChannelSettings => ({
  channel: c,
  source: 'not-set-up',
  id: null,
  enabled: false,
  destination: null,
  emailTo: null,
  telegramChatId: null,
  telegramBotTokenSet: false,
  webhookUrl: null,
  webhookSecretSet: false,
  webhookLegacySecretHeader: false,
  webhookSecretSetAtUtc: null,
  updatedAtUtc: null,
  updatedBy: null,
  ...over,
});

function apiStub() {
  return {
    alertChannels: vi.fn(() =>
      of([
        channel('Email', { source: 'organisation', id: 1, enabled: true, emailTo: 'desk@acme.io' }),
        channel('Webhook'),
        channel('Telegram'),
      ]),
    ),
    saveAlertChannel: vi.fn(() =>
      of({
        settings: channel('Webhook', { source: 'organisation' }),
        signingSecret: 'generated-secret-shown-once-0123456789',
      }),
    ),
    removeAlertChannel: vi.fn(() => of(true)),
    testAlertChannel: vi.fn(() =>
      of({
        channel: 'Email',
        delivered: true,
        destination: 'desk@acme.io',
        message: 'm',
        attemptedAt: '',
        reason: null,
      }),
    ),
    rotateWebhookSecret: vi.fn(() =>
      of({
        settings: channel('Webhook', { source: 'organisation' }),
        signingSecret: 'rotated-secret-0123456789abcdefghij',
      }),
    ),
  };
}

let api: ReturnType<typeof apiStub>;
let notify: { error: ReturnType<typeof vi.fn>; success: ReturnType<typeof vi.fn> };

function setup(kind: string) {
  api = apiStub();
  notify = { error: vi.fn(), success: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      // The delivery tiles read alert/channel/status; it goes to the testing backend and stays unanswered.
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: RUNTIME_CONFIG, useValue: { apiBaseUrl: 'http://engine.test' } },
      { provide: OrganisationApiService, useValue: api },
      { provide: NotificationService, useValue: notify },
      {
        provide: AuthService,
        useValue: {
          mode: 'bff',
          activeTenant: signal({ id: 5, slug: 'acme', name: 'Acme', kind }),
        },
      },
    ],
  });
}

afterEach(() => TestBed.resetTestingModule());

const page = () => TestBed.runInInjectionContext(() => new AlertsPageComponent());

describe('AlertsPageComponent', () => {
  beforeEach(() => setup('Customer'));

  it('loads the channels and prefills only the organisation’s own, non-secret values', () => {
    const p = page();
    expect(api.alertChannels).toHaveBeenCalledTimes(1);
    expect(p.draft('Email').emailTo).toBe('desk@acme.io');
    expect(p.draft('Webhook')).toMatchObject({ url: '', secret: '', enabled: true });
  });

  it('does not ask to save a channel with problems', () => {
    const p = page();
    p.startSave('Webhook');
    expect(p.confirmingSave()).toBeNull();
    expect(p.errors('Webhook')).toEqual(['Enter the webhook URL.']);
  });

  it('sets up a webhook after confirming and shows the generated signing secret once', () => {
    const p = page();
    p.patch('Webhook', { url: 'https://hooks.acme.io/lascodia' });
    p.startSave('Webhook');
    expect(p.confirmingSave()).toBe('Webhook');
    p.save();
    expect(api.saveAlertChannel).toHaveBeenCalledWith('Webhook', {
      enabled: true,
      webhookUrl: 'https://hooks.acme.io/lascodia',
      webhookLegacySecretHeader: false,
    });
    expect(p.secret()).toBe('generated-secret-shown-once-0123456789');
    expect(p.draft('Webhook').url).toBe('');
    expect(api.alertChannels).toHaveBeenCalledTimes(2);
  });

  it('rotates the signing secret after confirming', () => {
    const p = page();
    p.rotating.set(true);
    p.rotate();
    expect(api.rotateWebhookSecret).toHaveBeenCalledTimes(1);
    expect(p.secret()).toBe('rotated-secret-0123456789abcdefghij');
    expect(p.rotating()).toBe(false);
  });

  it('sends a test on one click and says what happened, including a throttle', () => {
    const p = page();
    p.test('Email');
    expect(api.testAlertChannel).toHaveBeenCalledWith('Email', null);
    expect(p.testResult()['Email']).toBe('Test alert sent to desk@acme.io.');

    api.testAlertChannel.mockReturnValueOnce(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 429,
            error: {
              status: false,
              message: 'A test was just sent on this channel. Wait 10 seconds between tests.',
              responseCode: '-429',
            },
          }),
      ),
    );
    p.test('Email');
    expect(p.testResult()['Email']).toContain('Wait 10 seconds');
  });

  it('removes a channel after confirming; an organisation other than House loses it outright', () => {
    const p = page();
    p.removing.set('Email');
    expect(p.removeMessage()).toContain('no longer sent');
    p.remove();
    expect(api.removeAlertChannel).toHaveBeenCalledWith('Email');
  });

  it('a step-up refusal is not reported as a failure', () => {
    const p = page();
    api.saveAlertChannel.mockReturnValueOnce(
      throwError(() => new HttpErrorResponse({ status: 401 })),
    );
    p.patch('Email', { emailTo: 'ops@acme.io' });
    p.startSave('Email');
    p.save();
    expect(notify.error).not.toHaveBeenCalled();
  });
});

describe('AlertsPageComponent in House', () => {
  beforeEach(() => setup('House'));

  it('says House’s alerts go back to the platform channel when its own is removed', () => {
    const p = page();
    p.removing.set('Email');
    expect(p.removeMessage()).toContain('back to the platform channel');
  });
});
