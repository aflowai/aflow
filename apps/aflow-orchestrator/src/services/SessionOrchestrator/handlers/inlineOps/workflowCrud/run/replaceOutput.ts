import { bumpResumeAttemptCount, commitReplaceOutputAndResume } from '@aflow/cybernetic-runtime';
import type { ApplyReplaceOutputResolutionArgs, ApplyReplaceOutputResult } from './resumeTypes.js';
import { getResumeAjv } from './resumeAjv.js';

export async function applyReplaceOutputResolution(
  ctx: ApplyReplaceOutputResolutionArgs,
): Promise<ApplyReplaceOutputResult> {
  const { args, db, tenantIdStr, run, surfaced, output, claimToken } = ctx;

  // 1. Bump the attempt counter eagerly. The surfacing call already ran
  //    in the parent handler; if the bump fails, our claim is gone and we
  //    must abort before doing real work.
  const postBump = await bumpResumeAttemptCount(db, tenantIdStr, run.runId, claimToken);
  if (postBump === null) {
    return {
      ok: false,
      error: {
        code: 'RESUME_COMMIT_LOST',
        message:
          'Resume lease expired before mode work could begin. Re-fetch the surfaced contract and retry.',
      },
    };
  }

  // 2. Validate the surfaced contract is well-formed for this mode.
  if (!surfaced) {
    return {
      ok: false,
      error: {
        code: 'RESUME_CONTRACT_MISSING',
        message:
          'No structured resume contract is attached to this pause. replace_output requires a `task_contract_violation` pause.',
      },
    };
  }
  const failedTaskId = surfaced.contract.failedTaskId;
  if (!failedTaskId) {
    return {
      ok: false,
      error: {
        code: 'RESUME_CONTRACT_MISSING_TASK',
        message:
          'Surfaced resume contract has no failedTaskId — cannot route replace_output to a specific task row.',
      },
    };
  }
  const expectedSchema = surfaced.contract.expectedTaskOutputSchema;
  if (!expectedSchema) {
    return {
      ok: false,
      error: {
        code: 'RESUME_CONTRACT_NO_SCHEMA',
        message: 'Failed task has no outputContract.schema; replace_output cannot be validated.',
      },
    };
  }

  // 3. Patch must be a JSON object (we merge into the failed task output).
  if (
    output === undefined ||
    output === null ||
    typeof output !== 'object' ||
    Array.isArray(output)
  ) {
    return {
      ok: false,
      error: {
        code: 'REPLACE_OUTPUT_INVALID',
        message:
          'replace_output.output must be a JSON object covering the failed ports. Pass the per-port patch matching `replaceOutputSchema` from the surfaced contract.',
      },
    };
  }

  const ajv = getResumeAjv();
  const replaceOutputSchema = surfaced.contract.replaceOutputSchema;
  if (replaceOutputSchema) {
    const validatePatch = ajv.compile(replaceOutputSchema);
    if (!validatePatch(output)) {
      const issues =
        (validatePatch as unknown as { errors?: Array<{ instancePath: string; message?: string }> })
          .errors ?? [];
      const summary = issues
        .slice(0, 5)
        .map((i) => `${i.instancePath || '<root>'}: ${i.message ?? 'invalid'}`)
        .join('; ');
      return {
        ok: false,
        error: {
          code: 'REPLACE_OUTPUT_PATCH_INVALID',
          message:
            `Patch failed validation against the contract's replaceOutputSchema: ${summary}. ` +
            'The patch may only fill the FAILED ports listed in the surfaced contract; ' +
            'rewriting passing ports is rejected to preserve the per-port subset guarantee.',
        },
      };
    }
  }

  // 5. Merge the patch onto the existing failed output. Q10 settled
  //    per-port: only ports declared in `expectedSchema.properties` carry
  //    over from the prior failed output; everything else is dropped.
  //
  let existingOutput: Record<string, unknown> = {};
  const failedRow = run.tasks.find((t) => t.taskId === failedTaskId);
  if (failedRow?.outputRef) {
    try {
      const fetched = await args.payloadStore.retrieve(failedRow.outputRef);
      if (fetched && typeof fetched === 'object' && !Array.isArray(fetched)) {
        existingOutput = fetched as Record<string, unknown>;
      }
    } catch {
      // existing output unrecoverable — fall through with empty base
    }
  }
  const schemaProps = expectedSchema['properties'];
  const allowedKeys =
    schemaProps && typeof schemaProps === 'object' && !Array.isArray(schemaProps)
      ? new Set(Object.keys(schemaProps as Record<string, unknown>))
      : null;
  const filteredExisting: Record<string, unknown> = {};
  if (allowedKeys) {
    for (const [k, v] of Object.entries(existingOutput)) {
      if (allowedKeys.has(k)) filteredExisting[k] = v;
    }
  } else {
    // Schema isn't an object schema with a property catalog; preserve as-is.
    Object.assign(filteredExisting, existingOutput);
  }
  const merged: Record<string, unknown> = {
    ...filteredExisting,
    ...(output as Record<string, unknown>),
  };

  // 6. Validate the merged full output against the task's outputContract.schema.
  const validate = ajv.compile(expectedSchema);
  if (!validate(merged)) {
    const issues =
      (validate as unknown as { errors?: Array<{ instancePath: string; message?: string }> })
        .errors ?? [];
    const summary = issues
      .slice(0, 5)
      .map((i) => `${i.instancePath || '<root>'}: ${i.message ?? 'invalid'}`)
      .join('; ');
    return {
      ok: false,
      error: {
        code: 'REPLACE_OUTPUT_VALIDATION_FAILED',
        message: `Merged output failed validation against outputContract.schema: ${summary}`,
      },
    };
  }

  // 7. Persist the merged output. This may produce an orphan payload if
  //    the commit transaction below rolls back — that's an acceptable
  //    outcome (cheap to GC) compared to split task/run state.
  const newOutputRef = await args.payloadStore.store({
    tenantId: args.context.tenantId,
    runId: args.context.runId,
    stepExecutionId: args.stepExecutionId,
    attempt: args.attempt,
    kind: 'output',
    data: merged,
    contentType: 'application/json',
  });

  // 8. Atomic commit — task row to `succeeded` + run row to `running`,
  //    both gated on the live claim, in a single transaction.
  const commitResult = await commitReplaceOutputAndResume(db, tenantIdStr, {
    runId: run.runId,
    claimToken,
    failedTaskId,
    outputRef: newOutputRef,
    summary: `Resolved via workflow.run.resume replace_output (pauseVersion=${String(surfaced.pauseVersion)}).`,
  });
  if (commitResult === 'claim_lost') {
    return {
      ok: false,
      error: {
        code: 'RESUME_COMMIT_LOST',
        message:
          'Resume lease expired or was superseded between validation and commit. Re-fetch the surfaced contract and retry.',
      },
    };
  }
  if (commitResult === 'task_row_not_paused') {
    return {
      ok: false,
      error: {
        code: 'RESUME_TASK_ROW_NOT_PAUSED',
        message:
          `Failed task "${failedTaskId}" on run ${run.runId} is not in 'paused' state — ` +
          'commit rolled back. Re-fetch the surfaced contract; if the issue persists, the ' +
          'task row was reprocessed out-of-band and manual recovery is needed.',
      },
    };
  }
  return { ok: true, succeededTaskId: failedTaskId };
}
