/**
 * The publication that opens a pull request arms it as a candidate of the
 * pull request event source (Plan 339 D2). Armed at the publication run's
 * end, after its terminal write, from the pull request its output names.
 *
 * The conversation that started the publication owns the pull request (D4),
 * where it is a Helmsman conversation that has not ended. It is given its
 * wait on the pull request here.
 */
import { armPullRequestWatch } from '@aflow/redis';
import {
  buildWorkflowRunResult,
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
  const bindingId = publicationBindingId(run);
  const watch = await armPullRequestWatch(deps.redis, {
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
  });
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

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
