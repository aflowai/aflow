/**
 * Plan 336 D6: a `?wait` start that ends FAILED returns the step's stored
 * error, so the integration card and form name a refused MCP connect's range
 * and remedy instead of "connection error".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import type { AuthUser } from '../plugins/auth.js';
import { storedStepErrorFrom } from '../lib/storedStepError.js';

const mockStartSession = vi.fn();
const mockGetSessionById = vi.fn();
const mockRetrieve = vi.fn();

vi.mock('../services/sessions.js', () => ({
  createSessionService: () => ({
    startSession: (...args: unknown[]) => mockStartSession(...args),
    getSessionById: (...args: unknown[]) => mockGetSessionById(...args),
  }),
  buildInlineAgentDefinition: () => ({ flowId: 'mcp-binding-test-corp-default', version: 1 }),
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
const ERROR_REF = 'payload:error-1';

const OPERATOR: AuthUser = {
  userId: '00000000-0000-4000-8000-0000000000c1' as AuthUser['userId'],
  roles: [],
  authMethod: 'jwt',
  isServicePrincipal: false,
};

const REFUSAL = {
  code: 'VALIDATION_ERROR',
  message:
    'DNS rebinding blocked: mcp.corp.example resolved to private IP 10.1.2.3 (private-rfc1918)',
  classification: 'validation',
  retryable: false,
  details: {
    kind: 'private-ip',
    target: 'mcp.corp.example',
    rangeLabel: 'private-rfc1918',
    range: 'private network address (10.0.0.0/8, 172.16.0.0/12 or 192.168.0.0/16)',
    remedy: 'acknowledge_private_network',
  },
  timestamp: '2026-10-31T00:00:00.000Z',
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  (app as unknown as { appContext: unknown }).appContext = {
    db: null,
    redis: null,
    payloadStore: { retrieve: (...args: unknown[]) => mockRetrieve(...args) },
  };
  app.decorate('authenticate', async (request: FastifyRequest) => {
    request.authUser = OPERATOR;
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

function startAndWait(app: FastifyInstance) {
  return app.inject({
    method: 'POST',
    url: `/v1/sessions?wait=5s&spaceId=${SPACE}`,
    payload: {
      agentConfig: {
        name: 'mcp-binding-test-corp-default',
        steps: [
          {
            stepId: 'test',
            type: 'mcp',
            operation: 'mcp.binding.test',
            config: { bindingId: 'corp-default' },
          },
        ],
      },
      input: {},
    },
  });
}

function sessionIn(status: string, errorRef?: string) {
  return {
    sessionId: SESSION,
    status,
    createdAt: '2026-10-31T00:00:00.000Z',
    updatedAt: '2026-10-31T00:00:00.000Z',
    stepCount: 1,
    ...(errorRef ? { errorRef } : {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStartSession.mockResolvedValue({
    sessionId: SESSION,
    status: 'QUEUED',
    eventsUrl: `https://api.example.com/v1/sessions/${SESSION}/events`,
    traceId: 'trace-1',
  });
  mockRetrieve.mockResolvedValue(REFUSAL);
});

describe('POST /v1/sessions?wait — the error of a failed session', () => {
  it('returns the stored step error with its code, message and details', async () => {
    mockGetSessionById.mockResolvedValue(sessionIn('FAILED', ERROR_REF));
    const app = await buildApp();
    const res = await startAndWait(app);
    expect(res.statusCode).toBe(201);
    expect(mockRetrieve).toHaveBeenCalledWith(ERROR_REF);
    expect(res.json()).toMatchObject({
      status: 'FAILED',
      errorRef: ERROR_REF,
      error: { code: REFUSAL.code, message: REFUSAL.message, details: REFUSAL.details },
    });
    await app.close();
  });

  it('returns no error when the stored error cannot be read', async () => {
    mockGetSessionById.mockResolvedValue(sessionIn('FAILED', ERROR_REF));
    mockRetrieve.mockRejectedValue(new Error('payload gone'));
    const app = await buildApp();
    const res = await startAndWait(app);
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('FAILED');
    expect(res.json().error).toBeUndefined();
    await app.close();
  });

  it('reads nothing for a session that succeeded', async () => {
    mockGetSessionById.mockResolvedValue(sessionIn('SUCCEEDED'));
    const app = await buildApp();
    const res = await startAndWait(app);
    expect(res.json().status).toBe('SUCCEEDED');
    expect(res.json().error).toBeUndefined();
    expect(mockRetrieve).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('storedStepErrorFrom', () => {
  it('reads an error nested under `error`', () => {
    expect(storedStepErrorFrom({ error: { code: 'X', message: 'm' } })).toEqual({
      code: 'X',
      message: 'm',
    });
  });

  it('drops details that are not an object', () => {
    expect(storedStepErrorFrom({ code: 'X', message: 'm', details: [{ path: 'a' }] })).toEqual({
      code: 'X',
      message: 'm',
    });
  });

  it('reads nothing from a payload without a code and a message', () => {
    expect(storedStepErrorFrom({ message: 'm' })).toBeUndefined();
    expect(storedStepErrorFrom('text')).toBeUndefined();
  });
});
