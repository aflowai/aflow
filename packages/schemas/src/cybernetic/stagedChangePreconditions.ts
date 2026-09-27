import { z } from 'zod';

// ============================================================================
// Target descriptor
// ============================================================================

/**
 * A `TargetDescriptor` names the smallest addressable subtree of a workflow
 * or eval suite that a single StagedChangeOp reads-and-mutates.
 *
 * `kind: 'none'` is reserved for ops that have no preconditions (purely
 * informational ops, kinds dispatched by dedicated handlers, etc.). It keeps
 * the per-op `preconditions[]` array 1:1 with the proposal's `ops[]`.
 */
export const TargetDescriptorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task.goal'), taskId: z.string() }).strict(),
  z.object({ kind: z.literal('task.context'), taskId: z.string() }).strict(),
  z.object({ kind: z.literal('task.dependencies'), taskId: z.string() }).strict(),
  z.object({ kind: z.literal('task.whole'), taskId: z.string() }).strict(),
  z.object({ kind: z.literal('task.absent'), taskId: z.string() }).strict(),
  z.object({ kind: z.literal('tasks.order') }).strict(),
  z.object({ kind: z.literal('outcome.threshold'), outcomeId: z.string() }).strict(),
  z.object({ kind: z.literal('activation.hint') }).strict(),
  z.object({ kind: z.literal('activation.trigger.absent'), pattern: z.string() }).strict(),
  z.object({ kind: z.literal('iteration') }).strict(),
  z.object({ kind: z.literal('workflow.status') }).strict(),
  z.object({ kind: z.literal('workflow.contract') }).strict(),
  z.object({ kind: z.literal('manifest.goal') }).strict(),
  z.object({ kind: z.literal('manifest.campaign.field'), fieldKey: z.string() }).strict(),
  z.object({ kind: z.literal('manifest.campaign.field.absent'), fieldKey: z.string() }).strict(),
  z
    .object({
      kind: z.literal('eval.criterion.byName'),
      skillSlug: z.string(),
      name: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('eval.criterion.absent'),
      skillSlug: z.string(),
      name: z.string(),
      scope: z.enum(['goal', 'trajectory', 'task']),
      taskId: z.string().optional(),
    })
    .strict(),
  z.object({ kind: z.literal('none') }).strict(),
]);

export type TargetDescriptor = z.infer<typeof TargetDescriptorSchema>;

// ============================================================================
// Precondition entry + present-sentinel
// ============================================================================

/**
 * Sentinel used in `targetHash` for an absent-target descriptor (e.g.
 * `task.absent`) whose target is unexpectedly **present** at hash time.
 * The runtime emits this so the next conflict check sees a hash mismatch
 * vs. `null` (which means "still absent — precondition holds"). Exported
 * so the runtime and any downstream consumer share one source of truth
 * instead of duplicating the magic string.
 */
export const TARGET_HASH_PRESENT_SENTINEL = '__present__' as const;

/**
 * One precondition entry per op in `proposal.ops`. `targetHash` is one of:
 *   - 64-char lowercase hex SHA-256 of the canonical-JSON subtree at
 *     proposal-creation time (the normal hash case);
 *   - `null` — for absent-target descriptors when the target is still
 *     absent (the precondition holds);
 *   - `TARGET_HASH_PRESENT_SENTINEL` — for absent-target descriptors when
 *     the target is currently present (precondition broken, conflict
 *     should fire on detect).
 * `kind: 'none'` descriptors always carry `targetHash: null`.
 */
export const PreconditionEntrySchema = z
  .object({
    opIndex: z.number().int().nonnegative(),
    descriptor: TargetDescriptorSchema,
    targetHash: z
      .union([z.string().regex(/^[0-9a-f]{64}$/), z.literal(TARGET_HASH_PRESENT_SENTINEL)])
      .nullable(),
  })
  .strict();

export type PreconditionEntry = z.infer<typeof PreconditionEntrySchema>;

// ============================================================================
// Rebase state + conflict detail
// ============================================================================

export const RebaseStateSchema = z.enum(['clean', 'stale']);
export type RebaseState = z.infer<typeof RebaseStateSchema>;

/**
 * Conflict detail for a single op whose precondition no longer holds.
 * `currentHash` of `null` means the target subtree is now absent (e.g.,
 * the task was removed by a sibling ratification).
 */
export const PreconditionConflictSchema = z
  .object({
    opIndex: z.number().int().nonnegative(),
    opKind: z.string().max(120),
    descriptor: TargetDescriptorSchema,
    pinnedHash: z.string().nullable(),
    currentHash: z.string().nullable(),
  })
  .strict();

export type PreconditionConflict = z.infer<typeof PreconditionConflictSchema>;
