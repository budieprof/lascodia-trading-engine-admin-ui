import { HttpErrorResponse } from '@angular/common/http';
import { describe, expect, it } from 'vitest';

import { ApiError } from '@core/api/api.types';
import {
  ENTITLEMENT_RESPONSE_CODE,
  entitlementRefusalMessage,
  isEntitlementRefusal,
} from './entitlement-refusal';

describe('entitlement refusals', () => {
  const body = {
    status: false,
    responseCode: ENTITLEMENT_RESPONSE_CODE,
    message:
      "Your organisation is not entitled to the 'cme-l2' feed (CME futures depth (MBP-10 book)).",
    data: null,
  };

  it('reads the engine reason from an HTTP 403, an ApiError or the envelope', () => {
    const http = new HttpErrorResponse({ status: 403, error: body });
    const api = new ApiError(ENTITLEMENT_RESPONSE_CODE, body.message, body as never);
    for (const err of [http, api, body]) {
      expect(isEntitlementRefusal(err)).toBe(true);
      expect(entitlementRefusalMessage(err)).toBe(body.message);
    }
  });

  it('says nothing about other refusals and errors', () => {
    expect(
      entitlementRefusalMessage(
        new HttpErrorResponse({ status: 403, error: { responseCode: '-403', message: 'x' } }),
      ),
    ).toBeNull();
    expect(entitlementRefusalMessage(new Error('boom'))).toBeNull();
    expect(entitlementRefusalMessage(null)).toBeNull();
  });

  it('falls back to a plain sentence when the engine sent no reason', () => {
    expect(
      entitlementRefusalMessage({ responseCode: ENTITLEMENT_RESPONSE_CODE, message: ' ' }),
    ).toBe('Your organisation is not entitled to this market-data feed.');
  });
});
