import { describe, expect, it } from 'vitest';

import type { AlgoEngineerAuditRowDto, AlgoEngineerRunStateDto } from '@core/api/api.types';
import type { WorkOrderRow } from './agent-ops';
import {
  latestCapabilities,
  parseCapabilities,
  recentWorkOrders,
  summariseWindow,
  toolLabel,
} from './agent-ops-history';

const NOW = Date.parse('2026-10-29T12:00:00Z');
const audit = (kind: string, atUtc: string) =>
  ({
    kind,
    atUtc,
    sessionLlmInvocationId: 1,
    actor: 'agent',
    summary: '',
  }) as AlgoEngineerAuditRowDto;
const run = (p: Partial<AlgoEngineerRunStateDto>) =>
  ({
    startedAtUtc: '2026-10-28T00:00:00Z',
    capabilitiesJson: null,
    sessionCostUsd: 0,
    ...p,
  }) as AlgoEngineerRunStateDto;
const order = (id: number, last: string, r: AlgoEngineerRunStateDto | null) =>
  ({ sessionId: id, lastActivityAtUtc: last, run: r }) as WorkOrderRow;

describe('agent ops history', () => {
  it('summarises a window from the audit and run state', () => {
    const s = summariseWindow(
      [
        audit('run_started', '2026-10-28T10:00:00Z'),
        audit('run_ended', '2026-10-28T10:05:00Z'),
        audit('config_change', '2026-10-20T10:00:00Z'),
        audit('run_started', '2026-09-01T10:00:00Z'),
      ],
      [
        order(1, '2026-10-28T10:05:00Z', run({ sessionCostUsd: 2.5 })),
        order(2, '2026-09-01T10:00:00Z', run({ sessionCostUsd: 9 })),
      ],
      7,
      NOW,
    );
    expect(s).toMatchObject({
      runsStarted: 1,
      runsFinished: 1,
      configWrites: 0,
      spendUsd: 2.5,
      spendSessions: 1,
    });
    expect(
      summariseWindow([audit('config_change', '2026-10-20T10:00:00Z')], [], 30, NOW).configWrites,
    ).toBe(1);
  });

  it('orders recent work orders newest first', () => {
    const rows = recentWorkOrders([
      order(1, '2026-10-01T00:00:00Z', null),
      order(2, '2026-10-02T00:00:00Z', null),
    ]);
    expect(rows.map((r) => r.sessionId)).toEqual([2, 1]);
  });

  it('parses capabilities and ignores deployment details', () => {
    const c = parseCapabilities(
      '{"mlControl":true,"configWrite":true,"promote":false,"readOnly":false,"maxSteps":60,"budgetUsd":6,"approvalRequiredFor":["ml_trigger_training"],"platformAccess":{"reads":"immediate","writes":"operator approval"},"deployment":{"host":"x"}}',
    )!;
    expect(c).toMatchObject({
      mlControl: true,
      promote: false,
      maxSteps: 60,
      budgetUsd: 6,
      reads: 'immediate',
    });
    expect(c.approvalRequiredFor).toEqual(['ml_trigger_training']);
    expect(parseCapabilities('not json')).toBeNull();
    expect(toolLabel('ml_trigger_training')).toBe('trigger training');
  });

  it('takes the newest run with capabilities', () => {
    const got = latestCapabilities([
      run({ startedAtUtc: '2026-10-01T00:00:00Z', capabilitiesJson: '{"promote":true}' }),
      run({ startedAtUtc: '2026-10-05T00:00:00Z', capabilitiesJson: '{"promote":false}' }),
      null,
    ]);
    expect(got?.caps.promote).toBe(false);
  });
});
