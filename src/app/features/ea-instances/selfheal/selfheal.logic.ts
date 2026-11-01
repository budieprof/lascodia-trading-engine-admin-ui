/**
 * Pure decisions behind the EA detail page's self-heal surface (health card,
 * command results, terminal card, diagnostics, auto-heal timeline, restart-
 * required inputs). Everything an operator reads is worded here, in plain
 * language, so it is table-tested in one place (`selfheal.logic.spec.ts`).
 */
import type {
  EABeacon,
  EACommandHistoryItem,
  EADiag,
  EAHealEventDto,
  EAInstallRuntime,
  EATerminalDto,
  PruneFileItem,
  PruneFilesResult,
  TerminalJobDto,
} from '@core/api/ea-selfheal.types';

export type Tone = 'ok' | 'warn' | 'bad' | 'muted' | 'pending';

// ── Time ────────────────────────────────────────────────────────────────────

/** Engine timestamps are UTC; a bare `2026-10-31T22:00:00` (no zone) is read as UTC too. */
export function parseUtcMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const s = /[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`;
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return null;
  // The EA sends "1970-01-01T00:00:00Z" for "never".
  if (ms <= 0) return null;
  return ms;
}

/** Seconds → "12 s", "4 min", "2 h 5 min", "3 days". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) {
    const rem = m % 60;
    return rem ? `${h} h ${rem} min` : `${h} h`;
  }
  return `${Math.floor(h / 24)} days`;
}

/** Age of an ISO time in seconds, or null when unknown / in the future by more than 2 min (clock fault). */
export function ageSeconds(iso: string | null | undefined, nowMs: number): number | null {
  const ms = parseUtcMs(iso);
  if (ms == null) return null;
  const age = (nowMs - ms) / 1000;
  if (age < -120) return null;
  return Math.max(0, age);
}

/** "4 min ago", "just now", or "" when unknown. */
export function agoText(iso: string | null | undefined, nowMs: number): string {
  const age = ageSeconds(iso, nowMs);
  if (age == null) return '';
  if (age < 5) return 'just now';
  return `${formatDuration(age)} ago`;
}

// ── Heartbeat staleness ─────────────────────────────────────────────────────

/** Same line the engine's health verdict uses (`EA:AutoHeal:HeartbeatFreshSeconds`, seeded 120). */
export const HEARTBEAT_FRESH_SECONDS = 120;

export interface HeartbeatFreshness {
  stale: boolean;
  ageSeconds: number | null;
  /** "last known (7 min ago)" when stale, "" when fresh. */
  label: string;
}

export function heartbeatFreshness(
  lastHeartbeat: string | null | undefined,
  nowMs: number,
  freshSeconds = HEARTBEAT_FRESH_SECONDS,
): HeartbeatFreshness {
  const age = ageSeconds(lastHeartbeat, nowMs);
  if (age == null) return { stale: true, ageSeconds: null, label: 'last known (time unknown)' };
  const stale = age > freshSeconds;
  return { stale, ageSeconds: age, label: stale ? `last known (${formatDuration(age)} ago)` : '' };
}

// ── Verdict ────────────────────────────────────────────────────────────────

export function verdictTone(verdict: string | null | undefined): Tone {
  switch (verdict) {
    case 'Healthy':
      return 'ok';
    case 'Degraded':
      return 'warn';
    case 'Down':
      return 'bad';
    default:
      return 'muted';
  }
}

export function verdictHeadline(verdict: string | null | undefined, problemCount: number): string {
  switch (verdict) {
    case 'Healthy':
      return 'Everything is working.';
    case 'Degraded':
      return problemCount === 1
        ? 'Running, but one thing needs attention.'
        : `Running, but ${problemCount} things need attention.`;
    case 'Down':
      return 'The EA is not reporting to the engine.';
    case 'Stopped':
      return 'Stopped on purpose.';
    default:
      return 'Health unknown.';
  }
}

export function severityTone(severity: string): Tone {
  return severity === 'error' ? 'bad' : severity === 'warning' ? 'warn' : 'muted';
}

/** Problems worst first; the engine's order is kept within a severity. */
export function sortProblems<T extends { severity: string }>(problems: readonly T[]): T[] {
  const rank = (s: string) => (s === 'error' ? 0 : s === 'warning' ? 1 : 2);
  return problems
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rank(a.p.severity) - rank(b.p.severity) || a.i - b.i)
    .map((x) => x.p);
}

// ── EA state words ─────────────────────────────────────────────────────────

const STATE_WORDS: Record<string, string> = {
  RUNNING: 'Running',
  SAFE_MODE: 'Safe mode (no new trades)',
  SAFETY_STOP: 'Safety stop (no new trades)',
  INITIALIZING: 'Starting up',
  MARKET_CLOSED: 'Market closed',
  SHUTTING_DOWN: 'Shutting down',
  DISCONNECTED: 'Disconnected',
};

export function stateWords(state: string | null | undefined): string {
  if (!state) return 'Unknown';
  return STATE_WORDS[state] ?? state;
}

export function stateTone(state: string | null | undefined): Tone {
  if (state === 'RUNNING') return 'ok';
  if (state === 'MARKET_CLOSED' || state === 'INITIALIZING') return 'muted';
  if (state === 'SAFE_MODE') return 'warn';
  if (!state) return 'muted';
  return 'bad';
}

// ── Commands ───────────────────────────────────────────────────────────────

export function isFinalCommandStatus(status: string | null | undefined): boolean {
  return status === 'Succeeded' || status === 'Failed' || status === 'Expired';
}

export function commandStatusTone(status: string | null | undefined): Tone {
  switch (status) {
    case 'Succeeded':
      return 'ok';
    case 'Failed':
      return 'bad';
    case 'Expired':
      return 'warn';
    default:
      return 'pending';
  }
}

/** Strip the EA's "Success:" / "Failed:" prefix so the sentence reads on its own. */
export function ackReason(ackResult: string | null | undefined): string {
  const s = (ackResult ?? '').trim();
  return s.replace(/^(success|succeeded|ok|failed|failure|error)\s*[:\-–]\s*/i, '').trim();
}

/** One plain sentence describing where a command is. */
export function commandStatusText(c: Pick<EACommandHistoryItem, 'status' | 'ackResult'>): string {
  const reason = ackReason(c.ackResult);
  switch (c.status) {
    case 'Pending':
      return 'Waiting for the EA to pick it up.';
    case 'Delivered':
      return 'The EA has it; waiting for its answer.';
    case 'Succeeded':
      return reason ? `Done — ${reason}` : 'Done.';
    case 'Failed':
      return reason ? `Failed — ${reason}` : 'Failed — the EA gave no reason.';
    case 'Expired':
      return 'Expired — the EA never picked it up (it was offline or replaced).';
    default:
      return c.status ? String(c.status) : 'Unknown.';
  }
}

/** EACommandType → operator words. */
const COMMAND_WORDS: Record<string, string> = {
  ForceSafetyStop: 'Safety stop',
  ClearSafetyStop: 'Clear safety stop',
  TriggerKillSwitch: 'Kill switch',
  ReleaseKillSwitch: 'Release kill switch',
  FlattenInstance: 'Flatten positions',
  ResetCircuitBreaker: 'Reset circuit breaker',
  FlushRetryQueue: 'Flush retry queue',
  PurgeRetryQueue: 'Purge retry queue',
  RestartInstance: 'Restart EA',
  LaunchInstance: 'Launch instance',
  ShutdownInstance: 'Shut down instance',
  UpdateConfig: 'Config change',
  RequestBackfill: 'Refresh symbol data',
  ForceRecovery: 'Force recovery',
  SetInputs: 'Change inputs + restart',
  ModifySLTP: 'Modify SL/TP',
  ClosePosition: 'Close position',
  CancelOrder: 'Cancel order',
  UpdateTrailing: 'Update trailing stop',
  RequestExecutionStatus: 'Execution status check',
  ScalePosition: 'Scale position',
  ReportDealHistory: 'Report deal history',
  CancelSignal: 'Cancel signal',
  ModifyOrderPrice: 'Modify order price',
};

export function commandWords(type: string | null | undefined): string {
  if (!type) return 'Command';
  return COMMAND_WORDS[type] ?? type;
}

/** "admin-user:5 (Ada Lovelace)" → "Ada Lovelace"; "system:auto-heal" → "Auto-heal". */
export function requesterWords(requestedBy: string | null | undefined): string {
  if (!requestedBy) return 'engine';
  const named = /\(([^)]+)\)\s*$/.exec(requestedBy);
  if (named) return named[1];
  if (requestedBy === 'system:auto-heal') return 'Auto-heal';
  if (requestedBy.startsWith('job:')) return 'After a host job';
  if (requestedBy.startsWith('system:')) return requestedBy.slice(7);
  return requestedBy;
}

// ── Host jobs ──────────────────────────────────────────────────────────────

export function isFinalJobStatus(status: string | null | undefined): boolean {
  return status === 'Succeeded' || status === 'Failed' || status === 'Expired';
}

export function jobStatusTone(status: string | null | undefined): Tone {
  return commandStatusTone(status);
}

const JOB_WORDS: Record<string, string> = {
  StartTerminal: 'Start terminal',
  StopTerminal: 'Stop terminal',
  RestartTerminal: 'Restart terminal',
  DeployEaBinary: 'Update EA',
  TailLog: 'Fetch host log',
  PruneFiles: 'Clean up old files',
};

export function jobWords(type: string | null | undefined): string {
  if (!type) return 'Host job';
  return JOB_WORDS[type] ?? type;
}

export function jobStatusText(
  j: Pick<TerminalJobDto, 'status' | 'resultMessage' | 'daemonName'>,
): string {
  const host = j.daemonName ? `the host (${j.daemonName})` : 'the host';
  const msg = (j.resultMessage ?? '').trim();
  switch (j.status) {
    case 'Pending':
      return `Waiting for ${host} to pick it up.`;
    case 'Claimed':
      return `${capitalise(host)} is working on it.`;
    case 'Succeeded':
      return msg ? `Done — ${msg}` : 'Done.';
    case 'Failed':
      return msg ? `Failed — ${msg}` : 'Failed — the host gave no reason.';
    case 'Expired':
      return `Expired — ${host} never picked it up (is its supervisor running?).`;
    default:
      return j.status ? String(j.status) : 'Unknown.';
  }
}

function capitalise(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

// ── Auto-heal timeline ─────────────────────────────────────────────────────

export function healStepLabel(e: Pick<EAHealEventDto, 'rung' | 'action'>): string {
  switch (e.action) {
    case 'Recovered':
      return 'Recovered';
    case 'GaveUp':
      return 'Gave up — needs an operator';
    case 'Held':
      return 'Held back';
    case 'ForceRecovery':
      return 'Step 1 · Force recovery';
    case 'RestartInstance':
      return 'Step 2 · Restart the EA';
    case 'RestartTerminal':
      return 'Step 3 · Restart the terminal';
    case 'StartTerminal':
      return 'Step 4 · Start the terminal';
    default:
      return e.rung > 0 ? `Step ${e.rung} · ${e.action}` : e.action;
  }
}

export function healOutcomeText(outcome: string | null | undefined): string {
  switch (outcome) {
    case 'DryRun':
      return 'Dry run — nothing was done';
    case 'Held':
      return 'Not done (held back)';
    case 'GaveUp':
      return 'Gave up';
    case 'Recovered':
      return 'Recovered';
    case 'Pending':
      return 'Waiting to be picked up';
    case 'Delivered':
      return 'Delivered, waiting for the answer';
    case 'Claimed':
      return 'Host is working on it';
    case 'Succeeded':
      return 'Worked';
    case 'Failed':
      return 'Failed';
    case 'Expired':
      return 'Expired (never picked up)';
    default:
      return outcome ?? '—';
  }
}

export function healOutcomeTone(outcome: string | null | undefined): Tone {
  switch (outcome) {
    case 'Succeeded':
    case 'Recovered':
      return 'ok';
    case 'Failed':
    case 'GaveUp':
      return 'bad';
    case 'Expired':
    case 'Held':
      return 'warn';
    case 'DryRun':
      return 'muted';
    default:
      return 'pending';
  }
}

// ── Diagnostics (C1 diag block) ────────────────────────────────────────────

export interface DiagRow {
  key: string;
  label: string;
  value: string;
  tone: Tone;
  /** What to do about it, when something is wrong. */
  hint?: string;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/** MQL5 WebRequest error codes an operator can act on. */
export function webRequestErrorText(code: number | null | undefined): string {
  switch (code) {
    case null:
    case undefined:
    case 0:
      return 'No errors';
    case 4014:
      return "The engine's address is not in MT5's allowed list";
    case 4060:
      return 'Web requests are switched off for this EA';
    case 5200:
      return 'Invalid engine address';
    case 5201:
      return 'Could not connect to the engine';
    case 5202:
      return 'The engine took too long to answer';
    case 5203:
      return 'The engine connection failed';
    default:
      return `Error ${code}`;
  }
}

const AUTH_RUNG_WORDS: Record<string, string> = {
  machine: 'its own machine credential',
  apikey: 'the account API key (legacy)',
  bootstrap: 'first-run bootstrap (legacy)',
  none: 'no credential',
};

const AUTH_STATE_WORDS: Record<string, string> = {
  ok: 'Signed in',
  retrying: 'Signing in — retrying',
  dormant: 'Waiting before the next sign-in attempt',
  dead: 'Cannot sign in',
};

const LASCODIA_FILES_WARN_BYTES = 5 * 1024 ** 3;

/** Plain-language rows for the diagnostics section. Empty when the EA sends no diag block. */
export function diagRows(diag: EADiag | null | undefined, nowMs: number): DiagRow[] {
  if (!diag) return [];
  const rows: DiagRow[] = [];
  const yesNo = (
    key: string,
    label: string,
    v: boolean | undefined,
    okText: string,
    badText: string,
    hint?: string,
    badTone: Tone = 'bad',
  ) => {
    if (v === undefined) return;
    rows.push({ key, label, value: v ? okText : badText, tone: v ? 'ok' : badTone, hint: v ? undefined : hint });
  };

  yesNo(
    'terminalConnected',
    'Broker connection',
    diag.terminalConnected,
    'Connected',
    'Not connected',
    'The terminal has lost its broker server. A terminal restart usually reconnects it; check the login if it does not.',
  );
  yesNo(
    'terminalTradeAllowed',
    'Algo Trading button (terminal)',
    diag.terminalTradeAllowed,
    'On',
    'Off',
    'Someone switched off "Algo Trading" in the MT5 toolbar. It has to be switched on in the terminal; a restart does not change it.',
  );
  yesNo(
    'mqlTradeAllowed',
    'EA allowed to trade (chart)',
    diag.mqlTradeAllowed,
    'Yes',
    'No',
    '"Allow Algo Trading" is unticked in this EA\'s properties on the chart (Common tab). It has to be ticked on the terminal.',
  );
  yesNo('dllsAllowed', 'DLL imports', diag.dllsAllowed, 'Allowed', 'Not allowed', undefined, 'muted');

  if (diag.restartTemplateSeeded !== undefined) {
    rows.push({
      key: 'restartTemplateSeeded',
      label: 'Remote restart',
      value: diag.restartTemplateSeeded ? 'Ready' : 'Not ready',
      tone: diag.restartTemplateSeeded ? 'ok' : 'warn',
      hint: diag.restartTemplateSeeded
        ? undefined
        : 'The EA has not saved its chart template yet, so "Restart EA" and input changes cannot work. Restarting the terminal re-attaches it and saves the template.',
    });
  }
  if (diag.spawnTemplateSeeded !== undefined) {
    rows.push({
      key: 'spawnTemplateSeeded',
      label: 'Launch sibling instances',
      value: diag.spawnTemplateSeeded ? 'Ready' : 'Not ready',
      tone: diag.spawnTemplateSeeded ? 'ok' : 'muted',
    });
  }

  if (diag.liveGateBlockedReason !== undefined) {
    const blocked = diag.liveGateBlockedReason.trim();
    rows.push({
      key: 'liveGate',
      label: 'Can go live',
      value: blocked ? `No — ${blocked}` : 'Yes',
      tone: blocked ? 'bad' : 'ok',
      hint: blocked ? '"Force recovery" re-runs the start-up checks.' : undefined,
    });
  }
  if (diag.recoveryFailed !== undefined) {
    rows.push({
      key: 'recovery',
      label: 'Start-up recovery',
      value: diag.recoveryFailed
        ? `Failed${diag.recoveryFailedPhase ? ` at "${diag.recoveryFailedPhase}"` : ''}`
        : 'Completed',
      tone: diag.recoveryFailed ? 'bad' : 'ok',
      hint: diag.recoveryFailed
        ? 'The EA will not trade until recovery passes. "Force recovery" clears the failure and runs it again.'
        : undefined,
    });
  }
  if (diag.initDegraded !== undefined) {
    rows.push({
      key: 'init',
      label: 'Start-up',
      value: diag.initDegraded
        ? `Still retrying${diag.initRetryReason ? ` — ${diag.initRetryReason}` : ''}`
        : 'Finished',
      tone: diag.initDegraded ? 'warn' : 'ok',
      hint: diag.initDegraded
        ? 'The EA keeps retrying the failed step by itself (every 5 s to 60 s) and does not trade meanwhile.'
        : undefined,
    });
  }

  if (diag.authState !== undefined || diag.authRung !== undefined) {
    const state = diag.authState ?? '';
    const rung = diag.authRung ? (AUTH_RUNG_WORDS[diag.authRung] ?? diag.authRung) : '';
    const words = AUTH_STATE_WORDS[state] ?? (state || 'Unknown');
    rows.push({
      key: 'auth',
      label: 'Engine sign-in',
      value: rung ? `${words} · using ${rung}` : words,
      tone: state === 'ok' ? 'ok' : state === 'dead' ? 'bad' : 'warn',
      hint:
        state === 'dead'
          ? "The engine refuses this EA's credential. Re-issue the terminal's machine credential (Organisation → Terminals)."
          : diag.authRung === 'apikey' || diag.authRung === 'bootstrap'
            ? 'Uses a legacy sign-in the engine can retire. Give the terminal a machine credential.'
            : undefined,
    });
  }

  if (diag.lastWebRequestError !== undefined) {
    const code = diag.lastWebRequestError;
    const when = agoText(diag.lastWebRequestErrorAtUtc, nowMs);
    rows.push({
      key: 'webRequest',
      label: 'Last web request error',
      value: code ? `${webRequestErrorText(code)}${when ? ` (${when})` : ''}` : 'None',
      tone: code ? (code === 4014 || code === 4060 ? 'bad' : 'warn') : 'ok',
      hint:
        code === 4014
          ? "In MT5: Tools → Options → Expert Advisors → tick \"Allow WebRequest for listed URL\" and add the engine's address. MT5 offers no remote way to do this."
          : code === 4060
            ? 'Tick "Allow WebRequest" in Tools → Options → Expert Advisors on the terminal.'
            : undefined,
    });
  }

  if (diag.deadLetterCount !== undefined) {
    rows.push({
      key: 'deadLetters',
      label: 'Undeliverable reports',
      value: diag.deadLetterCount === 0 ? 'None' : `${diag.deadLetterCount} waiting`,
      tone: diag.deadLetterCount === 0 ? 'ok' : 'warn',
      hint:
        diag.deadLetterCount > 0
          ? 'Reports the engine refused several times. They are kept on the terminal for review; "Flush retry queue" retries the rest.'
          : undefined,
    });
  }

  if (diag.diskBytesLascodia !== undefined && diag.diskBytesLascodia > 0) {
    const large = diag.diskBytesLascodia > LASCODIA_FILES_WARN_BYTES;
    rows.push({
      key: 'disk',
      label: "EA's files on the terminal",
      value: formatBytes(diag.diskBytesLascodia),
      tone: large ? 'warn' : 'ok',
      hint: large ? 'Old logs and ledgers should be pruned; the EA rotates them by itself from v8.47.259.' : undefined,
    });
  }

  if (diag.lastApplyError) {
    rows.push({
      key: 'applyError',
      label: 'Last template apply',
      value: `Refused by MT5 — ${diag.lastApplyError}`,
      tone: 'bad',
      hint: 'A restart or input change was acknowledged but MT5 refused to reload the chart. Restart the terminal.',
    });
  }

  if (diag.terminalBuild || diag.accountLogin || diag.server) {
    const parts: string[] = [];
    if (diag.accountLogin) parts.push(`login ${diag.accountLogin}`);
    if (diag.server) parts.push(diag.server);
    if (diag.terminalBuild) parts.push(`MT5 build ${diag.terminalBuild}`);
    rows.push({ key: 'terminal', label: 'Terminal', value: parts.join(' · '), tone: 'muted' });
  }

  return rows;
}

// ── Terminal card ──────────────────────────────────────────────────────────

/** Beacon freshness: the supervisor treats > 120 s (`EA:AutoHeal:BeaconFreshSeconds`) as stale. */
export const BEACON_FRESH_SECONDS = 120;

export interface BeaconSummary {
  text: string;
  tone: Tone;
}

export function beaconSummary(b: EABeacon | null | undefined, nowMs: number): BeaconSummary {
  if (!b) return { text: 'No beacon (EA older than v8.47.259, or not on this terminal)', tone: 'muted' };
  const age = ageSeconds(b.lastTimerUtc ?? b.writtenAtUtc, nowMs);
  const ageWords = age == null ? 'time unknown' : `${formatDuration(age)} ago`;
  switch (b.phase) {
    case 'init_failed':
      return {
        text: `Start-up failed${b.initFailReason ? ` — ${b.initFailReason}` : ''} (${ageWords})`,
        tone: 'bad',
      };
    case 'deinit':
      return {
        text: `EA was removed from its chart${b.initFailReason ? ` (${b.initFailReason})` : ''} — ${ageWords}`,
        tone: 'bad',
      };
    case 'init':
      return {
        text: `Starting up${b.initFailReason ? ` — ${b.initFailReason}` : ''} (${ageWords})`,
        tone: 'warn',
      };
    default: {
      const fresh = age != null && age <= BEACON_FRESH_SECONDS;
      return {
        text: fresh
          ? `Alive — last cycle ${ageWords}`
          : `Silent — last cycle ${ageWords}. The EA may be frozen.`,
        tone: fresh ? 'ok' : 'bad',
      };
    }
  }
}

export function watchdogSummary(
  w: EAInstallRuntime['watchdog'] | null | undefined,
  nowMs: number,
): BeaconSummary {
  if (!w || !w.state) return { text: 'Not reported', tone: 'muted' };
  const restarts = w.restartsLastHour ?? 0;
  const restartsText = restarts ? ` · ${restarts} restart${restarts === 1 ? '' : 's'} in the last hour` : '';
  switch (w.state) {
    case 'ok':
      return { text: `Watching${restartsText}`, tone: 'ok' };
    case 'restarting':
      return { text: `Restarting the terminal now${restartsText}`, tone: 'warn' };
    case 'backoff': {
      const next = parseUtcMs(w.nextAttemptUtc);
      const inText = next ? ` — next try in ${formatDuration((next - nowMs) / 1000)}` : '';
      return { text: `Waiting before retrying${inText}${restartsText}`, tone: 'warn' };
    }
    case 'gave_up':
      return { text: `Gave up restarting — needs an operator${restartsText}`, tone: 'bad' };
    case 'disabled':
      return { text: 'Off (terminal stopped or auto-heal off)', tone: 'muted' };
    default:
      return { text: w.state, tone: 'muted' };
  }
}

export function journalWarnings(
  j: EAInstallRuntime['journalSignals'] | null | undefined,
): string[] {
  if (!j) return [];
  const out: string[] = [];
  if (j.oldTick)
    out.push('The journal shows "old tick" errors — the MT5 client may be older than the broker server.');
  if (j.invalidBook) out.push('The journal shows invalid order-book data. A terminal restart usually clears it.');
  if (j.debuggerFound)
    out.push('MT5 stopped with "debugger has been found" — the Wine wrapper is too old for this MT5 build.');
  return out;
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 10) : '—';
}

/** Why the terminal buttons are disabled, or null when they can be used. */
export function terminalActionBlocker(t: EATerminalDto | null | undefined): string | null {
  if (!t) return 'Terminal information is not loaded yet.';
  if (t.linkedBy === 'none' || !t.installId)
    return 'No supervised terminal is linked to this EA, so the engine cannot start or stop it.';
  if (!t.daemonOnline)
    return `The host${t.daemonName ? ` "${t.daemonName}"` : ''} is offline — its supervisor is not reporting, so nothing can be sent to it.`;
  return null;
}

// ── Restart-required inputs (C3 SetInputs) ─────────────────────────────────

export type InputType = 's' | 'i' | 'd' | 'b';

export interface RestartInputDef {
  /** Key in the heartbeat `inputs` envelope. */
  key: string;
  /** The EA's `input` name (what SetInputs takes). */
  inp: string;
  label: string;
  type: InputType;
  /** Shown beside the field — what changing it does. */
  warning?: string;
  /** Changing it can cut the EA off from the engine or from its positions. */
  dangerous?: boolean;
}

/**
 * The inputs the EA reads only at attach time. Names are the EA's own `input`
 * declarations (`SelfHealPolicy.mqh` `LascodiaKnownInputs`), which the EA
 * validates again before it applies anything.
 */
export const RESTART_INPUTS: readonly RestartInputDef[] = [
  {
    key: 'engineBaseUrl',
    inp: 'InpEngineBaseUrl',
    label: 'Engine base URL',
    type: 's',
    dangerous: true,
    warning:
      'A wrong address cuts this EA off from the engine; the new address must also be in MT5\'s WebRequest allowed list. Fixing it then needs the terminal.',
  },
  { key: 'symbolMapping', inp: 'InpSymbolMapping', label: 'Broker→Engine symbol map', type: 's' },
  { key: 'timeframes', inp: 'InpTimeframes', label: 'Timeframes', type: 's' },
  { key: 'instanceLabel', inp: 'InpInstanceLabel', label: 'Instance label', type: 's' },
  {
    key: 'magicNumber',
    inp: 'InpMagicNumber',
    label: 'Magic number',
    type: 'i',
    dangerous: true,
    warning:
      'Positions and orders opened under the old magic number stop being recognised as this EA\'s. Only change it with no open positions.',
  },
  { key: 'useAsyncOrders', inp: 'InpUseAsyncOrders', label: 'Use async orders', type: 'b' },
  {
    key: 'useDllTransport',
    inp: 'InpUseDllTransport',
    label: 'Use DLL transport',
    type: 'b',
    warning: 'Needs DLL imports allowed in the terminal, and the bridge running.',
  },
  { key: 'dllBridgeHost', inp: 'InpDllBridgeHost', label: 'DLL bridge host (override)', type: 's' },
  { key: 'dllBridgePort', inp: 'InpDllBridgePort', label: 'DLL bridge port (override)', type: 'i' },
  { key: 'dllBridgeUseTls', inp: 'InpDllBridgeUseTls', label: 'DLL bridge TLS', type: 'b' },
  { key: 'dllBridgeStrictTls', inp: 'InpDllBridgeStrictTls', label: 'DLL bridge strict TLS', type: 'b' },
  {
    key: 'dllBridgeCertFingerprint',
    inp: 'InpDllBridgeCertFingerprint',
    label: 'DLL bridge cert fingerprint (SHA-256)',
    type: 's',
  },
  { key: 'coordinatorStaleSec', inp: 'InpCoordinatorStaleSec', label: 'Coordinator stale (s)', type: 'i' },
  { key: 'casEscalateThreshold', inp: 'InpCasEscalateThreshold', label: 'CAS escalate threshold', type: 'i' },
];

/**
 * The restart-badged fields of the Editable tab: a config push stores them,
 * but they only take effect after the EA restarts. SetInputs changes them and
 * restarts in one step.
 */
export const RESTART_BADGED_INPUTS: Readonly<Record<string, { inp: string; type: InputType }>> = {
  unmatchedDealExpirySec: { inp: 'InpUnmatchedDealExpirySec', type: 'i' },
  tickBufferMax: { inp: 'InpTickBufferMax', type: 'i' },
  telemetryEndpoint: { inp: 'InpTelemetryEndpoint', type: 's' },
  telemetryPushSec: { inp: 'InpTelemetryPushSec', type: 'i' },
  enableNewsBlackout: { inp: 'InpEnableNewsBlackout', type: 'b' },
  newsBlackoutFilePath: { inp: 'InpNewsBlackoutFilePath', type: 's' },
  enableFileLogging: { inp: 'InpEnableFileLogging', type: 'b' },
  logJsonFormat: { inp: 'InpLogJsonFormat', type: 'b' },
  enableChartPanel: { inp: 'InpEnableChartPanel', type: 'b' },
};

export type InputEdit = string | number | boolean | null | undefined;

/** True when an edit differs from the EA's current value. Blank text = "keep current". */
export function isInputEdited(def: { type: InputType }, edit: InputEdit, current: unknown): boolean {
  if (edit === undefined || edit === null) return false;
  if (def.type === 'b') return typeof edit === 'boolean' && edit !== current;
  if (def.type === 's') return String(edit) !== String(current ?? '');
  if (edit === '') return false;
  const n = Number(edit);
  if (!Number.isFinite(n)) return true; // invalid — surfaced by validateInputEdit
  return current !== n;
}

/** Plain-language validation error, or null. Mirrors what the EA itself checks. */
export function validateInputEdit(def: { type: InputType; label?: string }, edit: InputEdit): string | null {
  if (edit === undefined || edit === null) return null;
  if (def.type === 'b') return typeof edit === 'boolean' ? null : 'Choose yes or no.';
  if (def.type === 's') {
    const s = String(edit);
    if (/[\r\n]/.test(s)) return 'Line breaks are not allowed.';
    if (s.length > 512) return 'At most 512 characters.';
    return null;
  }
  const s = String(edit).trim();
  if (def.type === 'i' && !/^[+-]?\d+$/.test(s)) return 'Enter a whole number.';
  if (def.type === 'd' && !Number.isFinite(Number(s))) return 'Enter a number.';
  return null;
}

/**
 * Builds the SetInputs `inputs` object from edits keyed by envelope key.
 * Returns the body plus any validation errors (by envelope key); nothing is
 * sent when `errors` is non-empty.
 */
export function buildSetInputs(
  defs: readonly RestartInputDef[] | Readonly<Record<string, { inp: string; type: InputType }>>,
  edits: Readonly<Record<string, InputEdit>>,
  current: Readonly<Record<string, unknown>> | null | undefined,
): { inputs: Record<string, string | number | boolean>; errors: Record<string, string>; changed: string[] } {
  const list: { key: string; inp: string; type: InputType }[] = Array.isArray(defs)
    ? (defs as readonly RestartInputDef[]).map((d) => ({ key: d.key, inp: d.inp, type: d.type }))
    : Object.entries(defs as Record<string, { inp: string; type: InputType }>).map(([key, v]) => ({
        key,
        inp: v.inp,
        type: v.type,
      }));
  const inputs: Record<string, string | number | boolean> = {};
  const errors: Record<string, string> = {};
  const changed: string[] = [];
  for (const d of list) {
    const edit = edits[d.key];
    if (!isInputEdited(d, edit, current?.[d.key])) continue;
    const err = validateInputEdit(d, edit);
    if (err) {
      errors[d.key] = err;
      continue;
    }
    changed.push(d.key);
    if (d.type === 'b') inputs[d.inp] = edit as boolean;
    else if (d.type === 's') inputs[d.inp] = String(edit);
    else inputs[d.inp] = Number(String(edit).trim());
  }
  return { inputs, errors, changed };
}

// ── EA list page ───────────────────────────────────────────────────────────

/** Which fleet rows get a health verdict: live-ish ones only (heartbeat in the last 7 days, not deregistered). */
export function wantsHealth(
  row: { status: string; lastHeartbeat: string | null | undefined; deregisteredAt?: string | null },
  nowMs: number,
): boolean {
  if (row.deregisteredAt) return false;
  const age = ageSeconds(row.lastHeartbeat, nowMs);
  return age != null && age < 7 * 24 * 3600;
}

// ── Confirm copy for every action ──────────────────────────────────────────

export interface ActionCopy {
  title: string;
  description: string;
  warning: string | null;
  confirmLabel: string;
  tone: 'ok' | 'warn' | 'bad';
  askReason: boolean;
  reasonRequired: boolean;
}

export interface ActionContext {
  installName?: string | null;
  hostName?: string | null;
  version?: string | null;
  autoHealOn?: boolean;
}

/** What each button does, said before it is done. */
export function actionCopy(action: string, ctx: ActionContext = {}): ActionCopy {
  const terminal = ctx.installName ? `the MT5 terminal "${ctx.installName}"` : 'the MT5 terminal';
  const host = ctx.hostName ? ` on ${ctx.hostName}` : '';
  switch (action) {
    case 'force-recovery':
      return {
        title: 'Force recovery',
        description:
          "Clears the EA's failed-recovery flag and runs its start-up checks again. If they pass, the EA leaves safe mode and can trade again.\n\nIt never lifts an operator's safety stop or the kill switch.",
        warning: null,
        confirmLabel: 'Force recovery',
        tone: 'warn',
        askReason: true,
        reasonRequired: false,
      };
    case 'terminal/start':
      return {
        title: 'Start terminal',
        description: `The host supervisor starts ${terminal}${host}. Its EAs attach by themselves and, once signed in, trade this account again.`,
        warning: null,
        confirmLabel: 'Start terminal',
        tone: 'warn',
        askReason: true,
        reasonRequired: false,
      };
    case 'terminal/restart':
      return {
        title: 'Restart terminal',
        description: `The host closes ${terminal}${host} (gracefully, forcibly after 20 s) and starts it again. Every EA on this terminal is offline for about a minute.`,
        warning:
          'Open positions stay at the broker with their stop loss and take profit, but trailing stops do not move while the terminal is down.',
        confirmLabel: 'Restart terminal',
        tone: 'warn',
        askReason: true,
        reasonRequired: false,
      };
    case 'terminal/stop':
      return {
        title: 'Stop terminal',
        description: `The host closes ${terminal}${host} and keeps it closed. Every EA on it stops.`,
        warning:
          'Auto-heal and the host watchdog will NOT start it again — it stays stopped until you press Start. Open positions stay at the broker with their stop loss and take profit, but nothing manages them (no trailing stops) while it is stopped.',
        confirmLabel: 'Stop terminal',
        tone: 'bad',
        askReason: true,
        reasonRequired: true,
      };
    case 'clear-safety-stop':
      return {
        title: 'Clear safety stop',
        description: 'Lifts the operator safety stop. The EA returns to running and starts taking new trades.',
        warning: null,
        confirmLabel: 'Clear safety stop',
        tone: 'warn',
        askReason: true,
        reasonRequired: false,
      };
    case 'release-kill-switch':
      return {
        title: 'Release kill switch',
        description:
          'Lifts the kill switch. The EA can open new trades again (other safety limits still apply). Positions it closed are not reopened.',
        warning: null,
        confirmLabel: 'Release kill switch',
        tone: 'warn',
        askReason: true,
        reasonRequired: false,
      };
    case 'autoheal':
      return {
        title: 'Turn auto-heal on',
        description:
          'When this EA stops working, the engine may force a recovery, restart the EA, or restart / start its terminal by itself — step by step, at most 3 terminal restarts an hour. It never lifts an operator halt.',
        warning: null,
        confirmLabel: 'Turn on',
        tone: 'ok',
        askReason: false,
        reasonRequired: false,
      };
    case 'autoheal-off':
      return {
        title: 'Turn auto-heal off',
        description:
          'The engine stops recovering and restarting this EA and its terminal by itself. Problems still show here; fixing them is then up to you.',
        warning: null,
        confirmLabel: 'Turn off',
        tone: 'warn',
        askReason: false,
        reasonRequired: false,
      };
    case 'deploy':
      return {
        title: ctx.version ? `Update EA to ${ctx.version}` : 'Update EA',
        description: `Puts ${ctx.version ? `EA ${ctx.version}` : 'the latest EA build'} on ${terminal}${host} and restarts every EA on that terminal on it. Each EA is offline for a few seconds while it reloads.`,
        warning: 'Every EA instance on this terminal restarts, not only this one.',
        confirmLabel: ctx.version ? `Update to ${ctx.version}` : 'Update EA',
        tone: 'warn',
        askReason: true,
        reasonRequired: false,
      };
    default:
      return {
        title: action,
        description: '',
        warning: null,
        confirmLabel: 'Confirm',
        tone: 'warn',
        askReason: true,
        reasonRequired: false,
      };
  }
}

// ── Clean up old files (PruneFiles, C6) ───────────────────────────────────

/** Health-card fix actions that open the two-step clean-up instead of a plain confirm. */
export const PRUNE_FILES_ACTION = 'prune-files';

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** A PruneFiles job's `resultData`, tolerant of missing fields; null when it is not one. */
export function parsePruneResult(data: Record<string, unknown> | null | undefined): PruneFilesResult | null {
  if (!data || typeof data !== 'object' || typeof data['fileCount'] !== 'number') return null;
  const files = Array.isArray(data['files'])
    ? (data['files'] as unknown[])
        .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
        .map(
          (f): PruneFileItem => ({
            path: typeof f['path'] === 'string' ? (f['path'] as string) : '',
            bytes: num(f['bytes']),
            reason: typeof f['reason'] === 'string' ? (f['reason'] as string) : '',
          }),
        )
    : [];
  return {
    dryRun: data['dryRun'] !== false,
    fileCount: num(data['fileCount']),
    totalBytes: num(data['totalBytes']),
    deletedCount: num(data['deletedCount']),
    freedBytes: num(data['freedBytes']),
    failures: Array.isArray(data['failures']) ? (data['failures'] as unknown[]).map(String) : [],
    files,
    truncated: data['truncated'] === true,
  };
}

export interface PruneGroup {
  reason: string;
  count: number;
  bytes: number;
  files: PruneFileItem[];
}

/** The listed files grouped by why they go, biggest group first; files in a group biggest first. */
export function pruneGroups(files: readonly PruneFileItem[]): PruneGroup[] {
  const byReason = new Map<string, PruneGroup>();
  for (const f of files) {
    const reason = f.reason || 'Old file';
    const g = byReason.get(reason) ?? { reason, count: 0, bytes: 0, files: [] };
    g.count++;
    g.bytes += f.bytes;
    g.files.push(f);
    byReason.set(reason, g);
  }
  const groups = [...byReason.values()];
  for (const g of groups) g.files.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
  return groups.sort((a, b) => b.bytes - a.bytes || a.reason.localeCompare(b.reason));
}

/** The file name and the folder it is in, for a long Windows/Wine path. */
export function pruneFileLabel(path: string): { name: string; folder: string } {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const name = parts.pop() ?? path;
  return { name, folder: parts.slice(-2).join('/') };
}

function files(n: number): string {
  return n === 1 ? '1 file' : `${n} files`;
}

/** What the dry run found, in one sentence. */
export function pruneDryRunText(r: PruneFilesResult): string {
  if (r.fileCount <= 0) return 'Nothing to clean up: no old files match the clean-up rules.';
  return (
    `${files(r.fileCount)} can be deleted, freeing ${formatBytes(r.totalBytes)}.` +
    (r.truncated ? ` Only the first ${r.files.length} are listed below.` : '')
  );
}

/** What the real clean-up did, in one sentence. */
export function pruneOutcomeText(r: PruneFilesResult): string {
  const failed = r.failures.length;
  const done =
    r.deletedCount > 0
      ? `Deleted ${files(r.deletedCount)}, freed ${formatBytes(r.freedBytes)}.`
      : 'No file was deleted.';
  return failed > 0 ? `${done} ${files(failed)} could not be deleted (in use or no permission).` : done;
}

/** The confirm button of the review step. */
export function pruneConfirmLabel(r: PruneFilesResult | null): string {
  return r && r.fileCount > 0 ? `Delete ${files(r.fileCount)} (${formatBytes(r.totalBytes)})` : 'Delete files';
}

/** Fixed copy of the clean-up dialog. */
export const PRUNE_COPY = {
  title: 'Clean up old files',
  intro:
    "The host supervisor lists old files on this terminal's computer first: terminal journals and EA logs older than 14 days, and the files of EA instances that have been silent for 30 days or more. Nothing is deleted until you confirm the list.",
  safe: 'Never deleted: sign-in credentials, settings, chart templates, and reports or orders still waiting to be sent (outbox, retry queue, recovery, dead letters). The newest file of every kind is always kept.',
} as const;
