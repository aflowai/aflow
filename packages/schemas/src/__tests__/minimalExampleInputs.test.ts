import { describe, it, expect } from 'vitest';

import { AiOperationRegistrations } from '../operations/ai.js';
import { ApiOperationRegistrations } from '../operations/api.js';
import { MemoryOperationRegistrations } from '../operations/memory.js';
import { UserOperationRegistrations } from '../operations/user.js';
import { SearchOperationRegistrations } from '../operations/search.js';
import { ComputeOperationRegistrations } from '../operations/compute.js';
import { AgentOperationRegistrations } from '../operations/agentControl.js';
import { PlatformOperationRegistrations } from '../operations/platform.js';
import { GuardrailOperationRegistrations } from '../operations/guardrailOps.js';
import { UiOperationRegistrations } from '../operations/ui.js';
import { DesignSystemOperationRegistrations } from '../operations/designSystem.js';
import { McpOperationRegistrations } from '../operations/mcp.js';
import { ScheduleOperationRegistrations } from '../schedules/operations.js';
import { WebhookOperationRegistrations } from '../webhooks/operations.js';
import { WorkflowOperationRegistrations } from '../operations/workflow.js';
import { LearnerOperationRegistrations } from '../operations/learner.js';
import { ProposalOperationRegistrations } from '../operations/proposal.js';
import { SkillOperationRegistrations } from '../operations/skill.js';
import { ComposeSkillOperationRegistrations } from '../operations/composeSkillOps.js';
import { CapabilityOperationRegistrations } from '../operations/capability.js';
import { EvalOperationRegistrations } from '../operations/evalOps.js';
import { EvalBatchOperationRegistrations } from '../operations/evalBatchOps.js';
import { SimulationOperationRegistrations } from '../operations/simulation.js';

import type { OperationRegistration } from '../catalog/operationCatalog.js';

const ALL_REGISTRATIONS: OperationRegistration[] = [
  ...AiOperationRegistrations,
  ...ApiOperationRegistrations,
  ...MemoryOperationRegistrations,
  ...UserOperationRegistrations,
  ...SearchOperationRegistrations,
  ...ComputeOperationRegistrations,
  ...AgentOperationRegistrations,
  ...PlatformOperationRegistrations,
  ...GuardrailOperationRegistrations,
  ...UiOperationRegistrations,
  ...DesignSystemOperationRegistrations,
  ...McpOperationRegistrations,
  ...ScheduleOperationRegistrations,
  ...WebhookOperationRegistrations,
  ...WorkflowOperationRegistrations,
  ...LearnerOperationRegistrations,
  ...ProposalOperationRegistrations,
  ...SkillOperationRegistrations,
  ...ComposeSkillOperationRegistrations,
  ...CapabilityOperationRegistrations,
  ...EvalOperationRegistrations,
  ...EvalBatchOperationRegistrations,
  ...SimulationOperationRegistrations,
];

describe('OperationRegistration.usage.minimalExampleInput parses against inputZod', () => {
  for (const reg of ALL_REGISTRATIONS) {
    const id = `${reg.stepType}.${reg.group ?? '_'}.${reg.verb}`;
    const example = reg.usage?.minimalExampleInput;
    const hasExample = example !== undefined && Object.keys(example).length > 0;

    if (!hasExample) {
      // Some registrations have no usage block (internal/untyped); skip silently.
      continue;
    }

    // `internalFields.input` lists fields the orchestrator injects at runtime
    // (history, tool surface, turn counters, …). They are correctly absent from
    // the author-facing example, so we can't validate this op's example against
    // the full input schema without adding mock orchestrator state.
    const hasInternalInputs = (reg.internalFields?.input ?? []).length > 0;
    if (hasInternalInputs) {
      continue;
    }

    it(`${id}`, () => {
      const result = reg.inputZod.safeParse(example);
      if (!result.success) {
        throw new Error(`${id} minimalExampleInput failed inputZod parse: ${result.error.message}`);
      }
    });
  }
});
