import { z } from 'zod';

/**
 * One bound connection as the space's connection listing reports it, and the
 * contract the composer's placement panel reads.
 *
 * Shared rather than mirrored in the client: the panel decides what an operator
 * may pin and what it costs them per turn, so a client-side restatement of this
 * shape would keep compiling after the route changed and quietly price the
 * wrong thing.
 */
export const SpaceConnectionSchema = z.object({
  sourceKind: z.enum(['api', 'mcp']),
  integrationId: z.string(),
  bindingId: z.string(),
  label: z.string(),
  /** Tools this connection pins when `always_on`. */
  toolCount: z.number(),
  /** Per-turn cost if this connection is `always_on` with every tool pinned. */
  alwaysOnTokens: z.number(),
  /**
   * The connection's tools, so an operator can pin a subset and price it. The
   * `name` is what `pinnedToolNames` stores — the endpoint id for an API, the
   * tool name for MCP.
   */
  tools: z.array(z.object({ name: z.string(), label: z.string(), tokens: z.number() })),
  /**
   * Whether `always_on` would put anything on the agent's surface. False
   * carries `blockedReason`: a disabled binding or an empty tool cache pins
   * zero tools, and a switch that silently does nothing is worse than one that
   * says why.
   */
  pinnable: z.boolean(),
  blockedReason: z.string().optional(),
});

export type SpaceConnection = z.infer<typeof SpaceConnectionSchema>;
