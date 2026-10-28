import { describe, expect, it } from 'vitest';

import {
  compareVersions,
  countBySeverity,
  evidencePeriodProblem,
  filterReleases,
  findingLabel,
  shortHash,
  signOffProblem,
  sortFindings,
  staleTotal,
  terminalsByVersion,
} from './security.logic';
import type { AccessReviewCampaign, ReleaseNote, ReviewFinding } from './security.types';

const campaign = (over: Partial<AccessReviewCampaign> = {}): AccessReviewCampaign => ({
  id: 1,
  period: '2026-Q4',
  periodStartUtc: '2026-10-01T00:00:00Z',
  status: 'Open',
  generatedAtUtc: '2026-10-01T06:00:00Z',
  generatedBy: 'system:access-review',
  snapshotSha256: 'a'.repeat(64),
  peopleCount: 4,
  stalePeopleCount: 1,
  grantCount: 5,
  staleGrantCount: 2,
  privilegedGrantCount: 1,
  machineIdentityCount: 3,
  staleMachineIdentityCount: 1,
  apiTokenCount: 1,
  staleApiTokenCount: 0,
  signedOffAtUtc: null,
  signedOffBy: null,
  signedOffByName: null,
  signOffNotes: null,
  ...over,
});

describe('security logic', () => {
  it('orders findings high → medium → low and counts them', () => {
    const f: ReviewFinding[] = [
      { severity: 'low', kind: 'grant-expiring', subject: 'b', detail: '' },
      { severity: 'high', kind: 'stale-privileged-grant', subject: 'a', detail: '' },
      { severity: 'medium', kind: 'stale-grant', subject: 'c', detail: '' },
    ];
    expect(sortFindings(f).map((x) => x.severity)).toEqual(['high', 'medium', 'low']);
    expect(countBySeverity(f)).toEqual({ high: 1, medium: 1, low: 1 });
    expect(findingLabel('stale-machine-identity')).toBe('Unused terminal credential');
    expect(findingLabel('something-new')).toBe('something-new');
  });

  it('adds up everything stale the reviewer decides on', () => {
    expect(staleTotal(campaign())).toBe(4);
  });

  it('refuses a sign-off without a statement, on a signed-off review, or with unacknowledged high findings', () => {
    expect(signOffProblem(null, 'x'.repeat(20), false, 0)).toMatch(/Open a review/);
    expect(signOffProblem(campaign({ status: 'SignedOff' }), 'x'.repeat(20), true, 0)).toMatch(
      /already signed off/,
    );
    expect(signOffProblem(campaign(), 'too short', true, 0)).toMatch(/at least 10/);
    expect(signOffProblem(campaign(), 'Reviewed everything, revoked two.', false, 2)).toMatch(
      /high finding/,
    );
    expect(signOffProblem(campaign(), 'Reviewed everything, revoked two.', true, 2)).toBeNull();
    expect(signOffProblem(campaign(), 'Reviewed everything, nothing stale.', false, 0)).toBeNull();
  });

  it('shortens hashes for display', () => {
    expect(shortHash('0123456789abcdef0123456789abcdef')).toBe('01234567…89abcdef');
    expect(shortHash(null)).toBe('—');
  });

  it('filters release notes by component, newest first', () => {
    const note = (id: number, component: ReleaseNote['component'], at: string): ReleaseNote => ({
      id,
      component,
      version: String(id),
      releasedAtUtc: at,
      fromRef: null,
      toRef: 'x',
      commitCount: 1,
      summary: '',
      hasBreakingChanges: false,
      hasSecurityFixes: false,
      sections: [],
      publishedBy: '',
      publishedAtUtc: at,
    });
    const notes = [
      note(1, 'engine', '2026-10-01'),
      note(2, 'ea', '2026-10-03'),
      note(3, 'engine', '2026-10-05'),
    ];
    expect(filterReleases(notes, null).map((n) => n.id)).toEqual([3, 2, 1]);
    expect(filterReleases(notes, 'engine').map((n) => n.id)).toEqual([3, 1]);
  });

  it('checks the evidence period like the engine (from ≤ to, at most 800 days)', () => {
    expect(evidencePeriodProblem('2026-01-01', '2026-12-31')).toBeNull();
    expect(evidencePeriodProblem('2026-12-31', '2026-01-01')).toMatch(/before/);
    expect(evidencePeriodProblem('2023-01-01', '2026-01-01')).toMatch(/800/);
    expect(evidencePeriodProblem('', '2026-01-01')).toMatch(/both/);
  });
});

describe('EA versions', () => {
  it('compares dotted versions numerically', () => {
    expect(compareVersions('8.47.256', '8.47.99')).toBeGreaterThan(0);
    expect(compareVersions('8.47.253', '8.47.253')).toBe(0);
    expect(compareVersions('8.46', '8.47.1')).toBeLessThan(0);
  });

  it('counts active terminals per version against the latest and minimum', () => {
    const out = terminalsByVersion(
      [
        { eaVersion: '8.47.256', status: 'Active' },
        { eaVersion: '8.47.256', status: 'Active' },
        { eaVersion: '8.47.250', status: 'Active' },
        { eaVersion: '8.47.256', status: 'Disconnected' },
        { eaVersion: '', status: 'Active' },
      ],
      '8.47.256',
      '8.47.253',
    );
    expect(out).toEqual([
      { version: '8.47.256', terminals: 2, isLatest: true, belowMinimum: false },
      { version: '8.47.250', terminals: 1, isLatest: false, belowMinimum: true },
      { version: 'unknown', terminals: 1, isLatest: false, belowMinimum: false },
    ]);
  });
});
