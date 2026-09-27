import { describe, it, expect, vi } from 'vitest';
import {
  SUBAGENT_HANDOFF_PAYLOAD_KIND,
  type WorkflowResumeContract,
  type WorkflowTask,
} from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';
import { resolvePausedContractRef } from '../pauseContractStorage.js';

const RUN_ID = 'r-1';
const TASK_ID = 'prepare';
const HANDOFF_REF = 'inline:handoff';

/**
 * Minimal PayloadStore: `retrieve(HANDOFF_REF)` returns the signal_blocked
 * handoff payload; `store(...)` records the contract it persisted and returns a
 * stable ref so the test can inspect what `resolvePausedContractRef` built.
 */
function makePayloadStore(handoff: unknown): {
  payloadStore: PayloadStore;
  stored: WorkflowResumeContract[];
} {
  const stored: WorkflowResumeContract[] = [];
  const payloadStore = {
    retrieve: async (ref: string) => {
      if (ref === HANDOFF_REF) return handoff;
      throw new Error(`unexpected ref ${ref}`);
    },
    store: vi.fn(async (args: { data: unknown }) => {
      stored.push(args.data as WorkflowResumeContract);
      return `inline:stored-${String(stored.length)}`;
    }),
  } as unknown as PayloadStore;
  return { payloadStore, stored };
}

const TASK_DEF = {
  taskId: TASK_ID,
  name: 'Prepare',
  goal: 'prepare the competition',
  type: 'agent',
  maxAttempts: 3,
} as unknown as WorkflowTask;

describe('resolvePausedContractRef — credential reclassification (Plan 182 Task 1)', () => {
  it('a handoff carrying credentialBlock reclassifies to needs_credentials (acknowledge)', async () => {
    const { payloadStore, stored } = makePayloadStore({
      payloadKind: SUBAGENT_HANDOFF_PAYLOAD_KIND,
      handoffSource: 'runner-signal-blocked',
      prompt: 'Blocked: kaggle credentials missing',
      blockingCategory: 'other',
      credentialBlock: {
        bindingId: 'b-1',
        serverId: 'kaggle',
        bindingName: 'kaggle-default',
        missingFields: ['apiKey'],
        reason: 'credential_unresolved',
      },
    });

    const result = await resolvePausedContractRef({
      payloadStore,
      tenantId: 't-1',
      runId: RUN_ID,
      taskId: TASK_ID,
      pausedTaskAttempt: 1,
      contractRef: HANDOFF_REF,
      taskDef: TASK_DEF,
    });

    expect(result).not.toBeNull();
    expect(result?.pauseReason).toBe('needs_credentials');
    const contract = stored[0]!;
    expect(contract.pauseCause).toBe('needs_credentials');
    // Task-backed → carries failedTaskId so acknowledge re-executes the task.
    expect(contract.failedTaskId).toBe(TASK_ID);
    expect(contract.allowedResumeModes).toContain('acknowledge');
    expect(contract.blockedBindings?.[0]?.bindingName).toBe('kaggle-default');
  });

  it('a generic handoff (no credentialBlock) stays subagent_handoff', async () => {
    const { payloadStore, stored } = makePayloadStore({
      payloadKind: SUBAGENT_HANDOFF_PAYLOAD_KIND,
      handoffSource: 'runner-signal-blocked',
      prompt: 'Tool returned an unexpected error',
      blockingCategory: 'other',
    });

    const result = await resolvePausedContractRef({
      payloadStore,
      tenantId: 't-1',
      runId: RUN_ID,
      taskId: TASK_ID,
      pausedTaskAttempt: 1,
      contractRef: HANDOFF_REF,
      taskDef: TASK_DEF,
    });

    expect(result?.pauseReason).toBe('subagent_handoff');
    expect(stored[0]!.pauseCause).toBe('subagent_handoff');
    expect(stored[0]!.pauseCause).not.toBe('needs_credentials');
  });
});
