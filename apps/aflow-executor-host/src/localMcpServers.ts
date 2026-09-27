/**
 * MCP servers this machine will run.
 *
 * Declared in the machine's own policy for the same reason a harness is: the
 * executable is the thing that runs, so an appliance that could name it could
 * run anything. The workspace addresses a server by id and cannot introduce
 * one.
 *
 * A local server is confined by a binding like any other workload. That is what
 * makes it different from a remote MCP server, which is trusted to police its
 * own side of a network boundary: this one has the operator's filesystem
 * underneath it, so the binding decides what it can reach and the sandbox
 * enforces it rather than the server promising to behave.
 */
import { z } from 'zod';

export const LocalMcpServerSchema = z.object({
  id: z.string().min(1).describe('How a server definition addresses this server.'),
  executable: z
    .string()
    .min(1)
    .describe('Absolute path, or a name resolved against PATH on this machine.'),
  args: z.array(z.string()).default([]),
  /**
   * Which connected folder bounds it. Required, because a sandbox is always
   * compiled from some binding: leaving it out did not mean "reaches nothing",
   * it meant the request chose — read and write — which is exactly the decision
   * this file exists to keep on the machine.
   */
  bindingId: z.string().min(1),
  /** Read paths under the denied home region this server needs. */
  authPaths: z.array(z.string()).default([]),
  /** Hosts it may reach. Empty means no egress, as everywhere else here. */
  allowedDomains: z.array(z.string()).default([]),
  /** Extra environment names it may inherit from the executor. */
  inheritEnv: z.array(z.string()).default([]),
});
export type LocalMcpServer = z.infer<typeof LocalMcpServerSchema>;

export class LocalMcpServerError extends Error {
  constructor(
    message: string,
    readonly kind: 'unknown_server' | 'no_binding' | 'protocol',
  ) {
    super(message);
    this.name = 'LocalMcpServerError';
  }
}

export function requireLocalServer(
  servers: ReadonlyMap<string, LocalMcpServer>,
  serverId: string,
): LocalMcpServer {
  const server = servers.get(serverId);
  if (!server) {
    const known = [...servers.keys()].sort();
    throw new LocalMcpServerError(
      known.length === 0
        ? `No MCP server is configured on this machine. Add one to the host policy before addressing '${serverId}'.`
        : `Unknown MCP server '${serverId}' on this machine. Configured: ${known.join(', ')}.`,
      'unknown_server',
    );
  }
  return server;
}
