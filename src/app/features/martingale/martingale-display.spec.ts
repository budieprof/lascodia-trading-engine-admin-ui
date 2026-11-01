import { describe, expect, it } from 'vitest';

import { chainMatchesQuery, chainStatusTone, nextRungVerdict } from './martingale-display';

const chain = {
  id: 44,
  tradingAccountId: 26,
  accountName: 'Zero',
  symbol: 'EURUSD',
  status: 'Open',
};

describe('chainMatchesQuery', () => {
  it('matches everything on an empty query', () => {
    expect(chainMatchesQuery(chain, '')).toBe(true);
    expect(chainMatchesQuery(chain, '   ')).toBe(true);
  });

  it('matches the chain id or account id exactly, with or without #', () => {
    expect(chainMatchesQuery(chain, '44')).toBe(true);
    expect(chainMatchesQuery(chain, '#44')).toBe(true);
    expect(chainMatchesQuery(chain, '#26')).toBe(true);
    expect(chainMatchesQuery(chain, '4')).toBe(false);
  });

  it('matches symbol and account name case-insensitively by substring', () => {
    expect(chainMatchesQuery(chain, 'eur')).toBe(true);
    expect(chainMatchesQuery(chain, 'ZER')).toBe(true);
    expect(chainMatchesQuery(chain, 'gbp')).toBe(false);
  });
});

describe('chainStatusTone', () => {
  it('maps each status to a tone', () => {
    expect(chainStatusTone('Open', false)).toBe('warn');
    expect(chainStatusTone('Recovered', false)).toBe('ok');
    expect(chainStatusTone('Abandoned', false)).toBe('bad');
    expect(chainStatusTone('Something', false)).toBe('muted');
  });

  it('reads an operator reset as neutral, not as a loss alarm', () => {
    expect(chainStatusTone('Abandoned', true)).toBe('muted');
  });
});

describe('nextRungVerdict', () => {
  const clear = { wouldAbandon: false, blockedBy: null, rungWillBeSkipped: false };

  it('is clear when nothing binds', () => {
    expect(nextRungVerdict(clear)).toEqual({ tone: 'ok', label: 'Clear to stake' });
  });

  it('applies abandon > blocked > skipped precedence', () => {
    expect(
      nextRungVerdict({
        wouldAbandon: true,
        blockedBy: 'an open position',
        rungWillBeSkipped: true,
      }).label,
    ).toBe('Would not stake');
    expect(
      nextRungVerdict({ ...clear, blockedBy: 'an open position', rungWillBeSkipped: true }).label,
    ).toBe('Blocked');
    expect(nextRungVerdict({ ...clear, rungWillBeSkipped: true }).label).toBe('Will not fit');
  });
});
