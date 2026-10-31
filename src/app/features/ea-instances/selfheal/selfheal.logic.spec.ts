import { describe, expect, it } from 'vitest';

import type { EADiag, EATerminalDto } from '@core/api/ea-selfheal.types';
import {
  RESTART_BADGED_INPUTS,
  RESTART_INPUTS,
  ackReason,
  actionCopy,
  ageSeconds,
  beaconSummary,
  buildSetInputs,
  commandStatusText,
  commandStatusTone,
  diagRows,
  formatBytes,
  formatDuration,
  healOutcomeText,
  healStepLabel,
  heartbeatFreshness,
  isFinalCommandStatus,
  isFinalJobStatus,
  jobStatusText,
  journalWarnings,
  parseUtcMs,
  requesterWords,
  sortProblems,
  terminalActionBlocker,
  validateInputEdit,
  verdictHeadline,
  verdictTone,
  wantsHealth,
  watchdogSummary,
} from './selfheal.logic';

const NOW = Date.parse('2026-10-31T12:00:00Z');

describe('time helpers', () => {
  it('reads engine timestamps as UTC with or without a zone', () => {
    expect(parseUtcMs('2026-10-31T11:59:00Z')).toBe(NOW - 60_000);
    expect(parseUtcMs('2026-10-31T11:59:00')).toBe(NOW - 60_000);
    expect(parseUtcMs('2026-10-31T12:59:00+01:00')).toBe(NOW - 60_000);
    expect(parseUtcMs('1970-01-01T00:00:00Z')).toBeNull(); // the EA's "never"
    expect(parseUtcMs('')).toBeNull();
    expect(parseUtcMs('garbage')).toBeNull();
  });

  it('formats durations for people', () => {
    expect(formatDuration(12)).toBe('12 s');
    expect(formatDuration(240)).toBe('4 min');
    expect(formatDuration(2 * 3600 + 5 * 60)).toBe('2 h 5 min');
    expect(formatDuration(3 * 3600)).toBe('3 h');
    expect(formatDuration(3 * 86400)).toBe('3 days');
    expect(formatDuration(null)).toBe('—');
  });

  it('ignores times far in the future (the EA clock-offset fault)', () => {
    expect(ageSeconds('2026-10-31T13:00:00Z', NOW)).toBeNull();
    expect(ageSeconds('2026-10-31T12:00:30Z', NOW)).toBe(0); // small skew clamps to 0
  });
});

describe('heartbeatFreshness', () => {
  it('is fresh inside the engine line and "last known" past it', () => {
    expect(heartbeatFreshness('2026-10-31T11:59:00Z', NOW)).toEqual({
      stale: false,
      ageSeconds: 60,
      label: '',
    });
    const old = heartbeatFreshness('2026-10-31T11:53:00Z', NOW);
    expect(old.stale).toBe(true);
    expect(old.label).toBe('last known (7 min ago)');
  });

  it('treats an unknown heartbeat as stale', () => {
    expect(heartbeatFreshness(null, NOW).stale).toBe(true);
  });
});

describe('verdict', () => {
  it.each([
    ['Healthy', 'ok'],
    ['Degraded', 'warn'],
    ['Down', 'bad'],
    ['Stopped', 'muted'],
    [undefined, 'muted'],
  ])('%s → %s', (v, tone) => expect(verdictTone(v)).toBe(tone));

  it('words the headline with the problem count', () => {
    expect(verdictHeadline('Degraded', 1)).toBe('Running, but one thing needs attention.');
    expect(verdictHeadline('Degraded', 3)).toBe('Running, but 3 things need attention.');
    expect(verdictHeadline('Down', 0)).toContain('not reporting');
  });

  it('sorts problems worst first and keeps the engine order within a severity', () => {
    const sorted = sortProblems([
      { code: 'a', severity: 'info' },
      { code: 'b', severity: 'error' },
      { code: 'c', severity: 'warning' },
      { code: 'd', severity: 'error' },
    ]);
    expect(sorted.map((p) => p.code)).toEqual(['b', 'd', 'c', 'a']);
  });
});

describe('commands', () => {
  it('knows which statuses are final', () => {
    expect(['Pending', 'Delivered'].map(isFinalCommandStatus)).toEqual([false, false]);
    expect(['Succeeded', 'Failed', 'Expired'].map(isFinalCommandStatus)).toEqual([true, true, true]);
    expect(['Pending', 'Claimed'].map(isFinalJobStatus)).toEqual([false, false]);
  });

  it('shows the EA\'s own reason for a failure', () => {
    expect(ackReason('Failed: template not seeded')).toBe('template not seeded');
    expect(
      commandStatusText({ status: 'Failed', ackResult: 'Failed: unknown input InpFoo' }),
    ).toBe('Failed — unknown input InpFoo');
    expect(commandStatusText({ status: 'Succeeded', ackResult: 'Success: not stopped' })).toBe(
      'Done — not stopped',
    );
    expect(commandStatusText({ status: 'Succeeded', ackResult: null })).toBe('Done.');
    expect(commandStatusText({ status: 'Expired', ackResult: null })).toContain('never picked it up');
    expect(commandStatusText({ status: 'Delivered', ackResult: null })).toContain('waiting for its answer');
    expect(commandStatusTone('Failed')).toBe('bad');
    expect(commandStatusTone('Pending')).toBe('pending');
  });

  it('names who sent a command', () => {
    expect(requesterWords('admin-user:5 (Ada Lovelace)')).toBe('Ada Lovelace');
    expect(requesterWords('system:auto-heal')).toBe('Auto-heal');
    expect(requesterWords('job:1234')).toBe('After a host job');
    expect(requesterWords(null)).toBe('engine');
  });
});

describe('host jobs', () => {
  it('describes each status in plain words', () => {
    expect(jobStatusText({ status: 'Pending', resultMessage: null, daemonName: 'mac2' })).toBe(
      'Waiting for the host (mac2) to pick it up.',
    );
    expect(jobStatusText({ status: 'Claimed', resultMessage: null, daemonName: '' })).toBe(
      'The host is working on it.',
    );
    expect(
      jobStatusText({ status: 'Failed', resultMessage: 'terminal did not stop', daemonName: '' }),
    ).toBe('Failed — terminal did not stop');
    expect(jobStatusText({ status: 'Expired', resultMessage: null, daemonName: '' })).toContain(
      'supervisor running',
    );
  });
});

describe('auto-heal timeline', () => {
  it('labels the ladder steps', () => {
    expect(healStepLabel({ rung: 1, action: 'ForceRecovery' })).toBe('Step 1 · Force recovery');
    expect(healStepLabel({ rung: 3, action: 'RestartTerminal' })).toBe('Step 3 · Restart the terminal');
    expect(healStepLabel({ rung: 5, action: 'GaveUp' })).toContain('Gave up');
    expect(healOutcomeText('DryRun')).toBe('Dry run — nothing was done');
    expect(healOutcomeText('Succeeded')).toBe('Worked');
  });
});

describe('diagRows', () => {
  const healthy: EADiag = {
    terminalConnected: true,
    terminalTradeAllowed: true,
    mqlTradeAllowed: true,
    dllsAllowed: false,
    restartTemplateSeeded: true,
    spawnTemplateSeeded: true,
    liveGateBlockedReason: '',
    recoveryFailed: false,
    recoveryFailedPhase: '',
    authRung: 'machine',
    authState: 'ok',
    deadLetterCount: 0,
    lastWebRequestError: 0,
    lastWebRequestErrorAtUtc: '',
    initDegraded: false,
    initRetryReason: '',
    diskBytesLascodia: 1024 * 1024 * 300,
    terminalBuild: 5834,
    accountLogin: 107699364,
    server: 'MetaQuotes-Demo',
  };

  it('is empty without a diag block (older EA)', () => {
    expect(diagRows(null, NOW)).toEqual([]);
  });

  it('shows nothing red for a healthy EA (DLLs off is information, not a fault)', () => {
    const rows = diagRows(healthy, NOW);
    expect(rows.filter((r) => r.tone === 'bad' || r.tone === 'warn')).toEqual([]);
    expect(rows.find((r) => r.key === 'dllsAllowed')?.tone).toBe('muted');
    expect(rows.find((r) => r.key === 'auth')?.value).toBe('Signed in · using its own machine credential');
    expect(rows.find((r) => r.key === 'terminal')?.value).toBe(
      'login 107699364 · MetaQuotes-Demo · MT5 build 5834',
    );
  });

  it('explains the WebRequest allowlist error and how to fix it', () => {
    const rows = diagRows(
      { ...healthy, lastWebRequestError: 4014, lastWebRequestErrorAtUtc: '2026-10-31T11:58:00Z' },
      NOW,
    );
    const row = rows.find((r) => r.key === 'webRequest')!;
    expect(row.tone).toBe('bad');
    expect(row.value).toBe("The engine's address is not in MT5's allowed list (2 min ago)");
    expect(row.hint).toContain('Allow WebRequest');
  });

  it('flags a failed recovery, a blocked live gate and a missing restart template', () => {
    const rows = diagRows(
      {
        ...healthy,
        recoveryFailed: true,
        recoveryFailedPhase: 'positions',
        liveGateBlockedReason: 'symbol specs not loaded',
        restartTemplateSeeded: false,
        authState: 'dead',
        deadLetterCount: 3,
      },
      NOW,
    );
    const by = (k: string) => rows.find((r) => r.key === k)!;
    expect(by('recovery').value).toBe('Failed at "positions"');
    expect(by('recovery').hint).toContain('Force recovery');
    expect(by('liveGate').value).toBe('No — symbol specs not loaded');
    expect(by('restartTemplateSeeded').tone).toBe('warn');
    expect(by('auth').tone).toBe('bad');
    expect(by('deadLetters').value).toBe('3 waiting');
  });

  it('warns when the EA folder passes 5 GB', () => {
    const rows = diagRows({ ...healthy, diskBytesLascodia: 6 * 1024 ** 3 }, NOW);
    expect(rows.find((r) => r.key === 'disk')).toMatchObject({ value: '6.0 GB', tone: 'warn' });
  });
});

describe('formatBytes', () => {
  it.each([
    [512, '512 B'],
    [2048, '2.0 KB'],
    [5.5 * 1024 ** 3, '5.5 GB'],
    [12 * 1024 ** 3, '12 GB'],
  ])('%s → %s', (n, s) => expect(formatBytes(n)).toBe(s));
});

describe('terminal card', () => {
  it('summarises a beacon', () => {
    expect(beaconSummary(null, NOW).tone).toBe('muted');
    expect(beaconSummary({ phase: 'running', lastTimerUtc: '2026-10-31T11:59:40Z' }, NOW)).toEqual({
      text: 'Alive — last cycle 20 s ago',
      tone: 'ok',
    });
    expect(beaconSummary({ phase: 'running', lastTimerUtc: '2026-10-31T11:50:00Z' }, NOW).tone).toBe(
      'bad',
    );
    expect(
      beaconSummary({ phase: 'init_failed', initFailReason: 'bad inputs', lastTimerUtc: '2026-10-31T11:59:00Z' }, NOW)
        .text,
    ).toBe('Start-up failed — bad inputs (1 min ago)');
  });

  it('summarises the watchdog', () => {
    expect(watchdogSummary({ state: 'ok', restartsLastHour: 0 }, NOW)).toEqual({ text: 'Watching', tone: 'ok' });
    expect(watchdogSummary({ state: 'gave_up', restartsLastHour: 3 }, NOW).text).toBe(
      'Gave up restarting — needs an operator · 3 restarts in the last hour',
    );
    expect(
      watchdogSummary({ state: 'backoff', nextAttemptUtc: '2026-10-31T12:02:00Z' }, NOW).text,
    ).toBe('Waiting before retrying — next try in 2 min');
  });

  it('turns journal signals into sentences', () => {
    expect(journalWarnings({ oldTick: false, invalidBook: true, debuggerFound: true })).toHaveLength(2);
    expect(journalWarnings(null)).toEqual([]);
  });

  it('blocks terminal buttons when nothing can carry them out', () => {
    const base = {
      linkedBy: 'beacon',
      installId: 'exness',
      daemonOnline: true,
      daemonName: 'laptop',
    } as EATerminalDto;
    expect(terminalActionBlocker(base)).toBeNull();
    expect(terminalActionBlocker({ ...base, daemonOnline: false })).toContain('"laptop" is offline');
    expect(terminalActionBlocker({ ...base, linkedBy: 'none' })).toContain('No supervised terminal');
    expect(terminalActionBlocker(null)).not.toBeNull();
  });

  it('says that Stop keeps the terminal stopped and needs a reason', () => {
    const copy = actionCopy('terminal/stop', { installName: 'exness' });
    expect(copy.warning).toContain('will NOT start it again');
    expect(copy.reasonRequired).toBe(true);
    expect(copy.tone).toBe('bad');
    expect(actionCopy('deploy', { version: '8.47.259' }).confirmLabel).toBe('Update to 8.47.259');
  });
});

describe('restart-required inputs (SetInputs)', () => {
  it('uses the EA input names', () => {
    const names = RESTART_INPUTS.map((d) => d.inp);
    expect(names).toContain('InpEngineBaseUrl');
    expect(names).toContain('InpMagicNumber');
    expect(names.every((n) => /^Inp[A-Z]\w+$/.test(n))).toBe(true);
    // The one name that does not follow the envelope key.
    expect(RESTART_BADGED_INPUTS['enableChartPanel'].inp).toBe('InpEnableChartPanel');
  });

  it('marks the inputs that can cut the EA off as dangerous', () => {
    const dangerous = RESTART_INPUTS.filter((d) => d.dangerous).map((d) => d.key);
    expect(dangerous.sort()).toEqual(['engineBaseUrl', 'magicNumber']);
  });

  it('validates like the EA does', () => {
    expect(validateInputEdit({ type: 'i' }, '12')).toBeNull();
    expect(validateInputEdit({ type: 'i' }, '1.5')).toBe('Enter a whole number.');
    expect(validateInputEdit({ type: 'd' }, 'abc')).toBe('Enter a number.');
    expect(validateInputEdit({ type: 's' }, 'a\nb')).toBe('Line breaks are not allowed.');
    expect(validateInputEdit({ type: 's' }, 'x'.repeat(513))).toBe('At most 512 characters.');
  });

  it('sends only changed values, typed, under the EA names', () => {
    const current = { magicNumber: 1000, timeframes: 'H1', useAsyncOrders: true, dllBridgePort: 9000 };
    const out = buildSetInputs(
      RESTART_INPUTS,
      { magicNumber: '2000', timeframes: 'H1', useAsyncOrders: false, dllBridgePort: '', instanceLabel: 'east' },
      current,
    );
    expect(out.errors).toEqual({});
    expect(out.inputs).toEqual({ InpMagicNumber: 2000, InpUseAsyncOrders: false, InpInstanceLabel: 'east' });
    expect(out.changed.sort()).toEqual(['instanceLabel', 'magicNumber', 'useAsyncOrders']);
  });

  it('reports invalid values and sends nothing for them', () => {
    const out = buildSetInputs(RESTART_INPUTS, { coordinatorStaleSec: '3.5' }, { coordinatorStaleSec: 30 });
    expect(out.inputs).toEqual({});
    expect(out.errors).toEqual({ coordinatorStaleSec: 'Enter a whole number.' });
  });

  it('accepts the restart-badged map form', () => {
    const out = buildSetInputs(RESTART_BADGED_INPUTS, { tickBufferMax: '5000' }, { tickBufferMax: 1000 });
    expect(out.inputs).toEqual({ InpTickBufferMax: 5000 });
  });
});

describe('wantsHealth', () => {
  it('asks only for recent, registered instances', () => {
    expect(wantsHealth({ status: 'Active', lastHeartbeat: '2026-10-31T11:59:00Z' }, NOW)).toBe(true);
    expect(wantsHealth({ status: 'Disconnected', lastHeartbeat: '2026-10-01T00:00:00Z' }, NOW)).toBe(false);
    expect(
      wantsHealth(
        { status: 'ShuttingDown', lastHeartbeat: '2026-10-31T11:00:00Z', deregisteredAt: '2026-10-31T11:00:00Z' },
        NOW,
      ),
    ).toBe(false);
  });
});
