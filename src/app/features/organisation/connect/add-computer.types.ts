/**
 * Wire shapes of "Add a computer" — the one-line host supervisor install (self-heal program, contract C9):
 * `GET onboarding/supervisor/setup` (`accounts.read`) and the `daemon` part of
 * `GET machine/enrollments/{id}/progress` for a `Daemon` enrollment token.
 */

/** The newest supervisor bundle of one platform. */
export interface SupervisorPlatformBundle {
  /** `macos-arm64`, `macos-x86_64`, `windows-x64`. */
  platform: string;
  /** "macOS (Apple silicon)", "macOS (Intel)", "Windows". */
  label: string;
  available: boolean;
  version: string | null;
  sizeBytes: number | null;
  publishedAtUtc: string | null;
}

/** `GET onboarding/supervisor/setup`. */
export interface SupervisorSetup {
  apiBaseUrl: string;
  installShUrl: string;
  installPs1Url: string;
  /** The macOS line with `{token}` where the install code goes. */
  macCommandTemplate: string;
  /** The Windows line with `{token}` where the install code goes. */
  windowsCommandTemplate: string;
  /** What to add in MT5 → Tools → Options → Expert Advisors → "Allow WebRequest for listed URL". */
  webRequestAllowUrl: string;
  platforms: SupervisorPlatformBundle[];
  autoUpdate: boolean;
  enrollmentTokenHours: number;
  /** The double-click macOS installer (platform `macos-pkg`); absent on an engine that predates it. */
  macInstaller?: SupervisorPlatformBundle | null;
  /** The name the installer is saved under, with `{token}` where the install code goes. */
  macInstallerFileNameTemplate?: string | null;
}

/** The double-click macOS installer as downloaded (`GET onboarding/supervisor/installer`). */
export interface MacInstallerFile {
  blob: Blob;
  sha256: string | null;
  version: string | null;
}

/**
 * One EA on a terminal. `status`, worst first: `webrequest-blocked`, `webrequest-suspected`,
 * `start-failed`, `algo-trading-off`, `ea-trading-off`, `starting`, `not-connected`, `ok`.
 */
export interface DaemonEaProgress {
  instanceId: string;
  heartbeating: boolean;
  lastHeartbeatUtc: string | null;
  eaVersion: string | null;
  state: string | null;
  webRequestBlocked: boolean;
  webRequestSuspected: boolean;
  algoTradingOff: boolean;
  eaTradingNotAllowed: boolean;
  beaconPhase: string | null;
  beaconFresh: boolean;
  authState: string | null;
  linkedBy: string;
  status: string;
}

/** One MetaTrader 5 install the computer found. */
export interface DaemonInstallProgress {
  installId: string;
  name: string;
  broker: string | null;
  login: string | null;
  running: boolean | null;
  managed: boolean | null;
  desiredState: string | null;
  watchdogState: string | null;
  eaInstances: DaemonEaProgress[];
}

/** The computer a Daemon token connected. */
export interface DaemonProgress {
  daemonId: string;
  daemonRowId: number | null;
  name: string | null;
  online: boolean;
  lastSeenAtUtc: string | null;
  registeredAtUtc: string | null;
  supervisorVersion: string | null;
  platform: string | null;
  installs: DaemonInstallProgress[];
}

/** The operating systems the wizard offers (the installer itself picks Apple silicon vs Intel). */
export type ComputerOs = 'macos' | 'windows';
