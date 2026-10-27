/**
 * A folder's preview from the machine page (Plan 320 D18): a person's request
 * is relayed to the executor of the machine holding the folder on its folder
 * channel and answered with the declaration as it now is, or with the
 * executor's refusal; any other credential is refused, and so is a port this
 * stack serves on, before anything is relayed.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const { hostFolderAnswerChannel, hostFolderRequestChannel, hostInventoryKey } =
  await import('@aflow/redis');
const { hostFolderPreviewRoutes } = await import('./hostFolderPreview.js');

interface Credential {
  authMethod: string;
  isServicePrincipal?: boolean;
}

async function buildApp(credential: Credential): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('preHandler', async (request: FastifyRequest) => {
    (request as unknown as { authUser: unknown }).authUser = {
      userId: 'u1',
      roles: ['tenant_admin'],
      isServicePrincipal: false,
      ...credential,
    };
  });
  await app.register(hostFolderPreviewRoutes, { prefix: '/host' });
  await app.ready();
  return app;
}

const PERSON: Credential = { authMethod: 'local' };
const SPACE = '6f1d2c3b-4a5e-4f60-9a7b-8c9d0e1f2a3b';

const INVENTORY = JSON.stringify({
  hostname: 'laptop',
  observedAt: new Date().toISOString(),
  runtimes: [],
  harnesses: [],
  maxConcurrentHarnessRuns: HOST_HARNESS_CONCURRENCY_DEFAULT,
  folders: [],
  browsers: [],
});

const PREVIEW = { command: 'yarn dev --port {port}', uiPaths: ['src/**/*.tsx'] };

let answer: (request: Record<string, unknown>) => unknown;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listeners.length = 0;
  mocks.subscribed.length = 0;
  mocks.get.mockImplementation((key) =>
    Promise.resolve(key === hostInventoryKey('laptop') ? INVENTORY : null),
  );
  answer = (request) => ({ kind: 'changed', preview: request['preview'] });
  mocks.publish.mockImplementation((channel, message) => {
    if (channel !== hostFolderRequestChannel('laptop')) return Promise.resolve(0);
    const request = JSON.parse(message) as Record<string, unknown>;
    const reply = JSON.stringify(answer(request));
    queueMicrotask(() => {
      for (const listener of [...mocks.listeners]) {
        listener(hostFolderAnswerChannel(String(request['answerId'])), reply);
      }
    });
    return Promise.resolve(1);
  });
});

const CONTROLS = [
  {
    method: 'PUT',
    payload: { hostname: 'laptop', spaceId: SPACE, preview: PREVIEW },
    preview: PREVIEW,
  },
  { method: 'DELETE', payload: { hostname: 'laptop', spaceId: SPACE }, preview: null },
] as const;

const URL = '/host/folders/hb_site/preview';

describe('declaring a folder’s preview from the machine page', () => {
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
          url: URL,
          payload: control.payload,
        });
        expect(response.statusCode, `${credential.authMethod} ${control.method}`).toBe(403);
        expect(response.json<{ error: string; message: string }>()).toMatchObject({
          error: 'PersonRequired',
          message: expect.stringContaining('declared by a person'),
        });
      }
    }
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('relays a declaration and a clearing to the machine holding the folder, returning what it answers', async () => {
    const app = await buildApp(PERSON);
    for (const control of CONTROLS) {
      mocks.publish.mockClear();
      const response = await app.inject({
        method: control.method,
        url: URL,
        payload: control.payload,
      });
      expect(response.statusCode, control.method).toBe(200);
      expect(response.json()).toEqual({ preview: control.preview });
      const [channel, message] = mocks.publish.mock.calls[0] ?? [];
      expect(channel).toBe(hostFolderRequestChannel('laptop'));
      const request = JSON.parse(message ?? '{}') as { answerId: string };
      expect(request).toEqual({
        kind: 'preview',
        hostname: 'laptop',
        answerId: request.answerId,
        spaceId: SPACE,
        bindingId: 'hb_site',
        preview: control.preview,
      });
      expect(mocks.subscribed).toContain(hostFolderAnswerChannel(request.answerId));
    }
  });

  it('refuses a port this stack serves on, saying why, and relays nothing', async () => {
    const app = await buildApp(PERSON);
    for (const port of [3000, 3001, 3100, 6379, 5433, 8080]) {
      const response = await app.inject({
        method: 'PUT',
        url: URL,
        payload: { hostname: 'laptop', spaceId: SPACE, preview: { command: 'yarn dev', port } },
      });
      expect(response.statusCode, String(port)).toBe(422);
      const body = response.json<{ error: string; message: string }>();
      expect(body.error).toBe('FolderPreviewRefused');
      expect(body.message, String(port)).toContain(`Port ${String(port)} is this stack's own`);
      expect(body.message).toContain("so no folder's preview is declared on it");
    }
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('refuses a declaration the shared schema refuses, before anything is relayed', async () => {
    const app = await buildApp(PERSON);
    const response = await app.inject({
      method: 'PUT',
      url: URL,
      payload: { hostname: 'laptop', spaceId: SPACE, preview: { command: 'yarn dev' } },
    });
    expect(response.statusCode).toBe(400);
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('carries the executor’s refusal in its own words', async () => {
    const refusal = 'Binding `hb_site` was not connected for this workspace.';
    answer = () => ({ kind: 'refused', message: refusal });
    const app = await buildApp(PERSON);
    const response = await app.inject({ method: 'PUT', url: URL, payload: CONTROLS[0].payload });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: 'FolderPreviewRefused', message: refusal });
  });

  it('says so when the machine is not running, or nothing on it is listening', async () => {
    const app = await buildApp(PERSON);
    const elsewhere = await app.inject({
      method: 'PUT',
      url: URL,
      payload: { ...CONTROLS[0].payload, hostname: 'desktop' },
    });
    expect(elsewhere.statusCode).toBe(404);
    expect(mocks.publish).not.toHaveBeenCalled();

    mocks.publish.mockResolvedValue(0);
    const unheard = await app.inject({ method: 'PUT', url: URL, payload: CONTROLS[0].payload });
    expect(unheard.statusCode).toBe(503);
    expect(unheard.json<{ message: string }>().message).toContain('Nothing was changed');
  });
});

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'dist', '.next', '__tests__'].includes(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('the folder request channel', () => {
  it('is published by the operator route alone and heard by the host executor alone', () => {
    const naming = ['apps', 'packages']
      .flatMap((root) => sources(join(REPO, root)))
      .filter((file) => readFileSync(file, 'utf8').includes('hostFolderRequestChannel'))
      .map((file) => relative(REPO, file))
      .sort();
    expect(naming).toEqual([
      'apps/aflow-executor-host/src/index.ts',
      'packages/redis/src/hostInventory.ts',
      'packages/server-runtime/src/routes/hostFolderPreview.ts',
    ]);
  });
});
