import { describe, expect, it } from 'vitest';

import {
  anyAllowListProblem,
  daemonHeadline,
  detectOs,
  eaStatus,
  expiresInText,
  installAccountText,
  installCommand,
  installNeedsAction,
  installRunningText,
  isAllDone,
  isDaemonSettled,
  nextDaemonPollMs,
  openShellSteps,
  osAvailability,
} from './add-computer.logic';
import type {
  DaemonEaProgress,
  DaemonInstallProgress,
  SupervisorPlatformBundle,
  SupervisorSetup,
} from './add-computer.types';
import type { EnrollmentProgress } from './terminal-wizard.types';

const base = 'https://app.example.com/api/v1/lascodia-trading-engine';

function bundle(platform: string, available: boolean): SupervisorPlatformBundle {
  return { platform, label: platform, available, version: available ? '0.4.0' : null, sizeBytes: null, publishedAtUtc: null };
}

function setup(over: Partial<SupervisorSetup> = {}): SupervisorSetup {
  return {
    apiBaseUrl: base,
    installShUrl: `${base}/onboarding/supervisor/install.sh`,
    installPs1Url: `${base}/onboarding/supervisor/install.ps1`,
    macCommandTemplate: `curl -fsSL ${base}/onboarding/supervisor/install.sh | sh -s -- {token}`,
    windowsCommandTemplate: `& ([scriptblock]::Create((irm ${base}/onboarding/supervisor/install.ps1))) {token}`,
    webRequestAllowUrl: 'https://app.example.com',
    platforms: [bundle('macos-arm64', true), bundle('macos-x86_64', true), bundle('windows-x64', true)],
    autoUpdate: true,
    enrollmentTokenHours: 24,
    ...over,
  };
}

function ea(over: Partial<DaemonEaProgress> = {}): DaemonEaProgress {
  return {
    instanceId: 'LASC-1',
    heartbeating: true,
    lastHeartbeatUtc: null,
    eaVersion: '8.47.260',
    state: 'RUNNING',
    webRequestBlocked: false,
    webRequestSuspected: false,
    algoTradingOff: false,
    eaTradingNotAllowed: false,
    beaconPhase: 'running',
    beaconFresh: true,
    authState: 'ok',
    linkedBy: 'beacon',
    status: 'ok',
    ...over,
  };
}

function install(eas: DaemonEaProgress[], over: Partial<DaemonInstallProgress> = {}): DaemonInstallProgress {
  return {
    installId: 'wine-mt5-default',
    name: 'MetaTrader 5',
    broker: 'MetaQuotes-Demo',
    login: '107699364',
    running: true,
    managed: true,
    desiredState: 'Running',
    watchdogState: 'ok',
    eaInstances: eas,
    ...over,
  };
}

function progress(stage: string, installs: DaemonInstallProgress[] | null = null): EnrollmentProgress {
  return {
    tokenId: 9,
    label: 'Office Mac',
    kind: 'Daemon',
    tokenStatus: stage === 'waiting' ? 'Pending' : 'Used',
    createdAtUtc: '2026-11-01T10:00:00Z',
    expiresAtUtc: '2026-11-02T10:00:00Z',
    stage,
    connected: stage === 'reporting',
    lastRefusedAtUtc: null,
    lastRefusalReason: null,
    credentialId: null,
    instanceId: null,
    credentialLastUsedAtUtc: null,
    tradingAccountId: null,
    accountLogin: null,
    brokerServer: null,
    accountType: null,
    instanceStatus: null,
    lastHeartbeatUtc: null,
    secondsSinceHeartbeat: null,
    eaVersion: null,
    eaState: null,
    symbols: [],
    heartbeatTimeoutSeconds: 60,
    serverTimeUtc: '2026-11-01T10:05:00Z',
    steps: [],
    hints: [],
    daemon:
      installs === null
        ? null
        : {
            daemonId: 'office-mac-ab12',
            daemonRowId: 3,
            name: 'Office Mac',
            online: true,
            lastSeenAtUtc: null,
            registeredAtUtc: null,
            supervisorVersion: '0.4.0',
            platform: 'macos-arm64',
            installs,
          },
  };
}

describe('add a computer — choosing the computer', () => {
  it('guesses the OS from the browser, and says nothing for phones', () => {
    expect(detectOs({ userAgentData: { platform: 'macOS' } })).toBe('macos');
    expect(detectOs({ platform: 'MacIntel', userAgent: '' })).toBe('macos');
    expect(detectOs({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })).toBe('windows');
    expect(detectOs({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' })).toBeNull();
    expect(detectOs({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })).toBeNull();
    expect(detectOs(null)).toBeNull();
  });

  it('builds the one line from the engine template with the install code in it', () => {
    expect(installCommand(setup(), 'macos', 'lsc_enr_abc_DEF')).toBe(
      `curl -fsSL ${base}/onboarding/supervisor/install.sh | sh -s -- lsc_enr_abc_DEF`,
    );
    expect(installCommand(setup(), 'windows', 'lsc_enr_abc_DEF')).toBe(
      `& ([scriptblock]::Create((irm ${base}/onboarding/supervisor/install.ps1))) lsc_enr_abc_DEF`,
    );
    expect(installCommand(null, 'macos', 'x')).toBeNull();
    expect(installCommand(setup(), 'macos', '')).toBeNull();
  });

  it('refuses an OS with no published installer and names a missing Mac architecture', () => {
    const noWindows = setup({ platforms: [bundle('macos-arm64', true), bundle('macos-x86_64', false), bundle('windows-x64', false)] });
    expect(osAvailability(noWindows, 'windows').available).toBe(false);
    expect(osAvailability(noWindows, 'windows').note).toContain('has not been published');
    const mac = osAvailability(noWindows, 'macos');
    expect(mac.available).toBe(true);
    expect(mac.note).toContain('macos-x86_64');
    expect(osAvailability(setup(), 'macos')).toEqual({ available: true, note: null });
    expect(osAvailability(null, 'macos').available).toBe(false);
  });

  it('tells a first-timer how to open the window to paste into', () => {
    expect(openShellSteps('macos')[0]).toContain('Terminal');
    expect(openShellSteps('windows')[0]).toContain('PowerShell');
  });

  it('counts down to the expiry and says when it has passed', () => {
    const now = Date.parse('2026-11-01T10:00:00Z');
    expect(expiresInText('2026-11-02T09:40:00Z', now)).toEqual({ text: 'in 23 h 40 min', expired: false });
    expect(expiresInText('2026-11-01T10:12:00Z', now)).toEqual({ text: 'in 12 min', expired: false });
    expect(expiresInText('2026-11-01T12:00:00Z', now)).toEqual({ text: 'in 2 h', expired: false });
    expect(expiresInText('2026-11-01T09:00:00Z', now)).toEqual({ text: 'expired', expired: true });
    expect(expiresInText(null, now)).toEqual({ text: '', expired: false });
  });
});

describe('add a computer — following it connect', () => {
  it('words every stage plainly', () => {
    expect(daemonHeadline(null).text).toContain('Waiting for your computer');
    expect(daemonHeadline(progress('waiting')).tone).toBe('info');
    expect(daemonHeadline(progress('token-expired')).tone).toBe('bad');
    expect(daemonHeadline(progress('reporting', [install([ea()]), install([], { installId: 'b' })])).text).toBe(
      'Connected — 2 terminals found.',
    );
    expect(daemonHeadline(progress('reporting', [install([ea()])])).text).toBe('Connected — 1 terminal found.');
    expect(daemonHeadline(progress('reporting', [])).tone).toBe('warn');
    expect(daemonHeadline(progress('offline')).text).toContain('stopped reporting');
  });

  it('shows the allow-list steps only for an EA MetaTrader blocks (or likely blocks)', () => {
    expect(eaStatus(ea({ status: 'webrequest-blocked' })).showAllowList).toBe(true);
    expect(eaStatus(ea({ status: 'webrequest-suspected' })).showAllowList).toBe(true);
    expect(eaStatus(ea({ status: 'ok' })).showAllowList).toBe(false);
    expect(eaStatus(ea({ status: 'algo-trading-off' })).text).toContain('Algo Trading');
    expect(eaStatus(ea({ status: 'ea-trading-off' })).text).toContain('Allow Algo Trading');
    expect(anyAllowListProblem(progress('reporting', [install([ea({ status: 'webrequest-blocked' })])]))).toBe(true);
    expect(anyAllowListProblem(progress('reporting', [install([ea()])]))).toBe(false);
  });

  it('is done only when every terminal has a working EA', () => {
    expect(isAllDone(progress('reporting', [install([ea()])]))).toBe(true);
    expect(isAllDone(progress('reporting', [install([ea()]), install([])]))).toBe(false);
    expect(isAllDone(progress('reporting', [install([ea({ status: 'webrequest-blocked' })])]))).toBe(false);
    expect(isAllDone(progress('reporting', []))).toBe(false);
    expect(isAllDone(progress('registered', [install([ea()])]))).toBe(false);
    expect(installNeedsAction(install([]))).toBe(true);
  });

  it('describes each terminal', () => {
    expect(installAccountText(install([]))).toBe('Login 107699364 on MetaQuotes-Demo');
    expect(installAccountText(install([], { login: null, broker: null }))).toContain('Not signed in');
    expect(installRunningText(install([]))).toBe('Running');
    expect(installRunningText(install([], { running: false, desiredState: 'Stopped' }))).toContain('kept off');
    expect(installRunningText(install([], { running: null }))).toBe('');
  });

  it('polls fast while waiting, slower later, and stops once nothing more can happen', () => {
    expect(nextDaemonPollMs(null, 0)).toBe(3_000);
    expect(nextDaemonPollMs(progress('waiting'), 1_000)).toBe(3_000);
    expect(nextDaemonPollMs(progress('waiting'), 11 * 60_000)).toBe(10_000);
    expect(nextDaemonPollMs(progress('reporting', [install([ea({ status: 'webrequest-suspected' })])]), 0)).toBe(4_000);
    expect(nextDaemonPollMs(progress('reporting', [install([ea()])]), 0)).toBe(15_000);
    expect(nextDaemonPollMs(progress('token-expired'), 0)).toBeNull();
    expect(isDaemonSettled('credential-revoked')).toBe(true);
    expect(isDaemonSettled('offline')).toBe(false);
  });
});
