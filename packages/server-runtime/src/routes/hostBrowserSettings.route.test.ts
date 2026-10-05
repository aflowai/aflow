/**
 * A profile's settings from the machine page: a person's request is relayed to
 * the machine's executor on its request channel and answered with the profile
 * as it now is, or with the executor's refusal; any other credential is
 * refused before anything is relayed.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { HOST_HARNESS_CONCURRENCY_DEFAULT } from '@aflow/schemas';

type Listener = (channel: string, message: string) => void;

const mocks = vi.hoisted(() => ({
  get: vi.fn<(key: string) => Promise<string | null>>(),
  publish: vi.fn<(channel: string, message: string) => Promise<number>>(),
  listeners: [] as Listener[],
  subscribed: [] as string[],
}));

vi.mock('@aflow/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/redis')>();
  return {
    ...actual,
    getRedisConfig: () => ({}),
    getRedisConnection: () => ({ get: mocks.get, publish: mocks.publish }),
    createSubscriberConnection: () => ({
      on: (_event: string, listener: Listener) => mocks.listeners.push(listener),
      subscribe: (channel: string) => {
        mocks.subscribed.push(channel);
        return Promise.resolve(1);
      },
      disconnect: () => {
        mocks.listeners.length = 0;
      },
    }),
  };
});

const { hostBrowserAnswerChannel, hostBrowserRequestChannel, hostInventoryKey } =
  await import('@aflow/redis');
const { hostBrowserSettingsRoutes } = await import('./hostBrowserSettings.js');

interface Credential {
  authMethod: string;
  isServicePrincipal?: boolean;
}

async function buildApp(credential: Credential): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('authenticate', async (request: FastifyRequest): Promise<void> => {
    (request as unknown as { authUser: unknown }).authUser = {
      userId: 'u1',
      roles: ['tenant_admin'],
      isServicePrincipal: false,
      ...credential,
    };
  });
  app.addHook('preHandler', async (request) => {
    await (app as unknown as { authenticate: (r: FastifyRequest) => Promise<void> }).authenticate(
      request,
    );
  });
  await app.register(hostBrowserSettingsRoutes, { prefix: '/host' });
  await app.ready();
  return app;
}

const PERSON: Credential = { authMethod: 'local' };

const INVENTORY = JSON.stringify({
  hostname: 'laptop',
  observedAt: new Date().toISOString(),
  runtimes: [],
  harnesses: [],
  maxConcurrentHarnessRuns: HOST_HARNESS_CONCURRENCY_DEFAULT,
  folders: [],
  browsers: [],
});

const PROFILE = {
  id: 'work',
  spaces: 'all',
  posture: 'ask-to-act',
  rules: [{ origin: 'https://mail.example.com', effect: 'deny' }],
  window: 'hidden',
  windowSize: { width: 1280, height: 800 },
  unattended: false,
  idleMinutes: 30,
  handoffMinutes: 15,
};

/** The machine's executor as the channel sees it: what it was asked, and what it answers. */
let answer: (request: Record<string, unknown>) => unknown;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listeners.length = 0;
  mocks.subscribed.length = 0;
  mocks.get.mockImplementation((key) =>
    Promise.resolve(key === hostInventoryKey('laptop') ? INVENTORY : null),
  );
  answer = () => ({ kind: 'changed', profile: PROFILE });
  mocks.publish.mockImplementation((channel, message) => {
    if (channel !== hostBrowserRequestChannel('laptop')) return Promise.resolve(0);
    const request = JSON.parse(message) as Record<string, unknown>;
    const reply = JSON.stringify(answer(request));
    queueMicrotask(() => {
      for (const listener of [...mocks.listeners]) {
        listener(hostBrowserAnswerChannel(String(request['answerId'])), reply);
      }
    });
    return Promise.resolve(1);
  });
});

const CONTROLS = [
  {
    method: 'PUT',
    url: '/host/browsers/work/posture',
    payload: { hostname: 'laptop', posture: 'ask-to-act' },
    setting: { kind: 'posture', posture: 'ask-to-act' },
  },
  {
    method: 'PUT',
    url: '/host/browsers/work/unattended',
    payload: { hostname: 'laptop', choice: 'refuse' },
    setting: { kind: 'unattended', choice: 'refuse' },
  },
  {
    method: 'PUT',
    url: '/host/browsers/work/rules',
    payload: { hostname: 'laptop', origin: 'https://mail.example.com', effect: 'deny' },
    setting: { kind: 'rule', origin: 'https://mail.example.com', effect: 'deny' },
  },
  {
    method: 'DELETE',
    url: '/host/browsers/work/rules',
    payload: { hostname: 'laptop', origin: '*.example.org' },
    setting: { kind: 'rule_remove', origin: '*.example.org' },
  },
] as const;

describe('changing a browser profile’s settings from the machine page', () => {
  it('refuses every credential that is not a person, relaying nothing', async () => {
    for (const credential of [
      { authMethod: 'api_key' },
      { authMethod: 'device' },
      { authMethod: 'system' },
      { authMethod: 'local', isServicePrincipal: true },
    ]) {
      const app = await buildApp(credential);
      for (const control of CONTROLS) {
        const response = await app.inject({
          method: control.method,
          url: control.url,
          ...('payload' in control ? { payload: control.payload } : {}),
        });
        expect(response.statusCode, `${credential.authMethod} ${control.url}`).toBe(403);
        expect(response.json<{ message: string }>().message).toContain(
          'settings are changed by a person',
        );
      }
    }
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('relays each change from the local web application to the machine and returns the profile it answers with', async () => {
    const app = await buildApp(PERSON);
    for (const control of CONTROLS) {
      mocks.publish.mockClear();
      const response = await app.inject({
        method: control.method,
        url: control.url,
        ...('payload' in control ? { payload: control.payload } : {}),
      });
      expect(response.statusCode, control.url).toBe(200);
      expect(response.json()).toEqual({ profile: PROFILE });
      const [channel, message] = mocks.publish.mock.calls[0] ?? [];
      expect(channel).toBe(hostBrowserRequestChannel('laptop'));
      const request = JSON.parse(message ?? '{}') as { answerId: string };
      expect(request).toEqual({
        kind: 'setting',
        hostname: 'laptop',
        profileId: 'work',
        answerId: request.answerId,
        setting: control.setting,
      });
      expect(mocks.subscribed).toContain(hostBrowserAnswerChannel(request.answerId));
    }
  });

  it('carries the executor’s refusal to the client in its own words', async () => {
    const refusal =
      "'default' would not be valid after that change: rules.0.origin: An origin rule names an exact origin";
    answer = () => ({ kind: 'refused', message: refusal });
    const app = await buildApp(PERSON);
    const response = await app.inject({
      method: 'PUT',
      url: '/host/browsers/default/rules',
      payload: { hostname: 'laptop', origin: 'mail.example.com', effect: 'deny' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: 'BrowserSettingRefused', message: refusal });
  });

  it('says so when the machine is not running, or nothing on it is listening', async () => {
    const app = await buildApp(PERSON);
    const elsewhere = await app.inject({
      method: 'PUT',
      url: '/host/browsers/work/posture',
      payload: { hostname: 'desktop', posture: 'read-only' },
    });
    expect(elsewhere.statusCode).toBe(404);
    expect(mocks.publish).not.toHaveBeenCalled();

    mocks.publish.mockResolvedValue(0);
    const unheard = await app.inject({
      method: 'PUT',
      url: '/host/browsers/work/posture',
      payload: { hostname: 'laptop', posture: 'read-only' },
    });
    expect(unheard.statusCode).toBe(503);
    expect(unheard.json<{ message: string }>().message).toContain('Nothing was changed');
  });
});
