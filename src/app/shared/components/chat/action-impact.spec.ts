import { describe, expect, it } from 'vitest';
import { describeAction, humaniseBody, longTextFields } from './action-impact';

const BASE = '/api/v1/lascodia-trading-engine';

describe('describeAction — Pine script strategies', () => {
  it('flags account bindings as the dangerous one', () => {
    const a = describeAction('PUT', `${BASE}/strategy/42/account-bindings`);
    expect(a.severity).toBe('danger');
    expect(a.verb).toMatch(/accounts/);
  });

  it('names a script save, not a generic strategy change', () => {
    expect(describeAction('PUT', `${BASE}/strategy/42/script`).verb).toMatch(/Pine script/);
  });

  it('keeps alert routing apart from a script save', () => {
    expect(describeAction('PUT', `${BASE}/strategy/42/script/alerts`).severity).toBe('info');
  });

  it('recognises import, paper trading and approval', () => {
    expect(describeAction('POST', `${BASE}/strategy/import`).verb).toMatch(/from a script/);
    expect(describeAction('PUT', `${BASE}/strategy/42/start-paper-trading`).severity).toBe('info');
    expect(describeAction('POST', `${BASE}/strategy/42/submit-for-approval`).subject).toMatch(
      /auto-activate/,
    );
  });

  it('still describes activate as a status change', () => {
    expect(describeAction('PUT', `${BASE}/strategy/42/activate`).verb).toBe(
      'Change strategy status',
    );
  });
});

describe('long text in a request body', () => {
  const body = {
    id: 42,
    source: '//@version=6\nstrategy("x")\nplot(close)',
    changeReason: 'tighter stop',
  };

  it('summarises a script in the rows instead of dumping it', () => {
    const rows = humaniseBody(body);
    expect(rows.find((r) => r.label === 'Source')?.value).toBe(
      '3 lines of text — shown in full below',
    );
    expect(rows.find((r) => r.label === 'Change reason')?.value).toBe('tighter stop');
  });

  it('returns the script unescaped for its own block', () => {
    expect(longTextFields(body)).toEqual([{ label: 'Source', text: body.source, lines: 3 }]);
  });
});
