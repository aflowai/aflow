/**
 * Merged registry of all operations.
 *
 * Consumes OperationRegistration[] arrays from each step type,
 * computes operationId from structural fields, and produces
 * OperationDescriptor entries keyed by operationId.
 */
import type { OperationDescriptor, OperationRegistration } from './operationCatalog.js';
import type { CapabilityAccessMode, RiskModifier } from './capabilityGroups.js';
import { buildOperationId, buildGroupId, validateSegment } from './operationId.js';
import { StepTypeSchema } from '../artifact/operationDefinition.js';
import { StepImageOutputPathsSchema } from '../media/stepImage.js';
import { OperationObservationSchema } from '../runtime/toolObservation.js';

import { AiOperationRegistrations } from '../operations/ai.js';
import { ApiOperationRegistrations } from '../operations/api.js';
import { MemoryOperationRegistrations } from '../operations/memory.js';
import { UserOperationRegistrations } from '../operations/user.js';
import { SearchOperationRegistrations } from '../operations/search.js';
import { ComputeOperationRegistrations } from '../operations/compute.js';
import { HostOperationRegistrations } from '../operations/hostRegistrations.js';
import { BrowserPageActionRegistrations } from '../operations/browser.js';
import { BrowserObservationRegistrations } from '../operations/browserObservation.js';
import { BrowserWindowRegistrations } from '../operations/browserWindow.js';
import { AgentOperationRegistrations } from '../operations/agentControl.js';
import { PlatformOperationRegistrations } from '../operations/platform.js';
import { GuardrailOperationRegistrations } from '../operations/guardrailOps.js';
import { UiOperationRegistrations } from '../operations/ui.js';
import { DesignSystemOperationRegistrations } from '../operations/designSystem.js';
import { McpOperationRegistrations } from '../operations/mcp.js';
import { ScheduleOperationRegistrations } from '../schedules/operations.js';
import { WebhookOperationRegistrations } from '../webhooks/operations.js';
import { WorkflowOperationRegistrations } from '../operations/workflow.js';
import { LearnerOperationRegistrations } from '../operations/learner.js';
import { ProposalOperationRegistrations } from '../operations/proposal.js';
import { SkillOperationRegistrations } from '../operations/skill.js';
import { ComposeSkillOperationRegistrations } from '../operations/composeSkillOps.js';
import { CapabilityOperationRegistrations } from '../operations/capability.js';
import { IntegrationOperationRegistrations } from '../operations/integration.js';
import { SimulationOperationRegistrations } from '../operations/simulation.js';
import { HumanOperationRegistrations } from '../operations/human.js';
import { CodeOperationRegistrations } from '../operations/code.js';
import { StoreListingOperationRegistrations } from '../operations/store.js';
import { AppletOperationRegistrations } from '../applet/operations.js';
import { EvalOperationRegistrations } from '../operations/evalOps.js';
import { EvalBatchOperationRegistrations } from '../operations/evalBatchOps.js';
import { PlanOperationRegistrations } from '../operations/plan/registrations.js';

// ============================================================================
// Aggregate all registrations
// ============================================================================

const ALL_REGISTRATIONS: OperationRegistration[] = [
  ...AiOperationRegistrations,
  ...ApiOperationRegistrations,
  ...MemoryOperationRegistrations,
  ...UserOperationRegistrations,
  ...SearchOperationRegistrations,
  ...ComputeOperationRegistrations,
  ...HostOperationRegistrations,
  ...BrowserPageActionRegistrations,
  ...BrowserObservationRegistrations,
  ...BrowserWindowRegistrations,
  ...AgentOperationRegistrations,
  ...PlatformOperationRegistrations,
  ...GuardrailOperationRegistrations,
  ...UiOperationRegistrations,
  ...DesignSystemOperationRegistrations,
  ...McpOperationRegistrations,
  ...ScheduleOperationRegistrations,
  ...WebhookOperationRegistrations,
  ...WorkflowOperationRegistrations,
  ...LearnerOperationRegistrations,
  ...ProposalOperationRegistrations,
  ...SkillOperationRegistrations,
  ...ComposeSkillOperationRegistrations,
  ...CapabilityOperationRegistrations,
  ...IntegrationOperationRegistrations,
  ...SimulationOperationRegistrations,
  ...HumanOperationRegistrations,
  ...CodeOperationRegistrations,
  ...StoreListingOperationRegistrations,
  ...AppletOperationRegistrations,
  ...EvalOperationRegistrations,
  ...EvalBatchOperationRegistrations,
  ...PlanOperationRegistrations,
];

// ============================================================================
// Build-time validation
// ============================================================================

const VALID_STEP_TYPES = new Set(StepTypeSchema.options);

function validateRegistration(reg: OperationRegistration): void {
  if (!VALID_STEP_TYPES.has(reg.stepType)) {
    throw new Error(
      `Invalid stepType "${reg.stepType}" — must be one of: ${[...VALID_STEP_TYPES].join(', ')}`,
    );
  }
  if (reg.group !== null) {
    validateSegment(reg.group, 'group');
  }
  validateSegment(reg.verb, 'verb');
  if (reg.imageOutputPaths !== undefined) {
    const paths = StepImageOutputPathsSchema.safeParse(reg.imageOutputPaths);
    if (!paths.success) {
      throw new Error(
        `Invalid imageOutputPaths on "${buildOperationId(reg.stepType, reg.group, reg.verb)}": ${paths.error.message}`,
      );
    }
  }
  if (reg.observation !== undefined) {
    const observation = OperationObservationSchema.safeParse(reg.observation);
    if (!observation.success) {
      throw new Error(
        `Invalid observation on "${buildOperationId(reg.stepType, reg.group, reg.verb)}": ${observation.error.message}`,
      );
    }
  }
}

// ============================================================================
// Merged Registry (lazy singleton)
// ============================================================================

let _registry: Map<string, OperationDescriptor> | null = null;

function buildRegistry(): Map<string, OperationDescriptor> {
  const map = new Map<string, OperationDescriptor>();

  for (const reg of ALL_REGISTRATIONS) {
    validateRegistration(reg);

    const operationId = buildOperationId(reg.stepType, reg.group, reg.verb);

    if (map.has(operationId)) {
      throw new Error(`Duplicate operationId: "${operationId}"`);
    }

    map.set(operationId, {
      operationId,
      stepType: reg.stepType,
      group: reg.group,
      verb: reg.verb,
      name: reg.name,
      semanticDescription: reg.semanticDescription,
      ...(reg.actionLabel != null ? { actionLabel: reg.actionLabel } : {}),
      ...(reg.tags != null ? { tags: reg.tags } : {}),
      ...(reg.crudView != null ? { crudView: reg.crudView } : {}),
      ...(reg.internalFields != null ? { internalFields: reg.internalFields } : {}),
      ...(reg.agentCollapsedFields != null
        ? { agentCollapsedFields: reg.agentCollapsedFields }
        : {}),
      idempotency: reg.idempotency,
      usage: reg.usage,
      inputZod: reg.inputZod,
      ...(reg.outputZod != null ? { outputZod: reg.outputZod } : {}),
      ...(reg.resumePayloadZod != null ? { resumePayloadZod: reg.resumePayloadZod } : {}),
      ...(reg.stepConfigZod != null ? { stepConfigZod: reg.stepConfigZod } : {}),
      ...(reg.internal ? { internal: true } : {}),
      agentTool: reg.agentTool !== false,
      ...(reg.agentAlternative != null ? { agentAlternative: reg.agentAlternative } : {}),
      ...(reg.privileged ? { privileged: true } : {}),
      mutates: reg.mutates ?? false,
      ...(reg.skipInputValidation ? { skipInputValidation: true } : {}),
      ...(reg.bypassGrant ? { bypassGrant: true } : {}),
      ...(reg.outputSemanticType != null ? { outputSemanticType: reg.outputSemanticType } : {}),
      ...(reg.imageOutputPaths != null ? { imageOutputPaths: reg.imageOutputPaths } : {}),
      ...(reg.observation != null ? { observation: reg.observation } : {}),
      capabilityGroupId: buildGroupId(reg.stepType, reg.group),
      accessMode: reg.accessMode,
      riskModifiers: reg.riskModifiers ?? [],
      opTaskOnly: reg.opTaskOnly ?? false,
      ownsAsyncJobLifecycle: reg.ownsAsyncJobLifecycle ?? false,
      ...(reg.defaultResumeStrategy != null
        ? { defaultResumeStrategy: reg.defaultResumeStrategy }
        : {}),
    });
  }

  return map;
}

function getRegistry(): Map<string, OperationDescriptor> {
  _registry ??= buildRegistry();
  return _registry;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Get the complete merged registry of all operations.
 * Sorted by operationId for determinism.
 */
export function getAllOperations(): Map<string, OperationDescriptor> {
  return getRegistry();
}

/**
 * Get all operation IDs, sorted alphabetically.
 */
export function getAllOperationIds(): string[] {
  return Array.from(getRegistry().keys()).sort();
}

/**
 * Set of step-type prefixes that are gated by per-space operator policy
 * rather than always available. The space's `computePolicy.enabled` flag
 * controls compute access, so a workflow referencing
 * `compute.sandbox.exec` must still pass the policy gate even though
 * `compute` is a platform built-in. Validators (e.g.
 * `capability-references-bound`) treat these prefixes specially:
 * `signal_blocked` with `capability_unavailable` is the only correct
 * runner reaction since dropping the reference would silently break the
 * workflow.
 *
 * Keep this list narrow — adding a prefix here means runners can no
 * longer freely use those operations without operator setup.
 */
export const SPACE_POLICY_OPERATION_PREFIXES: ReadonlySet<string> = new Set([
  'compute',
  'code',
  'host',
]);

/**
 * Of those, the step types whose executor runs a space carrying no policy at
 * all — as opposed to one whose operator switched it off.
 *
 * The two executors genuinely differ, and a caller gating ahead of them has to
 * follow rather than pick. Compute refuses only an explicit `enabled: false`
 * and runs an absent policy; the coding lane requires `enabled === true` and
 * refuses everything else, which is the fail-closed default its own plan calls
 * for. A gate that allowed an unset code policy would admit work guaranteed to
 * fail at execution, and one that refused an unset compute policy would
 * withdraw work that still succeeds.
 */
export const SPACE_POLICY_RUNS_WHEN_UNSET: ReadonlySet<string> = new Set(['compute']);

/**
 * Derive the set of step-type prefixes that are unconditionally available
 * — i.e. operations under these prefixes never need a credentialled
 * binding or operator policy. The set is computed from the operation
 * registry minus `SPACE_POLICY_OPERATION_PREFIXES`, so adding a new
 * platform step type (`ai`, `mcp`, `user`, …) auto-propagates to every
 * downstream consumer that calls this helper instead of hand-writing a
 * list.
 *
 * Replaces three hand-written `PLATFORM_PREFIXES` sets that drifted out
 * of sync — runners authored `operations: ['ai.text.generate']` and the
 * validator's incomplete list reported `operation "ai" is not bound`.
 */
export function getPlatformOperationPrefixes(): ReadonlySet<string> {
  const prefixes = new Set<string>();
  for (const desc of getRegistry().values()) {
    if (!SPACE_POLICY_OPERATION_PREFIXES.has(desc.stepType)) {
      prefixes.add(desc.stepType);
    }
  }
  return prefixes;
}

/**
 * Get operations for a specific step type.
 */
export function getOperationsByStepType(stepType: string): Map<string, OperationDescriptor> {
  const filtered = new Map<string, OperationDescriptor>();
  for (const [id, desc] of getRegistry()) {
    if (desc.stepType === stepType) {
      filtered.set(id, desc);
    }
  }
  return filtered;
}

/**
 * Get operations matching a qualified groupId (e.g., 'ai.text', 'platform.flow').
 */
export function getOperationsByGroupId(groupId: string): Map<string, OperationDescriptor> {
  const filtered = new Map<string, OperationDescriptor>();
  for (const [id, desc] of getRegistry()) {
    const descGroupId = buildGroupId(desc.stepType, desc.group);
    if (descGroupId === groupId) {
      filtered.set(id, desc);
    }
  }
  return filtered;
}

/**
 * Get a single operation descriptor by ID.
 */
export function getOperation(operationId: string): OperationDescriptor | undefined {
  return getRegistry().get(operationId);
}

/**
 * Get all distinct groups as { groupId, stepType, group, operationCount }
 * sorted by (stepType, group).
 */
export function getAvailableGroups(): Array<{
  groupId: string;
  stepType: string;
  group: string | null;
  operationCount: number;
}> {
  const groupMap = new Map<string, { stepType: string; group: string | null; count: number }>();

  for (const desc of getRegistry().values()) {
    if (desc.internal) continue; // Skip internal ops — not visible to agents
    const gid = buildGroupId(desc.stepType, desc.group);
    const existing = groupMap.get(gid);
    if (existing) {
      existing.count++;
    } else {
      groupMap.set(gid, { stepType: desc.stepType, group: desc.group, count: 1 });
    }
  }

  return Array.from(groupMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([groupId, { stepType, group, count }]) => ({
      groupId,
      stepType,
      group,
      operationCount: count,
    }));
}

/**
 * Check whether an operation is privileged (only invocable from system flows).
 */
export function isPrivilegedOperation(operationId: string): boolean {
  const desc = getRegistry().get(operationId);
  return desc?.privileged === true;
}

/**
 * Operations on the eval plane that a skill may still call, because they only
 * ever produce a proposal a human ratifies.
 *
 * Membership has a hard bar: the operation must be incapable of revealing a
 * measurement and incapable of changing a ruler on its own. `eval.case.propose`
 * writes a StagedChange and nothing else — ratification is where the case
 * lands, and it re-runs the authoring gate at that point.
 */
const EVAL_AUTHORING_OPERATIONS: ReadonlySet<string> = new Set(['eval.case.propose']);

/**
 * Plan 269 D7 — the subject must not see the ruler.
 *
 * Read precisely, the invariant is that a skill may not learn its own score,
 * run its own measurement, or change a ruler without a human. A blanket ban on
 * the `eval.` prefix over-approximated that, and the gap showed the moment a
 * skill's JOB was authoring evaluations for another skill: legitimate work that
 * the rule refused on the strength of a name, pushing it toward an operation
 * named to evade the check rather than one named for what it does.
 *
 * So the exception is a set, not a pattern, and the default is still refusal:
 * any `eval.*` id absent from it — including one added later — stays excluded.
 * A new operation joins the set by argument, never by prefix.
 */
export function isEvalPlaneOperation(operationId: string): boolean {
  if (EVAL_AUTHORING_OPERATIONS.has(operationId)) return false;
  return operationId === 'eval' || operationId.startsWith('eval.');
}

/**
 * Plan 322 D3 — a run may serve a plan node and may never rewrite the plan it
 * serves. Fail-closed on the prefix: any `plan.*` id, including one added
 * later, is the Helmsman's alone.
 */
export function isPlanOperation(operationId: string): boolean {
  return operationId === 'plan' || operationId.startsWith('plan.');
}

// ============================================================================
// Action Label Lookup (lightweight, for client-side activity display)
// ============================================================================

let _actionLabelCache: Record<string, string> | null = null;

/**
 * Get the capability group ID and access mode for an operation.
 * Returns undefined if the operation is not found.
 */
export function getOperationCapability(
  operationId: string,
): { capabilityGroupId: string; accessMode: string; riskModifiers: string[] } | undefined {
  const desc = getRegistry().get(operationId);
  if (!desc) return undefined;
  return {
    capabilityGroupId: desc.capabilityGroupId,
    accessMode: desc.accessMode,
    riskModifiers: desc.riskModifiers,
  };
}

// ============================================================================

export interface DerivedCapabilityGroup {
  /** Capability group ID — derived from `stepType.group` */
  capabilityGroupId: string;
  /** Step type this group belongs to */
  stepType: string;
  /** Group within step type (null for ungrouped) */
  group: string | null;
  /** Human-readable label for admin UI */
  label: string;
  /** Description for admin UI */
  description: string;
  /** Access modes present across operations in this group */
  supportedAccessModes: readonly CapabilityAccessMode[];
  /** Whether any operation in this group mutates state */
  defaultMutates: boolean;
  /** Whether any operation in this group is privileged */
  defaultPrivileged: boolean;
  /** Union of risk modifiers across operations in this group */
  defaultRiskModifiers: readonly RiskModifier[];
  /** Number of operations in this group */
  operationCount: number;
}

let _derivedGroups: Map<string, DerivedCapabilityGroup> | null = null;

/**
 * Derive capability groups from the operation registry.
 *
 * Each unique `stepType.group` combination becomes a capability group.
 * Group metadata (label, description, access modes, risk modifiers) is
 * derived from the operations in that group, with optional overrides
 * from `groupDisplayName` and `groupDescription` on registrations.
 *
 * Result is cached after the first call.
 */
export function deriveCapabilityGroups(): ReadonlyMap<string, DerivedCapabilityGroup> {
  if (_derivedGroups) return _derivedGroups;

  const groups = new Map<string, DerivedCapabilityGroup>();
  const accessModes = new Map<string, Set<CapabilityAccessMode>>();
  const riskMods = new Map<string, Set<RiskModifier>>();

  // First pass: collect from registrations (which have groupDisplayName/groupDescription)
  const regDisplayNames = new Map<string, string>();
  const regDescriptions = new Map<string, string>();
  for (const reg of ALL_REGISTRATIONS) {
    const groupId = buildGroupId(reg.stepType, reg.group);
    if (reg.groupDisplayName && !regDisplayNames.has(groupId)) {
      regDisplayNames.set(groupId, reg.groupDisplayName);
    }
    if (reg.groupDescription && !regDescriptions.has(groupId)) {
      regDescriptions.set(groupId, reg.groupDescription);
    }
  }

  // Second pass: build groups from the registry
  for (const op of getRegistry().values()) {
    const groupId = op.capabilityGroupId; // already derived as buildGroupId(stepType, group)

    if (!groups.has(groupId)) {
      const modes = new Set<CapabilityAccessMode>();
      const risks = new Set<RiskModifier>();
      accessModes.set(groupId, modes);
      riskMods.set(groupId, risks);

      groups.set(groupId, {
        capabilityGroupId: groupId,
        stepType: op.stepType,
        group: op.group,
        label: regDisplayNames.get(groupId) ?? formatGroupLabel(op.stepType, op.group),
        description: regDescriptions.get(groupId) ?? op.semanticDescription,
        supportedAccessModes: [], // filled after all ops processed
        defaultMutates: false,
        defaultPrivileged: false,
        defaultRiskModifiers: [], // filled after all ops processed
        operationCount: 0,
      });
    }

    const g = groups.get(groupId)!;
    const modes = accessModes.get(groupId)!;
    const risks = riskMods.get(groupId)!;

    modes.add(op.accessMode);
    if (op.mutates) (g as { defaultMutates: boolean }).defaultMutates = true;
    if (op.privileged) (g as { defaultPrivileged: boolean }).defaultPrivileged = true;
    for (const rm of op.riskModifiers) risks.add(rm);
    (g as { operationCount: number }).operationCount++;
  }

  // Finalize supportedAccessModes and defaultRiskModifiers
  for (const [groupId, g] of groups) {
    const modes = accessModes.get(groupId)!;
    const risks = riskMods.get(groupId)!;
    (g as { supportedAccessModes: readonly CapabilityAccessMode[] }).supportedAccessModes = [
      ...modes,
    ].sort();
    (g as { defaultRiskModifiers: readonly RiskModifier[] }).defaultRiskModifiers = [
      ...risks,
    ].sort();
  }

  _derivedGroups = groups;
  return groups;
}

/**
 * Get a derived capability group by ID.
 */
export function getDerivedCapabilityGroup(groupId: string): DerivedCapabilityGroup | undefined {
  return deriveCapabilityGroups().get(groupId);
}

/**
 * Get all derived capability group IDs, sorted alphabetically.
 */
export function getDerivedCapabilityGroupIds(): string[] {
  return Array.from(deriveCapabilityGroups().keys()).sort();
}

/** Format a human-readable label from stepType + group. */
function formatGroupLabel(stepType: string, group: string | null): string {
  const st = stepType.charAt(0).toUpperCase() + stepType.slice(1);
  if (!group) return st;
  const g = group
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return `${st} → ${g}`;
}

// ============================================================================
// Action Label Lookup (lightweight, for client-side activity display)
// ============================================================================

/**
 * Build a flat `operationId → actionLabel` map from the registry.
 * Falls back to the operation's `name` when no `actionLabel` is defined.
 * Result is cached after the first call.
 */
export function getActionLabels(): Record<string, string> {
  if (_actionLabelCache) return _actionLabelCache;

  const labels: Record<string, string> = {};
  for (const [id, desc] of getRegistry()) {
    labels[id] = desc.actionLabel ?? desc.name;
  }
  _actionLabelCache = labels;
  return labels;
}
