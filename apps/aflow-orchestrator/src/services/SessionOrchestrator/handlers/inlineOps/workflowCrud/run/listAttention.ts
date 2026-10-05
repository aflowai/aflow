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
  const db = getDatabase();
  const tenantIdStr = args.context.tenantId as string;

  const { listAttentionItems } = await import('@aflow/cybernetic-runtime');
  // `limit` is schema-defaulted (25); the compaction win here is dropping the bulky
  // inline `contractRef` per item below, not the page size.
  const limit = input.limit;
  const rows = await listAttentionItems(db, tenantIdStr, {
    spaceId,
    ...(input.kind ? { kind: input.kind } : {}),
    includeConsumed: input.includeConsumed,
    limit,
  });

  const items: WorkflowRunListAttentionOutput['items'] = rows.map((row) => {
    // Drop `contractRef` from the list payload — for a paused item it inlines the
    // whole base64 pause contract (the bulk of the response), and a list only needs
    // to point at WHICH run needs attention. The contract comes from run.detail
    // (or the contractRef on the row) when the caller acts on a specific pause.
    const { contractRef: _contractRef, ...payloadRest } = row.payload as Record<string, unknown>;
    return {
      id: row.id,
      kind: row.kind as WorkflowRunListAttentionOutput['items'][number]['kind'],
      ...(row.relatedRunId ? { relatedRunId: row.relatedRunId } : {}),
      ...(row.relatedResource ? { relatedResource: row.relatedResource } : {}),
      payload: payloadRest,
      priority: row.priority,
      createdAt: row.createdAt.toISOString(),
      ...(row.consumedAt ? { consumedAt: row.consumedAt.toISOString() } : {}),
    };
  });

  const output: WorkflowRunListAttentionOutput = {
    items,
    hasMore: rows.length === limit,
  };

  await emitStepSuccess(args, output as unknown as Record<string, unknown>, startTime);
}
