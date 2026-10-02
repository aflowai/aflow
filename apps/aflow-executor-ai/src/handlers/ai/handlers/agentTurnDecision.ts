/**
 * Agent turn: Zod parse + repair, tool allowlist + arg validation, persistence repair.
 */
import { z } from 'zod';
import type { ExecutorContext } from '@aflow/executor-runtime';
import type { AgentTurnDecision, AgentToolSpec, AiMessageV1, AflowError } from '@aflow/schemas';
import {
  AgentTurnDecisionSchema,
  DECISION_MESSAGE_MAX,
  DECISION_REASONING_MAX,
  buildImplicitTextOnlyAgentDecision,
  findBlockedSignalTool,
  getAllowedAgentDecisionActions,
  normalizeDisallowedPauseDecision,
} from '@aflow/schemas';
import type { TenantId, StepExecutionId } from '@aflow/schemas';
import type {
  AIClient,
  ChatMessage,
  CostBreakdown,
  GenerateJsonResponse,
  TokenUsage,
} from '@aflow/ai-client';
import type { AgentTurnInput } from '../schema.js';
import type { HandlerDeps } from './types.js';
import { chatMessageToAiMessage } from './agentMessageConversion.js';
import { coerceStringifiedToolArgs } from './coerceToolArgs.js';
import { toolImageResolver } from './mediaSourceRef.js';

function mergeJsonCallUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const sumOptional = (x: number | undefined, y: number | undefined): number | undefined =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  const reasoningTokens = sumOptional(a.reasoningTokens, b.reasoningTokens);
  const cacheReadTokens = sumOptional(a.cacheReadTokens, b.cacheReadTokens);
  const cacheWriteTokens = sumOptional(a.cacheWriteTokens, b.cacheWriteTokens);
  const uncachedPromptTokens = sumOptional(a.uncachedPromptTokens, b.uncachedPromptTokens);
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(uncachedPromptTokens !== undefined ? { uncachedPromptTokens } : {}),
  };
}

/** Merged cost for multi-call agent turns (Zod repair, persistence repair). */
export function mergeCostBreakdown(
  a?: CostBreakdown,
  b?: CostBreakdown,
): CostBreakdown | undefined {
  if (!b) return a;
  if (!a) return b;
  const mediaSum = (a.mediaCost ?? 0) + (b.mediaCost ?? 0);
  return {
    promptCost: a.promptCost + b.promptCost,
    completionCost: a.completionCost + b.completionCost,
    totalCost: a.totalCost + b.totalCost,
    currency: a.currency || b.currency,
    ...(mediaSum > 0 ? { mediaCost: mediaSum } : {}),
  };
}

/** Thrown when Zod repair or persistence repair still yields an unusable decision — map to validationError in coordinator. */
export class InvalidAgentTurnDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAgentTurnDecisionError';
  }
}

export type AgentDecisionPersistenceResult =
  | { kind: 'accepted'; decision: AgentTurnDecision }
  | {
      kind: 'repairable_reject';
      reason: string;
      code: string;
      /**
       * The SHAPE of each argument the model sent, never its value.
       *
       * A rejected call is never executed and its arguments are not persisted,
       * so when one of these reaches production the evidence needed to fix it
       * is already gone — twice now a `/operations: must be array` rejection
       * could only be reasoned about from the model's own account of it. This
       * records types and lengths so the next occurrence explains itself
       * without carrying argument content into logs.
       */
      argShapes?: Record<string, string>;
    };

/** A type-and-size description of each argument, safe to log. */
function describeArgShapes(args: unknown): Record<string, string> {
  if (typeof args !== 'object' || args === null) return { '': typeof args };
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (Array.isArray(value)) out[key] = `array[${String(value.length)}]`;
    else if (value === null) out[key] = 'null';
    else if (typeof value === 'string') out[key] = `string(${String(value.length)})`;
    else if (typeof value === 'object') out[key] = `object{${Object.keys(value).join(',')}}`;
    else out[key] = typeof value;
  }
  return out;
}

function persistenceCodeFromArgErr(
  argErr: AflowError,
): 'schema_compile_failed' | 'tool_args_invalid' {
  const d = argErr.details;
  if (Array.isArray(d) && d.some((x) => x.code === 'schema_compile_failed')) {
    return 'schema_compile_failed';
  }
  return 'tool_args_invalid';
}

/**
 * Build a flat object schema describing the agent decision.
 *
 * Why flat (not anyOf-discriminated): a previous refactor produced a top-level
 * `anyOf` with one branch per allowed action so the JSON Schema would force
 * `invoke_steps` to include `calls`, `invoke_step` to include `args`, etc.
 * That works for OpenAI/Google but is silently destroyed by the Anthropic
 * adapter — `sanitizeAnthropicInputSchema` (packages/ai-client/src/providers/
 * anthropic.ts) strips any top-level `oneOf|allOf|anyOf` and replaces the
 * whole tool input_schema with `{ type: 'object', additionalProperties: true }`,
 * because Anthropic requires the tool's input_schema root to be `type: object`
 * and treats sibling top-level unions as invalid.
 *
 * Net effect: Anthropic-backed runners saw a *zero-information* schema, the
 * model freely emitted `{ action: 'invoke_steps' }` with no `calls`, and both
 * the first parse and the Zod-repair round (which uses the same schema) failed
 * with `calls: Required`. This bit the bind-capability runner repeatedly.
 *
 * The flat shape below is visible to all three providers. Per-action required
 * fields are encoded in property descriptions ("REQUIRED when action=…") and
 * enforced authoritatively by the Zod parse (`AgentTurnDecisionSchema`) on
 * the response — same Zod parse that already runs today.
 *
 * If we ever need stricter JSON-schema-level branch validation again, push it
 * one level deep (e.g. wrap the union under a `decision` property) so the root
 * stays `type: object`, OR teach `sanitizeAnthropicInputSchema` to inflate
 * top-level anyOf rather than wipe it.
 */
export function buildAgentDecisionRawJsonSchema(params: AgentTurnInput): Record<string, unknown> {
  const toolIds = params.availableTools.map((t) => t.toolId);
  const allowedActions = getAllowedAgentDecisionActions({
    requestInputPolicy: params.requestInputPolicy,
    allowComplete: params.policy.allowComplete,
  });

  const requiredFieldsPerTool =
    params.availableTools.length > 0
      ? 'Required fields per tool: ' +
        params.availableTools
          .map((t) => {
            const reqFields = t.inputSchema['required'] as string[] | undefined;
            return `${t.toolId}(${reqFields?.join(', ') ?? 'none'})`;
          })
          .join(', ')
      : '';

  const properties: Record<string, unknown> = {
    action: {
      type: 'string',
      enum: allowedActions,
      description:
        `The action to take. Selects which other fields are required:\n` +
        (allowedActions.includes('invoke_step')
          ? `- "invoke_step" — REQUIRES "toolId" and "args".\n`
          : '') +
        (allowedActions.includes('invoke_steps')
          ? `- "invoke_steps" — REQUIRES "calls" (array of {toolId,args}, length ≥ 1).\n`
          : '') +
        (allowedActions.includes('pause_for_input')
          ? `- "pause_for_input" — REQUIRES "message".\n`
          : '') +
        (allowedActions.includes('complete') ? `- "complete" — REQUIRES "result".\n` : ''),
    },
  };

  if (allowedActions.includes('invoke_step') || allowedActions.includes('invoke_steps')) {
    properties['toolId'] = {
      type: 'string',
      ...(toolIds.length > 0 ? { enum: toolIds } : {}),
      description: `REQUIRED when action="invoke_step". Tool ID to invoke. Must be one of: ${toolIds.join(', ')}`,
    };
    properties['args'] = {
      type: 'object',
      description:
        `REQUIRED when action="invoke_step". Arguments for the tool. MUST be a JSON object ` +
        `(use {} when the tool has no required fields, never omit, never null). MUST match the ` +
        `input schema of the selected tool. ${requiredFieldsPerTool}`,
    };
  }

  if (allowedActions.includes('invoke_steps')) {
    properties['calls'] = {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          toolId: {
            type: 'string',
            ...(toolIds.length > 0 ? { enum: toolIds } : {}),
          },
          args: {
            type: 'object',
            description: 'Arguments for the tool. MUST be a JSON object (use {} when none).',
          },
        },
        required: ['toolId', 'args'],
        additionalProperties: false,
      },
      description:
        `REQUIRED when action="invoke_steps". One entry per parallel tool call (length ≥ 1). ` +
        `Each entry MUST have toolId and args.`,
    };
  }

  if (allowedActions.includes('pause_for_input')) {
    properties['inputSchema'] = {
      type: 'object',
      description:
        'Optional JSON Schema for the expected input (only for action="pause_for_input").',
    };
  }

  if (allowedActions.includes('complete')) {
    properties['result'] = {
      type: 'string',
      description: 'REQUIRED when action="complete". Final result. Can be a JSON string.',
    };
  }

  // `message` is shared across pause_for_input (the reply text) and
  // invoke_step(s)/complete (progress updates / summary). Use the higher cap
  // needed by pause_for_input — invoke_step rarely fills more than a few
  // hundred chars and the cap is permissive, not enforced as a minimum.
  properties['message'] = {
    type: 'string',
    maxLength: DECISION_MESSAGE_MAX,
    description:
      `User-visible text. REQUIRED when action="pause_for_input" (this is your reply to the user). ` +
      `Optional otherwise — for "invoke_step(s)" use for brief progress updates; for "complete" a ` +
      `summary message. Keep it concise — summarize findings, don't dump raw data.`,
  };
  properties['reasoning'] = {
    type: 'string',
    maxLength: DECISION_REASONING_MAX,
    description: `Agent's reasoning (max ${String(DECISION_REASONING_MAX)} chars). Internal, not shown to user.`,
  };

  return {
    type: 'object',
    properties,
    required: ['action'],
    additionalProperties: false,
    description:
      `Decide what to do next. The "action" field selects which other fields are required: ` +
      `${allowedActions.join(', ')}. Read the "action" enum description for the per-action ` +
      `required-field list.`,
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Policy validation before persistence / orchestrator dispatch.
 * First-pass failures are repairable (one bounded generateJson repair in coordinator).
 */
export function validateAgentDecisionForPersistence(
  params: AgentTurnInput,
  deps: HandlerDeps,
  decision: AgentTurnDecision,
): AgentDecisionPersistenceResult {
  const toolMap = new Map<string, AgentToolSpec>();
  for (const tool of params.availableTools) {
    toolMap.set(tool.toolId, tool);
  }

  if (decision.action === 'pause_for_input' && params.requestInputPolicy === 'never') {
    // Detect whether the agent has a blocked-signal tool available — runners
    // do (`agent.control.signal_blocked` is part of their multi-step graph),
    // generic helpers may not. The hint follows the agent's actual surface so
    // we don't push a runner toward `complete` (which would fabricate a result)
    // or push a non-runner agent toward a tool it doesn't have. The tool's own
    // toolId goes into the hint — the graph may name the step anything.
    const blockedSignalTool = findBlockedSignalTool(params.availableTools);
    const hint = blockedSignalTool
      ? `If you need information you do not have, call the **${blockedSignalTool.toolId}** tool via invoke_step (with reason and category) — that pauses the run and lets the supervising agent provide what you need. Do NOT use pause_for_input. Do NOT call complete with a fabricated result.`
      : 'Use one of the allowed actions for this turn. Do NOT call pause_for_input again.';
    return {
      kind: 'repairable_reject',
      reason: 'pause_for_input is not allowed when requestInputPolicy is "never". ' + hint,
      code: 'policy_violation',
    };
  }

  if (decision.action === 'invoke_step') {
    if (!toolMap.has(decision.toolId)) {
      return {
        kind: 'repairable_reject',
        reason:
          `Agent selected unknown tool "${decision.toolId}". ` +
          `Available: ${Array.from(toolMap.keys()).join(', ')}`,
        code: 'unknown_step',
      };
    }
    if (!isPlainObject(decision.args)) {
      return {
        kind: 'repairable_reject',
        reason: `invoke_step requires "args" to be a JSON object (received ${decision.args === null ? 'null' : typeof decision.args}).`,
        code: 'args_not_object',
      };
    }
    const tool = toolMap.get(decision.toolId)!;
    // Skip strict JSON Schema arg validation for:
    //   - Virtual tools: their Zod schemas have preprocessors (e.g.,
    //     memory.store.get coerces {path} → {target:{path}}) that the raw
    //     JSON Schema doesn't reflect. The executor validates via Zod.
    const isVirtualTool = tool.kind === 'virtual';
    const isSubmitOutput = tool.operationId === 'agent.control.submit_output';
    if (!isVirtualTool && !isSubmitOutput) {
      // A structured argument sent as a JSON string is understood rather than
      // refused: the refusal reads as a tool failure to the model, which
      // answers it by repeating its last move.
      const c = coerceStringifiedToolArgs(decision.args, tool.inputSchema);
      if (c.coerced.length > 0) decision.args = c.args;
      const argErr = deps.validateToolArgs(decision.toolId, decision.args, tool.inputSchema);
      if (argErr) {
        return {
          kind: 'repairable_reject',
          reason: argErr.message,
          code: persistenceCodeFromArgErr(argErr),
          argShapes: describeArgShapes(decision.args),
        };
      }
    }
  }

  if (decision.action === 'invoke_steps') {
    // Over-request degrades gracefully — it never fails the run. An invoke_steps
    // batch is a set of INDEPENDENT parallel calls, so running the first `cap` this
    // turn and letting the agent re-request the rest next turn is safe. `cap` is the
    // tighter of the parallel / per-turn limits; both are stated in the prompt, so a
    // well-behaved agent stays under it — this is the backstop for when it doesn't
    // (a rejected over-parallel decision used to kill the run after one repair).
    const cap = Math.min(params.policy.maxParallel, params.policy.maxToolCallsPerTurn);
    if (decision.calls.length > cap) {
      decision = { ...decision, calls: decision.calls.slice(0, cap) };
    }
    for (const [i, call] of decision.calls.entries()) {
      if (!toolMap.has(call.toolId)) {
        return {
          kind: 'repairable_reject',
          reason:
            `Agent selected unknown tool "${call.toolId}" in calls[${String(i)}]. ` +
            `Available: ${Array.from(toolMap.keys()).join(', ')}`,
          code: 'unknown_step',
        };
      }
      if (!isPlainObject(call.args)) {
        return {
          kind: 'repairable_reject',
          reason: `calls[${String(i)}].args must be a JSON object (received ${call.args === null ? 'null' : typeof call.args}).`,
          code: 'args_not_object',
        };
      }
      const tool = toolMap.get(call.toolId)!;
      const isVirtualTool = tool.kind === 'virtual';
      const isSubmitOutput = tool.operationId === 'agent.control.submit_output';
      if (!isVirtualTool && !isSubmitOutput) {
        const c = coerceStringifiedToolArgs(call.args, tool.inputSchema);
        if (c.coerced.length > 0) call.args = c.args;
        const argErr = deps.validateToolArgs(call.toolId, call.args, tool.inputSchema);
        if (argErr) {
          return {
            kind: 'repairable_reject',
            reason: `Agent tool "${call.toolId}" in calls[${String(i)}]: ${argErr.message}`,
            code: persistenceCodeFromArgErr(argErr),
          };
        }
      }
    }
  }

  return { kind: 'accepted', decision };
}

export function applyOperationIdStepRewrite(
  _ctx: ExecutorContext,
  decision: AgentTurnDecision,
  toolIds: string[],
): AgentTurnDecision {
  if (decision.action !== 'invoke_step') {
    return decision;
  }
  const toolIdSet = new Set(toolIds);
  const chosen = decision.toolId;
  const hasRunStepTool = toolIdSet.has('flowcontrol-1');

  if (!toolIdSet.has(chosen) && hasRunStepTool) {
    const opId = chosen;
    const originalArgs = decision.args ?? {};
    (decision as Record<string, unknown>)['toolId'] = 'flowcontrol-1';
    (decision as Record<string, unknown>)['args'] = {
      operationId: opId,
      ...originalArgs,
    };
  }
  return decision;
}

export interface GenerateJsonAgentDecisionOutcome {
  decision: AgentTurnDecision;
  /** Raw JSON from the final accepted parse attempt (includes Zod repair output when repair ran). */
  rawContent: string;
  /** High-level attempt markers for `decisionAttemptSummary`. */
  attemptNotes: string[];
  /**
   * When Zod repair ran, messages for the successful attempt (history + repair user turn).
   * Omit when the first parse succeeded (caller uses original merged snapshot).
   */
  requestSnapshot?: AiMessageV1[];
  /** Sum of token usage across first + repair `generateJson` when repair ran. */
  usage: TokenUsage;
  /** Model for the accepted attempt (`generateJson` repair response when repair ran). */
  model: string;
  /** Provider for the accepted attempt. */
  provider: string;
  /** Merged cost across both calls when both report cost. */
  cost?: CostBreakdown;
}

type JsonRepairMeta = Pick<GenerateJsonResponse<unknown>, 'usage' | 'cost' | 'model' | 'provider'>;

/**
 * Parse generateJson output; at most one Zod repair round-trip.
 */
export async function parseGenerateJsonAgentDecision(
  ctx: ExecutorContext,
  deps: HandlerDeps,
  client: AIClient,
  model: string,
  merged: ChatMessage[],
  params: AgentTurnInput,
  firstResponse: Pick<GenerateJsonResponse<unknown>, 'usage' | 'cost' | 'model' | 'provider'>,
  firstRawDecision: Record<string, unknown>,
  firstRawContent: string,
): Promise<GenerateJsonAgentDecisionOutcome> {
  const agentDecisionJsonSchema = buildAgentDecisionRawJsonSchema(params);
  const allowedActions = getAllowedAgentDecisionActions({
    requestInputPolicy: params.requestInputPolicy,
    allowComplete: params.policy.allowComplete,
  });

  if (
    (firstRawDecision['action'] === null || firstRawDecision['action'] === undefined) &&
    typeof firstRawDecision['message'] === 'string' &&
    firstRawDecision['message'].length > 0
  ) {
    const implicitDecision = buildImplicitTextOnlyAgentDecision({
      requestInputPolicy: params.requestInputPolicy,
      allowComplete: params.policy.allowComplete,
      message: firstRawDecision['message'],
      availableTools: params.availableTools,
    });
    firstRawDecision['action'] = implicitDecision.action;
    if (implicitDecision.action === 'complete') {
      firstRawDecision['result'] = implicitDecision.result;
    } else if (implicitDecision.action === 'invoke_step') {
      firstRawDecision['toolId'] = implicitDecision.toolId;
      firstRawDecision['args'] = implicitDecision.args;
      if (implicitDecision.message !== undefined) {
        firstRawDecision['message'] = implicitDecision.message;
      } else {
        delete firstRawDecision['message'];
      }
    }
  }

  if (
    firstRawDecision['action'] === 'pause_for_input' &&
    typeof firstRawDecision['message'] === 'string'
  ) {
    const normalized = normalizeDisallowedPauseDecision({
      requestInputPolicy: params.requestInputPolicy,
      allowComplete: params.policy.allowComplete,
      availableTools: params.availableTools,
      decision: {
        action: 'pause_for_input',
        message: firstRawDecision['message'],
        ...(typeof firstRawDecision['reasoning'] === 'string'
          ? { reasoning: firstRawDecision['reasoning'] }
          : {}),
      },
    });
    if (normalized.action === 'complete') {
      firstRawDecision['action'] = 'complete';
      firstRawDecision['result'] = normalized.result;
      firstRawDecision['message'] = normalized.message;
    } else if (normalized.action === 'invoke_step') {
      firstRawDecision['action'] = 'invoke_step';
      firstRawDecision['toolId'] = normalized.toolId;
      firstRawDecision['args'] = normalized.args;
      if (normalized.message !== undefined) {
        firstRawDecision['message'] = normalized.message;
      } else {
        delete firstRawDecision['message'];
      }
      if (normalized.reasoning !== undefined) {
        firstRawDecision['reasoning'] = normalized.reasoning;
      }
    }
  }

  let parseResult = AgentTurnDecisionSchema.safeParse(firstRawDecision);
  let rawOut = firstRawContent;
  const attemptNotes: string[] = [];
  let repairRequestSnapshot: AiMessageV1[] | undefined;
  let repairedMeta: JsonRepairMeta | undefined;

  if (!parseResult.success) {
    ctx.log.warn('agent_turn_zod_repair_attempted', {
      error: parseResult.error.message,
      tenantId: ctx.job.tenantId,
      runId: ctx.runId,
      stepExecutionId: ctx.job.stepExecutionId,
      turnNumber: params.turnNumber,
      model: firstResponse.model,
    });

    try {
      await deps.payloadStore.store({
        tenantId: ctx.job.tenantId as TenantId,
        runId: ctx.runId,
        stepExecutionId: ctx.job.stepExecutionId as StepExecutionId,
        attempt: ctx.job.attempt,
        kind: 'logs',
        data: {
          rejected: true,
          rejectionReason: 'invalid_agent_turn_decision',
          validationError: parseResult.error.message,
          turnNumber: params.turnNumber,
          model: firstResponse.model,
          rawContent: firstRawContent,
          createdAtMs: Date.now(),
        },
      });
    } catch {
      // ignore log failures
    }

    const validationErrors = parseResult.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    const repairPrompt =
      'Your previous JSON output failed schema validation.\n\n' +
      `Validation errors:\n${validationErrors}\n\n` +
      'Fix these errors and return a corrected JSON object.\n' +
      `The "action" field MUST be one of: ${allowedActions.join(', ')}.\n` +
      'No prose, no markdown — only the corrected JSON.';

    const repairMessages: ChatMessage[] = [
      ...merged,
      { role: 'user' as const, content: repairPrompt },
    ];

    const repaired = await client.generateJson({
      model,
      messages: repairMessages,
      resolveToolImage: toolImageResolver(ctx),
      schema: z.unknown(),
      schemaName: 'agent_turn_decision_repair',
      rawJsonSchema: agentDecisionJsonSchema,
      strictJsonSchema: false,
      temperature: 0,
      tenantId: ctx.job.tenantId as TenantId,
      runId: ctx.runId,
      stepExecutionId: ctx.job.stepExecutionId as StepExecutionId,
      attempt: ctx.job.attempt,
    });

    const repairedDecision = repaired.data as Record<string, unknown>;
    parseResult = AgentTurnDecisionSchema.safeParse(repairedDecision);
    rawOut = repaired.rawContent;
    if (!parseResult.success) {
      ctx.log.error('agent_turn_zod_repair_failed', {
        error: parseResult.error.message,
        tenantId: ctx.job.tenantId,
        runId: ctx.runId,
        stepExecutionId: ctx.job.stepExecutionId,
        turnNumber: params.turnNumber,
        model: repaired.model,
        provider: repaired.provider,
      });
      throw new InvalidAgentTurnDecisionError(
        `Agent decision remained invalid after one repair attempt: ${parseResult.error.message}`,
      );
    }
    attemptNotes.push('generate_json_zod_repair_succeeded');
    repairRequestSnapshot = repairMessages.map(chatMessageToAiMessage);
    repairedMeta = {
      usage: repaired.usage,
      ...(repaired.cost !== undefined ? { cost: repaired.cost } : {}),
      model: repaired.model,
      provider: repaired.provider,
    };
  }

  const decision = applyOperationIdStepRewrite(
    ctx,
    parseResult.data,
    params.availableTools.map((t) => t.toolId),
  );

  return buildGenerateJsonOutcome({
    decision,
    rawContent: rawOut,
    attemptNotes,
    repairRequestSnapshot,
    firstResponse,
    repairedResponse: repairedMeta,
  });
}

function buildGenerateJsonOutcome(args: {
  decision: AgentTurnDecision;
  rawContent: string;
  attemptNotes: string[];
  repairRequestSnapshot: AiMessageV1[] | undefined;
  firstResponse: Pick<GenerateJsonResponse<unknown>, 'usage' | 'cost' | 'model' | 'provider'>;
  repairedResponse: JsonRepairMeta | undefined;
}): GenerateJsonAgentDecisionOutcome {
  const {
    decision,
    rawContent,
    attemptNotes,
    repairRequestSnapshot,
    firstResponse,
    repairedResponse,
  } = args;

  if (!repairedResponse) {
    return {
      decision,
      rawContent,
      attemptNotes,
      usage: firstResponse.usage,
      model: firstResponse.model,
      provider: firstResponse.provider,
      ...(firstResponse.cost !== undefined ? { cost: firstResponse.cost } : {}),
      ...(repairRequestSnapshot ? { requestSnapshot: repairRequestSnapshot } : {}),
    };
  }

  const usage = mergeJsonCallUsage(firstResponse.usage, repairedResponse.usage);
  const cost = mergeCostBreakdown(firstResponse.cost, repairedResponse.cost);

  return {
    decision,
    rawContent,
    attemptNotes,
    usage,
    model: repairedResponse.model,
    provider: repairedResponse.provider,
    ...(cost !== undefined ? { cost } : {}),
    ...(repairRequestSnapshot ? { requestSnapshot: repairRequestSnapshot } : {}),
  };
}

export interface PersistenceRepairOutcome {
  decision: AgentTurnDecision;
  rawContent: string;
  requestSnapshot: AiMessageV1[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    reasoningTokens?: number | undefined;
    cacheReadTokens?: number | undefined;
    cacheWriteTokens?: number | undefined;
    uncachedPromptTokens?: number | undefined;
  };
  cost?: {
    promptCost: number;
    completionCost: number;
    totalCost: number;
    currency: string;
    [extra: string]: unknown;
  };
  provider?: string;
}

/**
 * One `generateJson` call after persistence-stage rejection; output must Zod-parse before return.
 */
export async function repairPersistableAgentDecision(
  ctx: ExecutorContext,
  deps: HandlerDeps,
  client: AIClient,
  model: string,
  merged: ChatMessage[],
  params: AgentTurnInput,
  reject: { reason: string; code: string },
): Promise<PersistenceRepairOutcome> {
  const agentDecisionJsonSchema = buildAgentDecisionRawJsonSchema(params);
  // Use the canonical filter — listing pause_for_input as "allowed" in a
  // repair prompt that's recovering from a `never`-policy violation just
  // contradicts the rejection reason and confuses the model. Same helper
  // that builds the JSON Schema's `oneOf` branches.
  const allowedActions = getAllowedAgentDecisionActions({
    requestInputPolicy: params.requestInputPolicy,
    allowComplete: params.policy.allowComplete,
  });

  const schemaHint =
    reject.code === 'schema_compile_failed'
      ? 'The platform could not validate a tool you selected because that tool’s input schema failed to compile. Choose a different valid tool/action if possible, or use `pause_for_input` / `complete` as appropriate.\n\n'
      : '';

  const repairPrompt =
    'Your previous decision could not be accepted by the platform.\n\n' +
    `Reason: ${reject.reason}\n` +
    `(code: ${reject.code})\n\n` +
    schemaHint +
    'Return a corrected JSON object only (no prose, no markdown).\n' +
    `The "action" field MUST be one of: ${allowedActions.join(', ')}.\n` +
    'Ensure tool stepIds and arguments match the available tools and their schemas.';

  const messages: ChatMessage[] = [...merged, { role: 'user' as const, content: repairPrompt }];

  const repaired = await client.generateJson({
    model,
    messages,
    resolveToolImage: toolImageResolver(ctx),
    schema: z.unknown(),
    schemaName: 'agent_turn_decision_persistence_repair',
    rawJsonSchema: agentDecisionJsonSchema,
    strictJsonSchema: false,
    temperature: 0,
    tenantId: ctx.job.tenantId as TenantId,
    runId: ctx.runId,
    stepExecutionId: ctx.job.stepExecutionId as StepExecutionId,
    attempt: ctx.job.attempt,
  });

  const rawDecision = repaired.data as Record<string, unknown>;
  if (
    (rawDecision['action'] === null || rawDecision['action'] === undefined) &&
    typeof rawDecision['message'] === 'string' &&
    rawDecision['message'].length > 0
  ) {
    rawDecision['action'] = 'pause_for_input';
  }

  const parseResult = AgentTurnDecisionSchema.safeParse(rawDecision);
  if (!parseResult.success) {
    ctx.log.error('agent_turn_persistence_repair_zod_failed', {
      error: parseResult.error.message,
      tenantId: ctx.job.tenantId,
      runId: ctx.runId,
      stepExecutionId: ctx.job.stepExecutionId,
      turnNumber: params.turnNumber,
      model: repaired.model,
    });
    throw new InvalidAgentTurnDecisionError(
      `Agent decision remained invalid after one repair attempt: ${parseResult.error.message}`,
    );
  }

  // Guarded to the one case where a pause has no legal replacement besides the
  // blocked-signal escape — the repair round was the last chance, so a repaired
  // pause here would otherwise fail the task at re-validation. Other policies
  // keep their repaired decision untouched.
  const repairedDecision =
    parseResult.data.action === 'pause_for_input' &&
    params.requestInputPolicy === 'never' &&
    !params.policy.allowComplete
      ? normalizeDisallowedPauseDecision({
          requestInputPolicy: params.requestInputPolicy,
          allowComplete: params.policy.allowComplete,
          availableTools: params.availableTools,
          decision: parseResult.data,
        })
      : parseResult.data;

  const decision = applyOperationIdStepRewrite(
    ctx,
    repairedDecision,
    params.availableTools.map((t) => t.toolId),
  );

  return {
    decision,
    rawContent: repaired.rawContent,
    requestSnapshot: messages.map(chatMessageToAiMessage),
    usage: repaired.usage,
    ...(repaired.cost !== undefined ? { cost: repaired.cost } : {}),
    provider: repaired.provider,
  };
}
