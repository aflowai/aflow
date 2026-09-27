import { z } from 'zod';
import type { OperationRegistration } from '../catalog/operationCatalog.js';
import { ApiDefinitionDraftSchema } from '../cybernetic/stagedChange.js';
import { DesignSurfaceSchema, TaskGraphDraftSchema } from '../cybernetic/composeSkill.js';

export const CapabilityBindingProposeInputSchema = z.object({
  apiDefinition: ApiDefinitionDraftSchema,
});
export type CapabilityBindingProposeInput = z.infer<typeof CapabilityBindingProposeInputSchema>;

export const CapabilityBindingProposeOutputSchema = z.object({
  proposalId: z.string().uuid(),
  apiId: z.string(),
  status: z.literal('proposed'),
  endpointCount: z.number().int(),
  authKind: z.string(),
});
export type CapabilityBindingProposeOutput = z.infer<typeof CapabilityBindingProposeOutputSchema>;

// ============================================================================

export const CapabilityValidateGrantsInputSchema = z
  .object({
    draft: TaskGraphDraftSchema,
    surface: DesignSurfaceSchema,
  })
  .strict();
export type CapabilityValidateGrantsInput = z.infer<typeof CapabilityValidateGrantsInputSchema>;

export const CapabilityValidateGrantsOutputSchema = z
  .object({
    valid: z.literal(true),
  })
  .strict();
export type CapabilityValidateGrantsOutput = z.infer<typeof CapabilityValidateGrantsOutputSchema>;

export const CapabilityOperationRegistrations: OperationRegistration[] = [
  {
    stepType: 'capability',
    group: 'binding',
    verb: 'propose',
    name: 'Propose Capability Binding',
    actionLabel: 'Validating and proposing API binding…',
    semanticDescription:
      'Validate the API definition draft and emit a capability_binding StagedChange proposal for operator review. Final task in the bind-capability workflow.',
    tags: ['capability', 'binding', 'cybernetic'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Validate and propose an API definition for operator ratification.',
      whenToUse: ['As the final task in the bind-capability workflow after draft-definition'],
      whenNotToUse: ['Directly — this is called by the workflow engine, not by agents'],
      minimalExampleInput: {
        apiDefinition: {
          name: 'Example API',
          baseUrl: 'https://api.example.com',
          authKind: 'none',
          endpoints: [
            {
              method: 'GET',
              path: '/status',
              summary: 'Service health check',
            },
          ],
        },
      },
    },
    accessMode: 'write',
    inputZod: CapabilityBindingProposeInputSchema,
    outputZod: CapabilityBindingProposeOutputSchema,
    internal: true,
  },
  // ==========================================================================
  {
    stepType: 'capability',
    group: 'validate',
    verb: 'grants',
    name: 'Validate Capability Grants',
    actionLabel: 'Validating capability grants against design surface…',
    semanticDescription:
      'Graph node — verifies that every capability the draft grants is bound by the prepared design surface. Endpoint/tool subsets check against the supplied DesignSurface, not current space DB state. Emits FAILED with one ContractError per unbound apiId/serverId, missing bindingId, empty endpoints, or out-of-set endpoint/tool (all blame=producer-contract, source.bindAs=draft) so the rerun routes back to draft-task-graph.',
    tags: ['capability', 'validation', 'cybernetic', 'platform-123'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'Validate that draft grants subset the prepared DesignSurface.',
      whenToUse: ['Between draft-task-graph and assemble-workflow in compose-skill.'],
      whenNotToUse: ['Directly — emitted by the compose-skill graph compiler, not by agents.'],
      pitfalls: [],
      minimalExampleInput: {
        draft: {
          slug: 'echo',
          name: 'Echo',
          description: 'Echo a message back.',
          goal: 'Read input, return it unchanged.',
          outcomes: [
            {
              id: 'echoed',
              name: 'Echoed',
              evaluator: { type: 'manual', instruction: 'Output equals input.' },
            },
          ],
          tasks: [
            {
              type: 'agent',
              kind: 'transformer',
              taskId: 'echo',
              goal: 'Echo the message back.',
            },
          ],
        },
        surface: {
          integrations: [],
          operations: [],
          policies: { compute: false },
          bindableButUnbound: [],
        },
      },
    },
    accessMode: 'read',
    inputZod: CapabilityValidateGrantsInputSchema,
    outputZod: CapabilityValidateGrantsOutputSchema,
    internal: true,
    agentTool: false,
    bypassGrant: true,
  },
];
