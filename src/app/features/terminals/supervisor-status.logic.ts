/**
 * The supervisor line on each computer card of the Terminals page (self-heal program C9): which
 * version runs, on what, and whether it is updating itself. Pure, tested.
 */
import type { DaemonSupervisorDto } from '@core/api/api.types';

type Tone = 'ok' | 'info' | 'warn' | 'bad' | 'muted';

/** "macOS (Apple silicon)" etc. for the engine's platform names; anything else as it is. */
export function platformLabel(platform: string | null | undefined): string {
  switch (platform) {
    case 'macos-arm64':
      return 'macOS (Apple silicon)';
    case 'macos-x86_64':
      return 'macOS (Intel)';
    case 'windows-x64':
      return 'Windows';
    default:
      return platform ?? '';
  }
}

/** "Supervisor 0.4.0 · macOS (Apple silicon)", or a plain sentence when it does not report. */
export function supervisorVersionText(s: DaemonSupervisorDto | null | undefined): string {
  if (!s?.version) return 'Supervisor version not reported (an older supervisor)';
  const p = platformLabel(s.platform);
  return `Supervisor ${s.version}${p ? ` · ${p}` : ''}`;
}

/** The update pill, or null when there is nothing to say. */
export function supervisorUpdatePill(
  s: DaemonSupervisorDto | null | undefined,
): { text: string; tone: Tone; title: string } | null {
  if (!s) return null;
  switch (s.updateState) {
    case 'current':
      return { text: 'up to date', tone: 'ok', title: 'Runs the newest published supervisor.' };
    case 'available':
      return {
        text: `update available: ${s.latestVersion ?? ''}`.trim(),
        tone: 'warn',
        title:
          'A newer supervisor is published. Automatic updates are off (Supervisor:AutoUpdate), so it keeps its version until they are switched on or it is reinstalled with a fresh "Add a computer" line.',
      };
    case 'updating':
      return {
        text: `updating to ${s.offeredVersion ?? s.latestVersion ?? 'the newest version'}…`,
        tone: 'info',
        title:
          'The supervisor is updating itself at its next quiet moment (never during a terminal action). It switches back by itself if the new version does not connect within 2 minutes.',
      };
    case 'failed':
      return {
        text: 'update did not finish',
        tone: 'bad',
        title: `The supervisor was offered ${s.latestVersion ?? 'a newer version'} for 30 minutes but is still on ${s.version ?? 'its old version'} (it may have switched back). It is offered again in a day, or straight away when a newer version is published. Its log says why.`,
      };
    case 'no-release':
      return null;
    default:
      return null;
  }
}
