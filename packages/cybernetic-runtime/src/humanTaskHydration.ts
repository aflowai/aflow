import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type {
  WorkflowHumanActionPreview,
  WorkflowHumanFailureMode,
  WorkflowHumanTaskHydration,
  WorkflowTask,
  WorkflowTaskInputBinding,
} from '@aflow/schemas';
import { inferTaskType } from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';
import {
  resolveTaskInputBindings,
  type WorkflowRunContext,
  type TaskOutputSnapshot,
} from './scheduling/workflowResolver.js';
import type { WorkflowRunDetail, WorkflowTaskRow } from './ledger/types.js';
import { getRunCampaignId } from './ledger.js';
import { getCampaignById } from './campaigns.js';

/**
 * Narrow `workflow_runs.metadata.parentTaskInputs.inputs` — the run-level input
 * pool stored at start — into a plain record. Defensive: returns undefined on
 * absent/malformed metadata. (Inlined rather than imported from
 * workflowRunDetail.ts, which already imports this module.)
 */
function runInputFromMetadata(metadata: unknown): Record<string, unknown> | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const pti = (metadata as Record<string, unknown>)['parentTaskInputs'];
  if (!pti || typeof pti !== 'object') return undefined;
  const inputs = (pti as Record<string, unknown>)['inputs'];
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return undefined;
  return inputs as Record<string, unknown>;
}

/**
 * Decode an inline output ref into its structured payload, or null when
 * the ref is absent / non-inline / malformed.
 */
function decodeInlineOutputRef(outputRef: string | null): Record<string, unknown> | null {
  if (!outputRef?.startsWith('inline:')) return null;
  try {
    const raw = Buffer.from(outputRef.slice('inline:'.length), 'base64').toString('utf8');
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    /* malformed inline ref — treat as unavailable */
  }
  return null;
}

/**
 * Decode a single task's `outputRef` into a structured payload, handling
 * BOTH inline AND PayloadStore-backed refs. Returns `null` when the ref
 * is absent / unreadable / not an object.
 *
 * Both `when:` predicate
 * evaluation in `computeReadyView` and `actionPreview.inputBindings`
 * resolution in `runContextFromDetail` need decoded upstream outputs.
 * Handling inline refs only is not enough: with PayloadStore-backed
 * outputs (e.g. `prepare-submission.submissionPayload.fileContent` for
 * non-trivial CSVs), when-predicates always fall through
 * to `onMissingRef: 'skip'` (so the submit branch never runs) and
 * approve-echo strictly rejects (so approval fails). One shared loader
 * covers both.
 */
export async function decodeTaskOutput(
  outputRef: string | null,
  payloadStore: PayloadStore | undefined,
): Promise<Record<string, unknown> | null> {
  if (!outputRef) return null;
  if (outputRef.startsWith('inline:')) {
    return decodeInlineOutputRef(outputRef);
  }
  if (!payloadStore) return null;
  try {
    const fetched = await payloadStore.retrieve(outputRef as never);
    if (fetched === null || fetched === undefined) return null;
    if (typeof fetched === 'object' && !Array.isArray(fetched) && !Buffer.isBuffer(fetched)) {
      return fetched as Record<string, unknown>;
    }
    const text =
      typeof fetched === 'string'
        ? fetched
        : Buffer.isBuffer(fetched)
          ? fetched.toString('utf8')
          : '';
    if (!text) return null;
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* malformed or unreachable — treat as unavailable */
  }
  return null;
}

export async function loadTaskOutputs(
  taskRows: readonly WorkflowTaskRow[],
  payloadStore: PayloadStore | undefined,
): Promise<Map<string, Record<string, unknown>>> {
  const outputs = new Map<string, Record<string, unknown>>();
  // Sequential to keep PayloadStore retrieval polite; this typically
  // touches a handful of upstream tasks. Parallelize if a real consumer
  // shows up with > 20 upstream outputs.
  for (const row of taskRows) {
    if (row.status !== 'succeeded' && row.status !== 'completed') continue;
    const decoded = await decodeTaskOutput(row.outputRef, payloadStore);
    if (decoded) outputs.set(row.taskId, decoded);
  }
  return outputs;
}

export async function runContextFromDetail(
  run: WorkflowRunDetail,
  payloadStore: PayloadStore | undefined,
  db: PostgresJsDatabase,
  tenantId: string,
): Promise<WorkflowRunContext> {
  const decoded = await loadTaskOutputs(run.tasks, payloadStore);
  const taskOutputs = new Map<string, TaskOutputSnapshot>();
  for (const row of run.tasks) {
    if (row.status !== 'succeeded' && row.status !== 'completed') continue;
    const snapshot: TaskOutputSnapshot = { status: row.status };
    const output = decoded.get(row.taskId);
    if (output) snapshot.output = output;
    if (row.summary !== null) snapshot.summary = row.summary;
    taskOutputs.set(row.taskId, snapshot);
  }
  const context: WorkflowRunContext = {
    taskOutputs,
    stateVariables: new Map(),
  };
  // Run inputs (the run-level pool, stored under parentTaskInputs) must be
  // resolvable here too — an approve task's actionPreview legitimately binds
  // `run_input` (e.g. repo/branch), and without this the materialized
  // approvedCall fails with "Run input not available" at approve time.
  const runInput = runInputFromMetadata(run.metadata);
  if (runInput) context.runInput = runInput;
  const campaignId = await getRunCampaignId(db, tenantId, run.runId);
  if (campaignId) {
    const campaign = await getCampaignById(db, tenantId, campaignId);
    if (campaign) context.campaignConfig = campaign.config ?? {};
  }
  return context;
}

/**
 * Resolve `actionPreview.inputBindings` against the supplied workflow run
 * context. Returns a discriminated result so callers can choose their
 * failure policy:
 *
 *   - No `inputBindings`: `{ ok: true, preview }` — unchanged.
 *   - `inputBindings` resolves cleanly: `{ ok: true, preview: { op,
 *     input: <resolved> } }`, overlaying any literal `input` (parity with
 *     `workflowResolver.resolveTaskInputBindings`).
 *   - Any binding fails: `{ ok: false, preview: <unresolved>,
 *     reason }`. Callers decide whether to surface the unresolved preview
 *     (hydration emit) or reject the operation (approve-echo).
 *
 * Pure synchronous — callers pre-load task outputs into `runContext`.
 */
export type ResolveActionPreviewResult =
  | { ok: true; preview: WorkflowHumanActionPreview }
  | { ok: false; preview: WorkflowHumanActionPreview; reason: string };

export function resolveActionPreview(
  preview: WorkflowHumanActionPreview,
  runContext: WorkflowRunContext,
): ResolveActionPreviewResult {
  if (!preview.inputBindings || Object.keys(preview.inputBindings).length === 0) {
    return { ok: true, preview };
  }
  const bindings: Record<string, WorkflowTaskInputBinding> = preview.inputBindings;
  const baseInputs =
    preview.input && typeof preview.input === 'object' && !Array.isArray(preview.input)
      ? (preview.input as Record<string, unknown>)
      : undefined;

  const result = resolveTaskInputBindings(
    bindings as Record<string, { kind: string; path?: string; taskId?: string }>,
    runContext,
    baseInputs,
  );
  if (!result.ok) {
    const reason = result.errors.map((e) => `${e.field}: ${e.reason}`).join('; ');
    return { ok: false, preview, reason };
  }
  return { ok: true, preview: { op: preview.op, input: result.resolved } };
}

const ACTION_PREVIEW_HEAD_LINES = 8;
const ACTION_PREVIEW_HEAD_BYTES = 1024;

export function summarizeActionPreviewInput(input: unknown): Record<string, unknown> {
  const serialized = typeof input === 'string' ? input : JSON.stringify(input ?? null);
  const sizeBytes = Buffer.byteLength(serialized, 'utf8');
  const lines = serialized.split('\n');
  let head = lines.slice(0, ACTION_PREVIEW_HEAD_LINES).join('\n');
  // Byte-accurate cap (not `head.length`, which counts UTF-16 code units): for
  // multibyte content the code-unit count understates bytes ~3×, letting the
  // inline head exceed ACTION_PREVIEW_HEAD_BYTES. Slice on the UTF-8 buffer; a
  // clipped trailing multibyte char decodes to a replacement char, which is fine
  // for a preview.
  if (Buffer.byteLength(head, 'utf8') > ACTION_PREVIEW_HEAD_BYTES) {
    head = Buffer.from(head, 'utf8').subarray(0, ACTION_PREVIEW_HEAD_BYTES).toString('utf8') + '…';
  }
  return {
    __previewTruncated: true,
    sizeBytes,
    lineCount: lines.length,
    head,
    note: 'Head/stat only — full preview stored by reference (actionPreviewRef).',
  };
}

export function buildDisplayActionPreview(
  preview: WorkflowHumanActionPreview,
): WorkflowHumanActionPreview {
  return { op: preview.op, input: summarizeActionPreviewInput(preview.input) };
}

export type HumanTaskHydrationFields = Pick<
  WorkflowHumanTaskHydration,
  | 'humanIntent'
  | 'resolutionSchema'
  | 'actionPreview'
  | 'resumeContract'
  | 'pauseVersion'
  | 'failureMode'
>;

/**
 * Build optional hydration fields for a paused human workflow task.
 * Returns `undefined` when the task is not `type: 'human'`.
 *
 * Pass `resolvedActionPreview` when the task has `actionPreview.inputBindings`
 * the caller has already resolved. When omitted, the task's authored
 * preview (with unresolved bindings) is emitted as-is — the UI degrades
 * gracefully (operator sees binding objects rather than nothing).
 */
export function buildHumanTaskHydrationFields(args: {
  task: WorkflowTask;
  runPauseVersion: number;
  resumeContract?: unknown;
  /** Caller-resolved preview (`input` materialized from `inputBindings`). */
  resolvedActionPreview?: WorkflowHumanActionPreview;
}): HumanTaskHydrationFields | undefined {
  if (inferTaskType(args.task) !== 'human') return undefined;

  const intent = args.task.intent ?? 'collect';
  const failureMode: WorkflowHumanFailureMode = args.task.failureMode ?? 'isolate';

  const fields: HumanTaskHydrationFields = {
    humanIntent: intent,
    failureMode,
    pauseVersion: args.runPauseVersion,
  };

  if (args.resumeContract !== undefined) {
    fields.resumeContract = args.resumeContract;
  }

  if (intent === 'collect' && args.task.outputContract?.schema) {
    fields.resolutionSchema = args.task.outputContract.schema;
  }

  const preview = args.resolvedActionPreview ?? args.task.actionPreview;
  if (intent === 'approve' && preview) {
    fields.actionPreview = preview;
  }

  return fields;
}
