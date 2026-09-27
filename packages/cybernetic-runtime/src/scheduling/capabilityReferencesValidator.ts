import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  registerRuntimeValidator,
  getPlatformOperationPrefixes,
  SPACE_POLICY_OPERATION_PREFIXES,
  CODE_LANE_ABSENT_CAPABILITY_ID,
  isCodeLaneToken,
  type RuntimeValidatorContext,
  type RuntimeValidatorIssue,
} from '@aflow/schemas';
import { checkMissingCapabilities, type ReconcilerContext } from '../skillProjectionReconciler.js';

/** Stable name. Reference as `'capability-references-bound'` or `...@$.<path>`. */
export const CAPABILITY_REFERENCES_BOUND_VALIDATOR_REF = 'capability-references-bound' as const;

// ============================================================================
// Capability extraction (mirrors skillCompose.ts:425-465)
// ============================================================================

/**
 * Platform-prefix list — operations whose prefix is a platform built-in
 * (always available) and never needs a binding.
 *
 * Derived from the operation registry minus
 * `SPACE_POLICY_OPERATION_PREFIXES`. Prior revisions
 * hand-wrote the list and drifted — `'ai'` was missing from this file
 * even though `ai.text.generate` is a platform built-in, and runners got
 * `references operation "ai" but no enabled binding is available` errors
 * they couldn't act on.
 */
const PLATFORM_PREFIXES = getPlatformOperationPrefixes();

export interface CapabilityReference {
  taskIdx: number;
  taskId: string;
  kind: 'api' | 'mcp' | 'operation';
  identifier: string;
  /** Pointer for the Zod issue path so the agent sees exactly which entry is wrong. */
  path: Array<string | number>;
}

/**
 * Walk the workflow's tasks and collect every external capability reference
 * — apis, mcp servers, and operation prefixes, from both a task's own
 * `operation` and its context grants — paired with a path the agent can use
 * to locate the offending entry.
 *
 * Operations whose prefix is in `PLATFORM_PREFIXES` are skipped since
 * those are platform built-ins and don't need a binding.
 */
export function collectCapabilityReferences(workflow: unknown): CapabilityReference[] {
  const refs: CapabilityReference[] = [];
  if (!workflow || typeof workflow !== 'object') return refs;
  const tasks = (workflow as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) return refs;

  for (const [taskIdx, task] of tasks.entries()) {
    if (!task || typeof task !== 'object') continue;
    const t = task as Record<string, unknown>;
    const taskId = typeof t['taskId'] === 'string' ? t['taskId'] : `task-${String(taskIdx)}`;

    // An operation task names its operation directly, which is how a
    // policy-gated lane (`code`, `compute`) is meant to appear. Being
    // `opTaskOnly` those ops are refused at step scheduling if they arrive
    // by another route — a runtime denial, not a shape this compose-time
    // walk may assume, so read the task's own operation rather than
    // concluding no other form exists.
    if (typeof t['operation'] === 'string') {
      const prefix = t['operation'].split('.')[0];
      if (prefix && !PLATFORM_PREFIXES.has(prefix)) {
        refs.push({
          taskIdx,
          taskId,
          kind: 'operation',
          identifier: prefix,
          path: ['tasks', taskIdx, 'operation'],
        });
      }
    }

    const ctx = t['context'];
    if (!ctx || typeof ctx !== 'object') continue;

    const caps = (ctx as Record<string, unknown>)['capabilities'];
    if (caps && typeof caps === 'object') {
      const c = caps as Record<string, unknown>;

      if (Array.isArray(c['integrations'])) {
        for (const [grantIdx, grant] of c['integrations'].entries()) {
          if (!grant || typeof grant !== 'object') continue;
          const g = grant as Record<string, unknown>;
          const sourceKind = g['sourceKind'];
          const kind: 'api' | 'mcp' = sourceKind === 'mcp' ? 'mcp' : 'api';
          const integrationId = g['integrationId'];
          const capabilityId = g['capabilityId'];
          const basePath = ['tasks', taskIdx, 'context', 'capabilities', 'integrations', grantIdx];
          if (typeof integrationId === 'string') {
            refs.push({
              taskIdx,
              taskId,
              kind,
              identifier: integrationId,
              path: [...basePath, 'integrationId'],
            });
          }
          // capabilityId checked when distinct from integrationId (mirrors
          // skillCompose.ts: V1 invariant is they're equal, but stay defensive).
          if (typeof capabilityId === 'string' && capabilityId !== integrationId) {
            refs.push({
              taskIdx,
              taskId,
              kind,
              identifier: capabilityId,
              path: [...basePath, 'capabilityId'],
            });
          }
        }
      }

      // operations — only the prefix matters, and only non-platform prefixes
      // need a binding.
      if (Array.isArray(c['operations'])) {
        for (const [opIdx, op] of c['operations'].entries()) {
          if (typeof op !== 'string') continue;
          const prefix = op.split('.')[0];
          if (!prefix || PLATFORM_PREFIXES.has(prefix)) continue;
          refs.push({
            taskIdx,
            taskId,
            kind: 'operation',
            identifier: prefix,
            path: ['tasks', taskIdx, 'context', 'capabilities', 'operations', opIdx],
          });
        }
      }
    }

    // legacy: tools array (operation IDs)
    if (Array.isArray((ctx as Record<string, unknown>)['tools'])) {
      const tools = (ctx as Record<string, unknown>)['tools'] as unknown[];
      for (const [toolIdx, tool] of tools.entries()) {
        if (typeof tool !== 'string') continue;
        const prefix = tool.split('.')[0];
        if (!prefix || PLATFORM_PREFIXES.has(prefix)) continue;
        refs.push({
          taskIdx,
          taskId,
          kind: 'operation',
          identifier: prefix,
          path: ['tasks', taskIdx, 'context', 'tools', toolIdx],
        });
      }
    }
  }

  return refs;
}

// ============================================================================
// Validator
// ============================================================================

/**
 * Runtime validator entry point. Collects every external capability
 * reference in the workflow, asks `checkMissingCapabilities` which ones
 * the space doesn't satisfy, and emits one issue per missing identifier
 * — pointing at the exact path the agent can edit.
 *
 * Same function `checkMissingCapabilities` runs at apply-time and ratify-
 * time. By running it here too, the missing-binding check happens at the
 * producer's session and the runner can self-correct (drop the reference,
 * propose only what's available, or `signal_blocked` asking the operator
 * to bind the capability first).
 */
export async function capabilityReferencesBoundValidator(
  data: unknown,
  ctx: RuntimeValidatorContext,
): Promise<RuntimeValidatorIssue[]> {
  const refs = collectCapabilityReferences(data);
  if (refs.length === 0) return [];

  const requiredIdentifiers = [...new Set(refs.map((r) => r.identifier))];
  const reconcilerCtx: ReconcilerContext = {
    db: ctx.db as PostgresJsDatabase,
    tenantId: ctx.tenantId,
    spaceId: ctx.spaceId,
  };
  const missing = new Set(await checkMissingCapabilities(reconcilerCtx, requiredIdentifiers));
  // Where the deployment composes no coding lane, the lane's tokens fold into
  // one; a reference to any of them is still unmet here.
  const laneAbsent = missing.has(CODE_LANE_ABSENT_CAPABILITY_ID);

  const issues: RuntimeValidatorIssue[] = [];
  for (const ref of refs) {
    const unavailableOnEdition = laneAbsent && isCodeLaneToken(ref.identifier);
    if (!missing.has(ref.identifier) && !unavailableOnEdition) continue;

    // Distinguish space-policy capabilities (operator must enable) from
    // missing bindings (operator must bind, runner can drop or
    // signal_blocked). The two need different runner reactions:
    //
    //   - `compute` / `code` are governed by a per-space policy the runner
    //     cannot enable. If the task genuinely needs one, the only option
    //     is `signal_blocked`. Dropping the reference would silently break
    //     the workflow.
    //   - API / MCP bindings can be dropped if the task can run without
    //     them, OR `signal_blocked` if the task genuinely needs them.
    const isSpacePolicy = SPACE_POLICY_OPERATION_PREFIXES.has(ref.identifier);
    const message = unavailableOnEdition
      ? `Task "${ref.taskId}" references "${ref.identifier}", and this deployment composes no ` +
        'coding lane, so no binding, key or space setting can supply it. Drop the reference and ' +
        'run the work through a host-backed task, or call **signal_blocked** with category ' +
        '"capability_unavailable". Do NOT keep retrying with the same reference.'
      : isSpacePolicy
        ? `Task "${ref.taskId}" references "${ref.identifier}", which is a space-level policy ` +
          '(not an API binding) — the operator enables it per space, no binding can. ' +
          `If your task genuinely needs ${ref.identifier}, call **signal_blocked** with category ` +
          '"capability_unavailable" — the operator will enable it and resume the run. ' +
          'Do NOT keep retrying with the same reference; this validator will keep rejecting it.'
        : `Task "${ref.taskId}" references ${ref.kind} "${ref.identifier}" but no enabled binding ` +
          'is available in this space. If your task can run without this capability, drop the ' +
          'reference. If it genuinely needs the capability, call **signal_blocked** with category ' +
          '"capability_unavailable" so the operator can bind it. Do NOT keep retrying with the same ' +
          'reference; this validator will keep rejecting it.';

    issues.push({
      code: 'custom',
      path: ref.path,
      message,
      params: {
        runtimeValidatorKind: 'capability-references-bound',
        missingIdentifier: ref.identifier,
        capabilityKind: ref.kind,
        taskId: ref.taskId,
        // Coach evidence + future runtime decisions key off this. A
        // space-policy capability has no per-binding remedy — operator
        // policy is the only path.
        operatorBoundReason: unavailableOnEdition
          ? 'edition'
          : isSpacePolicy
            ? 'space-policy'
            : 'no-enabled-binding',
      },
    });
  }
  return issues;
}

// Register at module load. The schedulers / orchestrator import this file
// indirectly via the cybernetic-runtime barrel, so registration happens
// once when the orchestrator starts.
registerRuntimeValidator(
  CAPABILITY_REFERENCES_BOUND_VALIDATOR_REF,
  capabilityReferencesBoundValidator,
);
