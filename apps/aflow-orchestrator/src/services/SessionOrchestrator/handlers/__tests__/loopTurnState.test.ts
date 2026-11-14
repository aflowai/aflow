import { describe, expect, it } from 'vitest';
import { MEMORY_READ_OPERATION_ID } from '@aflow/schemas';
import type { SessionHotState } from '@aflow/redis';
import { readInlineVar } from '../../helpers/runtimeState.js';
import {
  HARD_PAUSE_IDENTICAL_CONSECUTIVE,
  HARD_PAUSE_SAME_TARGET_READS,
  loopVarKeys,
  SOFT_WARNING_IDENTICAL_CONSECUTIVE,
  SOFT_WARNING_SAME_TARGET_READS,
  type LoopWarning,
  type SignatureCall,
} from '../callSignature.js';
import { applyLoopTurn } from '../loopTurnState.js';

type RuntimeState = NonNullable<SessionHotState['runtimeState']>;

const STEP_ID = 'chat';
const KEYS = loopVarKeys(STEP_ID);
const TARGET = '/run/outputs/abc123_0/data';

const byJsonPath = (i: number): SignatureCall[] => [
  {
    toolId: MEMORY_READ_OPERATION_ID,
    args: { target: { path: TARGET }, view: 'content', jsonPath: `tasks[${String(i)}]` },
  },
];
const unrelated: SignatureCall[] = [{ toolId: 'memory.store.query', args: { prefix: '/x' } }];

interface Turn {
  state: RuntimeState;
  failed: boolean;
  logs: string[];
}

/** Drives applyLoopTurn as applyAgentDecision does, carrying the state turn to turn. */
function drive(turns: ReadonlyArray<ReadonlyArray<SignatureCall>>): Turn[] {
  let state: RuntimeState = { schemaVersion: 1, variables: {}, version: 0, updatedAtMs: 0 };
  return turns.map((calls, i) => {
    const update = applyLoopTurn(state, STEP_ID, calls, (id) => id, {
      nowMs: i,
      stepExecutionId: `sex-${String(i)}`,
    });
    state = { ...state, variables: update.variables };
    return {
      state,
      failed: update.verdict.failure !== undefined,
      logs: update.warningLogs.map((l) => l.label),
    };
  });
}

const warningIn = (turn: Turn | undefined, varKey: string): LoopWarning | null =>
  turn ? readInlineVar(turn.state, varKey, null as LoopWarning | null) : null;

describe('applyLoopTurn writes each rule its own warning variable', () => {
  it('writes the same-target warning and leaves the identical-call warning unset', () => {
    const loop = drive(
      Array.from({ length: SOFT_WARNING_SAME_TARGET_READS }, (_, i) => byJsonPath(i)),
    );
    const last = loop.at(-1);
    expect(warningIn(last, KEYS.sameTargetWarning)).toMatchObject({
      rule: 'same_target',
      severity: 'warning',
      repeatedActionCount: SOFT_WARNING_SAME_TARGET_READS,
    });
    expect(last?.state.variables[KEYS.identicalCallWarning]).toBeUndefined();
    expect(last?.logs).toEqual(['Same-target read warning']);
    const window = last ? readInlineVar(last.state, KEYS.recentReadTargets, [] as string[][]) : [];
    expect(window).toHaveLength(SOFT_WARNING_SAME_TARGET_READS);
  });

  it('writes the identical-call warning and leaves the same-target warning unset', () => {
    const loop = drive(Array.from({ length: SOFT_WARNING_IDENTICAL_CONSECUTIVE }, () => unrelated));
    const last = loop.at(-1);
    expect(warningIn(last, KEYS.identicalCallWarning)).toMatchObject({
      rule: 'identical_call',
      severity: 'warning',
    });
    expect(last?.state.variables[KEYS.sameTargetWarning]).toBeUndefined();
    expect(last?.logs).toEqual(['Loop warning']);
  });

  it('writes both warnings for a turn that trips both rules', () => {
    const same = byJsonPath(0);
    const loop = drive([
      ...Array.from({ length: 5 }, (_, i) => byJsonPath(i + 1)),
      same,
      same,
      same,
    ]);
    const last = loop.at(-1);
    expect(warningIn(last, KEYS.identicalCallWarning)?.rule).toBe('identical_call');
    expect(warningIn(last, KEYS.sameTargetWarning)?.rule).toBe('same_target');
    expect(last?.logs).toEqual(['Loop warning', 'Same-target read warning']);
  });

  it('clears a rule warning on the turn that rule stops warning', () => {
    const loop = drive([
      ...Array.from({ length: SOFT_WARNING_SAME_TARGET_READS }, (_, i) => byJsonPath(i)),
      unrelated,
    ]);
    expect(warningIn(loop.at(-2), KEYS.sameTargetWarning)).not.toBeNull();
    expect(loop.at(-1)?.state.variables[KEYS.sameTargetWarning]).toBeUndefined();
  });

  it('fails the run on the same-target rule and on the identical-call rule apart', () => {
    const sameTarget = drive(
      Array.from({ length: HARD_PAUSE_SAME_TARGET_READS }, (_, i) => byJsonPath(i)),
    );
    expect(sameTarget.slice(0, -1).every((t) => !t.failed)).toBe(true);
    expect(sameTarget.at(-1)?.failed).toBe(true);
    const identical = drive(
      Array.from({ length: HARD_PAUSE_IDENTICAL_CONSECUTIVE }, () => unrelated),
    );
    expect(identical.at(-1)?.failed).toBe(true);
  });
});
