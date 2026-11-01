/**
 * "Add a computer" (self-heal program C9): every decision and every sentence the wizard shows, kept
 * pure so it is tested without a browser. Plain language — the reader may never have opened a
 * terminal window before.
 */
import type { EnrollmentProgress } from './terminal-wizard.types';
import type {
  ComputerOs,
  DaemonEaProgress,
  DaemonInstallProgress,
  SupervisorSetup,
} from './add-computer.types';

/** Longest computer name the engine accepts (enrollment token label). */
export const COMPUTER_LABEL_MAX = 128;

type Tone = 'ok' | 'info' | 'warn' | 'bad';

/** The OS of the browser, as a first guess for "which computer is it?" (null = cannot tell). */
export function detectOs(nav: { userAgent?: string; platform?: string; userAgentData?: { platform?: string } } | null | undefined): ComputerOs | null {
  const hint = `${nav?.userAgentData?.platform ?? ''} ${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`.toLowerCase();
  if (/iphone|ipad|android/.test(hint)) return null;
  if (/mac/.test(hint)) return 'macos';
  if (/win/.test(hint)) return 'windows';
  return null;
}

/** "Mac" / "Windows PC". */
export function osLabel(os: ComputerOs): string {
  return os === 'macos' ? 'Mac' : 'Windows PC';
}

/**
 * The one line to paste, or null when the engine has no line for that OS. The engine's template
 * carries `{token}`; the install code never contains spaces or quotes, so it is put in as it is.
 */
export function installCommand(setup: SupervisorSetup | null, os: ComputerOs, token: string): string | null {
  const template = os === 'macos' ? setup?.macCommandTemplate : setup?.windowsCommandTemplate;
  if (!template || !token) return null;
  return template.replace('{token}', token);
}

/**
 * Whether the installer can work for this OS now: a bundle must be published. For a Mac either
 * architecture counts (the installer picks the right one), but a missing one is named.
 */
export function osAvailability(setup: SupervisorSetup | null, os: ComputerOs): { available: boolean; note: string | null } {
  if (!setup) return { available: false, note: null };
  const bundles = setup.platforms.filter((p) => (os === 'macos' ? p.platform.startsWith('macos-') : p.platform.startsWith('windows-')));
  const ready = bundles.filter((b) => b.available);
  if (ready.length === 0)
    return {
      available: false,
      note: `The installer for ${os === 'macos' ? 'Mac' : 'Windows'} has not been published yet. Ask your platform operator to publish it, then come back.`,
    };
  if (os === 'macos' && ready.length < bundles.length) {
    const missing = bundles.filter((b) => !b.available).map((b) => b.label);
    return { available: true, note: `Not available yet for ${missing.join(' and ')}.` };
  }
  return { available: true, note: null };
}

/** The engine's default name for the downloaded installer (`{token}` = the install code). */
export const MAC_INSTALLER_FILE_NAME = 'Lascodia Setup {token}.pkg';

/** Is the double-click installer offered: a Mac, and a published `macos-pkg`? */
export function macInstallerAvailable(setup: SupervisorSetup | null, os: ComputerOs): boolean {
  return os === 'macos' && !!setup?.macInstaller?.available;
}

/**
 * The name the installer is saved under. The package reads the install code back from its own
 * name, so the code must be in it (the code has no spaces, slashes or quotes).
 */
export function macInstallerFileName(setup: SupervisorSetup | null, token: string): string {
  const template = setup?.macInstallerFileNameTemplate || MAC_INSTALLER_FILE_NAME;
  return (template.includes('{token}') ? template : MAC_INSTALLER_FILE_NAME).replace('{token}', token);
}

/**
 * What to do with the downloaded installer. It is not signed with an Apple Developer ID, so macOS
 * stops the first open; the steps say exactly how to let it through, for macOS 15+ and earlier.
 */
export const MAC_INSTALLER_STEPS: readonly string[] = [
  'Do this on the Mac that runs MetaTrader 5. If you are reading this page on another computer, open it on that Mac, or use the install line below instead.',
  'Click "Download the installer". Then open the file "Lascodia Setup … .pkg" from your Downloads folder.',
  'macOS says it cannot check the file for malicious software. Click Done. Then open System Settings → Privacy & Security, scroll down to Security, click Open Anyway, and enter your Mac password. On macOS 14 or earlier, Control-click the file and choose Open instead.',
  'In the installer, click Continue, then Install, and enter your Mac password. It takes about a minute. Keep this page open: it shows the Mac connecting.',
];

/** Why macOS asks — one sentence, shown under the steps. */
export const MAC_INSTALLER_WHY_ASKED =
  'macOS asks because the installer is not signed with an Apple developer certificate. The installer still checks that the supervisor it downloads is the genuine file, and it runs the same steps as the install line.';

/** What a failed installer download means for the person (the body is a Blob, so the status decides). */
export function macInstallerErrorText(err: unknown): string {
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 403)
    return 'You may not download the installer here: it needs the permission to connect accounts, and the demonstration organisation cannot connect computers.';
  if (status === 404) return 'The installer has not been published yet. Use the install line below instead.';
  if (status === 429) return 'Too many downloads in a short time. Wait a minute and try again.';
  if (status === 0) return 'The engine could not be reached. Check your connection and try again.';
  return 'The installer could not be downloaded. Try again, or use the install line below.';
}

/** How to open the window the line is pasted into. */
export function openShellSteps(os: ComputerOs): string[] {
  return os === 'macos'
    ? [
        'On the Mac that runs MetaTrader 5, open Terminal: press ⌘ Space, type Terminal and press Return.',
        'Paste the line (⌘ V) and press Return.',
        'Wait until it says it is finished — about a minute. Keep this page open.',
      ]
    : [
        'On the Windows PC that runs MetaTrader 5, open PowerShell: press the Start button, type PowerShell and open it.',
        'Paste the line (right-click or Ctrl V) and press Enter.',
        'Wait until it says it is finished — about a minute. Keep this page open.',
      ];
}

/** The three lines of "what this does". */
export const WHAT_IT_DOES: readonly string[] = [
  'Downloads the Lascodia supervisor — a small helper that runs in the background — and checks that it is the genuine file.',
  'Installs it for the signed-in user and starts it every time that user signs in, so the terminals are looked after even after a restart.',
  'Finds the MetaTrader 5 terminals on the computer and connects them to your organisation. Nothing else on the computer is changed.',
];

/** "in 23 h 40 min" / "in 12 min" / "expired". */
export function expiresInText(expiresAtUtc: string | null | undefined, nowMs: number): { text: string; expired: boolean } {
  const at = expiresAtUtc ? Date.parse(expiresAtUtc) : NaN;
  if (!Number.isFinite(at)) return { text: '', expired: false };
  const ms = at - nowMs;
  if (ms <= 0) return { text: 'expired', expired: true };
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return { text: `in ${minutes} min`, expired: false };
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return { text: m ? `in ${h} h ${m} min` : `in ${h} h`, expired: false };
}

/** Is the token's progress final (nothing more will happen without a new line)? */
export function isDaemonSettled(stage: string): boolean {
  return stage === 'token-expired' || stage === 'token-revoked' || stage === 'credential-revoked';
}

/** The big sentence at the top of the progress card. */
export function daemonHeadline(p: EnrollmentProgress | null): { text: string; tone: Tone } {
  if (!p) return { text: 'Waiting for your computer…', tone: 'info' };
  const n = p.daemon?.installs.length ?? 0;
  switch (p.stage) {
    case 'waiting':
      return { text: 'Waiting for your computer…', tone: 'info' };
    case 'refused':
      return { text: 'The engine turned the computer away.', tone: 'bad' };
    case 'token-expired':
      return { text: 'The install line expired before it was used.', tone: 'bad' };
    case 'token-revoked':
      return { text: 'The install line was cancelled.', tone: 'bad' };
    case 'enrolled':
      return { text: 'Your computer signed in — starting the supervisor…', tone: 'info' };
    case 'registered':
      return { text: 'The supervisor is running — looking for terminals…', tone: 'info' };
    case 'reporting':
      return n === 0
        ? { text: 'Connected — no MetaTrader 5 terminal found yet.', tone: 'warn' }
        : { text: `Connected — ${n === 1 ? '1 terminal' : `${n} terminals`} found.`, tone: 'ok' };
    case 'offline':
      return { text: 'Your computer stopped reporting.', tone: 'warn' };
    case 'credential-revoked':
      return { text: "This computer's sign-in was revoked.", tone: 'bad' };
    default:
      return { text: p.stage, tone: 'info' };
  }
}

/** One EA's line on a terminal, and whether to show the WebRequest instructions under it. */
export function eaStatus(ea: DaemonEaProgress): { text: string; tone: Tone; showAllowList: boolean } {
  switch (ea.status) {
    case 'ok':
      return { text: 'EA running and connected.', tone: 'ok', showAllowList: false };
    case 'webrequest-blocked':
      return {
        text: 'MetaTrader 5 is blocking the EA from reaching the engine. Add the address below to its allowed list.',
        tone: 'bad',
        showAllowList: true,
      };
    case 'webrequest-suspected':
      return {
        text: 'The EA is running but has not reached the engine yet — almost always because the address below is not in MetaTrader 5\'s allowed list.',
        tone: 'warn',
        showAllowList: true,
      };
    case 'start-failed':
      return { text: 'The EA could not start on its chart. Open the terminal and look at the Experts tab for the reason.', tone: 'bad', showAllowList: false };
    case 'algo-trading-off':
      return {
        text: 'Algo Trading is switched off in this terminal. Click the "Algo Trading" button in its toolbar so it turns green.',
        tone: 'warn',
        showAllowList: false,
      };
    case 'ea-trading-off':
      return {
        text: '"Allow Algo Trading" is unticked in the EA\'s own settings. Open the EA\'s properties on the chart (Common tab) and tick it.',
        tone: 'warn',
        showAllowList: false,
      };
    case 'starting':
      return { text: 'The EA is starting…', tone: 'info', showAllowList: false };
    default:
      return { text: 'The EA has not reached the engine.', tone: 'warn', showAllowList: true };
  }
}

/** "Running" / "Not running" / "" for one install's process. */
export function installRunningText(i: DaemonInstallProgress): string {
  if (i.running === true) return 'Running';
  if (i.running === false) return i.desiredState === 'Stopped' ? 'Stopped (kept off)' : 'Not running';
  return '';
}

/** The account line of an install: "Login 107699364 on MetaQuotes-Demo". */
export function installAccountText(i: DaemonInstallProgress): string {
  if (i.login && i.broker) return `Login ${i.login} on ${i.broker}`;
  if (i.login) return `Login ${i.login}`;
  if (i.broker) return i.broker;
  return 'Not signed in to a broker account yet';
}

/** Does this install still need the person (no EA, or an EA that is not "ok")? */
export function installNeedsAction(i: DaemonInstallProgress): boolean {
  return i.eaInstances.length === 0 || i.eaInstances.some((e) => e.status !== 'ok');
}

/** Everything is set up: connected, at least one terminal, every terminal with a working EA. */
export function isAllDone(p: EnrollmentProgress | null): boolean {
  const installs = p?.daemon?.installs ?? [];
  return p?.stage === 'reporting' && installs.length > 0 && installs.every((i) => !installNeedsAction(i));
}

/** Is any EA on the computer blocked (or likely blocked) by the WebRequest list? */
export function anyAllowListProblem(p: EnrollmentProgress | null): boolean {
  return (p?.daemon?.installs ?? []).some((i) => i.eaInstances.some((e) => eaStatus(e).showAllowList));
}

/** When to read the progress again (ms), or null to stop. */
export function nextDaemonPollMs(p: EnrollmentProgress | null, waitedMs: number): number | null {
  if (!p) return 3_000;
  if (isDaemonSettled(p.stage)) return null;
  if (isAllDone(p)) return 15_000;
  if (p.stage === 'waiting' || p.stage === 'refused') return waitedMs < 10 * 60_000 ? 3_000 : 10_000;
  if (p.stage === 'offline') return 10_000;
  return 4_000;
}
