import type { ColDef } from 'ag-grid-community';

import { shortHash } from '../research-cockpit/research-cockpit.model';

/**
 * C1 version stamp as a grid column: the 8-digit configuration hash a signal / position / run was made by, with
 * "older" when the strategy's current hash is known and differs. Rows without a stamp (legacy rows, or an engine that
 * does not send `strategyConfigHash` on the DTO yet) show "—". Sorting/filtering stay off: the column is read-only
 * provenance, not a server-side sort key.
 */
export function configHashColumn<T = unknown>(
  currentHash: () => string | null = () => null,
): ColDef<T> {
  return {
    headerName: 'Config',
    colId: 'strategyConfigHash',
    width: 110,
    minWidth: 90,
    sortable: false,
    valueGetter: (p) =>
      ((p.data as Record<string, unknown> | undefined)?.['strategyConfigHash'] as string | null) ??
      null,
    valueFormatter: (p) => {
      const short = shortHash(p.value as string | null);
      if (!short) return '—';
      const cur = currentHash();
      return cur && String(p.value).toLowerCase() !== cur.toLowerCase()
        ? `${short} (older)`
        : short;
    },
    headerTooltip:
      'Configuration hash (C1) the row was made by; "older" = not the strategy’s current configuration',
  };
}
