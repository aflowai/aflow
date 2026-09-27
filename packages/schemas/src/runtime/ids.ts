/**
 * Strongly-typed ID schemas for the Aflow platform.
 * All IDs use branded types for compile-time safety.
 */
import { z } from 'zod';

// ============================================================================
// Branded ID Types
// ============================================================================

/**
 * UUID validation - accepts any valid UUID format (v1-v5).
 * We use Zod's built-in .uuid() which validates the structure
 * without enforcing a specific version.
 */

/** Brand type for compile-time type safety */
type Brand<T, B> = T & { readonly __brand: B };

/** Tenant identifier */
export type TenantId = Brand<string, 'TenantId'>;
export const TenantIdSchema = z
  .string()
  .uuid()
  .transform((val) => val as TenantId)
  .describe('Unique tenant identifier');

/** Session identifier (one durable instance of an agent's work) */
export type SessionId = Brand<string, 'SessionId'>;
export const SessionIdSchema = z
  .string()
  .uuid()
  .transform((val) => val as SessionId)
  .describe('Unique session identifier');

/** Step execution identifier */
export type StepExecutionId = Brand<string, 'StepExecutionId'>;
export const StepExecutionIdSchema = z
  .string()
  .uuid()
  .transform((val) => val as StepExecutionId)
  .describe('Unique step execution identifier');

/** Event identifier */
export type EventId = Brand<string, 'EventId'>;
export const EventIdSchema = z
  .string()
  .uuid()
  .transform((val) => val as EventId)
  .describe('Unique event identifier');

/** Trace identifier (for observability) */
export type TraceId = Brand<string, 'TraceId'>;
export const TraceIdSchema = z
  .string()
  .min(1)
  .max(128)
  .transform((val) => val as TraceId)
  .describe('OpenTelemetry trace identifier');

export type AgentId = Brand<string, 'AgentId'>;
export const AgentIdSchema = z
  .string()
  .uuid()
  .transform((val) => val as AgentId)
  .describe('Stable agent identifier (UUID, `agents.id`)');

/**
 * `agent_id` path parameter — accepts either a stable UUID OR a per-space
 * slug. URLs like `/v1/agents/:agentId` carry the slug for human
 * readability; UUIDs are also accepted for direct API callers. The handler
 * inspects the shape and dispatches: UUID → direct `agents.id` lookup,
 * slug → `resolveAgentRef` with history-aware fallback.
 *
 * For routes that must reject one or the other, use
 * {@link AgentIdSchema} (UUID-only) or {@link AgentSlugSchema} (slug-only)
 * directly.
 */
export const AgentIdPathParamSchema = z
  .string()
  .min(1)
  .max(128)
  .describe('Agent path identifier — UUID (agents.id) or per-space slug');

export type AgentSlug = Brand<string, 'AgentSlug'>;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const AgentSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9]+(-[a-z0-9]+)*$/,
    'Must be lowercase kebab-case: letters/digits separated by single hyphens, no leading or trailing hyphen',
  )
  .refine((val) => !UUID_SHAPE.test(val), 'Must not be a UUID')
  .transform((val) => val as AgentSlug)
  .describe('Per-space-unique human-readable agent handle');

export type SystemRole = Brand<string, 'SystemRole'>;
export const SystemRoleSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/, 'System role must be lowercase kebab-case')
  .transform((val) => val as SystemRole)
  .describe('Platform agent role identifier (e.g. "cybernetic-helmsman")');

// AgentTargetSchema lives in ./agentTarget.ts so it can import PayloadRefSchema
// without ids.ts taking on payload-runtime dependencies. Two variants exist:
//   - SessionAgentTargetSchema   (sessions / hot state / start command — 3 kinds)
//   - PersistentAgentTargetSchema (delegate / schedules / webhooks / defaults — 2 kinds)
// See packages/schemas/src/runtime/agentTarget.ts.

/** Step identifier within an agent (human-readable) */
export type StepId = Brand<string, 'StepId'>;
export const StepIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[a-z][a-z0-9_-]*$/,
    'Must start with lowercase letter, contain only lowercase letters, numbers, underscores, and hyphens',
  )
  .transform((val) => val as StepId)
  .describe('Human-readable step identifier within a flow');

/** Operation identifier (e.g., 'ai.text.generate', 'memory.store.get') */
export type OperationId = Brand<string, 'OperationId'>;
export const OperationIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,2}$/,
    "Must be 2–3 dot-separated snake_case segments (e.g., 'memory.store.get', 'ai.text.generate')",
  )
  .transform((val) => val as OperationId)
  .describe('Qualified operation identifier');

/** Idempotency key for request deduplication */
export type IdempotencyKey = Brand<string, 'IdempotencyKey'>;
export const IdempotencyKeySchema = z
  .string()
  .min(1)
  .max(256)
  .transform((val) => val as IdempotencyKey)
  .describe('Client-provided idempotency key for request deduplication');

/** Space identifier (for memory/context scoping) */
export type SpaceId = Brand<string, 'SpaceId'>;
export const SpaceIdSchema = z
  .string()
  .uuid()
  .transform((val) => val as SpaceId)
  .describe('Space identifier for memory scoping');

export type SpaceSlug = Brand<string, 'SpaceSlug'>;
export const SpaceSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9]+(-[a-z0-9]+)*$/,
    'Must be lowercase kebab-case: letters/digits separated by single hyphens, no leading or trailing hyphen',
  )
  .refine((val) => !UUID_SHAPE.test(val), 'Must not be a UUID')
  .transform((val) => val as SpaceSlug)
  .describe('Per-tenant-unique human-readable space handle');

/** User identifier */
export type UserId = Brand<string, 'UserId'>;
export const UserIdSchema = z
  .string()
  .min(1)
  .max(256)
  .transform((val) => val as UserId)
  .describe('User identifier');

export type SkillBundleId = Brand<string, 'SkillBundleId'>;
export const SkillBundleIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9_-]+$/, 'Must contain only lowercase letters, numbers, underscores, and hyphens')
  .transform((val) => val as SkillBundleId)
  .describe('Skill bundle catalog identifier');

// ============================================================================
// Version Schemas
// ============================================================================

/** Semantic version string */
export const SemanticVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, "Must be a valid semantic version (e.g., '1.0.0')")
  .describe('Semantic version string');

/** Schema version for artifacts */
export const SchemaVersionSchema = z
  .number()
  .int()
  .positive()
  .describe('Schema version number for backward compatibility tracking');

/** Agent definition version */
export const AgentVersionSchema = z
  .string()
  .min(1)
  .max(64)
  .describe('Agent definition version string');

/** Event envelope version */
export const EventVersionSchema = z
  .number()
  .int()
  .positive()
  .describe('Event envelope version for schema evolution');

/** Message version for stream messages */
export const MessageVersionSchema = z.number().int().positive().describe('Stream message version');
