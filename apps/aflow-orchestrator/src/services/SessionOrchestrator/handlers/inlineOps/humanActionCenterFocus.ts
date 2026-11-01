import type { Redis } from 'ioredis';
import {
  type StepDefinition,
  type StepExecutionId,
  type StepType,
  type OperationId,
  type IdempotencyKey,
  HumanActionCenterFocusInputSchema,
  actionCenterFocusNote,
  hasActionCenterFocusPrefix,
  type HumanActionCenterFocusOutput,
} from '@aflow/schemas';
import { addStepResult, publishActionCenterFocus } from '@aflow/redis';
import { getAttentionCache, type HelmsmanAttentionContext } from '@aflow/cybernetic-runtime';
import type { PayloadStore } from '@aflow/payload-store';
import { encodeInlineOpOutputRef } from './helpers.js';
import type { FlowExecutionContext } from '../../types.js';
import { inlineArgsFromPositional, readInlineInput } from './readInlineInput.js';

export async function handleHumanActionCenterFocusInline(
  redis: Redis,
  payloadStore: PayloadStore,
  context: FlowExecutionContext,
  focusStepDef: StepDefinition,
  stepExecutionId: StepExecutionId,
  idempotencyKey: IdempotencyKey,
  resolvedInputRef: string,
  attempt: number,
  _scheduledAtMs: number,
  parentStepExecutionId?: StepExecutionId,
): Promise<void> {
  const startTime = Date.now();
  const inlineArgs = inlineArgsFromPositional(
    redis,
    payloadStore,
    context,
    focusStepDef,
    stepExecutionId,
    idempotencyKey,
    resolvedInputRef,
    attempt,
    _scheduledAtMs,
    parentStepExecutionId,
  );
  try {
    const raw = await readInlineInput(inlineArgs, startTime);
    if (!raw) return;
    const parsed = HumanActionCenterFocusInputSchema.safeParse(raw);
    if (!parsed.success) {
      // Translate Zod path → operator-readable diagnostic. The most
      // common failure here is a bare UUID for `itemId` — the agent
      // hallucinated a value instead of fetching one from a listing op.
      // The thrown error becomes the FAILED step's `error.message` which
      // is what the agent sees next turn, so include a prescriptive
      // correction (call proposal.list / use human.chat.ask) rather
      // than a generic schema dump.
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      const sawBareItemId =
        typeof (raw as { itemId?: unknown }).itemId === 'string' &&
        !hasActionCenterFocusPrefix((raw as { itemId: string }).itemId);
      const correction = sawBareItemId
        ? 'Correction: that itemId is not from a listing op. Call proposal.list (or another Action Center listing) and pass the `id` field VERBATIM (it will already be prefixed like "proposal:<uuid>"). If no matching item exists yet, use `human.chat.ask` to author a fresh question instead — do not retry this tool with a fabricated id.'
        : 'Correction: re-read the tool input schema and call again with valid fields.';
      throw new Error(`human.action_center.focus: invalid input — ${issues}. ${correction}`);
    }
    const input = parsed.data;

    if (!context.spaceId) {
      throw new Error(
        'human.action_center.focus: no spaceId on the run context. ' +
          'Focus events are per-space scoped and require an active space.',
      );
    }

    // Publish — best-effort. Client may or may not be connected; the
    // item remains in the Action Center list either way.
    publishActionCenterFocus(redis, {
      tenantId: context.tenantId,
      spaceId: context.spaceId,
      itemId: input.itemId,
      ...(input.reason ? { reason: input.reason } : {}),
    });

    const listed = input.itemId.startsWith('proposal:')
      ? undefined
      : await listedInAttention(redis, context.tenantId, context.spaceId, input.itemId);

    const output: HumanActionCenterFocusOutput = {
      acknowledged: true,
      itemId: input.itemId,
      note: actionCenterFocusNote(input.itemId),
      ...(listed !== undefined ? { listed } : {}),
    };
    const outputRef = await encodeInlineOpOutputRef(
      payloadStore,
      context,
      stepExecutionId,
      attempt,
      output,
    );

    await addStepResult(redis, {
      messageVersion: 1,
      tenantId: context.tenantId,
      sessionId: context.runId,
      stepExecutionId,
      parentStepExecutionId: parentStepExecutionId ?? null,
      stepId: focusStepDef.stepId,
      stepType: 'human' as StepType,
      operationId: 'human.action_center.focus' as OperationId,
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
      code: 'HUMAN_ACTION_CENTER_FOCUS_FAILED',
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
      stepId: focusStepDef.stepId,
      stepType: 'human' as StepType,
      operationId: 'human.action_center.focus' as OperationId,
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

/**
 * The item as the space's cached attention block lists it, where it does. The
 * block is the listing the agent read the id from, so its title is the one
 * the agent named. A missed or unreadable cache yields nothing, and the
 * operator's card then reads the live item alone.
 */
async function listedInAttention(
  redis: Redis,
  tenantId: string,
  spaceId: string,
  itemId: string,
): Promise<HumanActionCenterFocusOutput['listed']> {
  const { value } = await getAttentionCache(redis, tenantId, spaceId);
  if (value === null) return undefined;
  let attention: Partial<Pick<HelmsmanAttentionContext, 'waitingOnPerson'>> | null;
  try {
    attention = JSON.parse(value) as Partial<
      Pick<HelmsmanAttentionContext, 'waitingOnPerson'>
    > | null;
  } catch {
    return undefined;
  }
  const items = attention?.waitingOnPerson?.items;
  const item = Array.isArray(items) ? items.find((entry) => entry.itemId === itemId) : undefined;
  return item !== undefined ? { kind: item.kind, title: item.title } : undefined;
}
