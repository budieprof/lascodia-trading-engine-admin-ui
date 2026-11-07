import { describe, expect, it } from 'vitest';

import {
  NON_EVIDENCE_QUEUE_SOURCES,
  QUEUE_SOURCE_LABELS,
  evidenceInvalidation,
  invalidatedBadgeHtml,
  isEvidenceRun,
  queueSourceHint,
  queueSourceLabel,
} from './run-provenance';

describe('queue source labels', () => {
  it('names every engine ValidationQueueSource, including the strategy program sources', () => {
    expect(queueSourceLabel('EvidenceRefresh')).toBe('Evidence refresh');
    expect(queueSourceLabel('LabReproduction')).toBe('Lab reproduction');
    expect(queueSourceLabel('ValidationPipeline')).toBe('Validation pipeline');
    expect(queueSourceLabel('ParityReconcile')).toBe('Parity reconcile');
    expect(queueSourceLabel('OptimizationFollowUp')).toBe('Optimization follow-up');
    expect(Object.keys(QUEUE_SOURCE_LABELS)).toHaveLength(11);
  });

  it('reads a numeric enum from an older build and shows an unknown name as sent', () => {
    expect(queueSourceLabel(8)).toBe('Evidence refresh');
    expect(queueSourceLabel(10)).toBe('Validation pipeline');
    expect(queueSourceLabel('SomethingNew')).toBe('SomethingNew');
    expect(queueSourceLabel(42)).toBe('42');
    expect(queueSourceLabel(null)).toBe('—');
    expect(queueSourceLabel('')).toBe('—');
  });

  it('explains the sources whose name is not enough', () => {
    expect(queueSourceHint('LabReproduction')).toContain('never promotion evidence');
    expect(queueSourceHint('Manual')).toBe('');
    expect(queueSourceHint(null)).toBe('');
  });
});

describe('evidence', () => {
  it('keeps parity reconciles and lab reproductions out of evidence', () => {
    expect([...NON_EVIDENCE_QUEUE_SOURCES].sort()).toEqual(['LabReproduction', 'ParityReconcile']);
    expect(isEvidenceRun({ queueSource: 'ParityReconcile' })).toBe(false);
    expect(isEvidenceRun({ queueSource: 'LabReproduction' })).toBe(false);
    expect(isEvidenceRun({ queueSource: 'EvidenceRefresh' })).toBe(true);
    expect(isEvidenceRun({ queueSource: 'ValidationPipeline' })).toBe(true);
    expect(isEvidenceRun({ queueSource: null })).toBe(true);
    expect(isEvidenceRun(null)).toBe(false);
  });

  it('reads the invalidation fields and degrades when they are absent', () => {
    expect(evidenceInvalidation({})).toBeNull();
    expect(evidenceInvalidation({ evidenceInvalidatedReason: '   ' })).toBeNull();
    expect(
      evidenceInvalidation({
        evidenceInvalidatedReason: 'Money converted at rate 1',
        evidenceInvalidatedAtUtc: '2026-11-07T12:00:00Z',
      }),
    ).toEqual({ reason: 'Money converted at rate 1', atUtc: '2026-11-07T12:00:00Z' });
    expect(isEvidenceRun({ queueSource: 'Manual', evidenceInvalidatedReason: 'x' })).toBe(false);
  });

  it('draws an escaped grid badge only for an invalidated run', () => {
    expect(invalidatedBadgeHtml({})).toBe('');
    expect(invalidatedBadgeHtml(undefined)).toBe('');
    const html = invalidatedBadgeHtml({ evidenceInvalidatedReason: 'rate 1 on <USDJPY> & "co"' });
    expect(html).toContain('>Excluded</span>');
    expect(html).toContain('title="Excluded from evidence: rate 1 on &lt;USDJPY&gt; &amp; &quot;co&quot;"');
  });
});
