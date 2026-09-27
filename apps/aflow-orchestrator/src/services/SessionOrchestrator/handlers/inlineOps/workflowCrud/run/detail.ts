import { getDatabase } from '@aflow/database';
import type { PayloadStore } from '@aflow/payload-store';
import { MAX_INLINE_PAYLOAD_BYTES } from '@aflow/schemas';
import type { PayloadRef, WorkflowRunDetailInput, WorkflowRunTaskOutput } from '@aflow/schemas';
import type { InlineHandlerArgs } from '../../types.js';
import { emitStepSuccess, emitStepError } from '../../helpers.js';
import { requireSpaceId } from '../../spaceScope.js';

/**
 * Read one task's recorded output, bounded to what an agent turn can hold.
 *
 * The whole payload is fetched because the JSON lane has no ranged read —
 * `openByteStream` refuses a JSON ref — so the bound is on what is returned,
 * and an oversized output says so rather than arriving silently clipped.
 */
async function readBoundedTaskOutput(
  payloadStore: PayloadStore,
  taskId: string,
  outputRef: PayloadRef,
): Promise<WorkflowRunTaskOutput | undefined> {
  let value: unknown;
  try {
    value = await payloadStore.retrieve(outputRef);
  } catch {
    return undefined;
  }
  if (value === null || value === undefined) return undefined;

  const text: string | undefined = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return undefined;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= MAX_INLINE_PAYLOAD_BYTES) return { taskId, output: value };
  return {
    taskId,
    truncated: true,
    bytes,
    // Decoded as a stream so a cut inside a multi-byte character holds that
    // character back rather than emitting a replacement mark.
    output: new TextDecoder('utf-8').decode(
      Buffer.from(text, 'utf8').subarray(0, MAX_INLINE_PAYLOAD_BYTES),
      { stream: true },
    ),
  };
}

export async function handleWorkflowRunDetail(
  args: InlineHandlerArgs,
  input: WorkflowRunDetailInput,
  startTime: number,
): Promise<void> {
  const spaceId = requireSpaceId(args.context);
  const db = getDatabase();
  const tenantIdStr = args.context.tenantId as string;

  const { buildWorkflowRunDetail, getTaskRow } = await import('@aflow/cybernetic-runtime');
  // Compact by default on the op path (MCP/agent) — the driver wants a token-efficient
  // peek; pass compact:false for the full per-task payloads. The web reads via the
  // server route, which calls buildWorkflowRunDetail directly (no compact) — unaffected.
  const output = await buildWorkflowRunDetail(
    db,
    args.payloadStore,
    tenantIdStr,
    spaceId,
    input.runId,
    {
      compact: input.compact ?? true,
    },
  );
  if (!output) {
    await emitStepError(
      args,
      'WORKFLOW_RUN_NOT_FOUND',
      `No workflow run found with id "${input.runId}" in this space.`,
      startTime,
      'validation',
    );
    return;
  }

  if (input.taskOutput) {
    // The row is re-read rather than taken from `output.tasks`: a compact
    // projection drops exactly the large inline refs this read is for.
    const row = await getTaskRow(db, tenantIdStr, input.runId, input.taskOutput);
    if (row?.outputRef) {
      const taskOutput = await readBoundedTaskOutput(
        args.payloadStore,
        input.taskOutput,
        row.outputRef,
      );
      if (taskOutput) output.taskOutput = taskOutput;
    }
  }

  if (input.present) {
    output.presentation = {
      mode: 'rendered_inline',
      substrate: 'workflow_run',
      runId: output.run.runId,
    };
  }

  await emitStepSuccess(args, output as unknown as Record<string, unknown>, startTime);
}
