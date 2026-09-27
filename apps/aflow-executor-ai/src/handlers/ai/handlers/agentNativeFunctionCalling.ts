import type {
  AgentToolSpec,
  AgentTurnDecision,
  AgentTurnPolicy,
  RequestInputPolicy,
} from '@aflow/schemas';
import {
  buildImplicitTextOnlyAgentDecision,
  isPauseForInputAllowed,
  normalizeDisallowedPauseDecision,
} from '@aflow/schemas';
import type { ToolDefinition, ToolCall, FinishReason } from '@aflow/ai-client';
import {
  ensureObjectType,
  sanitizeSchemaForGeminiFunctionCalling,
} from './nativeFcSchemaSanitize.js';

export {
  sanitizeSchemaForGeminiFunctionCalling,
  ensureObjectType,
} from './nativeFcSchemaSanitize.js';
export {
  convertOrphanToolMessages,
  enforceToolResultAdjacency,
  checkToolResultAdjacency,
  emptySanitizationStats,
  remapFunctionNamesForNativeFC,
} from './nativeFcMessagePatch.js';
import { resolveWebBaseUrl } from '@aflow/lib';
export type { SanitizationStats, AdjacencyViolation } from './nativeFcMessagePatch.js';

// ============================================================================
// Constants
// ============================================================================

const META_FUNCTION_NAMES = new Set(['pause_for_input', 'complete', 'present_options']);
const MAX_FN_NAME_LENGTH = 58; // leave room for collision suffix (up to 6 chars)
const FN_NAME_PATTERN = /[^a-zA-Z0-9_]/g;

/**
 * Build a user-facing message when the model returns no content AND no tool calls.
 * Includes the finishReason so the user (and logs) can diagnose the root cause.
 */
function emptyResponseMessage(finishReason?: string): string {
  switch (finishReason) {
    case 'length':
      return (
        '[The model ran out of output tokens before producing a response. ' +
        'The conversation may be too long — try starting a new session or increasing maxTokens.]'
      );
    case 'content_filter':
      return (
        '[The model response was blocked by a content filter. ' +
        'Try rephrasing your request or adjusting the conversation context.]'
      );
    case 'error':
      return '[The model encountered an error and could not produce a response. Please try again.]';
    case undefined:
    default:
      return `[The model did not produce a response (reason: ${finishReason ?? 'unknown'}). Please try again.]`;
  }
}

// ============================================================================
// Step ID ↔ Function Name Sanitization
// ============================================================================

/**
 * Sanitize a tool ID into a valid function name for providers.
 * Gemini requires: ^[a-zA-Z_][a-zA-Z0-9_]*$, max 64 chars.
 * For virtual tools (operationId with dots), dots are replaced with underscores.
 */
export function toolIdToFnName(toolId: string): string {
  let name = toolId.replace(FN_NAME_PATTERN, '_');
  if (/^\d/.test(name)) {
    name = `_${name}`;
  }
  if (name.length > MAX_FN_NAME_LENGTH) {
    name = name.slice(0, MAX_FN_NAME_LENGTH);
  }
  return name;
}

/**
 * Map a model-returned function name to our tool id.
 * Gemini may echo operation-style IDs with dots (e.g. `api.definition.get`) while
 * declarations use sanitized names (`api_definition_get`). Try direct lookup first,
 * then the sanitized form of the same string.
 */
export function resolveToolIdFromFnName(
  fnName: string,
  fnNameToToolId: Map<string, string>,
): string | undefined {
  const direct = fnNameToToolId.get(fnName);
  if (direct !== undefined) return direct;
  return fnNameToToolId.get(toolIdToFnName(fnName));
}

// ============================================================================
// Function Declaration Building
// ============================================================================

export interface FunctionDeclarationResult {
  tools: ToolDefinition[];
  fnNameToToolId: Map<string, string>;
  toolIdToFnNameMap: Map<string, string>;
}

/**
 * Build ToolDefinition[] from available tools + meta-functions.
 *
 * Each AgentToolSpec becomes a single function declaration. Meta-functions
 * (pause_for_input, complete) are always included per policy.
 *
 * Returns the tools and bidirectional name maps for response mapping.
 *
 * @param provider - Controls schema sanitization. Gemini strips unsupported
 *   keywords (additionalProperties, $ref, etc.). Other providers get the
 *   schema as-is.
 */
export function buildFunctionDeclarations(
  availableTools: AgentToolSpec[],
  policy: {
    allowComplete: boolean;
    allowParallel: boolean;
    agentRole?: string;
    voiceMode?: boolean;
    requestInputPolicy?: RequestInputPolicy;
  },
  provider?: string,
): FunctionDeclarationResult {
  const fnNameToToolId = new Map<string, string>();
  const toolIdToFnNameMap = new Map<string, string>();
  const tools: ToolDefinition[] = [];

  // Process tools in stable order (sorted by toolId) for determinism
  const sorted = [...availableTools].sort((a, b) => a.toolId.localeCompare(b.toolId));

  for (const tool of sorted) {
    let fnName = toolIdToFnName(tool.toolId);

    // Avoid collision with meta-function names.
    // For assistant role, pause_for_input is not a meta-function (text-only = auto-pause),
    // so only 'complete' can collide. For non-interactive subagents, pause_for_input
    // is also absent.
    const pauseForInputEnabled = isPauseForInputAllowed(policy.requestInputPolicy);
    const activeMeta =
      policy.agentRole === 'subagent' && pauseForInputEnabled
        ? META_FUNCTION_NAMES
        : new Set([...(policy.allowComplete ? ['complete'] : []), 'present_options']);
    if (activeMeta.has(fnName)) {
      fnName = `${fnName}_step`;
    }

    // Avoid collision with other tools
    if (fnNameToToolId.has(fnName)) {
      let suffix = 2;
      while (fnNameToToolId.has(`${fnName}_${String(suffix)}`)) {
        suffix++;
      }
      fnName = `${fnName}_${String(suffix)}`;
    }

    fnNameToToolId.set(fnName, tool.toolId);
    toolIdToFnNameMap.set(tool.toolId, fnName);

    const description = tool.description ?? `${tool.name} (${tool.operationId})`;

    const rawSchema =
      Object.keys(tool.inputSchema).length > 0
        ? tool.inputSchema
        : { type: 'object', properties: {} };
    const parameters =
      provider === 'google'
        ? sanitizeSchemaForGeminiFunctionCalling(rawSchema)
        : ensureObjectType(rawSchema);

    tools.push({
      type: 'function',
      function: {
        name: fnName,
        description,
        parameters,
      },
    });
  }

  // Meta-function: pause_for_input
  // For assistant role: NOT included as a function — text-only responses (no tool calls)
  // are automatically mapped to pause_for_input by mapToolCallsToDecision.
  // This prevents models from choosing pause_for_input when they should be calling tools.
  // For subagent role: included so the agent can explicitly signal it is BLOCKED.
  const isSubagent = (policy as { agentRole?: string }).agentRole === 'subagent';
  const isVoiceMode = (policy as { voiceMode?: boolean }).voiceMode === true;
  // Response options schema — shared between present_options (assistant) and pause_for_input (subagent)
  const responseOptionsProperty = {
    type: 'object',
    description:
      'Present structured choices. User sees buttons/dropdown but can always type free-text instead.',
    properties: {
      type: {
        type: 'string',
        enum: ['single', 'multi'],
        description: 'single = pick one, multi = pick several (default: single)',
      },
      options: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            value: { type: 'string', description: 'Option value returned on selection' },
            label: { type: 'string', description: 'Display label (defaults to value)' },
          },
          required: ['value'],
        },
        description: 'Available choices (2-50)',
      },
    },
    required: ['options'],
  };

  if (isSubagent && isPauseForInputAllowed(policy.requestInputPolicy)) {
    const pauseProperties: Record<string, unknown> = {
      message: {
        type: 'string',
        description: 'What you need from the user to proceed',
      },
      reasoning: {
        type: 'string',
        description: 'Brief reasoning for this response (internal, not shown to user)',
      },
      blockingReason: {
        type: 'string',
        description: 'Why you cannot proceed autonomously',
      },
      blockingCategory: {
        type: 'string',
        enum: [
          'missing_input',
          'approval_required',
          'external_dependency',
          'access_denied',
          'other',
        ],
        description: 'Category of blocking condition',
      },
      responseOptions: responseOptionsProperty,
    };
    tools.push({
      type: 'function',
      function: {
        name: 'pause_for_input',
        description:
          'Request user input because you are BLOCKED. Only use when you genuinely cannot proceed autonomously. ' +
          'You MUST provide a blockingReason explaining why you cannot continue.',
        parameters: {
          type: 'object',
          properties: pauseProperties,
          required: ['message', 'blockingReason'],
        },
      },
    });
  } else {
    // Assistant role: present_options function for structured choices
    tools.push({
      type: 'function',
      function: {
        name: 'present_options',
        description:
          'Present structured choices to the user. The user sees buttons or a dropdown and can always type free-text instead. ' +
          'Use when asking the user to choose from a known set of options.',
        parameters: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: 'Question or prompt to show alongside the options',
            },
            options: responseOptionsProperty.properties.options,
            type: responseOptionsProperty.properties.type,
            reasoning: {
              type: 'string',
              description: 'Brief reasoning (internal, not shown to user)',
            },
          },
          required: ['message', 'options'],
        },
      },
    });
  }

  // Meta-function: complete (conditional)
  if (policy.allowComplete) {
    tools.push({
      type: 'function',
      function: {
        name: 'complete',
        description: isSubagent
          ? 'Complete the delegated task with a final structured result. ' +
            'Use when the task is done and you have a clear output to return.'
          : 'Complete the task and show a final summary. The run pauses so the user can respond or stop. ' +
            'Prefer pause_for_input if you want to ask a follow-up question.',
        parameters: {
          type: 'object',
          properties: {
            result: {
              type: 'string',
              description: isSubagent
                ? 'Final structured result of the task (JSON string preferred)'
                : 'Final result of the task (can be a JSON string)',
            },
            message: {
              type: 'string',
              description: isVoiceMode
                ? 'Detailed summary shown in chat UI (can include markdown). Your text content is the spoken version.'
                : 'Summary message for the user',
            },
            reasoning: {
              type: 'string',
              description: 'Brief reasoning (internal)',
            },
          },
          required: isSubagent ? ['result', 'message'] : ['message'],
        },
      },
    });
  }

  return {
    tools,
    fnNameToToolId,
    toolIdToFnNameMap,
  };
}

// ============================================================================
// Response Mapping: toolCalls → AgentTurnDecision
// ============================================================================

/**
 * Map a generateText response to an AgentTurnDecision.
 *
 * Handles: text-only, single tool call, multiple tool calls, meta-functions,
 * and mixed calls (tool + meta-function).
 */
export interface MapToolCallsResult {
  decision: AgentTurnDecision;
  warnings: string[];
  /**
   * The model ran out of output budget partway through a tool call's
   * arguments, so what arrived is a prefix of valid JSON rather than a
   * malformed call. Reasoning is paid from the same budget as the answer, so a
   * model that thinks at length before emitting a large call can exhaust it
   * mid-argument — one run's raw arguments ended at `{"mutationId":
   * "draft-2", "operations": `.
   *
   * Worth distinguishing because the remedy is the opposite of the one a
   * malformed call gets: send FEWER items, not the same call again.
   */
  truncatedToolArgs?: boolean;
}

export function mapToolCallsToDecision(
  response: {
    content: string | null;
    toolCalls: ToolCall[] | undefined;
    finishReason?: FinishReason;
  },
  fnNameToToolId: Map<string, string>,
  maxToolCallsPerTurn: number,
  policy?: {
    allowComplete?: boolean;
    requestInputPolicy?: RequestInputPolicy;
    availableTools?: AgentToolSpec[];
  },
): MapToolCallsResult {
  const { content, toolCalls, finishReason } = response;
  const warnings: string[] = [];
  let truncatedToolArgs = false;

  // No tool calls — text-only response → pause_for_input
  if (!toolCalls || toolCalls.length === 0) {
    const raw = content?.trim() || emptyResponseMessage(finishReason);
    const message = stripModelMetaTags(stripTrailingDecisionJson(raw));
    return {
      decision: buildImplicitTextOnlyAgentDecision({
        requestInputPolicy: policy?.requestInputPolicy,
        allowComplete: policy?.allowComplete ?? true,
        message,
        ...(policy?.availableTools ? { availableTools: policy.availableTools } : {}),
      }),
      warnings,
      ...(truncatedToolArgs ? { truncatedToolArgs: true } : {}),
    };
  }

  // Parse all tool calls
  const parsed = toolCalls.map((tc) => {
    const fnName = tc.function.name;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
    } catch (err) {
      if (finishReason === 'length') truncatedToolArgs = true;
      warnings.push(
        `${truncatedToolArgs ? 'Truncated' : 'Malformed'} arguments for tool call ` +
          `"${fnName}" (id: ${tc.id}): ${err instanceof Error ? err.message : String(err)}. ` +
          `Raw: ${tc.function.arguments.slice(0, 200)}`,
      );
      args = {};
    }
    return { fnName, args };
  });

  // Check for meta-functions
  const metaCall = parsed.find((p) => META_FUNCTION_NAMES.has(p.fnName));
  const toolStepCalls = parsed.filter((p) => !META_FUNCTION_NAMES.has(p.fnName));

  // Mixed calls (tool steps + meta-function): prefer the tool calls.
  // The model may include pause_for_input alongside real tool calls — honor the tools,
  // and use the meta-function's message (or text content) as the decision message.
  if (metaCall && toolStepCalls.length > 0) {
    warnings.push(
      `Model called both tool(s) and "${metaCall.fnName}" — ignoring meta-function, executing tool calls.`,
    );
    // Fall through to tool call handling below (metaCall is filtered out of toolStepCalls)
  }

  // Pure meta-function call(s)
  if (metaCall && toolStepCalls.length === 0) {
    return {
      decision: mapMetaFunctionCall(metaCall.fnName, metaCall.args, content, {
        allowComplete: policy?.allowComplete ?? true,
        ...(policy?.requestInputPolicy ? { requestInputPolicy: policy.requestInputPolicy } : {}),
        ...(policy?.availableTools ? { availableTools: policy.availableTools } : {}),
      }),
      warnings,
      ...(truncatedToolArgs ? { truncatedToolArgs: true } : {}),
    };
  }

  // Single tool step call
  if (toolStepCalls.length === 1) {
    const call = toolStepCalls[0]!;
    const toolId = resolveToolIdFromFnName(call.fnName, fnNameToToolId);
    if (!toolId) {
      throw new Error(`Unknown function name in model response: "${call.fnName}"`);
    }
    const msg = content ? stripModelMetaTags(content) : undefined;
    return {
      decision: {
        action: 'invoke_step',
        toolId,
        args: call.args,
        ...(msg ? { message: msg } : {}),
      },
      warnings,
      ...(truncatedToolArgs ? { truncatedToolArgs: true } : {}),
    };
  }

  // Multiple tool step calls → invoke_steps (truncate if over limit)
  let effectiveCalls = toolStepCalls;
  if (toolStepCalls.length > maxToolCallsPerTurn) {
    warnings.push(
      `Model requested ${String(toolStepCalls.length)} tool calls but max is ${String(maxToolCallsPerTurn)}; truncated to first ${String(maxToolCallsPerTurn)}`,
    );
    effectiveCalls = toolStepCalls.slice(0, maxToolCallsPerTurn);
  }

  const calls = effectiveCalls.map((call) => {
    const toolId = resolveToolIdFromFnName(call.fnName, fnNameToToolId);
    if (!toolId) {
      throw new Error(`Unknown function name in model response: "${call.fnName}"`);
    }
    return { toolId, args: call.args };
  });

  const msg = content ? stripModelMetaTags(content) : undefined;
  return {
    decision: {
      action: 'invoke_steps',
      calls,
      ...(msg ? { message: msg } : {}),
    },
    warnings,
    ...(truncatedToolArgs ? { truncatedToolArgs: true } : {}),
  };
}

/**
 * Combine streamed pre-tool-call narration with the meta-function's `message` arg.
 *
 * Native function calling lets the model emit text content BEFORE the tool call.
 * That streamed text is the agent's explanation; `args.message` is typically a
 * shorter prompt that pairs with options. Both are valuable — preserve both.
 *
 * Skips the merge when the narration already ends with the prompt (some models
 * echo the prompt at the end of their stream) to avoid a duplicated tail.
 */
function mergeNarrationAndMessage(
  content: string | null,
  argMessage: string | undefined,
): string | undefined {
  const narration = content?.trim();
  const promptText = argMessage?.trim();
  if (!narration) return promptText;
  if (!promptText) return narration;
  if (narration === promptText) return promptText;
  if (narration.endsWith(promptText)) return narration;
  return `${narration}\n\n${promptText}`;
}

function mapMetaFunctionCall(
  fnName: string,
  args: Record<string, unknown>,
  content: string | null,
  policy?: {
    allowComplete: boolean;
    requestInputPolicy?: RequestInputPolicy;
    availableTools?: AgentToolSpec[];
  },
): AgentTurnDecision {
  if (fnName === 'pause_for_input') {
    const rawMessage =
      mergeNarrationAndMessage(content, args['message'] as string | undefined) ??
      '[The model did not produce a response. Please try again.]';
    const message = stripModelMetaTags(rawMessage);
    const reasoning = args['reasoning'] as string | undefined;
    const responseOptions = args['responseOptions'] as
      { type?: string; options?: Array<{ value: string; label?: string }> } | undefined;
    const roType = responseOptions?.type === 'multi' ? ('multi' as const) : ('single' as const);
    return normalizeDisallowedPauseDecision({
      requestInputPolicy: policy?.requestInputPolicy,
      allowComplete: policy?.allowComplete ?? true,
      ...(policy?.availableTools ? { availableTools: policy.availableTools } : {}),
      decision: {
        action: 'pause_for_input',
        message,
        ...(responseOptions?.options
          ? { responseOptions: { type: roType, options: responseOptions.options } }
          : {}),
        ...(reasoning ? { reasoning } : {}),
      },
    });
  }

  if (fnName === 'present_options') {
    const rawMessage =
      mergeNarrationAndMessage(content, args['message'] as string | undefined) ??
      'Please choose an option:';
    const message = stripModelMetaTags(rawMessage);
    const options = args['options'] as Array<{ value: string; label?: string }> | undefined;
    const rawType = args['type'] as string | undefined;
    const type = rawType === 'multi' ? ('multi' as const) : ('single' as const);
    const reasoning = args['reasoning'] as string | undefined;
    // present_options is offered even when pausing is forbidden (it is the
    // assistant-shaped meta-call), so its pause needs the same policy
    // normalization as an explicit pause_for_input.
    return normalizeDisallowedPauseDecision({
      requestInputPolicy: policy?.requestInputPolicy,
      allowComplete: policy?.allowComplete ?? true,
      ...(policy?.availableTools ? { availableTools: policy.availableTools } : {}),
      decision: {
        action: 'pause_for_input',
        message,
        ...(options ? { responseOptions: { type, options } } : {}),
        ...(reasoning ? { reasoning } : {}),
      },
    });
  }

  if (fnName === 'complete') {
    const result = args['result'] as string | undefined;
    const rawMessage =
      mergeNarrationAndMessage(content, args['message'] as string | undefined) ?? 'Task completed.';
    const message = stripModelMetaTags(rawMessage);
    const reasoning = args['reasoning'] as string | undefined;
    return {
      action: 'complete',
      result: result ?? message,
      ...(message ? { message } : {}),
      ...(reasoning ? { reasoning } : {}),
    };
  }

  throw new Error(`Unknown meta-function: "${fnName}"`);
}

/**
 * Strip model-internal XML tags (reasoning, thinking, etc.) from text content.
 * Models like Claude and Gemini sometimes wrap internal reasoning in XML tags
 * that should never be shown to users or spoken by TTS.
 */
export function stripModelMetaTags(text: string): string {
  return text
    .replace(/<(reasoning|thinking|internal|reflection|scratchpad)>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(reasoning|thinking|internal|reflection|scratchpad)\s*\/>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const KNOWN_DECISION_ACTIONS = new Set([
  'invoke_step',
  'invoke_steps',
  'pause_for_input',
  'complete',
]);

/**
 * Strip trailing JSON decision blocks from model text responses.
 * Some models (especially Gemini) output both a text response AND a JSON
 * `{"action":"...","message":"..."}` block when they should only use
 * native function calls. This prevents the JSON from leaking into the chat.
 *
 * Only strips if the trailing block parses as valid JSON with a known
 * `action` value, avoiding false positives on legitimate text content.
 */
export function stripTrailingDecisionJson(text: string): string {
  // Match the opening of a decision JSON block: { "action": "<known_action>"
  // Using a targeted pattern avoids the lastIndexOf('{') bug where nested
  // braces inside args would be found instead of the outer decision object.
  const pattern = /\{\s*"action"\s*:\s*"(invoke_step|invoke_steps|pause_for_input|complete)"/;
  const match = pattern.exec(text);
  if (match?.index == null) return text;

  const candidate = text.slice(match.index);
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (
      parsed != null &&
      typeof parsed === 'object' &&
      'action' in parsed &&
      KNOWN_DECISION_ACTIONS.has((parsed as Record<string, unknown>)['action'] as string)
    ) {
      return text.slice(0, match.index).trim();
    }
  } catch {
    // Not valid JSON — leave text unchanged
  }
  return text;
}

// ============================================================================
// System Prompt for Native FC
// ============================================================================

/**
 * Build a simplified system prompt for native function calling mode.
 * Omits "Available Tools" and "Decision Format" sections (these are expressed
 * as function declarations). Keeps platform policies and status.
 */
export function buildNativeFCSystemPrompt(params: {
  systemPrompt?: string;
  flowName?: string;
  flowDescription?: string;
  turnNumber: number;
  totalToolCallsSoFar: number;
  policy: Pick<
    AgentTurnPolicy,
    'maxToolCallsPerTurn' | 'maxParallel' | 'allowComplete' | 'allowParallel'
  >;
  agentRole: 'assistant' | 'subagent' | undefined;
  completionPrompt: string | undefined;
  finalOutputSchema?: Record<string, unknown> | undefined;
}): string {
  const parts: string[] = [];
  const isSubagent = params.agentRole === 'subagent';

  parts.push(
    params.systemPrompt ??
      'You are a capable agent. Analyze the request and decide the best action to take.',
  );

  parts.push('', '## Behavior Guidelines', '');

  if (isSubagent) {
    parts.push(
      '- You are a delegated worker executing a bounded task autonomously.',
      '- To invoke a tool, call the corresponding function with the required arguments.',
      '- NEVER ask "anything else?", "need adjustments?", or offer follow-ups — complete and exit.',
      '- Your result will be returned to the calling agent — make it structured and actionable.',
    );
    // Only mention complete/pause_for_input meta-functions if they are
    // actually registered. When the Runner uses graph steps (submit_output /
    // signal_blocked), completionPolicy='open_ended' suppresses complete.
    // The Runner's own system prompt guides the agent to the right tools.
    if (params.policy.allowComplete) {
      parts.push(
        '- When the task is complete, call complete with a structured result.',
        '- If you are missing information or cannot produce the required output, call pause_for_input with a blockingReason.',
      );
    }
  } else {
    parts.push(
      '- To invoke a tool, call the corresponding function with the required arguments.',
      '- You can include a text message alongside a tool call — it will be shown to the user while the tool runs. Use this for progress updates (e.g. "Scoring the lead now...").',
      '- To respond to the user WITHOUT calling a tool, just output text with no function calls. This pauses the run and waits for the user to reply.',
      '- To present structured choices, call present_options with a message and options array. The user sees buttons but can always type free-text instead.',
      '- IMPORTANT: If you still have work to do, ALWAYS call a tool function. Do not output text-only responses just to acknowledge — do the work.',
    );
  }

  if (params.policy.allowParallel) {
    parts.push(
      `- You may call multiple tool functions in one turn if the tasks are independent (parallel execution), up to ${String(params.policy.maxParallel)} in parallel. If you request more, only the first ${String(params.policy.maxParallel)} run this turn — request the rest next turn.`,
    );
  }
  parts.push(
    '- Do NOT stop working prematurely. If you have tools to call, call them.',
    '- If a tool call fails, you can retry with different arguments or respond with text to ask the user for help.',
  );
  if (params.policy.allowComplete) {
    parts.push(
      isSubagent
        ? '- When you have completed the task, call complete with the final result.'
        : '- When you are done with the task, call complete with a summary.',
    );
  }

  // A tool-using Runner takes this path, and the task's output contract used to
  // reach it only as the type of submit_output's `result` parameter. Submitting
  // takes no result now, so without this section the agent builds toward a
  // shape it cannot see — one live run answered that by submitting probe
  // payloads until something passed, then proposed the probe.
  if (params.finalOutputSchema) {
    parts.push(
      '',
      '## Output Contract',
      '',
      'The task output MUST conform to this schema:',
      JSON.stringify(params.finalOutputSchema, null, 2),
    );
  }

  parts.push(
    '',
    '## Data References ($ref)',
    '',
    'Pass data between tools by reference — never copy large data into arguments.',
    '',
    'Syntax: set any argument value to {"$ref": "<path>"}:',
    '- {"$ref": "output.TOOL_CALL_ID/data"} — primary data from a previous tool call (same path for all operations)',
    '- {"$ref": "state.VARIABLE/field"} — field from a state variable',
    '',
    '$ref is resolved to actual data before the tool runs. It works in any argument position,',
    'including where the schema expects a string (e.g. file contents, inline text).',
    '',
    'When a tool result is large, the output shows a "To pass full data" hint with the exact $ref to use.',
    '',
    'Call your tools directly by name. Prefer curated tools when they fit your use case.',
    'Use `discover` for operations not in your current set (if available).',
  );

  const webBaseUrl = resolveWebBaseUrl();
  const integrationsUrl = `${webBaseUrl}/integrations`;

  parts.push(
    '',
    '## Platform Policies',
    '',
    'These policies are enforced by the platform and cannot be overridden:',
    '',
    '1. **Never ask for or accept credentials, secrets, API keys, tokens, or passwords.** If a tool or API call fails because credentials are missing or misconfigured, instruct the user to configure them in the Integrations page. Never offer to handle secrets on their behalf.',
    '2. **Never include secrets in tool arguments.** Authentication is resolved automatically at runtime by the platform. Your tool inputs should only contain non-secret parameters.',
    '3. **API calls are fully managed by the platform.** When calling an external API, you only provide the apiId, endpointId, and parameters. The platform automatically resolves the connection, credentials, and authentication. Never attempt to manage connections, bindings, or credential keys — that is handled by the user in the Integrations page.',
    '',
    `**Integrations page**: [${integrationsUrl}](${integrationsUrl})`,
  );

  // Referencing previous tool outputs — kept minimal; field-specific $ref
  // guidance lives in schema .describe() (principle 1: schema-first discovery).

  if (params.completionPrompt) {
    parts.push('', '## Completion Instructions', '', params.completionPrompt);
  }

  const statusParts: string[] = [];
  if (params.flowName) {
    statusParts.push(
      `Flow: ${params.flowName}${params.flowDescription ? ` — ${params.flowDescription}` : ''}`,
    );
  }
  statusParts.push(`Agent role: ${params.agentRole ?? 'assistant'}`);
  statusParts.push(`Max tool calls per turn: ${String(params.policy.maxToolCallsPerTurn)}`);
  if (params.policy.allowParallel) {
    statusParts.push(`Max parallel tool calls: ${String(params.policy.maxParallel)}`);
  }
  parts.push('', '## Status', '', statusParts.join('\n'));

  return parts.join('\n');
}

// ============================================================================
// Observability Helpers
// ============================================================================

/**
 * Build a human-readable rawContent string from a generateText response
 * for observability snapshots.
 */
export function buildRawContentFromResponse(response: {
  content: string | null;
  toolCalls: ToolCall[] | undefined;
}): string {
  if (response.toolCalls && response.toolCalls.length > 0) {
    return response.toolCalls
      .map((tc) => `${tc.function.name}(${tc.function.arguments})`)
      .join('; ');
  }
  if (response.content) return stripTrailingDecisionJson(response.content);
  return '[no content]';
}
