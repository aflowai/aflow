import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import {
  getDatabase,
  createTenantContext,
  createMemoryDocRepository,
  createMemoryDirRepository,
} from '@aflow/database';
import { CapabilityBindingProposeInputSchema, ApiDefinitionSchema } from '@aflow/schemas';
import {
  resolveProposalRoute,
  proposalDirForRoute,
  runCapabilityBindingProposalValidations,
  isProposalReadinessSafe,
  loadSkillGrantReferencesForApiId,
  synthesizeEndpoints,
  buildDefinitionJsonForDraft,
} from '@aflow/cybernetic-runtime';
import type { InlineHandlerArgs } from './types.js';
import { compileSchemaError } from './agentOutputValidator.js';
import { emitStepSuccess, emitStepError, readInlineOpInput } from './helpers.js';
import { requireSpaceId } from './spaceScope.js';
import { getOrchestratorLogger } from '../../../../lib/orchestratorLogger.js';

// ============================================================================
// Handler
// ============================================================================

export async function handleCapabilityBindingInline(args: InlineHandlerArgs): Promise<void> {
  const startTime = Date.now();
  const logger = getOrchestratorLogger();

  try {
    const spaceId = requireSpaceId(args.context);
    const tenantId = args.context.tenantId;

    let raw: unknown;
    try {
      raw = await readInlineOpInput(args);
    } catch (err) {
      await emitStepError(
        args,
        'CAPABILITY_BINDING_INPUT_READ_FAILED',
        err instanceof Error ? err.message : String(err),
        startTime,
        'configuration',
      );
      return;
    }
    const parsed = CapabilityBindingProposeInputSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      await emitStepError(
        args,
        'CAPABILITY_BINDING_DRAFT_INVALID',
        `API definition draft validation failed: ${issues}`,
        startTime,
        'validation',
      );
      return;
    }
    const defParse = { data: parsed.data.apiDefinition };

    // An explicit draft apiId targets an EXISTING definition (extend/egress
    // edits); otherwise derive the id from the definition name (slugified).
    const apiId =
      defParse.data.apiId ??
      defParse.data.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 64);

    // In-time guard: the draft is valid, but the SYNTHESIZED definition (what
    // apply writes + the executor loads) must satisfy the runtime model schema.
    // The two schemas differ (e.g. draft summary ≤500 vs endpoint name ≤256),
    // and the executor SILENTLY skips an unparseable row → "API definition not
    // found in space". Validate here, with the same builder apply uses, so the
    // bind-capability Runner fails in-session with a clear reason rather than
    // shipping a definition that's invisible at runtime.
    const synthesizedModelDef = buildDefinitionJsonForDraft(apiId, defParse.data);
    const modelCheck = ApiDefinitionSchema.safeParse(synthesizedModelDef);
    if (!modelCheck.success) {
      const issues = modelCheck.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      await emitStepError(
        args,
        'CAPABILITY_BINDING_MODEL_INVALID',
        `The synthesized API definition is not runtime-valid and would be skipped by the executor (appearing as "API definition not found in space"): ${issues}`,
        startTime,
        'validation',
      );
      return;
    }

    // Each body schema must be a compilable JSON Schema — `z.record` accepts any
    // object, so a malformed schema passes the model check above but would throw
    // at the agent-turn tool-arg validator (AiHandler `validateToolArgs`),
    // degrading the promoted tool. Reject it in-session instead.
    for (const ep of modelCheck.data.endpoints) {
      for (const param of ep.params) {
        if (param.location !== 'body' || !param.schema) continue;
        const schemaErr = compileSchemaError(param.schema);
        if (schemaErr) {
          await emitStepError(
            args,
            'CAPABILITY_BINDING_BODY_SCHEMA_INVALID',
            `Endpoint "${ep.endpointId}" body schema is not a valid JSON Schema: ${schemaErr}`,
            startTime,
            'validation',
          );
          return;
        }
      }

      // Response schemas get the same treatment, and for a sharper reason: this
      // is what a simulation generates against. A schema that will not compile
      // is accepted by `z.record` and by the self-containment rule — which reads
      // `$ref`s, not validity — then surfaces much later as an endpoint that is
      // `not_ready` with `response_schema_uncompilable`, on a definition the
      // from-a-brief path has already created. Reject it in-session, where the
      // Runner can still fix it.
      for (const [statusClass, schema] of Object.entries(ep.responseSchemas ?? {})) {
        const schemaErr = compileSchemaError(schema);
        if (schemaErr) {
          await emitStepError(
            args,
            'CAPABILITY_BINDING_RESPONSE_SCHEMA_INVALID',
            `Endpoint "${ep.endpointId}" response schema for '${statusClass}' is not a valid JSON Schema: ${schemaErr}`,
            startTime,
            'validation',
          );
          return;
        }
      }
    }

    // Write the StagedChange
    const proposalId = randomUUID();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const bindOps = [
      {
        op: 'capability.definition.upsert' as const,
        kind: 'api' as const,
        apiId,
        definition: defParse.data,
        rationale: `Bind ${defParse.data.name} (${defParse.data.baseUrl ?? defParse.data.baseUrlTemplate ?? '<no base url>'}) into the space.`,
      },
    ];
    // bind-capability registers tenant-scoped API definitions; no platform
    // workflow target. resolveProposalRoute returns 'tenant_ratification'
    // here, and stays correct if a future platform binding op is introduced.
    const bindRoute = resolveProposalRoute({ ops: bindOps });

    const db = getDatabase();
    const tenantCtx = createTenantContext(tenantId);
    const docRepo = createMemoryDocRepository(db, tenantCtx);
    const dirRepo = createMemoryDirRepository(db, tenantCtx);

    const synthesizedEndpoints = synthesizeEndpoints(defParse.data.endpoints);
    const newEndpointIds = synthesizedEndpoints.map((ep) => ep.endpointId);
    const existingGrants = await loadSkillGrantReferencesForApiId(
      { db, tenantId: tenantId as string, spaceId },
      apiId,
    );
    const validations = runCapabilityBindingProposalValidations(newEndpointIds, existingGrants);
    const overallSafe = isProposalReadinessSafe(validations);

    const baseRationale = `API definition authored by bind-capability. ${String(defParse.data.endpoints.length)} endpoints. Auth: ${defParse.data.authKind}.`;
    const rationale = overallSafe
      ? baseRationale
      : `${baseRationale} WARNING: one or more existing skill grants reference endpoints the new definition does not declare — review the validations block before ratifying.`;

    const stagedChange = {
      id: proposalId,
      kind: 'capability_binding' as const,
      source: 'bind_capability' as const,
      status: 'proposed' as const,
      proposal: {
        summary: `Bind API: ${defParse.data.name}`,
        rationale,
        confidence: 'medium' as const,
        ops: bindOps,
        validations,
      },
      evidence: {
        sourceSessionIds: [args.context.runId],
      },
      authorityLevel: 'require_operator' as const,
      resolutionRoute: bindRoute,
      proposedAt: now,
      expiresAt,
      coachSessionId: args.context.runId,
    };

    const bindPath = `${proposalDirForRoute(bindRoute)}/${proposalId}.json`;
    await dirRepo.ensureParentDirs(bindPath, { spaceId });

    const content = JSON.stringify(stagedChange, null, 2);
    await docRepo.put({
      path: bindPath,
      writeMode: 'create',
      docType: 'json',
      mimeType: 'application/json',
      inlineContent: content,
      payloadRef: null,
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      contentHash: '',
      preview: content.substring(0, 200),
      tags: ['coach', 'staged', 'capability_binding'],
      summary: `Bind API: ${defParse.data.name}`,
      semanticType: 'staged_change',
      indexing: 'disabled',
      scope: { spaceId },
      provenance: { actor: 'system:bind-capability' },
    });

    logger.info(
      `[capabilityBinding] Proposed API binding '${apiId}' (proposal=${proposalId}, endpoints=${String(defParse.data.endpoints.length)})`,
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
          payload: { stagedChangeId: proposalId, kind: 'capability_binding', apiId },
          summary: `API binding "${defParse.data.name}" proposed for review`,
        },
      });
    } catch {
      // Best-effort event emission
    }

    await emitStepSuccess(
      args,
      {
        proposalId,
        apiId,
        status: 'proposed',
        endpointCount: defParse.data.endpoints.length,
        authKind: defParse.data.authKind,
        validations: {
          overallSafe,
          capabilityIssueCount: validations.capability.issues.length,
        },
      },
      startTime,
    );
  } catch (err) {
    logger.error(
      `[capabilityBinding] Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
    await emitStepError(
      args,
      'CAPABILITY_BINDING_INTERNAL',
      err instanceof Error ? err.message : String(err),
      startTime,
      'internal',
    );
  }
}
