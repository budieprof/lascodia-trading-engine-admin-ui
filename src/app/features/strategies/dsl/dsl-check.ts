import type { DslIssueDto, DslSummaryDto, ResponseData } from '@core/api/api.types';
import type { DslIssue } from './dsl-model';

/** A `POST /strategy/dsl/summarise` answer, whichever engine build gave it. */
export interface DslCheckResult {
  summary: string | null;
  isValid: boolean;
  errors: DslIssue[];
  warnings: DslIssue[];
}

function toIssues(list: unknown, severity: DslIssue['severity']): DslIssue[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((i): i is DslIssueDto => !!i && typeof i === 'object')
    .map((i) => ({
      path: typeof i.path === 'string' ? i.path : '',
      message: typeof i.message === 'string' && i.message ? i.message : 'Invalid',
      severity,
    }));
}

/**
 * Pre-path engine builds reported tree errors as prose — "EntryConditionsRoot:
 * child #1: child #0: Indicator period 1 outside [2, 500]". Recover the node
 * path from that so the error still lands on the right builder row.
 */
export function issueFromLegacyMessage(message: string): DslIssue {
  const tree = /^(Entry|Exit)ConditionsRoot:\s*((?:child #\d+:\s*)*)(.*)$/is.exec(message);
  if (tree) {
    const indices = [...tree[2].matchAll(/child #(\d+)/g)].map((m) => `.children[${m[1]}]`);
    const root = tree[1].toLowerCase() === 'entry' ? 'entryConditionsRoot' : 'exitConditionsRoot';
    return { path: root + indices.join(''), message: tree[3].trim() || message, severity: 'error' };
  }
  const flat = /^Entry condition #(\d+):\s*(.*)$/is.exec(message);
  if (flat) {
    return {
      path: `entryConditions[${flat[1]}]`,
      message: flat[2].trim() || message,
      severity: 'error',
    };
  }
  return { path: '', message, severity: 'error' };
}

/**
 * Normalises the summarise response. The current engine returns
 * `{ summary, isValid, errors, warnings }`; builds before it returned the
 * summary string on success and `data: null` + the error in `message` on
 * failure. Both land in one shape so the form never branches on the build.
 */
export function normaliseDslCheck(
  res: ResponseData<DslSummaryDto | string | null> | null | undefined,
): DslCheckResult {
  if (!res) {
    return {
      summary: null,
      isValid: false,
      errors: [{ path: '', message: 'No response from the DSL check', severity: 'error' }],
      warnings: [],
    };
  }
  const data = res.data as unknown;
  if (data && typeof data === 'object') {
    const d = data as Partial<DslSummaryDto>;
    const errors = toIssues(d.errors, 'error');
    const warnings = toIssues(d.warnings, 'warning');
    const isValid = d.isValid !== false && res.status !== false && errors.length === 0;
    if (!isValid && errors.length === 0) {
      errors.push({ path: '', message: res.message || 'The DSL is invalid', severity: 'error' });
    }
    return { summary: typeof d.summary === 'string' ? d.summary : null, isValid, errors, warnings };
  }
  if (typeof data === 'string') {
    return res.status
      ? { summary: data, isValid: true, errors: [], warnings: [] }
      : {
          summary: null,
          isValid: false,
          errors: [issueFromLegacyMessage(res.message || data)],
          warnings: [],
        };
  }
  return res.status
    ? { summary: null, isValid: true, errors: [], warnings: [] }
    : {
        summary: null,
        isValid: false,
        errors: [issueFromLegacyMessage(res.message || 'The DSL is invalid')],
        warnings: [],
      };
}
