import { describe, expect, it } from 'vitest';

import { delayedCaption } from '@core/realtime/marketdata-stream';
import {
  classifyAnswers,
  declarationBody,
  declarationErrors,
  emptyGrantDraft,
  grantBody,
  invalidPlanFeeds,
  isValidFeedId,
  subscriberTypeLabel,
  updateBody,
  usagesText,
} from './md-entitlements.logic';
import type { DeclarationQuestion } from './md-entitlements.types';

/** Multi-asset WS8 (exchange licensing): mirrors of the engine's rules the console applies before asking. */
describe('exchange licensing logic', () => {
  const questions: DeclarationQuestion[] = [
    { key: 'personalUse', text: '?', professionalWhen: false },
    { key: 'registered', text: '?', professionalWhen: true },
  ];

  it('accepts the exchange catalog feed ids like the engine', () => {
    for (const id of [
      'cme-l1',
      'ice-trades',
      'eurex-l2',
      'us-equities-nbbo',
      'us-equities-depth:xnas',
      'crypto:binance',
    ])
      expect(isValidFeedId(id)).toBe(true);
    for (const id of ['us-equities-depth:', 'us-equities-depth:toolongvenue', 'ice-l3'])
      expect(isValidFeedId(id)).toBe(false);
    expect(invalidPlanFeeds('crypto:*, us-equities-depth:*, cme-l1')).toEqual([]);
  });

  it('carries the delayed flag in grant and update bodies', () => {
    const d = { ...emptyGrantDraft(7), feedId: 'CME-L2', delayed: true, reason: 'contract' };
    expect(grantBody(d).delayed).toBe(true);
    expect(updateBody(d).delayed).toBe(true);
    expect(emptyGrantDraft().delayed).toBe(false);
    expect(usagesText({ display: true, nonDisplay: false, delayed: true, delayMinutes: 10 })).toBe(
      'Display only, delayed 10 min',
    );
    expect(usagesText({ display: true, nonDisplay: true })).toBe('Display + non-display');
  });

  it('classifies answers conservatively, like the engine', () => {
    expect(classifyAnswers(questions, { personalUse: true, registered: false }, false)).toBe(
      'NonProfessional',
    );
    expect(classifyAnswers(questions, { personalUse: false, registered: false }, false)).toBe(
      'Professional',
    );
    expect(classifyAnswers(questions, { personalUse: true, registered: true }, false)).toBe(
      'Professional',
    );
    expect(classifyAnswers(questions, { personalUse: true, registered: false }, true)).toBe(
      'Professional',
    );
    expect(classifyAnswers(questions, { personalUse: true }, false)).toBeNull();
  });

  it('refuses an incomplete declaration and builds the body', () => {
    const draft = {
      answers: { personalUse: true, registered: null },
      selfDeclaredProfessional: false,
      signedName: ' ',
      attest: false,
    };
    expect(declarationErrors(questions, draft)).toHaveLength(3);
    const ok = {
      answers: { personalUse: true, registered: false },
      selfDeclaredProfessional: false,
      signedName: ' Ada ',
      attest: true,
    };
    expect(declarationErrors(questions, ok)).toEqual([]);
    expect(declarationBody('cme-group', questions, ok)).toEqual({
      exchangeFamily: 'cme-group',
      answers: { personalUse: true, registered: false },
      selfDeclaredProfessional: false,
      signedName: 'Ada',
      attest: true,
    });
  });

  it('labels subscriber types and delayed captions', () => {
    expect(subscriberTypeLabel('undeclared')).toContain('professional');
    expect(subscriberTypeLabel('NonProfessional')).toBe('Non-professional');
    expect(delayedCaption([])).toBeNull();
    expect(delayedCaption([0, null, undefined])).toBeNull();
    expect(delayedCaption([10, 15])).toBe('Delayed 15 min');
  });
});
