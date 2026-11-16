/**
 * Arming a watch is two-step when the engine has warnings (CreateAnalysisMonitorCommand): the first
 * request goes WITHOUT `acceptWarnings`; a refusal the operator may override says so ("…Re-submit with
 * acceptWarnings=true…", code -19 for trigger lint, -20 for some script checks). The console shows
 * those warnings and resends with `acceptWarnings: true` only after the operator confirms.
 *
 * Not every -19 can be overridden: "The invalidation is already true on current values" shares the
 * code but is refused for every caller whatever the flag — it is shown as a plain refusal.
 */

/** The lead of the engine's invalidation-on-arrival refusal (CreateAnalysisMonitorCommandHandler). */
export const INVALIDATION_ALREADY_TRUE_LEAD = 'The invalidation is already true on current values';

/** True when a refusal message is a warning the operator may accept by resending with acceptWarnings. */
export function isAcceptableWarning(message: string | null | undefined): boolean {
  if (!message) return false;
  if (message.includes(INVALIDATION_ALREADY_TRUE_LEAD)) return false;
  return /acceptWarnings\s*=\s*true/i.test(message);
}

/**
 * Template fan-out failures read "<subject>: <engine message>". Returns the subjects whose failure
 * is an acceptable warning (so they can be re-armed with acceptWarnings once confirmed).
 */
export function warnedSubjects(failures: readonly string[]): string[] {
  const out: string[] = [];
  for (const f of failures) {
    const i = f.indexOf(': ');
    if (i <= 0) continue;
    if (isAcceptableWarning(f.slice(i + 2))) out.push(f.slice(0, i));
  }
  return out;
}
