import type { EAConfigInputs } from '@core/api/api.types';

export interface InputCell {
  key: string;
  label: string;
  value: string;
  tone: 'ok' | 'warn' | 'bad' | 'info';
}

/**
 * Cells read from the heartbeat `inputs` block. The per-symbol daily-loss limit shows 0 as "Off" (that is what 0
 * means on the EA — the gate is not checked); gap fill shows whether the filler runs and where its setting comes
 * from (engine override vs the chart input). Omitted when the EA build does not report the field.
 */
export function inputCells(inputs: EAConfigInputs | null | undefined): InputCell[] {
  const out: InputCell[] = [];
  const pct = inputs?.maxDailyLossPerSymbolPct;
  if (typeof pct === 'number') {
    out.push({
      key: 'dailyLossPerSymbol',
      label: 'Daily loss limit per symbol',
      value: pct === 0 ? 'Off' : `${pct}% equity`,
      tone: pct === 0 ? 'warn' : 'ok',
    });
  }
  if (typeof inputs?.mdGapFillActive === 'boolean') {
    const source = inputs.mdGapFillOverride === true ? 'engine override' : 'chart input';
    out.push({
      key: 'gapFill',
      label: 'Tick gap fill',
      value: `${inputs.mdGapFillActive ? 'Running' : 'Off'} · ${source}`,
      tone: 'info',
    });
  }
  return out;
}
