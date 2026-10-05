import type {
  AgentDefinition,
  StepDefinition,
  AgentToolSpec,
  AgentRole,
  CatalogConfig,
  CatalogFormat,
  ToolSurfaceScope,
  ToolSurfaceDiscoverable,
  ToolSurfaceContext,
  RoomExchangeEntry,
  RoomSpeaker,
  TenantId,
  RunAccessGrant,
  RunTrigger,
  WorkflowRunWakeupEntry,
} from '@aflow/schemas';
import {
  buildSessionParticipantsBlock,
  resolveSteeringAuthor,
  resolveTurnSpeaker,
  type RosterParticipant,
} from './sessionRoster.js';
import { resolveHelmsmanCapabilities } from './helmsmanCapabilities.js';

export { buildSessionParticipantsBlock, resolveSteeringAuthor } from './sessionRoster.js';
import {
  buildOperationId,
  buildToolSpec,
  buildVirtualToolSpec,
  buildCoreToolSpec,
  projectSpaceContextForModel,
  getOperation,
  toJsonSchemaSync,
  resolveAgentPoliciesFromConfig,
  getOperationCatalog,
  getAllOperations,
  buildSummaryCatalog,
  buildDetailedCatalog,
  buildCompactAwareness,
  pruneSchemaForAgent,
  type DisclosedCallerBinding,
} from '@aflow/schemas';
import { applyToolAccess, type ToolAccessContext } from './toolAccess.js';
import { resolveTurnToolSurface, type CoreAgentMeta } from './turnToolSurface.js';
export type { CoreAgentMeta };
import {
  MAX_TOTAL_TOOLS,
  admitConnectionsWithinCap,
  applyCapabilitySettings,
  withPromotedToolsRevoked,
} from './capabilityShedding.js';
// Re-exported: the surface assembler is where callers and tests expect it.
import { withGuaranteedReadOps } from '@aflow/schemas';
export { withGuaranteedReadOps };
import { renderDisclosedCallers } from '@aflow/cybernetic-runtime';
import { applySubmitOutputToolSchema } from './submitOutputToolSchema.js';
import { buildToolResultEnvelopes } from './toolResultEnvelope.js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import type { SessionHotState } from '@aflow/redis';
import type { PayloadStore } from '@aflow/payload-store';
import type { SpaceContext, EntityDirectives } from '@aflow/schemas';
import type { ToolResultSummary } from '../types.js';
import { resolveConfigRecursive } from './configResolution.js';
import { readInlineVar } from './runtimeState.js';
import { type ParsedApiGrant, type ParsedMcpGrant } from './capabilityGrantsToCatalog.js';
import { getOrchestratorLogger, logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import { encodeTaskInput } from '../../../lib/encodeTaskInput.js';
import {
  isCyberneticHelmsman,
  isHelmsmanDefinition,
  resolveSpaceContextRole,
  isCyberneticCoach,
  buildCyberneticTurnOverrides,
  type CyberneticTurnOverrides,
} from '@aflow/cybernetic-runtime';
import {
  isOperationComposed,
  isRunnerExcludedOperation,
  processEditionDescriptor,
  resolveRoleModel,
  resolveRoleReasoning,
} from '@aflow/schemas';
import { composeHelmsmanSurface } from '@aflow/platform-artifacts';

function formatDelegationFieldForPrompt(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

type AgentContextProfile = 'minimal' | 'default' | 'detailed' | 'debug';

export interface FlowScheduleSummary {
  name: string;
  kind: string;
  cronExpression?: string;
  timezone?: string;
  nextFireAt?: string;
}

export interface AgentFlowContextDetails {
  tenantId?: string;
  space?: {
    id?: string;
    name?: string;
  };
  user?: {
    id?: string;
    name?: string;
  };
  env?: 'production' | 'development';
  runId?: string;
  trigger?: RunTrigger;
  /** Whether the user is currently interacting via voice (mutable per-turn) */
  voiceMode?: boolean;
  /** Everyone who has spoken in this session, insertion-ordered (hot-state roster). */
  participants?: RosterParticipant[];
  schedules?: FlowScheduleSummary[];
  cyberneticHandles?: {
    db: unknown; // PostgresJsDatabase
    redis: unknown; // Redis
  };
  /**
   * The signed-in caller this run acts for, when its simulation discloses one.
   * Resolved at run start; carries identity, never that the binding is simulated.
   */
  disclosedCallers?: DisclosedCallerBinding[];
}

// ============================================================================
// Tool spec building
// ============================================================================

/** Virtual tool entry stored in ai.agent._virtualTools state variable */
export interface VirtualToolEntry {
  discoveredAtTurn: number;
  lastUsedAtTurn?: number;
}

/** Maximum number of *discovered* (agent-promoted) virtual tools per session. */
export const MAX_VIRTUAL_TOOLS = 20;

/** Stamp a promoted tool with its `_virtualTools` provenance for the inspector surface. */
function stampToolProvenance(spec: AgentToolSpec, entry: VirtualToolEntry): AgentToolSpec {
  return {
    ...spec,
    discoveredAtTurn: entry.discoveredAtTurn,
    ...(entry.lastUsedAtTurn !== undefined ? { lastUsedAtTurn: entry.lastUsedAtTurn } : {}),
  };
}

/**
 * The one universal floor: every agent turn can re-read this run's own tool
 * outputs (/run/outputs/*), so cleared/truncated results stay recoverable.
 * Agents that already hold the full memory read keep just that — the narrow
 * op would be a redundant sibling on their surface.
 */
/**
 * Extract the operator's Helmsman discovery override from a space's
 * directives. Returns the explicit op-level allow-list when the operator set
 * one (including `[]`, which turns discovery off), or `undefined` to fall
 * through to the platform preset baked into the Helmsman def. Plan 233 Part 3.
 */
export function resolveHelmsmanDiscoveryOverride(directives: unknown): string[] | undefined {
  const override = (
    directives as { capabilityDiscovery?: { helmsmanOperations?: unknown } } | undefined
  )?.capabilityDiscovery?.helmsmanOperations;
  if (!Array.isArray(override)) return undefined;
  return override.filter((o): o is string => typeof o === 'string' && o.length > 0);
}

const CATALOG_PROMOTE_OPERATION_ID = buildOperationId('catalog', 'tool', 'promote');
const CATALOG_SEARCH_OPERATION_ID = buildOperationId('catalog', 'tool', 'search');

export function buildAvailableTools(
  agentDef: AgentDefinition,
  agentStepId: string,
  catalogConfig?: CatalogConfig,
  virtualToolsState?: Record<string, VirtualToolEntry>,
  coreAgentMetas?: CoreAgentMeta[],
  apiToolSpecs?: AgentToolSpec[],
  discoveredApiToolSpecs?: AgentToolSpec[],
  mcpToolSpecs?: AgentToolSpec[],
  discoveredMcpToolSpecs?: AgentToolSpec[],
  appletToolSpecs?: AgentToolSpec[],
  access?: ToolAccessContext,
  connectionToolSpecs?: AgentToolSpec[],
): AgentToolSpec[] {
  const agentStep = agentDef.steps.find((s) => s.stepId === agentStepId);
  if (!agentStep) return [];

  const toolStepIds = agentStep.onSuccess.next.map((e) => e.stepId);
  const tools: AgentToolSpec[] = [];

  // 1. Authored graph tools (from onSuccess edges)
  for (const toolStepId of toolStepIds) {
    const toolStep = agentDef.steps.find((s) => s.stepId === toolStepId);
    if (!toolStep) continue;
    if (toolStepId?.includes('.')) {
      getOrchestratorLogger().warn(
        `buildAvailableTools: graph step "${toolStepId}" contains dots — virtual tools use dotted operationIds; rename the step to avoid shadowing (Plan 92).`,
      );
    }
    // Don't include the agent step itself as a tool
    if (toolStep.operation === 'ai.agent.turn') continue;
    if (toolStep.operation === 'agent.control.run_step') continue;
    if (toolStep.operation === 'api.http.call') continue;

    // Description priority: step definition → catalog semanticDescription → generic fallback
    let description = toolStep.description;
    if (!description) {
      const op = getOperation(toolStep.operation);
      description = op?.semanticDescription;
    }

    // Prune tool input schema (strip $schema, additionalProperties, redundant descriptions).
    // Pass agentDef so ${input.*} bindings can narrow types from state variables.
    const rawSchema = buildToolInputSchema(toolStep, agentDef);
    const prunedSchema = pruneSchemaForAgent(rawSchema);

    tools.push(
      buildToolSpec({
        stepId: toolStep.stepId,
        stepType: toolStep.stepType,
        operationId: toolStep.operation,
        name: toolStep.name ?? toolStep.stepId,
        ...(description != null ? { description } : {}),
        inputSchema: prunedSchema,
      }),
    );
  }

  // 2. Core virtual tools (from catalog.coreOperations)
  if (catalogConfig?.coreOperations) {
    for (const opId of catalogConfig.coreOperations) {
      const spec = buildCoreToolSpec(opId);
      if (spec) tools.push(spec);
    }
  }

  if (coreAgentMetas && coreAgentMetas.length > 0) {
    for (const agentMeta of coreAgentMetas) {
      // Use agent ID as tool ID, replacing dashes/spaces with underscores for LLM compatibility
      const toolId = agentMeta.agentId.replace(/[-\s]/g, '_');
      tools.push(
        buildVirtualToolSpec({
          operationId: toolId,
          stepType: 'agent',
          name: agentMeta.name,
          description:
            agentMeta.description +
            ' (Delegated agent — runs as a sub-agent and returns its result.)',
          inputSchema: {
            type: 'object',
            properties: {
              task: {
                type: 'string',
                description: 'Description of the task to delegate to this agent',
              },
              context: {
                type: 'object',
                description: 'Optional structured context for the sub-agent',
                properties: {
                  objective: { type: 'string' },
                  parentSummary: { type: 'string' },
                  constraints: { type: 'array', items: { type: 'string' } },
                },
              },
            },
            required: ['task'],
          },
          source: 'core',
          lowering: 'delegate',
        }),
      );
    }
  }

  if (apiToolSpecs && apiToolSpecs.length > 0) {
    for (const apiTool of apiToolSpecs) {
      tools.push(apiTool);
    }
  }

  if (mcpToolSpecs && mcpToolSpecs.length > 0) {
    for (const mcpTool of mcpToolSpecs) {
      tools.push(mcpTool);
    }
  }

  if (appletToolSpecs && appletToolSpecs.length > 0) {
    for (const appletTool of appletToolSpecs) {
      tools.push(appletTool);
    }
  }

  // Operator-pinned connections go in last and come out first. Everything above
  // is authored platform config, so its overflow is a bug worth throwing over;
  // this list is a settings panel, and the overflow it produces has to cost the
  // operator a connection's tools rather than every turn in the space. Whole
  // connections are dropped, never part of one — half an API's endpoints is a
  // surface nobody chose.
  const admittedConnections = admitConnectionsWithinCap(tools.length, connectionToolSpecs);
  for (const spec of admittedConnections) tools.push(spec);

  const pinnedCount = tools.length;
  if (pinnedCount > MAX_TOTAL_TOOLS) {
    // Build a per-source breakdown so the operator-facing message points
    // them at the actual culprit. The classifier (TOOL_BUDGET_EXCEEDED)
    // turns the technical message below into a friendly UI string; the
    // breakdown still surfaces in server logs.
    const mcpCount = mcpToolSpecs?.length ?? 0;
    const apiCount = apiToolSpecs?.length ?? 0;
    const appletCount = appletToolSpecs?.length ?? 0;
    const connectionCount = admittedConnections.length;
    const coreOpsCount = catalogConfig?.coreOperations?.length ?? 0;
    const coreAgentsCount = coreAgentMetas?.length ?? 0;
    const graphCount =
      pinnedCount -
      mcpCount -
      apiCount -
      appletCount -
      connectionCount -
      coreOpsCount -
      coreAgentsCount;
    const breakdown =
      `MCP=${String(mcpCount)}, API=${String(apiCount)}, applet=${String(appletCount)}, ` +
      `connections=${String(connectionCount)}, coreOps=${String(coreOpsCount)}, ` +
      `coreAgents=${String(coreAgentsCount)}, graph=${String(graphCount)}`;
    const msg =
      `Pinned tool count (${String(pinnedCount)}) exceeds MAX_TOTAL_TOOLS=${String(MAX_TOTAL_TOOLS)} ` +
      `[${breakdown}]. Reduce coreOperations / coreAgents / coreApis endpoints / coreMcpServers ` +
      `tools, or tighten binding.toolAccessPolicy.allow. (pinned_tool_cap_exceeded)`;
    logOrchestratorError(`[buildAvailableTools] ${msg}`, new Error('pinned_tool_cap_exceeded'), {});
    throw new Error(msg);
  }

  // 5. Session-discovered virtual tools (from ai.agent._virtualTools state var)
  if (virtualToolsState) {
    // Collect core operation IDs and agent IDs to avoid double-promoting
    const coreOpIds = new Set(catalogConfig?.coreOperations ?? []);
    const coreAgentIds = new Set((catalogConfig?.coreAgents ?? []).map((id) => `agent:${id}`));

    // Sort discovered tools by lastUsedAtTurn (most recently used first) for LRU
    const discoveredEntries = Object.entries(virtualToolsState)
      .filter(([vtId]) => !coreOpIds.has(vtId) && !coreAgentIds.has(vtId))
      .sort(
        ([, a], [, b]) =>
          (b.lastUsedAtTurn ?? b.discoveredAtTurn) - (a.lastUsedAtTurn ?? a.discoveredAtTurn),
      );

    let droppedAtCap: string[] | undefined;
    // LRU eviction: cap *agent-discovered* virtual tools at
    // MAX_VIRTUAL_TOOLS. Bug observed 2026-05-29: the prior version
    // counted `source: 'core'` toward the cap, but core operations are
    // pinned by the operator and routinely exceed 20 on Helmsman (~34
    // ops). That meant `currentVirtualCount >= 20` was already true
    // before the loop body ran, so every promoted MCP / API tool was
    // dropped on the floor before it could enter the agent's surface.
    // MAX_TOTAL_TOOLS still bounds pinned tools separately above.
    //
    // We use an explicit counter rather than `tools.filter(...)` because
    // the specs pushed inside this loop carry mixed `source` tags
    // (`'discovered'` for plain ops, `'mcp'`/`'api'` for integration
    // tools, which can also appear as pinned earlier in the array). A
    // filter would either under-count integration promotes (the prior
    // failing-test branch of this bug) or over-count pinned `coreApis`
    // / `coreMcpServers`. Counting pushes inside this block sidesteps
    // both.
    let admittedDiscovered = 0;
    for (const [vtId, entry] of discoveredEntries) {
      if (admittedDiscovered >= MAX_VIRTUAL_TOOLS) {
        droppedAtCap ??= [];
        droppedAtCap.push(vtId);
        continue;
      }

      if (vtId.startsWith('agent:')) {
        // Agent virtual tool — already handled by coreAgentMetas or will be
        // promoted via dynamic fetch. For discovered agents, we add a generic
        // tool spec since we don't have the metadata cached.
        const agentId = vtId.slice('agent:'.length);
        const toolId = agentId.replace(/[-\s]/g, '_');
        // Skip if already in tools (from coreAgentMetas)
        if (tools.some((t) => t.toolId === toolId)) continue;
        tools.push(
          stampToolProvenance(
            buildVirtualToolSpec({
              operationId: toolId,
              stepType: 'agent',
              name: agentId,
              description: `Discovered agent — delegate tasks to this specialist.`,
              inputSchema: {
                type: 'object',
                properties: {
                  task: {
                    type: 'string',
                    description: 'Description of the task to delegate',
                  },
                },
                required: ['task'],
              },
              source: 'discovered',
              lowering: 'delegate',
            }),
            entry,
          ),
        );
        admittedDiscovered++;
        continue;
      }

      if (vtId.startsWith('api:')) {
        // Skip if already in tools (from coreApis)
        if (tools.some((t) => t.toolId === vtId)) continue;

        // Look up in discovered API specs (from _discoveredApiToolSpecs cache)
        const fromDiscovered = discoveredApiToolSpecs?.find((s) => s.toolId === vtId);
        if (fromDiscovered) {
          tools.push(stampToolProvenance(fromDiscovered, entry));
          admittedDiscovered++;
          continue;
        }

        // Fallback: look in coreApis specs (if the endpoint is in a coreApis definition)
        const fromCore = apiToolSpecs?.find((s) => s.toolId === vtId);
        if (fromCore) {
          tools.push(stampToolProvenance(fromCore, entry));
          admittedDiscovered++;
          continue;
        }

        // Promoted but unresolvable: `_virtualTools` carries the marker but
        // neither `_discoveredApiToolSpecs` nor `coreApis` has the spec.
        // This shouldn't happen — promote writes both in one updateSessionState
        // — so log loudly so a regression surfaces in production logs rather
        // than reaching the LLM as a missing-tool hallucination.
        getOrchestratorLogger().warn(
          `[buildAvailableTools] Promoted API tool "${vtId}" has no resolvable spec ` +
            `(discoveredCount=${String(discoveredApiToolSpecs?.length ?? 0)}, ` +
            `coreCount=${String(apiToolSpecs?.length ?? 0)}). ` +
            'Promote write may have been lost; agent will not see this tool.',
        );
        continue;
      }

      if (vtId.startsWith('mcp:')) {
        if (tools.some((t) => t.toolId === vtId)) continue;

        const fromDiscoveredMcp = discoveredMcpToolSpecs?.find((s) => s.toolId === vtId);
        if (fromDiscoveredMcp) {
          tools.push(stampToolProvenance(fromDiscoveredMcp, entry));
          admittedDiscovered++;
          continue;
        }

        const fromCoreMcp = mcpToolSpecs?.find((s) => s.toolId === vtId);
        if (fromCoreMcp) {
          tools.push(stampToolProvenance(fromCoreMcp, entry));
          admittedDiscovered++;
          continue;
        }

        // See API branch above — same invariant, same regression signal.
        getOrchestratorLogger().warn(
          `[buildAvailableTools] Promoted MCP tool "${vtId}" has no resolvable spec ` +
            `(discoveredCount=${String(discoveredMcpToolSpecs?.length ?? 0)}, ` +
            `coreCount=${String(mcpToolSpecs?.length ?? 0)}). ` +
            'Promote write may have been lost; agent will not see this tool.',
        );
        continue;
      }

      // Operation virtual tool
      const op = getOperation(vtId);
      if (!op) continue;
      if (op.internal || !op.agentTool) continue;

      let inputSchema: Record<string, unknown> = { type: 'object', properties: {} };
      const fullSchemaDiscovered = toJsonSchemaSync(op.inputZod);
      if (op.internalFields?.input) {
        const props = (fullSchemaDiscovered as Record<string, unknown>)['properties'] as
          Record<string, unknown> | undefined;
        if (props) {
          for (const field of op.internalFields.input) {
            delete props[field];
          }
        }
      }
      inputSchema = pruneSchemaForAgent(fullSchemaDiscovered as Record<string, unknown>);

      tools.push(
        stampToolProvenance(
          buildVirtualToolSpec({
            operationId: vtId,
            stepType: op.stepType,
            name: op.name,
            description: op.semanticDescription,
            inputSchema,
            source: 'discovered',
          }),
          entry,
        ),
      );
      admittedDiscovered++;
    }

    if (droppedAtCap && droppedAtCap.length > 0) {
      getOrchestratorLogger().warn(
        `[buildAvailableTools] LRU cap reached: ${String(droppedAtCap.length)} promoted ` +
          `tool(s) dropped from the agent surface (cap=${String(MAX_VIRTUAL_TOOLS)} discovered, ` +
          `agent has ${String(discoveredEntries.length)} in _virtualTools). ` +
          `Dropped (least-recently-used first): ${droppedAtCap.slice(0, 5).join(', ')}` +
          (droppedAtCap.length > 5 ? `,... (+${String(droppedAtCap.length - 5)} more)` : '') +
          '. Re-promote them via catalog.tool.promote to bump them to most-recent.',
      );
    }
  }

  return applyToolAccess(tools, access);
}

/**
 * Build a typed input schema for a tool step by:
 * 1. Loading the operation's real input schema from the catalog
 * 2. Removing fields already satisfied by static config or literal/state bindings
 * 3. Returning only what the agent needs to produce as args
 *
 * Config values with `${input.*}` refs are agent-provided — those stay in the
 * schema. Fields with `${state.*}` refs, static values, or other non-input
 * refs are removed.
 */
export function buildToolInputSchema(
  stepDef: StepDefinition,
  agentDef?: AgentDefinition,
): Record<string, unknown> {
  // If the step defines an explicit inputSchema override, use it directly.
  // This is an escape hatch for cases where the operation schema and variable
  // bindings can't express the desired tool shape.
  if (stepDef.inputSchema) {
    return stepDef.inputSchema;
  }

  const op = getOperation(stepDef.operation);
  if (!op?.inputZod) {
    // No catalog entry — fall back to permissive schema
    return { type: 'object', additionalProperties: true };
  }

  let fullSchema: Record<string, unknown>;
  try {
    fullSchema = toJsonSchemaSync(op.inputZod, { draft: 'draft-2020-12' }) as Record<
      string,
      unknown
    >;
  } catch {
    return { type: 'object', additionalProperties: true };
  }

  const properties = fullSchema['properties'] as Record<string, unknown> | undefined;
  if (!properties) return fullSchema;

  // Build a lookup of state variable schemas by variableId for ${input.*} narrowing.
  const stateVarSchemas = new Map<string, Record<string, unknown>>();
  if (agentDef) {
    for (const sv of agentDef.stateVariables) {
      stateVarSchemas.set(sv.variableId, sv.typeSchema);
    }
  }

  // Determine which fields are already satisfied (not needed from agent).
  // Config values with ${input.*} refs mean the agent provides them — and we
  // rename the field from the operation field name to the variable name, using
  // the variable's typeSchema for the type. This lets graph steps expose a
  // clean, typed interface derived from the agent's state variables.
  const config = stepDef.config;
  const satisfiedFields = new Set<string>();
  // Tracks ${input.varName} renames: operation field → { varName, schema }
  const inputBindings = new Map<
    string,
    { varName: string; schema: Record<string, unknown> | undefined }
  >();

  /**
   * Recursively collect all ${input.varName} refs from a config value.
   * This allows nested objects like `config: { cancel: '${input.cancelFlag}' }`
   * to expose `cancelFlag` as a top-level tool parameter.
   */
  function collectInputRefs(value: unknown): string[] {
    if (typeof value === 'string') {
      const match = /^\$\{input\.([^}]+)\}$/.exec(value);
      return match ? [match[1]!] : [];
    }
    if (Array.isArray(value)) {
      return value.flatMap((item) => collectInputRefs(item));
    }
    if (value !== null && typeof value === 'object') {
      return Object.values(value as Record<string, unknown>).flatMap((v) => collectInputRefs(v));
    }
    return [];
  }

  for (const fieldName of Object.keys(properties)) {
    const configVal = config[fieldName];
    if (configVal === undefined) continue; // Not in config — agent must provide

    if (typeof configVal === 'string') {
      // Check for ${input.varName} — agent provides this via a named variable.
      // Extract the variable name and use its typeSchema for the exposed field.
      const inputMatch = /^\$\{input\.([^}]+)\}$/.exec(configVal);
      if (inputMatch) {
        const varName = inputMatch[1]!;
        const varSchema = stateVarSchemas.get(varName);
        inputBindings.set(fieldName, { varName, schema: varSchema });
        satisfiedFields.add(fieldName); // Remove the original operation field
        continue;
      }
      // Compound ${input.*} (embedded in larger string) — keep original field
      if (configVal.includes('${input.')) {
        continue;
      }
      // Check for ${state.*} — already satisfied from state
      if (configVal.includes('${state.')) {
        satisfiedFields.add(fieldName);
        continue;
      }
    }

    // Non-string values: check for nested ${input.*} refs
    if (typeof configVal !== 'string') {
      const nestedRefs = collectInputRefs(configVal);
      if (nestedRefs.length > 0) {
        // Mark the operation field as satisfied (it has static structure)
        satisfiedFields.add(fieldName);
        // Expose each nested ref as a top-level tool parameter
        for (const varName of nestedRefs) {
          const varSchema = stateVarSchemas.get(varName);
          inputBindings.set(`${fieldName}.${varName}`, { varName, schema: varSchema });
        }
        continue;
      }
    }

    // Non-string or plain string — static value, agent doesn't need to supply
    satisfiedFields.add(fieldName);
  }

  // Build filtered schema with only agent-required fields
  const filteredProperties: Record<string, unknown> = {};
  for (const [fieldName, fieldSchema] of Object.entries(properties)) {
    if (!satisfiedFields.has(fieldName)) {
      filteredProperties[fieldName] = fieldSchema;
    }
  }

  // Add renamed ${input.*} bindings with their variable schemas
  const renamedRequired: string[] = [];
  for (const [_opField, { varName, schema }] of inputBindings) {
    // Use the variable's typeSchema if available, otherwise fall back to
    // the operation field's original schema
    filteredProperties[varName] = schema ?? { type: 'string' };
    renamedRequired.push(varName);
  }

  // Rebuild required array without satisfied fields, plus renamed bindings
  const originalRequired = (fullSchema['required'] as string[] | undefined) ?? [];
  const filteredRequired = [
    ...originalRequired.filter((r) => !satisfiedFields.has(r)),
    ...renamedRequired,
  ];

  // Detect passthrough schemas (Zod .passthrough() → additionalProperties: true).
  // Gemini strips additionalProperties, so the model won't know it can pass extra
  // fields. Add a schema-level description to communicate this generically.
  const isPassthrough = fullSchema['additionalProperties'] === true;

  return {
    type: 'object',
    properties: filteredProperties,
    ...(filteredRequired.length > 0 && { required: filteredRequired }),
    // Allow additional properties — the agent may repeat a field that's also
    // statically configured, and that's fine (static value wins).
    additionalProperties: true,
    ...(isPassthrough
      ? {
          description:
            'This function accepts additional input parameters as direct top-level ' +
            'properties alongside the listed ones. Do not nest them in sub-objects.',
        }
      : {}),
  };
}

// ============================================================================
// Agent turn input assembly
// ============================================================================

/**
 * The instant this run is set at, which is not always now.
 *
 * A sealed eval fixture pins the clock its simulated integrations answer at.
 * Left on the wall clock, the agent and its world disagree: it reads a
 * relative date against today while the world sits at the anchor, and the case
 * measures the calendar rather than the agent.
 *
 * One HGET against a hash the session already has hot. A lookup that fails
 * falls back to the wall clock and says so — a run that cannot read its pin is
 * still runnable, but an operator has to be able to tell that batch apart from
 * one that was never pinned.
 */
async function resolveTurnTimestamp(tenantId: string, runId: string): Promise<string> {
  try {
    const { getRedisConnection, getSimulationRunInput } = await import('@aflow/redis');
    const input = await getSimulationRunInput(getRedisConnection(), tenantId, runId);
    if (input?.clockAnchorMs !== undefined) return new Date(input.clockAnchorMs).toISOString();
  } catch (err) {
    getOrchestratorLogger().warn(
      `[agent-turn] run clock lookup failed for ${runId}; falling back to wall time: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return new Date().toISOString();
}

/**
 * What assembling an agent turn's input leaves for the turn's step state to
 * carry: the attention items its attention block shows, consumed only once
 * the turn succeeds.
 */
export interface AgentTurnStepRecord {
  attentionItemIds?: string[];
}

/**
 * Build a full AgentTurnInput payload for scheduling an agent turn step.
 *
 * State-variable-first architecture:
 * - User input: read ONLY from `ai.agent.chatInput.<stepId>` state variable
 * - Config resolution: uses `${state.*}` only (empty rawInput)
 * - Tool results: passed as lastToolResults parameter
 * - Context: resolved from step config `${state.*}` references
 * - Conversation state: from `ai.agent.conversation.<stepId>` state variable
 */
export async function buildAgentTurnInput(
  agentDef: AgentDefinition,
  stepDef: StepDefinition,
  _rawInput: Record<string, unknown>,
  runtimeState: NonNullable<SessionHotState['runtimeState']>,
  tenantId: string,
  runId: string,
  lastToolResults?: ToolResultSummary[],
  payloadStore?: PayloadStore,
  flowContextDetails?: AgentFlowContextDetails,
  spaceContext?: SpaceContext,
  /** Override from agent.control.delegate — takes precedence over step config agentRole */
  agentRoleOverride?: 'assistant' | 'subagent',
  delegationContextJson?: string,
  finalOutputSchemaOverrideJson?: string,
  grant?: RunAccessGrant | null,
  stepRecord?: AgentTurnStepRecord,
): Promise<string> {
  // Build rawInput from state variables so ${input.*} refs resolve (e.g. ${input.step_types}).
  // Input-role state variables are stored during flow start with the same variable IDs.
  const rawInput: Record<string, unknown> = {};
  for (const varDef of agentDef.stateVariables) {
    if (varDef.lifecycle.isInput) {
      const entry = runtimeState.variables[varDef.variableId] as
        { ref?: { kind: string; value?: unknown } } | undefined;
      if (entry?.ref?.kind === 'inline' && entry.ref.value !== undefined) {
        rawInput[varDef.variableId] = entry.ref.value;
      }
    }
  }
  const rc = resolveConfigRecursive(stepDef.config, rawInput, runtimeState) as Record<
    string,
    unknown
  >;

  let catalogConfig = rc['catalog'] as CatalogConfig | undefined;

  // 104f/104g: Merge runner_tools from session state into coreOperations.
  // When a cybernetic workflow task declares context.tools, those tool IDs
  // flow via the delegation input as runner_tools → state variable. Here we
  // merge them into the effective coreOperations so the Runner can call them.
  // The delegation refuses an excluded op on this channel; dropping it here
  // too keeps it off a Runner whose state was written some other way.
  const runnerToolsVar = runtimeState.variables['runner_tools'] as
    { ref?: { kind: string; value?: unknown } } | undefined;
  if (
    runnerToolsVar?.ref?.kind === 'inline' &&
    Array.isArray(runnerToolsVar.ref.value) &&
    runnerToolsVar.ref.value.length > 0
  ) {
    const extraTools = runnerToolsVar.ref.value.filter(
      (t): t is string => typeof t === 'string' && !isRunnerExcludedOperation(t),
    );
    if (extraTools.length > 0) {
      const existingOps = catalogConfig?.coreOperations ?? [];
      const merged = [...new Set([...existingOps, ...extraTools])];
      catalogConfig = { ...catalogConfig, coreOperations: merged };
    }
  }

  catalogConfig = withGuaranteedReadOps(catalogConfig);

  // 104n: Read structured capability grants from session state.
  // When a cybernetic task declares context.capabilities with API/MCP grants,
  // the delegation input carries runner_capability_grants → state variable.
  // API grants are promoted as endpoint-filtered, binding-aware virtual tools.
  // MCP grants promote whole servers to coreMcpServers (tool-level filtering deferred).
  let parsedApiGrants: ParsedApiGrant[] | undefined;
  let parsedMcpGrants: ParsedMcpGrant[] | undefined;
  let promotableOps: string[] | undefined;

  const capGrantsVar = runtimeState.variables['runner_capability_grants'] as
    { ref?: { kind: string; value?: unknown } } | undefined;
  if (
    capGrantsVar?.ref?.kind === 'inline' &&
    capGrantsVar.ref.value &&
    typeof capGrantsVar.ref.value === 'object'
  ) {
    const grants = capGrantsVar.ref.value as {
      integrations?: Array<Record<string, unknown>>;
      promotable?: { operations?: unknown };
    };

    // Tier 2 of the task grant: ops the task may promote at runtime. They stay
    // off the default surface; declaring any makes catalog.tool.promote
    // available and bounds it (via the discovery scope) to exactly this set.
    // Plan 269 D7 and Plan 322 D3 — a task grant can never confer the ruler or
    // the plan: these ops feed the discovery scope's allowedOperationIds,
    // which authorizes promotion, so an eval.* or plan.* entry here would put
    // it on the Runner's tool surface. Skill validity rejects the authored
    // form; this closes the caller-supplied one.
    if (Array.isArray(grants.promotable?.operations)) {
      const ops = grants.promotable.operations.filter(
        (op): op is string =>
          typeof op === 'string' && op.length > 0 && !isRunnerExcludedOperation(op),
      );
      if (ops.length > 0) {
        promotableOps = ops;
        const existingOps = catalogConfig?.coreOperations ?? [];
        if (!existingOps.includes(CATALOG_PROMOTE_OPERATION_ID)) {
          catalogConfig = {
            ...catalogConfig,
            coreOperations: [...existingOps, CATALOG_PROMOTE_OPERATION_ID],
          };
        }
      }
    }

    if (Array.isArray(grants.integrations) && grants.integrations.length > 0) {
      for (const grant of grants.integrations) {
        const sourceKind = grant['sourceKind'];
        const integrationId = grant['integrationId'];
        if (typeof integrationId !== 'string') continue;
        const capabilityId = (grant['capabilityId'] as string | undefined) ?? integrationId;
        // Fail closed: a grant deferred to the run's connection
        // (`binding.kind === 'connection'`) that reached dispatch unresolved — or
        // any malformed/absent binding — withholds its tools rather than
        // scope-resolving an arbitrary apiId account. The connection→binding pin
        // (resolveConnectionGrantsToBinding) runs before this parser.
        const binding = grant['binding'] as { kind?: string; bindingId?: string } | undefined;
        if (binding?.kind !== 'binding' || typeof binding.bindingId !== 'string') continue;
        const bindingId = binding.bindingId;
        const toolNamesArr = Array.isArray(grant['toolNames'])
          ? (grant['toolNames'] as Array<Record<string, unknown>>).filter(
              (t) => typeof t['toolName'] === 'string',
            )
          : [];
        const allTools = grant['allTools'] === true;

        if (sourceKind === 'api') {
          parsedApiGrants ??= [];
          parsedApiGrants.push({
            capabilityId,
            bindingId,
            apiId: integrationId,
            endpoints: toolNamesArr.map((t) => ({ endpointId: t['toolName'] as string })),
            allEndpoints: allTools,
          });
        } else if (sourceKind === 'mcp') {
          parsedMcpGrants ??= [];
          parsedMcpGrants.push({
            capabilityId,
            bindingId,
            serverId: integrationId,
            tools: toolNamesArr.map((t) => ({ toolName: t['toolName'] as string })),
            allTools,
          });
        }
      }
    }

    // API capability grants are NOT merged into `coreApis` — doing so promoted an
    // unpinned `api:<apiId>/*` duplicate alongside the binding-pinned grant tools.
    // Grants are promoted solely by the binding-aware grant path below (pinned to
    // the run's connection); `catalogConfig.coreApis` stays the agent's own static
    // declaration. See capabilityGrantsToCatalog.ts.
  }

  // Operator override of the Helmsman's discovery ceiling (Plan 233 Part 3).
  // The platform def carries the curated preset in
  // `discovery.allowedOperationIds`; when the space's directives set an
  // explicit list it REPLACES the preset (widen / shrink / off). Runner tasks
  // are unaffected (their scope is grant-derived, not authored discovery).
  const spaceDirectivesForDiscovery = (
    spaceContext as { space?: { directives?: unknown } } | undefined
  )?.space?.directives;
  const isHelmsman = isCyberneticHelmsman(agentDef.metadata, spaceDirectivesForDiscovery);

  // The Helmsman's two tiers, composed for the edition this process runs as
  // (Plan 313 §D5). Ahead of the operator override on purpose: the override is
  // the operator's opinion about the surface the platform composed, so it
  // layers over this result rather than over the hosted default.
  if (catalogConfig && isHelmsmanDefinition(agentDef.metadata)) {
    const composed = composeHelmsmanSurface(
      {
        coreOperations: catalogConfig.coreOperations ?? [],
        promotableOperations: catalogConfig.discovery?.allowedOperationIds ?? [],
      },
      processEditionDescriptor(),
    );
    catalogConfig = {
      ...catalogConfig,
      coreOperations: composed.coreOperations,
      ...(catalogConfig.discovery
        ? {
            discovery: {
              ...catalogConfig.discovery,
              allowedOperationIds: composed.promotableOperations,
            },
          }
        : {}),
    };
  }

  if (catalogConfig?.discovery && isHelmsman) {
    const override = resolveHelmsmanDiscoveryOverride(spaceDirectivesForDiscovery);
    if (override) {
      // The operator's ceiling is a choice among capabilities the deployment
      // has; a lane the edition does not compose is not one of them.
      const lanes = processEditionDescriptor();
      catalogConfig = {
        ...catalogConfig,
        discovery: {
          ...catalogConfig.discovery,
          allowedOperationIds: override.filter((op) => isOperationComposed(op, lanes)),
        },
      };
    }
  }

  // Bundles the operator has shed, and the connections this agent may reach.
  // Deliberately NOT nested under the `discovery` guard above: shedding the
  // pinned tier is what moves tokens and has nothing to do with whether this
  // agent was authored with a discovery block.
  const capabilitySettings = applyCapabilitySettings(
    catalogConfig,
    isHelmsman ? spaceDirectivesForDiscovery : undefined,
  );
  catalogConfig = capabilitySettings.catalogConfig;
  const { shedCapabilityGroups, connectionAllowlist, pinnedConnections } = capabilitySettings;

  let resolvedDiscoveryScope: DiscoveryScope | undefined;
  if (catalogConfig) {
    resolvedDiscoveryScope = resolveDiscoveryScope(catalogConfig, parsedMcpGrants, promotableOps);
    if (resolvedDiscoveryScope) {
      runtimeState.variables[DISCOVERY_SCOPE_VAR] = {
        ref: { kind: 'inline', value: resolvedDiscoveryScope },
      };
      // Also write per-step scope for future multi-agent-step support
      runtimeState.variables[`${DISCOVERY_SCOPE_VAR}.${stepDef.stepId}`] = {
        ref: { kind: 'inline', value: resolvedDiscoveryScope },
      };
    }
  }

  const virtualToolsVar = runtimeState.variables['ai.agent._virtualTools'] as
    { ref?: { kind: string; value?: unknown } } | undefined;
  const virtualToolsState = withPromotedToolsRevoked(
    virtualToolsVar?.ref?.kind === 'inline' &&
      typeof virtualToolsVar.ref.value === 'object' &&
      virtualToolsVar.ref.value !== null
      ? (virtualToolsVar.ref.value as Record<string, VirtualToolEntry>)
      : undefined,
    shedCapabilityGroups,
    connectionAllowlist,
  );

  const {
    coreAgentMetas,
    mergedApiToolSpecs,
    discoveredApiToolSpecs,
    mergedMcpToolSpecs,
    discoveredMcpToolSpecs,
    appletToolSpecs,
    connectionToolSpecs,
  } = await resolveTurnToolSurface({
    catalogConfig,
    runtimeState,
    parsedApiGrants,
    parsedMcpGrants,
    tenantId,
    runId,
    spaceId: flowContextDetails?.space?.id ?? spaceContext?.space.id,
    pinnedConnections,
  });

  const availableTools = buildAvailableTools(
    agentDef,
    stepDef.stepId,
    catalogConfig,
    virtualToolsState,
    coreAgentMetas,
    mergedApiToolSpecs,
    discoveredApiToolSpecs,
    mergedMcpToolSpecs,
    discoveredMcpToolSpecs,
    appletToolSpecs,
    { grant: grant ?? null },
    connectionToolSpecs,
  );

  // Persist this turn's exact tool surface. The virtual-tool lowering
  // (applyAgentDecision) admits only toolIds recorded here — the model's
  // decision cannot name an operation it was never handed, regardless of
  // provider function-calling behavior or JSON-fallback repair paths.
  const toolSurface = availableTools.map((t) => t.toolId);
  runtimeState.variables[`${TOOL_SURFACE_VAR}.${stepDef.stepId}`] = {
    ref: { kind: 'inline', value: toolSurface },
  };

  // Turn tracking from runtime state
  const turnVar = runtimeState.variables[`ai.agent.turnNumber.${stepDef.stepId}`] as
    { ref?: { kind: string; value?: unknown } } | undefined;
  const turnNumber =
    turnVar?.ref?.kind === 'inline' && typeof turnVar.ref.value === 'number'
      ? turnVar.ref.value
      : 0;

  // Prompt from config (for top-level metadata, not for user message)
  const prompt = ((rc['prompt'] ?? rc['goal'] ?? '') as string) || '';

  const totalCallsVar = runtimeState.variables[`ai.agent.totalCalls.${stepDef.stepId}`] as
    { ref?: { kind: string; value?: unknown } } | undefined;
  const totalToolCallsSoFar =
    totalCallsVar?.ref?.kind === 'inline' && typeof totalCallsVar.ref.value === 'number'
      ? totalCallsVar.ref.value
      : 0;

  const lastTurnAtVar = runtimeState.variables[
    `ai.agent.lastTurnCompletedAtMs.${stepDef.stepId}`
  ] as { ref?: { kind: string; value?: unknown } } | undefined;
  const lastTurnCompletedAtMs =
    lastTurnAtVar?.ref?.kind === 'inline' && typeof lastTurnAtVar.ref.value === 'number'
      ? lastTurnAtVar.ref.value
      : undefined;

  const turnPolicy = (rc['turnPolicy'] ?? {}) as Record<string, unknown>;

  let configAgentRole: AgentRole | undefined = agentRoleOverride;
  if (!configAgentRole && (rc['agentRole'] === 'assistant' || rc['agentRole'] === 'subagent')) {
    configAgentRole = rc['agentRole'];
  }

  // Nobody is waiting on a run a clock or an inbound call started, so the
  // assistant's open-ended shape — pause, stay resumable — leaves it parked on a
  // question no one will read. The trigger is passed as a fact rather than
  // decided here: the resolver owns what each shape means, and it is the same
  // resolver the decision and recovery paths use.
  const policies = resolveAgentPoliciesFromConfig(rc, {
    agentRoleOverride: configAgentRole,
    trigger: flowContextDetails?.trigger,
  });

  const allowComplete = policies.completionPolicy !== 'open_ended';
  const contextProfile = resolveContextProfile(rc['contextProfile']);

  // Conversation state from runtime state
  const convStateVarKey = `ai.agent.conversation.${stepDef.stepId}`;
  const convStateVar = runtimeState.variables[convStateVarKey] as
    { ref?: { kind: string; payloadRef?: string } } | undefined;
  const conversationStateRef =
    convStateVar?.ref?.kind === 'ref' ? convStateVar.ref.payloadRef : undefined;

  const agentName = agentDef.metadata.name;
  const agentDescription = agentDef.metadata.description;

  // Pass the MERGED catalog config (runner_tools + auto-granted promote +
  // read floor), not the raw authored one — the awareness block dedups
  // against the agent's real tool surface.
  const { markdown: catalogMarkdown, summary: discoverableSummary } = buildCatalogForAgent(
    catalogConfig,
    runtimeState,
    runId,
    resolvedDiscoveryScope,
  );

  // Resolve context blocks from config
  const contextBlocks: Array<{
    key: string;
    content: unknown;
    cacheHint?: 'stable' | 'run_stable' | 'volatile';
  }> = [];
  const resolvedContext = rc['context'] as Record<string, unknown> | undefined;
  if (resolvedContext) {
    for (const [k, v] of Object.entries(resolvedContext)) {
      if (v === undefined || v === null) continue;
      if (
        payloadStore &&
        typeof v === 'string' &&
        (v.startsWith('gs://') || v.startsWith('inline:'))
      ) {
        try {
          const data = await payloadStore.retrieve(v as never);
          contextBlocks.push({ key: k, content: data });
        } catch {
          contextBlocks.push({ key: k, content: v });
        }
      } else {
        contextBlocks.push({ key: k, content: v });
      }
    }
  }

  const agentRunContext = buildFlowRunContext(
    contextProfile,
    flowContextDetails,
    agentDef,
    stepDef.stepId,
    agentName,
  );
  const finalContextBlocks = contextBlocks.filter((block) => !isFlowContextBlockKey(block.key));
  finalContextBlocks.unshift({
    key: 'FlowRunContext',
    // Run-stable, not space-stable: this block carries `runId`, and while it is
    // fixed for one run it differs between runs. Sharing a cache block with
    // `SpaceContext` would invalidate the space's whole context on every new
    // session, which is what this tier exists to prevent.
    cacheHint: 'run_stable' as const,
    content: agentRunContext,
  });

  const loopWarning = readInlineVar(
    runtimeState,
    `ai.agent.loopWarning.${stepDef.stepId}`,
    null as {
      repeatedActionCount?: number;
      repeatedActionSignature?: string;
      severity?: 'warning' | 'final_warning';
      message?: string;
      instruction?: string;
    } | null,
  );
  if (loopWarning) {
    finalContextBlocks.splice(1, 0, {
      key: 'LoopWarning',
      cacheHint: 'volatile' as const,
      content: {
        severity: loopWarning.severity ?? 'warning',
        repeatedActionCount: loopWarning.repeatedActionCount ?? 0,
        ...(loopWarning.message ? { message: loopWarning.message } : {}),
        ...(loopWarning.instruction ? { instruction: loopWarning.instruction } : {}),
        ...(loopWarning.repeatedActionSignature
          ? { repeatedActionSignature: loopWarning.repeatedActionSignature }
          : {}),
      },
    });
  }

  const wasInterrupted = readInlineVar(
    runtimeState,
    `ai.agent.wasInterrupted.${stepDef.stepId}`,
    false as boolean,
  );
  if (wasInterrupted) {
    finalContextBlocks.splice(loopWarning ? 2 : 1, 0, {
      key: 'InterruptNotice',
      cacheHint: 'volatile' as const,
      content:
        'The user interrupted the flow. Your previous action was not executed. ' +
        'The user is providing new input or changing direction. ' +
        'Read their message carefully and adjust your approach accordingly.',
    });
  }

  const spaceDirectives = (spaceContext as { space?: { directives?: unknown } } | undefined)?.space
    ?.directives;

  // Who the session is FOR, as an authenticated product would already know.
  // Pushed for every agent rather than the cybernetic path alone: a Runner
  // executing a skill against the same integration is the same caller.
  //
  // Resolved at run start (it must not move mid-run) but narrowed HERE, to the
  // connections this turn can actually reach: naming a caller for an
  // integration the allowlist excludes would hand the agent an identity it has
  // no tool to act as. An absent allowlist is unconstrained, not empty.
  const allDisclosedCallers = flowContextDetails?.disclosedCallers ?? [];
  const reachableIntegrationIds =
    connectionAllowlist === undefined
      ? undefined
      : new Set(
          connectionAllowlist
            .filter((entry) => entry.sourceKind === 'api')
            .map((entry) => entry.integrationId),
        );
  const disclosedCallers =
    reachableIntegrationIds === undefined
      ? allDisclosedCallers
      : allDisclosedCallers.filter((entry) => reachableIntegrationIds.has(entry.integrationId));
  if (disclosedCallers.length > 0) {
    finalContextBlocks.push({
      key: 'CallerIdentity',
      content: renderDisclosedCallers(disclosedCallers),
    });
  }

  const sessionParticipantsBlock = buildSessionParticipantsBlock(flowContextDetails?.participants);
  if (sessionParticipantsBlock) {
    finalContextBlocks.push(sessionParticipantsBlock);
  }

  if (delegationContextJson && contextProfile !== 'minimal') {
    try {
      const dc = JSON.parse(delegationContextJson) as Record<string, unknown>;
      const parts: string[] = ['You were delegated this task by a parent agent.'];
      if (dc['objective'])
        parts.push(`**Objective:** ${formatDelegationFieldForPrompt(dc['objective'])}`);
      if (dc['parentSummary']) {
        parts.push(`**From parent:** ${formatDelegationFieldForPrompt(dc['parentSummary'])}`);
      }
      if (Array.isArray(dc['constraints']) && dc['constraints'].length > 0) {
        parts.push(`**Constraints:** ${(dc['constraints'] as string[]).join('; ')}`);
      }
      if (dc['relevantState'] && typeof dc['relevantState'] === 'object') {
        parts.push(`**Relevant state:** ${JSON.stringify(dc['relevantState'])}`);
      }
      if (Array.isArray(dc['externalServices']) && dc['externalServices'].length > 0) {
        const services = dc['externalServices'] as Array<Record<string, unknown>>;
        const lines: string[] = [
          '**External services (TYPED OBLIGATIONS — MUST be mirrored into your output):**',
        ];
        for (const s of services) {
          const id = formatDelegationFieldForPrompt(s['identifier'] ?? '');
          const kind = formatDelegationFieldForPrompt(s['sourceKind'] ?? '');
          const status = formatDelegationFieldForPrompt(s['status'] ?? '');
          const apiId = s['apiId'] ? ` apiId=${formatDelegationFieldForPrompt(s['apiId'])}` : '';
          const bindingId = s['bindingId']
            ? ` bindingId=${formatDelegationFieldForPrompt(s['bindingId'])}`
            : '';
          const serverId = s['serverId']
            ? ` serverId=${formatDelegationFieldForPrompt(s['serverId'])}`
            : '';
          const rationale = s['rationale']
            ? ` — ${formatDelegationFieldForPrompt(s['rationale'])}`
            : '';
          lines.push(`- [${kind}:${status}] ${id}${apiId}${bindingId}${serverId}${rationale}`);
        }
        lines.push(
          'For each entry, emit one requiredCapabilities entry (kind=sourceKind, identifier=apiId|bindingId|serverId|identifier) AND one requiredDataSources entry (sourceKind matching, sourceId matching). Dropping a typed obligation is a hard error.',
        );
        parts.push(lines.join('\n'));
      }
      finalContextBlocks.push({ key: 'DelegationContext', content: parts.join('\n') });
    } catch {
      /* best-effort — skip if JSON is invalid */
    }
  }

  if (catalogMarkdown) {
    finalContextBlocks.push({ key: 'DiscoverableTools', content: catalogMarkdown });
  }

  // Voice mode: inject voice behavior instructions so the LLM produces speech-friendly output.
  // Checks voiceMode (mutable, set per-turn) OR trigger='voice' (immutable, set at run creation).
  const isVoiceMode =
    flowContextDetails?.voiceMode === true || flowContextDetails?.trigger === 'voice';
  if (isVoiceMode) {
    finalContextBlocks.push({
      key: 'VoiceMode',
      content:
        'VOICE MODE — Your text is spoken aloud. Think of yourself as a commentator: brief, natural, conversational.\n\n' +
        'Voice (your text): 1-2 sentences. No markdown, lists, code, or URLs. Plain spoken language.\n' +
        'Chat (message param): Full details — markdown, lists, tables, code all fine.\n\n' +
        'Pattern: voice = short commentary, message = the real content.\n' +
        'Example: voice "Here are three results, take a look." → message "1. **Result A** — ...\\n2. **Result B** — ..."\n\n' +
        'Do not repeat voice content in message. They complement each other.',
    });
  }

  appendTrailingContextBlocks(finalContextBlocks, contextProfile, turnNumber, totalToolCallsSoFar);

  if (finalContextBlocks.length > 0) {
    const contextSizes: Record<string, number> = {};
    for (const block of finalContextBlocks) {
      const v = block.content;
      contextSizes[block.key] = typeof v === 'string' ? v.length : JSON.stringify(v).length;
    }
    getOrchestratorLogger().debug(
      `agentTurn: context blocks keys=${finalContextBlocks.map((b) => b.key).join(',')}, sizes=${JSON.stringify(contextSizes)}`,
    );
  }

  const newToolResults = lastToolResults
    ? buildToolResultEnvelopes(lastToolResults, Date.now())
    : undefined;

  // ── State-variable-first: read user input from canonical state variable ──
  const chatInputVarKey = `ai.agent.chatInput.${stepDef.stepId}`;
  const chatInputVar = runtimeState.variables[chatInputVarKey] as
    { ref?: { kind: string; value?: unknown } } | undefined;
  const chatInputText =
    chatInputVar?.ref?.kind === 'inline' && typeof chatInputVar.ref.value === 'string'
      ? chatInputVar.ref.value
      : undefined;

  getOrchestratorLogger().debug(
    `agentTurn: chatInput key=${chatInputVarKey}, found=${!!chatInputVar}, text=${chatInputText ? chatInputText.slice(0, 80) : '<none>'}, turnNumber=${String(turnNumber)}, varKeys=${
      Object.keys(runtimeState.variables)
        .filter((k) => k.includes('chatInput'))
        .join(',') || '<none>'
    }`,
  );

  // What people said in the room while the agent was away. Best-effort: a
  // room the agent cannot read is a quieter turn, never a failed one.
  let newRoomMessages: RoomExchangeEntry[] = [];
  let currentSpeaker: RoomSpeaker | undefined;
  try {
    const { getDatabase } = await import('@aflow/database');
    const { readRoomExchange } = await import('./roomExchange.js');
    const room = await readRoomExchange(getDatabase(), tenantId as TenantId, runId);
    newRoomMessages = room.entries;
    currentSpeaker = room.latestSpeaker;
  } catch (err) {
    getOrchestratorLogger().warn(
      `agentTurn: could not read the room for ${runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // What runs this session started without waiting have reported since.
  // Best-effort like the room: an unread wakeup is read at the next turn.
  let newRunWakeups: WorkflowRunWakeupEntry[] = [];
  if (payloadStore) {
    try {
      const { getDatabase } = await import('@aflow/database');
      const { readRunWakeups } = await import('./runWakeups.js');
      newRunWakeups = await readRunWakeups(
        getDatabase(),
        payloadStore,
        tenantId as TenantId,
        runId,
      );
    } catch (err) {
      getOrchestratorLogger().warn(
        `agentTurn: could not read run wakeups for ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  let newUserInput:
    { userInputId: string; text: string; createdAtMs: number; author?: RoomSpeaker } | undefined;

  if (chatInputText) {
    const steeringAuthor = resolveSteeringAuthor(
      resolveTurnSpeaker(
        flowContextDetails?.user,
        flowContextDetails?.participants,
        currentSpeaker,
      ),
      flowContextDetails?.participants,
    );
    newUserInput = {
      userInputId: `run:${runId}:step:${stepDef.stepId}:turn:${String(turnNumber)}`,
      text: chatInputText,
      createdAtMs: Date.now(),
      // The same attribution room posts carry, but only once a second person
      // is in the roster — with several people a nameless steer reads as a
      // different speaker, while a solo session keeps its turns byte-identical.
      ...(steeringAuthor ? { author: steeringAuthor } : {}),
    };
    getOrchestratorLogger().debug(
      `agentTurn: newUserInput id=${newUserInput.userInputId}, text="${chatInputText.slice(0, 80)}"`,
    );
  } else {
    getOrchestratorLogger().debug(`agentTurn: no newUserInput for turn ${String(turnNumber)}`);
  }

  // System prompt from config
  const DEFAULT_SYSTEM_PROMPT =
    'You are a capable agent. Analyze the request and decide the best action to take.';
  let systemPrompt = rc['systemPrompt'] as string | undefined;
  if (
    typeof systemPrompt === 'string' &&
    (systemPrompt.startsWith('inline:') || systemPrompt.startsWith('gs://'))
  ) {
    systemPrompt = undefined;
  }
  if (!systemPrompt) {
    systemPrompt = DEFAULT_SYSTEM_PROMPT;
  }

  let cyberneticOverrides: CyberneticTurnOverrides | undefined;
  if (
    isCyberneticHelmsman(agentDef.metadata, spaceDirectives) &&
    flowContextDetails?.cyberneticHandles?.db &&
    flowContextDetails.cyberneticHandles.redis &&
    flowContextDetails.space?.id
  ) {
    try {
      cyberneticOverrides = await buildCyberneticTurnOverrides({
        tenantId: tenantId,
        spaceId: flowContextDetails.space.id,
        sessionId: runId,
        spaceName: flowContextDetails.space.name ?? 'Unknown',
        directives: spaceDirectives as EntityDirectives,
        db: flowContextDetails.cyberneticHandles.db as PostgresJsDatabase,
        redis: flowContextDetails.cyberneticHandles.redis as Redis,
        capabilities: resolveHelmsmanCapabilities(spaceContext, catalogConfig),
      });
      systemPrompt = cyberneticOverrides.systemPrompt;
      getOrchestratorLogger().debug(
        `agentTurn: cybernetic helmsman detected, using assembled prompt (${String(systemPrompt.length)} chars)`,
      );
    } catch (err) {
      getOrchestratorLogger().warn(
        `agentTurn: failed to build cybernetic overrides, falling back to default prompt: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (cyberneticOverrides) {
    finalContextBlocks.push(cyberneticOverrides.attentionContextBlock);
    if (stepRecord && cyberneticOverrides.attentionItemIds.length > 0) {
      stepRecord.attentionItemIds = cyberneticOverrides.attentionItemIds;
    }
  }

  // Spliced here rather than with the other blocks because the projection
  // depends on an outcome that is not known until now. Everything added in
  // between is a push, so the slot is unchanged.
  if (spaceContext && contextProfile !== 'minimal') {
    const role = resolveSpaceContextRole(agentDef.metadata, spaceDirectives);
    // The Helmsman projection drops the governance triple because
    // `buildGovernanceSection` renders it into the assembled prompt. When that
    // assembly failed the prompt fell back to the agent definition and carries
    // no governance at all, so stripping it here would leave the turn with no
    // statement of the space's mandate anywhere.
    const governanceIsInThePrompt = role !== 'helmsman' || cyberneticOverrides !== undefined;
    finalContextBlocks.splice(loopWarning ? 2 : 1, 0, {
      key: 'SpaceContext',
      // The cached object keeps `space.directives` — the orchestrator reads it
      // for Helmsman detection, the discovery override and model resolution.
      // Only the copy handed to the model is projected.
      content: projectSpaceContextForModel(spaceContext, governanceIsInThePrompt ? role : 'other'),
    });
  }

  if (spaceDirectives) {
    const directives = spaceDirectives as EntityDirectives;
    let resolvedRole: 'helmsman' | 'coach' | undefined;
    if (isCyberneticHelmsman(agentDef.metadata, spaceDirectives)) {
      resolvedRole = 'helmsman';
    } else if (isCyberneticCoach(agentDef.metadata, spaceDirectives)) {
      resolvedRole = 'coach';
    }
    if (resolvedRole) {
      rc['model'] = resolveRoleModel(directives.modelDefaults, resolvedRole);
      const reasoning = resolveRoleReasoning(directives.reasoningDefaults, resolvedRole);
      if (reasoning !== undefined) rc['reasoningEffort'] = reasoning;
    }
  }

  // Resolve optional finalOutputSchema and completionPrompt from config.
  let finalOutputSchema: Record<string, unknown> | undefined;
  if (finalOutputSchemaOverrideJson) {
    try {
      finalOutputSchema = JSON.parse(finalOutputSchemaOverrideJson) as Record<string, unknown>;
    } catch {
      finalOutputSchema = rc['finalOutputSchema'] as Record<string, unknown> | undefined;
    }
  } else {
    finalOutputSchema = rc['finalOutputSchema'] as Record<string, unknown> | undefined;
  }
  const completionPrompt = rc['completionPrompt'] as string | undefined;

  applySubmitOutputToolSchema(availableTools, finalOutputSchema);

  // Cap pressure for the inspector: promoted (virtual) tools carry provenance;
  // everything else counts against the pinned budget.
  const virtualUsed = availableTools.filter((t) => t.discoveredAtTurn !== undefined).length;
  const toolScope: ToolSurfaceScope = {
    pinnedUsed: availableTools.length - virtualUsed,
    pinnedMax: MAX_TOTAL_TOOLS,
    virtualUsed,
    virtualMax: MAX_VIRTUAL_TOOLS,
  };
  const toolSurfaceContext: ToolSurfaceContext = {
    scope: toolScope,
    ...(discoverableSummary ? { discoverable: discoverableSummary } : {}),
  };

  const agentTurnInput = {
    agentRole: policies.agentRole,
    requestInputPolicy: policies.requestInputPolicy,
    completionPolicy: policies.completionPolicy,
    ...(finalOutputSchema ? { finalOutputSchema } : {}),
    ...(completionPrompt ? { completionPrompt } : {}),
    systemPrompt,
    prompt,
    availableTools,
    toolSurfaceContext,
    conversationStateRef,
    ...(newUserInput ? { newUserInput } : {}),
    ...(newRoomMessages.length > 0 ? { newRoomMessages } : {}),
    ...(newRunWakeups.length > 0 ? { newRunWakeups } : {}),
    ...(newToolResults && newToolResults.length > 0 ? { newToolResults } : {}),
    ...(cyberneticOverrides?.activeMemory
      ? { activeMemoryInjection: cyberneticOverrides.activeMemory }
      : {}),
    ...(finalContextBlocks.length > 0 ? { contextBlocks: finalContextBlocks } : {}),
    contextProfile,
    policy: {
      maxToolCallsPerTurn:
        typeof turnPolicy['maxToolCallsPerTurn'] === 'number'
          ? turnPolicy['maxToolCallsPerTurn']
          : 5,
      allowParallel:
        typeof turnPolicy['allowParallel'] === 'boolean' ? turnPolicy['allowParallel'] : false,
      allowComplete,
    },
    model: rc['model'] as string | undefined,
    temperature: rc['temperature'] as number | undefined,
    maxTokens: rc['maxTokens'] as number | undefined,
    // Reasoning effort override resolved upstream from `EntityDirectives.reasoningDefaults`
    // (helmsman/coach in-session) or from agent-definition state vars (runner/coach via
    // `${state.<role>_reasoning_effort}`). Undefined → AI client falls through to the
    // catalog model's default reasoning. Filter out `null` (state-var unset) and the
    // unresolved literal that appears when ${state.…} interpolation didn't substitute.
    ...(rc['reasoningEffort'] === 'off' ||
    rc['reasoningEffort'] === 'low' ||
    rc['reasoningEffort'] === 'medium' ||
    rc['reasoningEffort'] === 'high'
      ? { reasoningEffort: rc['reasoningEffort'] }
      : {}),
    // Provider-native reasoning continuity (Plan 259), authored on the step
    // config (default `auto`). The executor resolves `auto` against the model's
    // provider and gates a named mode before any network I/O.
    ...(rc['reasoningContinuity'] === 'auto' ||
    rc['reasoningContinuity'] === 'off' ||
    rc['reasoningContinuity'] === 'tool_loop' ||
    rc['reasoningContinuity'] === 'conversation'
      ? { reasoningContinuity: rc['reasoningContinuity'] }
      : {}),
    turnNumber,
    totalToolCallsSoFar,
    turnTimestamp: await resolveTurnTimestamp(tenantId, runId),
    ...(lastTurnCompletedAtMs !== undefined ? { lastTurnCompletedAtMs } : {}),
    ...(agentName ? { agentName } : {}),
    ...(agentDescription ? { agentDescription } : {}),
    ...(isVoiceMode ? { voiceMode: true } : {}),
    ...(rc['contextWindowOverride']
      ? { contextWindowOverride: Number(rc['contextWindowOverride']) }
      : {}),
    ...(rc['summaryTemplate'] && typeof rc['summaryTemplate'] === 'object'
      ? { summaryTemplate: rc['summaryTemplate'] }
      : {}),
  };

  // A turn's input is assembled from the system prompt, the context blocks, the
  // tool surface and the conversation — none of them bounded — so it is one of
  // the values that routinely exceeds the inline cap. A ref past that cap is not
  // one the store resolves, so inlining it unconditionally produced a job whose
  // executor could not read its own input.
  return encodeTaskInput(
    payloadStore,
    { tenantId: tenantId, runId: runId, label: `agent turn input (${stepDef.stepId})` },
    agentTurnInput,
  );
}

function isFlowContextBlockKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return (
    normalized === 'flowcontext' || normalized === 'agentcontext' || normalized === 'flowruncontext'
  );
}

function toNamedEntity(entity?: {
  id?: string;
  name?: string;
}): { id?: string; name: string } | undefined {
  if (!entity?.id && !entity?.name) return undefined;
  return {
    ...(entity.id ? { id: entity.id } : {}),
    name: entity.name ?? entity.id ?? 'unknown',
  };
}

function resolveContextProfile(value: unknown): AgentContextProfile {
  return value === 'minimal' || value === 'default' || value === 'detailed' || value === 'debug'
    ? value
    : 'default';
}

function buildFlowRunContext(
  profile: AgentContextProfile,
  details: AgentFlowContextDetails | undefined,
  agentDef: AgentDefinition,
  stepId: string,
  agentName?: string,
): Record<string, unknown> {
  const context: Record<string, unknown> = {
    ...(details?.tenantId ? { tenantId: details.tenantId } : {}),
    ...(toNamedEntity(details?.space) ? { space: toNamedEntity(details?.space) } : {}),
    flow: {
      id: agentDef.flowId,
      name: agentName ?? agentDef.flowId,
    },
    ...(toNamedEntity(details?.user) ? { user: toNamedEntity(details?.user) } : {}),
    stepId,
  };

  // Trigger channel — always shown for non-chat triggers (agent needs to know
  // if it was invoked by a webhook, schedule, API, etc. to respond appropriately)
  if (profile !== 'minimal' && details?.trigger && details.trigger !== 'chat') {
    context['trigger'] = details.trigger;
  }

  if (profile === 'detailed' || profile === 'debug') {
    if (details?.runId) context['runId'] = details.runId;
    if (details?.env) context['env'] = details.env;
  }

  if (profile !== 'minimal' && details?.schedules && details.schedules.length > 0) {
    context['schedules'] = details.schedules;
  }

  return context;
}

// ============================================================================

/** Cache key for the compact catalog in SessionHotState runtime variables. */
const CATALOG_CACHE_VAR = 'ai.agent._catalogCache';

export const DISCOVERY_SCOPE_VAR = 'ai.agent._discoveryScope';

/**
 * Per-turn tool surface (keyed `${TOOL_SURFACE_VAR}.<agentStepId>`): the exact
 * toolIds handed to the model on its last turn. The virtual-tool lowering
 * admits members only — the enforcement half of "declared = ceiling".
 */
export const TOOL_SURFACE_VAR = 'ai.agent._toolSurface';

export interface DiscoveryMcpScopeEntry {
  serverId: string;
  bindingId?: string;
  toolNames?: string[];
}

export interface DiscoveryScope {
  allowedStepTypes: string[];
  /**
   * Operation-level allowlist. When present it is the SOLE authority for
   * platform-op discovery and promotion — `allowedStepTypes` does not widen
   * it. Sourced from the agent's authored `discovery.allowedOperationIds`
   * and/or a task grant's `promotable.operations`.
   */
  allowedOperationIds?: string[];
  allowedAgents?: boolean;
  allowedMcpServerIds?: string[];
  mcpServers?: DiscoveryMcpScopeEntry[];
  integrations?: {
    mode: 'none' | 'bound' | 'allowlist';
    sourceKinds?: Array<'api' | 'mcp'>;
    allowed?: Array<{
      sourceKind: 'api' | 'mcp';
      integrationId: string;
      bindingId?: string;
      toolNames?: string[];
    }>;
    maxResultsPerSource?: number;
  };
  excludeOperationIds?: string[];
  excludeGroupIds?: string[];
}

export function resolveDiscoveryScope(
  catalogConfig: CatalogConfig,
  mcpGrants?: readonly ParsedMcpGrant[],
  promotableOps?: readonly string[],
): DiscoveryScope | undefined {
  const discovery = catalogConfig.discovery;
  const stepTypes = discovery?.allowedStepTypes;
  const hasStepTypes = Array.isArray(stepTypes) && stepTypes.length > 0;

  const allowedOperationIds = [
    ...new Set([...(discovery?.allowedOperationIds ?? []), ...(promotableOps ?? [])]),
  ];
  // An explicitly-authored op-level list is op-level authority even when it
  // resolves empty: `capabilityDiscovery.helmsmanOperations: []` means "discovery
  // off" and must survive as an empty `allowedOperationIds`, not collapse to
  // "no op-level → fall through to allowedStepTypes".
  const hasOpIds = Array.isArray(discovery?.allowedOperationIds) || allowedOperationIds.length > 0;

  const mcpEntries: DiscoveryMcpScopeEntry[] = [];
  const seen = new Set<string>(); // dedupe key: `${serverId}|${bindingId ?? ''}`
  const pushEntry = (entry: DiscoveryMcpScopeEntry): void => {
    const key = `${entry.serverId}|${entry.bindingId ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    mcpEntries.push(entry);
  };

  if (catalogConfig.coreMcpServers) {
    for (const serverId of catalogConfig.coreMcpServers) pushEntry({ serverId });
  }
  if (discovery?.allowedMcpServerIds) {
    for (const serverId of discovery.allowedMcpServerIds) pushEntry({ serverId });
  }
  if (mcpGrants) {
    for (const grant of mcpGrants) {
      const entry: DiscoveryMcpScopeEntry = {
        serverId: grant.serverId,
        bindingId: grant.bindingId,
      };
      if (!grant.allTools && grant.tools.length > 0) {
        entry.toolNames = grant.tools.map((t) => t.toolName);
      }
      pushEntry(entry);
    }
  }

  const hasIntegrations = discovery?.integrations !== undefined;

  if (!hasStepTypes && !hasOpIds && mcpEntries.length === 0 && !hasIntegrations) return undefined;

  // `allowedMcpServerIds` is kept as a derived flat list for back-compat with
  // existing readers (catalog.tool.search MCP block, awareness builder).
  const allowedMcpServerIds = [...new Set(mcpEntries.map((e) => e.serverId))];

  // A scope that exists ONLY because of a task grant (no authored `discovery`
  // block) must not silently open agent discovery: undefined allowedAgents
  // reads as "open" downstream (checkAgentScope / catalogSearch), so a
  // promotable- or MCP-grant-derived scope would otherwise let the task
  // promote `agent:<visible>` and delegate to a broader agent. Close it by
  // default; an agent that WANTS agent discovery declares `discovery` explicitly.
  const grantDerivedOnly = discovery === undefined;
  return {
    allowedStepTypes: hasStepTypes ? stepTypes : [],
    ...(hasOpIds ? { allowedOperationIds } : {}),
    ...(discovery?.allowedAgents != null
      ? { allowedAgents: discovery.allowedAgents }
      : grantDerivedOnly
        ? { allowedAgents: false }
        : {}),
    ...(allowedMcpServerIds.length > 0 ? { allowedMcpServerIds } : {}),
    ...(mcpEntries.length > 0 ? { mcpServers: mcpEntries } : {}),
    ...(discovery?.integrations
      ? {
          integrations: stripUndefinedIntegrationScope(discovery.integrations),
        }
      : {}),
    ...(discovery?.excludeOperationIds
      ? { excludeOperationIds: discovery.excludeOperationIds }
      : {}),
    ...(discovery?.excludeGroupIds ? { excludeGroupIds: discovery.excludeGroupIds } : {}),
  };
}

/**
 * Strip undefined fields from the catalog-side integration scope so the
 * resolved `DiscoveryScope.integrations` satisfies `exactOptionalPropertyTypes`.
 */
function stripUndefinedIntegrationScope(
  cfg: NonNullable<NonNullable<CatalogConfig['discovery']>['integrations']>,
): NonNullable<DiscoveryScope['integrations']> {
  const out: NonNullable<DiscoveryScope['integrations']> = { mode: cfg.mode };
  if (cfg.sourceKinds) out.sourceKinds = cfg.sourceKinds;
  if (cfg.maxResultsPerSource !== undefined) out.maxResultsPerSource = cfg.maxResultsPerSource;
  if (cfg.allowed) {
    out.allowed = cfg.allowed.map((a) => ({
      sourceKind: a.sourceKind,
      integrationId: a.integrationId,
      ...(a.bindingId !== undefined ? { bindingId: a.bindingId } : {}),
      ...(a.toolNames !== undefined ? { toolNames: a.toolNames } : {}),
    }));
  }
  return out;
}

/**
 * Resolve the set of operation IDs that constitute "core tools" — operations
 * already present as native callable tools in the agent's tools[] array.
 * Includes coreOperations (coreAgents use agentId-based toolIds, not operation IDs).
 */
function resolveCoreToolIds(catalogConfig: CatalogConfig): Set<string> {
  const ids = new Set<string>();
  if (catalogConfig.coreOperations) {
    for (const id of catalogConfig.coreOperations) {
      ids.add(id);
    }
  }
  return ids;
}

/**
 * Operations excluded from agent-facing catalogs — derived from registry
 * (operations with `agentTool: false`). Computed once at startup.
 */
const STRUCTURAL_OPS = new Set(
  [...getAllOperations().values()].filter((op) => !op.agentTool).map((op) => op.operationId),
);

function deriveCatalogFormat(
  catalogConfig: CatalogConfig,
  filteredOps: Array<{ operationId: string }>,
): CatalogFormat {
  // Explicit format wins — backward compat for configs that set it
  if (catalogConfig.format) return catalogConfig.format;

  // No core operations → legacy summary mode
  if (!catalogConfig.coreOperations?.length) return 'summary';

  // Check if core ops + exclusions cover all remaining ops
  if (filteredOps.length === 0) return 'none';

  return 'compact';
}

/**
 * Awareness block for an op-level (promotable) scope. Names the exact ops the
 * agent may promote and teaches the two-step affordance — they are NOT yet on
 * the tool surface; promoting one makes it callable on the next turn.
 * Exported for unit testing.
 */
export function buildPromotableAwareness(
  ops: ReadonlyArray<{ operationId: string; description?: string; oneLine?: string }>,
): string {
  if (ops.length === 0) return '';
  const lines = ops.map((op) => {
    const desc = op.oneLine ?? op.description ?? getOperation(op.operationId)?.semanticDescription;
    return `- ${op.operationId}${desc ? ` — ${desc.split('\n')[0]!.slice(0, 140)}` : ''}`;
  });
  return (
    '## Promotable operations\n\n' +
    'These operations are available to you but NOT yet callable. To use one, call ' +
    '`catalog.tool.promote` with its operationId; it becomes a callable tool on your ' +
    'next turn. Promote only what the task needs.\n\n' +
    lines.join('\n')
  );
}

interface CatalogForAgent {
  /** The DiscoverableTools awareness markdown (absent when nothing is discoverable). */
  markdown: string | undefined;
  /** Compact ids + counts for the inspector's discoverable tier. */
  summary: ToolSurfaceDiscoverable | undefined;
}

function buildCatalogForAgent(
  catalogConfigRaw: unknown,
  runtimeState: NonNullable<SessionHotState['runtimeState']>,
  runId: string,
  resolvedScope?: DiscoveryScope,
): CatalogForAgent {
  if (!catalogConfigRaw || typeof catalogConfigRaw !== 'object')
    return { markdown: undefined, summary: undefined };

  const catalogConfig = catalogConfigRaw as CatalogConfig;

  // Step 1: Resolve core tools — operations already in tools[]
  const coreToolIds = resolveCoreToolIds(catalogConfig);

  // Step 2: Resolve discoverable scope. The caller passes the grant-aware
  // scope when it has one (task promotable ops don't live on catalogConfig,
  // so re-resolving here would miss them).
  const discoveryScope = resolvedScope ?? resolveDiscoveryScope(catalogConfig);
  if (!discoveryScope) return { markdown: undefined, summary: undefined };

  // Op-level scope: the awareness block lists exactly the allowed operations
  // (this is how the agent learns what it can promote). Step types are
  // derived from the allowed ops purely to bound the catalog fetch.
  const opLevel =
    discoveryScope.allowedOperationIds && discoveryScope.allowedOperationIds.length > 0
      ? new Set(discoveryScope.allowedOperationIds)
      : undefined;
  const catalogStepTypes = opLevel
    ? [
        ...new Set(
          [...opLevel]
            .map((id) => getOperation(id)?.stepType)
            .filter((t): t is string => t !== undefined),
        ),
      ]
    : discoveryScope.allowedStepTypes;

  const rawCatalog = getOperationCatalog({
    stepTypes: catalogStepTypes,
    includeUsageHints: true,
  });

  // Step 3: Subtract core tools + structural ops + exclusions from discoverable operations
  const excludeOpSet = new Set(STRUCTURAL_OPS);
  if (discoveryScope.excludeOperationIds) {
    for (const id of discoveryScope.excludeOperationIds) {
      excludeOpSet.add(id);
    }
  }
  // Core tools are already in tools[] — remove from awareness block to avoid duplication
  for (const id of coreToolIds) {
    excludeOpSet.add(id);
  }
  const excludeGrpSet =
    discoveryScope.excludeGroupIds && discoveryScope.excludeGroupIds.length > 0
      ? new Set(discoveryScope.excludeGroupIds)
      : undefined;

  // Step 4: Filter to discoverable-minus-core remainder
  const filteredOps = rawCatalog.operations.filter((op) => {
    if (opLevel && !opLevel.has(op.operationId)) return false;
    if (excludeOpSet.has(op.operationId)) return false;
    if (excludeGrpSet?.has(op.groupId)) return false;
    return true;
  });

  // Awareness verbosity for an op-level scope depends on whether the agent can
  // SEARCH — not on the scope's size. Two shapes:
  //  - No search tool (the Runner promotable tier: only catalog.tool.promote is
  //    auto-surfaced): the awareness block is the ONLY channel to learn the
  //    promotable ids, so list them (`promotable`). These sets are small.
  //  - Has search (Helmsman-style discovery): keep the compact step-type
  //    rollup + search guidance even when the op-level ceiling is LARGE — the
  //    agent discovers within it via catalog.tool.search (op-level-clamped at
  //    search + promote time), so a big pre-allowed ceiling never floods the
  //    default prompt. Plan 233.
  const canSearch = (catalogConfig.coreOperations ?? []).includes(CATALOG_SEARCH_OPERATION_ID);
  const format = opLevel
    ? filteredOps.length === 0
      ? 'none'
      : canSearch
        ? 'compact'
        : 'promotable'
    : deriveCatalogFormat(catalogConfig, filteredOps);

  // Discoverable summary for the inspector. Full op ids only for the small
  // `promotable` tier (the agent is meant to see the exact set); the `compact`
  // search tier lists counts only (the agent discovers within a large ceiling
  // via catalog.tool.search, so listing every id here would be the opposite of
  // compact). Counts come straight off the resolved scope.
  const mcpServerCount = discoveryScope.allowedMcpServerIds?.length ?? 0;
  const apiBindingCount = discoveryScope.integrations?.allowed?.length ?? 0;
  const summary: ToolSurfaceDiscoverable | undefined =
    filteredOps.length > 0 || mcpServerCount > 0 || apiBindingCount > 0
      ? {
          operationIds: format === 'promotable' ? filteredOps.map((o) => o.operationId) : [],
          operationCount: filteredOps.length,
          apiBindingCount,
          mcpServerCount,
        }
      : undefined;

  // Steps 5+6: 'none' = no awareness block (all relevant ops are core tools or zero remainder)
  if (format === 'none') return { markdown: undefined, summary };

  // Build a config hash to detect changes (${state.*} refs may resolve differently)
  const configHash = JSON.stringify({
    stepTypes: discoveryScope.allowedStepTypes,
    allowedOperationIds: discoveryScope.allowedOperationIds,
    excludeOperationIds: discoveryScope.excludeOperationIds,
    excludeGroupIds: discoveryScope.excludeGroupIds,
    coreOperations: catalogConfig.coreOperations,
    format,
  });

  // Check cache in runtime state
  const cacheVar = runtimeState.variables[CATALOG_CACHE_VAR] as
    { ref?: { kind: string; value?: unknown } } | undefined;
  if (cacheVar?.ref?.kind === 'inline' && typeof cacheVar.ref.value === 'object') {
    const cached = cacheVar.ref.value as { hash?: string; markdown?: string };
    if (cached.hash === configHash && typeof cached.markdown === 'string') {
      getOrchestratorLogger().debug(
        `agentTurn: using cached catalog (hash=${configHash.slice(0, 40)}...)`,
      );
      return { markdown: cached.markdown, summary };
    }
  }

  let markdown: string;
  if (format === 'promotable') {
    markdown = buildPromotableAwareness(filteredOps);
  } else if (format === 'detailed') {
    markdown = buildDetailedCatalog(filteredOps);
  } else if (format === 'compact') {
    // Ultra-compact step-type-level summary (~200 tokens)
    const coreToolCount = coreToolIds.size;
    markdown = buildCompactAwareness(filteredOps, coreToolCount);
  } else {
    // 'summary': Full operation one-liner listing
    markdown = buildSummaryCatalog(filteredOps);
  }

  if (!markdown) return { markdown: undefined, summary };

  // Cache in runtime state for subsequent turns
  runtimeState.variables[CATALOG_CACHE_VAR] = {
    ref: { kind: 'inline', value: { hash: configHash, markdown } },
  };

  getOrchestratorLogger().debug(
    `agentTurn: built catalog (format=${format}, ${String(filteredOps.length)} ops, ${String(markdown.length)} chars)`,
  );

  return { markdown, summary };
}

function appendTrailingContextBlocks(
  blocks: Array<{
    key: string;
    content: unknown;
    cacheHint?: 'stable' | 'run_stable' | 'volatile';
  }>,
  profile: AgentContextProfile,
  turnNumber: number,
  totalToolCallsSoFar: number,
): void {
  if (profile === 'debug') {
    blocks.push({
      key: 'TurnContext',
      cacheHint: 'volatile' as const,
      content: {
        turnNumber,
        totalToolCallsSoFar,
      },
    });
  }
}
