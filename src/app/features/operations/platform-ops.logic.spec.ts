import { describe, expect, it } from 'vitest';

import {
  expectedConfirmation,
  hostRequirements,
  isFinished,
  jobLine,
  leaderSummary,
  normaliseSetting,
  settingKind,
  shortImage,
  sizeText,
} from './platform-ops.logic';
import type {
  HostJob,
  PlatformColour,
  PlatformConfigValue,
  PlatformOps,
} from './platform-ops.types';

const colour = (name: string, state: string, leader = false): PlatformColour => ({
  name,
  state,
  leader,
  holder: name,
  fencingToken: leader ? 7 : null,
  leaderSinceUtc: null,
  draining: false,
  error: null,
});
const setting = (key: string, def: string): PlatformConfigValue => ({
  key,
  value: def,
  default: def,
  description: null,
  lastChangedBy: null,
  lastChangedAtUtc: null,
});

describe('platform ops logic', () => {
  it('confirms a deploy with the image id the engine checks', () => {
    const id = 'sha256:0123456789abcdef' + '0'.repeat(48);
    expect(shortImage(id)).toBe('0123456789ab');
    expect(expectedConfirmation(id, false)).toBe('DEPLOY 0123456789ab');
    expect(expectedConfirmation(null, true)).toBe('ROLLBACK');
  });

  it('summarises leadership honestly', () => {
    expect(
      leaderSummary([colour('api-blue', 'leader', true), colour('api-green', 'standby')]),
    ).toEqual({ text: 'api-blue leads · standby: api-green', tone: 'ok' });
    expect(
      leaderSummary([colour('api-blue', 'leader', true), colour('api-green', 'down')]).text,
    ).toContain('no standby running');
    expect(leaderSummary([colour('a', 'leader', true), colour('b', 'leader', true)]).tone).toBe(
      'bad',
    );
    expect(leaderSummary([colour('a', 'down'), colour('b', 'down')]).tone).toBe('warn');
  });

  it('lists what host actions need, with real status only', () => {
    const ops = {
      host: {
        configured: false,
        online: false,
        daemonId: '',
        daemonName: null,
        lastSeenAtUtc: null,
        status: null,
        statusAtUtc: null,
        statusJobId: null,
        statusError: null,
      },
    } as unknown as PlatformOps;
    const reqs = hostRequirements(ops);
    expect(reqs[0].ok).toBe(false);
    expect(reqs[1].ok).toBeNull(); // unknown until a daemon is named
    expect(reqs[3].ok).toBeNull(); // no host report: Caddy state unknown, never guessed
  });

  it('types and validates settings', () => {
    expect(settingKind(setting('Ops:ConsoleDeploy:Enabled', 'false'))).toBe('bool');
    expect(settingKind(setting('Ops:ConsoleDeploy:HighRiskMinutesBefore', '30'))).toBe('int');
    expect(settingKind(setting('Ops:HostDaemonId', ''))).toBe('text');
    expect(normaliseSetting(setting('x', 'false'), 'yes')).toEqual({ error: 'true or false' });
    expect(normaliseSetting(setting('x', '30'), ' 045 ')).toEqual({ value: '45' });
    expect(normaliseSetting(setting('x', '30'), '-1')).toHaveProperty('error');
  });

  it('formats jobs and sizes', () => {
    expect(isFinished('Claimed')).toBe(false);
    expect(isFinished('Expired')).toBe(true);
    expect(sizeText(1.5 * 1024 ** 3)).toBe('1.5 GB');
    const job = {
      type: 'HostDeployApi',
      status: 'Succeeded',
      params: { rollback: true },
      resultMessage: 'ok',
    } as unknown as HostJob;
    expect(jobLine(job)).toBe('Rollback — Succeeded: ok');
  });
});
