import { z } from 'zod';
import { TaskContextSpecSchema } from '../../cybernetic/context.js';
import { getSnoozeMinMs } from '../../schedules/operations.js';
import { WorkflowTaskInputBindingSchema } from './taskBindings.js';
import { WorkflowTaskOutputPromotionSchema } from './taskBindings.js';
import {
  OnContractFailureSchema,
  TaskInputContractSchema,
  WorkflowTaskOutputPortSchema,
} from './taskContract.js';
import { WorkflowHumanActionPreviewSchema, WorkflowHumanFailureModeSchema } from './taskHuman.js';
import {
  analyzeInputTemplate,
  TEMPLATE_BIND_KEY,
  WorkflowTaskInputTemplateSchema,
} from './taskTemplate.js';
import { listRegisteredValidatorNames } from '../../runtime/validatorRegistry.js';

// ============================================================================

/**
 * One comparison expression in the shared predicate grammar. Single
 * comparison only — combinators are JSON-level (`anyOf` / `allOf` arrays),
 * never embedded in the string.
 */
const PredicateExpressionSchema = z.string().min(1).max(500);

const PredicateExpressionListSchema = z.array(PredicateExpressionSchema).min(1).max(10);

const OnMissingRefSchema = z
  .enum(['skip', 'error'])
  .default('skip')
  .describe(
    "Behavior when the expression references a task that has not completed successfully: 'skip' (default) skips this task, 'error' fails the run.",
  );

/**
 * A storage ceiling for the prose an operator reads at a pause, not a style
 * guide: an approval that names what is about to happen, what can be checked
 * first and what declining leaves behind runs to several paragraphs.
 */
export const PAUSE_INSTRUCTION_MAX_CHARS = 4000;

export const WorkflowWhenSchema = z.union([
  z
    .object({
      /** Expression evaluated against the run-scoped task-output namespace. */
      expression: PredicateExpressionSchema,
      onMissingRef: OnMissingRefSchema,
    })
    .strict(),
  z
    .object({
      /** Passes when ANY listed comparison evaluates true. */
      anyOf: PredicateExpressionListSchema,
      onMissingRef: OnMissingRefSchema,
    })
    .strict(),
  z
    .object({
      /** Passes when ALL listed comparisons evaluate true. */
      allOf: PredicateExpressionListSchema,
      onMissingRef: OnMissingRefSchema,
    })
    .strict(),
]);
export type WorkflowWhen = z.infer<typeof WorkflowWhenSchema>;

/**
 * Structural predicate shape shared by `when` (task conditional) and
 * `poll.until` (poll exit condition). `onMissingRef` is `when`-only —
 * for `until`, a missing path is always "condition unmet" (§4.2).
 */
export type PredicateSpec = { expression: string } | { anyOf: string[] } | { allOf: string[] };

/** The expressions a predicate evaluates, regardless of combinator. */
export function predicateExpressions(predicate: PredicateSpec): string[] {
  if ('expression' in predicate) return [predicate.expression];
  if ('anyOf' in predicate) return predicate.anyOf;
  return predicate.allOf;
}

/** Which combinator a predicate uses. */
export function predicateCombinator(predicate: PredicateSpec): 'expression' | 'anyOf' | 'allOf' {
  if ('expression' in predicate) return 'expression';
  if ('anyOf' in predicate) return 'anyOf';
  return 'allOf';
}

/**
 * Canonical key for structural predicate equality (combinator + ordered
 * expression list). Used by the conditional-absence lockstep check — two
 * tasks are guarded "in lockstep" iff their predicate keys match.
 */
export function predicateKey(predicate: PredicateSpec): string {
  return `${predicateCombinator(predicate)}:${predicateExpressions(predicate).join(' || ')}`;
}

/** Human-readable rendering of a predicate for diagnostics. */
export function describePredicate(predicate: PredicateSpec): string {
  const exprs = predicateExpressions(predicate);
  const combinator = predicateCombinator(predicate);
  if (combinator === 'expression') return exprs[0] ?? '';
  return `${combinator}(${exprs.join('; ')})`;
}

/**
 * Display projection of a `when` guard, shared by the Skill Designer and the
 * workflow-run surface so both render the same compacted clauses. A schema
 * (not just a type) because the run-detail graph hint embeds it.
 */
export const WorkflowWhenViewSchema = z.object({
  mode: z.enum(['single', 'any', 'all']),
  /** One comparison per entry, with the leading `tasks.` namespace stripped. */
  clauses: z.array(z.string().max(500)).min(1).max(10),
  onMissingRef: z.enum(['skip', 'error']),
});
export type WorkflowWhenView = z.infer<typeof WorkflowWhenViewSchema>;

/**
 * Only the namespace prefix is stripped — `status` / `output.` segments must
 * survive, or a task-status guard becomes indistinguishable from a guard on
 * an output field that happens to be named `status`.
 */
function displayClause(expression: string): string {
  return expression.trim().replace(/^tasks\./, '');
}

export function workflowWhenView(when: WorkflowWhen): WorkflowWhenView {
  const combinator = predicateCombinator(when);
  return {
    mode: combinator === 'allOf' ? 'all' : combinator === 'anyOf' ? 'any' : 'single',
    clauses: predicateExpressions(when).map(displayClause),
    onMissingRef: when.onMissingRef,
  };
}

// ============================================================================

/**
 * Platform-reserved key the harness stamps into the task output of a polled
 * task at terminal completion: `{ cycles, exhausted, conditionMet }`.
 * Stamped into the OUTPUT (not row metadata) because downstream consumption
 * happens through `task_output` bindings, which read outputs only. Graph
 * validation rejects an `outputContract.schema` that declares its own
 * `_poll` on a polled task.
 */
export const POLL_RESERVED_OUTPUT_KEY = '_poll';

/**
 * Poll exit condition — same grammar as `when` but WITHOUT `onMissingRef`:
 * `until` resolution failure (path missing on the raw output) always counts
 * as "condition unmet", never as task failure — polling a not-yet-populated
 * field is the normal case. Expressions reference THIS task's raw op output
 * via `output.<field>` (e.g. `"output.status == 'COMPLETE'"`).
 */
export const WorkflowPollUntilSchema = z.union([
  z.object({ expression: PredicateExpressionSchema }).strict(),
  z.object({ anyOf: PredicateExpressionListSchema }).strict(),
  z.object({ allOf: PredicateExpressionListSchema }).strict(),
]);
export type WorkflowPollUntil = z.infer<typeof WorkflowPollUntilSchema>;

export const WorkflowTaskPollSchema = z
  .object({
    /**
     * Wait between cycles, in milliseconds. Author-set — no platform
     * default. Must be at least the platform snooze minimum.
     */
    intervalMs: z.number().int().positive(),
    maxCycles: z.number().int().min(1).max(20),
    /** Exit condition, evaluated against the raw op output after each cycle. */
    until: WorkflowPollUntilSchema,
    /**
     * What happens when `maxCycles` is exhausted without `until` being met.
     * `'complete'` (default): the task completes with the LAST raw op
     * output plus the reserved `_poll` stamp (`exhausted: true`) —
     * downstream consumers read the real last response, not a synthesized
     * timeout enum. `'fail'`: for chains where proceeding without the
     * condition is meaningless.
     */
    onExhausted: z.enum(['complete', 'fail']).default('complete'),
  })
  .strict()
  .superRefine((poll, ctx) => {
    const minMs = getSnoozeMinMs();
    if (poll.intervalMs < minMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `poll.intervalMs must be at least the platform minimum of ${String(minMs)}ms.`,
        path: ['intervalMs'],
      });
    }
  });
export type WorkflowTaskPoll = z.infer<typeof WorkflowTaskPollSchema>;

// ============================================================================

/**
 * Ordered parse pipeline steps for a projection field. Application order is
 * FIXED regardless of authoring order: `json` → `select` → `number`
 * (the schema rejects `['number','json']` so the written order always
 * matches the applied order).
 */
export const WorkflowTaskProjectionParseSchema = z.enum(['json', 'number']);
export type WorkflowTaskProjectionParse = z.infer<typeof WorkflowTaskProjectionParseSchema>;

const ProjectionPathSchema = z
  .string()
  .min(1)
  .max(256)
  .describe(
    "Shared output-path dialect: dot-separated keys with [n] array indexing, e.g. 'content[0].text'.",
  );

/**
 * One projected field sourced from the RAW op output. Pipeline:
 * read `path` → (`parse: 'json'`: JSON.parse a string value) →
 * (`select`: path into the parsed value) → (`parse: 'number'`: coerce a
 * numeric string). Any unresolvable step fails per `onMissing`.
 */
const WorkflowTaskProjectionPathFieldSchema = z
  .object({
    /** Path into the raw op output (shared dialect, `[n]` indexing). */
    path: ProjectionPathSchema,
    /** Ordered parse pipeline (applied around select: json → select → number). */
    parse: z.array(WorkflowTaskProjectionParseSchema).min(1).max(2).optional(),
    /** Path into the JSON-parsed value — requires 'json' in parse. */
    select: ProjectionPathSchema.optional(),
    /**
     * Failure mode when the field cannot be resolved at terminal completion:
     * 'error' (default) → structured PROJECTION_FAILED naming field + path;
     * 'null' → field set to null (legitimately-absent terminal values —
     * the outputContract must type the field nullable).
     */
    onMissing: z.enum(['error', 'null']).default('error'),
  })
  .strict()
  .superRefine((field, ctx) => {
    const parse = field.parse ?? [];
    if (new Set(parse).size !== parse.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'parse steps must be unique.',
        path: ['parse'],
      });
    }
    if (parse.length === 2 && (parse[0] !== 'json' || parse[1] !== 'number')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "parse pipeline order is fixed: json → select → number. Write ['json','number'].",
        path: ['parse'],
      });
    }
  })
  // `select` indexes into a JSON-parsed value, so it implies a prior `json`
  // parse — default it in rather than rejecting (the rule lives in the default,
  // not an error the author must learn). A genuinely-wrong `select` (on a value
  // that is already an object) still fails at runtime with a real type error.
  .transform((field) => {
    if (field.select !== undefined && !(field.parse ?? []).includes('json')) {
      const rest = (field.parse ?? []).filter((p) => p !== 'json');
      return { ...field, parse: ['json', ...rest] as WorkflowTaskProjectionParse[] };
    }
    return field;
  });

/** Echo a resolved input (bindAs name or literal inputs key) into the output. */
const WorkflowTaskProjectionInputFieldSchema = z
  .object({
    /** Name of a declared inputBindings entry (or literal inputs key) to echo. */
    fromInput: z.string().min(1).max(64),
  })
  .strict();

export const WorkflowTaskOutputProjectionFieldSchema = z.union([
  WorkflowTaskProjectionPathFieldSchema,
  WorkflowTaskProjectionInputFieldSchema,
]);
export type WorkflowTaskOutputProjectionField = z.infer<
  typeof WorkflowTaskOutputProjectionFieldSchema
>;

export const WorkflowTaskOutputProjectionSchema = z.record(
  z.string().min(1).max(64),
  WorkflowTaskOutputProjectionFieldSchema,
);
export type WorkflowTaskOutputProjection = z.infer<typeof WorkflowTaskOutputProjectionSchema>;

// ============================================================================
// Task Schema
// ============================================================================

const TaskDispatchFamilyRefine = (
  task: {
    type?: 'agent' | 'operation' | 'human' | undefined;
    agent?: string | undefined;
    operation?: string | undefined;
    pauseInstruction?: string | undefined;
    intent?: 'collect' | 'approve' | undefined;
    outputContract?: { schema?: Record<string, unknown> | undefined } | undefined;
    poll?: unknown;
    outputProjection?: unknown;
    inputTemplate?: unknown;
  },
  ctx: z.RefinementCtx,
): void => {
  // Resolve effective family — explicit `type` wins; otherwise infer from set fields.
  let resolved: 'agent' | 'operation' | 'human' | 'ambiguous' | 'undeclared';
  if (task.type) {
    resolved = task.type;
  } else {
    const present = [
      task.agent ? 'agent' : null,
      task.operation ? 'operation' : null,
      task.pauseInstruction ? 'human' : null,
    ].filter((x): x is string => x !== null);
    if (present.length === 0) resolved = 'undeclared';
    else if (present.length === 1) resolved = present[0] as 'agent' | 'operation' | 'human';
    else resolved = 'ambiguous';
  }

  if (resolved === 'undeclared') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'Task is missing a dispatch family. Set type to "agent" | "operation" | "human", ' +
        'or provide one of: agent, operation, pauseInstruction.',
      path: ['type'],
    });
    return;
  }

  if (resolved === 'ambiguous') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'Task has an ambiguous dispatch family. Exactly one of agent, operation, pauseInstruction must be set, ' +
        'or set type explicitly.',
      path: ['type'],
    });
    return;
  }

  // Family-specific invariants.
  if (resolved === 'human') {
    if (!task.pauseInstruction) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Human tasks require a non-empty pauseInstruction.',
        path: ['pauseInstruction'],
      });
    }
    if (task.agent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Human tasks must not specify an agent.',
        path: ['agent'],
      });
    }
    if (task.operation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Human tasks must not specify an operation.',
        path: ['operation'],
      });
    }
    if (task.intent === 'approve' && task.outputContract?.schema) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Human approval tasks (intent="approve") must not declare a custom outputContract.schema — ' +
          'the platform fixes the output shape to { decision: "approved" | "rejected", comment?: string }.',
        path: ['outputContract', 'schema'],
      });
    }
  } else if (resolved === 'operation') {
    if (!task.operation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Operation tasks require a non-empty operation id.',
        path: ['operation'],
      });
    }
    if (task.agent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Operation tasks must not specify an agent.',
        path: ['agent'],
      });
    }
    if (task.pauseInstruction) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Operation tasks must not specify a pauseInstruction.',
        path: ['pauseInstruction'],
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- keep explicit family branch for readability
  } else if (resolved === 'agent') {
    // `agent` is allowed to be omitted — execution falls back to
    // workflow.assignedAgent and then cybernetic-runner.
    if (task.operation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Agent tasks must not specify an operation.',
        path: ['operation'],
      });
    }
    if (task.pauseInstruction) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Agent tasks must not specify a pauseInstruction.',
        path: ['pauseInstruction'],
      });
    }
  }

  if (task.intent !== undefined && resolved !== 'human') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'intent is only valid on human tasks (type="human").',
      path: ['intent'],
    });
  }

  if (task.poll !== undefined && resolved !== 'operation') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'poll is only valid on operation tasks (type="operation").',
      path: ['poll'],
    });
  }

  if (task.outputProjection !== undefined && resolved !== 'operation') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'outputProjection is only valid on operation tasks (type="operation").',
      path: ['outputProjection'],
    });
  }

  if (task.inputTemplate !== undefined && resolved !== 'operation') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'inputTemplate is only valid on operation tasks (type="operation").',
      path: ['inputTemplate'],
    });
  }
};

// ============================================================================

/**
 * Reserved `DerivedFromBinding.from` source: the binding evaluates against
 * the run's campaign config instead of an upstream task's output. This is
 * how a campaign-contract cap becomes a structural constraint on a task's
 * output schema (e.g. `value:$.maxPositionSizePct` → `…sizePct.maximum`).
 */
export const DERIVED_FROM_CAMPAIGN_SOURCE = '$campaign';

export const DerivedFromBindingSchema = z
  .object({
    /**
     * Stable identifier within the task, used for attribution, evidence,
     * and Coach pattern flags. Must be unique per task.
     */
    bindingId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9-]*[a-z0-9]$/, {
        message: 'bindingId must match /^[a-z][a-z0-9-]*[a-z0-9]$/ (kebab-case)',
      }),

    /**
     * Upstream task whose output drives this binding. Must appear in the
     * downstream task's transitive `dependsOn` (validated at workflow load).
     * The reserved value `$campaign` ({@link DERIVED_FROM_CAMPAIGN_SOURCE})
     * evaluates the binding against the run's campaign config instead.
     */
    from: z.string().min(1).max(64),

    binding: z.string().regex(/^(enum|value|count):.+$/, {
      message: 'binding must be "enum:<jsonpath>", "value:<jsonpath>", or "count:<jsonpath>"',
    }),

    /**
     * Where the patch lands in the downstream schema, expressed in the
     * "logical mixed" form: data-path-style segments are auto-prefixed with
     * `properties` by the merger; JSON Schema keywords (`enum`, `const`,
     * `propertyNames`, `minimum`, `maximum`, etc.) are used literally.
     *
     * Example: `$.evalSuite.taskCriteria.propertyNames.enum`
     *   → walks to `properties.evalSuite.properties.taskCriteria.propertyNames.enum`
     */
    target: z.string().min(1).max(256),

    /**
     * Optional documentation: which task is the human-readable subject of
     * the constraint. Default: this task (the host). Documentation only —
     * no execution effect.
     */
    constraintSubject: z.string().min(1).max(64).optional(),

    /**
     * Reserved for future redaction logic. Phase A reserves the field but
     * does not implement redaction; no Phase A binding sets `sensitive: true`.
     */
    sensitive: z.boolean().optional(),

    /** Optional human comment for the workflow inspector. */
    note: z.string().max(280).optional(),
  })
  .strict();

export type DerivedFromBinding = z.infer<typeof DerivedFromBindingSchema>;

export const WorkflowTaskSchema = z
  .object({
    taskId: z.string().min(1).max(64),
    name: z.string().min(1).max(120),
    // System-authored cybernetic workflows (compose-skill, bind-capability) use
    // `goal` as the runner's full system prompt — already past 4000 chars
    goal: z.string().min(1).max(12000),

    agent: z.string().optional(),
    operation: z.string().optional(),

    inputs: z.record(z.unknown()).optional(),
    dependsOn: z.array(z.string().max(64)).optional(),
    metrics: z.array(z.string().min(1).max(64)).optional(),
    optional: z.boolean().optional(),
    retryCount: z.number().int().min(0).max(5).optional(),

    /** Task type discriminator — inferred from `agent`/`operation` if omitted. */
    type: z.enum(['agent', 'operation', 'human']).optional(),

    /** Instruction shown when a human task pauses the workflow for input. */
    pauseInstruction: z.string().max(PAUSE_INSTRUCTION_MAX_CHARS).optional(),

    intent: z.enum(['collect', 'approve']).optional(),

    actionPreview: WorkflowHumanActionPreviewSchema.optional(),

    /**
     * TaskIds whose output this approval gate reviews. Lowered from the
     * draft's `approves[]` field by assembleWorkflow — also contributes to
     * dependsOn. Persisted here so the UI can display "Reviewing output of:
     * <task names>" in the action center without re-reading the graph.
     */
    approves: z.array(z.string().max(64)).optional(),

    failureMode: WorkflowHumanFailureModeSchema.default('isolate').optional(),

    retryability: z.enum(['safe', 'unsafe', 'unknown']).optional(),

    maxAttempts: z.number().int().min(1).max(10).optional(),

    /** Declares what the task produces — expected metrics, artifact descriptions, and optional JSON Schema for structured output validation. */
    outputContract: z
      .object({
        metrics: z.record(z.string().max(64), z.string().max(200)).optional(),
        artifacts: z.array(z.string().max(200)).max(10).optional(),
        /** JSON Schema describing the structured output the task must produce. Used by submit_output for validation (104j §6.9). */
        schema: z.record(z.unknown()).optional(),
        derivedFrom: z.array(DerivedFromBindingSchema).max(10).optional(),
        /**
         * Names of registered output validators (`validatorRegistry`) run after
         * the JSON-Schema check at `submit_output` + the harness. Use a pure-Zod
         * validatorRef to carry rules a JSON-Schema projection cannot express
         * (cross-field `superRefine`s) as the authoritative contract.
         */
        validatorRefs: z.array(z.string().min(1).max(120)).max(10).optional(),
      })
      .optional(),

    context: TaskContextSpecSchema.optional(),

    model: z.string().min(1).max(64).optional(),

    when: WorkflowWhenSchema.optional(),

    poll: WorkflowTaskPollSchema.optional(),

    outputProjection: WorkflowTaskOutputProjectionSchema.optional(),

    inputTemplate: WorkflowTaskInputTemplateSchema.optional(),

    /**
     * 104j §6.2: Declarative input bindings.
     *
     * Maps input field names to binding sources (run input, upstream task output,
     * task metrics/summary, or workflow state variables). Resolved at task-launch
     * time by the Driver and overlaid onto `task.inputs`.
     */
    inputBindings: z.record(z.string().max(64), WorkflowTaskInputBindingSchema).optional(),

    /**
     * 104j §6.3: Output promotion rules.
     *
     * After task success, extracts values from the task's output/metrics/summary
     * and writes them into declared workflow-run state variables.
     */
    promoteOutputs: z
      .array(WorkflowTaskOutputPromotionSchema)
      .max(10)
      .optional()
      .describe('Write task output to run-level state; live + terminal result.output'),

    produces: z.array(WorkflowTaskOutputPortSchema).max(20).optional(),

    inputContract: TaskInputContractSchema.optional(),

    onContractFailure: OnContractFailureSchema.optional(),
  })
  .strict()
  .superRefine(TaskDispatchFamilyRefine)
  .superRefine((task, ctx) => {
    if (task.outputProjection && POLL_RESERVED_OUTPUT_KEY in task.outputProjection) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outputProjection', POLL_RESERVED_OUTPUT_KEY],
        message: `outputProjection must not declare "${POLL_RESERVED_OUTPUT_KEY}" — it is platform-reserved (the harness stamps poll metadata into the task output).`,
      });
    }

    // The registry is populated by side-effect imports (cybernetic-runtime
    // barrel) only in runtime contexts; in schema-only contexts it is empty
    // and we cannot meaningfully check, so the guard skips rather than
    // false-rejecting every ref.
    const refs = task.outputContract?.validatorRefs;
    if (refs && refs.length > 0) {
      const known = listRegisteredValidatorNames();
      if (known.length > 0) {
        for (const [i, ref] of refs.entries()) {
          if (!known.includes(ref)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['outputContract', 'validatorRefs', i],
              message: `outputContract.validatorRefs[${i}] "${ref}" is not a registered validator. Known: [${known.join(', ')}].`,
            });
          }
        }
      }
    }

    if (task.inputTemplate !== undefined) {
      const declared = new Set([
        ...Object.keys(task.inputBindings ?? {}),
        ...Object.keys(task.inputs ?? {}),
      ]);
      const analysis = analyzeInputTemplate(task.inputTemplate);
      for (const malformed of analysis.malformed) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['inputTemplate'],
          message: `inputTemplate node at "${malformed.path || '(root)'}" is malformed: ${malformed.reason}.`,
        });
      }
      for (const bind of analysis.binds) {
        if (!declared.has(bind.bindAs)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['inputTemplate'],
            message:
              `inputTemplate "${TEMPLATE_BIND_KEY}": "${bind.bindAs}" at "${bind.path || '(root)'}" names no ` +
              `declared inputBindings entry or literal inputs key. Declared: [${[...declared].sort().join(', ') || '(none)'}].`,
          });
        }
      }
    }

    if (!task.onContractFailure?.perBinding) return;
    const declaredBindings = new Set(Object.keys(task.inputBindings ?? {}));
    for (const bindAs of Object.keys(task.onContractFailure.perBinding)) {
      if (!declaredBindings.has(bindAs)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['onContractFailure', 'perBinding', bindAs],
          message: `onContractFailure.perBinding["${bindAs}"] references a binding not declared in inputBindings. Add the binding or remove the rule.`,
        });
      }
    }
  });
export type WorkflowTask = z.infer<typeof WorkflowTaskSchema>;

/**
 * Thrown when `inferTaskType` is asked to classify a task that has no
 * recognisable dispatch family. With the strict `WorkflowTaskSchema` in
 * place, validated tasks should never trigger this — callers that operate
 * on raw, unvalidated input must handle the error.
 */
export class InvalidTaskDispatchError extends Error {
  constructor(
    public readonly taskId: string,
    detail: string,
  ) {
    super(`Task "${taskId}": ${detail}`);
    this.name = 'InvalidTaskDispatchError';
  }
}

export function inferTaskType(task: WorkflowTask): 'agent' | 'operation' | 'human' {
  if (task.type) return task.type;
  if (task.agent) return 'agent';
  if (task.operation) return 'operation';
  if (task.pauseInstruction) return 'human';
  throw new InvalidTaskDispatchError(
    task.taskId,
    'Cannot infer dispatch family. Set type explicitly or provide one of: agent, operation, pauseInstruction.',
  );
}
