import { describe, expect, it } from 'vitest';

import {
  budgetError,
  budgetWarning,
  checkHeaders,
  findingCounts,
  parseCsp,
  rejectShare,
  scriptSources,
  sortFindings,
} from './security-posture.logic';
import type { SecurityFinding } from './security-posture.types';

const LIVE_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; frame-ancestors 'none'; base-uri 'self'";
const PROPOSED_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; frame-ancestors 'none'; base-uri 'self'; object-src 'none'";

function headers(map: Record<string, string>) {
  return (name: string) => map[name.toLowerCase()] ?? null;
}

const good = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'content-security-policy': PROPOSED_CSP,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

describe('security posture logic', () => {
  it('parses a CSP and falls back to default-src for scripts', () => {
    const csp = parseCsp("default-src 'self' https:; img-src data:");
    expect(csp.get('img-src')).toEqual(['data:']);
    expect(scriptSources(csp)).toEqual(["'self'", 'https:']);
    expect(scriptSources(parseCsp(''))).toBeNull();
  });

  it('passes the proposed edge policy over https', () => {
    const checks = checkHeaders(headers(good), true);
    expect(checks.map((c) => c.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(checks[1].note).toContain('residue');
  });

  it("flags today's live edge: one-day HSTS and inline script", () => {
    const checks = checkHeaders(
      headers({
        ...good,
        'strict-transport-security': 'max-age=86400',
        'content-security-policy': LIVE_CSP,
      }),
      true,
    );
    expect(checks[0].status).toBe('weak');
    expect(checks[0].note).toContain('1 days');
    expect(checks[0].note).toContain('no includeSubDomains');
    expect(checks[1].status).toBe('weak');
    expect(checks[1].note).toContain("'unsafe-inline'");
  });

  it('does not judge HSTS over plain http, and reports missing headers', () => {
    const checks = checkHeaders(headers({}), false);
    expect(checks[0].status).toBe('na');
    expect(checks.slice(1).every((c) => c.status === 'missing')).toBe(true);
  });

  it('requires framing to be refused by the CSP', () => {
    const csp = checkHeaders(
      headers({ ...good, 'content-security-policy': "default-src 'self'" }),
      true,
    )[1];
    expect(csp.status).toBe('weak');
    expect(csp.note).toContain('framing');
  });

  it('validates budgets as whole numbers in range', () => {
    const key = { min: 1, max: 1_000_000 };
    expect(budgetError('1200', key)).toBeNull();
    expect(budgetError(' 30 ', key)).toBeNull();
    expect(budgetError('0', key)).toContain('Between 1');
    expect(budgetError('12.5', key)).toContain('whole number');
    expect(budgetError('', key)).toContain('whole number');
    expect(budgetError('2000000', key)).toContain('1,000,000');
  });

  it('warns when a budget is below twice the observed rate', () => {
    const now = Date.parse('2026-11-01T12:00:00Z');
    const since = '2026-11-01T11:00:00Z';
    const ea = {
      name: 'ea',
      partition: '',
      applies: '',
      counted: 60_000,
      rejected: 0,
      endpoints: 40,
    };
    expect(budgetWarning(1500, ea, since, now)).toContain('~1000 requests/min');
    expect(budgetWarning(10_000, ea, since, now)).toBeNull();
    expect(budgetWarning(10, undefined, since, now)).toBeNull();
  });

  it('formats the refused share', () => {
    expect(rejectShare({ counted: 0, rejected: 0 })).toBe('—');
    expect(rejectShare({ counted: 200, rejected: 3 })).toBe('1.5%');
  });

  it('orders findings open → operator → fixed, most severe first', () => {
    const f = (
      id: string,
      severity: SecurityFinding['severity'],
      status: SecurityFinding['status'],
    ): SecurityFinding => ({
      id,
      severity,
      status,
      title: id,
      area: '',
      remedy: '',
    });
    const sorted = sortFindings([
      f('A', 'High', 'Fixed'),
      f('B', 'Low', 'Open'),
      f('C', 'Medium', 'Operator'),
      f('D', 'High', 'Open'),
    ]);
    expect(sorted.map((x) => x.id)).toEqual(['D', 'B', 'C', 'A']);
    expect(findingCounts(sorted)).toEqual({ open: 2, operator: 1, fixed: 1 });
  });
});
