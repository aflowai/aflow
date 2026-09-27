import type { Redis } from 'ioredis';
import crypto from 'node:crypto';
import { logOrchestratorError } from '../../../../lib/orchestratorLogger.js';
import {
  type StepDefinition,
  type StepExecutionId,
  type StepId,
  type StepType,
  type OperationId,
  type IdempotencyKey,
  HumanChatAskInputSchema,
  type HumanChatAskInput,
} from '@aflow/schemas';
import { addStepResult, updateSessionState, getSessionState } from '@aflow/redis';
import type { PayloadStore } from '@aflow/payload-store';
import { encodeInlineOpOutputRef } from './helpers.js';
import type { FlowExecutionContext } from '../../types.js';

export const HITL_INLINE_PLACEMENT_TAG = '_hitlPlacement:chat_inline' as const;

/**
 * Routing tag — `applyStepSucceeded` finds the child step by matching
 * `_routing:<stepExecutionId>` against the `human.chat.ask` step's own
 * execution id. Mirrors the `agent.control.run_step` convention.
 */
const ROUTING_TAG_PREFIX = '_routing:' as const;

export async function handleHumanChatAskInline(
  redis: Redis,
  payloadStore: PayloadStore,
  context: FlowExecutionContext,
  askStepDef: StepDefinition,
  stepExecutionId: StepExecutionId,
  idempotencyKey: IdempotencyKey,
  resolvedInputRef: string,
  attempt: number,
  _scheduledAtMs: number,
  parentStepExecutionId?: StepExecutionId,
): Promise<void> {
  const startTime = Date.now();
  try {
    // 1. Read + validate input. Schema enforced again at the handler
    //    boundary because `applyAgentDecision` ships raw tool-call args
    //    through; the Zod parse also normalises the discriminator.
    let raw: unknown = {};
    try {
      raw = await payloadStore.retrieve(resolvedInputRef);
    } catch {
      throw new Error('human.chat.ask: failed to read input payload.');
    }
    const parsed = HumanChatAskInputSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new Error(`human.chat.ask: invalid input — ${issues}`);
    }
    const input: HumanChatAskInput = parsed.data;

    // 2. Build the child user.interaction.* payload from the discriminator.
    //    This becomes BOTH the human.chat.ask step's outputRef (so
    //    applyStepSucceeded's routing path feeds it through to the
    //    scheduled child as input) AND the seed data the child runs on.
    //    Same pattern as `runStep.ts` — see `runStepOutputRef` there.
    const childOperationId: 'user.interaction.ask' | 'user.interaction.approve' =
      input.kind === 'input' ? 'user.interaction.ask' : 'user.interaction.approve';

    const childPayload =
      input.kind === 'input'
        ? {
            prompt: input.prompt!,
            ...(input.inputSchema ? { inputSchema: input.inputSchema } : {}),
            ...(input.uiHints ? { uiHints: input.uiHints } : {}),
            ...(input.timeoutSeconds ? { timeoutSeconds: input.timeoutSeconds } : {}),
            placement: 'chat_inline' as const,
          }
        : {
            title: input.title!,
            description: input.description!,
            ...(input.reviewData !== undefined ? { reviewData: input.reviewData } : {}),
            ...(input.uiHints ? { uiHints: input.uiHints } : {}),
            ...(input.timeoutSeconds ? { timeoutSeconds: input.timeoutSeconds } : {}),
            placement: 'chat_inline' as const,
          };

    // 3. Synthesise the child step. Carries:
    //    - inline-placement tag (chat reducer mounts <HitlInline>)
    //    - routing tag (applyStepSucceeded finds this child for the
    //      human.chat.ask SUCCESS)
    //    - parent tag (tool-result attribution back to the human.chat.ask
    //      tool call in the agent's history)
    const childStepId = `inline_hitl_${input.kind}_${crypto.randomUUID().slice(0, 8)}` as StepId;
    const childStep: StepDefinition = {
      stepId: childStepId,
      stepType: 'user' as StepType,
      operation: childOperationId as OperationId,
      name: input.kind === 'input' ? '↪ Ask user (in chat)' : '↪ Request approval (in chat)',
      config: {},
      tags: [
        'dynamic',
        HITL_INLINE_PLACEMENT_TAG,
        `${ROUTING_TAG_PREFIX}${stepExecutionId}`,
        `parent:${askStepDef.stepId}`,
        ...askStepDef.tags.filter((t) => t.startsWith('_toolId:') || t.startsWith('_toolCallId:')),
      ],
      optional: false,
      outputOptions: { displayToUser: true },
      onSuccess: askStepDef.onSuccess,
      onFailure: askStepDef.onFailure,
      // Phase 5b review P2: propagate `outputMapping` so workflow-style
      // callers (a step authored with `outputMapping` on `human.chat.ask`)
      // see the operator's response mapped into state. `applyStepSucceeded`
      // skips mapping for the parent `human.chat.ask` step because the
      // mapping belongs to the *result*, not the synthetic spawn — the
      // child step is where it must land. Mirrors `runStep.ts`'s copy of
      // `runStepDef.outputMapping` onto its dynamic step.
      ...(askStepDef.outputMapping ? { outputMapping: askStepDef.outputMapping } : {}),
    };

    // 4. Push into in-memory agent def + persist to Redis dynamic steps so
    //    the routing target survives orchestrator iterations / restarts.
    context.agentDefinition.steps.push(childStep);
    try {
      const existingState = await getSessionState(redis, context.tenantId, context.runId);
      const existingDynamic: StepDefinition[] = existingState?.dynamicSteps
        ? (JSON.parse(existingState.dynamicSteps) as StepDefinition[])
        : [];
      existingDynamic.push(childStep);
      await updateSessionState(redis, context.tenantId, context.runId, {
        dynamicSteps: JSON.stringify(existingDynamic),
      });
    } catch (persistErr) {
      logOrchestratorError(
        '[handleHumanChatAskInline] failed to persist child step to Redis dynamicSteps',
        persistErr,
        {
          tenantId: context.tenantId,
          sessionId: context.runId,
          stepExecutionId,
          childStepId,
        },
      );
    }

    // 5. Emit SUCCESS for the human.chat.ask step itself. The stored
    //    output is the child's *input* (`childPayload`) — `applyStepSucceeded`
    //    feeds `result.outputRef` to the routed-to child as `inputRef`
    //    via the standard `resolvedInputRef = result.outputRef` flow.
    //    The agent's tool result is the child's resume payload, attributed
    //    via the `parent:` tag chain — that's the catalog-declared
    //    HumanChatAskOutput shape (a discriminated union over the user
    //    resume payloads), not what we store here.
    const outputRef = await encodeInlineOpOutputRef(
      payloadStore,
      context,
      stepExecutionId,
      attempt,
      childPayload,
    );

    await addStepResult(redis, {
      messageVersion: 1,
      tenantId: context.tenantId,
      sessionId: context.runId,
      stepExecutionId,
      parentStepExecutionId: parentStepExecutionId ?? null,
      stepId: askStepDef.stepId,
      stepType: 'human' as StepType,
      operationId: 'human.chat.ask' as OperationId,
      attempt,
      idempotencyKey,
      status: 'SUCCEEDED',
      outputRef,
      resolvedInputRef,
      durationMs: Date.now() - startTime,
      traceId: context.traceId,
      finishedAtMs: Date.now(),
    });
  } catch (err) {
    const errorData = {
      code: 'HUMAN_CHAT_ASK_FAILED',
      message: err instanceof Error ? err.message : String(err),
      classification: 'validation' as const,
      retryable: false,
      timestamp: new Date().toISOString(),
    };
    const errorRef = `inline:${Buffer.from(JSON.stringify(errorData)).toString('base64')}`;

    await addStepResult(redis, {
      messageVersion: 1,
      tenantId: context.tenantId,
      sessionId: context.runId,
      stepExecutionId,
      parentStepExecutionId: parentStepExecutionId ?? null,
      stepId: askStepDef.stepId,
      stepType: 'human' as StepType,
      operationId: 'human.chat.ask' as OperationId,
      attempt,
      idempotencyKey,
      status: 'FAILED',
      errorRef,
      error: errorData,
      resolvedInputRef,
      durationMs: Date.now() - startTime,
      traceId: context.traceId,
      finishedAtMs: Date.now(),
    });
  }
}
