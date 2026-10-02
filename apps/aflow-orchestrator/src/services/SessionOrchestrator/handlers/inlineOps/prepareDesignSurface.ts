import { eq, and } from 'drizzle-orm';
import {
  PrepareDesignSurfaceInputSchema,
  DelegationContextSchema,
  SUBAGENT_HANDOFF_PAYLOAD_KIND,
  SPACE_POLICY_OPERATION_PREFIXES,
  getAllOperations,
  isOperationComposed,
  processEditionDescriptor,
  type TenantId,
  type ComposeIntent,
  type DesignSurface,
  type ExternalServiceObligation,
  getPlatformOperationPrefixes,
} from '@aflow/schemas';
import {
  getDatabase,
  withTenantSchema,
  createTenantContext,
  apiBindings,
  apiDefinitions,
  mcpServerBindings,
  mcpServerDefinitions,
} from '@aflow/database';
import { getSessionState } from '@aflow/redis';
import type { InlineHandlerArgs } from './types.js';
import {
  emitStepError,
  emitStepPaused,
  emitStepSuccess,
  readInlineOpInputRecord,
} from './helpers.js';
import { requireSpaceId } from './spaceScope.js';
import { resolveEnabledSpacePolicies } from '../../helpers/spacePolicyCapabilities.js';
import { getOrchestratorLogger } from '../../../../lib/orchestratorLogger.js';

// ============================================================================
// Required capability resolution
// ============================================================================

/** Prefixes that need no binding. Derived, because a hand-copied list drifts. */
const PLATFORM_PREFIXES = getPlatformOperationPrefixes();

interface SpaceState {
  apis: Array<{
    apiId: string;
    bindingId: string;
    endpoints: string[];
    callMode: 'endpoint' | 'direct_url';
    bound: boolean;
  }>;
  mcpServers: Array<{
    serverId: string;
    bindingId: string;
    tools: string[];
    bound: boolean;
  }>;
  /**
   * `SPACE_POLICY_OPERATION_PREFIXES` entries this space has switched ON.
   * Membership is the only way a policy-gated prefix becomes feasible, so a
   * prefix nothing here knows how to read stays off.
   */
  enabledPolicies: ReadonlySet<string>;
}

async function readSpaceState(tenantId: string, spaceId: string): Promise<SpaceState> {
  const db = getDatabase();
  const tenantCtx = createTenantContext(tenantId as TenantId);

  return withTenantSchema(db, tenantCtx, async (tx) => {
    // API definitions scoped to this space + their bindings (any scope row
    // either tenant-wide or matching this space).
    const defRows = await tx
      .select({
        apiId: apiDefinitions.apiId,
        definitionJson: apiDefinitions.definitionJson,
        enabled: apiDefinitions.enabled,
      })
      .from(apiDefinitions)
      .where(eq(apiDefinitions.spaceId, spaceId));

    const bindingRows = await tx
      .select({
        bindingId: apiBindings.bindingId,
        apiId: apiBindings.apiId,
        scopeJson: apiBindings.scopeJson,
        enabled: apiBindings.enabled,
      })
      .from(apiBindings)
      .where(and(eq(apiBindings.enabled, 1), eq(apiBindings.spaceId, spaceId)));

    const bindingsByApiId = new Map<string, Array<(typeof bindingRows)[number]>>();
    for (const b of bindingRows) {
      const scope = b.scopeJson as Record<string, unknown> | null;
      const scopeSpaceId = scope?.['spaceId'] as string | undefined;
      if (scopeSpaceId !== spaceId) continue;
      const list = bindingsByApiId.get(b.apiId) ?? [];
      list.push(b);
      bindingsByApiId.set(b.apiId, list);
    }

    const apis: SpaceState['apis'] = [];
    for (const def of defRows) {
      if (def.enabled !== 1) continue;
      const defJson = def.definitionJson as Record<string, unknown>;
      const defEndpoints =
        (defJson['endpoints'] as Array<Record<string, unknown>> | undefined) ?? [];
      const endpoints = defEndpoints
        .map((e) => e['endpointId'])
        .filter((id): id is string => typeof id === 'string');
      const callMode = defJson['callMode'] === 'direct_url' ? 'direct_url' : 'endpoint';

      const bindings = bindingsByApiId.get(def.apiId) ?? [];
      if (bindings.length === 0) {
        apis.push({ apiId: def.apiId, bindingId: '', endpoints, callMode, bound: false });
        continue;
      }
      for (const b of bindings) {
        apis.push({ apiId: def.apiId, bindingId: b.bindingId, endpoints, callMode, bound: true });
      }
    }

    // MCP definitions scoped to this space + their bindings.
    const mcpDefRows = await tx
      .select({
        serverId: mcpServerDefinitions.serverId,
        definitionJson: mcpServerDefinitions.definitionJson,
        enabled: mcpServerDefinitions.enabled,
      })
      .from(mcpServerDefinitions)
      .where(eq(mcpServerDefinitions.spaceId, spaceId));

    const mcpBindingRows = await tx
      .select({
        bindingId: mcpServerBindings.bindingId,
        serverId: mcpServerBindings.serverId,
        scopeJson: mcpServerBindings.scopeJson,
        cachedTools: mcpServerBindings.cachedTools,
      })
      .from(mcpServerBindings)
      .where(eq(mcpServerBindings.enabled, 1));

    const mcpBindingsByServerId = new Map<string, Array<(typeof mcpBindingRows)[number]>>();
    for (const b of mcpBindingRows) {
      const scope = b.scopeJson as Record<string, unknown> | null;
      const scopeSpaceId = scope?.['spaceId'] as string | undefined;
      if (scopeSpaceId !== spaceId) continue;
      const list = mcpBindingsByServerId.get(b.serverId) ?? [];
      list.push(b);
      mcpBindingsByServerId.set(b.serverId, list);
    }

    const mcpServers: SpaceState['mcpServers'] = [];
    for (const def of mcpDefRows) {
      if (def.enabled !== 1) continue;
      const defJson = def.definitionJson as Record<string, unknown>;
      const defTools = extractToolNames(defJson['tools']);

      const bindings = mcpBindingsByServerId.get(def.serverId) ?? [];
      if (bindings.length === 0) {
        mcpServers.push({
          serverId: def.serverId,
          bindingId: '',
          tools: defTools,
          bound: false,
        });
        continue;
      }
      for (const b of bindings) {
        const cachedTools = extractToolNames(b.cachedTools);
        const tools = cachedTools.length > 0 ? cachedTools : defTools;
        mcpServers.push({
          serverId: def.serverId,
          bindingId: b.bindingId,
          tools,
          bound: true,
        });
      }
    }

    const enabledPolicies = await resolveEnabledSpacePolicies(tx, spaceId);

    return { apis, mcpServers, enabledPolicies };
  });
}

function extractToolNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      names.push(item);
    } else if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>;
      const name = obj['name'] ?? obj['toolName'] ?? obj['id'];
      if (typeof name === 'string') names.push(name);
    }
  }
  return names;
}

// ============================================================================
// Feasibility check
// ============================================================================

/** `policy` — the operator resolves it by flipping the named space policy. */
type MissingCapabilityKind = 'api' | 'mcp' | 'operation' | 'policy';

interface MissingCapabilityRecord {
  kind: MissingCapabilityKind;
  identifier: string;
  /** Definition exists in this space but no binding is wired. */
  definitionExists: boolean;
}

function evaluateFeasibility(
  intent: ComposeIntent,
  state: SpaceState,
  availableOperations: Set<string>,
): { missing: MissingCapabilityRecord[] } {
  const missing: MissingCapabilityRecord[] = [];

  // De-dupe: a single missing identifier should only appear once.
  const seenMissing = new Set<string>();
  const recordMissing = (rec: MissingCapabilityRecord): void => {
    const key = `${rec.kind}:${rec.identifier}`;
    if (seenMissing.has(key)) return;
    seenMissing.add(key);
    missing.push(rec);
  };

  const recordPolicyUnlessEnabled = (prefix: string): void => {
    if (state.enabledPolicies.has(prefix)) return;
    recordMissing({ kind: 'policy', identifier: prefix, definitionExists: true });
  };

  for (const req of intent.requiredCapabilities) {
    if (req.kind === 'compute') {
      recordPolicyUnlessEnabled('compute');
      continue;
    }

    if (req.kind === 'api') {
      const matches = state.apis.filter(
        (a) => a.apiId === req.identifier || a.bindingId === req.identifier,
      );
      const hasBound = matches.some((a) => a.bound);
      if (hasBound) continue;
      // Definition exists in this space if there's any matching apiId row,
      // bound or unbound. Otherwise truly absent.
      const definitionExists = matches.length > 0;
      recordMissing({ kind: 'api', identifier: req.identifier, definitionExists });
      continue;
    }

    if (req.kind === 'mcp') {
      const matches = state.mcpServers.filter(
        (s) => s.serverId === req.identifier || s.bindingId === req.identifier,
      );
      const hasBound = matches.some((s) => s.bound);
      if (hasBound) continue;
      const definitionExists = matches.length > 0;
      recordMissing({ kind: 'mcp', identifier: req.identifier, definitionExists });
      continue;
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- exhaustive remaining req.kind union member
    if (req.kind === 'operation') {
      // Operation identifiers are full operation IDs (e.g. 'memory.store.put')
      // OR a prefix (e.g. 'kaggle'). Platform prefixes are always satisfied.
      const prefix = req.identifier.split('.')[0] ?? req.identifier;
      if (PLATFORM_PREFIXES.has(prefix)) continue;
      // Registry membership does not answer feasibility for a policy-gated
      // prefix — these operations are registered in every space, and only the
      // operator's policy decides whether this one may run them.
      if (SPACE_POLICY_OPERATION_PREFIXES.has(prefix)) {
        recordPolicyUnlessEnabled(prefix);
        continue;
      }
      if (availableOperations.has(req.identifier)) continue;
      // Treat as missing capability with no definition path — operator must
      // define the operation through bind-capability (api) or extend the
      // platform. We surface this as `unsupported` so the user picks a path.
      recordMissing({ kind: 'operation', identifier: req.identifier, definitionExists: false });
      continue;
    }
  }

  for (const ds of intent.requiredDataSources) {
    if (!ds.sourceId) continue;
    if (ds.sourceKind === 'api') {
      const matches = state.apis.filter(
        (a) => a.apiId === ds.sourceId || a.bindingId === ds.sourceId,
      );
      if (matches.some((a) => a.bound)) continue;
      const definitionExists = matches.length > 0;
      recordMissing({ kind: 'api', identifier: ds.sourceId, definitionExists });
      continue;
    }
    if (ds.sourceKind === 'mcp') {
      const matches = state.mcpServers.filter(
        (s) => s.serverId === ds.sourceId || s.bindingId === ds.sourceId,
      );
      if (matches.some((s) => s.bound)) continue;
      const definitionExists = matches.length > 0;
      recordMissing({ kind: 'mcp', identifier: ds.sourceId, definitionExists });
      continue;
    }
    // memory / user-upload — no static gate; provenance contract enforces
    // at submit_output time on the producing task.
  }

  return { missing };
}

// ============================================================================
// Surface assembly
// ============================================================================

function buildDesignSurface(state: SpaceState, availableOperations: string[]): DesignSurface {
  const integrations: DesignSurface['integrations'] = [];
  const seenIntegration = new Set<string>();
  for (const a of state.apis) {
    if (!a.bound) continue;
    const key = `api:${a.apiId}:${a.bindingId}`;
    if (seenIntegration.has(key)) continue;
    seenIntegration.add(key);
    integrations.push({
      sourceKind: 'api',
      integrationId: a.apiId,
      bindingId: a.bindingId,
      callMode: a.callMode,
      toolNames: [...a.endpoints],
    });
  }
  for (const s of state.mcpServers) {
    if (!s.bound) continue;
    const key = `mcp:${s.serverId}:${s.bindingId}`;
    if (seenIntegration.has(key)) continue;
    seenIntegration.add(key);
    integrations.push({
      sourceKind: 'mcp',
      integrationId: s.serverId,
      bindingId: s.bindingId,
      toolNames: [...s.tools],
    });
  }

  const bindableButUnbound: DesignSurface['bindableButUnbound'] = [];
  const seenBindable = new Set<string>();
  for (const a of state.apis) {
    if (a.bound) continue;
    const key = `api:${a.apiId}`;
    if (seenBindable.has(key)) continue;
    seenBindable.add(key);
    bindableButUnbound.push({ kind: 'api', identifier: a.apiId });
  }
  for (const s of state.mcpServers) {
    if (s.bound) continue;
    const key = `mcp:${s.serverId}`;
    if (seenBindable.has(key)) continue;
    seenBindable.add(key);
    bindableButUnbound.push({ kind: 'mcp', identifier: s.serverId });
  }

  const policies: Record<string, boolean> = {};
  for (const prefix of SPACE_POLICY_OPERATION_PREFIXES) {
    policies[prefix] = state.enabledPolicies.has(prefix);
  }

  return {
    integrations,
    operations: availableOperations
      .filter((operationId) => isOperationOffered(operationId, state.enabledPolicies))
      .sort(),
    policies,
    bindableButUnbound,
  };
}

/**
 * A policy-gated operation is registered in every space, so registry
 * membership alone would advertise a lane the operator has not enabled — the
 * design phase would then draft a task that can only fail mid-run.
 */
function isOperationOffered(operationId: string, enabledPolicies: ReadonlySet<string>): boolean {
  const prefix = operationId.split('.')[0] ?? operationId;
  if (!SPACE_POLICY_OPERATION_PREFIXES.has(prefix)) return true;
  return enabledPolicies.has(prefix);
}

function listAvailableOperationIds(): { all: Set<string>; surface: string[] } {
  const all = new Set<string>();
  const surface: string[] = [];
  const lanes = processEditionDescriptor();
  for (const op of getAllOperations().values()) {
    // A lane this deployment does not compose runs nothing, so a task drafted
    // on it could only fail mid-run.
    if (!isOperationComposed(op.operationId, lanes)) continue;
    all.add(op.operationId);
    // Surface only excludes internal ops (those invoked by the workflow
    // engine, not agents). The draft phase grants surface ops to tasks.
    if (op.internal) continue;
    surface.push(op.operationId);
  }
  return { all, surface };
}

// ============================================================================
// Output emission
// ============================================================================

async function emitFeasible(
  args: InlineHandlerArgs,
  designSurface: DesignSurface,
  startTime: number,
): Promise<void> {
  await emitStepSuccess(args, { status: 'feasible' as const, designSurface }, startTime);
}

interface BlockedHandoff {
  reason: 'needs_binding' | 'policy_disabled';
  missing: Array<{
    kind: MissingCapabilityKind;
    identifier: string;
    definitionExists?: boolean;
  }>;
  handoff: { skillSlug: string; prefill: Record<string, unknown> };
}

/**
 * Emit a PAUSED step result with a structured handoff payload. Mirrors the
 * shape used by `handleSignalBlockedInline` (`runnerOutput.ts:452-480`) so
 * `bubbleChildPauseToParent` propagates the pause to Helmsman identically.
 *
 * The bubble-up chain reads `requestedInputRef` (not `outputRef`) — so the
 * handoff payload is encoded there.
 */
async function emitBlockedPause(
  args: InlineHandlerArgs,
  payload: BlockedHandoff,
  startTime: number,
): Promise<void> {
  const definitionOnlyMissing = payload.missing.filter(
    (m) => (m.kind === 'api' || m.kind === 'mcp') && !m.definitionExists,
  );
  const credentialsMissing = payload.missing.filter(
    (m) => (m.kind === 'api' || m.kind === 'mcp') && m.definitionExists,
  );
  const policy = payload.missing.filter((m) => m.kind === 'policy');
  const operationOnly = payload.missing.filter((m) => m.kind === 'operation');

  const lines: string[] = ['compose-skill cannot proceed — missing capabilities:'];
  if (definitionOnlyMissing.length > 0) {
    lines.push(
      `- Bindable (run bind-capability — no definition yet): ${definitionOnlyMissing.map((m) => `${m.kind}:${m.identifier}`).join(', ')}`,
    );
  }
  if (credentialsMissing.length > 0) {
    lines.push(
      `- Needs credentials (definition is registered; add credentials at /integrations to activate the binding): ${credentialsMissing.map((m) => `${m.kind}:${m.identifier}`).join(', ')}`,
    );
  }
  if (policy.length > 0) {
    lines.push(
      `- Space policy (operator must enable in settings): ${policy.map((m) => m.identifier).join(', ')}`,
    );
  }
  if (operationOnly.length > 0) {
    lines.push(
      `- Platform operations (no in-product fix; revise the goal or extend the platform): ${operationOnly.map((m) => m.identifier).join(', ')}`,
    );
  }
  const prompt = lines.join('\n');

  const pausePayload = {
    payloadKind: SUBAGENT_HANDOFF_PAYLOAD_KIND,
    handoffSource: 'compose-skill-handoff' as const,
    prompt,
    blockingReason: prompt,
    blockingCategory: 'capability_unavailable',
    // Legacy `kind` retained for back-compat with parent-agent tool-result
    // pattern matching that already inspects this field.
    kind: 'compose-skill-handoff' as const,
    status: 'blocked' as const,
    reason: payload.reason,
    missing: payload.missing,
    handoff: payload.handoff,
  };

  await emitStepPaused(args, pausePayload, startTime);
}

async function emitUnsupportedPause(
  args: InlineHandlerArgs,
  missing: Array<{ kind: MissingCapabilityKind; identifier: string }>,
  startTime: number,
): Promise<void> {
  const summary = missing.map((m) => `${m.kind}:${m.identifier}`).join(', ');
  const prompt = `compose-skill cannot proceed — no in-product skill can resolve missing: ${summary}. Define a new capability or revise the goal, then resume.`;

  const pausePayload = {
    payloadKind: SUBAGENT_HANDOFF_PAYLOAD_KIND,
    handoffSource: 'compose-skill-handoff' as const,
    prompt,
    blockingReason: prompt,
    blockingCategory: 'capability_unavailable',
    kind: 'compose-skill-handoff' as const,
    status: 'unsupported' as const,
    missing,
  };

  await emitStepPaused(args, pausePayload, startTime);
}

function looksLikeExistingSkillModification(intent: ComposeIntent): boolean {
  if (intent.authoringIntent === 'modify_existing_skill') return true;
  const text = intent.intent.toLowerCase();
  return (
    /\b(existing|current|already-created|already created)\b/.test(text) &&
    /\b(skill|workflow)\b/.test(text) &&
    /\b(fix|modify|update|patch|repair|change|edit)\b/.test(text)
  );
}

async function emitExistingSkillModificationPause(
  args: InlineHandlerArgs,
  intent: ComposeIntent,
  startTime: number,
): Promise<void> {
  const prompt =
    'compose-skill is create-only, but this request is to modify an existing skill. ' +
    'Do not continue composing a replacement bundle. Read the target workflow with ' +
    '`workflow.manage.get`, then use `workflow.manage.patch` for the targeted change; ' +
    'definition patches are staged as `workflow_refinement` proposals for operator ratification. ' +
    `Intent: ${intent.intent}`;

  const pausePayload = {
    payloadKind: SUBAGENT_HANDOFF_PAYLOAD_KIND,
    handoffSource: 'compose-skill-handoff' as const,
    prompt,
    blockingReason: prompt,
    blockingCategory: 'unsupported_authoring_mode',
    kind: 'compose-skill-handoff' as const,
    status: 'unsupported' as const,
    suggestedNextAction: {
      operationId: 'workflow.manage.patch',
      rationale: 'Modify the existing workflow through the ratified refinement path.',
    },
  };

  await emitStepPaused(args, pausePayload, startTime);
}

// ============================================================================
// Intent loading
// ============================================================================

// ============================================================================

/**
 * Read the typed `externalServices` obligation from the run's hot state and
 * evaluate it against (a) the current design surface and (b) the
 * `requiredCapabilities` the runner emitted. Returns one of:
 *
 *   - `null` — no typed obligation present, or all checks pass.
 *   - `{ kind: 'binding-missing' | 'binding-stale' | 'mirror-missing', ... }`
 *     — payload the handler emits as PAUSED. `binding-missing` and
 *     `binding-stale` carry handoff payloads (Helmsman/operator can run
 *     bind-capability); `mirror-missing` is a plain rejection because the
 *     fix is upstream in `analyze-intent`.
 *
 * The obligation is read from `delegationContextJson` on the run hot state —
 * not from the operation input — because it belongs to the run (the parent
 * Helmsman set it once at delegation time), not to a specific step.
 */
type ExternalServicesGateResult =
  | null
  | {
      kind: 'binding-missing' | 'binding-stale';
      obligation: ExternalServiceObligation;
    }
  | {
      kind: 'mirror-missing';
      obligation: ExternalServiceObligation;
    };

async function evaluateExternalServicesObligation(
  args: InlineHandlerArgs,
  intent: ComposeIntent,
  state: SpaceState,
): Promise<ExternalServicesGateResult> {
  const sessionState = await getSessionState(args.redis, args.context.tenantId, args.context.runId);
  const dcJson = sessionState?.delegationContextJson;
  if (!dcJson) return null;

  const dcParse = (() => {
    try {
      return DelegationContextSchema.safeParse(JSON.parse(dcJson));
    } catch {
      return { success: false } as const;
    }
  })();
  if (!dcParse.success || !dcParse.data.externalServices?.length) return null;

  for (const ext of dcParse.data.externalServices) {
    // Backstop 1: parent said 'bound' — verify the binding still exists.
    // Surface entries are scope-filtered + enabled, so apis[*].bound and
    // mcpServers[*].bound here are authoritative.
    if (ext.status === 'bound') {
      const stillBound =
        ext.sourceKind === 'api'
          ? state.apis.some(
              (a) =>
                a.bound &&
                (a.apiId === ext.identifier ||
                  a.apiId === ext.apiId ||
                  a.bindingId === ext.bindingId),
            )
          : state.mcpServers.some(
              (m) =>
                m.bound &&
                (m.serverId === ext.identifier ||
                  m.serverId === ext.serverId ||
                  m.bindingId === ext.bindingId),
            );
      if (!stillBound) return { kind: 'binding-stale', obligation: ext };
    }

    // Backstop 2: parent said 'unknown' or 'definition-only' — Helmsman
    // skipped the pre-flight bind step. Emit the bind-capability handoff.
    if (ext.status === 'unknown' || ext.status === 'definition-only') {
      return { kind: 'binding-missing', obligation: ext };
    }

    // Mirroring check: analyze-intent must have lifted every typed
    // obligation into BOTH `requiredCapabilities` AND `requiredDataSources`.
    //
    const matchesObligation = (id: string | undefined): boolean =>
      !!id &&
      (id === ext.identifier || id === ext.apiId || id === ext.bindingId || id === ext.serverId);
    const mirroredAsCapability = intent.requiredCapabilities.some(
      (c) => c.kind === ext.sourceKind && matchesObligation(c.identifier),
    );
    const mirroredAsDataSource = intent.requiredDataSources.some(
      (d) => d.sourceKind === ext.sourceKind && matchesObligation(d.sourceId),
    );
    if (!mirroredAsCapability || !mirroredAsDataSource) {
      return { kind: 'mirror-missing', obligation: ext };
    }
  }
  return null;
}

async function emitExternalServicesGateFailure(
  args: InlineHandlerArgs,
  result: Exclude<ExternalServicesGateResult, null>,
  startTime: number,
): Promise<void> {
  const ext = result.obligation;
  const idLabel = `${ext.sourceKind}:${ext.identifier}`;

  if (result.kind === 'mirror-missing') {
    // FAILED, not PAUSED. The Phase 5 invariant (resumeRun preserves
    // stepState.inputRef on paused operation steps) means a PAUSED result
    // here would re-execute with the SAME malformed analyze-intent output
    // on every resume — pause-loop forever. The fix is upstream: re-run
    // analyze-intent (the workflow's onFailure routing or the operator's
    // intervention). `validation` classification + retryable=false routes
    // to the validation-error path the runner-style steps already handle.
    await emitStepError(
      args,
      'PREPARE_DESIGN_SURFACE_OBLIGATION_DROPPED',
      `compose-skill cannot proceed — typed externalServices obligation ${idLabel} was not mirrored into BOTH requiredCapabilities AND requiredDataSources. analyze-intent must include every parent-supplied externalServices entry as a hard requirement; dropping a typed obligation is not a permitted path. Re-run analyze-intent rather than resuming.`,
      startTime,
      'validation',
      false,
    );
    return;
  }

  // binding-missing or binding-stale → emit a bind-capability handoff with
  // sufficient prefill so Helmsman can drive the sub-skill.
  const reason =
    result.kind === 'binding-stale'
      ? `External service ${idLabel} was bound when the parent invoked compose-skill but is no longer in the design surface. Re-bind to continue.`
      : `External service ${idLabel} must be bound before compose-skill can design a workflow that uses it. Run bind-capability first.`;
  await emitBlockedPause(
    args,
    {
      reason: 'needs_binding',
      missing: [{ kind: ext.sourceKind, identifier: ext.identifier }],
      handoff: {
        skillSlug: 'bind-capability',
        prefill: {
          identifier: ext.identifier,
          sourceKind: ext.sourceKind,
          ...(ext.apiId ? { apiId: ext.apiId } : {}),
          ...(ext.bindingId ? { bindingId: ext.bindingId } : {}),
          ...(ext.serverId ? { serverId: ext.serverId } : {}),
          rationale: reason,
        },
      },
    },
    startTime,
  );
}

// ============================================================================
// Handler
// ============================================================================

export async function handlePrepareDesignSurfaceInline(args: InlineHandlerArgs): Promise<void> {
  const startTime = Date.now();
  const logger = getOrchestratorLogger();

  try {
    const spaceId = requireSpaceId(args.context);
    const tenantId = args.context.tenantId;

    const opInput = await readInlineOpInputRecord(args);
    if (!opInput) {
      await emitStepError(
        args,
        'PREPARE_DESIGN_SURFACE_NO_INTENT',
        'Operation input is missing or unparseable. prepare-design-surface expects an inputBindings entry "intent" pointing at the analyze-intent task output.',
        startTime,
        'validation',
      );
      return;
    }

    // Validate against the registered operation input schema
    // (`PrepareDesignSurfaceInputSchema = { intent: ComposeIntentSchema }`).
    // The wrapper matches what the workflow engine actually delivers via
    // `inputBindings.intent` and what catalog-level input validators see.
    const inputParse = PrepareDesignSurfaceInputSchema.safeParse(opInput);
    if (!inputParse.success) {
      const issues = inputParse.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      await emitStepError(
        args,
        'PREPARE_DESIGN_SURFACE_INVALID_INTENT',
        `Operation input failed schema validation: ${issues}`,
        startTime,
        'validation',
      );
      return;
    }
    const intent: ComposeIntent = inputParse.data.intent;

    if (looksLikeExistingSkillModification(intent)) {
      await emitExistingSkillModificationPause(args, intent, startTime);
      logger.info(
        `[prepareDesignSurface] blocked run=${args.context.runId} reason=unsupported_authoring_mode authoringIntent=${intent.authoringIntent}`,
      );
      return;
    }

    const state = await readSpaceState(tenantId, spaceId);
    const { all, surface } = listAvailableOperationIds();

    const obligationResult = await evaluateExternalServicesObligation(args, intent, state);
    if (obligationResult) {
      await emitExternalServicesGateFailure(args, obligationResult, startTime);
      logger.info(
        `[prepareDesignSurface] external-services-gate run=${args.context.runId} kind=${obligationResult.kind} obligation=${obligationResult.obligation.sourceKind}:${obligationResult.obligation.identifier}`,
      );
      return;
    }

    const { missing } = evaluateFeasibility(intent, state, all);

    if (missing.length === 0) {
      const designSurface = buildDesignSurface(state, surface);
      await emitFeasible(args, designSurface, startTime);
      logger.info(
        `[prepareDesignSurface] feasible run=${args.context.runId} integrations=${String(designSurface.integrations.length)} ops=${String(designSurface.operations.length)} policies=${Object.entries(
          designSurface.policies,
        )
          .map(([prefix, enabled]) => `${prefix}:${String(enabled)}`)
          .join(',')}`,
      );
      return;
    }

    // Resolvability classification:
    //   - api / mcp        → always resolvable via `bind-capability` (it can
    //     create the definition AND placeholder binding from scratch). The
    //     `definitionExists` flag only differentiates the *prompt copy* (run
    //     bind-capability vs. add credentials at /integrations); both paths
    //     are in-product.
    //   - policy           → resolvable via `space-settings` (operator toggle).
    //   - operation        → genuinely unsupported. No in-product mechanism
    //     creates a new platform operation; the user must either revise the
    //     goal or extend the platform.
    const hasUnresolvableOp = missing.some((m) => m.kind === 'operation');
    const policyMissing = missing.filter((m) => m.kind === 'policy');
    const policyOnlyMissing = missing.length > 0 && policyMissing.length === missing.length;

    if (!hasUnresolvableOp) {
      const reason: 'needs_binding' | 'policy_disabled' = policyOnlyMissing
        ? 'policy_disabled'
        : 'needs_binding';
      const handoffSkill = policyOnlyMissing ? 'space-settings' : 'bind-capability';
      const prefill: Record<string, unknown> = policyOnlyMissing
        ? { policies: policyMissing.map((m) => m.identifier), enable: true }
        : {
            apiNames: missing.filter((m) => m.kind === 'api').map((m) => m.identifier),
            mcpServers: missing.filter((m) => m.kind === 'mcp').map((m) => m.identifier),
          };
      await emitBlockedPause(
        args,
        {
          reason,
          // `definitionExists` lets `emitBlockedPause` split the prompt into
          // "no definition yet → run bind-capability" vs. "definition exists
          // but no binding/credentials → add credentials at /integrations".
          missing: missing.map((m) => ({
            kind: m.kind,
            identifier: m.identifier,
            definitionExists: m.definitionExists,
          })),
          handoff: { skillSlug: handoffSkill, prefill },
        },
        startTime,
      );
      logger.info(
        `[prepareDesignSurface] blocked run=${args.context.runId} reason=${reason} missing=${missing.map((m) => `${m.kind}:${m.identifier}`).join(',')}`,
      );
      return;
    }

    await emitUnsupportedPause(
      args,
      missing.map((m) => ({ kind: m.kind, identifier: m.identifier })),
      startTime,
    );
    logger.info(
      `[prepareDesignSurface] unsupported run=${args.context.runId} missing=${missing.map((m) => `${m.kind}:${m.identifier}`).join(',')}`,
    );
  } catch (err) {
    logger.error(
      `[prepareDesignSurface] Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
    await emitStepError(
      args,
      'PREPARE_DESIGN_SURFACE_INTERNAL',
      err instanceof Error ? err.message : String(err),
      startTime,
      'internal',
    );
  }
}
