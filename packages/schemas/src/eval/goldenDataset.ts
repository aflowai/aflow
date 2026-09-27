/**
 * Golden dataset — a versioned, per-skill collection of golden cases
 * (Plan 269 Part 1). Identity `(spaceId, workflowSlug)`; `datasetVersion`
 * tracks dataset CONTENT only and is fully orthogonal to skill revisions —
 * the instrument works by holding the dataset fixed while the skill varies.
 */
import { z } from 'zod';
import { GoldenCaseSchema } from './goldenCase.js';

export const GoldenDatasetSchema = z.object({
  datasetId: z.string().uuid(),
  spaceId: z.string().uuid(),
  workflowSlug: z.string().min(1).max(128),
  /** Monotonic; bumped by every case add/edit/remove, never by skill edits. */
  datasetVersion: z.number().int().nonnegative(),
});
export type GoldenDataset = z.infer<typeof GoldenDatasetSchema>;

/** An unreviewed `draft` never enters an active dataset version (D14). */
export const GoldenCaseRevisionStatusSchema = z.enum(['draft', 'active']);
export type GoldenCaseRevisionStatus = z.infer<typeof GoldenCaseRevisionStatusSchema>;

/**
 * Immutable revision row: every case add/edit/remove creates one and bumps
 * `datasetVersion`. The validity interval is
 * `addedInVersion <= v` and (`removedInVersion` unset or `> v`) —
 * closing the interval on the superseded revision is the single permitted
 * mutation.
 *
 * Draft revisions sit outside the interval math: they record the dataset
 * version current at drafting/discard, which is 0 on a fresh dataset (a
 * promotion may create the dataset itself). Only active revisions carry the
 * bumped-version invariant.
 */
export const GoldenCaseRevisionSchema = z
  .object({
    revisionId: z.string().uuid(),
    caseId: z.string().uuid(),
    datasetId: z.string().uuid(),
    addedInVersion: z.number().int().nonnegative(),
    removedInVersion: z.number().int().nonnegative().optional(),
    status: GoldenCaseRevisionStatusSchema,
    case: GoldenCaseSchema,
  })
  .superRefine((revision, ctx) => {
    if (revision.status !== 'active') return;
    for (const field of ['addedInVersion', 'removedInVersion'] as const) {
      const value = revision[field];
      if (value !== undefined && value < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: 'An active revision only ever enters or leaves at a bumped version (>= 1).',
        });
      }
    }
  });
export type GoldenCaseRevision = z.infer<typeof GoldenCaseRevisionSchema>;

// ============================================================================
// Version reconstruction
// ============================================================================

/** Structural subset shared by `GoldenCaseRevision` and the DB row shape. */
export interface CaseRevisionInterval {
  revisionId: string;
  caseId: string;
  addedInVersion: number;
  removedInVersion?: number | null | undefined;
  status: string;
}

/**
 * Whether one revision is live at a version. Separate from the resolver below
 * because a caller that only needs the interval must not inherit its throw:
 * the overlap check protects a batch from running a case twice, and refusing
 * an unrelated read over it is how a single bad row takes a whole dataset down.
 */
export function isLiveAtVersion(revision: CaseRevisionInterval, version: number): boolean {
  return (
    revision.status === 'active' &&
    revision.addedInVersion <= version &&
    (revision.removedInVersion === null ||
      revision.removedInVersion === undefined ||
      revision.removedInVersion > version)
  );
}

/**
 * The live case-revision set at a historical `datasetVersion`, from validity
 * intervals. Draft revisions never resolve. Throws on a corrupt interval set
 * (two live revisions of one case at the same version) — a batch must never
 * silently run a case twice or pick one arbitrarily.
 */
export function resolveDatasetVersion<T extends CaseRevisionInterval>(
  caseRevisions: readonly T[],
  version: number,
): T[] {
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(
      `resolveDatasetVersion: version must be a non-negative integer, got ${String(version)}`,
    );
  }
  const live = caseRevisions.filter((revision) => isLiveAtVersion(revision, version));
  const seen = new Map<string, string>();
  for (const revision of live) {
    const other = seen.get(revision.caseId);
    if (other !== undefined) {
      throw new Error(
        `resolveDatasetVersion: case ${revision.caseId} has two live revisions at version ${String(version)} ` +
          `(${other}, ${revision.revisionId}) — validity intervals overlap`,
      );
    }
    seen.set(revision.caseId, revision.revisionId);
  }
  return live;
}
