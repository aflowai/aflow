import { z } from 'zod';
import { CapabilityEntrySchema } from './runAccessGrant.js';
import { SpaceRoleSchema } from '../identity/user.js';

// ============================================================================
// Capability Profile
// ============================================================================

export const CapabilityProfileSchema = z.object({
  /** Profile ID */
  id: z.string().uuid(),
  /** Human-readable name (e.g., "Full Access", "Standard", "Read Only") */
  name: z.string().min(1).max(100),
  /** Description for admins */
  description: z.string().max(500).nullable(),
  /** Allowed capability group + access mode pairs */
  allowedCapabilities: z.array(CapabilityEntrySchema),
  /** Explicitly denied capability group + access mode pairs (higher priority) */
  deniedCapabilities: z.array(CapabilityEntrySchema),
  /** Allowed risk modifiers (e.g., ['external_side_effect']) */
  allowedRiskModifiers: z.array(z.string()),
  /** Denied risk modifiers */
  deniedRiskModifiers: z.array(z.string()),
  /** Allow privileged operations */
  allowPrivileged: z.boolean(),
  /** Whether this is a tenant default profile */
  isDefault: z.boolean(),
  /** Whether this is a system-seeded profile (immutable) */
  isSystemProfile: z.boolean(),
  /**
   * Which space role this profile is the default for.
   * Null = not a role default. Only one profile per role can be default.
   */
  defaultForRole: SpaceRoleSchema.nullable(),
  /** When this profile was created */
  createdAt: z.string().datetime(),
  /** When this profile was last updated */
  updatedAt: z.string().datetime(),
});

export type CapabilityProfile = z.infer<typeof CapabilityProfileSchema>;

// ============================================================================
// Space Capability Assignment
// ============================================================================

export const SpaceCapabilityAssignmentSchema = z.object({
  /** Assignment ID */
  id: z.string().uuid(),
  /** Space this assignment applies to */
  spaceId: z.string().uuid(),
  /** Profile assigned to this space */
  profileId: z.string().uuid(),
  /** Who assigned this profile */
  assignedBy: z.string().uuid().nullable(),
  /** When this assignment was made */
  assignedAt: z.string().datetime(),
});

export type SpaceCapabilityAssignment = z.infer<typeof SpaceCapabilityAssignmentSchema>;

// ============================================================================
// API Request Schemas
// ============================================================================

export const CreateCapabilityProfileSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  allowedCapabilities: z.array(CapabilityEntrySchema),
  deniedCapabilities: z.array(CapabilityEntrySchema).default([]),
  allowedRiskModifiers: z.array(z.string()).default([]),
  deniedRiskModifiers: z.array(z.string()).default([]),
  allowPrivileged: z.boolean().default(false),
  isDefault: z.boolean().default(false),
  defaultForRole: SpaceRoleSchema.nullable().default(null),
});

export type CreateCapabilityProfileInput = z.infer<typeof CreateCapabilityProfileSchema>;

export const UpdateCapabilityProfileSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  allowedCapabilities: z.array(CapabilityEntrySchema).optional(),
  deniedCapabilities: z.array(CapabilityEntrySchema).optional(),
  allowedRiskModifiers: z.array(z.string()).optional(),
  deniedRiskModifiers: z.array(z.string()).optional(),
  allowPrivileged: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  defaultForRole: SpaceRoleSchema.nullable().optional(),
});

export type UpdateCapabilityProfileInput = z.infer<typeof UpdateCapabilityProfileSchema>;

export const AssignCapabilityProfileSchema = z.object({
  profileId: z.string().uuid(),
});

export type AssignCapabilityProfileInput = z.infer<typeof AssignCapabilityProfileSchema>;
