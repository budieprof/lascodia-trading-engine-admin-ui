import { HttpErrorResponse } from '@angular/common/http';
import { describe, expect, it } from 'vitest';

import { ApiError } from '@core/api/api.types';
import {
  QUOTA_RESPONSE_CODE,
  describeQuotaRefusal,
  isQuotaRefusal,
  quotaRefusalMessage,
  quotaRefusalOf,
  type QuotaRefusal,
} from './quota-refusal';

const refusal: QuotaRefusal = {
  quota: 'tradingAccounts',
  feature: null,
  limit: 2,
  used: 2,
  requested: 1,
  plan: 'Trial',
  planSlug: 'trial',
  tenantId: 7001,
};

const envelope = (data: unknown, message = 'engine says no') => ({
  data,
  status: false,
  message,
  responseCode: QUOTA_RESPONSE_CODE,
});

const http403 = (body: unknown) => new HttpErrorResponse({ status: 403, error: body });

describe('quota refusals', () => {
  it('reads the refusal from an HTTP error, an ApiError or a bare envelope', () => {
    expect(quotaRefusalOf(http403(envelope(refusal)))).toEqual(refusal);
    expect(
      quotaRefusalOf(new ApiError(QUOTA_RESPONSE_CODE, 'x', envelope(refusal) as never)),
    ).toEqual(refusal);
    expect(quotaRefusalOf(envelope(refusal))).toEqual(refusal);
    expect(isQuotaRefusal(http403(envelope(refusal)))).toBe(true);
  });

  it('ignores every other refusal', () => {
    const other = { data: null, status: false, message: 'No', responseCode: '-403' };
    expect(isQuotaRefusal(http403(other))).toBe(false);
    expect(quotaRefusalOf(http403(other))).toBeNull();
    expect(quotaRefusalMessage(http403(other))).toBeNull();
    expect(quotaRefusalMessage(new HttpErrorResponse({ status: 500 }))).toBeNull();
    expect(quotaRefusalMessage(null)).toBeNull();
  });

  it('says what the plan allows, what is in use and what to do', () => {
    expect(describeQuotaRefusal(refusal)).toBe(
      "Your organisation's plan (Trial) allows 2 trading accounts; 2 are in use. Free one up, or ask platform staff for a larger plan.",
    );
    expect(
      describeQuotaRefusal({ ...refusal, quota: 'activeEaInstances', limit: 1, used: 1 }),
    ).toContain('allows 1 connected EA terminals; 1 is in use.');
    expect(
      describeQuotaRefusal({ ...refusal, quota: 'strategies', limit: 10, used: 9, requested: 3 }),
    ).toContain('allows 10 strategies; 9 are in use and this would add 3.');
  });

  it('names the missing feature', () => {
    expect(
      describeQuotaRefusal({ ...refusal, quota: 'feature', feature: 'sso', limit: 0, used: 0 }),
    ).toBe(
      "Your organisation's plan (Trial) does not include single sign-on. Ask platform staff to move it to a plan that does.",
    );
    expect(
      describeQuotaRefusal({
        ...refusal,
        quota: 'feature',
        feature: 'personalAccessTokens',
        limit: 0,
        used: 0,
      }),
    ).toContain('does not include personal access tokens');
  });

  it('tells an organisation without a plan to ask for one', () => {
    expect(
      describeQuotaRefusal({ ...refusal, plan: '', planSlug: null, limit: 0, used: 0 }),
    ).toContain('has no plan');
  });

  it("falls back to the engine's sentence when the refusal carries no data", () => {
    expect(quotaRefusalMessage(http403(envelope(null)))).toBe('engine says no');
    expect(quotaRefusalMessage(http403(envelope({ unexpected: true }, '')))).toContain(
      'does not allow this',
    );
  });
});
