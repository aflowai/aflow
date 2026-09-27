/**
 * AI Prompt V1 Schemas — Conversation State + Provider-Agnostic Messages
 *
 * This module defines the conversation architecture where:
 * - The executor is the canonical author of "what the model saw"
 * - Conversation state is diff-friendly (refs + hashes + append-only atoms)
 * - Model messages are stored directly in step output for UI display
 *
 * See: docs/plans/aflow/handoff-agent-history-architecture.md
 */
import { z } from 'zod';
import { AgentToolErrorSchema } from './errors.js';

// ============================================================================
// AI Roles
// ============================================================================

export const AiRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type AiRole = z.infer<typeof AiRoleSchema>;

// ============================================================================
// Content Parts (provider-agnostic)
// ============================================================================

/** Text content part */
export const AiTextPartSchema = z.object({
  kind: z.literal('text'),
  text: z.string(),
});
export type AiTextPart = z.infer<typeof AiTextPartSchema>;

/** Small structured JSON content part */
export const AiJsonPartSchema = z.object({
  kind: z.literal('json'),
  json: z.unknown(),
});
export type AiJsonPart = z.infer<typeof AiJsonPartSchema>;

/** Reference to a large payload stored externally */
export const AiRefPartSchema = z.object({
  kind: z.literal('ref'),
  /** PayloadRef string (e.g., inline:..., gs://...) */
  ref: z.string(),
  /** MIME type of the referenced content */
  contentType: z.string().optional(),
  /** Size of the referenced content in bytes */
  sizeBytes: z.number().int().nonnegative().optional(),
  /** Short human/model readable summary */
  summary: z.string().optional(),
  /** Hint for the UI on how to display the reference */
  displayHint: z.enum(['inline', 'link']).optional(),
});
export type AiRefPart = z.infer<typeof AiRefPartSchema>;

export const AiContentPartSchema = z.discriminatedUnion('kind', [
  AiTextPartSchema,
  AiJsonPartSchema,
  AiRefPartSchema,
]);
export type AiContentPart = z.infer<typeof AiContentPartSchema>;

// ============================================================================
// Tool Call (provider-agnostic, used in assistant messages)
// ============================================================================

export const AiToolCallV1Schema = z.object({
  /** Unique ID for this tool call (deterministic: compactStepExecId_N, ≤40 chars for OpenAI) */
  toolCallId: z.string(),
  /** Tool/function name (operationId or step-scoped tool name) */
  name: z.string(),
  /** Parsed arguments object (not raw JSON string) */
  argumentsJson: z.unknown(),
  /** Gemini 3 thought signature — must survive round-trip for function calling validation. */
  thoughtSignature: z.string().optional(),
});
export type AiToolCallV1 = z.infer<typeof AiToolCallV1Schema>;

// ============================================================================
// Provider-Native Reasoning (inline continuity artifact — Plan 259)
// ============================================================================

/** Providers whose native reasoning Phoenix retains and replays inline on the atom. */
export const AiReasoningProviderSchema = z.enum([
  'anthropic',
  'google',
  'fireworks',
  'openrouter',
  'xai',
]);
export type AiReasoningProvider = z.infer<typeof AiReasoningProviderSchema>;

/**
 * Provider-native reasoning captured from one assistant turn, retained so the
 * model can continue its reasoning across the tool-use exchange instead of
 * re-deriving it. Stored inline on the assistant atom (like `thoughtSignature`),
 * so it rides the existing PayloadStore-ref'd atom batches — never Redis hot state.
 *
 * `blocks` are opaque outside the owning provider adapter's codec (Anthropic
 * thinking/redacted_thinking blocks, Gemini signed thought parts, Fireworks
 * `reasoning_content`, xAI Responses reasoning items including `encrypted_content`).
 * Bound to `provider`+`model`: reset, never cross-replayed, when the resolved
 * provider/model changes.
 */
export const AiProviderReasoningV1Schema = z.object({
  provider: AiReasoningProviderSchema,
  model: z.string(),
  blocks: z.array(z.unknown()),
});
export type AiProviderReasoningV1 = z.infer<typeof AiProviderReasoningV1Schema>;

// ============================================================================
// Tool Result Envelope (rich, rubric-driven)
// ============================================================================

/**
 * Structured tool result with full rubric metadata.
 * Embedded in tool-role messages to give the agent maximum context about
 * what happened and what it should do next.
 */
export const MAX_NEXT_STEPS = 3;

export const MAX_ATOMS_STRUCTURAL = 200;

export const AiToolResultEnvelopeV1Schema = z.object({
  kind: z.literal('tool_result'),
  /** References the tool call this is responding to */
  toolCallId: z.string(),
  /** Resolved tool name / operationId */
  toolName: z.string(),
  operationId: z.string().optional(),
  /** Flow stepId that executed */
  stepId: z.string().optional(),
  /** StepExecutionId for traceability */
  stepExecutionId: z.string().optional(),
  /** Execution status */
  status: z.enum(['SUCCEEDED', 'FAILED', 'PAUSED']),
  /** Execution duration in milliseconds */
  durationMs: z.number().int().nonnegative().optional(),
  /** Wall-clock completion time (epoch ms) — lets the agent reason about timing without a synthetic user message */
  completedAtMs: z.number().int().nonnegative().optional(),
  /** PayloadRef where raw output is stored */
  outputRef: z.string().optional(),
  outputPath: z.string().optional(),
  /** Available output field paths for virtual-path reads (e.g., 'data', 'outputFiles/train.csv') */
  outputFields: z.array(z.string()).optional(),
  /** PayloadRef where error is stored */
  errorRef: z.string().optional(),
  /** State variables written by this tool */
  wroteVariables: z
    .array(
      z.object({
        variableKey: z.string(),
        ref: z.string().optional(),
        summary: z.string().optional(),
        displayedToUser: z.boolean().optional(),
      }),
    )
    .optional(),
  /** Whether the output was displayed to the user */
  displayedToUser: z.boolean().optional(),
  /** Guidance hints for the agent on what to do next */
  nextExpectedFromAgent: z
    .array(
      z.object({
        action: z.enum(['invoke_step', 'pause_for_input', 'complete', 'retry']),
        note: z.string().optional(),
      }),
    )
    .optional(),
  /** Short summary for the model (bounded text) — omitted for FAILED results, use `error` instead */
  summary: z.string().max(16000).optional(),
  error: AgentToolErrorSchema.optional(),
  nextSteps: z
    .array(
      z.object({
        action: z.string(),
        note: z.string(),
      }),
    )
    .max(MAX_NEXT_STEPS)
    .optional(),
});
export type AiToolResultEnvelopeV1 = z.infer<typeof AiToolResultEnvelopeV1Schema>;

// ============================================================================
// Normalized Message V1 (provider-agnostic)
// ============================================================================

/**
 * A single message in the provider-agnostic format.
 * Used in conversation state atoms and step output.
 */
export const AiMessageV1Schema = z.object({
  /** Message role */
  role: AiRoleSchema,
  /** For tool-role messages: which tool call this responds to */
  toolCallId: z.string().optional(),
  /** Optional name (e.g., tool name for tool-role messages) */
  name: z.string().optional(),
  /** Content parts (text, json, ref) */
  parts: z.array(AiContentPartSchema),
  /** Tool calls made by the assistant (present only on assistant messages that invoke tools) */
  toolCalls: z.array(AiToolCallV1Schema).optional(),
  /**
   * Provider-native reasoning for this assistant turn, retained for tool-use
   * continuity (Plan 259). Present only on assistant messages and only when the
   * resolved model produced replayable reasoning under a non-`off` continuity mode.
   */
  providerReasoning: AiProviderReasoningV1Schema.optional(),
});
export type AiMessageV1 = z.infer<typeof AiMessageV1Schema>;

// ============================================================================
// Message Atom V1 (append-only unit in conversation state)
// ============================================================================

/**
 * An atomic message unit stored in the conversation state.
 * Each atom has a stable sourceId for idempotent append.
 */
export const AiMessageAtomV1Schema = z.object({
  schemaVersion: z.literal(1).default(1),
  /** Unique atom ID (UUID) */
  atomId: z.string(),
  /** Message role (denormalized for quick filtering) */
  role: AiRoleSchema,
  /** Stable idempotency key for this atom */
  sourceId: z.string(),
  /** Classification of the source */
  sourceKind: z.enum([
    'user_input',
    'assistant_turn',
    'tool_result',
    'cleared_summary',
    'compaction_restore',
  ]),
  /** The actual message content */
  message: AiMessageV1Schema,
  /** Creation timestamp (epoch ms) */
  createdAtMs: z.number(),
  turnNumber: z.number().int().nonnegative().optional(),
});
export type AiMessageAtomV1 = z.infer<typeof AiMessageAtomV1Schema>;

// ============================================================================
// Context Block (stored once per version, referenced by hash)
// ============================================================================

export const AiContextBlockRefSchema = z.object({
  /** PayloadRef to the context block content */
  ref: z.string(),
  /** Content hash for change detection */
  hash: z.string(),
  /** Size in bytes (for budget estimation) */
  sizeBytes: z.number().int().nonnegative().optional(),
  /** MIME type hint */
  contentType: z.string().optional(),
});
export type AiContextBlockRef = z.infer<typeof AiContextBlockRefSchema>;

// ============================================================================

export const AiClearedToolCallV1Schema = z.object({
  /** Exchange key (compact-id base `S`) the call belonged to */
  exchangeKey: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  /** `computeToolCallArgsHash(toolName, argumentsJson)` — absent when the producer atom was already gone */
  argsHash: z.string().optional(),
  /** When the exchange was cleared — detection matches only calls newer than this */
  clearedAtMs: z.number(),
});
export type AiClearedToolCallV1 = z.infer<typeof AiClearedToolCallV1Schema>;

export const AiClearingStateV1Schema = z.object({
  /** Archive lineage — one immutable range snapshot per clearing cycle. */
  ranges: z
    .array(
      z.object({
        fromTurn: z.number().int().nonnegative(),
        toTurn: z.number().int().nonnegative(),
        /** PayloadRef to only the atoms in this range (not the full array). */
        rawAtomsRef: z.string(),
        clearedAt: z.number(),
      }),
    )
    .default([]),
  /**
   * Compact-id base keys (`S`) of exchanges already cleared (idempotency
   * guard). An exchange whose key is here is never re-archived.
   */
  clearedExchanges: z.array(z.string()).default([]),
  clearedCalls: z.array(AiClearedToolCallV1Schema).default([]),
  /**
   * Exchange keys the model proved it needs again (re-executed or re-fetched
   * cleared content, §4.6) — protection class 5, last to clear. Also the
   * counter-dedup ledger: a key here is never re-counted.
   */
  resurrectedExchanges: z.array(z.string()).default([]),
});
export type AiClearingStateV1 = z.infer<typeof AiClearingStateV1Schema>;

// ============================================================================
// Conversation State V1 (diff-friendly, minimal)
// ============================================================================

/**
 * Compact conversation state that tracks refs/hashes/atoms without
 * storing repeated full message text. The executor loads this, appends
 * new atoms, and stores an updated version after each turn.
 */
export const AiConversationStateV1Schema = z.object({
  schemaVersion: z.literal(1).default(1),
  /** Stable conversation ID (tenantId:runId:stepId) */
  conversationId: z.string(),
  /** Next turn number to execute */
  turnNumber: z.number().int().nonnegative(),

  // -- Stable blocks (stored once, referenced by ref + hash) --

  /** PayloadRef to the current system instruction text */
  systemRef: z.string().optional(),
  /** Hash of the system instruction for change detection */
  systemHash: z.string().optional(),

  // -- Context blocks (keyed, change-detected via hash) --

  /** Context blocks keyed by label (e.g., 'DiscoverableTools') */
  context: z.record(AiContextBlockRefSchema).default({}),

  history: z
    .object({
      /** Ordered list of message atom references */
      atoms: z
        .array(
          z.object({
            /** Atom UUID */
            atomId: z.string(),
            /** PayloadRef to the AiMessageAtomV1 */
            ref: z.string(),
            /** Denormalized role for quick filtering */
            role: AiRoleSchema,
            sourceKind: z
              .enum([
                'user_input',
                'assistant_turn',
                'tool_result',
                'cleared_summary',
                'compaction_restore',
              ])
              .optional(),
            /** Content hash for dedup/diffing */
            hash: z.string(),
            /** Creation timestamp */
            createdAtMs: z.number(),
            turnNumber: z.number().int().nonnegative().optional(),
          }),
        )
        .default([]),
      maxAtomsStructural: z.number().int().positive().default(MAX_ATOMS_STRUCTURAL),
    })
    .default({ atoms: [], maxAtomsStructural: MAX_ATOMS_STRUCTURAL }),

  clearing: AiClearingStateV1Schema.optional(),

  /** Tracks progressive summarization compaction cycles. */
  compaction: z
    .object({
      /** PayloadRef to the current CompactionArtifact. */
      artifactRef: z.string().optional(),
      /** Number of compaction cycles performed so far. */
      count: z.number().int().nonnegative().default(0),
      /** Highest turn number that has been compacted (watermark for idempotency). */
      lastCompactedTurn: z.number().int().nonnegative().optional(),
    })
    .optional(),

  // -- Idempotency tracking --

  /** Set of sourceIds already appended (prevents accidental duplicates) */
  seenSourceIds: z.record(z.literal(true)).default({}),
});
export type AiConversationStateV1 = z.infer<typeof AiConversationStateV1Schema>;

// ============================================================================

/**
 * Typed, machine-readable block extracted deterministically from conversation atoms.
 * No LLM involved — every field has an explicit source-of-truth available in the executor.
 */
export const PinnedStateSchema = z.object({
  /** Current task objective (from flow config goal or first user message). */
  objective: z.string().optional(),
  /** Active sub-goal (from last assistant decision's message field). */
  activeSubGoal: z.string().optional(),
  /** Active $ref paths — extracted from wroteVariables/outputRef in tool_result atoms. */
  activeRefs: z
    .array(
      z.object({
        ref: z.string(),
        description: z.string(),
        fromTurn: z.number().int(),
      }),
    )
    .optional(),
  /** State variables written — from wroteVariables in tool_result atoms. */
  writtenVariables: z
    .array(
      z.object({
        variableKey: z.string(),
        ref: z.string().optional(),
        summary: z.string().optional(),
      }),
    )
    .optional(),
});
export type PinnedState = z.infer<typeof PinnedStateSchema>;

// ============================================================================

/**
 * Customizable section template for the LLM summarizer.
 * Different flows need different reflection emphasis.
 */
export const SummaryTemplateSectionSchema = z.object({
  heading: z.string(),
  prompt: z.string(),
  required: z.boolean().default(true),
});

export const DEFAULT_SUMMARY_SECTIONS: Array<{
  heading: string;
  prompt: string;
  required: boolean;
}> = [
  {
    heading: 'What Was Accomplished',
    prompt:
      'List concrete outcomes with specific values/metrics. Include operation names and data sizes.',
    required: true,
  },
  {
    heading: 'Current Focus',
    prompt: 'What is the agent actively working on right now? What was the last action taken?',
    required: true,
  },
  {
    heading: 'Final Objective',
    prompt: 'What is the end goal? What does success look like?',
    required: true,
  },
  {
    heading: 'Mistakes & Lessons Learned',
    prompt:
      'What failed and why? What workarounds were discovered? Be specific — include error messages and parameter values that caused issues.',
    required: true,
  },
  {
    heading: 'Perplexing / Unresolved',
    prompt:
      'Anything confusing, contradictory, or unexplained that the agent should investigate further.',
    required: false,
  },
];

export const SummaryTemplateSchema = z.object({
  sections: z.array(SummaryTemplateSectionSchema).default(DEFAULT_SUMMARY_SECTIONS),
  /** Additional emphasis instructions appended to the summarizer prompt. */
  emphasisInstructions: z.string().optional(),
  /** Max tokens for the summary output. */
  maxTokens: z.number().int().min(200).max(4000).default(1500),
});
export type SummaryTemplate = z.infer<typeof SummaryTemplateSchema>;

// ============================================================================

/**
 * Immutable compaction artifact stored in PayloadStore (kind='state').
 * Each compaction cycle produces one artifact with a parent chain for lineage.
 */
export const CompactionArtifactSchema = z.object({
  version: z.literal(1),
  pinnedState: PinnedStateSchema,
  summaryMarkdown: z.string(),
  compressedTurnRange: z.tuple([z.number().int(), z.number().int()]),
  /** PayloadRef to ONLY the atoms in this compacted range. */
  rawAtomsRef: z.string(),
  /** Pointer to previous compaction artifact (for lineage). */
  parentArtifactRef: z.string().optional(),
  summaryModel: z.string(),
  summaryInputTokens: z.number().int(),
  summaryOutputTokens: z.number().int(),
  generatedAt: z.number(),
  /** Monotonically increasing: 1, 2, 3... for audit trail. */
  compactionNumber: z.number().int(),
});
export type CompactionArtifact = z.infer<typeof CompactionArtifactSchema>;

// ============================================================================

/**
 * Lightweight metadata stamped on assistant_turn atoms for pinned-state extraction.
 * The executor has this data at record time — storing it avoids needing orchestrator
 * hot state access during compaction.
 */
export const TurnMetadataSchema = z
  .object({
    turnNumber: z.number().int(),
    objective: z.string().optional(),
    toolCallCount: z.number().int().optional(),
    decision: z.enum(['invoke_step', 'invoke_steps', 'pause_for_input', 'complete']).optional(),
  })
  .optional();
export type TurnMetadata = z.infer<typeof TurnMetadataSchema>;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create a text-only AiMessageV1.
 */
export function textMessage(role: AiRole, text: string): AiMessageV1 {
  return { role, parts: [{ kind: 'text', text }] };
}

/**
 * Create an assistant message with tool calls.
 */
export function assistantToolCallMessage(toolCalls: AiToolCallV1[], text?: string): AiMessageV1 {
  return {
    role: 'assistant',
    parts: text ? [{ kind: 'text', text }] : [],
    toolCalls,
  };
}

/**
 * Create a tool result message from an envelope.
 */
export function toolResultMessage(envelope: AiToolResultEnvelopeV1): AiMessageV1 {
  return {
    role: 'tool',
    toolCallId: envelope.toolCallId,
    name: envelope.toolName,
    parts: [{ kind: 'json', json: envelope }],
  };
}

/** Deterministic JSON with recursively sorted object keys — array order preserved. */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const pairs = Object.keys(record)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`);
  return `{${pairs.join(',')}}`;
}

export function computeToolCallArgsHash(toolName: string, argumentsJson: unknown): string {
  return contentHash(`${toolName}:${stableStringify(argumentsJson)}`);
}

/**
 * Compute a fast content hash for dedup/diffing.
 * Uses a simple DJB2-like hash (no crypto dependency needed).
 */
export function contentHash(content: string): string {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0;
  }
  // Convert to unsigned 32-bit hex

  return (hash >>> 0).toString(16).padStart(8, '0');
}
