import {
  WorkflowWaitInputSchema,
  parsePullRequestRef,
  pullRequestSubject,
  type WorkflowWaitOutput,
} from '@aflow/schemas';
import { declareWait, WaitDeclarationError } from '@aflow/cybernetic-runtime';
import type { InlineHandlerArgs } from '../types.js';
import { emitStepError, emitStepSuccess } from '../helpers.js';
import { requireSpaceId } from '../spaceScope.js';

/**
 * `workflow.wait` (Plan 339 D1): declare a wait for this conversation. Where
 * the event fired already, the wait ends here and the output carries it.
 * Otherwise the conversation is woken when the event arrives or the window
 * closes, by `orchestrator.wait_delivery`.
 */
export async function handleWorkflowWait(
  args: InlineHandlerArgs,
  input: unknown,
  startTime: number,
): Promise<void> {
  const parsed = WorkflowWaitInputSchema.safeParse(input);
  if (!parsed.success) {
    await emitStepError(
      args,
      'INVALID_WAIT',
      `The wait was not declared: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      startTime,
      'validation',
    );
    return;
  }
  const spaceId = requireSpaceId(args.context);
  const { kind, windowSeconds, since } = parsed.data;
  let subject = parsed.data.subject;
  if (kind === 'pull_request.changed') {
    const ref = parsePullRequestRef(subject);
    if (ref === null) {
      await emitStepError(
        args,
        'INVALID_WAIT',
        `"${subject}" names no pull request. Name it as owner/repo#number or by its GitHub link.`,
        startTime,
        'validation',
      );
      return;
    }
    subject = pullRequestSubject(ref.owner, ref.repo, ref.number);
  }

  try {
    const declared = await declareWait(args.redis, {
      tenantId: args.context.tenantId as string,
      spaceId,
      sessionId: args.context.runId as string,
      kind,
      subject,
      windowSeconds,
      ...(since !== undefined ? { since: Date.parse(since) } : {}),
    });
    const output: WorkflowWaitOutput = {
      waitId: declared.waitId,
      kind,
      subject,
      state: declared.state,
      closesAt: new Date(declared.closesAt).toISOString(),
      ...(declared.state === 'ended' ? { outcome: declared.outcome } : {}),
    };
    await emitStepSuccess(args, output as unknown as Record<string, unknown>, startTime);
  } catch (err) {
    if (err instanceof WaitDeclarationError) {
      await emitStepError(args, 'INVALID_WAIT', err.message, startTime, 'validation');
      return;
    }
    throw err;
  }
}
