/**
 * Whether a person started a run is the server's to decide, from how the
 * request was authenticated: `mode` names the surface and is refused `chat`
 * and `voice` from a credential that is not an interactive user, rather than
 * rewritten. The local edition's authentication is the real one: its web
 * server presents the instance secret and is the owner; an API key is a key.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import type { AuthUser } from '../plugins/auth.js';
import { authenticateLocalInstance } from '../plugins/localInstanceAuth.js';
import { API_KEY_PREFIX } from '../lib/apiKeys.js';

const mockStartSession = vi.fn();
const mockResumeSession = vi.fn();

vi.mock('../services/sessions.js', () => ({
  createSessionService: () => ({
    startSession: (...args: unknown[]) => mockStartSession(...args),
    resumeSession: (...args: unknown[]) => mockResumeSession(...args),
  }),
  buildInlineAgentDefinition: vi.fn(),
}));

vi.mock('./mcp-elicitations.js', () => ({ registerMcpElicitationRoutes: vi.fn() }));
vi.mock('../lib/sessionMembership.js', () => ({
  recordSpeechJoin: vi.fn(),
  recordStartInvites: vi.fn(),
}));

const { runsRoutes } = await import('./runs.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const SPACE = '00000000-0000-4000-8000-000000000002';
const SESSION = '00000000-0000-4000-8000-0000000000aa';
const STEP = '00000000-0000-4000-8000-0000000000bb';

/** What the local web server presents: the instance's own word, here a fixture. */
const INSTANCE_WORD = 'w'.repeat(48);
const WEB_APP = { authorization: `Bearer ${INSTANCE_WORD}` };
const SCRIPT = { authorization: `Bearer ${API_KEY_PREFIX}${'k'.repeat(40)}` };

/** A hosted sign-in, as the auth plugin resolves an identity provider's token. */
const SIGNED_IN: AuthUser = {
  userId: '00000000-0000-4000-8000-0000000000c1' as AuthUser['userId'],
  roles: [],
  authMethod: 'jwt',
  isServicePrincipal: false,
};

let hostedPrincipal: AuthUser | undefined;

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  (app as unknown as { appContext: unknown }).appContext = { db: null, redis: null };

  app.decorate('authenticate', async (request: FastifyRequest) => {
    if (hostedPrincipal !== undefined) {
      request.authUser = hostedPrincipal;
      return;
    }
    const outcome = authenticateLocalInstance(request, {
      instanceSecret: INSTANCE_WORD,
      apiKeyPrefix: API_KEY_PREFIX,
      env: {},
    });
    if (outcome.kind === 'owner') request.authUser = outcome.authUser;
    // As the auth plugin resolves a key that validates.
    if (outcome.kind === 'api-key') {
      request.authUser = {
        userId: '00000000-0000-4000-8000-0000000000c2' as AuthUser['userId'],
        roles: [],
        authMethod: 'api_key',
        isServicePrincipal: false,
        apiKeyPrefix: API_KEY_PREFIX,
      };
    }
  });

  app.addHook('onRequest', async (request: FastifyRequest) => {
    Object.assign(request, {
      requireTenant: async () => ({ tenantId: TENANT, tenantRole: 'owner' }),
      requireSpace: async () => ({ spaceId: SPACE, spaceRole: 'admin', canWrite: true }),
    });
  });

  await app.register(runsRoutes, { prefix: '/v1/sessions' });
  await app.ready();
  return app;
}

function start(app: FastifyInstance, headers: Record<string, string>, body: object) {
  return app.inject({
    method: 'POST',
    url: `/v1/sessions?spaceId=${SPACE}`,
    headers,
    payload: body,
  });
}

const HELMSMAN = { target: { kind: 'platform-role', systemRole: 'cybernetic-helmsman' } };

beforeEach(() => {
  vi.clearAllMocks();
  hostedPrincipal = undefined;
  mockStartSession.mockResolvedValue({
    sessionId: SESSION,
    status: 'QUEUED',
    eventsUrl: `https://api.example.com/v1/sessions/${SESSION}/events`,
    traceId: 'trace-1',
  });
  mockResumeSession.mockResolvedValue({ status: 'RUNNING', traceId: 'trace-2' });
});

describe('POST /v1/sessions — who may start a run as a person', () => {
  it.each(['chat', 'voice'])(
    'refuses an API key sending mode %s, saying which modes it may send',
    async (mode) => {
      const app = await buildApp();
      const res = await start(app, SCRIPT, { ...HELMSMAN, mode });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain(`mode '${mode}'`);
      expect(res.json().message).toContain("may send mode 'api' or 'mcp'");
      expect(mockStartSession).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it.each(['api', 'mcp'] as const)(
    'starts an API key’s run with mode %s as that trigger, nobody present',
    async (mode) => {
      const app = await buildApp();
      const res = await start(app, SCRIPT, { ...HELMSMAN, mode });
      expect(res.statusCode).toBe(201);
      expect(mockStartSession.mock.calls[0]?.[0]).toMatchObject({
        trigger: mode,
        activatedByPerson: false,
      });
      await app.close();
    },
  );

  it('starts the MCP server’s own run, as FlowRunner sends it', async () => {
    const app = await buildApp();
    const res = await start(app, SCRIPT, {
      mode: 'mcp',
      target: { kind: 'platform-role', systemRole: 'mcp-runner' },
      input: { input: {}, config: { operationId: 'memory.store.query', inputs: {} } },
    });
    expect(res.statusCode).toBe(201);
    expect(mockStartSession.mock.calls[0]?.[0]).toMatchObject({
      trigger: 'mcp',
      activatedByPerson: false,
    });
    await app.close();
  });

  it('starts the local web application’s chat attended', async () => {
    const app = await buildApp();
    const res = await start(app, WEB_APP, { ...HELMSMAN, mode: 'chat' });
    expect(res.statusCode).toBe(201);
    expect(mockStartSession.mock.calls[0]?.[0]).toMatchObject({
      trigger: 'chat',
      activatedByPerson: true,
    });
    await app.close();
  });

  it('starts a signed-in user’s voice session attended, and their api run unattended', async () => {
    hostedPrincipal = SIGNED_IN;
    const app = await buildApp();
    await start(app, {}, { ...HELMSMAN, mode: 'voice' });
    await start(app, {}, { ...HELMSMAN, mode: 'api' });
    expect(mockStartSession.mock.calls.map(([request]) => request)).toMatchObject([
      { trigger: 'voice', voiceMode: true, activatedByPerson: true },
      { trigger: 'api', activatedByPerson: false },
    ]);
    await app.close();
  });

  it('refuses a service principal mode chat, whatever its token', async () => {
    hostedPrincipal = { ...SIGNED_IN, isServicePrincipal: true };
    const app = await buildApp();
    const res = await start(app, {}, { ...HELMSMAN, mode: 'chat' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('POST /v1/sessions/:id/resume — who sets a run going again', () => {
  const answer = { stepExecutionId: STEP, input: { message: 'go on' } };

  it('counts the web application’s message as a person and an API key’s as nobody', async () => {
    const app = await buildApp();
    for (const headers of [WEB_APP, SCRIPT]) {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${SESSION}/resume?spaceId=${SPACE}`,
        headers,
        payload: answer,
      });
      expect(res.statusCode).toBe(200);
    }
    expect(mockResumeSession.mock.calls.map(([request]) => request)).toMatchObject([
      { activatedByPerson: true },
      { activatedByPerson: false },
    ]);
    await app.close();
  });
});
