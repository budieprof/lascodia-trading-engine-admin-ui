/**
 * The write preflight's verdict on an assistant approval card, as a small badge.
 *
 * <p>Before the assistant shows an approval card for an engine write, the engine dry-runs it
 * (engine `AdminAssistant/Preflight`). A write that would fail never becomes a card; one that
 * would succeed carries the verdict on the card's arguments under `preflight`:</p>
 *
 * <pre>{ verdict: 'wouldSucceed' | 'wouldSucceedWithWarnings' | 'notChecked' | 'wouldFail',
 *   label: 'checked: would succeed', errors: string[], warnings: string[], note?: string,
 *   checkedAtUtc: string }</pre>
 *
 * <p>A card with no `preflight` was not checked at all — the checker itself failed, or the card
 * predates the preflight. That is said plainly, without alarm: the approval works as before.</p>
 *
 * <p>Display only. The engine's confirm ignores `preflight`, and so does approve / dismiss here.</p>
 */

export type PreflightTone = 'pass' | 'warn' | 'neutral' | 'fail';

export interface PreflightBadge {
  tone: PreflightTone;
  /** The one line shown on the card. */
  label: string;
  /** Hover text: the warnings / errors / note and when it was checked. */
  title: string;
  /** Warnings (or errors) worth listing under the badge. */
  details: string[];
}

const UI_ACTION = 'ui_action';

const NO_DRY_RUN_TITLE =
  'The engine looked at this change but could not dry-run it (see the note), so nobody has ' +
  'checked whether it would succeed. Approving it works as usual.';

const NOT_CHECKED_TITLE =
  'The engine did not dry-run this change before showing the card, so nobody has checked ' +
  'whether it would succeed. Approving it works as usual.';

/**
 * The badge for one approval card, or null when the card is not an engine write the assistant
 * addresses by operation (page commands, the spot chat's literal http calls, unreadable args).
 */
export function preflightBadgeOf(
  toolName: string | null | undefined,
  toolArgsJson: string | null | undefined,
): PreflightBadge | null {
  if (toolName === UI_ACTION || !toolArgsJson) return null;
  let args: unknown;
  try {
    args = JSON.parse(toolArgsJson);
  } catch {
    return null;
  }
  if (!isObject(args)) return null;

  const p = args['preflight'];
  if (!isObject(p)) {
    // Only an assistant engine write (addressed by operationId) is ever pre-checked; saying
    // "not pre-checked" on other kinds of card would suggest a check they never get.
    if (typeof args['operationId'] !== 'string' || !args['operationId']) return null;
    return { tone: 'neutral', label: 'Not pre-checked', title: NOT_CHECKED_TITLE, details: [] };
  }

  const verdict = typeof p['verdict'] === 'string' ? p['verdict'] : '';
  const errors = strings(p['errors']);
  const warnings = strings(p['warnings']);
  const note = typeof p['note'] === 'string' && p['note'].trim() ? p['note'].trim() : null;
  const at = typeof p['checkedAtUtc'] === 'string' ? p['checkedAtUtc'] : null;
  const engineLabel = typeof p['label'] === 'string' && p['label'].trim() ? p['label'].trim() : '';

  let tone: PreflightTone;
  let label: string;
  let details: string[];
  switch (verdict) {
    case 'wouldSucceed':
      tone = 'pass';
      label = engineLabel || 'checked: would succeed';
      details = [];
      break;
    case 'wouldSucceedWithWarnings':
      tone = 'warn';
      label = engineLabel || `checked: would succeed, with ${warnings.length} warning(s)`;
      details = warnings;
      break;
    case 'wouldFail':
      // The engine never shows such a card; if one arrives, say so loudly rather than pass it.
      tone = 'fail';
      label = engineLabel || 'checked: would fail';
      details = errors;
      break;
    case 'notChecked':
      tone = 'neutral';
      label = engineLabel || 'not checked';
      details = [];
      break;
    default:
      tone = 'neutral';
      label = engineLabel || 'Not pre-checked';
      details = [];
  }

  const lines: string[] = [];
  if (tone === 'pass')
    lines.push('A dry run of this exact change passed every check the engine makes.');
  if (tone === 'warn')
    lines.push('A dry run passed, but the engine raised warnings worth reading:');
  if (tone === 'fail') lines.push('A dry run says the engine would refuse this change:');
  if (tone === 'neutral')
    lines.push(verdict === 'notChecked' ? NO_DRY_RUN_TITLE : NOT_CHECKED_TITLE);
  for (const d of details) lines.push(`• ${d}`);
  if (tone !== 'warn' && tone !== 'fail') for (const w of warnings) lines.push(`• ${w}`);
  if (note && !label.includes(note)) lines.push(`Note: ${note}`);
  if (at) lines.push(`Checked ${at.replace('T', ' ').replace(/\.\d+/, '').replace(/Z$/, ' UTC')}`);
  return { tone, label: capitalise(label), title: lines.join('\n'), details };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strings(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())
    : [];
}

function capitalise(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

// ── Watch-script replay (`preflight.replay`, engine ScriptReplayPreflight) ──────────────────────

export type ReplayOutcome = 'passed' | 'blocked' | 'notChecked';

export interface ReplayLeg {
  label: string;
  outcome: ReplayOutcome | string;
  summary: string;
  window: string;
  bars: number;
}

export interface ReplayLine {
  outcome: ReplayOutcome;
  tone: PreflightTone;
  /** "Watch script replayed over 2026-11-06..09: ready on the retest ✓". */
  text: string;
  legs: ReplayLeg[];
}

/**
 * The automatic replay of the watch scripts a card would arm, over the setup they were written
 * for. Null when the card arms no script (no `preflight.replay`).
 */
export function replayLineOf(toolArgsJson: string | null | undefined): ReplayLine | null {
  if (!toolArgsJson) return null;
  let args: unknown;
  try {
    args = JSON.parse(toolArgsJson);
  } catch {
    return null;
  }
  if (!isObject(args) || !isObject(args['preflight'])) return null;
  const r = args['preflight']['replay'];
  if (!isObject(r)) return null;
  const legs: ReplayLeg[] = (Array.isArray(r['legs']) ? r['legs'] : [])
    .filter(isObject)
    .map((l) => ({
      label: typeof l['label'] === 'string' ? l['label'] : 'script',
      outcome: typeof l['outcome'] === 'string' ? l['outcome'] : 'notChecked',
      summary: typeof l['summary'] === 'string' ? l['summary'].trim() : '',
      window: replayWindow(l['fromUtc'], l['toUtc']),
      bars: typeof l['bars'] === 'number' ? l['bars'] : 0,
    }));
  const raw = typeof r['outcome'] === 'string' ? r['outcome'] : '';
  const outcome: ReplayOutcome = raw === 'passed' || raw === 'blocked' ? raw : 'notChecked';
  const windows = [...new Set(legs.map((l) => l.window).filter(Boolean))];
  const over = windows.length === 1 ? ` over ${windows[0]}` : '';
  const first =
    legs.find((l) => l.outcome === outcome && l.summary)?.summary ?? legs[0]?.summary ?? '';
  const mark = outcome === 'passed' ? ' ✓' : outcome === 'blocked' ? ' ✕' : '';
  const head =
    outcome === 'notChecked'
      ? `Watch script could not be replayed${over}`
      : `Watch script replayed${over}`;
  const more = legs.length > 1 ? ` (+${legs.length - 1} more)` : '';
  return {
    outcome,
    tone: outcome === 'passed' ? 'pass' : outcome === 'blocked' ? 'fail' : 'neutral',
    text: `${head}${first ? `: ${first}` : ''}${mark}${more}`,
    legs,
  };
}

/** "2026-11-06..09" (same month), "2026-10-30..11-02", or one day. */
export function replayWindow(from: unknown, to: unknown): string {
  const f = typeof from === 'string' ? from.slice(0, 10) : '';
  const t = typeof to === 'string' ? to.slice(0, 10) : '';
  if (!f || !t) return f || t;
  if (f === t) return f;
  if (f.slice(0, 7) === t.slice(0, 7)) return `${f}..${t.slice(8)}`;
  if (f.slice(0, 4) === t.slice(0, 4)) return `${f}..${t.slice(5)}`;
  return `${f}..${t}`;
}
