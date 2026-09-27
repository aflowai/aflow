import { z } from 'zod';
import type { OperationRegistration } from '../catalog/operationCatalog.js';

// ============================================================================
// artifact.inspect.list
// ============================================================================

export const ArtifactInspectTargetKindSchema = z.enum(['session', 'run', 'task']);
export type ArtifactInspectTargetKind = z.infer<typeof ArtifactInspectTargetKindSchema>;

export const ArtifactInspectListInputSchema = z.object({
  targetKind: ArtifactInspectTargetKindSchema,
  targetId: z.string().min(1).max(200),
});
export type ArtifactInspectListInput = z.infer<typeof ArtifactInspectListInputSchema>;

export const ArtifactInspectIndexEntrySchema = z
  .object({
    path: z.string().min(1).max(300),
    kind: z.enum(['summary', 'list', 'detail', 'payload', 'metric']),
    /** Best-effort byte-size estimate; absent when not cheaply known. */
    sizeBytes: z.number().int().nonnegative().optional(),
    /** Short prose hint describing what this slice contains. */
    summary: z.string().max(300),
  })
  .strict();
export type ArtifactInspectIndexEntry = z.infer<typeof ArtifactInspectIndexEntrySchema>;

export const ArtifactInspectListOutputSchema = z.object({
  targetKind: ArtifactInspectTargetKindSchema,
  targetId: z.string(),
  entries: z.array(ArtifactInspectIndexEntrySchema).max(100),
  /** Total bytes the index entries reference, when cheaply known. */
  totalSizeBytes: z.number().int().nonnegative().optional(),
});
export type ArtifactInspectListOutput = z.infer<typeof ArtifactInspectListOutputSchema>;

// ============================================================================
// artifact.inspect.read
// ============================================================================

export const ArtifactInspectReadInputSchema = z.object({
  targetKind: ArtifactInspectTargetKindSchema,
  targetId: z.string().min(1).max(200),
  /**
   * Stable path from the matching `artifact.inspect.list` call. Ad-hoc
   * paths are rejected — the handler validates the path matches the
   * documented vocabulary for the target kind.
   */
  path: z.string().min(1).max(300),
  /**
   * Optional sub-selector for structured payloads (e.g. `.failureReason`
   * for a task meta slice). When omitted, the full slice is returned.
   */
  selector: z.string().max(200).optional(),
  /**
   * Operator-tunable per-read cap; clamped by `coachEvidenceExploration
   * .maxBytesPerRead` on the directive side.
   */
  maxBytes: z.number().int().min(256).max(64_000).optional(),
});
export type ArtifactInspectReadInput = z.infer<typeof ArtifactInspectReadInputSchema>;

export const ArtifactInspectReadOutputSchema = z.object({
  targetKind: ArtifactInspectTargetKindSchema,
  targetId: z.string(),
  path: z.string(),
  /**
   * Content as a JSON-serializable value. The handler stringifies for
   * size accounting; the LLM sees the JSON shape directly.
   */
  content: z.unknown(),
  /** Byte size of the returned content (post-truncation). */
  sizeBytes: z.number().int().nonnegative(),
  /** True when the content was truncated to fit the byte cap. */
  truncated: z.boolean(),
});
export type ArtifactInspectReadOutput = z.infer<typeof ArtifactInspectReadOutputSchema>;

// ============================================================================

export const ArtifactInspectOperationRegistrations: OperationRegistration[] = [
  {
    stepType: 'artifact',
    group: 'inspect',
    verb: 'list',
    name: 'List Artifact Slices',
    actionLabel: 'Listing inspectable slices…',
    semanticDescription:
      'Coach run-reading: list the stable-path index for a session / run / task. ' +
      'Paths returned here are the only legal inputs to artifact.inspect.read. ' +
      'Read calls share a per-review budget capped by coachEvidenceExploration directives.',
    tags: ['artifact', 'inspect', 'coach'],
    groupDisplayName: 'Run Inspection',
    groupDescription:
      'Read-only inspection of run / task / session artifacts. Coach-only; the default way to read the run.',
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'List inspectable slices for a session / run / task.',
      whenToUse: [
        'The brief does not already pin the category',
        'Eval regression confirmed but the facts compiler could not attribute',
        'You need the actual run trace / task output to diagnose',
      ],
      whenNotToUse: ['The brief already pins the category — propose directly without reading'],
      pitfalls: [
        'Always list before reading — read rejects paths not in the listed index for that target',
        'Stale list output: a list call snapshots paths at call time; underlying state can shift',
      ],
      minimalExampleInput: {
        targetKind: 'run',
        targetId: '00000000-0000-0000-0000-000000000001',
      },
    },
    accessMode: 'read',
    inputZod: ArtifactInspectListInputSchema,
    outputZod: ArtifactInspectListOutputSchema,
  },
  {
    stepType: 'artifact',
    group: 'inspect',
    verb: 'read',
    name: 'Read Artifact Slice',
    actionLabel: 'Reading slice…',
    semanticDescription:
      'Read a single slice from the artifact.inspect.list index for a session / run / task. ' +
      'Paths must match the stable vocabulary documented on artifact.inspect.list — ad-hoc paths are rejected. ' +
      'Read counts against a per-review budget; per-read byte cap clamped by ' +
      'coachEvidenceExploration.maxBytesPerRead. Any proposal materially shaped by a read MUST cite the ' +
      'path via evidence.artifactRefs (enforced at validate-outcome).',
    tags: ['artifact', 'inspect', 'coach', 'plan-163'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'Read a stable-path slice of a session / run / task.',
      whenToUse: [
        'The list call surfaced a slice that may pin the failure category',
        "Inspecting a failed task's reflection or output payload",
      ],
      whenNotToUse: [
        'Path not in the prior list output — rejected',
        'Already exceeded per-review read cap — rejected',
      ],
      pitfalls: [
        'Selector strings are best-effort; missing selectors return the full slice',
        'Truncation: when the slice exceeds maxBytes, the response sets truncated=true',
        'Cite paths via evidence.artifactRefs when a read shapes a proposal',
      ],
      minimalExampleInput: {
        targetKind: 'run',
        targetId: '00000000-0000-0000-0000-000000000001',
        path: 'run/tasks/train-model/reflection',
      },
    },
    accessMode: 'read',
    inputZod: ArtifactInspectReadInputSchema,
    outputZod: ArtifactInspectReadOutputSchema,
  },
];
