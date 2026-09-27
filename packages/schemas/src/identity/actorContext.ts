/**
 * Actor context and audit event schemas.
 *
 * The **ActorContext** captures the identity, authentication method, and
 * authorization state of the entity performing an action. It is attached to
 * every request, stream message, and audit event so that any operation can
 * be traced back to a specific actor.
 *
 * **AuditEvent** provides a structured record of security-relevant actions
 * for compliance and forensic analysis.
 */
import { z } from 'zod';

// ============================================================================
// Actor Kind & Auth Method
// ============================================================================

export const ActorKindSchema = z.enum([
  'human', // Interactive user (web, CLI, MCP)
  'service_principal', // Machine-to-machine (API key, client credentials)
  'system', // Internal system operations (timers, DLQ recovery, migrations)
]);
export type ActorKind = z.infer<typeof ActorKindSchema>;

export const AuthMethodSchema = z.enum([
  'jwt', // OIDC JWT (Auth0 access token)
  'api_key', // Phoenix API key (phx_...)
  'session', // Web session cookie (BFF)
  'device', // Device authorization grant (CLI/MCP)
  'system', // Internal (no external auth)
  'local', // Local appliance instance identity (single-user edition)
  'dev_bypass', // Development mode only
]);
export type AuthMethod = z.infer<typeof AuthMethodSchema>;

// ============================================================================
// Actor Context
// ============================================================================

export const ActorContextSchema = z.object({
  /** Internal Phoenix user ID (from users table) */
  userId: z.string().uuid(),

  /** Actor kind */
  kind: ActorKindSchema,

  /** Authentication method used */
  authMethod: AuthMethodSchema,

  /** Tenant ID the actor is operating within */
  tenantId: z.string().uuid(),

  /** Tenant role at the time of the action */
  tenantRole: z.string(),

  /** Space ID (if the action is space-scoped) */
  spaceId: z.string().uuid().optional(),

  /** Space role at the time of the action (if space-scoped) */
  spaceRole: z.string().optional(),

  /** Display name (for logs/UI, not for authorization) */
  displayName: z.string().optional(),

  /** Email (for logs/UI, not for authorization) */
  email: z.string().email().optional(),

  /** IP address of the request origin */
  ipAddress: z.string().optional(),

  /** User-Agent string */
  userAgent: z.string().optional(),

  /** API key prefix (if authenticated via API key, for identification) */
  apiKeyPrefix: z.string().optional(),

  /** OpenTelemetry trace ID (for cross-service correlation) */
  traceId: z.string().optional(),

  /** Timestamp when the context was captured (ISO 8601) */
  capturedAt: z.string().datetime(),
});

export type ActorContext = z.infer<typeof ActorContextSchema>;

// ============================================================================
// Audit Event
// ============================================================================

export const AuditEventCategorySchema = z.enum([
  'auth', // Login, logout, token refresh, failed auth
  'authz', // Permission grants, denials, role changes
  'resource', // CRUD on flows, runs, memory, API configs
  'admin', // Tenant/user management, invite, membership changes
  'security', // Suspicious activity, rate limits, key revocation
]);
export type AuditEventCategory = z.infer<typeof AuditEventCategorySchema>;

export const AuditEventOutcomeSchema = z.enum(['success', 'failure', 'denied']);
export type AuditEventOutcome = z.infer<typeof AuditEventOutcomeSchema>;

export const AuditEventSchema = z.object({
  /** Unique event identifier */
  id: z.string().uuid(),

  /** When the event occurred */
  timestamp: z.string().datetime(),

  /** Actor who performed the action */
  actor: ActorContextSchema,

  /** Event category */
  category: AuditEventCategorySchema,

  /** Specific action */
  action: z.string(),

  /** Outcome */
  outcome: AuditEventOutcomeSchema,

  /** Target resource */
  target: z
    .object({
      resourceType: z.string(),
      resourceId: z.string().optional(),
      tenantId: z.string().uuid().optional(),
      spaceId: z.string().uuid().optional(),
    })
    .optional(),

  /** Additional context */
  details: z.record(z.unknown()).optional(),

  /** Error information (for failures) */
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),

  /** HTTP request metadata */
  request: z
    .object({
      method: z.string(),
      path: z.string(),
      ipAddress: z.string().optional(),
      userAgent: z.string().optional(),
    })
    .optional(),
});

export type AuditEvent = z.infer<typeof AuditEventSchema>;
