import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '@core/auth/auth.service';
import { NotificationService } from '@core/notifications/notification.service';
import { ensureTestBed } from '@core/testing/zoneless-test-bed';
import { OrganisationApiService } from './organisation-api.service';
import type { LlmUsageReport } from './organisation.types';
import { LlmPageComponent } from './pages/llm-page.component';

ensureTestBed();

const figures = {
  calls: 12,
  failedCalls: 1,
  refusedCalls: 0,
  tokensInput: 120_000,
  tokensOutput: 8_000,
  tokensCacheRead: 0,
  tokensCacheWrite: 0,
  costUsd: 3.2,
  notionalCostUsd: 3.2,
  platformPaidCostUsd: 3.2,
  ownKeyCostUsd: 0,
};

const report: LlmUsageReport = {
  tenantId: 5,
  from: '2026-10-01',
  to: '2026-10-20',
  asOfUtc: '2026-10-20T12:00:00Z',
  totals: figures,
  days: [{ ...figures, day: '2026-10-20' }],
  byModel: [{ ...figures, provider: 'anthropic', model: 'claude-sonnet', paidBy: 'Platform' }],
  budget: {
    dailyCapUsd: 5,
    monthlyCapUsd: 50,
    thresholdFraction: 0.9,
    spentTodayUsd: 1,
    spentThisMonthUsd: 3.2,
    assistantExemptFromDaily: false,
    blocked: false,
    reason: null,
    reasonCode: null,
    dailyResetsAtUtc: '2026-10-21T00:00:00Z',
    monthlyResetsAtUtc: '2026-11-01T00:00:00Z',
  },
  deepTier: { provider: 'anthropic', model: '', paidBy: 'Platform', ready: true, problem: null },
  quickTier: null,
};

function apiStub() {
  return {
    llmUsage: vi.fn(() => of(report)),
    tenantLlmKeys: vi.fn(() =>
      of([
        {
          provider: 'openai',
          hint: '…a1b2',
          updatedAtUtc: '2026-10-20T08:00:00Z',
          updatedBy: 'admin:3',
        },
      ]),
    ),
    storeTenantLlmKey: vi.fn(() =>
      of({
        provider: 'anthropic',
        hint: '…wxyz',
        updatedAtUtc: '2026-10-20T09:00:00Z',
        updatedBy: 'admin:3',
      }),
    ),
    removeTenantLlmKey: vi.fn(() => of(true)),
  };
}

let api: ReturnType<typeof apiStub>;
let notify: { error: ReturnType<typeof vi.fn>; success: ReturnType<typeof vi.fn> };

function setup(kind: string) {
  api = apiStub();
  notify = { error: vi.fn(), success: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
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

const page = () => TestBed.runInInjectionContext(() => new LlmPageComponent());

describe('LlmPageComponent', () => {
  beforeEach(() => setup('Customer'));

  it('shows this month against the budget and the tiers', () => {
    const p = page();
    expect(p.usageState()).toBe('ok');
    expect(p.monthly()).toMatchObject({ text: '$3.20 of $50.00', tone: 'ok' });
    expect(p.daily()?.percent).toBe(22);
    expect(p.thresholdPct()).toBe(90);
    expect(p.tiers().map((t) => t.name)).toEqual(['Deep analysis']);
    expect(p.keys().map((k) => k.provider)).toEqual(['openai']);
    expect(p.hasKey('openai')).toBe(true);
  });

  it('on an engine without the endpoints says "not available yet" for each section', () => {
    api.llmUsage.mockReturnValueOnce(
      throwError(() => new HttpErrorResponse({ status: 404, error: null })),
    );
    api.tenantLlmKeys.mockReturnValueOnce(
      throwError(() => new HttpErrorResponse({ status: 404, error: null })),
    );
    const p = page();
    expect(p.usageState()).toBe('missing');
    expect(p.keysState()).toBe('missing');
    expect(p.usage()).toBeNull();
  });

  it('tells a person without the key permission so, and still shows the usage', () => {
    api.tenantLlmKeys.mockReturnValueOnce(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 403,
            error: { status: false, message: 'Forbidden', responseCode: '-403' },
          }),
      ),
    );
    const p = page();
    expect(p.keysState()).toBe('forbidden');
    expect(p.usageState()).toBe('ok');
  });

  it('stores a key only when it is valid, clears it after, and never puts it in a message', () => {
    const p = page();
    p.apiKey.set('short');
    p.store();
    expect(api.storeTenantLlmKey).not.toHaveBeenCalled();
    expect(p.keyProblem()).toContain('20–512');

    const key = 'sk-ant-' + 'k'.repeat(40);
    p.apiKey.set(` ${key} `);
    p.store();
    expect(api.storeTenantLlmKey).toHaveBeenCalledWith('anthropic', key);
    expect(p.apiKey()).toBe('');
    expect(notify.success).toHaveBeenCalledWith('Anthropic key stored (…wxyz).');
    expect(JSON.stringify(notify.success.mock.calls)).not.toContain(key);
  });

  it('removes a key after confirming', () => {
    const p = page();
    p.removing.set(p.keys()[0]);
    p.remove();
    expect(api.removeTenantLlmKey).toHaveBeenCalledWith('openai');
    expect(p.removing()).toBeNull();
  });
});

describe('LlmPageComponent in House', () => {
  beforeEach(() => setup('House'));

  it('knows House stores no organisation key', () => {
    expect(page().isHouse()).toBe(true);
  });
});
