import type { OperationId, McpCredentialBlock, BlockerKind } from '@aflow/schemas';
import { materializeDraftForSubmit } from './taskDraft.js';
import { formatDraftRepairProgress } from '@aflow/schemas';
import { SUBAGENT_HANDOFF_PAYLOAD_KIND, BlockerKindSchema } from '@aflow/schemas';
import { getSessionState, addStepResult, updateSessionState } from '@aflow/redis';
import type { SessionHotState } from '@aflow/redis';
import { getDatabase } from '@aflow/database';
import {
  captureRunnerReflectionForSession,
  markReflectionExpected,
  setTaskSummary,
  runRegisteredOutputValidators,
  runRegisteredAdvisories,
  formatOutputValidatorIssues,
} from '@aflow/cybernetic-runtime';
import { normalizeMangledRef } from '@aflow/input-resolution';
import type { InlineHandlerArgs } from './types.js';
import { emitStepSuccess, emitStepError } from './helpers.js';
import { decodeStringifiedCompletionResult } from '../completionResultContract.js';
import { getOrchestratorLogger } from '../../../../lib/orchestratorLogger.js';

/**
 * How many advisory findings ride the summary. Generous rather than tight: the
 * whole point is telling an operator what a suite would miss, and a suite with
 * twenty weak cases is exactly the one worth saying twenty things about. The
 * cap exists only so a pathological draft cannot push a task row's summary to
 * an unbounded size.
 */
const ADVISORY_NOTE_LIMIT = 25;
import {
  validateAgentOutput,
  filterAnyOfBranchErrors,
  formatAjvError,
} from './agentOutputValidator.js';

/**
 * Walk a validated-output tree for a value that is still a `$ref`-shaped object
 * (clean or model-mangled). Its presence at validation time means `$ref`
 * resolution was skipped upstream — so the raw reference object reached the schema
 * check and produced a misleading type error (e.g. "must be string"). Returns the
 * first such ref string so the agent gets a real diagnosis instead of chasing the
 * type error. Depth-bounded to mirror the resolver's own walk limit.
 */
function findUnresolvedRef(value: unknown, depth = 0): string | null {
  if (depth > 20 || value === null || typeof value !== 'object') {
    return null;
  }
  const ref = normalizeMangledRef(value);
  if (ref) {
    return ref.$ref;
  }
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (const child of children) {
    const found = findUnresolvedRef(child, depth + 1);
    if (found) {
      return found;
    }
  }
  return null;
}

// Re-export the shared validator helpers under the existing testing names so
export const __testing_filterAnyOfBranchErrors = filterAnyOfBranchErrors;
export const __testing_formatAjvError = formatAjvError;
export const __testing_findUnresolvedRef = findUnresolvedRef;

// ============================================================================

interface ReflectionCaptureScope {
  spaceId: string;
  workflowExecution: { runId: string; taskId: string; attempt: number };
  workflowSlug?: string;
}

/**
 * Capture applies only to Runner sessions executing a workflow task (the
 * task row is the persistence target; the Coach is the consumer). Helmsman /
 * ad-hoc subagent completions ride the same contract but have no consumer
 * yet — per enact-or-delete, nothing is captured for them (183d §1).
 */
function reflectionCaptureScope(
  sessionState: SessionHotState | null,
): ReflectionCaptureScope | null {
  if (!sessionState?.workflowExecution || !sessionState.spaceId) return null;
  return {
    spaceId: sessionState.spaceId,
    workflowExecution: sessionState.workflowExecution,
    ...(sessionState.delegationDisplayWorkflowSlug
      ? { workflowSlug: sessionState.delegationDisplayWorkflowSlug }
      : {}),
  };
}

function launchReflectionCapture(
  args: InlineHandlerArgs,
  scope: ReflectionCaptureScope,
  terminal:
    | { source: 'submit_output' }
    | {
        source: 'signal_blocked';
        blocked: { category: BlockerKind; reason: string; needed?: string };
      },
): void {
  const logger = getOrchestratorLogger();
  try {
    const db = getDatabase();
    void captureRunnerReflectionForSession({
      db,
      redis: args.redis,
      tenantId: args.context.tenantId,
      spaceId: scope.spaceId,
      runnerSessionId: args.context.runId,
      workflowExecution: scope.workflowExecution,
      ...(scope.workflowSlug ? { workflowSlug: scope.workflowSlug } : {}),
      ...(terminal.source === 'signal_blocked' ? { blocked: terminal.blocked } : {}),
      source: terminal.source,
    }).catch((err: unknown) => {
      logger.warn(
        `[runnerOutput] reflection capture failed (non-fatal) for run=${scope.workflowExecution.runId} task=${scope.workflowExecution.taskId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  } catch (err) {
    logger.warn(
      `[runnerOutput] reflection capture launch failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Sync (single INCR), failure-isolated expected-marker write. */
async function markReflectionExpectedSafe(
  args: InlineHandlerArgs,
  scope: ReflectionCaptureScope,
): Promise<void> {
  try {
    await markReflectionExpected(args.redis, args.context.tenantId, scope.workflowExecution.runId);
  } catch (err) {
    getOrchestratorLogger().warn(
      `[runnerOutput] reflection expected-marker failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ============================================================================
// agent.control.submit_output
// ============================================================================

/**
 * States what the submission was built on and how much is still unmet, at the
 * front of the message where the failure accounting can see it. A repair that
 * only changed text past 500 characters is indistinguishable from repeating
 * itself, and the run is ended while it is converging.
 */
/**
 * A one-line census of the draft, and where to look for more.
 *
 * Printed with every rejection because that is the moment the agent needs it:
 * it is about to patch by index, and the alternative to seeing the indexes is
 * guessing at them.
 */
function describeDraftShape(content: unknown): string {
  if (Array.isArray(content)) return `draft is an array of ${String(content.length)}`;
  if (content === null || typeof content !== 'object') return `draft is ${typeof content}`;
  const counts = Object.entries(content as Record<string, unknown>).map(([k, v]) =>
    Array.isArray(v) ? `${k}[${String(v.length)}]` : k,
  );
  return `draft holds { ${counts.join(', ')} }`;
}

function draftRepairHint(shape: string): string {
  return (
    `The draft is kept — ${shape}. Read it with draft_get (a JSON Pointer such as ` +
    '"/cases/3" reads one entry) and repair in place with draft_patch at the pointer each ' +
    'error names, then submit again. Re-adding items that are already there is what an ' +
    'append without a read costs.'
  );
}

function draftProgressPrefix(revision: number, unmet: number): string {
  return `${formatDraftRepairProgress({ revision, unmet })} `;
}

export async function handleSubmitOutputInline(args: InlineHandlerArgs): Promise<void> {
  const { redis, payloadStore, context } = args;
  const startTime = Date.now();
  const logger = getOrchestratorLogger();

  try {
    // 1. Read the agent's output from the resolved input
    let input: Record<string, unknown> = {};
    try {
      const data = await payloadStore.retrieve(args.resolvedInputRef);
      if (typeof data === 'object' && data !== null) {
        input = data as Record<string, unknown>;
      }
    } catch {
      await emitStepError(
        args,
        'SUBMIT_OUTPUT_INVALID_INPUT',
        'Could not read submit_output input payload.',
        startTime,
        'validation',
      );
      return;
    }

    // There is no literal to take. Whatever the draft holds is what gets
    // validated and emitted, so an agent cannot route around accumulation by
    // passing the whole artifact in one message.
    const materialized = await materializeDraftForSubmit(args);
    if (!materialized.ok) {
      await emitStepError(
        args,
        'SUBMIT_OUTPUT_DRAFT_UNAVAILABLE',
        `${materialized.detail} Build the result with draft_patch, then submit.`,
        startTime,
        'validation',
        true,
      );
      return;
    }
    const draftRevision = materialized.revision;
    let result = materialized.content;
    // What the draft holds right now. The repair the agent is about to attempt
    // is addressed by index, and an agent that cannot see the indexes patches
    // blind — which is how a retry appended a second copy of cases 0-2 and
    // nobody noticed until the item cap refused the whole thing.
    const draftShape = describeDraftShape(result);

    // 2. Read the output schema from session state (existing finalOutputSchemaOverrideJson)
    const sessionState = await getSessionState(redis, context.tenantId, context.runId);
    let outputSchema: Record<string, unknown> | undefined;
    if (sessionState?.finalOutputSchemaOverrideJson) {
      try {
        outputSchema = JSON.parse(sessionState.finalOutputSchemaOverrideJson) as Record<
          string,
          unknown
        >;
        logger.info(
          `[submitOutput] Loaded outputSchema for session ${context.runId} (${String(sessionState.finalOutputSchemaOverrideJson.length)} chars)`,
        );
      } catch {
        logger.warn(
          `[submitOutput] Failed to parse finalOutputSchemaOverrideJson for session ${context.runId}`,
        );
      }
    } else {
      logger.warn(
        `[submitOutput] No outputSchema set on session ${context.runId} — validation will be skipped. ` +
          `Check that the parent passed outputSchema in delegate input (and that the workflow task declares outputContract.schema).`,
      );
    }

    // 3. Validate against schema if present (full JSON Schema via ajv)
    if (outputSchema) {
      let validation;
      try {
        validation = validateAgentOutput(result, outputSchema);
      } catch (schemaErr) {
        // Bad schema is a platform/configuration bug — fail fast so it gets
        // surfaced, not silently swallowed.
        const msg = schemaErr instanceof Error ? schemaErr.message : String(schemaErr);
        logger.error(
          `[submitOutput] Schema compilation failed for session ${context.runId}: ${msg}`,
        );
        await emitStepError(
          args,
          'OUTPUT_SCHEMA_INVALID',
          `The task's outputContract.schema is malformed and could not be compiled: ${msg}`,
          startTime,
          'configuration',
        );
        return;
      }

      // A large structured result often arrives JSON-stringified (the model
      // emits the object as one string). When the raw value fails and the
      // string decodes to a container that validates, accept the decoded form —
      // the same accommodation `decodeStringifiedCompletionResult` gives the
      // contract-bound `complete` path.
      if (!validation.ok && typeof result === 'string') {
        const decoded = decodeStringifiedCompletionResult(result);
        if (decoded !== undefined) {
          try {
            const decodedValidation = validateAgentOutput(decoded, outputSchema);
            if (decodedValidation.ok) {
              logger.info(
                `[submitOutput] Accepted JSON-stringified result after decode for session ${context.runId}`,
              );
              result = decoded;
              validation = decodedValidation;
            }
          } catch {
            // Schema compiled once already; keep the original failure.
          }
        }
      }

      if (!validation.ok) {
        const unresolvedRef = findUnresolvedRef(result);
        const refHint = unresolvedRef
          ? ` The value "${unresolvedRef}" reached validation as an unresolved $ref ` +
            `object — the platform could not resolve it, so the raw reference (not the ` +
            `data it points to) was type-checked, which is why a field reads as the wrong ` +
            `type. Reference a valid prior step output as { "$ref": "output.<toolCallId>/<jsonPointer>" } ` +
            `using the exact toolCallId from that step's result, or inline the literal value instead.`
          : '';
        // The draft root is a JSON string. There is no `result` parameter to
        // re-send it through, so the repair is to replace the root with the
        // decoded value and then fix the fields underneath it.
        const stringHint =
          typeof result === 'string' && decodeStringifiedCompletionResult(result) !== undefined
            ? ' The draft holds a JSON string whose decoded form also fails the contract — ' +
              'replace the draft root with the decoded object, naming the revision you are ' +
              'replacing ({"mutationId":"…","expectedRevision":<n>,"operations":' +
              '[{"op":"replace","path":"","value":{…}}]}), then fix the listed fields under it.'
            : '';
        // `formatted` is already capped at ten. Counting it would report ten
        // unmet however many there are, so fixing two hundred of three hundred
        // issues would read as no progress at all and burn the repair budget.
        const unmetTotal = validation.rawErrors.length;
        const hiddenCount = unmetTotal - validation.formatted.length;
        const message =
          `${draftProgressPrefix(draftRevision, unmetTotal)}Output validation failed. ` +
          `${validation.formatted.join('; ')}.${
            hiddenCount > 0
              ? ` ${String(hiddenCount)} further issues not shown; fixing these surfaces the rest.`
              : ''
          } ` +
          `${validation.actualDesc}. ${draftRepairHint(draftShape)}${refHint}${stringHint}`;
        logger.info(`[submitOutput] Validation failed for session ${context.runId}: ${message}`);
        await emitStepError(
          args,
          'OUTPUT_VALIDATION_FAILED',
          message,
          startTime,
          'validation',
          true,
        );
        return;
      }
    } else if (typeof result === 'string') {
      // Contract-less tasks: still decode a stringified container so downstream
      // produces[] bindings (`output.<key>` traversal) see the object form.
      const decoded = decodeStringifiedCompletionResult(result);
      if (decoded !== undefined) result = decoded;
    }

    // 3b. Registered validatorRefs (Plan 206) — the Zod authority for tasks
    //     whose JSON-Schema projection can't carry their cross-field rules.
    //     The refs ride session state alongside finalOutputSchemaOverrideJson.
    //     A validator throwing is a platform bug: fail-open (the harness
    //     defense-in-depth re-runs the same refs) so a defect never traps the
    //     Runner.
    const validatorRefs = sessionState?.finalOutputValidatorRefs;
    if (validatorRefs && validatorRefs.length > 0) {
      const spaceId = sessionState.spaceId;
      if (!spaceId) {
        logger.warn(
          `[submitOutput] validatorRefs present but session ${context.runId} has no spaceId — skipping registered validators.`,
        );
      } else {
        try {
          const refIssues = await runRegisteredOutputValidators(validatorRefs, result, {
            tenantId: context.tenantId,
            spaceId,
            runId: context.runId,
            db: getDatabase(),
          });
          if (refIssues.length > 0) {
            const lines = formatOutputValidatorIssues(refIssues).slice(0, 10);
            const message =
              `${draftProgressPrefix(draftRevision, refIssues.length)}Output validation failed. ` +
              `${lines.join('; ')}.${
                refIssues.length > lines.length
                  ? ` ${String(refIssues.length - lines.length)} further issues not shown; fixing these surfaces the rest.`
                  : ''
              } ${draftRepairHint(draftShape)}`;
            logger.info(
              `[submitOutput] validatorRef validation failed for session ${context.runId}: ${message}`,
            );
            await emitStepError(
              args,
              'OUTPUT_VALIDATION_FAILED',
              message,
              startTime,
              'validation',
              true,
            );
            return;
          }
        } catch (err) {
          logger.warn(
            `[submitOutput] validatorRefs threw for session ${context.runId} (fail-open): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    // 4. Accepted — emit the validated result as-is. Do NOT mutate (e.g.,
    //    injecting summary) after validation — that would break schemas that
    //    forbid additional properties. The submit_output `summary` PARAM is
    //    persisted onto the task row separately below (it is advertised on
    //    the tool contract; without that write the eval's reserved
    //    `summary` criterion never resolves).
    let outputData: Record<string, unknown>;
    if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
      outputData = result as Record<string, unknown>;
    } else {
      // Scalar/array results: wrap minimally so emitStepSuccess can encode
      outputData = { result };
    }

    logger.info(
      `[submitOutput] Output accepted for session ${context.runId} (keys: ${Object.keys(outputData).join(', ')})`,
    );

    // What the accepted output would pass with and still be weak at. Advisories
    // refuse nothing, so they run only once the blocking validators have said
    // yes, and they ride the summary the operator reads at ratification rather
    // than the typed output the next task is bound to. Silence is not a verdict:
    // nothing is appended when there is nothing to report.
    const advisoryNote = await (async (): Promise<string> => {
      if (!validatorRefs || validatorRefs.length === 0) return '';
      try {
        const findings = runRegisteredAdvisories(validatorRefs, result);
        if (findings.length === 0) return '';
        const shown = findings.slice(0, ADVISORY_NOTE_LIMIT);
        const rest = findings.length - shown.length;
        return (
          `\n\nWhat this would not catch (${String(findings.length)} advisory ` +
          `${findings.length === 1 ? 'finding' : 'findings'}, not blocking): ` +
          shown.map((f) => f.detail).join(' ') +
          (rest > 0 ? ` ${String(rest)} further not shown.` : '')
        );
      } catch (err) {
        logger.warn(
          `[submitOutput] advisories threw for session ${context.runId} (ignored): ${err instanceof Error ? err.message : String(err)}`,
        );
        return '';
      }
    })();

    const captureScope = reflectionCaptureScope(sessionState ?? null);
    if (captureScope) {
      await markReflectionExpectedSafe(args, captureScope);

      // Persist the agent's prose summary onto the task row BEFORE the
      // completion result, so the finalize-time eval (which reads task rows)
      // sees it even for the run's last task. Sync but tiny + failure-
      // isolated (the reflection-expected INCR precedent); never clobbers a
      // summary the completion writer set.
      const summaryParam = input['summary'];
      const summaryText = typeof summaryParam === 'string' ? summaryParam : '';
      // Advisories are the operator's half of the contract, so they are written
      // whether or not the agent chose to write a summary of its own: a valid
      // `submit_output({})` on a suite with findings must not lose them.
      if (summaryText.length > 0 || advisoryNote.length > 0) {
        try {
          const db = getDatabase();
          await setTaskSummary(db, args.context.tenantId, {
            runId: captureScope.workflowExecution.runId,
            taskId: captureScope.workflowExecution.taskId,
            attempt: captureScope.workflowExecution.attempt,
            summary: `${summaryText}${advisoryNote}`.trimStart(),
          });
        } catch (err) {
          logger.warn(
            `[submitOutput] task summary persist failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    await emitStepSuccess(args, outputData, startTime);

    if (captureScope) {
      launchReflectionCapture(args, captureScope, { source: 'submit_output' });
    }
  } catch (err) {
    await emitStepError(
      args,
      'SUBMIT_OUTPUT_INTERNAL',
      err instanceof Error ? err.message : String(err),
      startTime,
      'internal',
    );
  }
}

// ============================================================================
// agent.control.signal_blocked
// ============================================================================

export async function handleSignalBlockedInline(args: InlineHandlerArgs): Promise<void> {
  const { redis, payloadStore, context, stepDef, stepExecutionId } = args;
  const startTime = Date.now();
  const logger = getOrchestratorLogger();

  try {
    // 1. Read the blocking reason from resolved input
    let input: Record<string, unknown> = {};
    try {
      const data = await payloadStore.retrieve(args.resolvedInputRef);
      if (typeof data === 'object' && data !== null) {
        input = data as Record<string, unknown>;
      }
    } catch {
      await emitStepError(
        args,
        'SIGNAL_BLOCKED_INVALID_INPUT',
        'Could not read signal_blocked input payload.',
        startTime,
        'validation',
      );
      return;
    }

    const reason = typeof input['reason'] === 'string' ? input['reason'] : 'Agent is blocked';
    const category = typeof input['category'] === 'string' ? input['category'] : 'other';
    const needed = typeof input['needed'] === 'string' ? input['needed'] : undefined;

    // Session state feeds both the credential-block consume (1b) and the
    let sessionState: SessionHotState | null = null;
    try {
      sessionState = await getSessionState(redis, context.tenantId, context.runId);
    } catch (err) {
      logger.warn(
        `[signalBlocked] failed to read session state for ${context.runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let credentialBlock: McpCredentialBlock | undefined;
    try {
      if (sessionState?.pendingCredentialBlock) {
        credentialBlock = sessionState.pendingCredentialBlock;
        await updateSessionState(redis, context.tenantId, context.runId, {
          pendingCredentialBlock: undefined,
        });
      }
    } catch (err) {
      logger.warn(
        `[signalBlocked] failed to read/clear pendingCredentialBlock for session ${context.runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 2. Build pause prompt
    const promptParts = [reason];
    if (needed) {
      promptParts.push(`Needed: ${needed}`);
    }
    const prompt = promptParts.join('\n');

    // 3. Build requestedInputRef (the pause payload that will be read by
    //    bubbleChildPauseToParent and eventually shown to the Helmsman).
    const pausePayload = {
      payloadKind: SUBAGENT_HANDOFF_PAYLOAD_KIND,
      handoffSource: 'runner-signal-blocked' as const,
      prompt,
      blockingReason: reason,
      blockingCategory: category,
      ...(needed ? { needed } : {}),
      ...(credentialBlock ? { credentialBlock } : {}),
    };
    const requestedInputRef = `inline:${Buffer.from(JSON.stringify(pausePayload)).toString('base64')}`;

    const captureScope = reflectionCaptureScope(sessionState);
    if (captureScope) {
      await markReflectionExpectedSafe(args, captureScope);
    }

    // 4. Emit PAUSED step result with requestedInputRef — the bubble-up chain
    //    reads requestedInputRef (not outputRef) to extract the pause prompt.
    //    See bubbleChildPauseToParent() and SessionOrchestrator.resumeRun().
    await addStepResult(redis, {
      messageVersion: 1,
      tenantId: context.tenantId,
      sessionId: context.runId,
      stepExecutionId,
      parentStepExecutionId: args.parentStepExecutionId ?? null,
      stepId: stepDef.stepId,
      stepType: stepDef.stepType,
      operationId: stepDef.operation as OperationId,
      attempt: args.attempt,
      idempotencyKey: args.idempotencyKey,
      status: 'PAUSED',
      requestedInputRef,
      resolvedInputRef: args.resolvedInputRef,
      durationMs: Date.now() - startTime,
      traceId: context.traceId,
      finishedAtMs: Date.now(),
    });

    logger.info(
      `[signalBlocked] Runner paused for session ${context.runId}: ${reason} (category: ${category})`,
    );

    if (captureScope) {
      const categoryParse = BlockerKindSchema.safeParse(category);
      launchReflectionCapture(args, captureScope, {
        source: 'signal_blocked',
        blocked: {
          category: categoryParse.success ? categoryParse.data : 'other',
          reason,
          ...(needed !== undefined ? { needed } : {}),
        },
      });
    }
  } catch (err) {
    await emitStepError(
      args,
      'SIGNAL_BLOCKED_INTERNAL',
      err instanceof Error ? err.message : String(err),
      startTime,
      'internal',
    );
  }
}
