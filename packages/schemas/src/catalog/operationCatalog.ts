/**
 * Operation catalog types and definitions.
 *
 * Provides types for describing operations with metadata,
 * input/output schemas, and classification information.
 */
import { type z } from 'zod';
import type { StepType } from '../artifact/operationDefinition.js';
import type { SemanticType } from '../artifact/stateVariable.js';
import type { CapabilityAccessMode, RiskModifier } from './capabilityGroups.js';
import type { StepImageOutputPaths } from '../media/stepImage.js';
import type { OperationObservation } from '../runtime/toolObservation.js';

// ============================================================================
// Idempotency & Usage Metadata
// ============================================================================

export type IdempotencyKind = 'idempotent' | 'non_idempotent' | 'unknown';

/**
 * Token-efficient usage hints for agents and documentation.
 */
export interface OperationUsage {
  /** One-line summary, max ~120 chars */
  oneLine: string;
  /** When to use this operation (1–3 bullets) */
  whenToUse: string[];
  /** When NOT to use this operation (1–3 bullets) */
  whenNotToUse: string[];
  /** Common pitfalls (0–3 bullets) */
  pitfalls?: string[];
  /** Minimal working example input (valid JSON matching inputSchema) */
  minimalExampleInput: Record<string, unknown>;
  followUp?: Array<{
    operationId: string;
    note: string;
    /** 'always' = always include; 'when_available' (default) = only if in agent's tool surface */
    condition?: 'always' | 'when_available';
  }>;
}

// ============================================================================
// CRUD View Metadata
// ============================================================================

/**
 * CRUD view metadata for platform operations.
 * Helps agents reason about operations using a simpler mental model.
 */
export interface CrudViewMetadata {
  /** Entity type being operated on */
  entityType:
    | 'agent'
    | 'flow' // deprecated, kept during migration
    | 'space'
    | 'workflow'
    | 'api_config'
    | 'api_definition'
    | 'api_binding'
    | 'mcp_server_definition'
    | 'mcp_server_binding'
    | 'guardrail_policy'
    | 'guardrail_violation';
  /** CRUD action */
  action: 'create' | 'read' | 'update' | 'delete' | 'list';
}

// ============================================================================
// Operation Registration (source-of-truth declaration)
// ============================================================================

/**
 * How an operation is defined by its source file.
 * stepType, group, and verb are the structural source of truth.
 * operationId is NEVER specified here — it's computed by the registry.
 */
export interface OperationRegistration {
  /** Executor class / capability domain — must match StepTypeSchema */
  stepType: StepType;
  /** Logical sub-domain within the stepType (null for ungrouped operations).
   *  Must be snake_case if present. */
  group: string | null;
  /** The action verb (e.g., 'generate', 'create', 'query'). Must be snake_case. */
  verb: string;
  /** Human-readable name */
  name: string;
  /** Semantic description for agents */
  semanticDescription: string;
  /** Short label shown during execution (e.g., "Generating image…") */
  actionLabel?: string;
  /** Tags for supplementary categorization */
  tags?: string[];
  /** CRUD view metadata (for platform entity operations) */
  crudView?: CrudViewMetadata;
  /** Orchestrator-managed fields hidden from the flow editor */
  internalFields?: { input?: string[]; output?: string[] };
  /**
   * Sub-objects collapsed to `{ type: 'object', description }` in the schema
   * emitted to a model, keyed by top-level property name.
   *
   * The full shape stays in `inputZod`, so the server still validates it and
   * `catalog.tool.list` still serves it — this narrows only what is pinned into
   * every turn. Reaches for the same lever `internalFields.input` already uses,
   * for a different reason: those fields are never the model's to send, these
   * are rarely worth the bytes to describe up front.
   *
   * A string value becomes `{ type: 'object', description }`. An object value
   * is emitted verbatim, for the cases where part of the shape is worth keeping
   * typed — an `enum` constrains generation in a way prose cannot.
   *
   * The description must name the keys and their types, because it becomes the
   * only shape information the model has for that argument.
   */
  agentCollapsedFields?: Record<string, string | Record<string, unknown>>;

  /** Idempotency classification for retry/agent reasoning */
  idempotency: IdempotencyKind;
  /** Token-efficient usage hints for agents and documentation */
  usage: OperationUsage;

  /** Input Zod schema */
  inputZod: z.ZodType;
  /** Output Zod schema */
  outputZod?: z.ZodType;
  /** Resume payload Zod schema (for pausable operations like user.*) */
  resumePayloadZod?: z.ZodType;
  /**
   * Step config Zod schema — defines the config fields a flow author sets
   * on the step definition. When provided, the flow editor uses this instead
   * of inputZod to determine known config fields.
   *
   * Use when the step config is a superset of the operation input (e.g.,
   * ai.agent.turn has orchestrator-consumed fields like `catalog` and
   * `turnPolicy` that never reach the executor).
   */
  stepConfigZod?: z.ZodType;
  /** If true, this operation is internal-only (excluded from agent catalog). */
  internal?: boolean;
  /**
   * If false, this operation is a structural runtime primitive (e.g., ai.text.generate,
   * ai.agent.turn) that agents never select as a tool. Excluded from agent catalogs,
   * agent-turn tool lists, and agent editor dropdowns. Visible in the operations registry.
   * Default: true (omit for normal agent-facing operations).
   */
  agentTool?: boolean;
  agentAlternative?: string;
  /** If true, this operation is privileged (RunAccessGrant must allow privileged ops). */
  privileged?: boolean;
  /** If true, this operation mutates state (used for access-grant enforcement). */
  mutates?: boolean;
  skipInputValidation?: boolean;
  bypassGrant?: boolean;

  /**
   * Coarse permission mode: 'read' or 'write'.
   * This is what admins reason about in policy. Should usually agree with `mutates`.
   */
  accessMode: CapabilityAccessMode;
  /**
   * Optional risk modifiers for this specific operation.
   * E.g., 'external_side_effect' for operations that call external APIs.
   */
  riskModifiers?: RiskModifier[];

  opTaskOnly?: boolean;

  /**
   * True for operations whose provider work outlives the step that starts it and
   * which drive it through the managed async-job lifecycle. Absence means the
   * operation is not eligible as a fan-out body — a replayed submit with no
   * managed lifecycle is how the same paid job gets bought twice.
   *
   * The recovery *mechanism* is deliberately not here: these operations resolve
   * their adapter from the requested model at run time, so one operation reaches
   * providers with different idempotency support. A static declaration could
   * only overclaim (duplicate spend on a route that ignores the key) or
   * underclaim (`unknown` everywhere, discarding recovery that exists). The
   * resolved route declares it; the job row persists what was actually used.
   */
  ownsAsyncJobLifecycle?: boolean;

  // --- Output rendering metadata ---

  /**
   * Optional semantic type for this operation's output. When set, the UI renders
   * the output with a specialized card component instead of raw JSON.
   * The orchestrator attaches this to the step result event metadata so the
   * web UI can match it without shape detection hacks.
   */
  outputSemanticType?: SemanticType;

  /**
   * The output paths where this operation returns a `StepImage` (Plan 320 D10),
   * shaped by `StepImageOutputPathsSchema`. An agent turn is shown images only
   * from an operation that declares them, read at these paths and nowhere else;
   * every other output reaches the model as its JSON, however it is shaped.
   * An operation whose data originates outside the platform declares this only
   * through the allowlist in `imageOutputDeclarations.test.ts`.
   */
  imageOutputPaths?: StepImageOutputPaths;

  /**
   * That this operation's result observes something a later result makes stale
   * (`observes`), or ends it (`ends`), shaped by `OperationObservationSchema`.
   * The agent turn shows the newest observation per group and key in full and
   * reduces every earlier one to its receipt. Absent: the result is always
   * shown as it was returned.
   */
  observation?: OperationObservation;

  /**
   * Optional display name for this operation's group (used in catalog/admin UI).
   * Set on one operation per group; registry picks the first non-null value.
   * E.g., 'Text Generation' for the 'ai.text' group.
   */
  groupDisplayName?: string;
  /**
   * Optional description for this operation's group (used in admin UI).
   * Same convention as groupDisplayName — set on one operation per group.
   */
  groupDescription?: string;

  /**
   * Default resume strategy when this operation's step fails and is retried.
   * - 'rerun_failed_step': replay the exact failed step with same/corrected input
   * - 'rerun_parent_agent_turn': let the parent agent reconsider
   * Default when unset: 'rerun_parent_agent_turn' (conservative).
   */
  defaultResumeStrategy?: 'rerun_failed_step' | 'rerun_parent_agent_turn';
}

// ============================================================================
// Operation Descriptor (registry-produced, includes computed operationId)
// ============================================================================

/**
 * Complete descriptor for an operation, produced by the registry.
 * All metadata is flattened — no nested `meta` sub-object.
 */
export interface OperationDescriptor {
  /** Computed operation ID (e.g., "ai.text.generate") */
  operationId: string;
  /** Step type this operation belongs to */
  stepType: string;
  /** Logical group within stepType (null if ungrouped) */
  group: string | null;
  /** Action verb */
  verb: string;
  /** Human-readable name */
  name: string;
  /** Semantic description for agents */
  semanticDescription: string;
  /** Short label shown during execution */
  actionLabel?: string;
  /** Tags for supplementary categorization */
  tags?: string[];
  /** CRUD view metadata */
  crudView?: CrudViewMetadata;
  /** Orchestrator-managed fields hidden from the flow editor */
  internalFields?: { input?: string[]; output?: string[] };
  /** See `OperationDescriptor.agentCollapsedFields`. */
  agentCollapsedFields?: Record<string, string | Record<string, unknown>>;
  /** Idempotency classification */
  idempotency: IdempotencyKind;
  /** Usage hints */
  usage: OperationUsage;
  /** Input Zod schema */
  inputZod: z.ZodType;
  /** Output Zod schema (optional) */
  outputZod?: z.ZodType;
  /** Resume payload Zod schema (for pausable operations) */
  resumePayloadZod?: z.ZodType;
  /** Step config Zod schema (flow-editor uses this to show known config fields) */
  stepConfigZod?: z.ZodType;
  /** If true, this operation is internal-only (excluded from agent catalog). */
  internal?: boolean;
  /** If false, structural runtime primitive — never offered as an agent tool. */
  agentTool: boolean;
  agentAlternative?: string;
  /** If true, this operation is privileged (RunAccessGrant must allow privileged ops). */
  privileged?: boolean;
  /** Whether this operation mutates state (derived from registration, defaults to false). */
  mutates: boolean;
  skipInputValidation?: boolean;
  bypassGrant?: boolean;

  // --- Output rendering metadata ---

  /** Semantic type for this operation's output (from registration). */
  outputSemanticType?: SemanticType;
  /** See `OperationRegistration.imageOutputPaths`. */
  imageOutputPaths?: StepImageOutputPaths;
  /** See `OperationRegistration.observation`. */
  observation?: OperationObservation;

  capabilityGroupId: string;
  /** Coarse permission mode: 'read' or 'write'. */
  accessMode: CapabilityAccessMode;
  /** Risk modifiers for this operation. */
  riskModifiers: RiskModifier[];

  opTaskOnly: boolean;

  /** True for operations that drive the managed async-job lifecycle. */
  ownsAsyncJobLifecycle: boolean;

  /** Default resume strategy when this operation's step fails and is retried. */
  defaultResumeStrategy?: 'rerun_failed_step' | 'rerun_parent_agent_turn';
}

// ============================================================================
// Operation Catalog JSON Format
// ============================================================================

/**
 * JSON Schema representation (simplified).
 */
export interface JsonSchemaObject {
  type?: string | string[];
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  items?: JsonSchemaObject;
  enum?: unknown[];
  const?: unknown;
  allOf?: JsonSchemaObject[];
  anyOf?: JsonSchemaObject[];
  oneOf?: JsonSchemaObject[];
  format?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  default?: unknown;
  description?: string;
  title?: string;
  additionalProperties?: boolean | JsonSchemaObject;
  [key: string]: unknown;
}

/**
 * Operation entry in the catalog JSON export.
 */
export interface OperationCatalogEntry {
  /** Computed operation ID */
  operationId: string;
  /** Step type */
  stepType: string;
  /** Logical group (null if ungrouped) */
  group: string | null;
  /** Qualified group ID: `${stepType}.${group}` or `${stepType}` */
  groupId: string;
  /** Action verb */
  verb: string;
  /** Human-readable name */
  name: string;
  /** Short label during execution */
  actionLabel?: string;
  /** Semantic description */
  semanticDescription: string;
  /** Tags */
  tags?: string[];
  /** CRUD view metadata (if applicable) */
  crudView?: CrudViewMetadata;
  /** Input schema as JSON Schema */
  inputSchema: JsonSchemaObject;
  /** Output schema as JSON Schema (optional) */
  outputSchema?: JsonSchemaObject;
  /** Step config schema as JSON Schema (superset of inputSchema for flow editor) */
  stepConfigSchema?: JsonSchemaObject;
  /** Orchestrator-managed fields hidden from the flow editor */
  internalFields?: { input?: string[]; output?: string[] };
  /** Idempotency classification */
  idempotency: IdempotencyKind;
  /** Usage hints */
  usage: OperationUsage;
  /** SHA-256 hash of deterministic inputSchema JSON */
  inputSchemaHash: string;
  /** SHA-256 hash of deterministic outputSchema JSON (if present) */
  outputSchemaHash?: string;
}

/**
 * Complete operation catalog JSON structure.
 */
export interface OperationCatalog {
  /** Catalog format version */
  catalogVersion: number;
  /** ISO timestamp when catalog was generated */
  generatedAt: string;
  /** Array of operations (sorted by operationId) */
  operations: OperationCatalogEntry[];
}

// ============================================================================
// Tool Catalog Format (for AI tool calling)
// ============================================================================

/**
 * Tool definition for AI tool calling (catalog format).
 */
export interface CatalogToolDefinition {
  /** Tool name (operation ID) */
  name: string;
  /** Tool description */
  description: string;
  /** Tool parameters as JSON Schema */
  parameters: JsonSchemaObject;
}

/**
 * Tool catalog JSON structure.
 */
export interface ToolCatalog {
  /** Catalog format version */
  catalogVersion: number;
  /** ISO timestamp when catalog was generated */
  generatedAt: string;
  /** Array of tool definitions */
  tools: CatalogToolDefinition[];
}

// ============================================================================
// Catalog Filter Options
// ============================================================================

/**
 * Options for filtering the operation catalog.
 */
export interface CatalogFilterOptions {
  /** Filter by step types */
  stepTypes?: string[];
  /** Filter by qualified group IDs (e.g., 'ai.text', 'platform.flow') */
  groupIds?: string[];
  /** Filter by operation IDs */
  operationIds?: string[];
  /** Filter by tags */
  tags?: string[];
  /** Whether to include output schemas */
  includeOutputSchema?: boolean;
  /** Whether to include usage hints */
  includeUsageHints?: boolean;
  /** Format version */
  formatVersion?: number;
}
