import { z } from 'zod';
import { PersistentAgentTargetSchema } from '../runtime/agentTarget.js';

export const CatalogToolSearchOutputSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('directory'),
    guidance: z.string(),
    stepTypes: z.array(
      z.object({
        stepType: z.string(),
        operationCount: z.number(),
        groups: z.array(z.object({ groupId: z.string(), count: z.number() })),
      }),
    ),
    totalOperations: z.number(),
  }),
  z.object({
    mode: z.literal('search'),
    discovered: z.array(
      z.object({
        operationId: z.string().optional(),
        target: PersistentAgentTargetSchema.optional(),
        slug: z
          .string()
          .optional()
          .describe("A custom agent's handle, which catalog.tool.promote takes as agent:<slug>"),
        toolId: z.string().optional(),
        callName: z.string().optional(),
        type: z.enum(['platform', 'agent', 'api', 'mcp']),
        name: z.string().optional(),
        description: z.string(),
        matchReason: z.string(),
        apiId: z.string().optional(),
        serverId: z.string().optional(),
        opTaskOnly: z.boolean().optional(),
        caution: z.string().optional(),
      }),
    ),
    count: z.number(),
    query: z.string().optional(),
    promotion: z.string(),
    suggestedPromoteCall: z
      .object({
        operation: z.literal('catalog.tool.promote'),
        input: z.object({
          toolIds: z.array(z.string()),
        }),
      })
      .optional(),
  }),
]);
