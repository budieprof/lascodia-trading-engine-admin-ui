import { parseProposalEnvelope } from './proposal-envelope';

describe('parseProposalEnvelope', () => {
  it('reads a Pine envelope', () => {
    const env = parseProposalEnvelope(
      JSON.stringify({
        name: 'N',
        description: 'D',
        symbol: 'EURUSD',
        timeframe: 'H1',
        script: '//@version=6\nstrategy("x")',
      }),
    );
    expect(env).toEqual({
      name: 'N',
      description: 'D',
      symbol: 'EURUSD',
      timeframe: 'H1',
      script: '//@version=6\nstrategy("x")',
    });
  });

  it('accepts PascalCase keys', () => {
    expect(parseProposalEnvelope('{"Script":"//@version=6","Timeframe":"M5"}')?.timeframe).toBe(
      'M5',
    );
  });

  it('is null for a legacy DSL proposal, malformed JSON or an empty script', () => {
    expect(parseProposalEnvelope('{"entryConditionsRoot":{"op":"And"}}')).toBeNull();
    expect(parseProposalEnvelope('{not json')).toBeNull();
    expect(parseProposalEnvelope('{"script":"  "}')).toBeNull();
    expect(parseProposalEnvelope('[]')).toBeNull();
    expect(parseProposalEnvelope(null)).toBeNull();
  });
});
