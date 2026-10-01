/**
 * What the binding route owns is the operator's declaration about a folder.
 *
 * Every field here is an authority — what may be read, written, run, and now
 * which branches may be pushed — so what is worth asserting is that an
 * inconsistent declaration is refused rather than recorded, and that what is
 * recorded comes back as it was said.
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SpaceId, TenantId } from '@aflow/schemas';

const SPACE = '11111111-1111-4111-8111-111111111111';

const written = vi.hoisted(() => ({
  inserted: [] as Array<Record<string, unknown>>,
  updated: [] as Array<Record<string, unknown>>,
  existing: [] as Array<Record<string, unknown>>,
}));

const published = vi.hoisted(() => ({
  folders: [] as Array<{ id: string; spaceId: string; pushApproval: string }>,
}));

function storedRow(values: Record<string, unknown>): Record<string, unknown> {
  return {
    hostBindingId: 'hb_thing',
    label: 'thing',
    root: '/Users/someone/code/thing',
    writable: true,
    allowsExecution: true,
    branchPrefix: null,
    mcpServers: [],
    ...values,
  };
}

vi.mock('@aflow/database', () => ({
  createTenantContext: () => ({}),
  withTenantSchema: (_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({
      select: () => ({ from: () => ({ where: () => Promise.resolve(written.existing) }) }),
      insert: () => ({
        values: (values: Record<string, unknown>) => ({
          returning: () => {
            written.inserted.push(values);
            return Promise.resolve([storedRow(values)]);
          },
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => ({
            returning: () => {
              written.updated.push(values);
              return Promise.resolve([storedRow(values)]);
            },
          }),
        }),
      }),
      delete: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    }),
  hostBindings: { spaceId: {}, hostBindingId: {} },
}));
vi.mock('drizzle-orm', () => ({ eq: () => ({}), and: () => ({}) }));
vi.mock('@aflow/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/redis')>();
  return {
    getRedisConnection: () => ({ publish: () => Promise.resolve(1) }),
    HOST_WITHDRAWAL_CHANNEL: 'aflow:host-withdrawal',
    readLiveHostInventories: () =>
      Promise.resolve([
        {
          hostname: 'laptop',
          observedAt: new Date().toISOString(),
          runtimes: [],
          harnesses: [],
          folders: published.folders,
        },
      ]),
    pushApprovalsForSpace: actual.pushApprovalsForSpace,
  };
});

async function buildApp(): Promise<FastifyInstance> {
  const { hostBindingRoutes } = await import('./hostBindings.js');
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  (app as unknown as { appContext: unknown }).appContext = { db: {} };
  app.decorate('edition', { id: 'community-local', hostLane: 'present' } as never);
  app.decorateRequest('requireTenant', function (this: FastifyRequest) {
    return Promise.resolve({
      tenantId: 'a0000000-0000-4000-8000-000000000001' as TenantId,
      tenantRole: 'admin',
      isAdmin: true,
    });
  });
  app.decorateRequest('requireSpace', function (this: FastifyRequest) {
    return Promise.resolve({
      spaceId: SPACE as SpaceId,
      spaceRole: 'admin',
      canWrite: true,
      isSpaceAdmin: true,
      ownerId: null,
      memberCount: 1,
    });
  });
  await app.register(hostBindingRoutes, { prefix: '/spaces' });
  await app.ready();
  return app;
}

const body = {
  hostBindingId: 'hb_thing',
  label: 'thing',
  root: '/Users/someone/code/thing',
  writable: true,
  allowsExecution: true,
};

beforeEach(() => {
  written.inserted = [];
  written.updated = [];
  written.existing = [];
  published.folders = [];
});

describe('the folders a workspace lists', () => {
  it('says when a publication asks before pushing, as the machine publishes it', async () => {
    written.existing = [
      storedRow({ branchPrefix: 'aflow/' }),
      storedRow({ hostBindingId: 'hb_quiet', branchPrefix: 'aflow/' }),
      storedRow({ hostBindingId: 'hb_files', branchPrefix: null, allowsExecution: false }),
    ];
    published.folders = [
      { id: 'hb_thing', spaceId: SPACE, pushApproval: 'never' },
      { id: 'hb_quiet', spaceId: 'another-space', pushApproval: 'always' },
      { id: 'hb_files', spaceId: SPACE, pushApproval: 'always' },
    ];
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/spaces/${SPACE}/host-bindings` });
    expect(res.statusCode).toBe(200);
    const listed = (res.json() as { bindings: Array<Record<string, unknown>> }).bindings;
    expect(listed.map((b) => [b['hostBindingId'], b['pushApproval']])).toEqual([
      ['hb_thing', 'never'],
      // Published for another workspace, so this one does not hear of it.
      ['hb_quiet', null],
      // A folder that pushes nothing has no push to approve.
      ['hb_files', null],
    ]);
    await app.close();
  });
});

describe('which branches a connected folder may be pushed to', () => {
  it('records the prefix and returns it beside the other grants', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/spaces/${SPACE}/host-bindings`,
      payload: { ...body, branchPrefix: 'aflow/' },
    });
    expect(res.statusCode).toBe(200);
    expect(written.inserted[0]).toMatchObject({ branchPrefix: 'aflow/' });
    expect(res.json()).toMatchObject({ allowsExecution: true, branchPrefix: 'aflow/' });
    await app.close();
  });

  it('records no prefix for a folder connected without one', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/spaces/${SPACE}/host-bindings`,
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(written.inserted[0]).toMatchObject({ branchPrefix: null });
    expect(res.json()).toMatchObject({ branchPrefix: null });
    await app.close();
  });

  it('clears a prefix when the folder is reconnected without one', async () => {
    // Reconnecting is how a grant is narrowed. A prefix left in place by
    // omission would survive its own withdrawal.
    written.existing = [storedRow({ branchPrefix: 'aflow/' })];
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/spaces/${SPACE}/host-bindings`,
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(written.updated[0]).toMatchObject({ branchPrefix: null });
    await app.close();
  });

  it('refuses a prefix on a folder that runs no commands', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/spaces/${SPACE}/host-bindings`,
      payload: { ...body, allowsExecution: false, branchPrefix: 'aflow/' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'HostBindingInconsistent' });
    expect(written.inserted).toEqual([]);
    await app.close();
  });

  it('refuses a prefix that is not a name', async () => {
    const app = await buildApp();
    for (const branchPrefix of ['-oops', 'has space', 'up/../out']) {
      const res = await app.inject({
        method: 'POST',
        url: `/spaces/${SPACE}/host-bindings`,
        payload: { ...body, branchPrefix },
      });
      expect(res.statusCode).toBe(400);
    }
    expect(written.inserted).toEqual([]);
    await app.close();
  });
});
