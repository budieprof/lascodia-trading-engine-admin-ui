import { describe, expect, it } from 'vitest';

import type { TerminalDaemonDto, TerminalSessionDto } from '@core/api/api.types';
import { fleetSummary, orderSessions, runningOnInstall, sessionTone } from './terminals-page.logic';

function session(p: Partial<TerminalSessionDto>): TerminalSessionDto {
  return {
    id: 1,
    daemonId: 1,
    daemonName: 'mac',
    daemonSessionId: 'x',
    installId: 'default',
    pid: 100,
    status: 'Running',
    reason: null,
    launchedAt: '2026-11-01T00:00:00Z',
    lastSeenAt: '2026-11-01T00:00:00Z',
    stoppedAt: null,
    ...p,
  };
}

function daemon(p: Partial<TerminalDaemonDto>): TerminalDaemonDto {
  return {
    id: 1,
    daemonId: 'mac',
    name: 'mac',
    baseUrl: 'http://x',
    registeredAt: '2026-01-01T00:00:00Z',
    lastSeenAt: '2026-11-01T00:00:00Z',
    isOnline: true,
    installs: [],
    ...p,
  };
}

describe('terminals-page logic', () => {
  it('tones session statuses', () => {
    expect(sessionTone('Running')).toBe('ok');
    expect(sessionTone('Starting')).toBe('warn');
    expect(sessionTone('Stopping')).toBe('warn');
    expect(sessionTone('Crashed')).toBe('bad');
    expect(sessionTone('Stopped')).toBe('muted');
    expect(sessionTone('Something')).toBe('muted');
  });

  it('orders crashed, in-flight, running, closed; newest first within a group', () => {
    const rows = [
      session({ id: 1, status: 'Stopped', stoppedAt: '2026-11-01T01:00:00Z' }),
      session({ id: 2, status: 'Running', launchedAt: '2026-11-01T00:00:00Z' }),
      session({ id: 3, status: 'Running', launchedAt: '2026-11-01T02:00:00Z' }),
      session({ id: 4, status: 'Crashed', stoppedAt: '2026-11-01T01:00:00Z' }),
      session({ id: 5, status: 'Starting' }),
    ];
    expect(orderSessions(rows).map((s) => s.id)).toEqual([4, 5, 3, 2, 1]);
    expect(rows[0].id).toBe(1); // input untouched
  });

  it('counts running sessions per install', () => {
    const rows = [
      session({ id: 1, installId: 'a' }),
      session({ id: 2, installId: 'a', status: 'Stopped', stoppedAt: '2026-11-01T01:00:00Z' }),
      session({ id: 3, installId: 'a', daemonId: 2 }),
    ];
    expect(runningOnInstall(rows, 1, 'a')).toBe(1);
    expect(runningOnInstall(rows, 1, 'b')).toBe(0);
  });

  it('summarises the fleet and lists what needs attention', () => {
    const s = fleetSummary(
      [
        daemon({ id: 1, name: 'mac' }),
        daemon({ id: 2, name: 'mac2', isOnline: false }),
        daemon({
          id: 3,
          name: 'win',
          supervisor: {
            version: '0.3',
            latestVersion: '0.4',
            updateState: 'failed',
          } as TerminalDaemonDto['supervisor'],
        }),
      ],
      [
        session({ id: 1 }),
        session({ id: 2, status: 'Crashed', reason: 'exit 1', stoppedAt: '2026-11-01T01:00:00Z' }),
        session({ id: 3, status: 'Stopped', stoppedAt: '2026-11-01T01:00:00Z' }),
        session({ id: 4, status: 'Starting' }),
      ],
    );
    expect(s.daemonsOnline).toBe(2);
    expect(s.daemonsTotal).toBe(3);
    expect(s.running).toBe(1);
    expect(s.inFlight).toBe(1);
    expect(s.crashed).toBe(1);
    expect(s.closed).toBe(1);
    expect(s.attention.map((a) => a.tone)).toEqual(['bad', 'warn', 'bad']);
    expect(s.attention[2].text).toContain('crashed: exit 1');
  });

  it('has nothing to flag on a healthy fleet', () => {
    expect(fleetSummary([daemon({})], [session({})]).attention).toEqual([]);
  });
});
