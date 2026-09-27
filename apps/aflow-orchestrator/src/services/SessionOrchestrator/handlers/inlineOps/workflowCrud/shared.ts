import {
  getDatabase,
  createTenantContext,
  createMemoryDocRepository,
  createMemoryDirRepository,
  workflowDirPath,
} from '@aflow/database';
import type { TenantId, WorkflowTrajectoryRow } from '@aflow/schemas';
import type { WorkflowRunSummary } from '@aflow/cybernetic-runtime';

export const workflowPath = workflowDirPath;

export function buildTrajectory(runs: WorkflowRunSummary[]): WorkflowTrajectoryRow[] {
  return runs.map((run) => ({
    runId: run.runId,
    status: run.status as WorkflowTrajectoryRow['status'],
    startedAt: run.startedAt.toISOString(),
    ...(run.completedAt ? { completedAt: run.completedAt.toISOString() } : {}),
    learningCount: run.learningCount,
    ...(run.totalCostCents != null ? { costCents: run.totalCostCents } : {}),
    score: run.score,
  }));
}

export function nextCursorFromRuns(runs: WorkflowRunSummary[], limit: number): string | undefined {
  if (limit <= 0 || runs.length < limit) return undefined;
  const oldest = runs[runs.length - 1];
  return oldest ? `${oldest.startedAt.toISOString()}|${oldest.runId}` : undefined;
}

export function parseLedgerCursor(cursor: string | undefined): {
  before?: Date;
  beforeRunId?: string;
} {
  if (!cursor) return {};
  const sep = cursor.indexOf('|'); // ISO timestamps contain no '|'
  const isoPart = sep === -1 ? cursor : cursor.slice(0, sep);
  const date = new Date(isoPart);
  if (Number.isNaN(date.getTime())) return {};
  if (sep === -1) return { before: date };
  return { before: date, beforeRunId: cursor.slice(sep + 1) };
}

export function getRepos(tenantId: TenantId) {
  const db = getDatabase();
  const tenantCtx = createTenantContext(tenantId);
  const docRepo = createMemoryDocRepository(db, tenantCtx);
  const dirRepo = createMemoryDirRepository(db, tenantCtx);
  return { db, tenantCtx, docRepo, dirRepo };
}

export async function readJsonDoc<T>(
  docRepo: ReturnType<typeof createMemoryDocRepository>,
  path: string,
  spaceId: string,
): Promise<T | null> {
  const doc = await docRepo.getByPath(path, spaceId);
  if (!doc) return null;
  if (doc.inlineContent) {
    return JSON.parse(doc.inlineContent) as T;
  }
  return null;
}

export async function writeJsonDoc(
  docRepo: ReturnType<typeof createMemoryDocRepository>,
  dirRepo: ReturnType<typeof createMemoryDirRepository>,
  path: string,
  data: Record<string, unknown>,
  docType: string,
  spaceId: string,
  writeMode: 'upsert' | 'create' | 'overwrite' = 'upsert',
  semanticType: string | null = 'workflow_overview',
): Promise<{ id: string; path: string; version: number }> {
  const content = JSON.stringify(data, null, 2);

  await dirRepo.ensureParentDirs(path, { spaceId });

  const result = await docRepo.put({
    path,
    writeMode,
    docType,
    mimeType: 'application/json',
    inlineContent: content,
    payloadRef: null,
    sizeBytes: Buffer.byteLength(content, 'utf8'),
    contentHash: '',
    preview: content.substring(0, 200),
    tags: ['workflow'],
    summary: null,
    semanticType,
    indexing: 'disabled',
    scope: { spaceId },
  });

  return { id: result.id, path: result.path, version: result.currentVersion };
}
