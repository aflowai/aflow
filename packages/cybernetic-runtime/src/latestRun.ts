/**
 * The newest completed run of a skill, optionally the newest whose promoted
 * value matches one given — the read behind `workflow.run.latest`.
 *
 * Promoted values are derived from task outputs at read time rather than
 * stored on the run, so the search reads them run by run, newest first, and
 * stops at the first match. It is bounded by the scan limit rather than by the
 * skill's history: a caller asks one question and pays for at most that many
 * runs.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PayloadStore } from '@aflow/payload-store';
import { resolveWorkflowForRunRevision } from '@aflow/database';
import {
  WORKFLOW_RUN_LATEST_SCAN_LIMIT,
  type TenantId,
  type Workflow,
  type WorkflowRunLatestInput,
  type WorkflowRunLatestOutput,
} from '@aflow/schemas';
import { listRecentCompletedRuns, loadRunById } from './ledger/queries.js';
import { buildWorkflowRunResult } from './runResult.js';

export interface FindLatestCompletedRunArgs {
  tenantId: string;
  spaceId: string;
  input: WorkflowRunLatestInput;
  scanLimit?: number;
}

export async function findLatestCompletedRun(
  deps: { db: PostgresJsDatabase; payloadStore: PayloadStore },
  args: FindLatestCompletedRunArgs,
): Promise<WorkflowRunLatestOutput> {
  const { db, payloadStore } = deps;
  const { tenantId, spaceId, input } = args;
  const candidates = await listRecentCompletedRuns(
    db,
    tenantId,
    spaceId,
    input.slug,
    args.scanLimit ?? WORKFLOW_RUN_LATEST_SCAN_LIMIT,
  );

  // Runs of one skill share a handful of revisions, and each resolution is a
  // document read.
  const workflowByRevision = new Map<number, Workflow | null>();
  const workflowFor = async (revision: number): Promise<Workflow | null> => {
    if (!workflowByRevision.has(revision)) {
      const resolved = await resolveWorkflowForRunRevision(
        db,
        tenantId as TenantId,
        spaceId,
        input.slug,
        revision,
      ).catch(() => null);
      workflowByRevision.set(revision, resolved?.workflow ?? null);
    }
    return workflowByRevision.get(revision) ?? null;
  };

  let scanned = 0;
  for (const candidate of candidates) {
    scanned += 1;
    if (candidate.completedAt === null) continue;
    const workflow = await workflowFor(candidate.workflowRevision);
    if (workflow === null) continue;
    const run = await loadRunById(db, tenantId, spaceId, candidate.runId);
    if (run === null) continue;
    const result = await buildWorkflowRunResult(
      { db, payloadStore },
      { tenantId, run, workflow, scope: 'partial' },
    );
    const state = result?.output ?? {};
    if (input.match !== undefined && state[input.match.stateVariable] !== input.match.equals) {
      continue;
    }
    return {
      run: { runId: candidate.runId, completedAt: candidate.completedAt.toISOString(), state },
      scanned,
    };
  }
  return { run: null, scanned };
}
