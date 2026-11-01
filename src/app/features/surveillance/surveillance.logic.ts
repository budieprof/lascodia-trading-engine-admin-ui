import type {
  JobStatus,
  SurveillanceDetector,
  SurveillanceKey,
  SurveillanceResolution,
  SurveillanceSeverity,
  SurveillanceStatus,
} from './surveillance.types';

export const SEVERITIES: SurveillanceSeverity[] = ['Low', 'Medium', 'High', 'Critical'];
export const STATUSES: SurveillanceStatus[] = ['Open', 'UnderReview', 'Closed'];
export const RESOLUTIONS: SurveillanceResolution[] = ['FalsePositive', 'Escalated', 'Actioned'];

/** Fewest characters of a closing note (the engine's `SurveillanceAlertLifecycle.MinCloseNoteLength`). */
export const MIN_CLOSE_NOTE = 10;

export function statusLabel(s: SurveillanceStatus): string {
  return s === 'UnderReview' ? 'Under review' : s;
}

export function resolutionLabel(r: SurveillanceResolution | null | undefined): string {
  switch (r) {
    case 'FalsePositive':
      return 'False positive';
    case 'Escalated':
      return 'Escalated';
    case 'Actioned':
      return 'Actioned';
    default:
      return '';
  }
}

/** The pill class of a severity. */
export function severityTone(s: SurveillanceSeverity): 'bad' | 'warn' | 'info' | 'muted' {
  return s === 'Critical' ? 'bad' : s === 'High' ? 'warn' : s === 'Medium' ? 'info' : 'muted';
}

/** Why a review move cannot be sent as it is (mirrors the engine's rule), or null. */
export function transitionProblem(
  from: SurveillanceStatus,
  to: SurveillanceStatus,
  resolution: SurveillanceResolution | null,
  note: string,
): string | null {
  if (from === 'Closed') return 'A closed alert stays closed. Add a note instead.';
  if (from === to) return `The alert is already ${statusLabel(to).toLowerCase()}.`;
  if (to === 'Closed') {
    if (!resolution) return 'Pick a resolution: false positive, escalated or actioned.';
    if (note.trim().length < MIN_CLOSE_NOTE)
      return `Say why in a note of at least ${MIN_CLOSE_NOTE} characters.`;
  }
  return null;
}

/** "3 min ago" / "in 12 min" / "2 h ago" from an ISO time (UTC). */
export function relative(iso: string | null | undefined, now: Date): string {
  if (!iso) return '—';
  const t = Date.parse(iso.endsWith('Z') || /[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`);
  if (Number.isNaN(t)) return '—';
  const s = Math.round((t - now.getTime()) / 1000);
  const abs = Math.abs(s);
  const text =
    abs < 60
      ? `${abs} s`
      : abs < 3600
        ? `${Math.round(abs / 60)} min`
        : abs < 172800
          ? `${Math.round(abs / 3600)} h`
          : `${Math.round(abs / 86400)} d`;
  return s >= 0 ? `in ${text}` : `${text} ago`;
}

/** One word for a job's state: never run, ok, failing, late (overdue by more than 10 minutes), skipped. */
export function jobHealth(
  s: JobStatus | null | undefined,
  now: Date,
): 'never' | 'ok' | 'failing' | 'late' | 'skipped' {
  if (!s || !s.lastFinishedAtUtc) return 'never';
  if (s.lastOutcome === 'Failed') return 'failing';
  if (s.nextRunAtUtc) {
    const next = Date.parse(s.nextRunAtUtc.endsWith('Z') ? s.nextRunAtUtc : `${s.nextRunAtUtc}Z`);
    if (!Number.isNaN(next) && now.getTime() - next > 10 * 60_000) return 'late';
  }
  return s.lastOutcome === 'Skipped' ? 'skipped' : 'ok';
}

/** The kind of control a Surveillance:* key gets on the settings page. */
export type ControlKind = 'bool' | 'int' | 'decimal' | 'severity';

export function controlKind(k: SurveillanceKey): ControlKind {
  if (k.dataType === 'Bool') return 'bool';
  if (k.key.endsWith(':Severity') || k.key.endsWith('NotifyMinSeverity')) return 'severity';
  return k.dataType === 'Int' ? 'int' : 'decimal';
}

/** The value a control shows: the stored one, else the default. */
export function effective(k: SurveillanceKey): string {
  return k.value ?? k.default;
}

/** The bounds of a detector threshold key (from the detector catalogue), or null for other keys. */
export function boundsOf(
  key: string,
  detectors: SurveillanceDetector[],
): { min: number; max: number } | null {
  for (const d of detectors)
    for (const p of d.parameters) if (p.configKey === key) return { min: p.min, max: p.max };
  const global: Record<string, { min: number; max: number }> = {
    'Surveillance:PollIntervalSeconds': { min: 60, max: 86400 },
    'Surveillance:LookbackHours': { min: 1, max: 168 },
    'Surveillance:MaxOrdersPerCycle': { min: 100, max: 200000 },
    'Surveillance:MaxQuoteLookupsPerCycle': { min: 0, max: 50000 },
  };
  return global[key] ?? null;
}

/** Why a typed value cannot be saved, or null (the engine clamps too; the page refuses first). */
export function valueProblem(
  k: SurveillanceKey,
  raw: string,
  detectors: SurveillanceDetector[],
): string | null {
  const kind = controlKind(k);
  const v = raw.trim();
  if (kind === 'bool') return v === 'true' || v === 'false' ? null : 'true or false.';
  if (kind === 'severity')
    return (SEVERITIES as string[]).includes(v) ? null : 'Low, Medium, High or Critical.';
  if (v === '' || !/^-?\d+(\.\d+)?$/.test(v)) return 'A number.';
  const n = Number(v);
  if (kind === 'int' && !Number.isInteger(n)) return 'A whole number.';
  const b = boundsOf(k.key, detectors);
  if (b && (n < b.min || n > b.max)) return `Between ${b.min} and ${b.max}.`;
  return null;
}

/** The keys of one detector (`Surveillance:{Detector}:*`), switch and severity first. */
export function detectorKeys(keys: SurveillanceKey[], detector: string): SurveillanceKey[] {
  const prefix = `Surveillance:${detector}:`;
  const rank = (k: SurveillanceKey) =>
    k.key.endsWith(':Enabled') ? 0 : k.key.endsWith(':Severity') ? 1 : 2;
  return keys.filter((k) => k.key.startsWith(prefix)).sort((a, b) => rank(a) - rank(b));
}

/** The keys that are not a detector's (cadence, lookback, notification). */
export function globalKeys(
  keys: SurveillanceKey[],
  detectors: SurveillanceDetector[],
): SurveillanceKey[] {
  return keys.filter((k) => !detectors.some((d) => k.key.startsWith(`Surveillance:${d.key}:`)));
}

/** The last segment of a key, spaced: `Surveillance:WashTrade:WindowSeconds` → "Window seconds". */
export function keyLabel(key: string): string {
  const last = key.split(':').pop() ?? key;
  const words = last.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A metric value for the evidence table. */
export function metricText(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number')
    return Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** ISO 17442 LEI check (MOD 97-10, as the engine checks it); null when valid, else why not. Blank = null (optional here). */
export function leiProblem(raw: string | null | undefined): string | null {
  const lei = (raw ?? '').trim().toUpperCase();
  if (!lei) return null;
  if (!/^[A-Z0-9]{18}[0-9]{2}$/.test(lei))
    return '20 letters and digits ending in two check digits.';
  let rem = 0;
  for (const c of lei) {
    const v = c >= '0' && c <= '9' ? c.charCodeAt(0) - 48 : c.charCodeAt(0) - 55;
    rem = v >= 10 ? (rem * 100 + v) % 97 : (rem * 10 + v) % 97;
  }
  return rem === 1 ? null : 'The check digits do not match (mistyped?).';
}
