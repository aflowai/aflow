/**
 * AI operation input schemas (Zod).
 * Single source of truth for input validation.
 */
import { z } from 'zod';
import {
  AiToolResultEnvelopeV1Schema,
  AgentToolSpecSchema,
  ActiveMemoryInjectionSchema,
  ToolSurfaceContextSchema,
  RoomExchangeEntrySchema,
  RoomSpeakerSchema,
} from '@aflow/schemas';

function nonEmptyPromptSchema() {
  return z.string().refine((value) => value.trim().length > 0, {
    message: 'Prompt cannot be empty',
  });
}

// ============================================================================
// Shared message shape for generate/generateStream
// ============================================================================

const messageShape = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  name: z.string().optional(),
  toolCallId: z.string().optional(),
  toolCalls: z
    .array(
      z.object({
        id: z.string(),
        type: z.literal('function'),
        function: z.object({
          name: z.string(),
          arguments: z.string(),
        }),
      }),
    )
    .optional(),
});

// ============================================================================
// ai.text.generate / ai.text.generate_stream
// ============================================================================

const aiGenerateBaseSchema = z.object({
  systemPrompt: z.string().optional(),
  prompt: nonEmptyPromptSchema().optional(),
  messages: z.array(messageShape).optional(),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  stopSequences: z.array(z.string()).optional(),
  tools: z
    .array(
      z.object({
        type: z.literal('function'),
        function: z.object({
          name: z.string(),
          description: z.string().optional(),
          parameters: z.record(z.unknown()),
        }),
      }),
    )
    .optional(),
  toolChoice: z
    .union([
      z.literal('auto'),
      z.literal('none'),
      z.literal('required'),
      z.object({
        type: z.literal('function'),
        function: z.object({ name: z.string() }),
      }),
    ])
    .optional(),
  historyRef: z.string().optional(),
});

function requireContent<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  return schema.refine(
    (d) =>
      d['prompt'] || (d['messages'] && (d['messages'] as unknown[]).length > 0) || d['historyRef'],
    { message: 'At least one of prompt, messages, or historyRef is required' },
  );
}

export const AiGenerateInputSchema = requireContent(aiGenerateBaseSchema);
export type AiGenerateInput = z.infer<typeof AiGenerateInputSchema>;

export const AiGenerateJsonInputSchema = requireContent(
  aiGenerateBaseSchema.extend({
    outputSchema: z.record(z.unknown()),
    schemaName: z.string().optional(),
  }),
);
export type AiGenerateJsonInput = z.infer<typeof AiGenerateJsonInputSchema>;

export const AiGenerateStreamInputSchema = AiGenerateInputSchema;
export type AiGenerateStreamInput = z.infer<typeof AiGenerateStreamInputSchema>;

// ============================================================================
// ai.embedding.generate
// ============================================================================

export const AiEmbedInputSchema = z.object({
  text: z.union([z.string(), z.array(z.string())]),
  model: z.string().optional(),
  dimensions: z.number().int().positive().optional(),
});
export type AiEmbedInput = z.infer<typeof AiEmbedInputSchema>;

// ============================================================================
// ai.agent.turn
// ============================================================================

export const AgentTurnInputSchema = z.object({
  agentRole: z.enum(['assistant', 'subagent']).default('assistant'),
  requestInputPolicy: z.enum(['allowed', 'blocked_only', 'never']).optional(),
  completionPolicy: z.enum(['open_ended', 'allowed', 'must_complete_or_block']).optional(),
  finalOutputSchema: z.record(z.unknown()).optional(),
  completionPrompt: z.string().max(4000).optional(),
  systemPrompt: z.string().optional(),
  prompt: nonEmptyPromptSchema(),
  // Use the shared AgentToolSpecSchema to prevent drift (was a local copy that
  availableTools: z.array(AgentToolSpecSchema),
  // Orchestrator-resolved cap pressure + discoverable tier. MUST be declared
  // here too — this local schema parses the wire input, and Zod strips unknown
  // keys, so a shared-schema-only field would be silently dropped.
  toolSurfaceContext: ToolSurfaceContextSchema.optional(),
  conversationStateRef: z.string().optional(),
  contextProfile: z.enum(['minimal', 'default', 'detailed', 'debug']).optional().default('default'),
  newUserInput: z
    .object({
      userInputId: z.string(),
      text: nonEmptyPromptSchema(),
      createdAtMs: z.number(),
      /** Who said it, when a person did. Absent for scheduled and API triggers. */
      author: RoomSpeakerSchema.optional(),
    })
    .optional(),
  /**
   * What people said in the room since the agent last read it.
   *
   * Separate from `newUserInput` because a room is several people, not one:
   * each entry keeps its own author, and the store drops the ones it has
   * already seen — so the recent window can be handed over every turn and
   * each message still lands exactly once.
   */
  newRoomMessages: z.array(RoomExchangeEntrySchema).optional(),
  newToolResults: z.array(AiToolResultEnvelopeV1Schema).optional(),
  activeMemoryInjection: ActiveMemoryInjectionSchema.optional(),
  contextBlocks: z
    .array(
      z.object({
        key: z.string(),
        content: z.unknown(),
        cacheHint: z.enum(['stable', 'run_stable', 'volatile']).optional(),
      }),
    )
    .optional(),
  policy: z
    .object({
      maxToolCallsPerTurn: z.number().default(5),
      allowParallel: z.boolean().default(false),
      maxParallel: z.number().default(5),
      allowComplete: z.boolean().default(true),
      budgetHints: z
        .object({
          maxTotalTurns: z.number().optional(),
          maxTotalToolCalls: z.number().optional(),
          maxTotalTokens: z.number().optional(),
        })
        .optional(),
    })
    .default({}),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().max(128_000).optional(),
  /**
   * Per-call reasoning effort override. Resolution order at the call site:
   * `reasoningEffort` (this field) → catalog model default → provider default.
   * Populated by the orchestrator from the space's `reasoningDefaults` for the
   * caller's role (helmsman / runner / coach / judge).
   */
  reasoningEffort: z.enum(['off', 'low', 'medium', 'high']).optional(),
  /**
   * Provider-native reasoning continuity mode (Plan 259). Resolved from the
   * step config. `off` (default) keeps only the wire-minimal reasoning needed
   * for the active tool-use exchange; `tool_loop` retains native reasoning
   * across the current assistant tool-use turn; `conversation` is reserved
   * (capability-gated; unsupported modes fail loud before any provider call).
   */
  reasoningContinuity: z.enum(['auto', 'off', 'tool_loop', 'conversation']).optional(),
  turnNumber: z.number().default(0),
  totalToolCallsSoFar: z.number().default(0),
  flowName: z.string().optional(),
  flowDescription: z.string().optional(),
  /** Whether voice mode is active — enables voiceMessage field on meta-functions */
  voiceMode: z.boolean().optional(),
  turnTimestamp: z.string().optional(),
  lastTurnCompletedAtMs: z.number().optional(),
  contextWindowOverride: z.number().int().positive().optional(),
  summaryTemplate: z
    .object({
      sections: z
        .array(
          z.object({
            heading: z.string(),
            prompt: z.string(),
            required: z.boolean().default(true),
          }),
        )
        .optional(),
      emphasisInstructions: z.string().optional(),
      maxTokens: z.number().int().min(200).max(4000).default(1500),
    })
    .optional(),
});
export type AgentTurnInput = z.infer<typeof AgentTurnInputSchema>;

// The ai.media.* input schemas live in @aflow/schemas — the registry
// validates against them at authoring time, so a local copy would let a step
// pass authoring and fail at dispatch.
