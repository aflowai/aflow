import { z } from 'zod';

// ============================================================================
// Rail Trigger Points
// ============================================================================

export const GuardrailTriggerSchema = z.enum([
  'on_run_input',
  'on_agent_turn_input',
  'on_agent_turn_output',
  'on_tool_input',
  'on_tool_output',
  'on_run_output',
  'on_user_message',
]);
export type GuardrailTrigger = z.infer<typeof GuardrailTriggerSchema>;

// ============================================================================
// Rail Execution Mode
// ============================================================================

export const GuardrailModeSchema = z.enum(['blocking', 'parallel', 'async', 'advisory']);
export type GuardrailMode = z.infer<typeof GuardrailModeSchema>;

// ============================================================================
// Rail Type (Layer 1 only in Phase 1)
// ============================================================================

export const GuardrailRailTypeSchema = z.enum([
  // Layer 1: Rule-based (Phase 1)
  'blocklist',
  'allowlist',
  'regex_filter',
  'pii_detect_regex',
  'length_limit',
  'rate_limit',
  'budget_limit',
  'tool_allowlist',
  'tool_denylist',
  'argument_constraint',
  // Layer 2: Classifier (Phase 3 — validated but not executed in Phase 1)
  'content_safety',
  'jailbreak_detect',
  'topic_boundary',
  'sentiment_gate',
  'pii_detect_model',
  'custom_classifier',
  // Layer 3: LLM Verify (Phase 5 — validated but not executed in Phase 1)
  'factuality_check',
  'policy_compliance',
  'reasoning_review',
  'action_review',
  'output_review',
]);
export type GuardrailRailType = z.infer<typeof GuardrailRailTypeSchema>;

export const GuardrailLayerSchema = z.enum(['rule', 'classifier', 'llm_verify']);
export type GuardrailLayer = z.infer<typeof GuardrailLayerSchema>;

// ============================================================================
// Violation Action
// ============================================================================

export const GuardrailViolationActionSchema = z.enum([
  'block',
  'block_with_retry',
  'redact',
  'warn',
  'escalate',
]);
export type GuardrailViolationAction = z.infer<typeof GuardrailViolationActionSchema>;

// ============================================================================
// Fail Behavior
// ============================================================================

export const GuardrailFailBehaviorSchema = z.enum(['fail_closed', 'fail_open']);
export type GuardrailFailBehavior = z.infer<typeof GuardrailFailBehaviorSchema>;

// ============================================================================
// Rail Definition (inside a policy)
// ============================================================================

export const GuardrailRailSchema = z.object({
  railId: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  layer: GuardrailLayerSchema,
  trigger: GuardrailTriggerSchema,
  mode: GuardrailModeSchema,
  type: GuardrailRailTypeSchema,
  config: z.record(z.unknown()),
  onViolation: GuardrailViolationActionSchema,
  violationMessage: z.string().max(4000).optional(),
  priority: z.number().int().min(0).max(10000).default(100),
  enabled: z.boolean().default(true),
  failBehavior: GuardrailFailBehaviorSchema.optional(),
  timeoutMs: z.number().int().positive().max(30000).optional(),
});
export type GuardrailRail = z.infer<typeof GuardrailRailSchema>;

// ============================================================================
// Policy Scope
// ============================================================================

export const GuardrailScopeSchema = z.object({
  platform: z.boolean().default(false),
  tenantIds: z.array(z.string().max(128)).optional(),
  spaceIds: z.array(z.string().max(128)).optional(),
  flowIds: z.array(z.string().max(128)).optional(),
  stepIds: z.array(z.string().max(128)).optional(),
  operationIds: z.array(z.string().max(128)).optional(),
});
export type GuardrailScope = z.infer<typeof GuardrailScopeSchema>;

// ============================================================================
// Policy Log Mode
// ============================================================================

export const GuardrailLogModeSchema = z.enum(['violations_only', 'all', 'sampled']);
export type GuardrailLogMode = z.infer<typeof GuardrailLogModeSchema>;

// ============================================================================
// Policy Settings
// ============================================================================

export const GuardrailPolicySettingsSchema = z.object({
  defaultFailBehavior: GuardrailFailBehaviorSchema.default('fail_closed'),
  maxLatencyMs: z.number().int().positive().default(5000),
  logMode: GuardrailLogModeSchema.default('violations_only'),
  logSampleRate: z.number().min(0).max(1).default(0.1),
});
export type GuardrailPolicySettings = z.infer<typeof GuardrailPolicySettingsSchema>;

// ============================================================================
// Guardrail Policy (top-level entity)
// ============================================================================

export const GuardrailPolicySchema = z.object({
  policyId: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  description: z.string().max(2000).optional(),
  version: z.string().max(64).default('1'),
  scope: GuardrailScopeSchema,
  rails: z.array(GuardrailRailSchema).min(1).max(100),
  settings: GuardrailPolicySettingsSchema.default({}),
  tags: z.array(z.string().max(64)).max(20).optional(),
});
export type GuardrailPolicy = z.infer<typeof GuardrailPolicySchema>;
