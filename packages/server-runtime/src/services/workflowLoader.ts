import { type MemoryDocRepository, type MemoryDoc } from '@aflow/database';
import type { PayloadStore } from '@aflow/payload-store';
import { WorkflowSchema, type Workflow } from '@aflow/schemas';

export interface WorkflowLoadResult {
  /** The fully validated workflow, or null if validation failed. */
  workflow: Workflow | null;
  /** The raw parsed JSON (available even when validation fails). */
  raw: unknown;
  /** Human-readable validation error (set when workflow is null). */
  error?: string;
}

export async function loadWorkflowContentWithDiagnostic(
  repo: MemoryDocRepository,
  payloadStore: PayloadStore | null,
  docId: string,
  spaceId: string,
  opts?: { includeDeleted?: boolean },
): Promise<WorkflowLoadResult> {
  const doc: MemoryDoc | null = await repo.getById(docId, spaceId, opts);
  if (!doc) return { workflow: null, raw: null };
  if (doc.deletedAt && !opts?.includeDeleted) return { workflow: null, raw: null };

  let raw: unknown;
  if (doc.inlineContent !== null) {
    try {
      raw = JSON.parse(doc.inlineContent);
    } catch {
      return { workflow: null, raw: null, error: 'JSON parse failed' };
    }
  } else if (doc.payloadRef && payloadStore) {
    try {
      const payload = await payloadStore.retrieve(doc.payloadRef);
      raw = typeof payload === 'string' ? JSON.parse(payload) : payload;
    } catch {
      return { workflow: null, raw: null, error: 'Payload retrieval failed' };
    }
  } else {
    return { workflow: null, raw: null, error: 'No content' };
  }

  const parsed = WorkflowSchema.safeParse(raw);
  if (parsed.success) {
    return { workflow: parsed.data, raw };
  }

  const firstIssue = parsed.error.issues[0];
  const errorMsg = firstIssue
    ? `${firstIssue.path.join('.')}: ${firstIssue.message}`
    : parsed.error.message;
  return { workflow: null, raw, error: errorMsg };
}

export async function loadWorkflowContent(
  repo: MemoryDocRepository,
  payloadStore: PayloadStore | null,
  docId: string,
  spaceId: string,
): Promise<Workflow | null> {
  const result = await loadWorkflowContentWithDiagnostic(repo, payloadStore, docId, spaceId);
  return result.workflow;
}
