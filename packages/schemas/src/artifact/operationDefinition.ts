/**
 * Operation definition schemas.
 * Operations are the atomic units of work (e.g., 'ai.generate', 'memory.read').
 */
import { z } from 'zod';
import { OperationIdSchema, SchemaVersionSchema } from '../runtime/ids.js';
import { SideEffectDeclarationSchema } from '../runtime/sideEffects.js';
import { PermissionSetSchema, PermissionScopeSchema } from '../runtime/permissions.js';

// ============================================================================
// Step Types (Executor Classes)
// ============================================================================

/**
 * Canonical step types - each has a dedicated executor.
 */
export const StepTypeSchema = z.enum([
  'ai',
  'memory',
  'api',
  'compute',
  'search',
  'agent',
  'user',
  'eval',
  'guardrail',
  'ui',
  'mcp',
  'catalog',
  'space',
  'workflow',
  'learner',
  'proposal',
  'skill', // 104f: compose-skill inline ops
  'capability', // 104g: bind-capability inline ops
  'integration',
  'human',
  'artifact',
  'code',
  'store',
  'host', // 298: the operator's own machine, through the paired native executor
  'browser',
]);

export type StepType = z.infer<typeof StepTypeSchema>;

// ============================================================================
// Error Model
// ============================================================================

/**
 * Error model for operation definition.
 */
export const OperationErrorModelSchema = z.object({
  /** Possible error codes this operation can return */
  possibleErrorCodes: z.array(z.string().max(64)).default([]),
  /** Default retryable status for errors from this operation */
  defaultRetryable: z.boolean().default(false),
});

export type OperationErrorModel = z.infer<typeof OperationErrorModelSchema>;

// ============================================================================
// Operation Definition
// ============================================================================

/**
 * Full operation definition as stored in the catalog.
 */
export const OperationDefinitionSchema = z.object({
  /** Schema version for this artifact type */
  schemaVersion: SchemaVersionSchema.default(1),

  /** Operation identifier (e.g., 'ai.generate', 'memory.read') */
  operationId: OperationIdSchema,

  /** Step type this operation belongs to */
  stepType: StepTypeSchema,

  /** Human-readable name */
  name: z.string().min(1).max(128).describe('Human-readable operation name'),

  /** Semantic description for agents and documentation */
  semanticDescription: z
    .string()
    .max(2000)
    .describe('Detailed description for agent understanding'),

  /** Short description for UI */
  shortDescription: z.string().max(200).optional().describe('Short description for UI display'),

  /** JSON Schema for operation input */
  inputSchema: z.record(z.unknown()).describe('JSON Schema defining operation input'),

  /** JSON Schema for operation output (optional but recommended) */
  outputSchema: z.record(z.unknown()).optional().describe('JSON Schema defining operation output'),

  /** Side effect declaration */
  sideEffects: SideEffectDeclarationSchema,

  /** Required permissions */
  permissions: PermissionSetSchema.default({ required: [], optional: [] }),

  /** Scope model - what context this operation operates in */
  scopeModel: PermissionScopeSchema.default('run'),

  /** Error model */
  errorModel: OperationErrorModelSchema.default({
    possibleErrorCodes: [],
    defaultRetryable: false,
  }),

  /** Whether this operation is experimental */
  experimental: z.boolean().default(false),

  /** Whether this operation is deprecated */
  deprecated: z.boolean().default(false),

  /** Deprecation message if deprecated */
  deprecationMessage: z.string().max(500).optional(),

  /** Tags for categorization */
  tags: z.array(z.string().max(64)).default([]),
});

export type OperationDefinition = z.infer<typeof OperationDefinitionSchema>;

// ============================================================================
// Canonical Operations Registry
// ============================================================================

/**
 * All canonical operation IDs from the spec.
 */
/**
 * All canonical operation IDs — derived from the structural registration.
 * Format: {stepType}.{group}.{verb} or {stepType}.{verb}
 */
export const CanonicalOperationIds = {
  // AI — text
  AI_TEXT_GENERATE: 'ai.text.generate' as const,
  AI_TEXT_GENERATE_JSON: 'ai.text.generate_json' as const,
  AI_TEXT_GENERATE_STREAM: 'ai.text.generate_stream' as const,
  // AI — embedding (internal)
  AI_EMBEDDING_GENERATE: 'ai.embedding.generate' as const,
  // AI — agent
  AI_AGENT_TURN: 'ai.agent.turn' as const,
  // AI — media (merged image + video)
  AI_MEDIA_IMAGE: 'ai.media.image' as const,
  AI_MEDIA_EDIT_IMAGE: 'ai.media.edit_image' as const,
  AI_MEDIA_VIDEO: 'ai.media.video' as const,
  AI_MEDIA_ANIMATE: 'ai.media.animate' as const,

  // Memory — store
  MEMORY_STORE_QUERY: 'memory.store.query' as const,
  MEMORY_STORE_GET: 'memory.store.get' as const,
  MEMORY_STORE_PUT: 'memory.store.put' as const,
  MEMORY_STORE_PATCH: 'memory.store.patch' as const,
  MEMORY_STORE_DELETE: 'memory.store.delete' as const,
  MEMORY_STORE_MKDIR: 'memory.store.mkdir' as const,

  // API — http
  API_HTTP_CALL: 'api.http.call' as const,
  // API — definition (moved from platform)
  API_DEFINITION_UPSERT: 'api.definition.upsert' as const,
  API_DEFINITION_DELETE: 'api.definition.delete' as const,
  API_DEFINITION_GET: 'api.definition.get' as const,
  API_DEFINITION_LIST: 'api.definition.list' as const,
  API_DEFINITION_IMPORT_OPENAPI: 'api.definition.import_openapi' as const,
  // API — binding (moved from platform)
  API_BINDING_UPSERT: 'api.binding.upsert' as const,
  API_BINDING_DELETE: 'api.binding.delete' as const,
  API_BINDING_GET: 'api.binding.get' as const,
  API_BINDING_LIST: 'api.binding.list' as const,

  // Compute — sandbox
  COMPUTE_SANDBOX_EXEC: 'compute.sandbox.exec' as const,

  // Search — web
  SEARCH_WEB_SEARCH: 'search.web.search' as const,
  SEARCH_WEB_FETCH: 'search.web.fetch' as const,

  // Agent — control
  AGENT_CONTROL_DISPATCH: 'agent.control.dispatch' as const,
  AGENT_CONTROL_DELEGATE: 'agent.control.delegate' as const,
  AGENT_CONTROL_ABORT: 'agent.control.abort' as const,
  AGENT_CONTROL_END: 'agent.control.end' as const,
  AGENT_CONTROL_RUN_STEP: 'agent.control.run_step' as const,

  // User — interaction
  USER_INTERACTION_ASK: 'user.interaction.ask' as const,
  USER_INTERACTION_APPROVE: 'user.interaction.approve' as const,

  // Agent — manage
  AGENT_MANAGE_CREATE: 'agent.manage.create' as const,
  AGENT_MANAGE_GET: 'agent.manage.get' as const,
  AGENT_MANAGE_UPDATE: 'agent.manage.update' as const,
  AGENT_MANAGE_DELETE: 'agent.manage.delete' as const,
  AGENT_MANAGE_LIST: 'agent.manage.list' as const,
  AGENT_MANAGE_VALIDATE: 'agent.manage.validate' as const,

  // Guardrail — policy / violation (moved from platform.guardrail.*)
  GUARDRAIL_POLICY_CREATE: 'guardrail.policy.create' as const,
  GUARDRAIL_POLICY_GET: 'guardrail.policy.get' as const,
  GUARDRAIL_POLICY_UPDATE: 'guardrail.policy.update' as const,
  GUARDRAIL_POLICY_DELETE: 'guardrail.policy.delete' as const,
  GUARDRAIL_POLICY_LIST: 'guardrail.policy.list' as const,
  GUARDRAIL_POLICY_GET_EFFECTIVE: 'guardrail.policy.get_effective' as const,
  GUARDRAIL_VIOLATION_LIST: 'guardrail.violation.list' as const,

  // Space — manage
  SPACE_MANAGE_CREATE: 'space.manage.create' as const,
  SPACE_MANAGE_GET: 'space.manage.get' as const,
  SPACE_MANAGE_UPDATE: 'space.manage.update' as const,
  SPACE_MANAGE_DELETE: 'space.manage.delete' as const,
  // Catalog — tool
  CATALOG_TOOL_LIST: 'catalog.tool.list' as const,
} as const;

export type CanonicalOperationId =
  (typeof CanonicalOperationIds)[keyof typeof CanonicalOperationIds];
