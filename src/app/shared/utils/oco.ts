/**
 * One-cancels-other groups, shown the same way on every page: a short code and a colour derived
 * from the group id, so the legs of one group read as a set at a glance (same colour, same code)
 * on the recommendations grid, the monitor board and the detail views.
 */

/** Hues that stay clear of the buy-green / sell-red the cards already use for direction. */
const OCO_HUES = [212, 268, 28, 188, 305, 45, 240, 335, 172, 288] as const;

/** "oco-ad37ee6142ca" → "AD37". Ids without the prefix use their first four characters. */
export function ocoShortCode(groupId: string | null | undefined): string {
  if (!groupId) return '';
  const bare = groupId.replace(/^oco-/i, '');
  return (bare.slice(0, 4) || bare).toUpperCase();
}

/** Stable hue for a group (FNV-1a over the id), from a palette that avoids red and green. */
export function ocoHue(groupId: string | null | undefined): number {
  if (!groupId) return OCO_HUES[0];
  let h = 0x811c9dc5;
  for (let i = 0; i < groupId.length; i++) {
    h ^= groupId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return OCO_HUES[h % OCO_HUES.length];
}

/** Statuses after which a leg can no longer fire or fill. */
const ENDED = new Set(['Cancelled', 'Expired', 'Invalidated', 'Withdrawn', 'Rejected', 'Error']);

export function ocoLegEnded(status: string | null | undefined): boolean {
  return !!status && ENDED.has(status);
}

/** One linked leg as the chip lists it. */
export interface OcoChipPartner {
  id: number;
  /** "Buy Limit · Filed" — shown in the tooltip. */
  label?: string | null;
  /** Struck through: the leg was cancelled or otherwise ended. */
  ended?: boolean;
}
