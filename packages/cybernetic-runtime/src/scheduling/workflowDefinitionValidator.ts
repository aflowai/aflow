import { ComposedWorkflowSchema, registerValidator } from '@aflow/schemas';
import { materializeAndValidateSkillConfig } from '../skillValidity/skillValidity.js';

/** Stable name for the validatorRef field on outputContract. */
export const WORKFLOW_DEFINITION_VALIDATOR_REF = 'workflow-definition' as const;

/**
 * `ComposedWorkflowSchema` plus a `superRefine` that runs every invariant
 * declared in `validateWorkflowGraph`. Use this when you want a single
 * call to detect both shape errors and graph-structural errors.
 *
 * The static `ComposedWorkflowSchema` is the delivery contract (what the
 * LLM sees in the prompt-injected JSON Schema); this augmented schema is
 * the structural-correctness contract (what the runner's submit_output
 * actually validates against).
 */
export const ComposedWorkflowSchemaWithInvariants = ComposedWorkflowSchema.superRefine(
  (data, ctx) => {
    const { validity } = materializeAndValidateSkillConfig({
      tasks: data.tasks,
      stateVariables: data.stateVariables,
      runInputs: data.runInputs,
    });
    for (const diag of validity.diagnostics) {
      // Zod issue paths help the agent locate the problem. Map diagnostics to
      // the most specific path we can compute.
      const path: Array<string | number> = [];
      if (diag.taskId !== undefined) {
        const idx = data.tasks.findIndex((t) => t.taskId === diag.taskId);
        if (idx >= 0) {
          path.push('tasks', idx);
        }
      }
      const taskIds = [diag.taskId, diag.producerTaskId].filter(
        (t): t is string => t !== undefined,
      );
      ctx.addIssue({
        code: 'custom',
        message: `[${diag.code}] ${diag.detail}`,
        path,
        // Carry the typed code via params so callers (e.g. Coach evidence)
        // can group failures by graph-error class rather than raw message.
        params: {
          graphErrorKind: diag.code,
          taskIds,
        },
      });
    }
  },
);

// Register at module load. Idempotent: registering the same schema instance
// twice is a no-op; registering a different schema under the same name
// throws (see validatorRegistry.ts).
registerValidator(WORKFLOW_DEFINITION_VALIDATOR_REF, ComposedWorkflowSchemaWithInvariants);
