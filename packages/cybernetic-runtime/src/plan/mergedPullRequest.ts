import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { createTenantContext, withTenantSchema } from '@aflow/database';
import { PLAN_STREAM_PUBLICATION_SLUG, type TenantId } from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';
import { resolveConnectionForRepoCoordinate } from '../repoConnection.js';
import { getTaskRow } from '../ledger/queries.js';

type BindingRead = (
  bindingId: string,
  endpointId: string,
  params: Record<string, string>,
) => Promise<unknown>;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

export function formatMergeEvidence(
  url?: string,
  answer: Record<string, unknown> | null = null,
  work: { sha?: unknown; branch?: unknown } = {},
  merged = false,
): string {
  const reported = (value: unknown) => (typeof value === 'string' ? value : 'not reported');
  return [
    url
      ? `Pull request: #${url.split('/pull/')[1]?.replace(/\/$/, '') ?? '?'} ${url}`
      : 'Pull request: not linked',
    `GitHub reports merged: ${answer?.['merged'] === true ? 'yes' : 'no'}`,
    `Merge commit: ${reported(answer?.['merge_commit_sha'])}`,
    `Merged by: ${reported(record(answer?.['merged_by'])?.['login'])}`,
    `Merged at: ${reported(answer?.['merged_at'])}`,
    `Recorded publication commit: ${typeof work.sha === 'string' ? work.sha : 'not recorded'}`,
    `Recorded publication branch: ${typeof work.branch === 'string' ? work.branch : 'not recorded'}`,
    `Merge delivers recorded commit or branch: ${merged ? 'yes' : 'not attested'}`,
  ]
    .map((line) => `- ${line}`)
    .join('\n');
}

/** Each close reads both the node's publication record and GitHub anew. */
export async function readMergedPullRequest(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  url: string,
  nodeId: string,
  deps: { payloadStore: PayloadStore; readBinding: BindingRead },
): Promise<{ merged: boolean; evidence: string; reason: string }> {
  let answer: Record<string, unknown> | null = null;
  const work = { sha: undefined as unknown, branch: undefined as unknown };
  const result = (merged: boolean, reason: string) => ({
    merged,
    reason,
    evidence: formatMergeEvidence(url, answer, work, merged),
  });
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/i.exec(url);
  if (!match) return result(false, 'The linked URL is not a GitHub pull request.');
  const owner = match[1]!;
  const repo = match[2]!;
  const number = match[3]!;
  const publication = await withTenantSchema(
    db,
    createTenantContext(tenantId as TenantId),
    async (tx) => {
      const [row] = await tx.execute<{ run_id: string }>(sql`
      SELECT run_id FROM workflow_runs
      WHERE space_id = ${spaceId}::uuid AND plan_node_id = ${nodeId}::uuid
        AND workflow_slug = ${PLAN_STREAM_PUBLICATION_SLUG} AND eval_batch_id IS NULL
      ORDER BY started_at DESC, run_id DESC LIMIT 1
    `);
      return row;
    },
  );
  if (!publication) return result(false, 'No publication is recorded for this step.');
  let publishedUrl: string | undefined;
  for (const taskId of ['open-pr', 'find-pr']) {
    const prTask = await getTaskRow(db, tenantId, publication.run_id, taskId);
    if (
      prTask?.status !== 'succeeded' ||
      prTask.operationId !== 'api.http.call' ||
      !prTask.outputRef
    )
      continue;
    const prOutput = record(await deps.payloadStore.retrieve(prTask.outputRef));
    if (typeof prOutput?.['prUrl'] === 'string') {
      publishedUrl = prOutput['prUrl'];
      break;
    }
  }
  const task = await getTaskRow(db, tenantId, publication.run_id, 'commit');
  if (task?.status !== 'succeeded' || task.operationId !== 'host.file.patch' || !task.outputRef)
    return result(false, 'The publication has no successful commit record.');
  const output = record(await deps.payloadStore.retrieve(task.outputRef));
  const merge = record(output?.['commit']);
  const sha = (work.sha = merge?.['sha']);
  const branch = (work.branch = merge?.['branch']);
  if (publishedUrl?.replace(/\/$/, '').toLowerCase() !== url.replace(/\/$/, '').toLowerCase())
    return result(
      false,
      'The linked pull request differs from the recorded publication pull request.',
    );
  const recordedSha = typeof sha === 'string' && /^[0-9a-f]{40}$/i.test(sha) ? sha : undefined;
  if (recordedSha === undefined && (typeof branch !== 'string' || branch.length === 0))
    return result(false, 'The publication records neither a commit nor a branch.');

  const bindingId = await resolveConnectionForRepoCoordinate(
    db,
    tenantId,
    spaceId,
    `${owner}/${repo}`.toLowerCase(),
  );
  answer = record(
    await deps.readBinding(bindingId, 'getPullRequest', { owner, repo, pull_number: number }),
  );
  if (!answer || typeof answer['merged'] !== 'boolean')
    throw new Error('Invalid GitHub pull request response');

  if (
    !answer['merged'] ||
    typeof answer['html_url'] !== 'string' ||
    answer['html_url'].replace(/\/$/, '').toLowerCase() !== url.replace(/\/$/, '').toLowerCase()
  )
    return result(
      false,
      !answer['merged']
        ? 'GitHub does not report the linked pull request merged.'
        : 'GitHub returned a different pull request.',
    );
  const head = record(answer['head']);
  const headRepo = record(head?.['repo']);
  const coordinate = `${owner}/${repo}`.toLowerCase();
  if (
    (recordedSha !== undefined &&
      typeof head?.['sha'] === 'string' &&
      head['sha'].toLowerCase() === recordedSha.toLowerCase()) ||
    (typeof branch === 'string' &&
      head?.['ref'] === branch &&
      typeof headRepo?.['full_name'] === 'string' &&
      headRepo['full_name'].toLowerCase() === coordinate)
  )
    return result(true, 'The merge delivers the recorded commit or branch.');
  if (recordedSha === undefined)
    return result(false, 'The merge does not deliver the recorded publication branch.');
  const mergeSha = answer['merge_commit_sha'];
  if (typeof mergeSha !== 'string' || !/^[0-9a-f]{40}$/i.test(mergeSha))
    return result(false, 'GitHub reports no merge commit to compare with the recorded work.');
  if (mergeSha.toLowerCase() === recordedSha.toLowerCase())
    return result(true, 'The merge delivers the recorded commit or branch.');
  const comparison = record(
    await deps.readBinding(bindingId, 'compareCommits', {
      owner,
      repo,
      base: recordedSha,
      head: mergeSha,
    }),
  );
  if (
    !comparison ||
    !['ahead', 'identical', 'behind', 'diverged'].includes(String(comparison['status']))
  )
    throw new Error('Invalid GitHub comparison response');
  const delivered = comparison['status'] === 'ahead' || comparison['status'] === 'identical';
  return result(
    delivered,
    delivered
      ? 'The merge contains the recorded commit.'
      : 'The merge does not deliver the recorded commit or branch.',
  );
}
