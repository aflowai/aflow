/**
 * The publication that opens a pull request arms it as a candidate of the
 * pull request event source (Plan 339 D2). Armed at the publication run's
 * end, after its terminal write, from the pull request its output names.
 *
 * A pull request has one owner (D4). The conversation that started the
 * publication owns it where it is a Helmsman conversation that has not ended,
 * and where no owner is recorded or the recorded one can no longer act. So a
 * conversation a hand-over started owns the pull request once it publishes
 * the branch, and hears its next event. The owner is given its wait on the
 * pull request here.
 */
import { armPullRequestWatch, readPullRequestWatch } from '@aflow/redis';
import {
  buildWorkflowRunResult,
  isActingConversation,
  isLiveConversation,
  type WorkflowRunDetail,
} from '@aflow/cybernetic-runtime';
import {
  PLAN_STREAM_PUBLICATION_SLUG,
  RUN_PULL_REQUEST_URL_OUTPUT,
  parsePullRequestRef,
  pullRequestSubject,
} from '@aflow/schemas';
import type { HarnessDeps } from '../cybernetic/harness/types.js';
import { getOrchestratorLogger } from '../../lib/orchestratorLogger.js';
import { holdForOwner } from './owner.js';

/** The folder a publication was started on, as its validated inputs recorded it. */
function publicationBindingId(run: WorkflowRunDetail): string | undefined {
  const metadata = run.metadata;
  if (metadata === null || typeof metadata !== 'object') return undefined;
  const inputs = (metadata as { parentTaskInputs?: { inputs?: Record<string, unknown> } })
    .parentTaskInputs?.inputs;
  const bindingId = inputs?.['bindingId'];
  return typeof bindingId === 'string' && bindingId.length > 0 ? bindingId : undefined;
}

export type PublicationArmOutcome = 'armed' | 'not_a_publication' | 'no_pull_request';

/** Arm the pull request a completed publication names, so the source watches it until it merges or closes. */
export async function armPullRequestOnPublication(
  deps: HarnessDeps,
  tenantId: string,
  run: WorkflowRunDetail,
  status: 'completed' | 'failed' | 'cancelled',
  nowMs: number = Date.now(),
): Promise<PublicationArmOutcome> {
  if (run.workflowSlug !== PLAN_STREAM_PUBLICATION_SLUG || status !== 'completed') {
    return 'not_a_publication';
  }
  const result = await buildWorkflowRunResult(
    { db: deps.db, payloadStore: deps.payloadStore },
    { tenantId, run, scope: 'partial' },
  );
  const url = result?.output?.[RUN_PULL_REQUEST_URL_OUTPUT];
  const ref = typeof url === 'string' ? parsePullRequestRef(url) : null;
  if (typeof url !== 'string' || ref === null) return 'no_pull_request';
  const subject = pullRequestSubject(ref.owner, ref.repo, ref.number);
  const ownerSessionId = await liveStarter(deps, tenantId, run, subject);
  const replacingOwner =
    ownerSessionId !== undefined
      ? await ownerUnableToAct(deps, tenantId, { spaceId: run.spaceId, subject }, ownerSessionId)
      : undefined;
  const bindingId = publicationBindingId(run);
  const watch = await armPullRequestWatch(
    deps.redis,
    {
      tenantId,
      spaceId: run.spaceId,
      owner: ref.owner,
      repo: ref.repo,
      number: ref.number,
      subject,
      url,
      armedAt: nowMs,
      ...(bindingId !== undefined ? { bindingId } : {}),
      ...(ownerSessionId !== undefined ? { ownerSessionId } : {}),
    },
    replacingOwner !== undefined ? { replacingOwner } : {},
  );
  try {
    await holdForOwner(deps, watch, { nowMs });
  } catch (err) {
    getOrchestratorLogger().warn(
      `[pr-arm] declaring the owner's wait on ${subject} failed; the sweep tends it: ${errorText(err)}`,
    );
  }
  return 'armed';
}

/**
 * The conversation that started the publication, where it is a Helmsman
 * conversation that has not ended. A read that fails names no owner: the pull
 * request is still armed and indexed, and the sweep tends it.
 */
async function liveStarter(
  deps: HarnessDeps,
  tenantId: string,
  run: WorkflowRunDetail,
  subject: string,
): Promise<string | undefined> {
  const starter = run.sessionId;
  if (typeof starter !== 'string') return undefined;
  try {
    return (await isLiveConversation(deps.db, tenantId, starter)) ? starter : undefined;
  } catch (err) {
    getOrchestratorLogger().warn(
      `[pr-arm] reading the owner of ${subject} failed; it is armed with none, and the sweep tends it: ${errorText(err)}`,
    );
    return undefined;
  }
}

/**
 * The recorded owner of the pull request, where it is another conversation
 * that can no longer act: ended, failed or gone. The arm's publisher takes the
 * pull request over from it. A read that fails names none, so the recorded
 * owner stays.
 */
async function ownerUnableToAct(
  deps: HarnessDeps,
  tenantId: string,
  ref: { spaceId: string; subject: string },
  publisher: string,
): Promise<string | undefined> {
  try {
    const recorded = (await readPullRequestWatch(deps.redis, { tenantId, ...ref }))?.ownerSessionId;
    if (recorded === undefined || recorded === publisher) return undefined;
    return (await isActingConversation(deps.db, tenantId, recorded)) ? undefined : recorded;
  } catch (err) {
    getOrchestratorLogger().warn(
      `[pr-arm] reading whether the owner of ${ref.subject} can act failed; it stays its owner: ${errorText(err)}`,
    );
    return undefined;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
