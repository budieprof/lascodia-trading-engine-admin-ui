import { describe, expect, it } from 'vitest';

import {
  DRAFT_ACTIVATION_HINT,
  PAPER_ACTIVATION_HINT,
  activationRefusalMessage,
  isDraftActivationRefusal,
} from './activation';

const DRAFT_REFUSAL =
  'Strategy must reach Approved lifecycle stage before activation. Current stage: Draft';
const ENGINE_DRAFT_REFUSAL =
  'Strategy 5 is a Draft and cannot be activated. Submit it for approval first with POST strategy/5/submit-for-approval';
const ENGINE_PAPER_REFUSAL =
  'Strategy 8 is paper trading (the paper-only stage) and cannot be activated yet. Submit it for approval with POST strategy/8/submit-for-approval';

describe('activation refusals', () => {
  it("recognises the engine's refusal for a Draft, by message or by stage", () => {
    expect(isDraftActivationRefusal(DRAFT_REFUSAL)).toBe(true);
    expect(isDraftActivationRefusal(ENGINE_DRAFT_REFUSAL)).toBe(true);
    expect(isDraftActivationRefusal('Promotion gates failed: CPCV', 'Draft')).toBe(true);
    expect(
      isDraftActivationRefusal(
        'Strategy must reach Approved lifecycle stage before activation. Current stage: ShadowLive',
      ),
    ).toBe(false);
    expect(isDraftActivationRefusal('Promotion gates failed: CPCV', 'Approved')).toBe(false);
    expect(isDraftActivationRefusal(null)).toBe(false);
  });

  it('recognises a paper-trading script the same way — it is submitted from its paper stage', () => {
    expect(isDraftActivationRefusal(ENGINE_PAPER_REFUSAL)).toBe(true);
    expect(isDraftActivationRefusal('anything', 'PaperTrading')).toBe(true);
    expect(activationRefusalMessage(ENGINE_PAPER_REFUSAL)).toBe(
      `${ENGINE_PAPER_REFUSAL} — ${PAPER_ACTIVATION_HINT}`,
    );
    expect(activationRefusalMessage('Refused', 'PaperTrading')).toBe(
      `Refused — ${PAPER_ACTIVATION_HINT}`,
    );
    expect(PAPER_ACTIVATION_HINT).toContain('Submit for approval');
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
