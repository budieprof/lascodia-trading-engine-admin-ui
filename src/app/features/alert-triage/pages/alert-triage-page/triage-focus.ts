import type { AlertDto } from '@core/api/api.types';

/**
 * The triage page's `?focus=<alertId>` (SP-04): the notification bell links an engine alert here. The linked alert is
 * pinned above the queue whatever the window, severity, type, symbol and status filters say — before 2026-10-09 the
 * link landed on the default "Critical + High, active" queue, so a Medium or auto-resolved alert was simply not there.
 */

/** `?focus=` → a positive alert id, or null for anything else. */
export function parseFocusParam(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return null;
  const id = Number(s);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export type FocusedAlertStatusKey = 'snoozed' | 'inactive' | 'auto-resolved' | 'active';

/** The linked alert's state in the queue's own words (snoozing is this browser's, like the queue's). */
export function focusedAlertStatus(
  alert: Pick<AlertDto, 'isActive' | 'autoResolvedAt'>,
  snoozedUntil: number | null | undefined,
  now: number,
): { key: FocusedAlertStatusKey; label: string } {
  if (snoozedUntil && snoozedUntil > now) return { key: 'snoozed', label: 'Snoozed here' };
  if (!alert.isActive) return { key: 'inactive', label: 'Switched off' };
  if (alert.autoResolvedAt) return { key: 'auto-resolved', label: 'Auto-resolved' };
  return { key: 'active', label: 'Active' };
}
