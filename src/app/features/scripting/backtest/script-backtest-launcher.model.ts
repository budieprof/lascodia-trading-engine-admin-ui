/** Checks the launcher form; returns the first problem, or null. */
export function validateBacktestForm(f: {
  fromDate: string;
  toDate: string;
  symbolOverride: string;
}): string | null {
  if (!f.fromDate || !f.toDate) return 'Choose a start and an end date.';
  if (Date.parse(f.toDate) <= Date.parse(f.fromDate))
    return 'The end date must be after the start.';
  const sym = f.symbolOverride.trim();
  if (sym && !/^[A-Za-z0-9]{1,10}$/.test(sym))
    return 'The symbol override must be 1–10 letters or digits.';
  return null;
}
