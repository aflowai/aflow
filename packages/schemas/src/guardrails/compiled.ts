/**
 * Compiled guardrail set — the hot-cache representation.
 * Built by the policy compiler from one or more GuardrailPolicy instances.
 */
import { z } from 'zod';
import {
  GuardrailLayerSchema,
  GuardrailModeSchema,
  GuardrailViolationActionSchema,
  GuardrailFailBehaviorSchema,
} from './policy.js';

export const CompiledRailSchema = z.object({
  railId: z.string(),
  policyId: z.string(),
  layer: GuardrailLayerSchema,
  mode: GuardrailModeSchema,
  type: z.string(),
  config: z.record(z.unknown()),
  onViolation: GuardrailViolationActionSchema,
  violationMessage: z.string().optional(),
  priority: z.number().int(),
  failBehavior: GuardrailFailBehaviorSchema,
});
export type CompiledRail = z.infer<typeof CompiledRailSchema>;

export const CompiledGuardrailSetSchema = z.object({
  byTrigger: z.object({
    on_run_input: z.array(CompiledRailSchema),
    on_agent_turn_input: z.array(CompiledRailSchema),
    on_agent_turn_output: z.array(CompiledRailSchema),
    on_tool_input: z.array(CompiledRailSchema),
    on_tool_output: z.array(CompiledRailSchema),
    on_run_output: z.array(CompiledRailSchema),
    on_user_message: z.array(CompiledRailSchema),
  }),
  version: z.string(),
  compiledAtMs: z.number(),
  policyIds: z.array(z.string()),
});
export type CompiledGuardrailSet = z.infer<typeof CompiledGuardrailSetSchema>;
