import type {
  AccessReviewCampaign,
  FindingSeverity,
  ReleaseComponent,
  ReleaseNote,
  ReviewFinding,
} from './security.types';

/** Plain words for each finding kind the engine reports. */
export const FINDING_LABELS: Record<string, string> = {
  'inactive-user-with-grants': 'Deactivated user still holds access',
  'grant-without-membership': 'Access without membership',
  'stale-privileged-grant': 'Unused privileged access',
  'stale-person': 'No sign-in for 90 days',
  'stale-grant': 'Unused grant',
  'stale-machine-identity': 'Unused terminal credential',
  'stale-api-token': 'Unused API token',
  'grant-expiring': 'Grant expiring soon',
};

export function findingLabel(kind: string): string {
  return FINDING_LABELS[kind] ?? kind;
}

const RANK: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2 };

/** Most serious first, then by kind and subject (the engine sends them sorted; this keeps a filtered view stable). */
export function sortFindings(findings: readonly ReviewFinding[]): ReviewFinding[] {
  return [...findings].sort(
    (a, b) =>
      (RANK[a.severity] ?? 3) - (RANK[b.severity] ?? 3) ||
      a.kind.localeCompare(b.kind) ||
      a.subject.localeCompare(b.subject),
  );
}

export function countBySeverity(
  findings: readonly ReviewFinding[],
): Record<FindingSeverity, number> {
  const out: Record<FindingSeverity, number> = { high: 0, medium: 0, low: 0 };
  for (const f of findings) if (f.severity in out) out[f.severity]++;
  return out;
}

/** Everything the reviewer has to decide on: stale people, grants, terminal credentials and tokens. */
export function staleTotal(c: AccessReviewCampaign): number {
  return (
    c.stalePeopleCount + c.staleGrantCount + c.staleMachineIdentityCount + c.staleApiTokenCount
  );
}

export const MIN_NOTES = 10;
export const MAX_NOTES = 4000;

/**
 * Why the sign-off button is disabled, or null when it may be sent. High findings are allowed (the engine does
 * not block them) but the statement must then say how each was handled.
 */
export function signOffProblem(
  campaign: AccessReviewCampaign | null,
  notes: string,
  acknowledged: boolean,
  highFindings: number,
): string | null {
  if (!campaign) return 'Open a review first.';
  if (campaign.status === 'SignedOff') return 'This review is already signed off.';
  const n = notes.trim().length;
  if (n < MIN_NOTES) return `Say what you checked and decided (at least ${MIN_NOTES} characters).`;
  if (n > MAX_NOTES) return `Keep the statement under ${MAX_NOTES} characters.`;
  if (highFindings > 0 && !acknowledged)
    return 'Confirm that your statement covers every high finding (revoked, or kept and why).';
  return null;
}

/** "abcd…wxyz" — enough of the hash to compare by eye with the export. */
export function shortHash(sha: string | null | undefined): string {
  if (!sha) return '—';
  return sha.length > 16 ? `${sha.slice(0, 8)}…${sha.slice(-8)}` : sha;
}

export const COMPONENT_LABELS: Record<ReleaseComponent, string> = {
  engine: 'Engine',
  console: 'Console',
  ea: 'Expert Advisor',
  'cme-feed': 'CME feed',
};

/** Release notes filtered to one component (all when null), newest first. */
export function filterReleases(
  notes: readonly ReleaseNote[],
  component: ReleaseComponent | null,
): ReleaseNote[] {
  return notes
    .filter((n) => !component || n.component === component)
    .sort((a, b) => b.releasedAtUtc.localeCompare(a.releasedAtUtc) || b.id - a.id);
}

/** `yyyy-mm-dd` for a date input, and the ISO instant the engine takes for it (start or end of that day, UTC). */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function evidencePeriodProblem(from: string, to: string): string | null {
  if (!from || !to) return 'Choose both dates.';
  if (from > to) return '"From" must be on or before "to".';
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (days > 800) return 'A bundle covers at most 800 days.';
  return null;
}

/** Dotted versions compared part by part as numbers ("8.47.256" > "8.47.99"); unparseable parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** How many connected terminals run each EA version, newest first, judged against the latest and minimum builds. */
export interface VersionCount {
  version: string;
  terminals: number;
  isLatest: boolean;
  /** Older than the engine's minimum (`Onboarding:EaMinimumVersion`): the connection wizard flags it. */
  belowMinimum: boolean;
}

export function terminalsByVersion(
  instances: readonly { eaVersion: string | null; status: string }[],
  latest: string | null,
  minimum: string | null,
): VersionCount[] {
  const counts = new Map<string, number>();
  for (const i of instances) {
    if (i.status !== 'Active') continue;
    const v = (i.eaVersion ?? '').trim() || 'unknown';
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([version, terminals]) => ({
      version,
      terminals,
      isLatest: latest !== null && version === latest,
      belowMinimum: version !== 'unknown' && !!minimum && compareVersions(version, minimum) < 0,
    }))
    .sort((a, b) => compareVersions(b.version, a.version));
}
