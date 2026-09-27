// ============================================================================
// Access Mode
// ============================================================================

/** The coarse permission mode admins reason about. */
export type CapabilityAccessMode = 'read' | 'write';

// ============================================================================
// Risk Modifiers
// ============================================================================

/**
 * Small orthogonal layer for dangerous subclasses of operations.
 * These are NOT part of the capability group ID — they are separate flags.
 */
export const RISK_MODIFIERS = [
  /** Operation is privileged (platform/flow management, admin-only) */
  'privileged',
  /** Operation causes side effects outside Phoenix (HTTP calls, emails) */
  'external_side_effect',
  /** Operation requires admin-level trust */
  'admin',
] as const;

export type RiskModifier = (typeof RISK_MODIFIERS)[number];
