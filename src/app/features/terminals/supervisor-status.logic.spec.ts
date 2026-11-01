import { describe, expect, it } from 'vitest';

import type { DaemonSupervisorDto } from '@core/api/api.types';
import { platformLabel, supervisorUpdatePill, supervisorVersionText } from './supervisor-status.logic';

function sup(over: Partial<DaemonSupervisorDto> = {}): DaemonSupervisorDto {
  return {
    version: '0.3.0',
    platform: 'macos-arm64',
    latestVersion: '0.4.0',
    updateState: 'updating',
    offeredVersion: '0.4.0',
    offeredAt: '2026-11-01T10:00:00Z',
    autoUpdate: true,
    ...over,
  };
}

describe('supervisor line on a computer card', () => {
  it('names the version and platform, or says an older supervisor does not report it', () => {
    expect(supervisorVersionText(sup())).toBe('Supervisor 0.3.0 · macOS (Apple silicon)');
    expect(supervisorVersionText(sup({ platform: null }))).toBe('Supervisor 0.3.0');
    expect(supervisorVersionText(sup({ version: null }))).toContain('not reported');
    expect(supervisorVersionText(undefined)).toContain('not reported');
    expect(platformLabel('windows-x64')).toBe('Windows');
    expect(platformLabel('linux-arm64')).toBe('linux-arm64');
  });

  it('shows the update state as a pill', () => {
    expect(supervisorUpdatePill(sup())?.text).toBe('updating to 0.4.0…');
    expect(supervisorUpdatePill(sup({ updateState: 'current' }))?.tone).toBe('ok');
    expect(supervisorUpdatePill(sup({ updateState: 'available' }))?.text).toBe('update available: 0.4.0');
    expect(supervisorUpdatePill(sup({ updateState: 'failed' }))?.tone).toBe('bad');
    expect(supervisorUpdatePill(sup({ updateState: 'no-release' }))).toBeNull();
    expect(supervisorUpdatePill(sup({ updateState: 'unknown' }))).toBeNull();
    expect(supervisorUpdatePill(null)).toBeNull();
  });
});
