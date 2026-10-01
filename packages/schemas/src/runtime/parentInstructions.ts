import { Buffer } from 'node:buffer';
import { z } from 'zod';

/**
 * Char budget for a single freeform-instructions string (run-level, or one
 * per-task entry's `text`). This channel is the primary design brief for
 * authoring workflows (e.g. compose-skill), not just a short nudge, so the
 * budget must hold a full specification. It is inlined into the Runner prompt
 * and stored on `workflow_runs.metadata.parentInstructions`, so it stays well
 * under the `inputs` 32 KB byte budget.
 */
export const MAX_INSTRUCTION_CHARS = 8000;

export const TaskTargetedInstructionsSchema = z.union([
  z.string().min(1).max(MAX_INSTRUCTION_CHARS),
  z
    .array(
      z.object({
        taskId: z.string().min(1).max(64),
        text: z.string().min(1).max(MAX_INSTRUCTION_CHARS),
      }),
    )
    .min(1)
    .max(20),
]);
export type TaskTargetedInstructions = z.infer<typeof TaskTargetedInstructionsSchema>;

/**
 * Canonical storage shape for the freeform-instructions channel as it
 * lives on `workflow_runs.metadata.parentInstructions`. The handler
 * normalises the discriminated-union input into this shape via
 * `normalizeInstructionsForStorage`:
 *
 *   - run-level string  → `{ runLevel: string }`
 *   - task-targeted []  → `{ taskTargeted: [...] }`
 *
 * Stored under `metadata.parentInstructions` so the key is self-describing
 * when the row is inspected manually. Reader: `taskHelpers.buildDelegateTaskInput`.
 */
export const StoredParentInstructionsSchema = z.union([
  z.object({ runLevel: z.string().min(1).max(MAX_INSTRUCTION_CHARS) }),
  z.object({
    taskTargeted: z
      .array(
        z.object({
          taskId: z.string().min(1).max(64),
          text: z.string().min(1).max(MAX_INSTRUCTION_CHARS),
        }),
      )
      .min(1)
      .max(20),
  }),
]);
export type StoredParentInstructions = z.infer<typeof StoredParentInstructionsSchema>;

const MAX_PARENT_INPUTS_KEYS = 20;
/** What a run's inputs may come to together, serialised — the most any one input can carry. */
export const MAX_PARENT_INPUTS_SERIALIZED_BYTES = 32 * 1024;

export const ParentInputsRecordSchema = z
  .record(z.unknown())
  .refine((v) => Object.keys(v).length <= MAX_PARENT_INPUTS_KEYS, {
    message: `inputs may have at most ${String(MAX_PARENT_INPUTS_KEYS)} keys. Group related values into a single nested object.`,
  })
  .refine(
    (v) => {
      try {
        // Phase 4 review fix (P2.2): `.length` on a JSON string counts
        // UTF-16 code units, not bytes. Non-ASCII (emoji, CJK, etc.)
        // would pass the guard while exceeding the byte budget that
        // protects metadata / inline Runner prompt payloads. Use
        // `Buffer.byteLength` to count the actual UTF-8 bytes.
        return Buffer.byteLength(JSON.stringify(v), 'utf8') <= MAX_PARENT_INPUTS_SERIALIZED_BYTES;
      } catch {
        // JSON.stringify throws on circular / BigInt values — reject loud.
        return false;
      }
    },
    {
      message:
        `inputs serialised payload exceeds ${String(MAX_PARENT_INPUTS_SERIALIZED_BYTES)} bytes (or is non-serialisable). ` +
        'A large value travels as a payload reference — pass the reference its producer returned ' +
        "(a commission's `patchRef`, for example), never the value itself.",
    },
  );
export type ParentInputsRecord = z.infer<typeof ParentInputsRecordSchema>;

export const StoredParentTaskInputsSchema = z
  .object({
    /** Workflow task id (NOT step execution id) whose typed slots this fills. */
    taskId: z.string().min(1).max(64),
    /** Keyed by `bindAs`. Validated at start; surfaced to the Runner verbatim. */
    inputs: ParentInputsRecordSchema,
  })
  .strict();
export type StoredParentTaskInputs = z.infer<typeof StoredParentTaskInputsSchema>;

/**
 * Narrow projection of `workflow_runs.metadata`. Reserved for known
 * platform-managed keys; arbitrary other keys are allowed (the column is
 * open by design). Use this when reading the column so the runtime treats
 * it as `unknown` everywhere else.
 */
export const WorkflowRunMetadataSchema = z
  .object({
    parentInstructions: StoredParentInstructionsSchema.optional(),
    parentTaskInputs: StoredParentTaskInputsSchema.optional(),
    /**
     * Where the run sits in a chain of runs started by workflow tasks: one more
     * than the run whose task started it. Absent on a run nothing but a
     * conversation or an operator started, which is depth 1.
     */
    runDepth: z.number().int().min(2).optional(),
  })
  .passthrough();
export type WorkflowRunMetadata = z.infer<typeof WorkflowRunMetadataSchema>;

/**
 * The deepest a chain of task-started runs may reach, counting the run at its
 * head as 1. A publication and the review it starts of its own commit are two;
 * nothing a task starts needs a third, and without a bound a workflow that
 * starts itself would never stop.
 */
export const MAX_WORKFLOW_RUN_DEPTH = 2;

export function workflowRunDepth(metadata: unknown): number {
  const parsed = WorkflowRunMetadataSchema.safeParse(metadata ?? {});
  return parsed.success ? (parsed.data.runDepth ?? 1) : 1;
}

/**
 * Normalise the discriminated-union input into the canonical stored shape.
 * Exported so the start handler and any future caller (resume
 * `re_execute`, `provide_input`) share the same converter.
 */
export function normalizeInstructionsForStorage(
  instructions: TaskTargetedInstructions,
): StoredParentInstructions {
  if (typeof instructions === 'string') {
    return { runLevel: instructions };
  }
  return { taskTargeted: instructions };
}

export const TaskTargetedInstructionsJsonSchema = {
  oneOf: [
    {
      type: 'string',
      minLength: 1,
      maxLength: MAX_INSTRUCTION_CHARS,
      description:
        `Run-level instructions — shown to every task in the run. Up to ${String(MAX_INSTRUCTION_CHARS)} characters. ` +
        'For a longer brief, split it into the per-task array form (each task gets its own slice), ' +
        'or stage the detail via memory.store and reference it here.',
    },
    {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      description:
        'Per-task targeted instructions — each entry is shown only to the task whose taskId matches.',
      items: {
        type: 'object',
        required: ['taskId', 'text'],
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', minLength: 1, maxLength: 64 },
          text: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_INSTRUCTION_CHARS,
            description: `This task's instructions — up to ${String(MAX_INSTRUCTION_CHARS)} characters.`,
          },
        },
      },
    },
  ],
} as const;
