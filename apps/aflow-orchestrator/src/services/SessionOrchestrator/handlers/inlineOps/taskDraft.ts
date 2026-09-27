/**
 * `agent.control.draft_patch` / `draft_get` — the scratch a task-mode agent
 * builds its result in.
 *
 * Nothing here is validated against the task's output contract. An unfinished
 * draft failing validation is the normal state of unfinished work, and
 * reporting it as an error every turn trains an agent to ignore the channel
 * that will eventually carry the real answer.
 */
import { createMemoryDocRepository, createTenantContext, getDatabase } from '@aflow/database';
import {
  DraftRevisionMismatch,
  DraftUnchanged,
  DraftWouldDiscard,
  outlineOf,
  patchTaskDraft,
  readTaskDraft,
  type TaskDraftScope,
} from '@aflow/cybernetic-runtime';
import { AgentDraftGetInputSchema, AgentDraftPatchInputSchema } from '@aflow/schemas';

import { emitStepError, emitStepSuccess, readInlineOpInputRecord } from './helpers.js';
import { readJsonPointer } from '@aflow/lib';
import { requireSpaceId } from './spaceScope.js';
import type { InlineHandlerArgs } from './types.js';

/**
 * Server-derived, every field. The agent names no part of this, so one
 * session's draft cannot address another's however the call is shaped.
 */
function scopeFor(args: InlineHandlerArgs): TaskDraftScope {
  return {
    tenantId: args.context.tenantId,
    // The session this agent is running in — the same key the harness uses to
    // discard the draft when the task ends.
    sessionId: args.context.runId,
    spaceId: requireSpaceId(args.context),
  };
}

function storeDeps(args: InlineHandlerArgs) {
  const tenantCtx = createTenantContext(args.context.tenantId);
  return {
    repo: createMemoryDocRepository(getDatabase(), tenantCtx),
    payloadStore: args.payloadStore,
  };
}

export async function handleDraftPatchInline(args: InlineHandlerArgs): Promise<void> {
  const startTime = Date.now();
  const raw = await readInlineOpInputRecord(args);
  const parsed = AgentDraftPatchInputSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    await emitStepError(
      args,
      'DRAFT_PATCH_INVALID_INPUT',
      `draft_patch input is malformed: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ')}`,
      startTime,
      'validation',
      true,
    );
    return;
  }

  const { mutationId, operations, expectedRevision } = parsed.data;
  try {
    const receipt = await patchTaskDraft({
      ...storeDeps(args),
      scope: scopeFor(args),
      owner: {
        runId: args.context.runId,
        stepExecutionId: args.stepExecutionId,
        attempt: args.attempt,
      },
      mutationId,
      operations: operations as never,
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    });
    await emitStepSuccess(args, { ...receipt }, startTime);
  } catch (err) {
    if (err instanceof DraftWouldDiscard) {
      await emitStepError(args, 'DRAFT_WOULD_DISCARD', err.message, startTime, 'validation', true);
      return;
    }
    if (err instanceof DraftUnchanged) {
      // Classified as a tool failure on purpose: a no-op that returns SUCCEEDED
      // moves no counter, so a repeating agent never reaches a ceiling. As a
      // failure it trips MAX_CONSECUTIVE_TOOL_FAILURES like anything else.
      await emitStepError(args, 'DRAFT_UNCHANGED', err.message, startTime, 'validation', true);
      return;
    }
    if (err instanceof DraftRevisionMismatch) {
      await emitStepError(
        args,
        'DRAFT_REVISION_MISMATCH',
        err.message,
        startTime,
        'validation',
        true,
      );
      return;
    }
    // A malformed pointer or a patch against a shape that is not there. The
    // draft is unchanged, so the agent can read it back and try again.
    await emitStepError(
      args,
      'DRAFT_PATCH_FAILED',
      `The patch did not apply, and the draft is unchanged: ${
        err instanceof Error ? err.message : String(err)
      }`,
      startTime,
      'validation',
      true,
    );
  }
}

export async function handleDraftGetInline(args: InlineHandlerArgs): Promise<void> {
  const startTime = Date.now();
  const raw = await readInlineOpInputRecord(args);
  const parsed = AgentDraftGetInputSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    await emitStepError(
      args,
      'DRAFT_GET_INVALID_INPUT',
      `draft_get input is malformed: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      startTime,
      'validation',
      true,
    );
    return;
  }

  const { view, path, itemRange } = parsed.data;
  const { envelope, exists, contentHash, sizeBytes } = await readTaskDraft({
    ...storeDeps(args),
    scope: scopeFor(args),
  });

  // One addressing scheme for the document, and one implementation of it: the
  // pointer a validation error reports is the pointer draft_patch takes and the
  // pointer read here, resolved by the same library that applies the patch. A
  // second walk drifts — `/01` read as index 1, a missing leading slash read
  // rather than refused — and sends a repair somewhere the write will not go.
  let content: unknown = path ? readJsonPointer(envelope.content, path) : envelope.content;

  if (itemRange && Array.isArray(content)) {
    content = content.slice(itemRange.start, itemRange.start + itemRange.count);
  }

  await emitStepSuccess(
    args,
    {
      revision: envelope.revision,
      contentHash,
      sizeBytes,
      exists,
      // The default is an outline: reading a draft back must not undo the
      // reason it exists. It outlines the SAME value the request narrowed to,
      // so a pointer or an item window changes what is described rather than
      // being silently ignored.
      ...(view === 'full' || path ? { content } : { outline: outlineOf(content) }),
    },
    startTime,
  );
}

/** Used by submit_output to turn the draft into the value it validates. */
export async function materializeDraftForSubmit(
  args: InlineHandlerArgs,
): Promise<{ ok: true; content: unknown; revision: number } | { ok: false; detail: string }> {
  const { envelope, exists } = await readTaskDraft({
    ...storeDeps(args),
    scope: scopeFor(args),
  });
  if (!exists || envelope.revision === 0) {
    return { ok: false, detail: 'No draft has been built for this task attempt.' };
  }
  return { ok: true, content: envelope.content, revision: envelope.revision };
}
