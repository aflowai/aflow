/**
 * Skill Compose Apply — 104f Phase 2.
 *
 * Ratification handler for `skill_compose` proposals. Atomically creates
 * all artifacts in the skill bundle: Workflow, SkillManifest, EvalSuite,
 * and ProcedureActivation (when present).
 *
 * Plugs into the shared ratification engine (`applyRatifiedOps`) via the
 * kind-level dispatch added to that module. Not a standalone ratifier —
 * reusable infrastructure.
 *
 * Atomicity: all artifacts are validated and assembled in memory first.
 * Writes happen at the end and use `upsert` so retries are safe. If any
 * write fails, the proposal stays `proposed` at the caller level and the
 * operator can retry or reject. Partial state is benign because:
 * - All writes are upserts (idempotent on retry)
 * - The SkillProjectionReconciler picks up the manifest only after it
 *   and its workflow both exist
 * - No downstream consumer acts until `entity.coach.ratified` is emitted,
 *   which happens only after all writes succeed
 *
 * Single-writer: this module writes workflow docs, skill manifests, and
 * eval suite docs. It does NOT write `causal_measurements` — that is
 * sole-writer `causalBinder`, triggered by `entity.coach.ratified`.
 *
 * @packageDocumentation
 */
import type {
  TenantId,
  SkillManifest,
  SkillComposeBundle,
  SkillOrigin,
  StagedChange,
} from '@aflow/schemas';
import {
  SkillComposeBundleSchema,
  WorkflowSchema,
  getPlatformOperationPrefixes,
  CODE_REPO_CAPABILITY_ID,
  laneCapabilityTokensForTask,
  subsumeLaneTokens,
  type TaskCapabilityGrant,
} from '@aflow/schemas';
import { createTenantContext, createMemoryDocRepository } from '@aflow/database';
import { getCyberneticLogger } from '../logger.js';
import { collectOperationTaskApiRefs } from '../operationTaskApiRefs.js';
import { upsertSkillManifest } from '../skill.js';
import {
  materializeAndValidateSkillConfig,
  renderSkillDiagnostics,
} from '../skillValidity/skillValidity.js';
import type { ApplyContext, ApplyResult } from './applyRatifiedOps.js';
import { RatificationApplyError } from './applyRatifiedOps.js';

// ============================================================================
// Paths
// ============================================================================

export function workflowDocPath(slug: string): string {
  return `/workflows/${slug}/workflow.json`;
}

export function evalSuiteDocPath(slug: string): string {
  return `/evals/${slug}/suite.json`;
}

export function activationDocPath(slug: string): string {
  return `/workflows/${slug}/activation.json`;
}

export const DEFAULT_ITERATION_POLICY = {
  auto: false,
  maxConsecutiveRuns: 5,
  stopOnOutcomesMet: true,
  cooldownMs: 0,
} as const;

/**
 * Materialize + validate a compose bundle's workflow config with the full
 * bundle/campaign context — the single derivation every path that persists
 * (or hashes) a bundle's workflow doc must run first.
 */
export function materializeSkillComposeBundle(
  bundle: SkillComposeBundle,
): ReturnType<typeof materializeAndValidateSkillConfig> {
  return materializeAndValidateSkillConfig({
    tasks: bundle.workflow.tasks,
    stateVariables: bundle.workflow.stateVariables,
    output: bundle.workflow.output,
    runInputs: bundle.workflow.runInputs,
    bundle: {
      uiOutput: bundle.manifest.uiOutput,
      taskCriteria: bundle.evalSuite?.taskCriteria,
      evalSuite: bundle.evalSuite,
    },
    campaign: {
      contract: bundle.manifest.campaign,
      goal: bundle.manifest.goal,
      outcomes: bundle.workflow.outcomes,
      goalCriteria: bundle.evalSuite?.goalCriteria,
      trajectoryCriteria: bundle.evalSuite?.trajectoryCriteria,
    },
  });
}

export interface SkillWorkflowDocIdentity {
  id: string;
  status: string;
  origin: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Assemble the full workflow doc from a (materialized) compose bundle plus
 * the identity/lifecycle fields the caller owns. Install mints a fresh
 * identity; update preserves the existing one and bumps the revision; content
 * hashing pins a fixed identity and strips it back out — all three must agree
 * on this shape byte-for-byte.
 */
export function buildSkillWorkflowDoc(
  bundle: SkillComposeBundle,
  identity: SkillWorkflowDocIdentity,
): Record<string, unknown> {
  // Activation: single source of truth is bundle.activation (top-level).
  // ComposedWorkflowSchema intentionally omits activation to prevent
  // two sources of truth; it is copied onto the workflow doc here.
  return {
    id: identity.id,
    ...bundle.workflow,
    ...(bundle.activation !== undefined ? { activation: bundle.activation } : {}),
    iteration: bundle.workflow.iteration ?? DEFAULT_ITERATION_POLICY,
    status: identity.status,
    origin: identity.origin,
    revision: identity.revision,
    createdAt: identity.createdAt,
    updatedAt: identity.updatedAt,
  };
}

// ============================================================================
// Extract + validate
// ============================================================================

/**
 * Extract and validate the skill_compose bundle from a StagedChange.
 *
 * Enforces invariants:
 * - Exactly 1 op with `op === 'skill_compose'`
 * - Bundle passes `SkillComposeBundleSchema`
 * - Workflow graph passes `validateWorkflowGraph`
 * - Task-scoped eval criteria reference only valid taskIds
 * - No task declares `context.strategy: 'curated'` (reserved for 105)
 */
export function extractAndValidateBundle(sc: StagedChange): SkillComposeBundle {
  // -- Exactly 1 op invariant ------------------------------------------------
  if (sc.proposal.ops.length !== 1) {
    throw new RatificationApplyError(
      'skill_compose',
      `skill_compose proposal must have exactly 1 op, got ${String(sc.proposal.ops.length)}`,
    );
  }
  const op = sc.proposal.ops[0]!;
  if (op.op !== 'skill_compose') {
    throw new RatificationApplyError('skill_compose', `Expected skill_compose op, got '${op.op}'`);
  }

  // -- Re-validate bundle at apply time (defense in depth) -------------------
  const bundleParse = SkillComposeBundleSchema.safeParse(op.bundle);
  if (!bundleParse.success) {
    throw new RatificationApplyError(
      'skill_compose',
      `Bundle validation failed at apply time: ${bundleParse.error.message}`,
    );
  }
  const bundle = bundleParse.data;

  const { materializedTasks, validity } = materializeSkillComposeBundle(bundle);
  if (validity.status === 'invalid') {
    throw new RatificationApplyError(
      'skill_compose',
      `Skill contract validation failed:\n${renderSkillDiagnostics(validity.diagnostics)}`,
    );
  }
  bundle.workflow.tasks = materializedTasks;

  // -- 104n: Reject broad grants in compose-skill output --------------------
  // allEndpoints and allTools are reserved for operator-authored exploratory
  // skills and bind-capability. compose-skill must emit specific grants. This
  // is a compose-output policy (not a contract-validity dimension), so it
  // stays a dedicated check rather than moving into the shared function.
  for (const task of bundle.workflow.tasks) {
    if (task.context && typeof task.context === 'object') {
      const ctx = task.context as Record<string, unknown>;
      if (ctx['capabilities'] && typeof ctx['capabilities'] === 'object') {
        const caps = ctx['capabilities'] as TaskCapabilityGrant;

        if (Array.isArray(caps.integrations)) {
          for (const grant of caps.integrations) {
            if (grant.allTools) {
              const label = grant.sourceKind === 'api' ? 'API' : 'MCP server';
              throw new RatificationApplyError(
                'skill_compose',
                `Task '${task.taskId}' uses allTools for ${label} '${grant.integrationId}'. ` +
                  `Broad grants are not allowed in compose-skill output. ` +
                  `List specific tool names instead.`,
              );
            }
          }
        }
      }
    }
  }

  return bundle;
}

// ============================================================================
// Required capabilities derivation (104g read-path)
// ============================================================================

/**
 * Unconditionally available platform operation prefixes.
 *
 * Derived from the operation registry minus
 * `SPACE_POLICY_OPERATION_PREFIXES`. The previous
 * hand-written list missed `ai`, `mcp`, `api`, etc., letting those
 * prefixes leak into `requiredCapabilities` when a task referenced
 * `ai.text.generate` — derivation downstream then surfaced phantom
 * "missing binding" errors. Sourcing from the registry keeps this
 * declaration aligned with the platform's actual built-ins as new step
 * types are added.
 */
const PLATFORM_PREFIXES = getPlatformOperationPrefixes();

export function deriveRequiredCapabilities(bundle: SkillComposeBundle): string[] {
  const prefixes = new Set<string>();

  for (const task of bundle.workflow.tasks) {
    // Operation-type tasks: the operation ID itself
    if (task.operation) {
      const prefix = task.operation.split('.')[0];
      if (prefix) prefixes.add(prefix);
      // Plan 222 P2: every code.* op resolves a repo designation → the skill needs
      // a ready repo. Distinct from the `code` prefix itself, which survives the
      // filter below as the space's coding-lane policy gate.
      if (prefix === 'code') prefixes.add(CODE_REPO_CAPABILITY_ID);
      for (const token of laneCapabilityTokensForTask(task)) prefixes.add(token);
    }

    if (task.context && typeof task.context === 'object') {
      const ctx = task.context as Record<string, unknown>;

      // 104n: structured capability grants
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

        // Operation grants → extract prefix
        if (Array.isArray(caps.operations)) {
          for (const op of caps.operations) {
            if (typeof op === 'string') {
              const prefix = op.split('.')[0];
              if (prefix) prefixes.add(prefix);
              if (prefix === 'code') prefixes.add(CODE_REPO_CAPABILITY_ID);
              for (const token of laneCapabilityTokensForTask({ operation: op })) {
                prefixes.add(token);
              }
            }
          }
        }
      }

      // Legacy: context.tools array
      if ('tools' in ctx) {
        const tools = ctx['tools'];
        if (Array.isArray(tools)) {
          for (const tool of tools) {
            if (typeof tool === 'string') {
              const prefix = tool.split('.')[0];
              if (prefix) prefixes.add(prefix);
            }
          }
        }
      }
    }
  }

  // api.http.call operation tasks reference a binding via inputTemplate, not a
  // context grant — fold those in. Add BOTH the apiId and the exact bindingId
  // (parity with context grants, which add capabilityId=bindingId) so readiness
  // checks the specific binding, not just "some binding for this apiId exists"
  // checkMissingCapabilities matches bindingId exactly.
  for (const ref of collectOperationTaskApiRefs(bundle.workflow.tasks)) {
    prefixes.add(ref.apiId);
    if (ref.bindingId) prefixes.add(ref.bindingId);
  }

  // Exclude platform prefixes — they're always available
  return subsumeLaneTokens([...prefixes].filter((p) => !PLATFORM_PREFIXES.has(p))).sort();
}

// ============================================================================
// Apply handler
// ============================================================================

/**
 * Options for `applySkillComposeBundle`. Defaults produce the standard
 * agent-composed behavior; catalog install overrides origin + provenance.
 */
export interface ApplySkillComposeBundleOptions {
  /** Origin for both the manifest and the workflow. Defaults to `'operator'`. */
  origin?: SkillOrigin;
  provenance?: {
    sourceCatalogId: string;
    sourceVersion: number;
    installedAt: string;
  };
}

export async function applySkillComposeBundle(
  ctx: ApplyContext,
  bundle: SkillComposeBundle,
  opts?: ApplySkillComposeBundleOptions,
): Promise<ApplyResult> {
  const logger = getCyberneticLogger();
  const result: ApplyResult = {
    applied: false,
    appliedOps: [],
    skippedOps: [],
  };

  const slug = bundle.workflow.slug;
  const tenantCtx = createTenantContext(ctx.tenantId as TenantId);
  const repo = createMemoryDocRepository(ctx.db, tenantCtx, {
    inTransaction: ctx.inTransaction ?? false,
  });

  // -- Slug conflict guard (active only) -------------------------------------
  const wfPath = workflowDocPath(slug);
  const existingWf = await repo.getByPath(wfPath, ctx.spaceId, { includeDeleted: true });
  const revivingArchivedSkill = existingWf !== null && existingWf.deletedAt !== null;
  if (existingWf !== null && existingWf.deletedAt === null) {
    throw new RatificationApplyError(
      'skill_compose',
      `Workflow '${slug}' already exists. Use workflow refinement to modify existing skills.`,
    );
  }

  const installCheck = materializeSkillComposeBundle(bundle);
  if (installCheck.validity.status === 'invalid') {
    throw new RatificationApplyError(
      'skill_compose',
      `Skill contract validation failed at install:\n${renderSkillDiagnostics(installCheck.validity.diagnostics)}`,
    );
  }
  bundle.workflow.tasks = installCheck.materializedTasks;

  // -- Build the full Workflow document (add platform fields) -----------------
  const now = new Date().toISOString();
  const workflowDoc = buildSkillWorkflowDoc(bundle, {
    id: crypto.randomUUID(),
    status: 'approved',
    origin: (opts?.origin ?? 'operator') as string,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });

  // Validate the full workflow against WorkflowSchema
  const wfParse = WorkflowSchema.safeParse(workflowDoc);
  if (!wfParse.success) {
    throw new RatificationApplyError(
      'skill_compose',
      `Full workflow fails WorkflowSchema: ${wfParse.error.message}`,
    );
  }

  // -- Derive requiredCapabilities from task operations + context.tools ------
  const requiredCapabilities = deriveRequiredCapabilities(bundle);

  // -- Build SkillManifest ---------------------------------------------------
  const origin = opts?.origin ?? 'operator';
  const manifest: SkillManifest = {
    schemaVersion: 2,
    skillId: bundle.manifest.skillId,
    name: bundle.manifest.name,
    goal: bundle.manifest.goal,
    ...(bundle.manifest.campaign !== undefined ? { campaign: bundle.manifest.campaign } : {}),
    ...(bundle.manifest.concurrency !== undefined
      ? { concurrency: bundle.manifest.concurrency }
      : {}),
    mode: bundle.manifest.mode,
    origin,
    workflowSlug: slug,
    evalSuiteRef: bundle.evalSuite ? evalSuiteDocPath(slug) : undefined,
    activationRef: bundle.activation ? `/workflows/${slug}/activation.json` : undefined,
    requiredCapabilities,
    ...(opts?.provenance && {
      sourceCatalogId: opts.provenance.sourceCatalogId,
      sourceVersion: opts.provenance.sourceVersion,
      installedAt: opts.provenance.installedAt,
    }),
    createdAt: now,
    updatedAt: now,
  };

  // -- All validation passed — write artifacts (upsert for retry safety) ------

  // 1. Workflow doc
  const wfJson = JSON.stringify(wfParse.data, null, 2);
  const wfBytes = Buffer.byteLength(wfJson, 'utf8');
  await repo.put({
    path: wfPath,
    writeMode: 'upsert' as const,
    docType: 'json',
    mimeType: 'application/json',
    inlineContent: wfJson,
    payloadRef: null,
    sizeBytes: wfBytes,
    contentHash: '',
    preview: wfJson.substring(0, 200),
    tags: ['workflow'],
    summary: `Workflow created by skill_compose ratification`,
    semanticType: 'workflow',
    indexing: 'disabled',
    scope: { spaceId: ctx.spaceId },
    provenance: { actor: 'system:skill-compose-ratification' },
  });

  // 2. SkillManifest
  await upsertSkillManifest(
    {
      db: ctx.db,
      tenantId: ctx.tenantId,
      spaceId: ctx.spaceId,
      ...(ctx.inTransaction ? { inTransaction: true } : {}),
    },
    manifest,
  );

  // 3. EvalSuite
  if (bundle.evalSuite) {
    const evalJson = JSON.stringify(bundle.evalSuite, null, 2);
    const evalBytes = Buffer.byteLength(evalJson, 'utf8');
    await repo.put({
      path: evalSuiteDocPath(slug),
      writeMode: 'upsert' as const,
      docType: 'json',
      mimeType: 'application/json',
      inlineContent: evalJson,
      payloadRef: null,
      sizeBytes: evalBytes,
      contentHash: '',
      preview: evalJson.substring(0, 200),
      tags: ['eval', 'suite'],
      summary: `Eval suite created by skill_compose ratification`,
      semanticType: 'eval_suite',
      indexing: 'disabled',
      scope: { spaceId: ctx.spaceId },
      provenance: { actor: 'system:skill-compose-ratification' },
    });
  }

  // 4. ProcedureActivation (optional, separate doc for dedicated lookups)
  if (bundle.activation) {
    const actJson = JSON.stringify(bundle.activation, null, 2);
    const actBytes = Buffer.byteLength(actJson, 'utf8');
    await repo.put({
      path: `/workflows/${slug}/activation.json`,
      writeMode: 'upsert' as const,
      docType: 'json',
      mimeType: 'application/json',
      inlineContent: actJson,
      payloadRef: null,
      sizeBytes: actBytes,
      contentHash: '',
      preview: actJson.substring(0, 200),
      tags: ['activation'],
      summary: `Activation pattern created by skill_compose ratification`,
      semanticType: 'procedure_activation',
      indexing: 'disabled',
      scope: { spaceId: ctx.spaceId },
      provenance: { actor: 'system:skill-compose-ratification' },
    });
  }

  result.applied = true;
  result.appliedOps.push('skill_compose');

  logger.info(
    `[applySkillComposeBundle] ${revivingArchivedSkill ? 'Revived archived' : 'Created'} skill ` +
      `'${bundle.manifest.skillId}' (workflow=${slug}, ` +
      `evalCriteria=${String(bundle.evalSuite ? bundle.evalSuite.goalCriteria.length + bundle.evalSuite.trajectoryCriteria.length : 0)}, ` +
      `activation=${String(!!bundle.activation)})`,
  );

  return result;
}
