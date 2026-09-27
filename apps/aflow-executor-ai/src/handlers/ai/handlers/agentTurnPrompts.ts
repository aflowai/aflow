/**
 * System prompt builders for ai.agent.turn (generateJson path).
 */
import type { AgentTurnInput } from '../schema.js';
import { isPauseForInputAllowed } from '@aflow/schemas';
import { renderJsonToolLines } from './agentToolSurface.js';
import { resolveWebBaseUrl } from '@aflow/lib';

function buildRolePreamble(params: AgentTurnInput): string {
  const role = params.agentRole;
  if (role === 'subagent') {
    const allowComplete = params.completionPolicy !== 'open_ended';
    // When completionPolicy='open_ended' and requestInputPolicy='never',
    // meta-functions are suppressed — the Runner uses graph steps
    // (submit_output / signal_blocked) instead. Don't mention complete/pause.
    if (!allowComplete) {
      return (
        'You are a delegated worker executing a bounded task autonomously.\n' +
        '- Use tools to accomplish the task without user interaction.\n' +
        '- NEVER ask "anything else?", "need adjustments?", or offer follow-ups.\n' +
        '- Your result will be returned to the calling agent — make it structured and actionable.'
      );
    }
    const mayPause = isPauseForInputAllowed(params.requestInputPolicy);
    return (
      'You are a delegated worker executing a bounded task autonomously.\n' +
      '- Use tools to accomplish the task without user interaction.\n' +
      (mayPause
        ? '- Do NOT ask the user for input unless you are genuinely blocked and cannot proceed.\n' +
          '- When blocked, explain exactly what is missing and why you cannot continue.\n'
        : '- You must NEVER ask the user for input or pause for input.\n' +
          '- If something is missing or blocked, include that clearly in your final result and complete.\n') +
      '- When the task is complete, call `complete` with the final result immediately.\n' +
      '- NEVER ask "anything else?", "need adjustments?", or offer follow-ups. Your job is done when the task is done.\n' +
      '- NEVER pause for input after completing the task. Complete and exit.\n' +
      '- Your result will be returned to the calling agent — make it structured and actionable.'
    );
  }
  return (
    'You are continuing a conversation with the user.\n' +
    '- It is normal to ask follow-up questions and keep the interaction open-ended.\n' +
    '- Use tools as needed to help the user.\n' +
    '- Respond naturally and conversationally.'
  );
}

export function buildGenerateJsonSystemPrompt(params: AgentTurnInput): string {
  const systemParts: string[] = [];
  systemParts.push(
    params.systemPrompt ??
      'You are a capable agent. Analyze the request and decide the best action to take.',
  );

  systemParts.push('', '## Role', '', buildRolePreamble(params));

  systemParts.push('', '## Available Tools', '');
  for (const tool of params.availableTools) {
    systemParts.push(...renderJsonToolLines(tool), '');
  }

  const isSubagent = params.agentRole === 'subagent';
  const toolIds = params.availableTools.map((t) => t.toolId);
  let actionNum = 1;
  systemParts.push(
    '## Decision Format',
    '',
    'You MUST respond with a JSON object. Choose exactly one action:',
    '',
    'Important:',
  );
  if (isSubagent) {
    const allowComplete = params.completionPolicy !== 'open_ended';
    systemParts.push('- Prefer `invoke_step` / `invoke_steps` to make autonomous progress.');
    // Only mention complete/pause_for_input when meta-functions are active.
    // When suppressed (Runner graph steps), the system prompt already guides
    // the agent to submit_output / signal_blocked.
    if (allowComplete) {
      const mayPause = isPauseForInputAllowed(params.requestInputPolicy);
      if (mayPause) {
        systemParts.push(
          '- Only use `pause_for_input` if you are genuinely BLOCKED and cannot proceed. Include `blockingReason` explaining why.',
        );
      } else {
        systemParts.push('- You must never use `pause_for_input`. Finish with `complete` instead.');
      }
      systemParts.push('- Use `complete` when the task is done — include a structured `result`.');
    }
  } else {
    systemParts.push(
      '- If you want to keep working (e.g. "Next I will search / call tools / try another approach"), do NOT pause.',
      '- Instead: choose `invoke_step` / `invoke_steps` and put your progress update in the optional `message` field.',
      '- IMPORTANT: To respond to the user WITHOUT calling a tool, use {"action": "pause_for_input", "message": "your response"}. This pauses the run and waits for the user to reply.',
      '- Do NOT use pause_for_input if you still have tools to call — do the work first.',
    );
  }
  systemParts.push('');

  systemParts.push(
    `${String(actionNum++)}. Invoke a tool: {"action": "invoke_step", "toolId": "<one of: ${toolIds.join(', ')}>", "args": {...}, "message": "optional user-visible message", "reasoning": "..."}`,
  );
  if (params.policy.allowParallel) {
    systemParts.push(
      `${String(actionNum++)}. Invoke multiple tools: {"action": "invoke_steps", "calls": [{"toolId": "...", "args": {...}}], "message": "...", "reasoning": "..."}`,
    );
  }

  if (isSubagent) {
    const allowCompleteActions = params.completionPolicy !== 'open_ended';
    if (allowCompleteActions && isPauseForInputAllowed(params.requestInputPolicy)) {
      systemParts.push(
        `${String(actionNum++)}. Request input (ONLY when blocked): {"action": "pause_for_input", "message": "what you need from the user", "blockingReason": "why you cannot proceed", "blockingCategory": "<missing_input|approval_required|external_dependency|access_denied|other>", "reasoning": "..."}`,
        '   - Use ONLY when you are genuinely blocked and cannot continue autonomously.',
        '   - Optional responseOptions: {"type": "single"|"multi", "options": [{"value": "...", "label": "..."}]} — present structured choices when useful.',
      );
    }
    if (allowCompleteActions) {
      systemParts.push(
        `${String(actionNum++)}. Complete the task: {"action": "complete", "result": <final structured result>, "message": "summary for the user", "reasoning": "..."}`,
        '   - Use when you have finished the task. Include a structured result.',
      );
    }
  } else {
    systemParts.push(
      `${String(actionNum++)}. Reply to the user (PAUSES the run): {"action": "pause_for_input", "message": "your response to the user", "reasoning": "..."}`,
      '   - Use whenever you want to respond, share results, or ask a question. The run pauses until the user replies.',
      '   - Optional responseOptions: {"options": [{"value": "A"}, {"value": "B"}]} — present structured choices. User sees buttons but can always type free-text. For multi-select: {"type": "multi", "options": [...]}',
    );
    if (params.policy.allowComplete) {
      systemParts.push(
        `${String(actionNum++)}. Complete the task: {"action": "complete", "result": <final result>, "message": "optional summary", "reasoning": "..."}`,
        '   - Use when you have finished the task. The run pauses so the user can respond or stop.',
      );
    }
  }

  // The output contract is a property of the TASK, not of the `complete`
  // action. Nesting it under that action hid it from every agent whose
  // completionPolicy is 'open_ended' — the cybernetic Runner among them, which
  // submits through a graph tool and so was left building toward a shape it
  // could not see.
  if (params.finalOutputSchema) {
    systemParts.push(
      '',
      '## Output Contract',
      '',
      'The task output MUST conform to this schema:',
      JSON.stringify(params.finalOutputSchema, null, 2),
    );
  }

  if (params.availableTools.length > 0) {
    systemParts.push(
      '',
      '## Data References ($ref)',
      '',
      'Pass data between tools by reference — never copy large data into arguments.',
      '',
      'Syntax: set any argument value to `{"$ref": "<path>"}`:',
      '- `{"$ref": "output.TOOL_CALL_ID/data"}` — primary data from a previous tool call (same path for all operations)',
      '- `{"$ref": "state.VARIABLE/field"}` — field from a state variable',
      '',
      '$ref is resolved to actual data before the tool runs. It works in any argument position,',
      'including where the schema expects a string (e.g. file contents, inline text).',
      '',
      'When a tool result is large, the output shows a "To pass full data" hint with the exact $ref to use.',
      '',
      'To load more operations: use your **discover** tool (if present), or `catalog.tool.search` / `catalog.tool.list`.',
    );
  }

  const webBaseUrl = resolveWebBaseUrl();
  const integrationsUrl = `${webBaseUrl}/integrations`;

  systemParts.push(
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
    systemParts.push('', '## Completion Instructions', '', params.completionPrompt);
  }

  const rubricParts: string[] = [];
  if (params.flowName) {
    rubricParts.push(
      `Flow: ${params.flowName}${params.flowDescription ? ` — ${params.flowDescription}` : ''}`,
    );
  }
  rubricParts.push(`Agent role: ${params.agentRole}`);
  rubricParts.push(`Max tool calls per turn: ${String(params.policy.maxToolCallsPerTurn)}`);
  if (params.policy.allowParallel) {
    rubricParts.push(`Max parallel tool calls: ${String(params.policy.maxParallel)}`);
  }
  systemParts.push('', '## Status', '', rubricParts.join('\n'));

  return systemParts.join('\n');
}
