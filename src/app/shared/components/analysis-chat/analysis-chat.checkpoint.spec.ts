import { describe, expect, it } from 'vitest';
import type { SpotAnalysisFollowUpTurnDto } from '@core/api/api.types';
import { isCheckpointTurn } from './analysis-chat.component';

const turn = (over: Partial<SpotAnalysisFollowUpTurnDto>): SpotAnalysisFollowUpTurnDto => ({
  id: 1,
  llmInvocationId: 33391,
  role: 'Assistant',
  content: '↻ Still working',
  createdAtUtc: '2026-09-21T16:08:00Z',
  ...over,
});

describe('isCheckpointTurn', () => {
  it('recognises the engine checkpoint notice, which the client must resume', () => {
    expect(
      isCheckpointTurn(
        turn({ toolName: 'run_notice', toolResultJson: '{"kind":"checkpoint","segment":1}' }),
      ),
    ).toBe(true);
  });

  it('ignores other harness notices — a held-for-revision notice is not a pause', () => {
    expect(isCheckpointTurn(turn({ toolName: 'run_notice', toolResultJson: null }))).toBe(false);
    expect(
      isCheckpointTurn(turn({ toolName: 'run_notice', toolResultJson: '{"kind":"budget"}' })),
    ).toBe(false);
  });

  it('ignores answers, narration, bad JSON and missing turns', () => {
    expect(isCheckpointTurn(turn({}))).toBe(false);
    expect(isCheckpointTurn(turn({ toolName: 'thought', toolResultJson: '{"final":false}' }))).toBe(
      false,
    );
    expect(isCheckpointTurn(turn({ toolName: 'run_notice', toolResultJson: '{not json' }))).toBe(
      false,
    );
    expect(
      isCheckpointTurn(
        turn({ role: 'Tool', toolName: 'run_notice', toolResultJson: '{"kind":"checkpoint"}' }),
      ),
    ).toBe(false);
    expect(isCheckpointTurn(undefined)).toBe(false);
  });
});
