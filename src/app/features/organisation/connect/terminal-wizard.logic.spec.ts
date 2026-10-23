import { describe, expect, it } from 'vitest';

import {
  allowListEntry,
  connectBlocker,
  engineBaseUrl,
  isInsecureRemote,
  isSettled,
  nextPollMs,
  presetFileName,
  presetText,
  stageHeadline,
} from './terminal-wizard.logic';
import type { EnrollmentProgress, TerminalSetup } from './terminal-wizard.types';

const setup = (over: Partial<TerminalSetup> = {}): TerminalSetup => ({
  engineBaseUrl: '',
  apiPath: '/api/v1/lascodia-trading-engine',
  eaDownloadUrl: '',
  eaMinimumVersion: '8.47.253',
  enrollmentTokenInput: 'InpEnrollmentToken',
  engineUrlInput: 'InpEngineBaseUrl',
  enrollmentTokenHours: 24,
  demoAccountsOnly: true,
  showcaseOrganisation: false,
  maxTerminals: null,
  terminalsInUse: 0,
  maxTradingAccounts: null,
  heartbeatTimeoutSeconds: 60,
  ...over,
});

const progress = (stage: string): EnrollmentProgress =>
  ({ stage, connected: stage === 'connected', steps: [], hints: [] }) as unknown as EnrollmentProgress;

describe('terminal wizard', () => {
  it('uses the configured engine address, else the console origin + the API path', () => {
    expect(engineBaseUrl(setup({ engineBaseUrl: 'https://eng.example.com/api/v1/lascodia-trading-engine/' }), 'https://x')).toBe(
      'https://eng.example.com/api/v1/lascodia-trading-engine',
    );
    expect(engineBaseUrl(setup(), 'https://app.example.com/')).toBe(
      'https://app.example.com/api/v1/lascodia-trading-engine',
    );
    expect(engineBaseUrl(null, 'http://localhost:4200')).toBe(
      'http://localhost:4200/api/v1/lascodia-trading-engine',
    );
  });

  it('allow-lists the origin, which MT5 matches by prefix', () => {
    expect(allowListEntry('https://app.example.com/api/v1/lascodia-trading-engine')).toBe('https://app.example.com');
    expect(allowListEntry('http://192.168.1.4:5081/api/v1/x')).toBe('http://192.168.1.4:5081');
    expect(allowListEntry('not a url')).toBe('not a url');
  });

  it('warns about plain http to a public host only', () => {
    expect(isInsecureRemote('http://app.example.com/api')).toBe(true);
    expect(isInsecureRemote('http://127.0.0.1:5081/api')).toBe(false);
    expect(isInsecureRemote('http://10.0.0.4/api')).toBe(false);
    expect(isInsecureRemote('https://app.example.com/api')).toBe(false);
  });

  it('builds a preset holding only the two connection inputs, one per line', () => {
    const text = presetText('https://e.example/api/v1/lascodia-trading-engine', 'lsc_enr_ab_cd', 'Office\nPC', new Date('2026-10-23T12:00:00Z'));
    const lines = text.split('\r\n');
    expect(lines).toContain('InpEngineBaseUrl=https://e.example/api/v1/lascodia-trading-engine');
    expect(lines).toContain('InpEnrollmentToken=lsc_enr_ab_cd');
    expect(lines.filter((l) => l && !l.startsWith(';'))).toHaveLength(2);
    expect(text).toContain('Office PC');
    expect(presetFileName('Office PC — EURUSD!')).toBe('lascodia-office-pc-eurusd.set');
    expect(presetFileName('   ')).toBe('lascodia-terminal.set');
  });

  it('polls quickly while the terminal is on its way and stops when settled', () => {
    expect(nextPollMs(null, 0)).toBe(3_000);
    expect(nextPollMs(progress('waiting-for-terminal'), 10_000)).toBe(3_000);
    expect(nextPollMs(progress('waiting-for-terminal'), 300_000)).toBe(10_000);
    expect(nextPollMs(progress('registered'), 300_000)).toBe(3_000);
    expect(nextPollMs(progress('connected'), 0)).toBe(15_000);
    expect(nextPollMs(progress('token-expired'), 0)).toBeNull();
    expect(nextPollMs(progress('credential-revoked'), 0)).toBeNull();
    expect(isSettled('refused')).toBe(false);
  });

  it('names every stage in plain words with a tone', () => {
    expect(stageHeadline('connected').tone).toBe('ok');
    expect(stageHeadline('stale').tone).toBe('warn');
    expect(stageHeadline('refused').tone).toBe('bad');
    expect(stageHeadline('waiting-for-terminal').text).toMatch(/Waiting/);
  });

  it('blocks the showcase organisation and a full plan', () => {
    expect(connectBlocker(setup())).toBeNull();
    expect(connectBlocker(setup({ showcaseOrganisation: true }))).toMatch(/never trades/);
    expect(connectBlocker(setup({ maxTerminals: 2, terminalsInUse: 2 }))).toMatch(/allows 2/);
    expect(connectBlocker(null)).toBeNull();
  });
});
