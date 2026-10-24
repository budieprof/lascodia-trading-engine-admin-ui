import type {
  EaReleaseInfo,
  EnrollmentProgress,
  EnrollmentStage,
  TerminalSetup,
} from './terminal-wizard.types';

/** The engine's API path below its host. */
export const API_PATH = '/api/v1/lascodia-trading-engine';

/**
 * The value for the EA's `InpEngineBaseUrl`: the engine's configured address, else this console's
 * own origin + the API path (a release is served same-origin with the engine behind it).
 */
export function engineBaseUrl(
  setup: Pick<TerminalSetup, 'engineBaseUrl' | 'apiPath'> | null,
  origin: string,
): string {
  const configured = setup?.engineBaseUrl?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  const base = origin.replace(/\/+$/, '');
  return `${base}${setup?.apiPath || API_PATH}`;
}

/**
 * What goes into MT5's "Allow WebRequest for listed URL": the engine's scheme + host (+ port). MT5
 * matches by prefix, so the origin covers every engine path.
 */
export function allowListEntry(engineUrl: string): string {
  try {
    const u = new URL(engineUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return engineUrl;
  }
}

/** True when the address is plain http to something that is not this machine or a private network. */
export function isInsecureRemote(engineUrl: string): boolean {
  try {
    const u = new URL(engineUrl);
    if (u.protocol !== 'http:') return false;
    const h = u.hostname;
    return !(
      h === 'localhost' ||
      h === '127.0.0.1' ||
      h === '::1' ||
      /^10\./.test(h) ||
      /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    );
  } catch {
    return false;
  }
}

/**
 * A MetaTrader 5 preset (`.set`) with the two connection inputs filled. Loading it in the EA's Inputs
 * tab ("Load") sets only these lines; every other input keeps its value. The token is a secret: the
 * file is built in the browser and never sent anywhere.
 */
export function presetText(
  engineUrl: string,
  token: string,
  label: string,
  now = new Date(),
): string {
  const clean = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
  return [
    "; Lascodia EA — connection preset (made by the console's terminal wizard)",
    `; ${clean(label) || 'terminal'} — ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    '; The enrollment token works once. Delete this file after the terminal has connected.',
    `InpEngineBaseUrl=${clean(engineUrl)}`,
    `InpEnrollmentToken=${clean(token)}`,
    '',
  ].join('\r\n');
}

/** A file name for the preset: `lascodia-<label>.set`, safe on Windows. */
export function presetFileName(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `lascodia-${slug || 'terminal'}.set`;
}

/** Stages after which nothing changes by itself: polling stops (a person must act). */
export function isSettled(stage: EnrollmentStage): boolean {
  return (
    stage === 'connected' ||
    stage === 'token-expired' ||
    stage === 'token-revoked' ||
    stage === 'credential-revoked'
  );
}

/**
 * How long to wait before the next progress read: quick while the terminal is on its way, slower
 * while nothing has happened for a while, and never while settled (null). A connected terminal is
 * re-read slowly so the page notices it going stale.
 */
export function nextPollMs(progress: EnrollmentProgress | null, waitedMs: number): number | null {
  if (!progress) return 3_000;
  if (progress.stage === 'connected') return 15_000;
  if (isSettled(progress.stage)) return null;
  if (progress.stage === 'waiting-for-terminal' || progress.stage === 'refused')
    return waitedMs < 120_000 ? 3_000 : 10_000;
  return 3_000;
}

/** The headline for a stage, in plain words, and its tone. */
export function stageHeadline(stage: EnrollmentStage): {
  text: string;
  tone: 'ok' | 'info' | 'warn' | 'bad';
} {
  switch (stage) {
    case 'connected':
      return { text: 'Connected — the terminal is sending heartbeats.', tone: 'ok' };
    case 'waiting-for-terminal':
      return { text: 'Waiting for the terminal to use the token…', tone: 'info' };
    case 'enrolled':
      return { text: 'The terminal has its credential; waiting for it to sign in…', tone: 'info' };
    case 'signed-in':
      return { text: 'Signed in; waiting for the EA to register…', tone: 'info' };
    case 'registered':
      return { text: 'Registered; waiting for the first heartbeat…', tone: 'info' };
    case 'stale':
      return { text: 'The terminal stopped sending heartbeats.', tone: 'warn' };
    case 'refused':
      return { text: 'The engine turned the terminal away.', tone: 'bad' };
    case 'token-expired':
      return { text: 'The token expired before a terminal used it.', tone: 'bad' };
    case 'token-revoked':
      return { text: 'The token was revoked.', tone: 'bad' };
    case 'credential-revoked':
      return { text: "This terminal's credential was revoked.", tone: 'bad' };
    default:
      return { text: stage, tone: 'info' };
  }
}

/** Dotted numeric version comparison (`8.47.99` < `8.47.100`); unreadable → not older (as the engine). */
export function isOlderVersion(
  version: string | null | undefined,
  than: string | null | undefined,
): boolean {
  const parse = (v: string | null | undefined): number[] | null => {
    if (!v) return null;
    const parts = v.trim().replace(/^[vV]/, '').split('.');
    const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
    return nums.some((n) => Number.isNaN(n)) ? null : nums;
  };
  const a = parse(version);
  const b = parse(than);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/** A terminal running `running` should update: a newer build than it is published. */
export function eaUpdateAvailable(
  running: string | null | undefined,
  latest: EaReleaseInfo | null | undefined,
): boolean {
  return !!running && !!latest && isOlderVersion(running, latest.version);
}

/** "3.2 MB" / "812 KB". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Whether the downloaded bytes are what the engine published: compares the SHA-256 of `bytes` with
 * `expected` (null when the browser cannot hash — non-secure context — or nothing to compare).
 */
export async function sha256Matches(
  bytes: ArrayBuffer,
  expected: string | null,
): Promise<boolean | null> {
  if (!expected || typeof crypto === 'undefined' || !crypto.subtle) return null;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return hex === expected.trim().toLowerCase();
}

/** What a failed EA download means for the person (the body is a Blob, so the HTTP status decides). */
export function eaDownloadErrorText(err: unknown): string {
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 403)
    return 'You may not download the EA here: it needs the permission to connect terminals, and the demonstration organisation cannot connect any.';
  if (status === 404)
    return 'No EA build has been published to the engine yet. Ask your platform contact.';
  if (status === 429) return 'Too many downloads just now. Try again in a minute.';
  return 'The EA could not be downloaded. Try again.';
}

/** Why the wizard cannot create a token for this organisation (null = it can). */
export function connectBlocker(setup: TerminalSetup | null): string | null {
  if (!setup) return null;
  if (setup.showcaseOrganisation)
    return 'This is the demonstration organisation: it runs on recorded data and never trades, so no terminal can be connected to it.';
  if (setup.maxTerminals !== null && setup.terminalsInUse >= setup.maxTerminals)
    return `Your plan allows ${setup.maxTerminals} connected terminal(s) and ${setup.terminalsInUse} are connected. Disconnect one, or ask about a larger plan.`;
  return null;
}
