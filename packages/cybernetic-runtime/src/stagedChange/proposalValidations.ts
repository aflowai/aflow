import type { Workflow, TaskCapabilityGrant, SkillValidity, SkillDiagnostic } from '@aflow/schemas';
import { WorkflowSchema } from '@aflow/schemas';
import { collectOperationTaskApiRefs } from '../operationTaskApiRefs.js';
import {
  materializeAndValidateSkillConfig,
  type SkillCampaignManifestParams,
} from '../skillValidity/skillValidity.js';

// ============================================================================
// Types
// ============================================================================

/**
 * A snapshot of the space's capability bindings, used by the
 * `skillGrantIntegrity` and `capabilityAvailability` checks.
 *
 * The caller (Coach proposal emission, bind-capability emission, etc.) is
 * responsible for assembling this from `api_bindings` + `api_definitions`
 * (and `mcp_server_bindings` for MCP). Keeping the runner pure means tests
 * can construct snapshots inline without touching SQL.
 */
export interface ProposalValidationSnapshot {
  /**
   * Every API binding visible in this space. Each entry MUST list the
   * binding's available endpoint IDs (read from the joined api_definition).
   *
   * Empty when the space has no API bindings — the skillGrantIntegrity check
   * will then surface any grant referencing a binding as a "binding missing"
   * issue, and capabilityAvailability will warn.
   */
  apiBindings: ReadonlyArray<{
    bindingId: string;
    apiId: string;
    /** All endpoint IDs declared by the referenced api_definition. */
    endpointIds: readonly string[];
  }>;
  mcpBindings: ReadonlyArray<{
    bindingId: string;
    serverId: string;
  }>;
}

export interface ProposalReadiness {
  contract: SkillValidity;
  capability: {
    issues: string[];
    warnings: string[];
  };
}

/** True iff the proposal is contract-valid AND has no hard capability issues. */
export function isProposalReadinessSafe(r: ProposalReadiness): boolean {
  return r.contract.status === 'valid' && r.capability.issues.length === 0;
}

/** Non-blocking hints: contract advisories + soft capability warnings. */
export function proposalReadinessWarningCount(r: ProposalReadiness): number {
  return r.contract.advisories.length + r.capability.warnings.length;
}

/** Blocking signals: contract error diagnostics + hard capability issues. */
export function proposalReadinessBlockerCount(r: ProposalReadiness): number {
  return r.contract.diagnostics.length + r.capability.issues.length;
}

// ============================================================================
// Semantic-consistency heuristic
// ============================================================================

function checkSemanticConsistency(workflow: Workflow): string[] {
  const warnings: string[] = [];
  const INPUT_REF = /\binputs\.([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const task of workflow.tasks) {
    const declaredKeys = new Set(Object.keys(task.inputBindings ?? {}));
    const referencedKeys = new Set<string>();
    let match: RegExpExecArray | null;
    INPUT_REF.lastIndex = 0;
    while ((match = INPUT_REF.exec(task.goal)) !== null) {
      const key = match[1];
      if (key) referencedKeys.add(key);
    }
    for (const key of referencedKeys) {
      if (!declaredKeys.has(key)) {
        warnings.push(
          `Task "${task.taskId}".goal references \`inputs.${key}\` but ${
            declaredKeys.size === 0
              ? 'the task declares no inputBindings'
              : `\`inputs.${key}\` is not in inputBindings (declared: ${[...declaredKeys].join(', ')})`
          }.`,
        );
      }
    }
  }
  return warnings;
}

// ============================================================================
// Skill-grant integrity + capability availability
// ============================================================================

interface GrantIntegrityResult {
  issues: string[];
  warnings: string[];
}

export function checkGrantIntegrity(
  workflow: Workflow,
  snapshot: ProposalValidationSnapshot,
): GrantIntegrityResult {
  const bindingsById = new Map(snapshot.apiBindings.map((b) => [b.bindingId, b]));
  const mcpBindingsById = new Map(snapshot.mcpBindings.map((b) => [b.bindingId, b]));
  const issues: string[] = [];
  const warnings: string[] = [];

  for (const task of workflow.tasks) {
    const grants = (task.context as { capabilities?: TaskCapabilityGrant } | undefined)
      ?.capabilities;
    if (!grants) continue;

    for (const grant of grants.integrations ?? []) {
      // A connection-deferred grant carries no fixed binding to check for
      // present-in-space; it resolves at dispatch to the run's pinned connection.
      if (grant.binding.kind === 'connection') continue;
      const grantBindingId = grant.binding.bindingId;
      if (grant.sourceKind === 'api') {
        const binding = bindingsById.get(grantBindingId);
        if (!binding) {
          warnings.push(
            `Task "${task.taskId}" grants API binding "${grantBindingId}" (apiId="${grant.integrationId}") which is not present in this space.`,
          );
          continue;
        }
        if (grant.allTools) continue;
        const knownEndpointIds = new Set(binding.endpointIds);
        for (const t of grant.toolNames) {
          if (!knownEndpointIds.has(t.toolName)) {
            issues.push(
              `Task "${task.taskId}" grants endpoint "${t.toolName}" on binding "${grantBindingId}" but the binding's API definition declares no such endpoint.`,
            );
          }
        }
      } else {
        if (!mcpBindingsById.has(grantBindingId)) {
          warnings.push(
            `Task "${task.taskId}" grants MCP binding "${grantBindingId}" (serverId="${grant.integrationId}") which is not present in this space.`,
          );
        }
      }
    }
  }

  // api.http.call operation tasks reference a binding via inputTemplate, not a
  // context grant — check those too so a missing direct-URL binding, a binding
  // belonging to a different apiId, or an endpoint absent from the definition is
  // caught at propose time.
  const endpointIdsByApiId = new Map<string, Set<string>>();
  for (const b of snapshot.apiBindings) {
    let set = endpointIdsByApiId.get(b.apiId);
    if (!set) {
      set = new Set();
      endpointIdsByApiId.set(b.apiId, set);
    }
    for (const e of b.endpointIds) set.add(e);
  }
  for (const ref of collectOperationTaskApiRefs(workflow.tasks)) {
    if (ref.bindingId) {
      const binding = bindingsById.get(ref.bindingId);
      if (!binding) {
        warnings.push(
          `Task "${ref.taskId}" calls api.http.call against binding "${ref.bindingId}" (apiId="${ref.apiId}") which is not present in this space.`,
        );
        continue;
      }
      if (binding.apiId !== ref.apiId) {
        issues.push(
          `Task "${ref.taskId}" calls api.http.call with apiId="${ref.apiId}" + bindingId="${ref.bindingId}", but that binding belongs to apiId="${binding.apiId}".`,
        );
      }
      if (ref.endpointId && !new Set(binding.endpointIds).has(ref.endpointId)) {
        issues.push(
          `Task "${ref.taskId}" calls api.http.call endpoint "${ref.endpointId}" on binding "${ref.bindingId}" but the binding's API definition declares no such endpoint.`,
        );
      }
    } else if (ref.endpointId) {
      // Endpoint-mode call without an explicit bindingId — the binding resolves
      // at runtime, but the endpoint must still exist on the apiId's definition.
      const known = endpointIdsByApiId.get(ref.apiId);
      if (known && !known.has(ref.endpointId)) {
        issues.push(
          `Task "${ref.taskId}" calls api.http.call endpoint "${ref.endpointId}" on apiId="${ref.apiId}" but the API definition declares no such endpoint.`,
        );
      }
    }
  }

  return { issues, warnings };
}

// ============================================================================
// Top-level entry
// ============================================================================

// ============================================================================

export interface ExistingSkillGrantReference {
  /** Skill that holds the grant (slug — for operator-facing error text). */
  skillSlug: string;
  /** Task in the skill's workflow that grants the endpoint. */
  taskId: string;
  /** apiId the grant points at — only refs matching the upsert's apiId
   *  should be collected by the caller. */
  apiId: string;
  /** Endpoint IDs the task's grant references (post-synthesis, stable). */
  grantedEndpointIds: readonly string[];
}

/**
 * Validate a `capability_binding` proposal. Pure function over the proposed
 * API definition + a snapshot of existing skill grants against the same
 * apiId. The caller is responsible for loading the snapshot (see
 * `loadSkillGrantReferencesForApiId` in loadCapabilitySnapshot.ts).
 *
 * Only `skillGrantIntegrity` carries signal here: every other check on the
 * workflow-focused block is trivially "passed" (no workflow / graph / port
 * surface to validate). The shape is kept identical to the workflow runner
 * so the UI checklist renderer is the same.
 */
export function runCapabilityBindingProposalValidations(
  newEndpointIds: readonly string[],
  existingGrants: readonly ExistingSkillGrantReference[],
): ProposalReadiness {
  const knownIds = new Set(newEndpointIds);
  const issues: string[] = [];
  for (const grant of existingGrants) {
    for (const id of grant.grantedEndpointIds) {
      if (!knownIds.has(id)) {
        issues.push(
          `Skill "${grant.skillSlug}" task "${grant.taskId}" grants endpoint "${id}" on apiId="${grant.apiId}", but the proposed definition does not declare it. Ratifying this upsert will leave the grant unresolved (the projection will surface it as missing_endpoint).`,
        );
      }
    }
  }
  // No workflow to validate — the contract is trivially valid; the only signal
  // is the SPACE-dependent capability axis (grants that would be left dangling).
  return {
    contract: validContract(),
    capability: { issues: issues.slice(0, 20), warnings: [] },
  };
}

/** A trivially-valid contract verdict (no workflow / graph surface to check). */
function validContract(): SkillValidity {
  return {
    status: 'valid',
    diagnostics: [],
    advisories: [],
    validatedAt: new Date().toISOString(),
  };
}

export function runWorkflowProposalValidations(
  proposedWorkflow: unknown,
  snapshot: ProposalValidationSnapshot,
  campaign?: SkillCampaignManifestParams,
): ProposalReadiness {
  // (1) Schema check — short-circuit downstream checks if the doc doesn't
  //     even parse, since they would otherwise crash on undefined fields. The
  //     failure IS the contract's `parse` dimension.
  const schemaParse = WorkflowSchema.safeParse(proposedWorkflow);
  if (!schemaParse.success) {
    const diagnostics: SkillDiagnostic[] = schemaParse.error.issues.slice(0, 20).map((iss) => {
      const path = iss.path.length > 0 ? `${iss.path.join('.')}: ` : '';
      return {
        code: 'workflow_parse_failed',
        dimension: 'parse',
        severity: 'error',
        detail: `${path}${iss.message}`,
      };
    });
    return {
      contract: {
        status: 'invalid',
        diagnostics,
        advisories: [],
        validatedAt: new Date().toISOString(),
      },
      capability: { issues: [], warnings: [] },
    };
  }

  const workflow = schemaParse.data;

  const { materializedTasks, validity } = materializeAndValidateSkillConfig({
    tasks: workflow.tasks,
    stateVariables: workflow.stateVariables,
    runInputs: workflow.runInputs,
    ...(campaign ? { campaign: { ...campaign, outcomes: workflow.outcomes } } : {}),
  });
  workflow.tasks = materializedTasks;

  // (3) Semantic-consistency heuristic (soft) → contract advisories (§8 —
  //     "semantic → advisories"). Non-blocking; status is unchanged.
  const semanticAdvisories: SkillDiagnostic[] = checkSemanticConsistency(workflow).map(
    (detail) => ({
      code: 'semantic_input_ref',
      dimension: 'semantic',
      severity: 'advisory',
      detail,
    }),
  );

  // (4) Skill-grant integrity (hard) + capability-availability (soft) — the
  //     SPACE-dependent capability axis, kept off the contract verdict.
  const grantResult = checkGrantIntegrity(workflow, snapshot);

  return {
    contract: {
      ...validity,
      advisories: [...validity.advisories, ...semanticAdvisories],
    },
    capability: {
      issues: grantResult.issues.slice(0, 20),
      warnings: grantResult.warnings.slice(0, 20),
    },
  };
}
