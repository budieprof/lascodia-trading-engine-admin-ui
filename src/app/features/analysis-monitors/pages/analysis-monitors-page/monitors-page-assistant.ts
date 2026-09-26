import type { WritableSignal } from '@angular/core';
import type { AnalysisMonitorDto } from '@core/api/api.types';
import type { PageFacts } from '@core/assistant/page-context.types';
import type { UiCommand } from '@core/assistant/ui-command.types';
import type { AnalysisMonitorDetail } from '../../analysis-monitors.types';

/**
 * What the monitors page tells the admin assistant, and the page commands it offers.
 *
 * <p>The page published nothing, so the assistant could operate every monitor endpoint yet could
 * not tell which monitor the operator had open, which filters were set, or what "this one" meant.
 * Pure functions over the page's signals, so the contract is testable without a browser.</p>
 */

export interface MonitorsPageState {
  statusFilter: string;
  search: string;
  origin: string;
  mode: string;
  page: number;
  monitors: readonly AnalysisMonitorDto[];
  counters: Record<string, number> | null;
  detail: AnalysisMonitorDetail | null;
}

/** Timeline rows included for the open monitor — enough to answer "why did it fire?". */
const TIMELINE_ROWS = 12;

export function monitorsPageFacts(s: MonitorsPageState): PageFacts {
  const m = s.detail?.monitor ?? null;
  const figures: Record<string, string | number | null> = {};
  for (const [k, v] of Object.entries(s.counters ?? {})) figures[k] = v;
  if (m) {
    figures['open.status'] = m.status;
    figures['open.symbol'] = m.symbol;
    figures['open.timeframe'] = m.timeframe;
    figures['open.evaluationMode'] = m.evaluationMode;
    figures['open.triggerCount'] = `${m.triggerCount}/${m.maxTriggers}`;
    figures['open.expiresAtUtc'] = m.expiresAtUtc;
    figures['open.lastTriggeredAtUtc'] = m.lastTriggeredAtUtc ?? null;
    figures['open.lastEvalNote'] = m.lastEvalNote ?? null;
    figures['open.intent'] = m.intentText;
    figures['open.trigger'] = m.triggerSpecJson;
    figures['open.action'] = m.actionSpecJson;
    (s.detail?.timeline ?? []).slice(0, TIMELINE_ROWS).forEach((e, i) => {
      figures[`open.timeline[${i}]`] =
        `${e.occurredAtUtc} ${e.kind}${e.fired ? ' (fired)' : ''}${e.note ? ` — ${e.note}` : ''}`;
    });
  }

  return {
    headline: m
      ? `Monitor #${m.id} open — ${m.symbol} ${m.timeframe}, ${m.status}; board shows ${s.monitors.length} monitor(s)`
      : `Monitor board — ${s.monitors.length} monitor(s) on page ${s.page}`,
    record: m
      ? { kind: 'analysisMonitor', id: m.id, label: `${m.symbol} ${m.timeframe}` }
      : undefined,
    filters: {
      status: s.statusFilter || 'All',
      search: s.search || null,
      origin: s.origin || null,
      evaluationMode: s.mode || null,
      page: s.page,
    },
    figures,
    ids: { monitorsOnPage: s.monitors.map((x) => x.id) },
  };
}

export interface MonitorsPageHandles {
  statusFilter: WritableSignal<string>;
  search: WritableSignal<string>;
  origin: WritableSignal<string>;
  mode: WritableSignal<string>;
  page: WritableSignal<number>;
  statusKeys: readonly string[];
  openMonitor: (id: number) => void;
  closeMonitor: () => void;
  openBuilder: (seedMonitorId: number | null) => boolean;
  openTemplates: () => void;
}

export function monitorsPageCommands(h: MonitorsPageHandles): UiCommand[] {
  const statusValues = h.statusKeys.map((k) => k || 'All');
  return [
    {
      id: 'monitors.setStatusFilter',
      description: 'Filter the monitor board by status (Live = Active + Paused)',
      params: [
        {
          name: 'status',
          type: 'enum',
          values: statusValues,
          required: true,
          description: 'Status to show',
        },
      ],
      run: (a) => {
        const v = String(a['status']);
        h.statusFilter.set(v === 'All' ? '' : v);
        h.page.set(1);
        return { ok: true, message: `Showing ${v} monitors` };
      },
    },
    {
      id: 'monitors.search',
      description: 'Search the board (symbol, intent text, id); empty clears it',
      params: [{ name: 'text', type: 'string', description: 'Search text' }],
      run: (a) => {
        const v = String(a['text'] ?? '');
        h.search.set(v);
        h.page.set(1);
        return { ok: true, message: v ? `Searching "${v}"` : 'Search cleared' };
      },
    },
    {
      id: 'monitors.setOrigin',
      description: 'Filter by who armed the monitor; empty clears it',
      params: [
        {
          name: 'origin',
          type: 'enum',
          values: ['', 'operator', 'assistant', 'hunter', 'patient-trader', 'spot-watch'],
          description: 'Origin to show',
        },
      ],
      run: (a) => {
        h.origin.set(String(a['origin'] ?? ''));
        h.page.set(1);
        return { ok: true, message: `Origin filter: ${String(a['origin'] || 'any')}` };
      },
    },
    {
      id: 'monitors.open',
      description: "Open one monitor's detail and timeline on screen",
      params: [{ name: 'monitorId', type: 'number', required: true, description: 'Monitor id' }],
      run: (a) => {
        const id = Number(a['monitorId']);
        if (!Number.isFinite(id) || id <= 0)
          return { ok: false, message: 'monitorId must be a positive number' };
        h.openMonitor(id);
        return { ok: true, message: `Opened monitor #${id}` };
      },
    },
    {
      id: 'monitors.close',
      description: 'Close the open monitor detail',
      run: () => {
        h.closeMonitor();
        return { ok: true, message: 'Closed the monitor detail' };
      },
    },
    {
      id: 'monitors.openBuilder',
      description: 'Open the monitor builder form, blank or pre-filled from an existing monitor',
      params: [
        {
          name: 'seedMonitorId',
          type: 'number',
          description: 'Monitor to copy from (optional; must be on the board)',
        },
      ],
      run: (a) => {
        const seed = a['seedMonitorId'] == null ? null : Number(a['seedMonitorId']);
        return h.openBuilder(seed)
          ? { ok: true, message: seed ? `Builder opened from monitor #${seed}` : 'Builder opened' }
          : {
              ok: false,
              message: `Monitor #${seed} is not on the board — open or search for it first`,
            };
      },
    },
    {
      id: 'monitors.openTemplates',
      description: 'Open the monitor template library',
      run: () => {
        h.openTemplates();
        return { ok: true, message: 'Template library opened' };
      },
    },
  ];
}
