import { getDatabase } from '@aflow/database';
import type { WorkflowRunListAttentionInput, WorkflowRunListAttentionOutput } from '@aflow/schemas';
import type { InlineHandlerArgs } from '../../types.js';
import { emitStepSuccess } from '../../helpers.js';
import { requireSpaceId } from '../../spaceScope.js';

export async function handleWorkflowRunListAttention(
  args: InlineHandlerArgs,
  input: WorkflowRunListAttentionInput,
  startTime: number,
): Promise<void> {
  const spaceId = requireSpaceId(args.context);

  const { listAttentionForConversation } = await import('@aflow/cybernetic-runtime');
  const listed = await listAttentionForConversation({
    db: getDatabase(),
    tenantId: args.context.tenantId as string,
    spaceId,
    sessionId: args.context.runId,
    scope: input.scope,
    ...(input.kind ? { kind: input.kind } : {}),
    includeConsumed: input.includeConsumed,
    limit: input.limit,
  });

  const items: WorkflowRunListAttentionOutput['items'] = listed.items.map(({ item, own }) => {
    // Drop `contractRef` from the list payload — for a paused item it inlines the
    // whole base64 pause contract (the bulk of the response), and a list only needs
    // to point at WHICH run needs attention. The contract comes from run.detail
    // (or the contractRef on the row) when the caller acts on a specific pause.
    const { contractRef: _contractRef, ...payloadRest } = item.payload as Record<string, unknown>;
    return {
      id: item.id,
      kind: item.kind as WorkflowRunListAttentionOutput['items'][number]['kind'],
      ...(item.relatedRunId ? { relatedRunId: item.relatedRunId } : {}),
      ...(item.relatedResource ? { relatedResource: item.relatedResource } : {}),
      payload: payloadRest,
      priority: item.priority,
      createdAt: item.createdAt.toISOString(),
      ...(item.consumedAt ? { consumedAt: item.consumedAt.toISOString() } : {}),
      own,
    };
  });

  const output: WorkflowRunListAttentionOutput = { items, hasMore: listed.hasMore };

  await emitStepSuccess(args, output as unknown as Record<string, unknown>, startTime);
}
