import { describe, it, expect } from 'vitest';
import type { AgentToolSpec } from '@aflow/schemas';
import { AgentTurnInputSchema, type AgentTurnInput } from '../schema.js';
import { estimateStringTokens, ESTIMATED_CHARS_PER_TOKEN } from '../../tokenEstimate.js';
import { buildFunctionDeclarations } from './agentNativeFunctionCalling.js';
import { buildGenerateJsonSystemPrompt } from './agentTurnPrompts.js';
import { buildToolSurface, renderJsonToolLines } from './agentToolSurface.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeTool = (overrides: Partial<AgentToolSpec> = {}): AgentToolSpec => ({
  toolId: 'search-1',
  operationId: 'api.http.call',
  stepType: 'api',
  name: 'Search',
  description: 'Search the web',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'The search query' } },
    required: ['query'],
  },
  ...overrides,
});

function makeParams(
  tools: AgentToolSpec[],
  overrides: Partial<{ agentRole: 'assistant' | 'subagent'; allowComplete: boolean }> = {},
): AgentTurnInput {
  return AgentTurnInputSchema.parse({
    prompt: 'do the thing',
    availableTools: tools,
    agentRole: overrides.agentRole ?? 'assistant',
    policy: { allowComplete: overrides.allowComplete ?? true, allowParallel: false },
  });
}

const twoTools = [
  makeTool({ toolId: 'search-1', name: 'Search' }),
  makeTool({
    toolId: 'fetch-1',
    name: 'Fetch',
    operationId: 'api.http.call',
    stepType: 'api',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  }),
];

// ---------------------------------------------------------------------------
// native_fc
// ---------------------------------------------------------------------------

describe('buildToolSurface — native_fc', () => {
  it('mirrors the declarations actually sent (callNames, params) and includes meta', () => {
    const params = makeParams(twoTools, { allowComplete: true });
    const { tools: declarations } = buildFunctionDeclarations(
      params.availableTools,
      { ...params.policy, agentRole: params.agentRole },
      'anthropic',
    );
    const { surface } = buildToolSurface({
      params,
      provider: 'anthropic',
      model: 'claude-test',
      deliveryMode: 'native_fc',
    });

    // Same call names, same order as the emitted declarations.
    expect(surface.active.map((e) => e.callName)).toEqual(declarations.map((d) => d.function.name));
    // present_options + complete are meta (assistant role, allowComplete).
    const meta = surface.active.filter((e) => e.source === 'meta').map((e) => e.callName);
    expect(meta).toEqual(expect.arrayContaining(['present_options', 'complete']));

    // Each real-tool entry carries the EMITTED parameters, verbatim.
    for (const decl of declarations) {
      const entry = surface.active.find((e) => e.callName === decl.function.name);
      expect(entry).toBeDefined();
      expect(entry?.parameters).toEqual(decl.function.parameters);
      expect(entry?.estTokens).toBeGreaterThan(0);
    }
    expect(surface.deliveryMode).toBe('native_fc');
    expect(surface.surfaceBytes).toBeGreaterThan(0);
    expect(surface.surfaceHash).toMatch(/\S/);
  });

  it('tools tokens are additive (native declarations live outside the system prompt)', () => {
    const params = makeParams(twoTools);
    const { toolsTokens } = buildToolSurface({
      params,
      provider: 'anthropic',
      model: 'claude-test',
      deliveryMode: 'native_fc',
    });
    // The generate_json system prompt (with tool section) does NOT drive native
    // accounting — declarations are a separate, additive cost.
    expect(toolsTokens).toBeGreaterThan(0);
  });

  it('surfaces meta functions even with no real tools', () => {
    const params = makeParams([], { allowComplete: true });
    const { surface } = buildToolSurface({
      params,
      provider: 'anthropic',
      model: 'claude-test',
      deliveryMode: 'native_fc',
    });
    expect(surface.active.every((e) => e.source === 'meta')).toBe(true);
    expect(surface.active.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// generate_json — the non-overlap invariant
// ---------------------------------------------------------------------------

describe('buildToolSurface — generate_json', () => {
  it('system + tools reconstructs the full-prompt estimate (no double-count, no gap)', () => {
    const params = makeParams(twoTools);
    const fullPrompt = buildGenerateJsonSystemPrompt(params);
    const { toolsChars, toolsTokens } = buildToolSurface({
      params,
      provider: 'anthropic',
      model: 'claude-test',
      deliveryMode: 'generate_json',
    });

    // The exact partition the executor applies.
    const systemTokens = Math.ceil(
      Math.max(0, fullPrompt.length - toolsChars) / ESTIMATED_CHARS_PER_TOKEN,
    );
    const combined = systemTokens + toolsTokens;
    const wholePrompt = estimateStringTokens(fullPrompt);

    expect(toolsChars).toBeGreaterThan(0);
    // Two disjoint char partitions, each ceil'd — at most ~1 token of rounding slack.
    expect(Math.abs(combined - wholePrompt)).toBeLessThanOrEqual(2);
    // The tool section is a real, non-trivial share of the prompt.
    expect(toolsTokens).toBeGreaterThan(0);
    expect(systemTokens).toBeGreaterThan(0);
  });

  it('renders the tool section byte-identically to the prompt (regression guard)', () => {
    const params = makeParams(twoTools);
    const fullPrompt = buildGenerateJsonSystemPrompt(params);
    for (const tool of params.availableTools) {
      expect(fullPrompt).toContain(renderJsonToolLines(tool).join('\n'));
    }
  });

  it('serializes the input schema compactly, and the schema still round-trips', () => {
    // The tool block is re-sent every turn for every tool, so indentation is
    // paid repeatedly for bytes a JSON parse discards. Guarding the property
    // rather than the exact string: what matters is no pretty-printing and no
    // loss, not a particular serializer.
    const tool = twoTools[0]!;
    const schemaLine = renderJsonToolLines(tool).find((l) => l.startsWith('Input schema: '));
    expect(schemaLine).toBeDefined();
    const json = schemaLine!.slice('Input schema: '.length);
    expect(json).not.toContain('\n');
    expect(JSON.parse(json)).toEqual(tool.inputSchema);
  });

  it('active surface excludes meta (JSON meta actions are prose, counted in system)', () => {
    const params = makeParams(twoTools);
    const { surface } = buildToolSurface({
      params,
      provider: 'anthropic',
      model: 'claude-test',
      deliveryMode: 'generate_json',
    });
    expect(surface.active.every((e) => e.source !== 'meta')).toBe(true);
    expect(surface.active.map((e) => e.toolId)).toEqual(['search-1', 'fetch-1']);
    // JSON mode addresses tools by toolId.
    expect(surface.active[0]?.callName).toBe('search-1');
  });

  it('toolsTokens is a single ceil over toolsChars (composes with system)', () => {
    const params = makeParams(twoTools);
    const { toolsChars, toolsTokens } = buildToolSurface({
      params,
      provider: 'anthropic',
      model: 'claude-test',
      deliveryMode: 'generate_json',
    });
    expect(toolsTokens).toBe(Math.ceil(toolsChars / ESTIMATED_CHARS_PER_TOKEN));
  });
});

// ---------------------------------------------------------------------------
// P2 — orchestrator passthrough (provenance + scope + discoverable)
// ---------------------------------------------------------------------------

describe('buildToolSurface — P2 passthrough', () => {
  it('maps promotion provenance onto entries and echoes scope + discoverable', () => {
    const promoted = makeTool({
      toolId: 'promoted-1',
      name: 'Promoted',
      source: 'discovered',
      discoveredAtTurn: 4,
      lastUsedAtTurn: 6,
    });
    const params = AgentTurnInputSchema.parse({
      prompt: 'x',
      availableTools: [promoted],
      policy: { allowComplete: true, allowParallel: false },
      toolSurfaceContext: {
        scope: { pinnedUsed: 10, pinnedMax: 50, virtualUsed: 1, virtualMax: 20 },
        discoverable: {
          operationIds: ['memory.store.query'],
          operationCount: 1,
          apiBindingCount: 2,
          mcpServerCount: 3,
        },
      },
    });
    const { surface } = buildToolSurface({
      params,
      provider: 'anthropic',
      model: 'claude-test',
      deliveryMode: 'generate_json',
    });

    const entry = surface.active.find((e) => e.toolId === 'promoted-1');
    expect(entry?.source).toBe('discovered');
    expect(entry?.discoveredAtTurn).toBe(4);
    expect(entry?.lastUsedAtTurn).toBe(6);
    expect(surface.scope).toEqual({
      pinnedUsed: 10,
      pinnedMax: 50,
      virtualUsed: 1,
      virtualMax: 20,
    });
    expect(surface.discoverable?.operationIds).toEqual(['memory.store.query']);
    expect(surface.discoverable?.apiBindingCount).toBe(2);
    expect(surface.discoverable?.mcpServerCount).toBe(3);
  });

  it('omits scope/discoverable when the orchestrator passed no context', () => {
    const params = makeParams(twoTools);
    const { surface } = buildToolSurface({
      params,
      provider: 'anthropic',
      model: 'claude-test',
      deliveryMode: 'native_fc',
    });
    expect(surface.scope).toBeUndefined();
    expect(surface.discoverable).toBeUndefined();
    // Non-promoted tools carry no provenance.
    expect(surface.active.every((e) => e.discoveredAtTurn === undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Payload-size gate — representative + worst-case surfaces
// ---------------------------------------------------------------------------

describe('buildToolSurface — payload size', () => {
  const bigSchema = (): Record<string, unknown> => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 30; i++) {
      properties[`field_${i}`] = {
        type: 'string',
        description: `A reasonably verbose description for field ${i} so the schema is realistic.`,
      };
    }
    return { type: 'object', properties, required: ['field_0'] };
  };

  it('a worst-case 50-tool surface stays within a sane payload budget', () => {
    const tools = Array.from({ length: 50 }, (_, i) =>
      makeTool({ toolId: `mcp-tool-${i}`, name: `Tool ${i}`, inputSchema: bigSchema() }),
    );
    const params = makeParams(tools);
    const { surface } = buildToolSurface({
      params,
      provider: 'anthropic',
      model: 'claude-test',
      deliveryMode: 'native_fc',
    });
    const payloadBytes = JSON.stringify(surface).length;
    // These serialized schemas already cross the wire; the surface just records
    // them into the payload-store-backed chat-history payload. Guardrail: keep
    // this pathological case (50 tools × 30 verbose fields, ≈190KB measured)
    // under 256KB so the payload + inspector stay responsive. Representative
    // surfaces (≈10 tools) measure ≈40KB.
    expect(payloadBytes).toBeLessThan(256 * 1024);
    expect(surface.surfaceBytes).toBeGreaterThan(0);
  });
});
