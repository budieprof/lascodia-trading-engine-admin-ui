import type { PineChartData } from '@shared/pine-chart/model/chart-data';
import { toPineChartData } from '@shared/pine-chart/model/chart-data';

import type { ScriptLiveOutputs } from '../api/scripting-api.types';
import { formatDateTime } from '../report/report-format';
import { isoMs } from './parity.model';

/**
 * The live session's own outputs (§8a, SS-I7) as the shared Pine chart reads them. The answer carries no script
 * declaration, so the chart draws the plots over price (as for a stored run without its compile).
 */
export function liveOutputsChartData(
  dto: ScriptLiveOutputs | null | undefined,
): PineChartData | null {
  if (!dto || !Array.isArray(dto.bars) || dto.bars.length === 0) return null;
  const data = toPineChartData({
    declaration: null,
    bars: dto.bars,
    outputs: dto.outputs ?? null,
    report: null,
  });
  return data && data.bars.length > 0 ? data : null;
}

/** What answered and how fresh it is, in one line. */
export function liveOutputsCaption(dto: ScriptLiveOutputs | null | undefined): string {
  if (!dto) return '';
  const where = [dto.symbol, dto.timeframe].filter((s) => !!s).join(' · ');
  const bar =
    dto.barIndex >= 0 ? `bar ${dto.barIndex}${dto.lastBarForming ? ' (forming)' : ''}` : 'no bars';
  if (dto.source === 'session') return `${where} · running session · ${bar}`;
  if (dto.source === 'snapshot') {
    const at = isoMs(dto.snapshotAtUtc ?? null);
    return `${where} · last bar-close snapshot${at !== null ? ` of ${formatDateTime(at)} UTC` : ''} · ${bar}`;
  }
  return where;
}

/**
 * K2: the member to ask for. A portfolio answer (non-empty `portfolioMembers`) keeps the operator's pick while it is
 * still a member, else the first member; a single-symbol strategy (or an engine without K2) asks for none.
 */
export function resolveMember(
  members: readonly string[] | null | undefined,
  current: string | null,
): string | null {
  if (!members || members.length === 0) return null;
  return current && members.includes(current) ? current : members[0];
}
