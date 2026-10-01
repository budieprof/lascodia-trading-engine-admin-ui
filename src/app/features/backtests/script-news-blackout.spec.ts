import { describe, expect, it } from 'vitest';

import { scriptNewsBlackoutOf, summarizeNewsBlackout } from './script-news-blackout';

const result = (newsBlackout: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ Trades: [], report: {}, script: { costModel: 'Pine', newsBlackout }, ...extra });

const applied = {
  applied: true,
  exempt: false,
  modelled: true,
  minutesBefore: 30,
  minutesAfter: 15,
  explanation: 'HighImpactEventInTtl=Enforce, PostEventBlackout=Enforce',
  events: 42,
  blockedEntries: 3,
};

describe('scriptNewsBlackoutOf', () => {
  it('reads script.newsBlackout off a script run', () => {
    expect(scriptNewsBlackoutOf(result(applied))).toEqual(applied);
  });

  it('is null on older runs, non-script runs and bad payloads', () => {
    expect(
      scriptNewsBlackoutOf(JSON.stringify({ Trades: [], script: { costModel: 'Pine' } })),
    ).toBeNull();
    expect(scriptNewsBlackoutOf(JSON.stringify({ Trades: [] }))).toBeNull();
    expect(scriptNewsBlackoutOf(result(null))).toBeNull();
    expect(scriptNewsBlackoutOf('not json')).toBeNull();
    expect(scriptNewsBlackoutOf('[1,2]')).toBeNull();
    expect(scriptNewsBlackoutOf(null)).toBeNull();
    expect(scriptNewsBlackoutOf('')).toBeNull();
  });

  it('tolerates PascalCase and missing or odd fields', () => {
    const nb = scriptNewsBlackoutOf(
      JSON.stringify({ Script: { NewsBlackout: { Applied: true, Modelled: true, Events: '7' } } }),
    );
    expect(nb).toEqual({
      applied: true,
      exempt: false,
      modelled: true,
      minutesBefore: 0,
      minutesAfter: 0,
      explanation: '',
      events: 0,
      blockedEntries: 0,
    });
  });
});

describe('summarizeNewsBlackout', () => {
  it('states the window, the events and the entries removed when applied', () => {
    const s = summarizeNewsBlackout(applied);
    expect(s.tone).toBe('applied');
    expect(s.status).toBe('Applied');
    expect(s.window).toBe('30 min before / 15 min after');
    expect(s.effect).toBe(
      'Modelled as live applies it around 42 High-impact events: 3 entries live would refuse were removed.',
    );
    expect(s.reportNote).toContain('Strategy report includes them');
    expect(s.explanation).toContain('HighImpactEventInTtl=Enforce');
  });

  it('says so when nothing fell inside the window', () => {
    const s = summarizeNewsBlackout({ ...applied, events: 1, blockedEntries: 0 });
    expect(s.effect).toBe(
      'Modelled as live applies it around 1 High-impact event: no entry fell inside it.',
    );
    expect(s.reportNote).toBeNull();
    expect(summarizeNewsBlackout({ ...applied, blockedEntries: 1 }).effect).toContain(
      '1 entry live would refuse was removed',
    );
  });

  it('says an exempt strategy kept its entries', () => {
    const s = summarizeNewsBlackout({
      ...applied,
      applied: false,
      exempt: true,
      minutesBefore: 0,
      minutesAfter: 0,
      events: 0,
      blockedEntries: 0,
      explanation: 'the strategy is news-blackout exempt (Strategy.NewsBlackoutExempt …)',
    });
    expect(s.tone).toBe('exempt');
    expect(s.status).toBe('Exempt');
    expect(s.window).toBeNull();
    expect(s.effect).toContain('news-blackout exempt');
  });

  it('says the blackout was off, or not modelled', () => {
    const off = summarizeNewsBlackout({
      ...applied,
      applied: false,
      minutesBefore: 0,
      minutesAfter: 0,
      events: 0,
      blockedEntries: 0,
      explanation: 'news blocking is off on the Viability Gates page',
    });
    expect(off.tone).toBe('off');
    expect(off.effect).toContain('live applies none either');
    expect(off.window).toBeNull();

    const unmodelled = summarizeNewsBlackout({ ...applied, modelled: false, applied: false });
    expect(unmodelled.tone).toBe('unmodelled');
    expect(unmodelled.status).toBe('Not modelled');
  });
});
