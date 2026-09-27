import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and } from 'drizzle-orm';
import { createTenantContext, withTenantSchema, workflowRunTasks } from '@aflow/database';
import {
  DurableWorkflowHumanTaskHydrationSchema,
  type DurableWorkflowHumanTaskHydration,
  type PayloadRef,
  type TenantId,
  type WorkflowHumanTaskHydrationMissingError,
} from '@aflow/schemas';
import { encodeInlinePayloadRef, type PayloadStore } from '@aflow/payload-store';

// ============================================================================
// Resolve
// ============================================================================

export type LoadHydrationResult =
  | { kind: 'hydrated'; hydration: DurableWorkflowHumanTaskHydration }
  | {
      kind: 'missing';
      diagnostic: WorkflowHumanTaskHydrationMissingError;
    };

export interface LoadHydrationParams {
  runId: string;
  taskId: string;
  /** When provided, the resolver rejects refs whose pauseVersion does
   *  not match — guards against a stale ref left over after a re-pause. */
  expectedPauseVersion?: number;
  expectedAttempt?: number;
}

export async function loadWorkflowHumanTaskHydration(
  deps: { db: PostgresJsDatabase; payloadStore: PayloadStore },
  tenantId: TenantId,
  params: LoadHydrationParams,
): Promise<LoadHydrationResult> {
  const ctx = createTenantContext(tenantId);
  const row = await withTenantSchema(deps.db, ctx, async (tx) => {
    const rows = await tx
      .select({
        attempt: workflowRunTasks.attempt,
        humanTaskHydrationRef: workflowRunTasks.humanTaskHydrationRef,
        humanTaskHydrationPauseVersion: workflowRunTasks.humanTaskHydrationPauseVersion,
        humanTaskHydrationAttempt: workflowRunTasks.humanTaskHydrationAttempt,
      })
      .from(workflowRunTasks)
      .where(
        and(eq(workflowRunTasks.runId, params.runId), eq(workflowRunTasks.taskId, params.taskId)),
      )
      .limit(1);
    return rows[0] ?? null;
  });

  // Build the diagnostic shape lazily — every miss path uses it.
  const diagnostic = (message: string): WorkflowHumanTaskHydrationMissingError => ({
    code: 'WORKFLOW_HUMAN_TASK_HYDRATION_MISSING',
    runId: params.runId,
    taskId: params.taskId,
    attempt: params.expectedAttempt ?? row?.attempt ?? 1,
    pauseVersion: params.expectedPauseVersion ?? row?.humanTaskHydrationPauseVersion ?? 0,
    message,
  });

  if (!row) {
    return { kind: 'missing', diagnostic: diagnostic('Task row not found for this run') };
  }
  if (!row.humanTaskHydrationRef) {
    return {
      kind: 'missing',
      diagnostic: diagnostic(
        'Hydration ref not stamped — paused on a pre-Plan-170 code path; run the backfill',
      ),
    };
  }
  if (
    params.expectedAttempt !== undefined &&
    row.humanTaskHydrationAttempt !== null &&
    row.humanTaskHydrationAttempt !== params.expectedAttempt
  ) {
    return {
      kind: 'missing',
      diagnostic: diagnostic(
        `Hydration ref attempt ${String(row.humanTaskHydrationAttempt)} ` +
          `does not match task attempt ${String(params.expectedAttempt)}`,
      ),
    };
  }
  if (
    params.expectedPauseVersion !== undefined &&
    row.humanTaskHydrationPauseVersion !== null &&
    row.humanTaskHydrationPauseVersion !== params.expectedPauseVersion
  ) {
    return {
      kind: 'missing',
      diagnostic: diagnostic(
        `Hydration ref pauseVersion ${String(row.humanTaskHydrationPauseVersion)} ` +
          `does not match run pauseVersion ${String(params.expectedPauseVersion)}`,
      ),
    };
  }

  let raw: unknown;
  try {
    raw = await deps.payloadStore.retrieve(row.humanTaskHydrationRef);
  } catch (err) {
    return {
      kind: 'missing',
      diagnostic: diagnostic(
        `Hydration ref failed to dereference: ${err instanceof Error ? err.message : String(err)}`,
      ),
    };
  }
  if (raw === null || raw === undefined) {
    return {
      kind: 'missing',
      diagnostic: diagnostic('Hydration ref dereferenced to null — payload missing or evicted'),
    };
  }

  // PayloadStore.retrieve returns the decoded value; for inline refs
  // it's already an object, for GCS-backed refs it's a parsed JSON
  // body. Either way Zod validates.
  const parsed = DurableWorkflowHumanTaskHydrationSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      kind: 'missing',
      diagnostic: diagnostic(
        `Hydration payload failed schema validation: ${parsed.error.issues
          .map((i) => i.path.join('.') + ': ' + i.message)
          .slice(0, 3)
          .join('; ')}`,
      ),
    };
  }

  const hyd = parsed.data;
  if (hyd.runId !== params.runId) {
    return {
      kind: 'missing',
      diagnostic: diagnostic(
        `Hydration payload runId mismatch: expected ${params.runId}, got ${hyd.runId}`,
      ),
    };
  }
  if (hyd.taskId !== params.taskId) {
    return {
      kind: 'missing',
      diagnostic: diagnostic(
        `Hydration payload taskId mismatch: expected ${params.taskId}, got ${hyd.taskId}`,
      ),
    };
  }
  if (params.expectedAttempt !== undefined && hyd.attempt !== params.expectedAttempt) {
    return {
      kind: 'missing',
      diagnostic: diagnostic(
        `Hydration payload attempt mismatch: expected ${String(params.expectedAttempt)}, got ${String(hyd.attempt)}`,
      ),
    };
  }
  if (
    params.expectedPauseVersion !== undefined &&
    hyd.pauseVersion !== params.expectedPauseVersion
  ) {
    return {
      kind: 'missing',
      diagnostic: diagnostic(
        `Hydration payload pauseVersion mismatch: expected ${String(params.expectedPauseVersion)}, got ${String(hyd.pauseVersion)}`,
      ),
    };
  }
  return { kind: 'hydrated', hydration: hyd };
}

// ============================================================================
// Build hydration payload — pure helper used by the harness pause site
// ============================================================================

export interface BuildHydrationParams {
  runId: string;
  taskId: string;
  attempt: number;
  /** POST-bump value (the new pause version after this pause). */
  pauseVersion: number;
  humanIntent: 'collect' | 'approve';
  failureMode?: 'isolate' | 'cancel_siblings';
  resolutionSchema?: Record<string, unknown>;
  /** Inline action preview, when it fits. Mutually exclusive with
   *  `actionPreviewRef`. */
  actionPreview?: DurableWorkflowHumanTaskHydration['actionPreview'];
  actionPreviewRef?: PayloadRef;
  resumeContract: DurableWorkflowHumanTaskHydration['resumeContract'];
}

/**
 * Build a durable hydration payload. The shape is the wire-level
 * `DurableWorkflowHumanTaskHydrationSchema`; this helper just stamps
 * `hydrationVersion`/`createdAt` and assembles optional fields without
 * passing `undefined` explicitly (TypeScript
 * `exactOptionalPropertyTypes` strict mode).
 */
export function buildDurableHydration(
  params: BuildHydrationParams,
): DurableWorkflowHumanTaskHydration {
  return {
    hydrationVersion: 1,
    runId: params.runId,
    taskId: params.taskId,
    attempt: params.attempt,
    pauseVersion: params.pauseVersion,
    humanIntent: params.humanIntent,
    ...(params.failureMode ? { failureMode: params.failureMode } : {}),
    ...(params.resolutionSchema ? { resolutionSchema: params.resolutionSchema } : {}),
    ...(params.actionPreview ? { actionPreview: params.actionPreview } : {}),
    ...(params.actionPreviewRef ? { actionPreviewRef: params.actionPreviewRef } : {}),
    resumeContract: params.resumeContract,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Encode the durable hydration as an `inline:<base64>` PayloadRef.
 * Used by the harness pause site for hydrations small enough to ride
 * inline (the typical case — a workflow definition's resumeContract +
 * resolved preview rarely exceeds the inline payload threshold).
 *
 * Large previews use the full PayloadStore path; the harness checks
 * `payloadStore.shouldStore` before deciding which path to take.
 */
export function encodeInlineHydrationRef(hydration: DurableWorkflowHumanTaskHydration): PayloadRef {
  return encodeInlinePayloadRef(hydration);
}
