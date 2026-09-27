import type { Workflow, StagedChangeOp, SkillGoal, SkillCampaignContract } from '@aflow/schemas';
import {
  WorkflowTaskSchema,
  TaskContextSpecSchema,
  WorkflowOutputDeclarationSchema,
  WorkflowStateVariableSchema,
  SkillGoalSchema,
  CampaignContractFieldSchema,
} from '@aflow/schemas';
import type { WorkflowPatchInput } from '@aflow/schemas';
import { applyJsonPatch, JsonPatchError } from '@aflow/lib';

/** The slice of the manifest a `workflow.manage.patch` may edit via `/goal` + `/campaign`. */
export interface ManifestPatchDoc {
  goal?: SkillGoal;
  campaign?: SkillCampaignContract;
}

/** A JSON-Patch op targets the manifest when its first segment is goal/campaign. */
export function isManifestPatchOp(op: WorkflowPatchInput['operations'][number]): boolean {
  const seg = parsePath(op.path).segments[0];
  return seg === 'goal' || seg === 'campaign';
}

export interface ConversionResult {
  ops: StagedChangeOp[];
  unsupported: string[];
}

interface ParsedPath {
  segments: string[];
  /** The original `/a/b/c` string for error messages. */
  raw: string;
}

function parsePath(path: string): ParsedPath {
  // RFC 6902 path: leading slash, segments split on /, ~0 → ~ and ~1 → /.
  const segments = path
    .split('/')
    .slice(1)
    .map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'));
  return { segments, raw: path };
}

function taskIdAtIndex(workflow: Workflow, index: number): string | undefined {
  const task = workflow.tasks[index];
  return task?.taskId;
}

function outcomeIdAtIndex(workflow: Workflow, index: number): string | undefined {
  const outcome = workflow.outcomes[index];
  return outcome?.id;
}

function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function convertContextPatch(
  op: WorkflowPatchInput['operations'][number],
  existing: Workflow,
  index: number,
  taskId: string,
  segments: string[],
): StagedChangeOp | { unsupported: string } {
  const task = existing.tasks[index];
  if (!task) {
    return {
      unsupported: `Task path "${op.path}" references task index ${String(index)}, which does not exist on the workflow.`,
    };
  }

  if (segments.length === 3) {
    if (op.op !== 'add' && op.op !== 'replace') {
      return {
        unsupported: `${op.op} ${op.path} cannot be expressed as update_task_context_spec. Use add/replace with a complete TaskContextSpec value.`,
      };
    }
    const parse = TaskContextSpecSchema.safeParse(op.value);
    if (!parse.success) {
      return {
        unsupported: `${op.op} ${op.path} requires a TaskContextSpec value: ${parse.error.message}`,
      };
    }
    return {
      op: 'update_task_context_spec',
      taskId,
      contextSpec: parse.data,
    } as StagedChangeOp;
  }

  if (op.op !== 'add' && op.op !== 'replace' && op.op !== 'remove') {
    return {
      unsupported: `Op shape "${op.op} ${op.path}" is not supported for nested task context patches. Use add/replace/remove under /tasks/{i}/context.`,
    };
  }

  if (!task.context) {
    return {
      unsupported: `${op.op} ${op.path} targets a nested context field, but task "${taskId}" has no context. Add or replace /tasks/${String(index)}/context with a complete TaskContextSpec first.`,
    };
  }

  const contextPath = `/${segments.slice(3).map(escapePointerSegment).join('/')}`;
  try {
    const patchedContext = applyJsonPatch(task.context, [
      { ...op, path: contextPath },
    ] as WorkflowPatchInput['operations']);
    const parse = TaskContextSpecSchema.safeParse(patchedContext);
    if (!parse.success) {
      return {
        unsupported: `${op.op} ${op.path} would leave task "${taskId}" with an invalid TaskContextSpec: ${parse.error.message}`,
      };
    }
    return {
      op: 'update_task_context_spec',
      taskId,
      contextSpec: parse.data,
    } as StagedChangeOp;
  } catch (err) {
    const detail =
      err instanceof JsonPatchError
        ? `${err.message}${err.opPath ? ` (at ${err.opPath})` : ''}`
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      unsupported: `${op.op} ${op.path} cannot be applied to task "${taskId}" context: ${detail}`,
    };
  }
}

function convertTaskPatch(
  op: WorkflowPatchInput['operations'][number],
  existing: Workflow,
  index: number,
  taskId: string,
  segments: string[],
): StagedChangeOp | { unsupported: string } {
  const task = existing.tasks[index];
  if (!task) {
    return {
      unsupported: `Task path "${op.path}" references task index ${String(index)}, which does not exist on the workflow.`,
    };
  }
  if (op.op !== 'add' && op.op !== 'replace' && op.op !== 'remove') {
    return {
      unsupported: `Op shape "${op.op} ${op.path}" is not supported for task replacement proposals. Use add/replace/remove under /tasks/{i}.`,
    };
  }

  const taskPath = `/${segments.slice(2).map(escapePointerSegment).join('/')}`;
  try {
    const patchedTask = applyJsonPatch(task, [
      { ...op, path: taskPath },
    ] as WorkflowPatchInput['operations']);
    const parse = WorkflowTaskSchema.safeParse(patchedTask);
    if (!parse.success) {
      return {
        unsupported: `${op.op} ${op.path} would leave task "${taskId}" invalid: ${parse.error.message}`,
      };
    }
    if (parse.data.taskId !== taskId) {
      return {
        unsupported: `${op.op} ${op.path} would change taskId from "${taskId}" to "${parse.data.taskId}". Task identity is immutable; add a new task and remove the old one instead.`,
      };
    }
    return { op: 'replace_task', taskId, task: parse.data } as StagedChangeOp;
  } catch (err) {
    const detail =
      err instanceof JsonPatchError
        ? `${err.message}${err.opPath ? ` (at ${err.opPath})` : ''}`
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      unsupported: `${op.op} ${op.path} cannot be applied to task "${taskId}": ${detail}`,
    };
  }
}

function convertWorkflowContractPatch(
  op: WorkflowPatchInput['operations'][number],
  existing: Workflow,
): StagedChangeOp | { unsupported: string } {
  if (op.op !== 'add' && op.op !== 'replace' && op.op !== 'remove') {
    return {
      unsupported: `Op shape "${op.op} ${op.path}" is not supported for workflow contract patches. Use add/replace/remove under /stateVariables or /output.`,
    };
  }
  try {
    const patchedWorkflow = applyJsonPatch<Workflow>(existing, [op]);
    const parsedStateVariables = WorkflowStateVariableSchema.array()
      .max(20)
      .safeParse(patchedWorkflow.stateVariables);
    if (!parsedStateVariables.success) {
      return {
        unsupported: `${op.op} ${op.path} would leave stateVariables invalid: ${parsedStateVariables.error.message}`,
      };
    }
    const outputValue = patchedWorkflow.output;
    const parsedOutput =
      outputValue === undefined
        ? { success: true as const, data: undefined }
        : WorkflowOutputDeclarationSchema.safeParse(outputValue);
    if (!parsedOutput.success) {
      return {
        unsupported: `${op.op} ${op.path} would leave workflow output invalid: ${parsedOutput.error.message}`,
      };
    }

    const { segments } = parsePath(op.path);
    const result: StagedChangeOp = {
      op: 'update_workflow_contract',
      ...(segments[0] === 'stateVariables' ? { stateVariables: parsedStateVariables.data } : {}),
      ...(segments[0] === 'output'
        ? { output: parsedOutput.data === undefined ? null : parsedOutput.data }
        : {}),
    };
    return result;
  } catch (err) {
    const detail =
      err instanceof JsonPatchError
        ? `${err.message}${err.opPath ? ` (at ${err.opPath})` : ''}`
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      unsupported: `${op.op} ${op.path} cannot be applied to workflow contract: ${detail}`,
    };
  }
}

/**
 * Convert one JSON Patch op. Returns either the typed StagedChangeOp or an
 * `unsupported` reason string. The reason is operator-facing, so it should
 * name the op shape concretely.
 */
function convertOne(
  op: WorkflowPatchInput['operations'][number],
  existing: Workflow,
): StagedChangeOp | { unsupported: string } {
  const { segments } = parsePath(op.path);

  // move / copy / test — out of scope for proposal conversion. The agent
  // can express the same intent via `replace`/`add`/`remove`.
  if (op.op === 'move' || op.op === 'copy' || op.op === 'test') {
    return {
      unsupported: `Op shape "${op.op} ${op.path}" is not supported by workflow_refinement. Use replace/add/remove, or workflow.manage.put for a full rewrite.`,
    };
  }

  // /iteration — replace the whole iteration policy. Maps to the typed op
  // by extracting the fields that the typed op actually carries (auto is
  // not part of update_iteration_policy; if the patch tries to change it,
  // surface as unsupported so the operator-HTTP route can handle it).
  if (op.op === 'replace' && segments.length === 1 && segments[0] === 'iteration') {
    const value = (op.value ?? {}) as {
      auto?: boolean;
      maxConsecutiveRuns?: number;
      stopOnOutcomesMet?: boolean;
      cooldownMs?: number;
    };
    if (value.auto !== undefined && existing.iteration.auto !== value.auto) {
      return {
        unsupported: `replace ${op.path} changes "auto", which update_iteration_policy does not cover. Use workflow.manage.put for iteration.auto flips.`,
      };
    }
    return {
      op: 'update_iteration_policy',
      ...(value.maxConsecutiveRuns !== undefined
        ? { maxConsecutiveRuns: value.maxConsecutiveRuns }
        : {}),
      ...(value.cooldownMs !== undefined ? { cooldownMs: value.cooldownMs } : {}),
      ...(value.stopOnOutcomesMet !== undefined
        ? { stopOnOutcomesMet: value.stopOnOutcomesMet }
        : {}),
    } as StagedChangeOp;
  }

  if (segments[0] === 'stateVariables' || segments[0] === 'output') {
    return convertWorkflowContractPatch(op, existing);
  }

  // /tasks/... shapes
  if (segments[0] === 'tasks') {
    // add /tasks/- — append a task.
    if (op.op === 'add' && segments[1] === '-') {
      const parse = WorkflowTaskSchema.safeParse(op.value);
      if (!parse.success) {
        return {
          unsupported: `add /tasks/- requires a complete task body; the value did not pass WorkflowTaskSchema: ${parse.error.message}`,
        };
      }
      return { op: 'add_task', task: parse.data } as StagedChangeOp;
    }

    // /tasks/{i}/... — indexed task ops.
    const index = Number(segments[1]);
    if (!Number.isInteger(index) || index < 0) {
      return {
        unsupported: `Task path "${op.path}" must use an integer index after /tasks/.`,
      };
    }
    const taskId = taskIdAtIndex(existing, index);
    if (!taskId) {
      return {
        unsupported: `Task path "${op.path}" references task index ${String(index)}, which does not exist on the workflow.`,
      };
    }

    // remove /tasks/{i}
    if (op.op === 'remove' && segments.length === 2) {
      return { op: 'remove_task', taskId } as StagedChangeOp;
    }

    // replace /tasks/{i}/goal
    if (op.op === 'replace' && segments.length === 3 && segments[2] === 'goal') {
      if (typeof op.value !== 'string') {
        return {
          unsupported: `replace ${op.path} requires a string value (the new goal).`,
        };
      }
      return { op: 'update_task_goal', taskId, newGoal: op.value } as StagedChangeOp;
    }

    // add/replace /tasks/{i}/context or nested add/replace/remove under it.
    // The ratification vocabulary already has a safe full-context op, so a
    // narrow JSON Patch is applied to the task context snapshot and staged as
    // the resulting complete TaskContextSpec.
    if (segments[2] === 'context') {
      return convertContextPatch(op, existing, index, taskId, segments);
    }

    // replace /tasks/{i}/dependsOn
    if (op.op === 'replace' && segments.length === 3 && segments[2] === 'dependsOn') {
      if (!Array.isArray(op.value) || !op.value.every((v): v is string => typeof v === 'string')) {
        return {
          unsupported: `replace ${op.path} requires a string[] value.`,
        };
      }
      const dependsOn: string[] = op.value;
      const result: StagedChangeOp = {
        op: 'update_task_dependencies',
        taskId,
        dependsOn,
        ...(dependsOn.length === 0 ? { source: true } : {}),
      };
      return result;
    }

    return convertTaskPatch(op, existing, index, taskId, segments);
  }

  // /outcomes/{i}/evaluator/target — the threshold lives inside the
  // outcome's evaluator, so the JSON Patch path is one segment deeper than
  // the typed op's name suggests.
  if (
    op.op === 'replace' &&
    segments[0] === 'outcomes' &&
    segments.length === 4 &&
    segments[2] === 'evaluator' &&
    segments[3] === 'target'
  ) {
    const index = Number(segments[1]);
    if (!Number.isInteger(index) || index < 0) {
      return {
        unsupported: `Outcome path "${op.path}" must use an integer index after /outcomes/.`,
      };
    }
    const outcomeId = outcomeIdAtIndex(existing, index);
    if (!outcomeId) {
      return {
        unsupported: `Outcome path "${op.path}" references outcome index ${String(index)}, which does not exist.`,
      };
    }
    if (typeof op.value !== 'number') {
      return {
        unsupported: `replace ${op.path} requires a numeric target.`,
      };
    }
    return {
      op: 'update_outcome_threshold',
      outcomeId,
      newTarget: op.value,
    } as StagedChangeOp;
  }

  return {
    unsupported: `Op shape "${op.op} ${op.path}" is not yet supported for agent-initiated workflow patches. Supported shapes: task add/remove/replacements under /tasks, replace /outcomes/{i}/evaluator/target, add/replace/remove under /stateVariables or /output, and replace /iteration. For wholesale rewrites use workflow.manage.put.`,
  };
}

/**
 * RFC 6902 evaluates each op against the document already mutated by prior
 * ops. To pick the right taskId/outcomeId for an indexed op, we must walk
 * a shadow workflow that incorporates earlier patches before resolving the
 * next op. Example: `[{ remove /tasks/0 }, { replace /tasks/0/goal }]` — the
 * second op's index resolves to the OLD task 1 in the live patch
 * semantics, not the OLD task 0.
 *
 * The shadow is updated by re-applying single JSON Patch ops with
 * `applyJsonPatch` (which deep-clones each call). For mutations we couldn't
 * lower (returned as `unsupported`), we still attempt to apply them to the
 * shadow so the final shadow remains coherent for later ops; if shadow-apply
 * fails (already malformed) we surface the original unsupported reason.
 */
/**
 * Convert one manifest JSON-Patch op (`/goal` or `/campaign/fields/{key}`) into
 * a manifest StagedChangeOp, against a shadow `{ goal, campaign }` doc. Whole-
 * field/whole-goal ops map directly; nested ops are applied to the shadow
 * subtree and re-emitted as the complete value (mirroring the task-context
 * lowering above).
 */
function convertManifestOne(
  op: WorkflowPatchInput['operations'][number],
  shadow: ManifestPatchDoc,
): StagedChangeOp | { unsupported: string } {
  const { segments } = parsePath(op.path);

  if (op.op === 'move' || op.op === 'copy' || op.op === 'test') {
    return {
      unsupported: `Op shape "${op.op} ${op.path}" is not supported for goal/campaign patches. Use replace/add/remove.`,
    };
  }

  // -- /goal (whole goal, or a nested field re-emitted as the whole goal) --
  if (segments[0] === 'goal') {
    if (op.op === 'remove') {
      return { unsupported: `remove ${op.path} is not allowed — a skill must always have a goal.` };
    }
    let nextGoalRaw: unknown;
    if (segments.length === 1) {
      nextGoalRaw = op.value;
    } else {
      const sub = tryApplySubPatch(shadow.goal, segments.slice(1), op);
      if (!sub.ok) return { unsupported: sub.unsupported };
      nextGoalRaw = sub.value;
    }
    const parsed = SkillGoalSchema.safeParse(nextGoalRaw);
    if (!parsed.success) {
      return {
        unsupported: `${op.op} ${op.path} requires a valid SkillGoal: ${parsed.error.message}`,
      };
    }
    return { op: 'update_goal', goal: parsed.data } as StagedChangeOp;
  }

  // -- /campaign/fields/{key} (whole field add/update/remove, or nested) --
  if (segments[0] === 'campaign' && segments[1] === 'fields' && segments.length >= 3) {
    const fieldKey = segments[2]!;
    if (op.op === 'remove' && segments.length === 3) {
      return { op: 'campaign.field.remove', fieldKey } as StagedChangeOp;
    }
    const existingField = shadow.campaign?.fields[fieldKey];
    let nextFieldRaw: unknown;
    if (segments.length === 3) {
      nextFieldRaw = op.value;
    } else {
      const sub = tryApplySubPatch(existingField, segments.slice(3), op);
      if (!sub.ok) return { unsupported: sub.unsupported };
      nextFieldRaw = sub.value;
    }
    const parsed = CampaignContractFieldSchema.safeParse(nextFieldRaw);
    if (!parsed.success) {
      return {
        unsupported: `${op.op} ${op.path} requires a valid campaign contract field: ${parsed.error.message}`,
      };
    }
    // A whole-field `add` on a new key is an add; otherwise (replace, or any
    // nested edit of an existing field) it is an update.
    const isAdd = op.op === 'add' && segments.length === 3 && existingField === undefined;
    return isAdd
      ? ({ op: 'campaign.field.add', fieldKey, field: parsed.data } as StagedChangeOp)
      : ({ op: 'campaign.field.update', fieldKey, field: parsed.data } as StagedChangeOp);
  }

  return {
    unsupported:
      `Op shape "${op.op} ${op.path}" is not supported for goal/campaign patches. ` +
      `Supported: replace /goal, and add/replace/remove /campaign/fields/{key}.`,
  };
}

type SubPatchResult = { ok: true; value: unknown } | { ok: false; unsupported: string };

/** Apply a single sub-path RFC op to a subtree, returning the new subtree or unsupported. */
function tryApplySubPatch(
  subtree: unknown,
  subSegments: string[],
  op: WorkflowPatchInput['operations'][number],
): SubPatchResult {
  if (subtree === undefined) {
    return {
      ok: false,
      unsupported: `${op.op} ${op.path} targets a nested field that does not exist yet.`,
    };
  }
  const subPath = `/${subSegments.map(escapePointerSegment).join('/')}`;
  try {
    const value = applyJsonPatch(subtree, [
      { ...op, path: subPath },
    ] as WorkflowPatchInput['operations']);
    return { ok: true, value };
  } catch (err) {
    const detail =
      err instanceof JsonPatchError
        ? `${err.message}${err.opPath ? ` (at ${err.opPath})` : ''}`
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, unsupported: `${op.op} ${op.path} cannot be applied: ${detail}` };
  }
}

/**
 * Convert the manifest-targeting subset of a patch (`/goal`, `/campaign/...`)
 * into manifest StagedChangeOps. Walks a shadow manifest doc so nested-field
 * ops and `add`-vs-`update` disambiguation resolve against prior ops.
 */
export function convertManifestPatchToStagedOps(
  jsonPatchOps: WorkflowPatchInput['operations'],
  manifest: ManifestPatchDoc,
): ConversionResult {
  const ops: StagedChangeOp[] = [];
  const unsupported: string[] = [];
  let shadow: ManifestPatchDoc = JSON.parse(JSON.stringify(manifest)) as ManifestPatchDoc;
  // A contract-less skill has no `campaign` object — seed an empty fields map so
  // `add /campaign/fields/{key}` (the first field) resolves at the JSON-Patch
  // level. The emitted op is still campaign.field.add; the engine creates the
  // contract. An all-removed contract is cleared back to undefined by the engine.
  if (!shadow.campaign) shadow.campaign = { fields: {} };
  for (const jp of jsonPatchOps) {
    const out = convertManifestOne(jp, shadow);
    if ('unsupported' in out) {
      unsupported.push(out.unsupported);
    } else {
      ops.push(out);
    }
    try {
      shadow = applyJsonPatch<ManifestPatchDoc>(shadow, [jp]);
    } catch (err) {
      const detail =
        err instanceof JsonPatchError
          ? `${err.message}${err.opPath ? ` (at ${err.opPath})` : ''}`
          : err instanceof Error
            ? err.message
            : String(err);
      unsupported.push(
        `Op "${jp.op} ${jp.path}" cannot be applied to the patched manifest: ${detail}`,
      );
      break;
    }
  }
  return { ops, unsupported };
}

export function convertWorkflowPatchToStagedOps(
  jsonPatchOps: WorkflowPatchInput['operations'],
  existing: Workflow,
): ConversionResult {
  const ops: StagedChangeOp[] = [];
  const unsupported: string[] = [];
  let shadow: Workflow = existing;
  for (const jp of jsonPatchOps) {
    const out = convertOne(jp, shadow);
    if ('unsupported' in out) {
      unsupported.push(out.unsupported);
    } else {
      ops.push(out);
    }
    // Advance the shadow regardless of conversion outcome. If a single op
    // is structurally invalid against the shadow (e.g. removing an index
    // that no longer exists after a prior remove), we record the failure
    // and stop — continuing would make later resolutions meaningless.
    try {
      shadow = applyJsonPatch<Workflow>(shadow, [jp]);
    } catch (err) {
      const detail =
        err instanceof JsonPatchError
          ? `${err.message}${err.opPath ? ` (at ${err.opPath})` : ''}`
          : err instanceof Error
            ? err.message
            : String(err);
      unsupported.push(
        `Op "${jp.op} ${jp.path}" cannot be applied to the patched document — earlier ops left it incompatible: ${detail}`,
      );
      break;
    }
  }
  return { ops, unsupported };
}
