import { describe, expect, it } from 'vitest';

import {
  DRAFT_ACTIVATION_HINT,
  activationRefusalMessage,
  isDraftActivationRefusal,
} from './activation';

const DRAFT_REFUSAL =
  'Strategy must reach Approved lifecycle stage before activation. Current stage: Draft';

describe('activation refusals', () => {
  it("recognises the engine's refusal for a Draft, by message or by stage", () => {
    expect(isDraftActivationRefusal(DRAFT_REFUSAL)).toBe(true);
    expect(isDraftActivationRefusal('Promotion gates failed: CPCV', 'Draft')).toBe(true);
    expect(
      isDraftActivationRefusal(
        'Strategy must reach Approved lifecycle stage before activation. Current stage: ShadowLive',
      ),
    ).toBe(false);
    expect(isDraftActivationRefusal('Promotion gates failed: CPCV', 'Approved')).toBe(false);
    expect(isDraftActivationRefusal(null)).toBe(false);
  });

  it('points a Draft at "Submit for approval" and leaves other refusals alone', () => {
    expect(activationRefusalMessage(DRAFT_REFUSAL)).toBe(
      `${DRAFT_REFUSAL} — ${DRAFT_ACTIVATION_HINT}`,
    );
    expect(DRAFT_ACTIVATION_HINT).toContain('Submit for approval');
    expect(activationRefusalMessage('Promotion gates failed: DSR', 'Approved')).toBe(
      'Promotion gates failed: DSR',
    );
  });
});
