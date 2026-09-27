/**
 * Host bindings — which folders on the operator's machine a space may reach.
 *
 * Operator-authored, never agent-authored. A run that could create one of these
 * would be choosing its own reach, which is the property the whole lane rests
 * on, so these are space-admin routes and no operation writes them.
 *
 * What a row here grants is half the authority. The paired executor keeps its
 * own policy outside any job-writable path, and the effective grant is the
 * intersection — a binding declared here that the machine does not offer
 * reaches nothing.
 */
import { createTenantContext, withTenantSchema, hostBindings } from '@aflow/database';
import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { HostBranchPrefixSchema, type EditionDescriptor } from '@aflow/schemas';
import {
  getRedisConnection,
  HOST_WITHDRAWAL_CHANNEL,
  type HostWithdrawalNotice,
} from '@aflow/redis';

/**
 * Whether this deployment can serve host work at all.
 *
 * The descriptor's own answer, so this route and the tool surface composed for
 * the same process cannot come apart. It is keyed on the host credential rather
 * than on an edition label, because that is the thing that actually decides it.
 *
 * Connecting a folder where nothing can serve it produced a binding that looked
 * real, appeared in space context, and failed at dispatch — a footgun that grew
 * teeth once `Full Access` started carrying the host capabilities.
 */
function hostLaneAvailable(edition: EditionDescriptor): boolean {
  return edition.hostLane === 'present';
}

const HOST_LANE_UNAVAILABLE = {
  error: 'HostLaneUnavailable',
  message:
    'This deployment has no host lane, so a folder connected here could never be reached. ' +
    'Host execution belongs to the local edition, where the machine and the instance are ' +
    'the same operator.',
} as const;

const LocalMcpToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
});

const LocalMcpServerRefSchema = z.object({
  id: z.string(),
  label: z.string(),
  tools: z.array(LocalMcpToolSchema).optional(),
});

const HostBindingSchema = z.object({
  hostBindingId: z.string(),
  label: z.string(),
  root: z.string(),
  writable: z.boolean(),
  allowsExecution: z.boolean(),
  /** Null means the folder pushes nothing, which is every folder by default. */
  branchPrefix: z.string().nullable().default(null),
  mcpServers: z.array(LocalMcpServerRefSchema).default([]),
});

const CreateBody = z.object({
  hostBindingId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_-]+$/, 'Lowercase letters, digits, hyphen and underscore.')
    .describe('The same id this folder has in the host policy file.'),
  label: z.string().min(1).max(120),
  root: z.string().min(1).max(1024).describe('Absolute path, as it is on the operator machine.'),
  writable: z.boolean().default(false),
  allowsExecution: z
    .boolean()
    .default(false)
    .describe('Whether commands may run here. A folder is readable without being a shell.'),
  branchPrefix: HostBranchPrefixSchema.optional(),
  mcpServers: z
    .array(
      z.object({
        id: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9_-]+$/, 'Lowercase letters, digits, hyphen and underscore.'),
        label: z.string().min(1).max(120),
        tools: z
          .array(
            z.object({
              name: z.string().min(1).max(128),
              description: z.string().max(2000).optional(),
              inputSchema: z.record(z.string(), z.unknown()).optional(),
            }),
          )
          .max(200)
          .optional()
          .describe(
            'What the server said it can do, as the machine heard it. Recorded because the ' +
              'appliance cannot reach the machine to ask.',
          ),
      }),
    )
    .max(32)
    .default([])
    .describe(
      'MCP servers the machine offers in this folder — ids and names only. What an id runs ' +
        "is in the machine's own policy, which this cannot reach.",
    ),
});

const spaceParams = z.object({ spaceId: z.string().uuid() });
const bindingParams = spaceParams.extend({ hostBindingId: z.string() });
const ErrorSchema = z.object({ error: z.string(), message: z.string() });

export const hostBindingRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  async function inTenant<T>(
    tenantId: string,
    run: (tx: PostgresJsDatabase) => Promise<T>,
  ): Promise<T> {
    const db = fastify.appContext.db as PostgresJsDatabase;
    return (await withTenantSchema(
      db,
      createTenantContext(tenantId as never),
      async (tx: unknown) => run(tx as PostgresJsDatabase),
    )) as T;
  }

  app.get(
    '/:spaceId/host-bindings',
    {
      config: {
        authz: {
          resource: 'space',
          action: 'read',
          spaceIdFrom: 'param',
          resourceIdFrom: 'param',
          resourceIdParam: 'spaceId',
        },
      },
      schema: {
        tags: ['Host'],
        summary: 'List the folders this space may reach on the operator machine',
        params: spaceParams,
        response: { 200: z.object({ bindings: z.array(HostBindingSchema) }) },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      await request.requireSpace();
      const rows = await inTenant(tenant.tenantId, (tx) =>
        tx.select().from(hostBindings).where(eq(hostBindings.spaceId, request.params.spaceId)),
      );
      return reply.send({ bindings: rows.map((r) => HostBindingSchema.parse(r)) });
    },
  );

  app.post(
    '/:spaceId/host-bindings',
    {
      config: {
        authz: {
          resource: 'space',
          action: 'admin',
          spaceIdFrom: 'param',
          resourceIdFrom: 'param',
          resourceIdParam: 'spaceId',
        },
      },
      schema: {
        tags: ['Host'],
        summary:
          'Connect a folder on the operator machine to this space, or update how it is connected',
        params: spaceParams,
        body: CreateBody,
        response: { 200: HostBindingSchema, 400: ErrorSchema, 503: ErrorSchema },
      },
    },
    async (request, reply) => {
      if (!hostLaneAvailable(fastify.edition)) {
        return await reply.status(503).send(HOST_LANE_UNAVAILABLE);
      }
      const tenant = await request.requireTenant();
      await request.requireSpace();
      const body = request.body;

      // A server is a program, and running one needs the execution grant. A
      // folder offering servers it can never run publishes named tools to the
      // agent surface that are refused at the moment of use — the worst shape
      // for a capability, since the agent spends a turn discovering it.
      if (body.mcpServers.length > 0 && !body.allowsExecution) {
        return await reply.status(400).send({
          error: 'HostBindingInconsistent',
          message:
            'This folder offers MCP servers but does not allow commands, so none of them ' +
            'could ever run. Connect it with execution allowed, or without the servers.',
        });
      }

      // A push is a command too, so a prefix on a folder that runs nothing
      // declares an authority that could never be exercised.
      if (body.branchPrefix !== undefined && !body.allowsExecution) {
        return await reply.status(400).send({
          error: 'HostBindingInconsistent',
          message:
            'This folder declares a branch prefix but does not allow commands, and a push is ' +
            'a command. Connect it with execution allowed, or without the prefix.',
        });
      }

      const existing = await inTenant(tenant.tenantId, (tx) =>
        tx
          .select()
          .from(hostBindings)
          .where(
            and(
              eq(hostBindings.spaceId, request.params.spaceId),
              eq(hostBindings.hostBindingId, body.hostBindingId),
            ),
          ),
      );
      // Reconnecting is how a folder's permissions change and how a local MCP
      // server's tool list is refreshed, and the machine half is rewritten in
      // place. Refusing here left the two halves disagreeing: the machine
      // updated, the workspace still describing the old grant.
      if (existing.length > 0) {
        const [updated] = await inTenant(tenant.tenantId, (tx) =>
          tx
            .update(hostBindings)
            // The prefix is written explicitly rather than spread: reconnecting
            // is how a grant is narrowed, and one left in place by omission
            // would survive its own withdrawal.
            .set({ ...body, branchPrefix: body.branchPrefix ?? null, updatedAt: new Date() })
            .where(
              and(
                eq(hostBindings.spaceId, request.params.spaceId),
                eq(hostBindings.hostBindingId, body.hostBindingId),
              ),
            )
            .returning(),
        );
        return reply.send(HostBindingSchema.parse(updated));
      }

      const [row] = await inTenant(tenant.tenantId, (tx) =>
        tx
          .insert(hostBindings)
          .values({
            ...body,
            branchPrefix: body.branchPrefix ?? null,
            spaceId: request.params.spaceId,
          })
          .returning(),
      );
      return reply.send(HostBindingSchema.parse(row));
    },
  );

  app.delete(
    '/:spaceId/host-bindings/:hostBindingId',
    {
      config: {
        authz: {
          resource: 'space',
          action: 'admin',
          spaceIdFrom: 'param',
          resourceIdFrom: 'param',
          resourceIdParam: 'spaceId',
        },
      },
      schema: {
        tags: ['Host'],
        summary: 'Disconnect a folder from this space',
        description:
          "Removes the space's reference to the folder. It does not touch the folder, and it " +
          "does not revoke the machine's own policy — that is the operator's to edit.",
        params: bindingParams,
        response: { 204: z.null(), 404: ErrorSchema },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      await request.requireSpace();
      const removed = await inTenant(tenant.tenantId, (tx) =>
        tx
          .delete(hostBindings)
          .where(
            and(
              eq(hostBindings.spaceId, request.params.spaceId),
              eq(hostBindings.hostBindingId, request.params.hostBindingId),
            ),
          )
          .returning(),
      );
      if (removed.length === 0) {
        return reply.status(404).send({ error: 'NotFound', message: 'No such binding.' });
      }
      // Told to the machine as well as recorded here. Removing the row stops
      // the next step; a command already detached under this binding would
      // otherwise keep the folder for as long as it runs, while the workspace
      // showed the folder disconnected.
      const notice: HostWithdrawalNotice = {
        spaceId: request.params.spaceId,
        hostBindingId: request.params.hostBindingId,
      };
      await getRedisConnection()
        .publish(HOST_WITHDRAWAL_CHANNEL, JSON.stringify(notice))
        .catch(() => {
          // A machine that is not listening has nothing running to withdraw
          // from, and the row is already gone. Failing the request here would
          // report the withdrawal as not having happened when it has.
        });
      return reply.status(204).send(null);
    },
  );
};
