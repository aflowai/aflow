/**
 * Applet action lowering — the current instance's declared actions become
 * typed AgentToolSpecs over ui.applet.act, following the API virtual-tool
 * precedent exactly: a `source` value and a meta block, not a new execution
 * path (Plan 264 §4.14). Only the current instance is lowered; every other
 * instance stays reachable through ui.applet.list / get and the generic op.
 */
import type {
  AgentToolSpec,
  AppletAction,
  OperationId,
  StepDefinition,
  StepId,
  StepType,
  AppletDefinition,
  AppletFocus,
  AppletInstance,
  AppletStatePatch,
  AppletStateVersion,
  UiAppletActInput,
} from '@aflow/schemas';
import {
  AppletStatePatchSchema,
  APPLET_OUTCOME_MAX_LENGTH,
  RAW_PATCH_ACTION,
  UI_APPLET_ACT_OPERATION_ID,
  buildVirtualToolSpec,
  toJsonSchemaSync,
} from '@aflow/schemas';
import type { SessionHotState } from '@aflow/redis';

/**
 * This turn's lowered applet specs, written at assembly and read back at
 * dispatch to recover appletMeta — the same runtime-state round trip the
 * api:/mcp: lowerings use for binding identity.
 */
export const APPLET_TOOL_SPECS_VAR = 'ai.agent._appletToolSpecs';

export interface ResolvedAppletInstance {
  instance: AppletInstance;
  definition: AppletDefinition;
  stateVersion: AppletStateVersion;
}

// ============================================================================
// Focus resolution (§4.13 tier 3)
// ============================================================================

export interface AppletFocusResolutionDeps {
  getFocus(): Promise<AppletFocus | null>;
  loadInstance(instanceId: string): Promise<ResolvedAppletInstance | null>;
  /** Active instances in the space — only `total` and the first item are consulted. */
  listActiveInstances(): Promise<{ items: ResolvedAppletInstance[]; total: number }>;
}

/**
 * The session's current instance, by the locked §4.13 precedence:
 * waking action → explicit focus → sole active instance → none.
 *
 * The store holds one slot per session, so a waking-action focus (Phase 4 —
 * no producer yet) arrives through the same read with source 'waking_action';
 * the seam needs no extra branch here. A focus whose instance is gone, ended,
 * or in another space falls through rather than erroring — with two live
 * games and no focus, guessing is worse than declining.
 */
export async function resolveCurrentAppletInstance(
  spaceId: string,
  deps: AppletFocusResolutionDeps,
): Promise<ResolvedAppletInstance | null> {
  const focus = await deps.getFocus();
  if (focus) {
    const record = await deps.loadInstance(focus.instanceId);
    if (
      record !== null &&
      record.instance.spaceId === spaceId &&
      record.instance.status === 'active'
    ) {
      return record;
    }
  }

  const { items, total } = await deps.listActiveInstances();
  const sole = items[0];
  if (total === 1 && sole !== undefined) return sole;
  return null;
}

// ============================================================================
// Action lowering (§4.14)
// ============================================================================

function isAgentAudience(action: AppletAction): boolean {
  return action.audience === 'agent' || action.audience === 'both';
}

function composeActionDescription(action: AppletAction): string {
  const parts = [action.description];
  if (action.whenToUse !== undefined && action.whenToUse.length > 0) {
    parts.push(`When to use: ${action.whenToUse.join('; ')}`);
  }
  if (action.pitfalls !== undefined && action.pitfalls.length > 0) {
    parts.push(`Pitfalls: ${action.pitfalls.join('; ')}`);
  }
  return parts.join('\n');
}

/** The action's own fields plus the outcome slot — narration must survive lowering. */
function templateInputSchema(action: AppletAction): Record<string, unknown> {
  const base = action.inputSchema;
  const properties = isRecord(base['properties']) ? base['properties'] : {};
  return {
    ...base,
    properties: {
      ...properties,
      outcome: {
        type: 'string',
        maxLength: APPLET_OUTCOME_MAX_LENGTH,
        description: 'Human-readable result of the action, in your words',
      },
    },
  };
}

function actorSuppliedInputSchema(action: AppletAction): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      input: action.inputSchema,
      proposedPatch: {
        ...(toJsonSchemaSync(AppletStatePatchSchema) as Record<string, unknown>),
        description: 'RFC 6902 patch confined to /state, computed against the state you last read',
      },
      outcome: {
        type: 'string',
        maxLength: APPLET_OUTCOME_MAX_LENGTH,
        description: 'Human-readable result of the action, in your words',
      },
    },
    required: ['input', 'proposedPatch'],
  };
}

/**
 * Lower every agent-audience declared action plus the built-in raw_patch into
 * AgentToolSpecs named `<appletKey>.<action>`. Two shapes: template actions
 * expose the action's own inputSchema; actor_supplied actions expose the
 * `{ input, proposedPatch, outcome? }` wrapper — whoever acts computes the
 * change. instanceId/actionId/baseVersion never appear in any schema.
 */
export function mapAppletActionsToToolSpecs(resolved: ResolvedAppletInstance): AgentToolSpec[] {
  const { instance, definition, stateVersion } = resolved;
  const actions = [...definition.actions.filter(isAgentAudience), RAW_PATCH_ACTION];

  return actions.map((action) => {
    const toolId = `${definition.appletKey}.${action.name}`;
    const patchMode = action.patch === 'actor_supplied' ? 'actor_supplied' : 'template';
    return buildVirtualToolSpec({
      operationId: UI_APPLET_ACT_OPERATION_ID,
      toolId,
      callName: toolId,
      stepType: 'ui',
      name: toolId,
      description: composeActionDescription(action),
      inputSchema:
        patchMode === 'actor_supplied'
          ? actorSuppliedInputSchema(action)
          : templateInputSchema(action),
      source: 'applet',
      appletMeta: {
        instanceId: instance.instanceId,
        actionName: action.name,
        patchMode,
        baseVersion: stateVersion,
      },
    });
  });
}

// ============================================================================
// Dispatch synthesis
// ============================================================================

export function findCachedAppletToolSpec(
  runtimeState: SessionHotState['runtimeState'] | undefined,
  toolId: string,
): AgentToolSpec | undefined {
  const cached = runtimeState?.variables[APPLET_TOOL_SPECS_VAR] as
    { ref?: { kind: string; value?: unknown } } | undefined;
  if (cached?.ref?.kind !== 'inline' || !Array.isArray(cached.ref.value)) return undefined;
  const spec = (cached.ref.value as AgentToolSpec[]).find(
    (candidate) => candidate.toolId === toolId,
  );
  return spec?.appletMeta !== undefined ? spec : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Synthesize the ui.applet.act input from the lowered tool's meta and the
 * model's arguments. instanceId, actionId and baseVersion are never
 * model-supplied — the meta carries instance and version, the server mints
 * the idempotency key, and anything the model tried is dropped (§4.14).
 * baseVersion is the assembly-time read: specs are re-resolved every turn,
 * so it is at most one turn old, and a same-decision get cannot complete
 * before a parallel act dispatches.
 */
export function buildAppletActInput(
  appletMeta: NonNullable<AgentToolSpec['appletMeta']>,
  modelArgs: Record<string, unknown>,
): UiAppletActInput {
  const envelope: UiAppletActInput = {
    instanceId: appletMeta.instanceId,
    actionId: crypto.randomUUID(),
    baseVersion: appletMeta.baseVersion,
    name: appletMeta.actionName,
    input: {},
  };

  if (appletMeta.patchMode === 'template') {
    const {
      instanceId: _instanceId,
      actionId: _actionId,
      baseVersion: _baseVersion,
      proposedPatch: _proposedPatch,
      outcome,
      ...input
    } = modelArgs;
    envelope.input = input;
    if (typeof outcome === 'string') envelope.outcome = outcome;
    return envelope;
  }

  if (isRecord(modelArgs['input'])) envelope.input = modelArgs['input'];
  const proposedPatch = modelArgs['proposedPatch'];
  if (Array.isArray(proposedPatch)) {
    envelope.proposedPatch = proposedPatch as AppletStatePatch;
  }
  if (typeof modelArgs['outcome'] === 'string') envelope.outcome = modelArgs['outcome'];
  return envelope;
}

/**
 * The synthesized ui.applet.act step for a lowered applet tool call —
 * routing back to the agent on both outcomes, tagged for trace legibility.
 */
export function buildLoweredAppletStep(
  toolId: string,
  compactCallId: string,
  agentStepId: StepId,
  appletMeta: NonNullable<AgentToolSpec['appletMeta']>,
): { stepId: StepId; stepDef: StepDefinition } {
  const stepId =
    `virtual_applet_${toolId.replace(/\./g, '_')}_${crypto.randomUUID().slice(0, 8)}` as StepId;
  const stepDef: StepDefinition = {
    stepId,
    stepType: 'ui' as StepType,
    operation: 'ui.applet.act' as OperationId,
    name: `↪ ${toolId}`,
    config: {},
    tags: [
      'dynamic',
      'virtual_applet_tool',
      `parent:${agentStepId}`,
      `_toolId:${toolId}`,
      `_toolCallId:${compactCallId}`,
      `_instanceId:${appletMeta.instanceId}`,
      `_actionName:${appletMeta.actionName}`,
    ],
    optional: false,
    outputOptions: { displayToUser: true },
    onSuccess: { next: [{ stepId: agentStepId, priority: 50 }] },
    onFailure: { next: [{ stepId: agentStepId, priority: 50 }] },
  };
  return { stepId, stepDef };
}
