import { z } from 'zod';
import type { OperationRegistration } from '../catalog/operationCatalog.js';
import {
  GuardrailPolicySchema,
  GuardrailRailSchema,
  GuardrailScopeSchema,
  GuardrailPolicySettingsSchema,
} from '../guardrails/policy.js';
import { CompiledGuardrailSetSchema } from '../guardrails/compiled.js';
import { PaginationSchema } from './platform.js';

// ============================================================================
// Create Policy
// ============================================================================

export const GuardrailCreateInputSchema = GuardrailPolicySchema;
export type GuardrailCreateInput = z.infer<typeof GuardrailCreateInputSchema>;

export const GuardrailCreateOutputSchema = z.object({
  policyId: z.string(),
  createdAt: z.string().datetime(),
});
export type GuardrailCreateOutput = z.infer<typeof GuardrailCreateOutputSchema>;

// ============================================================================
// Get Policy
// ============================================================================

export const GuardrailGetInputSchema = z.object({
  policyId: z.string().min(1).max(128).describe('Guardrail policy ID'),
});
export type GuardrailGetInput = z.infer<typeof GuardrailGetInputSchema>;

export const GuardrailGetOutputSchema = GuardrailPolicySchema.extend({
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type GuardrailGetOutput = z.infer<typeof GuardrailGetOutputSchema>;

// ============================================================================
// Update Policy
// ============================================================================

export const GuardrailUpdateInputSchema = z.object({
  policyId: z.string().min(1).max(128).describe('Guardrail policy ID to update'),
  name: z.string().min(1).max(256).optional(),
  description: z.string().max(2000).optional(),
  version: z.string().max(64).optional(),
  scope: GuardrailScopeSchema.optional(),
  rails: z.array(GuardrailRailSchema).min(1).max(100).optional(),
  settings: GuardrailPolicySettingsSchema.optional(),
  tags: z.array(z.string().max(64)).max(20).optional(),
});
export type GuardrailUpdateInput = z.infer<typeof GuardrailUpdateInputSchema>;

export const GuardrailUpdateOutputSchema = z.object({
  policyId: z.string(),
  updatedAt: z.string().datetime(),
});
export type GuardrailUpdateOutput = z.infer<typeof GuardrailUpdateOutputSchema>;

// ============================================================================
// Delete Policy
// ============================================================================

export const GuardrailDeleteInputSchema = z.object({
  policyId: z.string().min(1).max(128).describe('Guardrail policy ID to delete'),
});
export type GuardrailDeleteInput = z.infer<typeof GuardrailDeleteInputSchema>;

export const GuardrailDeleteOutputSchema = z.object({
  policyId: z.string(),
  deleted: z.boolean(),
});
export type GuardrailDeleteOutput = z.infer<typeof GuardrailDeleteOutputSchema>;

// ============================================================================
// List Policies
// ============================================================================

export const GuardrailListInputSchema = PaginationSchema.extend({
  spaceId: z.string().max(128).optional(),
  tags: z.array(z.string().max(64)).optional(),
});
export type GuardrailListInput = z.infer<typeof GuardrailListInputSchema>;

export const GuardrailListOutputSchema = z.object({
  policies: z.array(
    z.object({
      policyId: z.string(),
      name: z.string(),
      description: z.string().optional(),
      version: z.string(),
      railCount: z.number().int().nonnegative(),
      tags: z.array(z.string()).optional(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }),
  ),
  total: z.number().int().nonnegative(),
});
export type GuardrailListOutput = z.infer<typeof GuardrailListOutputSchema>;

// ============================================================================
// Get Effective (compiled guardrail set for a flow)
// ============================================================================

export const GuardrailGetEffectiveInputSchema = z.object({
  flowId: z.string().min(1).max(128).describe('Flow ID to get effective guardrails for'),
});
export type GuardrailGetEffectiveInput = z.infer<typeof GuardrailGetEffectiveInputSchema>;

export const GuardrailGetEffectiveOutputSchema = CompiledGuardrailSetSchema;
export type GuardrailGetEffectiveOutput = z.infer<typeof GuardrailGetEffectiveOutputSchema>;

// ============================================================================
// Get Violations
// ============================================================================

export const GuardrailGetViolationsInputSchema = PaginationSchema.extend({
  runId: z.string().optional().describe('Filter by run ID'),
  policyId: z.string().optional().describe('Filter by policy ID'),
  railId: z.string().optional().describe('Filter by rail ID'),
});
export type GuardrailGetViolationsInput = z.infer<typeof GuardrailGetViolationsInputSchema>;

export const GuardrailGetViolationsOutputSchema = z.object({
  violations: z.array(
    z.object({
      runId: z.string(),
      stepExecutionId: z.string().optional(),
      policyId: z.string(),
      railId: z.string(),
      trigger: z.string(),
      violationType: z.string(),
      actionTaken: z.string(),
      detail: z.record(z.unknown()).optional(),
      durationMs: z.number(),
      createdAt: z.string().datetime(),
    }),
  ),
  total: z.number().int().nonnegative(),
});
export type GuardrailGetViolationsOutput = z.infer<typeof GuardrailGetViolationsOutputSchema>;

// ============================================================================
// Operation Registrations
// ============================================================================

export const GuardrailOperationRegistrations: OperationRegistration[] = [
  // ---------------------------------------------------------------------------
  // Policy CRUD (guardrail.policy.*)
  // ---------------------------------------------------------------------------
  {
    stepType: 'guardrail',
    group: 'policy',
    verb: 'create',
    name: 'Create Guardrail Policy',
    actionLabel: 'Creating guardrail policy…',
    semanticDescription: 'Create a new guardrail policy with rails, scope, and settings',
    tags: ['guardrail', 'crud'],
    crudView: { entityType: 'guardrail_policy', action: 'create' },
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Create a new guardrail policy with rules and scope.',
      whenToUse: [
        'Setting up content safety or compliance rules for a flow',
        'Adding budget, rate, or tool usage limits',
      ],
      whenNotToUse: [
        'Updating an existing policy — use guardrail.policy.update',
        'Checking current guardrails for a flow — use guardrail.policy.get_effective',
      ],
      minimalExampleInput: {
        policyId: 'content-safety',
        name: 'Content Safety Policy',
        scope: { platform: false, flowIds: ['my-agent-flow'] },
        rails: [
          {
            railId: 'block-bad-words',
            name: 'Blocklist Filter',
            layer: 'rule',
            trigger: 'on_agent_turn_output',
            mode: 'blocking',
            type: 'blocklist',
            config: { words: ['banned-word'] },
            onViolation: 'block',
          },
        ],
      },
    },
    accessMode: 'write',
    inputZod: GuardrailCreateInputSchema,
    outputZod: GuardrailCreateOutputSchema,
  },
  {
    stepType: 'guardrail',
    group: 'policy',
    verb: 'get',
    name: 'Get Guardrail Policy',
    actionLabel: 'Reading guardrail policy…',
    semanticDescription: 'Retrieve a guardrail policy by ID with all rails and settings',
    tags: ['guardrail', 'crud'],
    outputSemanticType: 'guardrail_policy',
    crudView: { entityType: 'guardrail_policy', action: 'read' },
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'Retrieve a guardrail policy by ID.',
      whenToUse: [
        'Inspecting a policy before modifying it',
        'Reviewing rails and scope configuration',
      ],
      whenNotToUse: ['Listing policies — use guardrail.policy.list'],
      minimalExampleInput: { policyId: 'content-safety' },
    },
    accessMode: 'read',
    inputZod: GuardrailGetInputSchema,
    outputZod: GuardrailGetOutputSchema,
  },
  {
    stepType: 'guardrail',
    group: 'policy',
    verb: 'update',
    name: 'Update Guardrail Policy',
    actionLabel: 'Updating guardrail policy…',
    semanticDescription: 'Update an existing guardrail policy (name, scope, rails, settings)',
    tags: ['guardrail', 'crud'],
    crudView: { entityType: 'guardrail_policy', action: 'update' },
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Update an existing guardrail policy.',
      whenToUse: [
        'Adding or modifying rails in a policy',
        'Changing the scope or settings of a policy',
      ],
      whenNotToUse: ['Creating a new policy — use guardrail.policy.create'],
      minimalExampleInput: { policyId: 'content-safety', name: 'Updated Policy Name' },
    },
    accessMode: 'write',
    inputZod: GuardrailUpdateInputSchema,
    outputZod: GuardrailUpdateOutputSchema,
  },
  {
    stepType: 'guardrail',
    group: 'policy',
    verb: 'delete',
    name: 'Delete Guardrail Policy',
    actionLabel: 'Deleting guardrail policy…',
    semanticDescription: 'Delete a guardrail policy',
    tags: ['guardrail', 'crud'],
    crudView: { entityType: 'guardrail_policy', action: 'delete' },
    idempotency: 'idempotent',
    mutates: true,
    usage: {
      oneLine: 'Delete a guardrail policy by ID.',
      whenToUse: ['Removing a policy that is no longer needed'],
      whenNotToUse: [
        'Temporarily disabling rails — set enabled: false on individual rails instead',
      ],
      pitfalls: ['Deleting a policy removes all its rails from affected flows'],
      minimalExampleInput: { policyId: 'content-safety' },
    },
    accessMode: 'write',
    inputZod: GuardrailDeleteInputSchema,
    outputZod: GuardrailDeleteOutputSchema,
  },
  {
    stepType: 'guardrail',
    group: 'policy',
    verb: 'list',
    name: 'List Guardrail Policies',
    actionLabel: 'Listing guardrail policies…',
    semanticDescription: 'List guardrail policies with optional filtering',
    tags: ['guardrail', 'crud'],
    crudView: { entityType: 'guardrail_policy', action: 'list' },
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'List guardrail policies with optional filtering and pagination.',
      whenToUse: ['Browsing available guardrail policies', 'Finding policies by tag or space'],
      whenNotToUse: ['Fetching a single policy — use guardrail.policy.get'],
      minimalExampleInput: {},
    },
    accessMode: 'read',
    inputZod: GuardrailListInputSchema,
    outputZod: GuardrailListOutputSchema,
  },
  {
    stepType: 'guardrail',
    group: 'policy',
    verb: 'get_effective',
    name: 'Get Effective Guardrails',
    actionLabel: 'Compiling effective guardrails…',
    semanticDescription:
      'Get the compiled effective guardrail set for a flow — merges all applicable policies by scope',
    tags: ['guardrail'],
    outputSemanticType: 'guardrail_policy',
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'Get compiled guardrails effective for a specific flow.',
      whenToUse: [
        'Checking which guardrails apply to a flow before running it',
        'Debugging guardrail behavior by inspecting compiled rails',
      ],
      whenNotToUse: ['Managing policies — use guardrail.policy.list/get/create/update'],
      minimalExampleInput: { flowId: 'my-agent-flow' },
    },
    accessMode: 'read',
    inputZod: GuardrailGetEffectiveInputSchema,
    outputZod: GuardrailGetEffectiveOutputSchema,
  },

  // ---------------------------------------------------------------------------
  // Violations (guardrail.violation.*)
  // ---------------------------------------------------------------------------
  {
    stepType: 'guardrail',
    group: 'violation',
    verb: 'list',
    name: 'List Guardrail Violations',
    actionLabel: 'Listing guardrail violations…',
    semanticDescription: 'List guardrail violations with filtering by run, policy, or rail',
    tags: ['guardrail'],
    outputSemanticType: 'guardrail_violations',
    crudView: { entityType: 'guardrail_violation', action: 'list' },
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'List guardrail violations filtered by run, policy, or rail.',
      whenToUse: [
        'Reviewing violations for a specific run',
        'Auditing which policies are triggering violations',
      ],
      whenNotToUse: ['Getting effective policies — use guardrail.policy.get_effective'],
      minimalExampleInput: { runId: 'run-uuid-here' },
    },
    accessMode: 'read',
    inputZod: GuardrailGetViolationsInputSchema,
    outputZod: GuardrailGetViolationsOutputSchema,
  },
];
