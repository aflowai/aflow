/**
 * Deterministic capture of the tool surface serialized into a turn's model
 * request — the executed truth the inspector renders. Computed from
 * (availableTools, policy, provider, deliveryMode) alone, so it describes the
 * request independent of any response retry/fallback.
 *
 * The two delivery modes spend tool tokens differently:
 * - native_fc: each tool becomes a provider function declaration (outside the
 *   system string) — `tools` is purely additive to `system`.
 * - generate_json: each tool's schema is rendered into the system string — the
 *   caller subtracts `toolsChars` from `system` so the two never double-count.
 */
import { contentHash } from '@aflow/schemas';
import type { ToolSurface, ToolSurfaceEntry } from '@aflow/schemas';
import type { AgentTurnInput } from '../schema.js';
import type { AgentToolSpec } from '@aflow/schemas';
import { estimateStringTokens, ESTIMATED_CHARS_PER_TOKEN } from '../../tokenEstimate.js';
import { buildFunctionDeclarations } from './agentNativeFunctionCalling.js';

export interface ToolSurfaceCapture {
  /** Executor-populated subset — orchestrator adds `scope`/`discoverable` in P2. */
  surface: ToolSurface;
  /**
   * The `tools` token component: a single ceil over the total tool-schema chars,
   * so it composes cleanly with a char-based `system` subtraction (JSON mode).
   * Per-entry `estTokens` are individual estimates for display and sum to ~this.
   */
  toolsTokens: number;
  /** Chars the tool schemas occupy in the system string (generate_json only). */
  toolsChars: number;
}

/**
 * The exact per-tool lines `buildGenerateJsonSystemPrompt` renders under
 * "## Available Tools". Shared with the prompt builder so the prompt bytes and
 * the accounting stay identical.
 */
export function renderJsonToolLines(tool: AgentToolSpec): string[] {
  const lines = [`### ${tool.name} (tool: ${tool.toolId}, type: ${tool.stepType})`];
  if (tool.description) {
    lines.push(tool.description);
  }
  if (Object.keys(tool.inputSchema).length > 0) {
    // Serialized compactly: indentation is insignificant to a JSON parse but is
    // ~30% of these bytes, and this block is re-sent on EVERY turn for EVERY
    // tool. Measured on a 23-endpoint connector set: 4,515 -> 3,170 tokens.
    lines.push(`Input schema: ${JSON.stringify(tool.inputSchema)}`);
  }
  return lines;
}

/** Graph tools carry no `source`/`kind`; virtual tools always set both. */
function deriveEntryMeta(spec: AgentToolSpec): {
  source: ToolSurfaceEntry['source'];
  kind: ToolSurfaceEntry['kind'];
} {
  return {
    source: spec.source ?? 'graph',
    kind: spec.kind ?? 'graph',
  };
}

function toEntry(
  spec: AgentToolSpec,
  callName: string,
  parameters: Record<string, unknown>,
  estTokens: number,
): ToolSurfaceEntry {
  const { source, kind } = deriveEntryMeta(spec);
  return {
    toolId: spec.toolId,
    callName,
    source,
    kind,
    ...(spec.lowering ? { lowering: spec.lowering } : {}),
    ...(spec.operationId ? { operationId: spec.operationId } : {}),
    ...(spec.stepType ? { stepType: spec.stepType } : {}),
    ...(spec.description ? { description: spec.description } : {}),
    estTokens,
    parameters,
    ...(spec.discoveredAtTurn !== undefined ? { discoveredAtTurn: spec.discoveredAtTurn } : {}),
    ...(spec.lastUsedAtTurn !== undefined ? { lastUsedAtTurn: spec.lastUsedAtTurn } : {}),
  };
}

export function buildToolSurface(args: {
  params: AgentTurnInput;
  provider: string;
  model: string;
  deliveryMode: 'native_fc' | 'generate_json';
}): ToolSurfaceCapture {
  const { params, provider, model, deliveryMode } = args;
  const active: ToolSurfaceEntry[] = [];
  let toolsChars = 0;

  if (deliveryMode === 'native_fc') {
    // Rebuild the exact declarations the model stage sends (same policy shape).
    const { tools: declarations, fnNameToToolId } = buildFunctionDeclarations(
      params.availableTools,
      {
        ...params.policy,
        agentRole: params.agentRole,
        ...(params.requestInputPolicy ? { requestInputPolicy: params.requestInputPolicy } : {}),
        ...(params.voiceMode ? { voiceMode: true } : {}),
      },
      provider,
    );
    const specByToolId = new Map(params.availableTools.map((t) => [t.toolId, t]));
    for (const decl of declarations) {
      const fn = decl.function;
      const serialized = JSON.stringify(fn);
      const estTokens = estimateStringTokens(serialized);
      toolsChars += serialized.length;
      const toolId = fnNameToToolId.get(fn.name);
      const spec = toolId !== undefined ? specByToolId.get(toolId) : undefined;
      if (spec) {
        active.push(toEntry(spec, fn.name, fn.parameters, estTokens));
      } else {
        // Executor-added meta function (complete / pause_for_input / present_options).
        active.push({
          toolId: fn.name,
          callName: fn.name,
          source: 'meta',
          kind: 'meta',
          ...(fn.description ? { description: fn.description } : {}),
          estTokens,
          parameters: fn.parameters,
        });
      }
    }
  } else {
    // generate_json: the model addresses tools by toolId (see the decision-format
    // prose); meta actions are prose, not schemas, so they stay in `system`.
    for (const tool of params.availableTools) {
      const block = renderJsonToolLines(tool).join('\n');
      const estTokens = estimateStringTokens(block);
      toolsChars += block.length;
      active.push(toEntry(tool, tool.toolId, tool.inputSchema, estTokens));
    }
  }

  const toolsTokens = Math.ceil(toolsChars / ESTIMATED_CHARS_PER_TOKEN);
  // Full serialized entry size (not just parameters) — this is what the surface
  // actually contributes to the chat-history payload.
  const surfaceBytes = JSON.stringify(active).length;
  const surfaceHash = contentHash(
    active
      .map((e) => `${e.callName}:${JSON.stringify(e.parameters)}`)
      .sort()
      .join('|'),
  );

  const surface: ToolSurface = {
    deliveryMode,
    provider,
    model,
    surfaceBytes,
    surfaceHash,
    active,
    // Cap pressure + discoverable tier are resolved by the orchestrator and
    // echoed verbatim — the executor never re-derives them.
    ...(params.toolSurfaceContext?.scope ? { scope: params.toolSurfaceContext.scope } : {}),
    ...(params.toolSurfaceContext?.discoverable
      ? { discoverable: params.toolSurfaceContext.discoverable }
      : {}),
  };
  return { surface, toolsTokens, toolsChars };
}
