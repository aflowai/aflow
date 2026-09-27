/**
 * Permission schemas for step and operation access control.
 */
import { z } from 'zod';

// ============================================================================
// Permission Scopes
// ============================================================================

/**
 * Permission scope for operations.
 */
export const PermissionScopeSchema = z.enum([
  /** Access to tenant-level resources */
  'tenant',
  /** Access to space-level resources */
  'space',
  /** Access to run-level resources */
  'run',
  /** Access to user-level resources */
  'user',
  /** Platform/admin-level access */
  'platform',
]);

export type PermissionScope = z.infer<typeof PermissionScopeSchema>;

/**
 * Permission action types.
 */
export const PermissionActionSchema = z.enum([
  'read',
  'write',
  'delete',
  'execute',
  'approve',
  'admin',
]);

export type PermissionAction = z.infer<typeof PermissionActionSchema>;

/**
 * Resource type for permission scoping.
 */
export const ResourceTypeSchema = z.enum([
  'flow',
  'run',
  'step',
  'memory',
  'api_config',
  'secret',
  'model',
  'space',
  'tenant',
]);

export type ResourceType = z.infer<typeof ResourceTypeSchema>;

// ============================================================================
// Permission Requirements
// ============================================================================

/**
 * A single permission requirement.
 */
export const PermissionRequirementSchema = z.object({
  /** Resource type this permission applies to */
  resource: ResourceTypeSchema,
  /** Required action */
  action: PermissionActionSchema,
  /** Scope level */
  scope: PermissionScopeSchema,
  /** Optional: specific resource identifier pattern (glob) */
  resourcePattern: z.string().max(256).optional(),
});

export type PermissionRequirement = z.infer<typeof PermissionRequirementSchema>;

/**
 * Collection of permissions required for an operation.
 */
export const PermissionSetSchema = z.object({
  /** Required permissions (all must be satisfied) */
  required: z.array(PermissionRequirementSchema).default([]),
  /** Optional permissions (enhance capability if present) */
  optional: z.array(PermissionRequirementSchema).default([]),
});

export type PermissionSet = z.infer<typeof PermissionSetSchema>;
