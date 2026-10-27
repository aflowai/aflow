/**
 * A connected folder's preview — how its change is seen working — declared or
 * cleared from the machine page (Plan 320 D18).
 *
 * Nothing an agent can reach may set it, so this takes a person's
 * authenticated request and nothing else: an API key, a service principal or
 * an MCP session is refused whoever holds it, and no catalog operation names a
 * preview. The route stores nothing. It relays the declaration to the
 * executor of the machine holding the folder, which checks the folder was
 * connected for this workspace, writes it with `aflow folder <id> preview`'s
 * own writer and answers with the declaration as it now is, or its refusal.
 */
import { describeStackPortOwner, stackOwnPorts } from '@aflow/lib';
import {
  askHost,
  getRedisConnection,
  hostFolderAnswerChannel,
  hostFolderRequestChannel,
  type HostExchange,
  type HostFolderAnswer,
  HostFolderAnswerSchema,
  type HostFolderRequest,
  newHostAnswerId,
  readHostInventory,
} from '@aflow/redis';
import {
  folderPreviewStackPortRefusal,
  type HostFolderPreview,
  HostFolderPreviewSchema,
} from '@aflow/schemas';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { hostExchangeConnections } from '../lib/hostExchange.js';
import { isInteractiveUser } from '../utils/interactiveUser.js';

/** Past the executor republishing its inventory, which it does before it answers. */
export const PREVIEW_ANSWER_TIMEOUT_MS = 20_000;

const ProblemSchema = z.object({ error: z.string(), message: z.string() });

const RESPONSES = {
  200: z.object({ preview: HostFolderPreviewSchema.nullable() }),
  403: ProblemSchema,
  404: ProblemSchema,
  422: ProblemSchema,
  503: ProblemSchema,
  504: ProblemSchema,
};

const NOT_A_PERSON = {
  error: 'PersonRequired',
  message:
    'A folder’s preview is declared by a person: signed in to the application, on the machine ' +
    'page, or on the machine with `aflow folder <bindingId> preview`. This credential — an API ' +
    'key, a service principal or an MCP session — cannot declare it.',
} as const;

const Params = z.object({ bindingId: z.string().min(1).max(64) });
const Target = z.object({
  hostname: z.string().min(1).max(256),
  spaceId: z.string().uuid(),
});

async function relay(request: HostFolderRequest): Promise<HostExchange<HostFolderAnswer>> {
  return await askHost(hostExchangeConnections('host-folder-answer'), {
    requestChannel: hostFolderRequestChannel(request.hostname),
    answerChannel: hostFolderAnswerChannel(request.answerId),
    request,
    parse: (value) => HostFolderAnswerSchema.safeParse(value).data,
    timeoutMs: PREVIEW_ANSWER_TIMEOUT_MS,
  });
}

async function change(
  request: FastifyRequest,
  reply: FastifyReply,
  target: z.infer<typeof Target> & { bindingId: string },
  preview: HostFolderPreview | null,
): Promise<FastifyReply> {
  if (!isInteractiveUser(request.authUser)) {
    return await reply.status(403).send(NOT_A_PERSON);
  }
  // The machine refuses the ports its own environment names; this process
  // knows where it and the services configured beside it listen, which the
  // machine may not.
  const owner =
    preview?.port === undefined ? undefined : stackOwnPorts(process.env).get(preview.port);
  if (preview?.port !== undefined && owner !== undefined) {
    return await reply.status(422).send({
      error: 'FolderPreviewRefused',
      message: folderPreviewStackPortRefusal(preview.port, describeStackPortOwner(owner)),
    });
  }
  if ((await readHostInventory(getRedisConnection(), target.hostname)) === undefined) {
    return await reply.status(404).send({
      error: 'HostNotRunning',
      message: `The machine ${target.hostname} is not running its executor, so nothing was changed.`,
    });
  }
  const relayed = await relay({
    kind: 'preview',
    hostname: target.hostname,
    answerId: newHostAnswerId(),
    spaceId: target.spaceId,
    bindingId: target.bindingId,
    preview,
  });
  if (relayed.status === 'not_listening') {
    return await reply.status(503).send({
      error: 'HostNotListening',
      message: `No executor on ${target.hostname} is listening for folder requests. Restart it there and try again. Nothing was changed.`,
    });
  }
  if (relayed.status === 'no_answer') {
    return await reply.status(504).send({
      error: 'HostDidNotAnswer',
      message: `The executor on ${target.hostname} took the change and has not answered after ${String(PREVIEW_ANSWER_TIMEOUT_MS / 1000)} seconds. Its log says whether it was made.`,
    });
  }
  const { answer } = relayed;
  if (answer.kind === 'refused') {
    return await reply.status(422).send({ error: 'FolderPreviewRefused', message: answer.message });
  }
  return await reply.send({ preview: answer.preview });
}

export const hostFolderPreviewRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  // Tenant admin as the rest of the machine's routes are; the person check is
  // in `change`, because a permission is held by an API key as well.
  const config = { authz: { resource: 'tenant', action: 'admin' } } as const;

  app.put(
    '/folders/:bindingId/preview',
    {
      config,
      schema: {
        tags: ['Host'],
        summary: "Declare a connected folder's preview on the machine holding it",
        description:
          'A person’s request only. The machine’s executor writes it as ' +
          '`aflow folder <bindingId> preview` does, replacing the declaration before, and ' +
          'answers with it. A port this stack serves on is refused, here and by the machine.',
        params: Params,
        body: Target.extend({ preview: HostFolderPreviewSchema }),
        response: RESPONSES,
      },
    },
    async (request, reply) =>
      await change(
        request,
        reply,
        { ...request.body, bindingId: request.params.bindingId },
        request.body.preview,
      ),
  );

  app.delete(
    '/folders/:bindingId/preview',
    {
      config,
      schema: {
        tags: ['Host'],
        summary: "Clear a connected folder's preview",
        description: 'A person’s request only, as `aflow folder <bindingId> preview --clear`.',
        params: Params,
        body: Target,
        response: RESPONSES,
      },
    },
    async (request, reply) =>
      await change(
        request,
        reply,
        {
          hostname: request.body.hostname,
          spaceId: request.body.spaceId,
          bindingId: request.params.bindingId,
        },
        null,
      ),
  );
};
