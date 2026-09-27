import { randomUUID } from 'node:crypto';
import {
  getDatabase,
  createTenantContext,
  createMemoryDocRepository,
  createMemoryDirRepository,
} from '@aflow/database';
import {
  ProcedureActivationSchema,
  SkillComposeBundleSchema,
  SkillComposeProposeInputSchema,
  SPACE_POLICY_OPERATION_PREFIXES,
  SUBAGENT_HANDOFF_PAYLOAD_KIND,
  getPlatformOperationPrefixes,
  type TaskCapabilityGrant,
} from '@aflow/schemas';
import {
  materializeAndValidateSkillConfig,
  renderSkillDiagnostics,
  checkMissingCapabilities,
  resolveProposalRoute,
  proposalDirForRoute,
} from '@aflow/cybernetic-runtime';
import type { InlineHandlerArgs } from './types.js';
import {
  emitStepSuccess,
  emitStepError,
  emitStepPaused,
  readInlineOpInputRecord,
} from './helpers.js';
import { requireSpaceId } from './spaceScope.js';
import { getOrchestratorLogger } from '../../../../lib/orchestratorLogger.js';

// ============================================================================
// Input loading
// ============================================================================

/**
 * Read the resolved operation input. The workflow engine
 * (`taskHelpers.resolveOperationTaskInputs`) materializes the upstream
 * `assemble-workflow` output into `args.resolvedInputRef` via the
 * validate-and-propose task's `inputBindings: { assembled }` declaration.
 * Reading from there means no run lookup, no concurrent-run leak, and the
 * schema-first contract holds end-to-end.
 */

// ============================================================================
// Handler
// ============================================================================

export async function handleSkillComposeInline(args: InlineHandlerArgs): Promise<void> {
  const startTime = Date.now();
  const logger = getOrchestratorLogger();

  try {
    const spaceId = requireSpaceId(args.context);
    const tenantId = args.context.tenantId;

    const opInput = await readInlineOpInputRecord(args);
    if (!opInput) {
      await emitStepError(
        args,
        'SKILL_COMPOSE_NO_INPUT',
        'Operation input is missing or unparseable. validate-and-propose expects inputBindings { assembled } resolved by the workflow engine.',
        startTime,
        'validation',
      );
      return;
    }

    // Validate against the registered operation input schema.
    const inputParse = SkillComposeProposeInputSchema.safeParse(opInput);
    if (!inputParse.success) {
      const issues = inputParse.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      await emitStepError(
        args,
        'SKILL_COMPOSE_INVALID_INPUT',
        `Operation input failed schema validation: ${issues}`,
        startTime,
        'validation',
      );
      return;
    }

    // Coerce to records for the bundle assembly path which still walks the
    // payload object-style. Zod parsing has already established shape; the
    // record cast just removes the structural type narrowing.
    const assembled = inputParse.data.assembled as unknown as Record<string, unknown>;
    const workflow = assembled['workflow'] as Record<string, unknown> | undefined;
    const rawActivation = assembled['activation'] as Record<string, unknown> | undefined;

    // Activation is optional in the bundle, but when present, the schema
    // requires `triggerPatterns` and `activationHint`. If the Runner produced
    // a partial / malformed activation object, dropping it is strictly better
    // than failing the whole bundle: the Driver's children are already done
    // and re-running them is expensive. Operators can edit activation later
    // via skill management. Log enough detail for the loop to learn from it.
    let activation: ReturnType<typeof ProcedureActivationSchema.safeParse>['data'] | undefined;
    if (rawActivation && typeof rawActivation === 'object') {
      const parsed = ProcedureActivationSchema.safeParse(rawActivation);
      if (parsed.success) {
        activation = parsed.data;
      } else {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ');
        logger.warn(
          `[skill.compose.propose] Dropping malformed activation from assemble-workflow output: ${issues}`,
          { sessionId: args.context.runId, rawActivation },
        );
      }
    }

    if (!workflow || typeof workflow !== 'object') {
      await emitStepError(
        args,
        'SKILL_COMPOSE_INVALID_DESIGN',
        'assemble-workflow output missing "workflow" field or it is not an object.',
        startTime,
        'validation',
      );
      return;
    }

    // Derive manifest fields deterministically (never trust LLM for these)
    const slug = typeof workflow['slug'] === 'string' ? workflow['slug'] : '';
    const name = typeof workflow['name'] === 'string' ? workflow['name'] : slug;
    const mode = typeof workflow['mode'] === 'string' ? workflow['mode'] : 'process';
    const goalText = typeof workflow['goal'] === 'string' ? workflow['goal'] : name;

    // The optimization archetype surfaces a typed numeric `goal` + `campaign`
    // contract from assemble-workflow (Plan 203 §3.3) — author them onto the
    // manifest. Process skills carry neither: the goal lifts from the workflow
    // prose (preprocessed into a subjective rubric by the bundle schema).
    const composedGoal = assembled['goal'];
    const composedCampaign = assembled['campaign'];
    const manifestGoal =
      composedGoal ?? (typeof workflow['goal'] === 'string' ? workflow['goal'] : name);

    const rawBundle = {
      workflow,
      manifest: {
        skillId: slug, // derived from workflow slug, not freehand
        name,
        goal: manifestGoal,
        mode,
        ...(composedCampaign ? { campaign: composedCampaign } : {}),
      },
      ...(activation ? { activation } : {}),
      rationale: `Composed by compose-skill workflow (run ${args.context.runId}).`,
    };

    // Validate the bundle against the schema.
    const bundleParse = SkillComposeBundleSchema.safeParse(rawBundle);
    if (!bundleParse.success) {
      const issues = bundleParse.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');

      await emitStepError(
        args,
        'SKILL_COMPOSE_BUNDLE_INVALID',
        `Bundle validation failed: ${issues}`,
        startTime,
        'validation',
      );
      return;
    }

    const composedBundle = bundleParse.data;
    const { validity } = materializeAndValidateSkillConfig({
      tasks: composedBundle.workflow.tasks,
      stateVariables: composedBundle.workflow.stateVariables,
      output: composedBundle.workflow.output,
      runInputs: composedBundle.workflow.runInputs,
      // Plan 203: pass the mode + campaign context so the optimization
      // archetype-coherence checks (campaign / goal-metric / unbound field /
      // ungated side-effect) run on the assembled bundle.
      mode: composedBundle.workflow.mode,
      campaign: {
        contract: composedBundle.manifest.campaign,
        goal: composedBundle.manifest.goal,
        outcomes: composedBundle.workflow.outcomes,
      },
    });
    if (validity.status === 'invalid') {
      // Separate agent-fixable optimization archetype errors (only checkable
      // post-assembly, so the draft validator can't catch them) from true
      // upstream regressions (should have been caught by draft validators).
      const ASSEMBLY_ONLY_CODES = new Set([
        'placeholder_constant_in_parameterized_skill',
        'campaign_field_unbound',
        'optimization_goal_metric_unresolved',
      ]);
      const assemblyOnlyDiags = validity.diagnostics.filter((d) => ASSEMBLY_ONLY_CODES.has(d.code));
      const regressionDiags = validity.diagnostics.filter((d) => !ASSEMBLY_ONLY_CODES.has(d.code));

      if (assemblyOnlyDiags.length > 0 && regressionDiags.length === 0) {
        // Optimization archetype errors: visible to Helmsman as validation
        // failures so it can instruct the Runner to fix the draft.
        const detail = renderSkillDiagnostics(assemblyOnlyDiags);
        logger.warn(
          `[skill.compose.propose] OPTIMIZATION_VALIDATION sessionId=${args.context.runId}: ` +
            `optimization archetype errors caught post-assembly: ${detail}.`,
        );
        await emitStepError(
          args,
          'BUNDLE_OPTIMIZATION_VALIDATION_FAILED',
          `The assembled optimization archetype failed validation: ${detail}. ` +
            `Fix the draft and retry (regenerate draft-task-graph with corrected optimization fields).`,
          startTime,
          'validation',
          false,
          { diagnostics: assemblyOnlyDiags },
        );
        return;
      }

      const detail = renderSkillDiagnostics(validity.diagnostics);
      logger.error(
        `[skill.compose.propose] BUNDLE_INVARIANT_REGRESSION sessionId=${args.context.runId}: validateWorkflowGraph fired in bundle assembly. ` +
          `These invariants are enforced upstream via the 'workflow-definition' validatorRef on design-skill. ` +
          `Reaching this code path means the producer-side validation did not catch the error. ` +
          `Graph errors: ${detail}.`,
      );
      await emitStepError(
        args,
        'BUNDLE_INVARIANT_REGRESSION',
        `Workflow graph regression: ${detail}. ` +
          `These invariants are enforced upstream via the 'workflow-definition' validatorRef — ` +
          `reaching this point indicates a derivation pipeline bug.`,
        startTime,
        'internal',
        false,
        { diagnostics: validity.diagnostics },
      );
      return;
    }

    // Check for curated context strategy (forbidden in V2)
    for (const task of bundleParse.data.workflow.tasks) {
      if (
        task.context &&
        typeof task.context === 'object' &&
        'strategy' in task.context &&
        task.context.strategy === 'curated'
      ) {
        await emitStepError(
          args,
          'SKILL_COMPOSE_CURATED_FORBIDDEN',
          `Task '${task.taskId}' uses context strategy 'curated', which is reserved for V3.`,
          startTime,
          'validation',
        );
        return;
      }
    }

    // 104n: Reject broad grants in compose-skill output at proposal time.
    // allEndpoints and allTools are reserved for operator-authored exploratory
    // skills. compose-skill must emit specific endpoint/tool grants.
    for (const task of bundleParse.data.workflow.tasks) {
      if (task.context && typeof task.context === 'object') {
        const ctx = task.context as Record<string, unknown>;
        if (ctx['capabilities'] && typeof ctx['capabilities'] === 'object') {
          const caps = ctx['capabilities'] as TaskCapabilityGrant;

          if (Array.isArray(caps.integrations)) {
            for (const grant of caps.integrations) {
              if (grant.allTools) {
                const label = grant.sourceKind === 'api' ? 'API' : 'MCP server';
                await emitStepError(
                  args,
                  'SKILL_COMPOSE_BROAD_GRANT',
                  `Task '${task.taskId}' uses allTools for ${label} '${grant.integrationId}'. ` +
                    `Broad grants are not allowed in compose-skill output. List specific tool names instead.`,
                  startTime,
                  'validation',
                );
                return;
              }
            }
          }
        }
      }
    }

    // 104g Phase 2 + 104n: Resolve referenced capabilities against the space
    // registry. Reject with NeedsCapabilityHandoff if any are missing.
    {
      // Derive required capability prefixes from the bundle (same logic as
      // skillComposeApply.deriveRequiredCapabilities, inlined to avoid
      // importing a private function).
      const PLATFORM_PREFIXES = getPlatformOperationPrefixes();
      const prefixes = new Set<string>();
      const missingByTask = new Map<
        string,
        Array<{ kind: 'api' | 'mcp'; nameOrId: string; endpoints?: string[] }>
      >();

      for (const task of bundleParse.data.workflow.tasks) {
        if (task.operation) {
          const prefix = task.operation.split('.')[0];
          if (prefix && !PLATFORM_PREFIXES.has(prefix)) prefixes.add(prefix);
        }

        if (task.context && typeof task.context === 'object') {
          const ctx = task.context as Record<string, unknown>;
          if (ctx['capabilities'] && typeof ctx['capabilities'] === 'object') {
            const caps = ctx['capabilities'] as TaskCapabilityGrant;
            if (Array.isArray(caps.integrations)) {
              for (const grant of caps.integrations) {
                if (grant.integrationId) prefixes.add(grant.integrationId);
                if (grant.capabilityId && grant.capabilityId !== grant.integrationId) {
                  prefixes.add(grant.capabilityId);
                }
              }
            }
            if (Array.isArray(caps.operations)) {
              for (const op of caps.operations) {
                if (typeof op === 'string') {
                  const prefix = op.split('.')[0];
                  if (prefix && !PLATFORM_PREFIXES.has(prefix)) prefixes.add(prefix);
                }
              }
            }
          }
          if ('tools' in ctx && Array.isArray(ctx['tools'])) {
            for (const tool of ctx['tools'] as unknown[]) {
              if (typeof tool === 'string') {
                const prefix = tool.split('.')[0];
                if (prefix && !PLATFORM_PREFIXES.has(prefix)) prefixes.add(prefix);
              }
            }
          }
        }
      }

      // Check which required capabilities are missing from the space
      const requiredPrefixes = [...prefixes];
      if (requiredPrefixes.length > 0) {
        const db = getDatabase();
        const missingCaps = await checkMissingCapabilities(
          { db, tenantId, spaceId },
          requiredPrefixes,
        );

        // A disabled lane is an operator setting, not a derivation-pipeline
        // bug: no upstream validator could have bound it, and no binding ever
        // will. It gets the same space-settings handoff prepare-design-surface
        // raises, so the run parks instead of failing as an invariant breach.
        const policyMissing = missingCaps.filter((cap) => SPACE_POLICY_OPERATION_PREFIXES.has(cap));
        if (policyMissing.length > 0) {
          const prompt =
            `compose-skill cannot propose this bundle — the space has not enabled: ${policyMissing.join(', ')}. ` +
            'A space admin must switch the lane on in space settings; no binding or credential resolves it.';
          await emitStepPaused(
            args,
            {
              payloadKind: SUBAGENT_HANDOFF_PAYLOAD_KIND,
              handoffSource: 'compose-skill-handoff' as const,
              prompt,
              blockingReason: prompt,
              blockingCategory: 'capability_unavailable',
              kind: 'compose-skill-handoff' as const,
              status: 'blocked' as const,
              reason: 'policy_disabled' as const,
              missing: policyMissing.map((identifier) => ({ kind: 'policy' as const, identifier })),
              handoff: {
                skillSlug: 'space-settings',
                prefill: { policies: policyMissing, enable: true },
              },
            },
            startTime,
          );
          logger.info(
            `[skill.compose.propose] policy_disabled sessionId=${args.context.runId} policies=${policyMissing.join(',')}`,
          );
          return;
        }

        if (missingCaps.length > 0) {
          // Build NeedsCapabilityHandoff: map missing caps back to tasks
          for (const task of bundleParse.data.workflow.tasks) {
            if (!task.context || typeof task.context !== 'object') continue;
            const ctx = task.context as Record<string, unknown>;
            if (ctx['capabilities'] && typeof ctx['capabilities'] === 'object') {
              const caps = ctx['capabilities'] as TaskCapabilityGrant;
              if (Array.isArray(caps.integrations)) {
                for (const grant of caps.integrations) {
                  if (
                    missingCaps.includes(grant.integrationId) ||
                    missingCaps.includes(grant.capabilityId)
                  ) {
                    if (!missingByTask.has(task.taskId)) missingByTask.set(task.taskId, []);
                    if (grant.sourceKind === 'api') {
                      missingByTask.get(task.taskId)!.push({
                        kind: 'api',
                        nameOrId: grant.integrationId,
                        endpoints: grant.toolNames.map((t) => t.toolName),
                      });
                    } else {
                      missingByTask.get(task.taskId)!.push({
                        kind: 'mcp',
                        nameOrId: grant.integrationId,
                      });
                    }
                  }
                }
              }
            }
          }

          // Build the structured handoff — determine kind from task-level data
          const requestedCapabilities = [...new Set(missingCaps)].map((cap) => {
            const taskIds: string[] = [];
            const endpointsOrTools: string[] = [];
            let detectedKind: 'api' | 'mcp' = 'api';
            for (const [taskId, reqs] of missingByTask) {
              for (const req of reqs) {
                if (req.nameOrId === cap || req.nameOrId === cap) {
                  if (!taskIds.includes(taskId)) taskIds.push(taskId);
                  if (req.endpoints) endpointsOrTools.push(...req.endpoints);
                  detectedKind = req.kind;
                }
              }
            }
            return {
              kind: detectedKind,
              nameOrId: cap,
              requiredByTasks: taskIds.length > 0 ? taskIds : ['(derived from operation prefix)'],
              ...(endpointsOrTools.length > 0
                ? { requiredEndpointsOrTools: endpointsOrTools }
                : {}),
              rationale: `Required by skill but no enabled binding found in space.`,
            };
          });

          logger.error(
            `[skill.compose.propose] BUNDLE_INVARIANT_REGRESSION sessionId=${args.context.runId}: ` +
              `checkMissingCapabilities fired in bundle assembly. ` +
              `These references should have been caught upstream by the ` +
              `'capability-references-bound' runtime validator on design-skill. ` +
              `Missing: ${missingCaps.join(', ')}.`,
          );
          await emitStepError(
            args,
            'BUNDLE_INVARIANT_REGRESSION',
            JSON.stringify({
              code: 'BUNDLE_INVARIANT_REGRESSION',
              kind: 'capability-references-bound',
              requestedCapabilities,
              suggestedNextAction: {
                skillSlug: 'bind-capability',
                prefill: {
                  apiNames: missingCaps,
                },
              },
              note: 'This invariant is enforced upstream via the validatorRef on design-skill — reaching this point indicates a derivation-pipeline bug.',
            }),
            startTime,
            'internal',
          );
          return;
        }
      }
    }

    {
      const apiGrants = new Map<
        string,
        Array<{ taskId: string; endpoints: Array<{ endpointId: string }> }>
      >();
      for (const task of bundleParse.data.workflow.tasks) {
        if (!task.context || typeof task.context !== 'object') continue;
        const ctx = task.context as Record<string, unknown>;
        if (ctx['capabilities'] && typeof ctx['capabilities'] === 'object') {
          const caps = ctx['capabilities'] as TaskCapabilityGrant;
          if (Array.isArray(caps.integrations)) {
            for (const grant of caps.integrations) {
              if (grant.sourceKind !== 'api') continue;
              if (grant.toolNames.length === 0) continue;
              if (!apiGrants.has(grant.integrationId)) apiGrants.set(grant.integrationId, []);
              apiGrants.get(grant.integrationId)!.push({
                taskId: task.taskId,
                endpoints: grant.toolNames.map((t) => ({ endpointId: t.toolName })),
              });
            }
          }
        }
      }

      if (apiGrants.size > 0) {
        try {
          const db = getDatabase();
          const tenantCtx = createTenantContext(tenantId);
          const { withTenantSchema, apiDefinitions } = await import('@aflow/database');
          const { inArray, eq, and } = await import('drizzle-orm');
          const rows = await withTenantSchema(db, tenantCtx, async (tx) => {
            return tx
              .select({
                apiId: apiDefinitions.apiId,
                definitionJson: apiDefinitions.definitionJson,
              })
              .from(apiDefinitions)
              .where(
                and(
                  inArray(apiDefinitions.apiId, [...apiGrants.keys()]),
                  eq(apiDefinitions.spaceId, spaceId),
                  eq(apiDefinitions.enabled, 1),
                ),
              );
          });

          const defByApiId = new Map(rows.map((r) => [r.apiId, r]));

          for (const [apiId, grants] of apiGrants) {
            const def = defByApiId.get(apiId);
            if (!def) continue; // Missing API already caught by binding check

            const defJson = def.definitionJson as Record<string, unknown>;
            const defEndpoints = defJson['endpoints'] as Array<Record<string, unknown>> | undefined;
            const availableIds = new Set(
              (defEndpoints ?? [])
                .map((e) => e['endpointId'] as string | undefined)
                .filter(Boolean),
            );

            for (const grant of grants) {
              for (const ep of grant.endpoints) {
                if (!availableIds.has(ep.endpointId)) {
                  await emitStepError(
                    args,
                    'SKILL_COMPOSE_INVALID_ENDPOINT',
                    `Task '${grant.taskId}' grants endpoint '${ep.endpointId}' for API '${apiId}', ` +
                      `but that endpoint does not exist in the definition. ` +
                      `Available: ${[...availableIds].join(', ') || '(none)'}`,
                    startTime,
                    'validation',
                  );
                  return;
                }
              }
            }
          }
        } catch (err) {
          logger.warn(
            `[skillCompose] Endpoint validation failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`,
          );
          // Non-blocking: if the definition lookup fails, let the proposal through.
          // The runtime will catch it at execution time.
        }
      }
    }

    // Write the StagedChange. compose-skill creates a fresh tenant skill, so
    // it always lands on the tenant ratification route (the new skill slug
    // is the bundle's, not a platform slug).
    const proposalId = randomUUID();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days

    const composeOps = [
      {
        op: 'skill_compose' as const,
        bundle: bundleParse.data,
        authoredBySkillId: 'compose-skill',
      },
    ];
    const composeRoute = resolveProposalRoute({ targetSlug: slug, ops: composeOps });

    const stagedChange = {
      id: proposalId,
      kind: 'skill_compose' as const,
      source: 'compose_skill' as const,
      status: 'proposed' as const,
      targetWorkflowSlug: slug,
      proposal: {
        summary: `Create skill: ${name}`,
        rationale: `Authored by compose-skill. Goal: ${goalText}`,
        confidence: 'medium' as const,
        ops: composeOps,
      },
      evidence: {
        sourceSessionIds: [args.context.runId],
      },
      authorityLevel: 'require_operator' as const,
      resolutionRoute: composeRoute,
      proposedAt: now,
      expiresAt,
      coachSessionId: args.context.runId,
    };

    // Write to memory store
    const db = getDatabase();
    const tenantCtx = createTenantContext(tenantId);
    const docRepo = createMemoryDocRepository(db, tenantCtx);
    const dirRepo = createMemoryDirRepository(db, tenantCtx);

    const composePath = `${proposalDirForRoute(composeRoute)}/${proposalId}.json`;
    await dirRepo.ensureParentDirs(composePath, { spaceId });

    const content = JSON.stringify(stagedChange, null, 2);
    await docRepo.put({
      path: composePath,
      writeMode: 'create',
      docType: 'json',
      mimeType: 'application/json',
      inlineContent: content,
      payloadRef: null,
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      contentHash: '',
      preview: content.substring(0, 200),
      tags: ['coach', 'staged', 'skill_compose'],
      summary: `Create skill: ${name}`,
      semanticType: 'staged_change',
      indexing: 'disabled',
      scope: { spaceId },
      provenance: { actor: 'system:compose-skill' },
    });

    logger.info(
      `[skillCompose] Proposed skill '${slug}' (proposal=${proposalId}, tasks=${String(bundleParse.data.workflow.tasks.length)})`,
    );

    try {
      const { appendEntityEvent } = await import('@aflow/redis');
      await appendEntityEvent(args.redis, {
        tenantId,
        spaceId,
        event: {
          eventId: randomUUID(),
          eventType: 'entity.coach.proposal',
          spaceId,
          tenantId,
          timestamp: Date.now(),
          causedBySessionId: args.context.runId,
          causedByStepExecutionId: args.stepExecutionId,
          payload: { stagedChangeId: proposalId, kind: 'skill_compose', targetSlug: slug },
          summary: `Skill "${name}" proposed for review`,
        },
      });
    } catch {
      // Best-effort event emission
    }

    await emitStepSuccess(
      args,
      {
        proposalId,
        skillId: slug,
        status: 'proposed',
        taskCount: bundleParse.data.workflow.tasks.length,
        evalCriteriaCount: bundleParse.data.evalSuite
          ? bundleParse.data.evalSuite.goalCriteria.length +
            bundleParse.data.evalSuite.trajectoryCriteria.length +
            Object.values(bundleParse.data.evalSuite.taskCriteria).reduce(
              (n, arr) => n + arr.length,
              0,
            )
          : 0,
      },
      startTime,
    );
  } catch (err) {
    logger.error(
      `[skillCompose] Unexpected error in skill.compose.propose: ${err instanceof Error ? err.message : String(err)}`,
    );
    await emitStepError(
      args,
      'SKILL_COMPOSE_INTERNAL',
      err instanceof Error ? err.message : String(err),
      startTime,
      'internal',
    );
  }
}
