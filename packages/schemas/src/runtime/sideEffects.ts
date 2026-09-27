/**
 * Side effect classification schemas.
 * Every step/operation must declare its side effect classification.
 */
import { z } from 'zod';

// ============================================================================
// Side Effect Classification
// ============================================================================

/**
 * Side effect classification for steps and operations.
 * Determines what security policies and approvals are required.
 */
export const SideEffectClassSchema = z.enum([
  /** No side effects - pure computation or read from immutable sources */
  'NONE',
  /** Read-only access to mutable state (databases, APIs) */
  'READ_ONLY',
  /** Write access to mutable state (creates, updates) */
  'WRITE',
  /** Destructive or irreversible operations (deletes, sends) */
  'DESTRUCTIVE',
]);

export type SideEffectClass = z.infer<typeof SideEffectClassSchema>;

/**
 * Detailed side effect declaration for governance.
 */
export const SideEffectDeclarationSchema = z.object({
  /** Primary classification */
  classification: SideEffectClassSchema,

  /** Human-readable description of the side effect */
  description: z.string().max(500).optional(),

  /** Whether this operation is idempotent (safe to retry) */
  idempotent: z.boolean().default(false),

  /** Whether this operation is reversible */
  reversible: z.boolean().default(false),

  /** External systems affected */
  affectedSystems: z.array(z.string().max(128)).default([]),

  opTaskOnly: z.boolean().default(false),
});

export type SideEffectDeclaration = z.infer<typeof SideEffectDeclarationSchema>;

// ============================================================================
// Policy Helpers
// ============================================================================

/**
 * Determines if a side effect class requires approval by default.
 */
export function requiresDefaultApproval(classification: SideEffectClass): boolean {
  return classification === 'DESTRUCTIVE';
}

/**
 * Determines if a side effect class is safe for retry.
 */
export function isSafeForRetry(classification: SideEffectClass): boolean {
  return classification === 'NONE' || classification === 'READ_ONLY';
}
