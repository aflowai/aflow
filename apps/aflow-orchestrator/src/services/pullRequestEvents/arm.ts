/**
 * The publication that opens a pull request arms it as a candidate of the
 * pull request event source (Plan 339 D2). Armed at the publication run's
 * end, after its terminal write, from the pull request its output names.
 */
import { armPullRequestWatch } from '@aflow/redis';
import { buildWorkflowRunResult, type WorkflowRunDetail } from '@aflow/cybernetic-runtime';
import {
  PLAN_STREAM_PUBLICATION_SLUG,
  RUN_PULL_REQUEST_URL_OUTPUT,
  parsePullRequestRef,
  pullRequestSubject,
} from '@aflow/schemas';
import type { HarnessDeps } from '../cybernetic/harness/types.js';

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
  await armPullRequestWatch(deps.redis, {
    tenantId,
    spaceId: run.spaceId,
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    subject: pullRequestSubject(ref.owner, ref.repo, ref.number),
    url,
    armedAt: nowMs,
  });
  return 'armed';
}
