import { describe, it, expect } from 'vitest';
import type { SessionHotState } from '@aflow/redis';
import { deriveSessionBlockedOn } from './deriveSessionBlockedOn.js';

type DerivationState = Pick<
  SessionHotState,
  'status' | 'waitingOnWorkflowRunId' | 'delegationPauseSource' | 'waitingForChildSessionIds'
>;

const RUN_ID = '11111111-1111-1111-1111-111111111111';
const CHILD_A = '22222222-2222-2222-2222-222222222222';
const STEP_EXEC = '33333333-3333-3333-3333-333333333333';

function state(partial: Partial<DerivationState>): DerivationState {
  return { status: 'PAUSED', ...partial } as DerivationState;
}

describe('deriveSessionBlockedOn (Plan 182 §2.1)', () => {
  it('prioritizes workflow_run over user_input when BOTH signals are present (§1.2 fix)', () => {
    // The workflow-wait park leaves a requiredInput.stepExecutionId too; a
    // user_input-first derivation would re-enable the premature-resume bug.
    const result = deriveSessionBlockedOn(
      state({ status: 'PAUSED', waitingOnWorkflowRunId: RUN_ID }),
      STEP_EXEC,
    );
    expect(result).toEqual({ kind: 'workflow_run', runId: RUN_ID });
  });

  it('does NOT derive workflow_run when status is not PAUSED (stale-marker defense)', () => {
    expect(
      deriveSessionBlockedOn(
        state({ status: 'RUNNING', waitingOnWorkflowRunId: RUN_ID }),
        undefined,
      ),
    ).toBeNull();
    expect(
      deriveSessionBlockedOn(
        state({ status: 'SUCCEEDED', waitingOnWorkflowRunId: RUN_ID }),
        undefined,
      ),
    ).toBeNull();
  });

  it('derives child_session from WAITING_ON_CHILD', () => {
    expect(
      deriveSessionBlockedOn(
        state({ status: 'WAITING_ON_CHILD', waitingForChildSessionIds: [CHILD_A] }),
        undefined,
      ),
    ).toEqual({ kind: 'child_session', sessionIds: [CHILD_A] });
  });

  it('derives child_session from PAUSED + child_running + ids', () => {
    expect(
      deriveSessionBlockedOn(
        state({
          status: 'PAUSED',
          delegationPauseSource: 'child_running',
          waitingForChildSessionIds: [CHILD_A],
        }),
        undefined,
      ),
    ).toEqual({ kind: 'child_session', sessionIds: [CHILD_A] });
  });

  it('derives user_input from PAUSED + requiredInput when no workflow/child wait', () => {
    expect(deriveSessionBlockedOn(state({ status: 'PAUSED' }), STEP_EXEC)).toEqual({
      kind: 'user_input',
      stepExecutionId: STEP_EXEC,
    });
  });

  it('returns null for a PAUSED session with no wait signal', () => {
    expect(deriveSessionBlockedOn(state({ status: 'PAUSED' }), undefined)).toBeNull();
  });
});
