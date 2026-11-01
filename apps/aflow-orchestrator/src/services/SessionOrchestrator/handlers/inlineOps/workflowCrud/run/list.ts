import { getDatabase } from '@aflow/database';
import { readPullRequestWatch } from '@aflow/redis';
import {
  WorkflowRunListInputSchema,
  parsePullRequestRef,
  pullRequestSubject,
} from '@aflow/schemas';
import type { InlineHandlerArgs } from '../../types.js';
import { emitStepError, emitStepSuccess } from '../../helpers.js';
import { requireSpaceId } from '../../spaceScope.js';

export async function handleWorkflowRunList(
  args: InlineHandlerArgs,
  input: unknown,
  startTime: number,
): Promise<void> {
  const parsed = WorkflowRunListInputSchema.safeParse(input);
  if (!parsed.success) {
    await emitStepError(
      args,
      'WORKFLOW_RUN_LIST_INPUT_INVALID',
      parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; '),
      startTime,
      'validation',
    );
    return;
  }
  const spaceId = requireSpaceId(args.context);
  const tenantId = args.context.tenantId as string;
  // The owner is the one the pull request's watch records (Plan 339 D4), the
  // same record its events go to.
  const ownerOf = parsed.data.startedByActingOwnerOf;
  const ref = ownerOf !== undefined ? parsePullRequestRef(ownerOf) : null;
  const pullRequestOwner =
    ref !== null
      ? ((
          await readPullRequestWatch(args.redis, {
            tenantId,
            spaceId,
            subject: pullRequestSubject(ref.owner, ref.repo, ref.number),
          })
        )?.ownerSessionId ?? null)
      : undefined;
  const { listRunsByInput } = await import('@aflow/cybernetic-runtime');
  const output = await listRunsByInput({
    db: getDatabase(),
    tenantId,
    spaceId,
    sessionId: args.context.runId,
    query: parsed.data,
    payloadStore: args.payloadStore,
    ...(pullRequestOwner !== undefined ? { pullRequestOwner } : {}),
  });
  await emitStepSuccess(args, output as unknown as Record<string, unknown>, startTime);
}
