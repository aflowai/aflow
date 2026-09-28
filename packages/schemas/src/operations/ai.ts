/**
 * AI step operation schemas.
 *
 * All AI operations that interact with LLMs or embedding models.
 */
import { z } from 'zod';
import {
  AgentTurnInputSchema,
  AgentTurnOutputSchema,
  AgentStepConfigSchema,
} from '../runtime/agentTurn.js';
import { HistoryPolicySchema } from '../runtime/aiHistory.js';
import { AiMediaOutputSchema, PinnedMemoryRefSchema } from '../media/asset.js';
import type { OperationRegistration } from '../catalog/operationCatalog.js';
import { TokenUsageSchema } from './aiUsage.js';
import { AiDecideInputSchema, AiDecideOutputSchema } from './aiDecision.js';

// Import enum constants and helper (defined in a separate file to avoid circular deps)
import {
  TEXT_MODELS,
  EMBEDDING_MODELS,
  IMAGE_MODELS,
  VIDEO_MODELS,
  ASPECT_RATIOS,
  IMAGE_SIZES,
  VIDEO_RESOLUTIONS,
  IMAGE_REFERENCE_ROLES,
  MAX_IMAGE_REFERENCES_PER_ROLE,
  MAX_VIDEO_REFERENCES_PER_ROLE,
  maxReferences,
  enumWithCustom,
  type ImageReferenceRole,
} from './enums.js';

// Re-export for downstream consumers
export {
  TEXT_MODELS,
  EMBEDDING_MODELS,
  DECISION_MODELS,
  IMAGE_MODELS,
  VIDEO_MODELS,
  ASPECT_RATIOS,
  IMAGE_SIZES,
  VIDEO_RESOLUTIONS,
  IMAGE_REFERENCE_ROLES,
  MAX_IMAGE_REFERENCES,
  MAX_IMAGE_REFERENCES_PER_ROLE,
  MEDIA_BINDING_ROLES,
  enumWithCustom,
} from './enums.js';
export type { ImageReferenceRole, MediaBindingRole } from './enums.js';

// ============================================================================
// Shared Types
// ============================================================================

/**
 * Chat message roles.
 */
export const ChatMessageRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type ChatMessageRole = z.infer<typeof ChatMessageRoleSchema>;

/**
 * Chat message (matches ai-client ChatMessage).
 */
export const ChatMessageSchema = z.object({
  role: ChatMessageRoleSchema,
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
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/**
 * Token usage.
 */
export { TokenUsageSchema, type TokenUsage } from './aiUsage.js';

/**
 * Tool definition for function calling.
 */
export const ToolDefinitionSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().max(64),
    description: z.string().max(1000).optional(),
    parameters: z.record(z.unknown()),
  }),
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

function nonEmptyPromptSchema(max: number, description: string) {
  return z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0, {
      message: 'Prompt cannot be empty',
    })
    .describe(description);
}

// ============================================================================
// ai.generate - Text Generation
// ============================================================================

export const AiGenerateInputSchema = z.object({
  messages: z.array(ChatMessageSchema).min(1).describe('Conversation messages').optional(),
  systemPrompt: z.string().max(100_000).describe("Instructions for the AI's behavior").optional(),
  prompt: nonEmptyPromptSchema(100_000, 'Your text prompt').optional(),
  model: enumWithCustom(TEXT_MODELS).describe('AI model to use').optional(),
  temperature: z
    .number()
    .min(0)
    .max(2)
    .describe('Creativity level (0 = precise, 2 = creative)')
    .optional(),
  maxTokens: z
    .number()
    .int()
    .positive()
    .max(128_000)
    .describe('Maximum length of the response')
    .optional(),
  stopSequences: z
    .array(z.string().max(128))
    .max(4)
    .describe('Text patterns that stop generation')
    .optional(),
  tools: z.array(ToolDefinitionSchema).describe('Tools available for function calling').optional(),
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
    .describe('Which tool to call (auto, none, required, or specific)')
    .optional(),
  historyRef: z.string().describe('Reference to conversation history').optional(),
  historyPolicy: HistoryPolicySchema.describe('How to manage conversation history').optional(),
});
export type AiGenerateInput = z.infer<typeof AiGenerateInputSchema>;

export const AiGenerateOutputSchema = z.object({
  /** Generated content */
  content: z.string(),
  /** Token usage */
  usage: TokenUsageSchema,
  /** Model used */
  model: z.string(),
  /** Finish reason */
  finishReason: z.enum(['stop', 'length', 'content_filter', 'tool_calls', 'error']),
  /** Tool calls if function calling was used */
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
export type AiGenerateOutput = z.infer<typeof AiGenerateOutputSchema>;

// ============================================================================
// ai.text.generate_json - Structured JSON Output
// ============================================================================

export const AiGenerateJsonInputSchema = AiGenerateInputSchema.extend({
  outputSchema: z
    .record(z.unknown())
    .describe('JSON Schema defining the expected output structure'),
  schemaName: z.string().max(64).describe('Name for the output schema').optional(),
});
export type AiGenerateJsonInput = z.infer<typeof AiGenerateJsonInputSchema>;

export const AiGenerateJsonOutputSchema = z.object({
  /** Parsed structured data */
  content: z.unknown(),
  /** Raw response content */
  rawContent: z.string().optional(),
  /** Token usage */
  usage: TokenUsageSchema,
  /** Model used */
  model: z.string(),
  /** Finish reason */
  finishReason: z.enum(['stop', 'length', 'content_filter', 'error']),
});
export type AiGenerateJsonOutput = z.infer<typeof AiGenerateJsonOutputSchema>;

// ============================================================================
// ai.embed - Embedding Generation
// ============================================================================

export const AiEmbedInputSchema = z.object({
  text: z
    .union([z.string().max(32_000), z.array(z.string().max(32_000)).max(2048)])
    .describe('Text to generate embeddings for'),
  model: enumWithCustom(EMBEDDING_MODELS).describe('AI model to use').optional(),
  dimensions: z
    .number()
    .int()
    .positive()
    .max(3072)
    .describe('Embedding vector dimensions')
    .optional(),
});
export type AiEmbedInput = z.infer<typeof AiEmbedInputSchema>;

export const AiEmbedOutputSchema = z.object({
  /** Generated embeddings (array of vectors) */
  embeddings: z.array(z.array(z.number())),
  /** Model used */
  model: z.string(),
  /** Embedding dimensions */
  dimensions: z.number().int().positive(),
  /** Token usage */
  usage: z.object({
    totalTokens: z.number().int().nonnegative(),
  }),
});
export type AiEmbedOutput = z.infer<typeof AiEmbedOutputSchema>;

// ============================================================================
// ai.text.generate_stream - Streaming Text Generation
// ============================================================================

export const AiGenerateStreamInputSchema = AiGenerateInputSchema;
export type AiGenerateStreamInput = z.infer<typeof AiGenerateStreamInputSchema>;

export const AiGenerateStreamOutputSchema = z.object({
  /** Final assembled content */
  content: z.string(),
  /** Payload ref to NDJSON stream chunks (kind: "logs") */
  streamRef: z.string().optional(),
  /** Payload ref to stream summary (kind: "output") */
  summaryRef: z.string().optional(),
  /** Number of chunks */
  chunkCount: z.number().int().nonnegative(),
  /** Token usage */
  usage: TokenUsageSchema,
  /** Model used */
  model: z.string(),
  /** Finish reason */
  finishReason: z.enum(['stop', 'length', 'content_filter', 'tool_calls', 'error']),
  /** Tool calls if function calling was used */
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
export type AiGenerateStreamOutput = z.infer<typeof AiGenerateStreamOutputSchema>;

// ============================================================================
// Media source references
// ============================================================================

const SOURCE_REF_HINT =
  'Pass the pinned memory reference a media step returns — an entry of its `assets`, carrying ' +
  'path, version and contentHash — or a PayloadRef of stored bytes. For a document no render ' +
  "just produced, read its pin with memory.store.get({ target: { path }, view: 'stat' }). A bare " +
  'path is not a form here, and a version that no longer exists or a hash that disagrees fails ' +
  'the step rather than rendering from whatever the path now holds.';

/**
 * Where a media operation reads an input image from.
 *
 * The pinned form is exactly what every media operation returns, so an asset
 * out of one render is the input of the next without translation. A bare path
 * is deliberately not a form: the render's receipt states which version of
 * which document it read, and a path resolves to whatever it holds at the
 * moment of reading, which would make that statement unprovable.
 */
export const MediaSourceRefSchema = z
  .union([
    PinnedMemoryRefSchema,
    z
      .string()
      .min(1)
      .describe(
        'PayloadRef of stored image bytes — a platform handle a workflow step is wired to, which ' +
          'an agent has no way to mint.',
      ),
  ])
  .describe(SOURCE_REF_HINT);
export type MediaSourceRef = z.infer<typeof MediaSourceRefSchema>;

// ============================================================================
// ai.image.generate - Image Generation
// ============================================================================

export const ImageReferenceSchema = z.object({
  ref: MediaSourceRefSchema,
  role: z
    .enum(IMAGE_REFERENCE_ROLES)
    .describe(
      'What the model takes from this image. `character` pins identity — face, build, wardrobe — so the same person recurs across shots. `style` pins palette, lighting, and rendering. The provider conditions on the two differently, so a style plate sent as a character reference bleeds its subject into the result.',
    ),
  label: z
    .string()
    .max(120)
    .describe('Name the prompt uses for this reference, sent to the model alongside the image')
    .optional(),
});
export type ImageReference = z.infer<typeof ImageReferenceSchema>;

/**
 * The roles a medium's routes actually read. A role no route of that medium
 * conditions on is not an option a caller should be offered: offering it costs
 * every agent the words explaining it, and the request it produces is refused
 * for a count it never chose.
 */
function referenceRolesFor(
  limits: Readonly<Record<string, number>>,
): [ImageReferenceRole, ...ImageReferenceRole[]] {
  const roles = IMAGE_REFERENCE_ROLES.filter((role) => (limits[role] ?? 0) > 0);
  return roles as [ImageReferenceRole, ...ImageReferenceRole[]];
}

/**
 * The coarse bound, per medium — no route of that medium reads more. The
 * resolved route's own descriptor is checked at dispatch and is usually lower;
 * this only stops a request no route could have honoured.
 */
function referenceListSchema(limits: Readonly<Record<string, number>>) {
  return z
    .array(referenceSchemaFor(limits))
    .max(maxReferences(limits))
    .superRefine((references, ctx) => {
      for (const [role, limit] of Object.entries(limits)) {
        const count = references.filter((reference) => reference.role === role).length;
        if (count > limit) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${String(count)} ${role} references exceeds the limit of ${String(limit)}. Reference-capable routes honour at most ${String(limit)} ${role} references and silently ignore the rest — drop the weakest ones rather than paying for a generation that reads only some of them.`,
          });
        }
      }
    });
}

/**
 * One reference, offering only the roles the medium reads. The image lane keeps
 * the full explanation because it genuinely conditions on both; a lane with one
 * role needs no comparison drawn against a role it cannot take.
 */
function referenceSchemaFor(limits: Readonly<Record<string, number>>) {
  const roles = referenceRolesFor(limits);
  return ImageReferenceSchema.extend({
    role:
      roles.length > 1
        ? ImageReferenceSchema.shape.role
        : z
            .enum(roles)
            .describe('What the model takes from this image — identity it holds across shots'),
  });
}

const imageReferenceListSchema = referenceListSchema(MAX_IMAGE_REFERENCES_PER_ROLE);
const videoReferenceListSchema = referenceListSchema(MAX_VIDEO_REFERENCES_PER_ROLE);

export const AiImageGenerateInputSchema = z.object({
  prompt: nonEmptyPromptSchema(32_000, 'Your text prompt'),
  referenceRefs: imageReferenceListSchema
    .describe(
      'Reference images that condition the generation, in the order the model should read them. Only reference-capable models accept these — the step fails rather than generating an unconditioned image.',
    )
    .optional(),
  model: enumWithCustom(IMAGE_MODELS).describe('AI model to use').optional(),
  size: enumWithCustom(IMAGE_SIZES, 32).describe('Image dimensions').optional(),
  n: z
    .number()
    .int()
    .min(1)
    .max(10)
    .describe('Number of images to generate. Omit to render one.')
    .optional(),
  quality: z.enum(['low', 'medium', 'high', 'auto']).describe('Image quality level').optional(),
  aspectRatio: enumWithCustom(ASPECT_RATIOS, 16).describe('Image aspect ratio').optional(),
  outputFormat: z.enum(['png', 'jpeg', 'webp']).describe('Output image format').optional(),
  background: z
    .enum(['transparent', 'opaque', 'auto'])
    .describe('Background transparency')
    .optional(),
});
export type AiImageGenerateInput = z.infer<typeof AiImageGenerateInputSchema>;

// ============================================================================
// ai.image.edit - Image Editing
// ============================================================================

export const AiImageEditInputSchema = z.object({
  prompt: nonEmptyPromptSchema(32_000, 'Your text prompt'),
  imageRef: MediaSourceRefSchema.describe(`The image to edit. ${SOURCE_REF_HINT}`),
  maskRef: MediaSourceRefSchema.describe(
    `The mask that marks the region to edit, for inpainting. ${SOURCE_REF_HINT}`,
  ).optional(),
  model: enumWithCustom(IMAGE_MODELS).describe('AI model to use').optional(),
  size: enumWithCustom(IMAGE_SIZES, 32).describe('Image dimensions').optional(),
  n: z
    .number()
    .int()
    .min(1)
    .max(10)
    .describe('Number of images to generate. Omit to render one.')
    .optional(),
  aspectRatio: enumWithCustom(ASPECT_RATIOS, 16).describe('Image aspect ratio').optional(),
});
export type AiImageEditInput = z.infer<typeof AiImageEditInputSchema>;

// ============================================================================
// ai.video.generate - Video Generation (Text-to-Video)
// ============================================================================

export const AiVideoGenerateInputSchema = z.object({
  prompt: nonEmptyPromptSchema(32_000, 'Your text prompt'),
  negativePrompt: z.string().max(32_000).describe('What to avoid in the video').optional(),
  model: enumWithCustom(VIDEO_MODELS).describe('AI model to use').optional(),
  durationSeconds: z
    .number()
    .positive()
    .max(60)
    .describe("Clip length in seconds. Omit to render the model's own default length.")
    .optional(),
  aspectRatio: enumWithCustom(ASPECT_RATIOS, 16).describe('Image aspect ratio').optional(),
  resolution: enumWithCustom(VIDEO_RESOLUTIONS, 16).describe('Video resolution').optional(),
});
export type AiVideoGenerateInput = z.infer<typeof AiVideoGenerateInputSchema>;

// ============================================================================
// ai.video.animate - Animate Image (Image-to-Video)
// ============================================================================

export const AiVideoFromImageInputSchema = z.object({
  prompt: nonEmptyPromptSchema(32_000, 'Your text prompt'),
  imageRef: MediaSourceRefSchema.describe(`The clip's first frame. ${SOURCE_REF_HINT}`),
  lastFrameRef: MediaSourceRefSchema.describe(
    `The final frame to interpolate towards. ${SOURCE_REF_HINT}`,
  ).optional(),
  referenceRefs: videoReferenceListSchema
    .describe(
      'Reference images that hold a character across shots. Each needs a `label` the prompt uses as that character’s name — a name the prompt never says is a reference the render ignores. Images sharing a label are angles on one identity.',
    )
    .optional(),
  negativePrompt: z.string().max(32_000).describe('What to avoid in the video').optional(),
  model: enumWithCustom(VIDEO_MODELS).describe('AI model to use').optional(),
  durationSeconds: z
    .number()
    .positive()
    .max(60)
    .describe("Clip length in seconds. Omit to render the model's own default length.")
    .optional(),
  aspectRatio: enumWithCustom(ASPECT_RATIOS, 16).describe('Image aspect ratio').optional(),
  resolution: enumWithCustom(VIDEO_RESOLUTIONS, 16).describe('Video resolution').optional(),
});
export type AiVideoFromImageInput = z.infer<typeof AiVideoFromImageInputSchema>;

// ============================================================================

export const AiOperationRegistrations: OperationRegistration[] = [
  {
    stepType: 'ai',
    group: 'text',
    verb: 'generate',
    name: 'Generate Text',
    agentTool: false,
    actionLabel: 'Generating text…',
    semanticDescription:
      'Generate text using an LLM with a prompt and optional system instructions',
    tags: ['generation'],
    internalFields: {
      input: ['tools', 'toolChoice', 'messages', 'historyRef', 'historyPolicy'],
      output: ['toolCalls'],
    },
    idempotency: 'non_idempotent',
    mutates: false,
    usage: {
      oneLine: 'Generate text from a prompt using an LLM.',
      whenToUse: [
        'Generating free-form text responses',
        'Summarization, translation, or rewriting tasks',
      ],
      whenNotToUse: [
        'Need structured JSON output — use ai.text.generate_json instead',
        'Need streaming — use ai.text.generate_stream instead',
      ],
      pitfalls: ['Set temperature=0 for deterministic output'],
      minimalExampleInput: { prompt: 'Summarize this article in 3 sentences.' },
    },
    accessMode: 'read',
    inputZod: AiGenerateInputSchema,
    outputZod: AiGenerateOutputSchema,
  },
  {
    stepType: 'ai',
    group: 'text',
    verb: 'generate_json',
    name: 'Generate Structured JSON',
    agentTool: false,
    actionLabel: 'Generating structured output…',
    semanticDescription: 'Generate structured JSON output conforming to a provided JSON Schema',
    tags: ['generation', 'structured'],
    internalFields: {
      input: ['tools', 'toolChoice', 'messages', 'historyRef', 'historyPolicy'],
      output: ['toolCalls'],
    },
    idempotency: 'non_idempotent',
    mutates: false,
    usage: {
      oneLine: 'Generate structured JSON conforming to a JSON Schema.',
      whenToUse: [
        'Need typed, parseable output (objects, arrays, enums)',
        'Extracting structured data from unstructured text',
      ],
      whenNotToUse: [
        'Free-form text is fine — use ai.text.generate instead',
        'Need streaming output — use ai.text.generate_stream instead',
      ],
      pitfalls: [
        'outputSchema must be valid JSON Schema — Zod .toJsonSchema() works',
        'Complex nested schemas may cause more retries',
      ],
      minimalExampleInput: {
        prompt: 'Extract the name and age from: "Alice is 30."',
        outputSchema: {
          type: 'object',
          properties: { name: { type: 'string' }, age: { type: 'number' } },
          required: ['name', 'age'],
        },
      },
    },
    accessMode: 'read',
    inputZod: AiGenerateJsonInputSchema,
    outputZod: AiGenerateJsonOutputSchema,
  },
  {
    stepType: 'ai',
    group: 'text',
    verb: 'generate_stream',
    name: 'Generate Streaming Text',
    agentTool: false,
    actionLabel: 'Generating text…',
    semanticDescription:
      'Generate text with a durable NDJSON stream of deltas for live UI and replay',
    tags: ['generation', 'streaming'],
    internalFields: {
      input: ['tools', 'toolChoice', 'messages', 'historyRef', 'historyPolicy'],
      output: ['toolCalls'],
    },
    idempotency: 'non_idempotent',
    mutates: false,
    usage: {
      oneLine: 'Stream text generation with NDJSON deltas for live display.',
      whenToUse: [
        'Chat or live UIs where progressive rendering matters',
        'Long-running generation where partial output is useful',
      ],
      whenNotToUse: [
        'Batch processing where final result is all you need — use ai.text.generate',
        'Need structured JSON — use ai.text.generate_json',
      ],
      pitfalls: [
        'streamRef points to NDJSON chunks stored in PayloadStore',
        'Final content is also available in the output for non-streaming consumers',
      ],
      minimalExampleInput: { prompt: 'Write a short poem about the ocean.' },
    },
    accessMode: 'read',
    inputZod: AiGenerateStreamInputSchema,
    outputZod: AiGenerateStreamOutputSchema,
  },
  {
    stepType: 'ai',
    group: 'embedding',
    verb: 'generate',
    name: 'Generate Embeddings',
    agentTool: false,
    actionLabel: 'Embedding…',
    semanticDescription: 'Generate embeddings for text(s) using an embedding model',
    tags: ['embeddings'],
    idempotency: 'idempotent',
    mutates: false,
    internal: true,
    usage: {
      oneLine: 'Generate vector embeddings for text using an embedding model.',
      whenToUse: [
        'Creating embeddings for semantic search or similarity',
        'Batch-embedding multiple texts for storage in a vector index',
      ],
      whenNotToUse: [
        'Need to search existing embeddings — use memory.store.query instead',
        'Need text generation — use ai.text.generate',
      ],
      minimalExampleInput: { text: 'The quick brown fox jumps over the lazy dog.' },
    },
    accessMode: 'read',
    inputZod: AiEmbedInputSchema,
    outputZod: AiEmbedOutputSchema,
  },
  {
    stepType: 'ai',
    group: 'decision',
    verb: 'decide',
    name: 'Decide',
    agentTool: false,
    actionLabel: 'Deciding…',
    semanticDescription:
      'Answer named questions about a state — a choice among labelled options, a score on a rubric, or a yes/no — with calibrated confidence, from a decision model that writes no text',
    tags: ['decision', 'classification', 'routing'],
    idempotency: 'idempotent',
    mutates: false,
    groupDisplayName: 'Decisions',
    groupDescription:
      'Typed judgements about a state with calibrated confidence, for routing and gating in workflows.',
    usage: {
      oneLine: 'Route, triage, gate or score a state with typed answers and calibrated confidence.',
      whenToUse: [
        'A workflow step that routes, triages, gates or scores on a judgement, with the questions fixed when the skill is authored',
        'Deciding whether an item needs a reasoning step at all: set minConfidence and send decided=false to an agent task',
        'The same questions asked of many items, where a reasoning model per item costs too much or takes too long',
      ],
      whenNotToUse: [
        'Anything that must produce text, code or an explanation — use an agent task or ai.text.generate_json',
        'Counting or arithmetic over a set of items',
        'A comparison of values that already exist — a when predicate on the producing task decides that for nothing',
      ],
      pitfalls: [
        'Instructions are read literally: negations and scope apply exactly as written',
        'Content in the state can steer the answer, so a decision about untrusted input is never the only gate on a consequential action',
        'Each question is answered in isolation; one question cannot see another question’s answer',
      ],
      minimalExampleInput: {
        state: 'My card was charged twice for the same order.',
        questions: {
          team: {
            type: 'choice',
            instructions: 'Which team should handle this message',
            options: {
              billing: 'Payments, invoices, refunds',
              technical: 'Bugs, outages, integrations',
              sales: 'Pricing, upgrades, new accounts',
            },
            minConfidence: 0.7,
          },
          urgent: { type: 'yes_no', instructions: 'The message conveys urgency' },
        },
      },
    },
    accessMode: 'read',
    inputZod: AiDecideInputSchema,
    outputZod: AiDecideOutputSchema,
  },
  {
    stepType: 'ai',
    group: 'agent',
    verb: 'turn',
    name: 'Agent Turn',
    agentTool: false,
    actionLabel: 'Agent working…',
    semanticDescription:
      "Execute one turn of an agent loop: decide the next action (invoke tool steps, request user input, or complete). Tools are derived from the flow's connected steps.",
    tags: ['agent'],
    internalFields: {
      input: [
        'availableTools',
        'historyRef',
        'contextRef',
        'lastToolResults',
        'policy',
        'turnNumber',
        'totalToolCallsSoFar',
        'requestInputPolicy',
        'completionPolicy',
        'finalOutputSchema',
        'completionPrompt',
        'historyPolicy',
        'contextPolicy',
        'outputPolicy',
      ],
    },
    idempotency: 'non_idempotent',
    mutates: false,
    usage: {
      oneLine: 'Execute one agent turn — the orchestrator manages history and tool dispatch.',
      whenToUse: [
        'Building agent flows where the AI decides which tools to call next',
        'Multi-turn conversational agents with tool use',
      ],
      whenNotToUse: ['Simple single-shot generation — use ai.text.generate'],
      pitfalls: [
        'History, tool results, and turn counters are managed by the orchestrator — do not set them manually',
      ],
      minimalExampleInput: {
        prompt: 'Help the user plan a trip to Paris.',
        model: 'haiku',
      },
    },
    accessMode: 'write',
    inputZod: AgentTurnInputSchema,
    stepConfigZod: AgentStepConfigSchema,
    outputZod: AgentTurnOutputSchema,
  },
  {
    stepType: 'ai',
    group: 'media',
    verb: 'image',
    name: 'Generate Image',
    actionLabel: 'Generating image…',
    semanticDescription:
      'Generate images from text prompts using AI models (GPT-Image-1.5, Gemini 2.5 Flash Image, Gemini 3 Pro Image). Supports multiple providers, aspect ratios, sizes, and quality levels, and conditioning on character and style reference images.',
    tags: ['generation', 'media'],
    idempotency: 'non_idempotent',
    mutates: false,
    usage: {
      oneLine: 'Generate images from a text prompt.',
      whenToUse: [
        'Creating images, illustrations, or visual assets from descriptions',
        'Generating multiple variants with different styles or aspect ratios',
        'Keeping a character or a style consistent across shots — pass earlier assets as referenceRefs',
      ],
      whenNotToUse: [
        'Modifying an existing image — use ai.media.edit_image instead',
        'Animating an image that already exists — use ai.media.animate on its pinned reference',
      ],
      pitfalls: [
        'Reference images need a reference-capable model — the step fails naming one rather than returning an unconditioned image',
        "The output carries pinned references, never image bytes — read one back with memory.store.get({ target: { path, version, expectedContentHash }, view: 'content' }), which confirms the pin and returns the document's metadata",
        'n > 1 renders and bills n candidates of ONE request under one receipt — raise it to choose between alternatives, not to get extras for free',
      ],
      minimalExampleInput: { prompt: 'A sunset over mountains, oil painting style' },
    },
    accessMode: 'write',
    inputZod: AiImageGenerateInputSchema,
    outputZod: AiMediaOutputSchema,
  },
  {
    stepType: 'ai',
    group: 'media',
    verb: 'edit_image',
    name: 'Edit Image',
    actionLabel: 'Editing image…',
    semanticDescription:
      'Edit an existing image using a text prompt and optional mask. Supports inpainting, style transfer, and content modification.',
    tags: ['editing', 'media'],
    idempotency: 'non_idempotent',
    mutates: false,
    usage: {
      oneLine: 'Edit an existing image with a text prompt and optional mask.',
      whenToUse: [
        'Inpainting: remove or replace objects in a region (provide maskRef)',
        'Style transfer or global edits on an existing image',
        'Revising an image this run generated — pass the asset it returned as imageRef',
      ],
      whenNotToUse: ['Creating an image from scratch — use ai.media.image'],
      pitfalls: [
        'maskRef is optional — omit for global edits, provide for region-specific changes',
        "The output carries pinned references, never image bytes — read one back with memory.store.get({ target: { path, version, expectedContentHash }, view: 'content' }), which confirms the pin and returns the document's metadata",
        'An edit reads the pinned version, never the current one — a document overwritten since the pin fails the step naming both hashes rather than editing the newer bytes',
      ],
      minimalExampleInput: {
        prompt: 'Make the sky more dramatic',
        imageRef: {
          path: '/media/run-1/take-9f2c1a-0',
          version: 1,
          contentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        },
      },
    },
    accessMode: 'write',
    inputZod: AiImageEditInputSchema,
    outputZod: AiMediaOutputSchema,
  },
  {
    stepType: 'ai',
    group: 'media',
    verb: 'video',
    name: 'Generate Video',
    actionLabel: 'Generating video…',
    semanticDescription:
      'Generate video from text prompts using AI models (Veo 3.1, Sora 2). Supports dialog, sound effects, cinematic styles, and multiple resolutions (720p, 1080p).',
    tags: ['generation', 'media'],
    idempotency: 'non_idempotent',
    mutates: false,
    usage: {
      oneLine: 'Generate video from a text prompt.',
      whenToUse: [
        'Creating short video clips from text descriptions',
        'Generating video content with dialog or sound effects',
      ],
      whenNotToUse: ['Animating an existing image — use ai.media.animate'],
      pitfalls: [
        "The output carries pinned references, never video bytes — read one back with memory.store.get({ target: { path, version, expectedContentHash }, view: 'content' }), which confirms the pin and returns the document's metadata",
        'No video route hands back a handle to continue a clip from, which assets[i].providerNative states per asset — a longer sequence means rendering further clips and assembling them, never extending this one',
        'receipt.rendered is read from the delivered file rather than echoed from the request, so a route that clamped the ask reports the shorter length here — read it before assembling a timeline',
      ],
      minimalExampleInput: { prompt: 'A drone shot flying over a tropical beach at sunset' },
    },
    accessMode: 'write',
    ownsAsyncJobLifecycle: true,
    inputZod: AiVideoGenerateInputSchema,
    outputZod: AiMediaOutputSchema,
  },
  {
    stepType: 'ai',
    group: 'media',
    verb: 'animate',
    name: 'Animate Image',
    actionLabel: 'Generating video…',
    semanticDescription:
      'Generate video starting from a source image as the first frame. Optionally specify a last frame for interpolation (Veo 3.1).',
    tags: ['generation', 'media'],
    idempotency: 'non_idempotent',
    mutates: false,
    usage: {
      oneLine: 'Animate a source image into a video clip.',
      whenToUse: [
        'Turning a still image into a short animation',
        'Creating smooth transitions between a start and end frame',
        'Animating an image this run generated — pass the asset it returned as imageRef',
        'Holding a character recognisable across shots',
      ],
      whenNotToUse: ['No source image — use ai.media.video for text-to-video'],
      pitfalls: [
        'A reference is read only while animating a frame and only when the prompt names its label — ai.media.video takes none at all',
        "The output carries pinned references, never video bytes — read one back with memory.store.get({ target: { path, version, expectedContentHash }, view: 'content' }), which confirms the pin and returns the document's metadata",
        'No video route hands back a handle to continue a clip from, which assets[i].providerNative states per asset — a longer sequence means rendering further clips and assembling them, never extending this one',
        'The frames are read at the pinned version — a document overwritten since the pin fails the step naming both hashes rather than animating the newer bytes',
      ],
      minimalExampleInput: {
        prompt: 'The camera slowly zooms out',
        imageRef: {
          path: '/media/run-1/take-9f2c1a-0',
          version: 1,
          contentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        },
      },
    },
    accessMode: 'write',
    ownsAsyncJobLifecycle: true,
    inputZod: AiVideoFromImageInputSchema,
    outputZod: AiMediaOutputSchema,
  },
];
