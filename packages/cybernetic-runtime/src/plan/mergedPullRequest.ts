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

/** Each close reads both the node's publication record and GitHub anew. */
export async function readMergedPullRequest(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  url: string,
  nodeId: string,
  deps: { payloadStore: PayloadStore; readBinding: BindingRead },
): Promise<boolean> {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/i.exec(url);
  if (!match) return false;
  const owner = match[1]!;
  const repo = match[2]!;
  const number = match[3]!;
  const bindingId = await resolveConnectionForRepoCoordinate(
    db,
    tenantId,
    spaceId,
    `${owner}/${repo}`.toLowerCase(),
  );
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
  if (!publication) return false;
  const task = await getTaskRow(db, tenantId, publication.run_id, 'commit');
  if (task?.status !== 'succeeded' || task.operationId !== 'host.file.patch' || !task.outputRef)
    return false;
  const output = record(await deps.payloadStore.retrieve(task.outputRef));
  const merge = record(output?.['commit']);
  const sha = merge?.['sha'];
  const branch = merge?.['branch'];
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/i.test(sha)) return false;

  const answer = record(
    await deps.readBinding(bindingId, 'getPullRequest', { owner, repo, pull_number: number }),
  );
  if (
    answer?.['merged'] !== true ||
    typeof answer['html_url'] !== 'string' ||
    answer['html_url'].replace(/\/$/, '').toLowerCase() !== url.replace(/\/$/, '').toLowerCase()
  )
    return false;
  const head = record(answer['head']);
  const headRepo = record(head?.['repo']);
  const coordinate = `${owner}/${repo}`.toLowerCase();
  if (
    head?.['sha'] === sha ||
    (typeof branch === 'string' &&
      head?.['ref'] === branch &&
      typeof headRepo?.['full_name'] === 'string' &&
      headRepo['full_name'].toLowerCase() === coordinate)
  )
    return true;
  const mergeSha = answer['merge_commit_sha'];
  if (typeof mergeSha !== 'string' || !/^[0-9a-f]{40}$/i.test(mergeSha)) return false;
  if (mergeSha.toLowerCase() === sha.toLowerCase()) return true;
  const comparison = record(
    await deps.readBinding(bindingId, 'compareCommits', { owner, repo, base: sha, head: mergeSha }),
  );
  return comparison?.['status'] === 'ahead' || comparison?.['status'] === 'identical';
}
