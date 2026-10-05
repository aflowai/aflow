/**
 * A browser profile's posture, `unattended` choice, origin rules and the
 * loopback ports it is opened to, changed from the machine page (Plan 320 D5).
 *
 * The guarantee is that nothing an agent can reach loosens its own limits, so
 * these take a person's authenticated request and nothing else: an API key, a
 * service principal or an MCP session is refused whoever holds it, and no
 * catalog operation names them. The route stores nothing. It relays the change
 * to the machine's executor on the channel sign-in already travels, and the
 * executor writes the policy file through the command's own writer and answers
 * with the profile as it now is, or with its refusal.
 */
import { randomBytes } from 'node:crypto';

import {
  createSubscriberConnection,
  getRedisConfig,
  getRedisConnection,
  hostBrowserAnswerChannel,
  hostBrowserRequestChannel,
  type HostBrowserRequest,
  type HostBrowserSetting,
  type HostBrowserSettingAnswer,
  HostBrowserSettingAnswerSchema,
  readHostInventory,
} from '@aflow/redis';
import { describeStackPortOwner, stackOwnPorts } from '@aflow/lib';
import {
  BrowserProfileIdSchema,
  BrowserProfileSchema,
  browserStackPortRefusal,
} from '@aflow/schemas';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { isInteractiveUser } from '../utils/interactiveUser.js';

/** Past the executor republishing its inventory, which it does before it answers. */
export const SETTING_ANSWER_TIMEOUT_MS = 20_000;

const ProblemSchema = z.object({ error: z.string(), message: z.string() });

const RESPONSES = {
  200: z.object({ profile: BrowserProfileSchema }),
  403: ProblemSchema,
  404: ProblemSchema,
  422: ProblemSchema,
  503: ProblemSchema,
  504: ProblemSchema,
};

const NOT_A_PERSON = {
  error: 'PersonRequired',
  message:
    'A browser profile’s settings are changed by a person: signed in to the application, ' +
    'on the machine page, or on the machine with `aflow browser`. This credential — an API ' +
    'key, a service principal or an MCP session — cannot change them.',
} as const;

const Hostname = z.string().min(1).max(256);
const Params = z.object({ profileId: BrowserProfileIdSchema });

type Relayed =
  | { readonly status: 'answered'; readonly answer: HostBrowserSettingAnswer }
  | { readonly status: 'not_listening' }
  | { readonly status: 'no_answer' };

async function relay(
  hostname: string,
  profileId: string,
  setting: HostBrowserSetting,
): Promise<Relayed> {
  const answerId = randomBytes(18).toString('base64url');
  const answers = createSubscriberConnection({
    ...getRedisConfig(),
    connectionName: 'host-browser-answer',
  });
  try {
    const channel = hostBrowserAnswerChannel(answerId);
    let timer: NodeJS.Timeout | undefined;
    const answered = new Promise<HostBrowserSettingAnswer | undefined>((resolve) => {
      answers.on('message', (from: string, raw: string) => {
        if (from !== channel) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return;
        }
        const answer = HostBrowserSettingAnswerSchema.safeParse(parsed);
        if (answer.success) resolve(answer.data);
      });
      timer = setTimeout(() => {
        resolve(undefined);
      }, SETTING_ANSWER_TIMEOUT_MS);
    });
    // Subscribed before the request goes out, so an executor that answers at
    // once is heard.
    await answers.subscribe(channel);
    const request: HostBrowserRequest = {
      kind: 'setting',
      hostname,
      profileId,
      answerId,
      setting,
    };
    const receivers = await getRedisConnection().publish(
      hostBrowserRequestChannel(hostname),
      JSON.stringify(request),
    );
    if (receivers === 0) {
      clearTimeout(timer);
      return { status: 'not_listening' };
    }
    const answer = await answered;
    clearTimeout(timer);
    return answer === undefined ? { status: 'no_answer' } : { status: 'answered', answer };
  } finally {
    answers.disconnect();
  }
}

/** Why a port asked for is never opened to a profile, when this process can tell. */
function stackPortRefusal(requested: string): string | undefined {
  const text = requested.trim();
  if (!/^\d{1,5}$/.test(text)) return undefined;
  const port = Number(text);
  const owner = stackOwnPorts(process.env).get(port);
  return owner === undefined
    ? undefined
    : browserStackPortRefusal(port, describeStackPortOwner(owner));
}

async function change(
  request: FastifyRequest,
  reply: FastifyReply,
  hostname: string,
  profileId: string,
  setting: HostBrowserSetting,
): Promise<FastifyReply> {
  if (!isInteractiveUser(request.authUser)) {
    return await reply.status(403).send(NOT_A_PERSON);
  }
  // The machine refuses the ports its own environment names; this process
  // knows where it and the services configured beside it listen, which the
  // machine may not.
  const stackPort = setting.kind === 'local_port' ? stackPortRefusal(setting.port) : undefined;
  if (stackPort !== undefined) {
    return await reply.status(422).send({ error: 'BrowserSettingRefused', message: stackPort });
  }
  if ((await readHostInventory(getRedisConnection(), hostname)) === undefined) {
    return await reply.status(404).send({
      error: 'HostNotRunning',
      message: `The machine ${hostname} is not running its executor, so nothing was changed.`,
    });
  }
  const relayed = await relay(hostname, profileId, setting);
  if (relayed.status === 'not_listening') {
    return await reply.status(503).send({
      error: 'HostNotListening',
      message: `No executor on ${hostname} is listening for browser requests. Restart it there and try again. Nothing was changed.`,
    });
  }
  if (relayed.status === 'no_answer') {
    return await reply.status(504).send({
      error: 'HostDidNotAnswer',
      message: `The executor on ${hostname} took the change and has not answered after ${String(SETTING_ANSWER_TIMEOUT_MS / 1000)} seconds. Its log says whether it was made.`,
    });
  }
  const { answer } = relayed;
  if (answer.kind === 'refused') {
    return await reply
      .status(422)
      .send({ error: 'BrowserSettingRefused', message: answer.message });
  }
  return await reply.send({ profile: answer.profile });
}

export const hostBrowserSettingsRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  // Tenant admin as the rest of the machine's routes are; the person check is
  // in `change`, because a permission is held by an API key as well.
  const config = { authz: { resource: 'tenant', action: 'admin' } } as const;

  app.put(
    '/browsers/:profileId/posture',
    {
      config,
      schema: {
        tags: ['Host'],
        summary: "Set a browser profile's posture on the paired machine",
        description:
          'A person’s request only. The machine’s executor writes it as `aflow browser posture` ' +
          'does and answers with the profile as it now is.',
        params: Params,
        body: z.object({ hostname: Hostname, posture: z.string().max(64) }),
        response: RESPONSES,
      },
    },
    async (request, reply) =>
      await change(request, reply, request.body.hostname, request.params.profileId, {
        kind: 'posture',
        posture: request.body.posture,
      }),
  );

  app.put(
    '/browsers/:profileId/unattended',
    {
      config,
      schema: {
        tags: ['Host'],
        summary: 'Open or close a browser profile to runs nobody is present for',
        description:
          'A person’s request only. `allow` or `refuse`, written as `aflow browser unattended` ' +
          'writes it.',
        params: Params,
        body: z.object({ hostname: Hostname, choice: z.string().max(64) }),
        response: RESPONSES,
      },
    },
    async (request, reply) =>
      await change(request, reply, request.body.hostname, request.params.profileId, {
        kind: 'unattended',
        choice: request.body.choice,
      }),
  );

  app.put(
    '/browsers/:profileId/rules',
    {
      config,
      schema: {
        tags: ['Host'],
        summary: 'Add or replace an origin rule on a browser profile',
        description:
          'A person’s request only. Replaces the effect of a rule already naming the origin, ' +
          'as `aflow browser rule` does.',
        params: Params,
        body: z.object({
          hostname: Hostname,
          origin: z.string().max(2048),
          effect: z.string().max(64),
        }),
        response: RESPONSES,
      },
    },
    async (request, reply) =>
      await change(request, reply, request.body.hostname, request.params.profileId, {
        kind: 'rule',
        origin: request.body.origin,
        effect: request.body.effect,
      }),
  );

  app.delete(
    '/browsers/:profileId/rules',
    {
      config,
      schema: {
        tags: ['Host'],
        summary: 'Remove an origin rule from a browser profile',
        description: 'A person’s request only, as `aflow browser rule … --remove`.',
        params: Params,
        body: z.object({ hostname: Hostname, origin: z.string().max(2048) }),
        response: RESPONSES,
      },
    },
    async (request, reply) =>
      await change(request, reply, request.body.hostname, request.params.profileId, {
        kind: 'rule_remove',
        origin: request.body.origin,
      }),
  );

  app.put(
    '/browsers/:profileId/local-ports',
    {
      config,
      schema: {
        tags: ['Host'],
        summary: 'Open a loopback port on the paired machine to a browser profile',
        description:
          'A person’s request only, as `aflow browser local-port`. A port this stack serves on ' +
          'is refused, here and by the machine.',
        params: Params,
        body: z.object({ hostname: Hostname, port: z.string().max(16) }),
        response: RESPONSES,
      },
    },
    async (request, reply) =>
      await change(request, reply, request.body.hostname, request.params.profileId, {
        kind: 'local_port',
        port: request.body.port,
      }),
  );

  app.delete(
    '/browsers/:profileId/local-ports',
    {
      config,
      schema: {
        tags: ['Host'],
        summary: 'Close a loopback port to a browser profile again',
        description: 'A person’s request only, as `aflow browser local-port … --remove`.',
        params: Params,
        body: z.object({ hostname: Hostname, port: z.string().max(16) }),
        response: RESPONSES,
      },
    },
    async (request, reply) =>
      await change(request, reply, request.body.hostname, request.params.profileId, {
        kind: 'local_port_remove',
        port: request.body.port,
      }),
  );
};
