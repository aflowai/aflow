/**
 * Pairing a host executor with this instance.
 *
 * The executor runs as the operator's own user on their machine, so it cannot
 * mount the volume its credential lives in — the credential has to be carried
 * out, and this is the only door it comes through. Owner-authenticated, because
 * the whole point of the boundary is that a run cannot widen its own reach: an
 * agent that could call this would be able to pair a machine to itself.
 *
 * The response is the material a host needs and nothing more: where Redis is,
 * the identity to claim host jobs with, and the bindings the operator has
 * declared. It carries neither the instance secret nor the credential-wrapping
 * key, because claiming jobs and reporting results is all a host does.
 */
import { randomBytes } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { createTenantContext, withTenantSchema, hostBindings, spaces } from '@aflow/database';
import {
  getRedisConnection,
  HOST_BROWSER_SIGN_IN_CHANNEL,
  HOST_INVENTORY_TTL_MS,
  type HostBrowserSignInRequest,
  HOST_MACHINES_KEY,
  type HostInventory,
  hostInventoryKey,
  HostInventorySchema,
} from '@aflow/redis';

import { applyHostIdentityToRunningServer } from '../bootstrap/redisAcl.js';
import { mintConnectToken, redeemConnectToken } from './hostConnectToken.js';
import { rotateInstanceValue } from '../bootstrap/instanceConfig.js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { BrowserProfileIdSchema, HostBranchPrefixSchema } from '@aflow/schemas';

const HostBindingSchema = z.object({
  id: z.string(),
  label: z.string(),
  root: z.string(),
  mode: z.enum(['read', 'readwrite']),
  allowsExecution: z.boolean(),
  /** Absent means the folder pushes nothing, which is every folder by default. */
  branchPrefix: z.string().optional(),
});

/**
 * The most names a machine reports as taken. A body-size bound rather than a
 * policy: it is a machine describing itself, and a list this long already
 * describes more folders than an operator connected by hand.
 */
const MAX_NAMES_IN_USE = 200;

/** The shape of a binding name, for the one asked for and for the ones already taken. */
const HOST_BINDING_ID_MAX_LENGTH = 64;
const HostBindingIdSchema = z
  .string()
  .min(1)
  .max(HOST_BINDING_ID_MAX_LENGTH)
  .regex(/^[a-z0-9_-]+$/, 'Lowercase letters, digits, hyphen and underscore.');

interface NameInUse {
  hostBindingId: string;
  root: string;
  spaceId?: string | undefined;
}

/** The spelling a binding name allows, so a name composed here is one that could be typed. */
function idPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * The suffix is what makes a name unique, so the stem yields to it: a name
 * longer than a binding id may be is one the other binding surfaces refuse.
 */
function boundedName(stem: string, suffix: string): string {
  const room = Math.max(1, HOST_BINDING_ID_MAX_LENGTH - suffix.length);
  const head = stem.slice(0, room).replace(/-+$/, '');
  return `${head}${suffix}`.slice(0, HOST_BINDING_ID_MAX_LENGTH);
}

/**
 * The name to record the folder under, decided here because this is the half
 * that knows which space the code redeems for.
 *
 * A name is unique on the machine while a workspace keys folders by (space, id),
 * and the machine's default name comes from the folder — so two workspaces
 * reaching folders called `docs` is the ordinary case. The machine cannot settle
 * it: it does not know the target space until this call answers. Same name, same
 * folder, same space is a reconnect and keeps the name; anything else already
 * answered for on that machine gets a name of its own, so the row this writes is
 * one the machine can answer for.
 */
function resolveBindingName(input: {
  requested: string;
  root: string;
  spaceId: string;
  spaceSlug: string;
  namesInUse: readonly NameInUse[];
}): string {
  const takenByOther = (candidate: string): boolean =>
    input.namesInUse.some(
      (entry) =>
        entry.hostBindingId === candidate &&
        ((entry.spaceId !== undefined && entry.spaceId !== input.spaceId) ||
          entry.root !== input.root),
    );
  if (!takenByOther(input.requested)) return input.requested;

  const fromSlug = idPart(input.spaceSlug);
  const space = fromSlug === '' ? idPart(input.spaceId) : fromSlug;
  let candidate = boundedName(input.requested, `-${space}`);
  // Bounded by the list itself: each number yields a distinct name, so a free
  // one exists within one more than the number of names that can be taken.
  for (let n = 2; takenByOther(candidate) && n <= input.namesInUse.length + 2; n += 1) {
    candidate = boundedName(input.requested, `-${space}-${String(n)}`);
  }
  return candidate;
}

/** A row of the tenant table, as the two places that map one read it. */
interface HostBindingRow {
  hostBindingId: string;
  label: string;
  root: string;
  writable: boolean;
  allowsExecution: boolean;
  branchPrefix?: string | null;
}

function bindingForMachine(row: HostBindingRow): z.infer<typeof HostBindingSchema> {
  const prefix = row.branchPrefix;
  return {
    id: row.hostBindingId,
    label: row.label,
    root: row.root,
    mode: row.writable ? ('readwrite' as const) : ('read' as const),
    allowsExecution: row.allowsExecution,
    ...(prefix !== null && prefix !== undefined ? { branchPrefix: prefix } : {}),
  };
}

const PairingResponseSchema = z.object({
  redisUrl: z
    .string()
    .describe('Reachable from the operator machine, not from inside the appliance.'),
  redisUsername: z.string(),
  redisPassword: z.string(),
  bindings: z.array(HostBindingSchema),
});

/**
 * Where the host reaches Redis. Inside the appliance it is `redis:6379`, which
 * resolves nowhere on the operator's machine — the published loopback port is
 * the address that means anything there.
 */
function hostReachableRedisUrl(): string {
  const configured = process.env['PHOENIX_HOST_REDIS_URL']?.trim();
  if (configured !== undefined && configured !== '') return configured;
  const port = process.env['AFLOW_REDIS_PORT']?.trim() ?? '6380';
  return `redis://127.0.0.1:${port}`;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export const hostPairingRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  /**
   * Applied to the running server as well as written to the file it loads at
   * boot. Redis reads an `aclfile` once at startup, so a rotation that only
   * rewrote the file would leave the old credential working until something
   * restarted — which is the opposite of what revoking means.
   */
  async function setHostPassword(password: string): Promise<void> {
    const redis = getRedisConnection();
    await applyHostIdentityToRunningServer(redis, {
      defaultPassword: process.env['REDIS_PASSWORD'] ?? '',
      hostPassword: password,
    });

    // Replacing the password does not touch connections that already
    // authenticated with the old one: they keep issuing commands on the socket
    // they hold. A revocation that leaves the revoked machine working until it
    // happens to reconnect is not a revocation, so the connections go too and
    // a reconnect has to present the new credential.
    //
    // Non-fatal: the credential is already replaced by the time this runs, so
    // failing here would report a revocation that did happen as one that did
    // not. It is logged by the caller's error path only if the replace failed.
    try {
      await redis.call('CLIENT', 'KILL', 'USER', 'hostexec');
    } catch {
      // An older server without `CLIENT KILL USER` still had its password
      // replaced; the held connection outlives the rotation until it drops.
    }
  }

  app.post(
    '/pair',
    {
      // The instance is the tenant on an appliance, so tenant admin is the
      // owner. A run carries no such authority, which is the point: an agent
      // able to reach this could pair a machine to itself.
      config: { authz: { resource: 'tenant', action: 'admin' } },
      schema: {
        tags: ['Host'],
        summary: 'Pair a host executor with this instance',
        description:
          'Returns the material a host executor needs to claim host jobs. Owner-only: an ' +
          'agent able to call this could pair a machine to itself.',
        response: {
          200: PairingResponseSchema,
          503: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const redisPassword = process.env['PHOENIX_HOST_REDIS_PASSWORD']?.trim();
      if (redisPassword === undefined || redisPassword === '') {
        return await reply.status(503).send({
          error: 'HostPairingUnavailable',
          message:
            'This instance has no host credential. It is generated at first boot; an instance ' +
            'started before the host lane existed needs one more boot to have it.',
        });
      }

      // The credential this hands out has to exist on the Redis this instance is
      // actually using. On the appliance the `aclfile` created it at Redis start,
      // so nothing here had to; anywhere else — a development stack attached to a
      // Redis with no ACL file — pairing returned a password for an identity that
      // was never created, and the paired daemon died on `WRONGPASS` two systems
      // from the cause.
      //
      // Applied rather than assumed, and fatal rather than logged: a pairing that
      // reports success while provisioning nothing is the failure this replaces.
      try {
        await setHostPassword(redisPassword);
      } catch (error) {
        fastify.log.error({ err: error }, 'host pairing could not provision the Redis identity');
        return await reply.status(503).send({
          error: 'HostPairingUnavailable',
          message:
            "The host identity could not be created on this instance's Redis, so the credential " +
            'this would return would not authenticate. Nothing was paired.',
        });
      }

      // What the appliance believes this machine may reach. The machine keeps
      // its own policy and grants the intersection, so this list widens nothing
      // — it tells a freshly paired host which folders to expect.
      const tenant = await request.requireTenant();
      const db = fastify.appContext.db as PostgresJsDatabase;
      const rows = (await withTenantSchema(
        db,
        createTenantContext(tenant.tenantId),
        async (tx: unknown) => (tx as PostgresJsDatabase).select().from(hostBindings),
      )) as HostBindingRow[];

      return await reply.send({
        redisUrl: hostReachableRedisUrl(),
        redisUsername: 'hostexec',
        redisPassword,
        bindings: rows.map(bindingForMachine),
      });
    },
  );

  app.post(
    '/connect-tokens',
    {
      // Minted by the operator through their own authenticated session. A run
      // carries no such authority — an agent able to mint one could invite
      // itself onto the machine.
      config: {
        authz: {
          resource: 'space',
          action: 'admin',
          spaceIdFrom: 'body',
          resourceIdFrom: 'body',
          resourceIdParam: 'spaceId',
        },
      },
      schema: {
        tags: ['Host'],
        summary: 'Mint a short-lived token for connecting a folder from the operator machine',
        description:
          'The token pairs a machine and attaches folders to this space, expires in minutes, and ' +
          'is spent on first use. It exists so connecting a folder does not cost the instance ' +
          'secret, which authenticates as the owner for every call this API has.',
        body: z.object({ spaceId: z.string().uuid() }),
        response: {
          200: z.object({ code: z.string(), expiresAt: z.string() }),
          503: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      // Read rather than taken from `requireSpace()`: this path carries the
      // space in its body, and the header that call reads is not set unless a
      // caller thought to. Authorisation already happened against this id.
      const db = fastify.appContext.db as PostgresJsDatabase;
      const [row] = (await withTenantSchema(
        db,
        createTenantContext(tenant.tenantId),
        async (tx: unknown) =>
          (tx as PostgresJsDatabase)
            .select({ slug: spaces.slug })
            .from(spaces)
            .where(eq(spaces.id, request.body.spaceId))
            .limit(1),
      )) as Array<{ slug: string }>;

      const minted = await mintConnectToken({
        tenantId: tenant.tenantId,
        spaceId: request.body.spaceId,
        spaceSlug: row?.slug ?? request.body.spaceId,
      });
      return await reply.send(minted);
    },
  );

  app.post(
    '/connect',
    {
      // No session: the token IS the authentication, which is the whole reason
      // it exists. It is scoped to one space, spent on redemption, and worth
      // nothing after — so carrying it to a terminal costs the operator only
      // what it can do.
      config: { public: true },
      schema: {
        tags: ['Host'],
        summary: 'Redeem a connect token: attach a folder and return pairing material',
        description:
          'One call rather than pair-then-register, so the machine holds one credential and the ' +
          'operator runs one command. The folder and its grants come from the operator answering ' +
          'on their own machine; this records what they said and returns what the executor needs.',
        body: z.object({
          code: z.string().min(1).max(64),
          binding: z.object({
            hostBindingId: HostBindingIdSchema,
            /**
             * The names this machine already offers, so a default name that is
             * taken there for another workspace or another folder is made unique
             * here — where the target space is known. Absent when the operator
             * named the folder themselves: an explicit name is an answer.
             */
            namesInUse: z
              .array(
                z.object({
                  hostBindingId: HostBindingIdSchema,
                  root: z.string().min(1).max(1024),
                  /** Absent for a binding written before the machine recorded a workspace. */
                  spaceId: z.string().min(1).optional(),
                }),
              )
              .max(MAX_NAMES_IN_USE)
              .optional(),
            label: z.string().min(1).max(120),
            root: z.string().min(1).max(1024),
            writable: z.boolean(),
            allowsExecution: z.boolean(),
            /**
             * Which branches this folder may be pushed to. Absent means none,
             * which is what a folder connected without the question allows.
             */
            branchPrefix: HostBranchPrefixSchema.optional(),
            /**
             * Names and tool lists only. What an id runs stays in the machine's
             * own policy, which nothing here writes.
             */
            mcpServers: z
              .array(
                z.object({
                  id: z.string().min(1).max(64),
                  label: z.string().min(1).max(120),
                  tools: z
                    .array(
                      z.object({
                        name: z.string(),
                        description: z.string().optional(),
                        inputSchema: z.record(z.string(), z.unknown()).optional(),
                      }),
                    )
                    .optional(),
                }),
              )
              .default([]),
          }),
        }),
        response: {
          200: PairingResponseSchema.extend({
            spaceId: z.string(),
            spaceSlug: z.string(),
            /**
             * The name the folder was recorded under. Returned rather than left
             * to be found among `bindings` by root: it is the machine's own name
             * for the folder, and it is not always the one that was sent.
             */
            binding: z.object({ hostBindingId: z.string() }),
          }),
          400: z.object({ error: z.string(), message: z.string() }),
          401: z.object({ error: z.string(), message: z.string() }),
          503: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const redisPassword = process.env['PHOENIX_HOST_REDIS_PASSWORD']?.trim();
      if (redisPassword === undefined || redisPassword === '') {
        return await reply.status(503).send({
          error: 'HostPairingUnavailable',
          message:
            'This instance has no host credential. It is generated at first boot; an instance ' +
            'started before the host lane existed needs one more boot to have it.',
        });
      }

      // The same invariant the authenticated binding route enforces. A server is
      // a program, so a folder offering one without the execution grant
      // publishes named tools into an agent's context that are refused at the
      // moment of use — the worst shape for a capability, since the agent
      // spends a turn discovering it. Checked before the code is spent, so a
      // refusal costs the operator nothing but the correction.
      if (request.body.binding.mcpServers.length > 0 && !request.body.binding.allowsExecution) {
        return await reply.status(400).send({
          error: 'McpServersNeedExecution',
          message:
            'An MCP server is a program, so the folder it runs in has to allow commands. ' +
            'Connect it with commands allowed, or without offering servers.',
        });
      }

      // A push is a command, so the same reasoning applies: a prefix on a
      // folder that runs nothing declares an authority that could never be
      // exercised.
      if (
        request.body.binding.branchPrefix !== undefined &&
        !request.body.binding.allowsExecution
      ) {
        return await reply.status(400).send({
          error: 'BranchPrefixNeedsExecution',
          message:
            'A push is a command, so a folder with a branch prefix has to allow commands. ' +
            'Connect it with commands allowed, or without a prefix.',
        });
      }

      const grant = await redeemConnectToken(request.body.code);
      if (grant === null) {
        // Expired, already spent, and never valid are one answer on purpose:
        // distinguishing them turns this into an oracle for guessing codes.
        return await reply.status(401).send({
          error: 'InvalidConnectToken',
          message:
            'That code is not valid. Codes last a few minutes and work once — generate a new ' +
            'one from the workspace and run the command again.',
        });
      }

      const hostBindingId = resolveBindingName({
        requested: request.body.binding.hostBindingId,
        root: request.body.binding.root,
        spaceId: grant.spaceId,
        spaceSlug: grant.spaceSlug,
        namesInUse: request.body.binding.namesInUse ?? [],
      });

      const db = fastify.appContext.db as PostgresJsDatabase;
      const rows = (await withTenantSchema(
        db,
        createTenantContext(grant.tenantId),
        async (tx: unknown) => {
          const t = tx as PostgresJsDatabase;
          await t
            .insert(hostBindings)
            .values({
              spaceId: grant.spaceId,
              hostBindingId,
              label: request.body.binding.label,
              root: request.body.binding.root,
              writable: request.body.binding.writable,
              allowsExecution: request.body.binding.allowsExecution,
              branchPrefix: request.body.binding.branchPrefix ?? null,
              mcpServers: request.body.binding.mcpServers,
            })
            .onConflictDoUpdate({
              target: [hostBindings.spaceId, hostBindings.hostBindingId],
              set: {
                label: request.body.binding.label,
                root: request.body.binding.root,
                writable: request.body.binding.writable,
                allowsExecution: request.body.binding.allowsExecution,
                // Explicitly null when the operator did not ask for one:
                // reconnecting is how a grant is narrowed, and a prefix left
                // in place by omission would survive its own withdrawal.
                branchPrefix: request.body.binding.branchPrefix ?? null,
                mcpServers: request.body.binding.mcpServers,
              },
            });
          return await t.select().from(hostBindings);
        },
      )) as HostBindingRow[];

      return await reply.send({
        redisUrl: hostReachableRedisUrl(),
        redisUsername: 'hostexec',
        redisPassword,
        spaceId: grant.spaceId,
        spaceSlug: grant.spaceSlug,
        binding: { hostBindingId },
        bindings: rows.map(bindingForMachine),
      });
    },
  );

  app.get(
    '/status',
    {
      // Admin, not tenant/read: that permission is a governance bundle a member
      // must not hold, and which machine is paired to this instance is an
      // operator's question either way.
      config: { authz: { resource: 'tenant', action: 'admin' } },
      schema: {
        tags: ['Host'],
        summary: 'Whether a machine is paired, and what it reports having',
        response: {
          200: z.object({
            paired: z.boolean(),
            machines: z.array(
              HostInventorySchema.pick({
                hostname: true,
                observedAt: true,
                runtimes: true,
                browsers: true,
              }),
            ),
          }),
        },
      },
    },
    async (_request, reply) => {
      // Read from what the executor publishes rather than from anything stored:
      // an inventory that outlives its machine describes tools nobody can run.
      const redis = getRedisConnection();
      const machines: Array<
        Pick<HostInventory, 'hostname' | 'observedAt' | 'runtimes' | 'browsers'>
      > = [];
      // Read from the set each executor announces itself into. Scanning the
      // keyspace for them is what [[180]] forbids, and the cost here tracks
      // paired machines rather than everything stored.
      // Entries older than an inventory's lifetime name machines that stopped
      // publishing; dropping them here is what keeps this set the size of the
      // fleet rather than of its history.
      await redis
        .zremrangebyscore(HOST_MACHINES_KEY, '-inf', Date.now() - HOST_INVENTORY_TTL_MS)
        .catch(() => undefined);
      const names = await redis.zrange(HOST_MACHINES_KEY, 0, -1);
      for (const name of names) {
        const raw = await redis.get(hostInventoryKey(name));
        // A name whose inventory expired is a machine that stopped publishing,
        // which is not the same as one that is running and says nothing.
        if (raw === null) continue;
        // A machine writing something unreadable is not a reason to fail the
        // question everyone else answered.
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue;
        }
        const inventory = HostInventorySchema.safeParse(parsed);
        if (!inventory.success) continue;
        const { hostname, observedAt, runtimes, browsers } = inventory.data;
        machines.push({ hostname, observedAt, runtimes, browsers });
      }
      return await reply.send({ paired: machines.length > 0, machines });
    },
  );

  app.post(
    '/browsers/:profileId/sign-in',
    {
      // An operator action, dispatched straight to the machine. No catalog
      // operation reaches the channel this publishes on, so no agent surface —
      // tool list, skill or grant — can name it; this authenticated route is
      // the only way in, as it is for the rest of this machine's pairing.
      config: { authz: { resource: 'tenant', action: 'admin' } },
      schema: {
        tags: ['Host'],
        summary: "Show a browser profile's window on the machine for the operator to sign in",
        description:
          'The sign-in sitting `aflow browser sign-in` holds on the machine: the profile’s ' +
          'window opens there, runs on the profile wait until it closes, and the machine’s ' +
          'inventory reports the window open and, after, the sites that hold a session.',
        params: z.object({ profileId: BrowserProfileIdSchema }),
        body: z.object({ hostname: z.string().min(1).max(256) }),
        response: {
          202: z.object({ asked: z.literal(true) }),
          404: z.object({ error: z.string(), message: z.string() }),
          409: z.object({ error: z.string(), message: z.string() }),
          503: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const { profileId } = request.params;
      const { hostname } = request.body;
      const redis = getRedisConnection();
      const raw = await redis.get(hostInventoryKey(hostname));
      const inventory =
        raw === null ? undefined : HostInventorySchema.safeParse(safeJson(raw)).data;
      if (inventory === undefined) {
        return await reply.status(404).send({
          error: 'HostNotRunning',
          message: `The machine ${hostname} is not running its executor, so it cannot open a window.`,
        });
      }
      const profile = inventory.browsers.find((browser) => browser.id === profileId);
      if (profile === undefined) {
        return await reply.status(404).send({
          error: 'BrowserProfileNotFound',
          message: `The machine ${hostname} has no browser profile \`${profileId}\`.`,
        });
      }
      if (profile.windowOpen) {
        return await reply.status(409).send({
          error: 'BrowserWindowOpen',
          message: `Profile \`${profileId}\`'s window is already open on ${hostname}.`,
        });
      }
      const asked: HostBrowserSignInRequest = { hostname, profileId };
      const receivers = await redis.publish(HOST_BROWSER_SIGN_IN_CHANNEL, JSON.stringify(asked));
      if (receivers === 0) {
        return await reply.status(503).send({
          error: 'HostNotListening',
          message: `No executor on ${hostname} is listening for sign-in requests. Restart it there and try again.`,
        });
      }
      return await reply.status(202).send({ asked: true as const });
    },
  );

  app.post(
    '/revoke',
    {
      config: { authz: { resource: 'tenant', action: 'admin' } },
      schema: {
        tags: ['Host'],
        summary: 'Stop a paired machine from claiming host jobs',
        description:
          'Rotates the credential the paired executor authenticates with, so it stops claiming ' +
          'work immediately. The bindings stay: what a machine may reach is a separate decision ' +
          'from whether it is currently allowed to connect.',
        response: {
          200: z.object({ revoked: z.literal(true) }),
          503: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (_request, reply) => {
      const fresh = randomBytes(32).toString('hex');
      try {
        // Durable first. Live Redis and this process both forget a rotation on
        // restart; `instance.env` is what survives one, and the ACL file is
        // rebuilt from it at boot. Rotating only the live server reported a
        // revocation that the next restart quietly undid.
        const instanceDir = process.env['PHOENIX_INSTANCE_DIR']?.trim();
        if (instanceDir === undefined || instanceDir === '') {
          return await reply.status(503).send({
            error: 'HostRevokeFailed',
            message:
              'This instance does not know where it keeps its identity (PHOENIX_INSTANCE_DIR), ' +
              'so a revocation could not be made durable. Nothing was changed.',
          });
        }
        await rotateInstanceValue(instanceDir, 'PHOENIX_HOST_REDIS_PASSWORD', fresh);
        await setHostPassword(fresh);
      } catch (error) {
        return await reply.status(503).send({
          error: 'HostRevokeFailed',
          message: `Could not rotate the host credential: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      // The process env is what the next pairing reads, so a rotation that did
      // not update it would hand the next machine a credential Redis no longer
      // knows.
      process.env['PHOENIX_HOST_REDIS_PASSWORD'] = fresh;
      return await reply.send({ revoked: true as const });
    },
  );
};
