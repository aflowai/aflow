import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { SkillDiagnostic, SkillValidityStatus } from '@aflow/schemas';

// ============================================================================
// Activation (pure)
// ============================================================================

export interface ValidityCoachActivation {
  activate: true;
  source: 'validity_signal';
  reason: string;
}

export interface ValidityCoachTriggerInput {
  /** The blocking (`severity: 'error'`) set from the verdict. */
  diagnostics: SkillDiagnostic[];
  /**
   * An unresolved (`status: 'proposed'`) `workflow_refinement` proposal
   * already targets this skill — the repair is in flight; don't re-activate.
   */
  openRepairProposal: boolean;
  /**
   * This diagnostic set already fired an activation that hasn't resolved
   * (pending-repair fingerprint match) — covers the window between the
   * activation and the Coach actually filing its proposal.
   */
  pendingRepairActivation: boolean;
}

export function checkValidityCoachActivation(
  input: ValidityCoachTriggerInput,
): ValidityCoachActivation | null {
  if (input.diagnostics.length === 0) return null;
  if (input.openRepairProposal) return null;
  if (input.pendingRepairActivation) return null;
  return {
    activate: true,
    source: 'validity_signal',
    reason: `contract invalid (${String(input.diagnostics.length)} diagnostics): ${formatDiagnosticCodes(input.diagnostics)}`,
  };
}

/** Compact `code@taskId.field` listing for the activation reason string. */
function formatDiagnosticCodes(diagnostics: readonly SkillDiagnostic[]): string {
  return diagnostics
    .map((d) => {
      const at = d.taskId ? `@${d.taskId}${d.field ? `.${d.field}` : ''}` : '';
      return `${d.code}${at}`;
    })
    .join(', ');
}

// ============================================================================
// Reconciler transition seam (pure)
// ============================================================================

export function shouldFireValidityTransition(
  prior: SkillValidityStatus | undefined,
  next: SkillValidityStatus,
): boolean {
  return prior === 'valid' && next === 'invalid';
}

/**
 * The repair landed (or the rules drifted back): the verdict flipped
 * `invalid → valid`, so the pending-repair fingerprints for this skill are
 * stale and must clear — a future re-break with the SAME diagnostic set must
 * be able to activate again.
 */
export function shouldClearValidityRepairState(
  prior: SkillValidityStatus | undefined,
  next: SkillValidityStatus,
): boolean {
  return prior === 'invalid' && next === 'valid';
}

// ============================================================================

/**
 * Stable fingerprint over the diagnostic IDENTITY set (code / dimension /
 * taskId / field / producerTaskId / operationId), order-insensitive and
 * prose-insensitive (`detail` / `fixHint` are excluded — they may vary across
 * recomputes of the same break). Mirrors `computeProposalFingerprint` (163
 * §4.2): canonical-JSON each identity tuple, join with '|', prefix the slug —
 * entry boundaries stay unambiguous because JSON escapes its delimiters.
 */
export function computeValidityRepairFingerprint(
  workflowSlug: string,
  diagnostics: readonly SkillDiagnostic[],
): string {
  const identity = diagnostics
    .map((d) =>
      JSON.stringify([
        d.code,
        d.dimension,
        d.taskId ?? '',
        d.field ?? '',
        d.producerTaskId ?? '',
        d.operationId ?? '',
      ]),
    )
    .sort()
    .join('|');
  return createHash('sha256').update(`${workflowSlug}:${identity}`).digest('hex');
}

function pendingRepairKey(spaceId: string): string {
  return `cybernetic:pending-repair-fingerprints:${spaceId}`;
}

function pendingRepairMember(workflowSlug: string, fingerprint: string): string {
  return `${workflowSlug}:${fingerprint}`;
}

/**
 * Check whether this diagnostic set already fired an unresolved activation.
 * Mirrors `checkDuplicateFingerprint` (163 §4.2); `windowMs` is the existing
 * `learningPolicy.rejectedFingerprintWindow` knob — the same retention the
 * rejected-fingerprint dedup uses (and the proposal-expiry horizon), so an
 * abandoned activation can re-fire once the window lapses.
 */
export async function checkPendingRepairFingerprint(
  redis: Redis,
  spaceId: string,
  workflowSlug: string,
  fingerprint: string,
  windowMs: number,
): Promise<boolean> {
  const key = pendingRepairKey(spaceId);
  const cutoff = Date.now() - windowMs;
  await redis.zremrangebyscore(key, '-inf', cutoff);
  const score = await redis.zscore(key, pendingRepairMember(workflowSlug, fingerprint));
  return score !== null;
}

/** Record a fired validity activation's diagnostic-set fingerprint as pending. */
export async function recordPendingRepairFingerprint(
  redis: Redis,
  spaceId: string,
  workflowSlug: string,
  fingerprint: string,
  firedAt: number,
  windowMs: number,
): Promise<void> {
  const key = pendingRepairKey(spaceId);
  const pipeline = redis.pipeline();
  pipeline.zadd(key, firedAt, pendingRepairMember(workflowSlug, fingerprint));
  pipeline.zremrangebyscore(key, '-inf', Date.now() - windowMs);
  await pipeline.exec();
}

/**
 * Clear every pending-repair fingerprint for a skill — called on the
 * reconciler's `invalid → valid` transition (the repair landed).
 */
export async function clearPendingRepairFingerprints(
  redis: Redis,
  spaceId: string,
  workflowSlug: string,
): Promise<void> {
  const key = pendingRepairKey(spaceId);
  const members = await redis.zrange(key, 0, -1);
  const prefix = `${workflowSlug}:`;
  const stale = members.filter((m) => m.startsWith(prefix));
  if (stale.length > 0) {
    await redis.zrem(key, ...stale);
  }
}

// ============================================================================

/**
 * The repair-intent prompt head for a `validity_signal` review. Replaces the
 * run-review head: there is no run to grade — evidence is the structured
 * diagnostics plus the live config read via `workflow.manage.get` (which
 * recomputes the verdict). Diagnostics are rendered as verbatim JSON so the
 * Coach can copy them into `evidence.validityDiagnostics` unchanged.
 */
export function buildValidityRepairPromptParts(params: {
  workflowSlug: string;
  diagnostics: readonly SkillDiagnostic[];
  reason: string;
}): string[] {
  return [
    `Repair skill "${params.workflowSlug}" — its contract verdict is INVALID and new runs are blocked.`,
    `Trigger: validity_signal — ${params.reason}.`,
    'This is a STRUCTURAL repair review, not a performance review: the validity membrane diagnosed the break; your job is the patch.',
    '',
    'Blocking diagnostics (SkillDiagnostic[], verbatim):',
    JSON.stringify(params.diagnostics, null, 2),
    '',
    'Steps:',
    '1. Read the live config with workflow.manage.get — its response carries the recomputed verdict.',
    '2. Propose ONE workflow_refinement patch via learner.propose.workflow_change that clears every diagnostic. Patch the live config in place; reinstall is never the fix.',
    '3. Copy the diagnostics above verbatim into evidence.validityDiagnostics — a blocked skill has no run digest; the diagnostics ARE the evidence.',
    '4. If the propose call rejects your patch, use the diagnostics it returns to fix the patch and retry in this session.',
  ];
}
