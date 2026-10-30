/**
 * Plan 335 P2: the profile routes answer only the local edition's owner, and
 * every change to the set of profiles drops the cached profile count.
 *
 * The service is a double here. `localProfiles.pg.test.ts` runs it on a real
 * database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { EditionId, LocalProfile } from '@aflow/schemas';

const service = vi.hoisted(() => ({
  listLocalProfiles: vi.fn(),
  addLocalProfile: vi.fn(),
  updateLocalProfile: vi.fn(),
  previewLocalProfileRemoval: vi.fn(),
  removeLocalProfile: vi.fn(),
}));

vi.mock('../services/localProfiles.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/localProfiles.js')>();
  return { ...actual, ...service };
});

const { localProfileRoutes } = await import('./localProfiles.js');
const { LocalProfileError } = await import('../services/localProfiles.js');

const OWNER = '00000000-0000-4000-8000-0000000ed1c1';
const SECOND = '00000000-0000-4000-8000-000000000b0b';

const profile = (userId: string, role: 'owner' | 'member'): LocalProfile => ({
  userId,
  displayName: role === 'owner' ? 'Local user' : 'Bob',
  avatar: role === 'owner' ? null : 'owl',
  role,
  isOwner: role === 'owner',
  createdAt: new Date(0).toISOString(),
});

async function build(
  edition: EditionId,
  tenantRole: 'owner' | 'admin' | 'member',
): Promise<{ app: FastifyInstance; dropLocalProfileCount: ReturnType<typeof vi.fn> }> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const dropLocalProfileCount = vi.fn();
  app.decorate('edition', { edition } as never);
  app.decorate('dropLocalProfileCount', dropLocalProfileCount);
  app.decorate('authenticate', async (request: { authUser?: unknown }) => {
    request.authUser = { userId: OWNER, authMethod: 'local', roles: [] };
  });
  (app as unknown as { appContext: unknown }).appContext = { db: {}, sql: {}, redis: null };
  app.decorateRequest('authUser', undefined);
  app.decorateRequest(
    'requireTenant',
    async () => ({ tenantId: 't', tenantRole, isAdmin: tenantRole !== 'member' }) as never,
  );
  await app.register(localProfileRoutes);
  await app.ready();
  return { app, dropLocalProfileCount };
}

const CALLS = [
  { method: 'GET', url: '/' },
  { method: 'POST', url: '/', payload: { displayName: 'Bob', avatar: 'owl' } },
  { method: 'PATCH', url: `/${SECOND}`, payload: { displayName: 'Robert' } },
  { method: 'GET', url: `/${SECOND}/removal` },
  { method: 'DELETE', url: `/${SECOND}` },
] as const;

beforeEach(() => {
  for (const fn of Object.values(service)) fn.mockReset();
});

describe('local profile routes', () => {
  it('are refused outside the local edition, before any profile is read', async () => {
    const { app } = await build('enterprise', 'owner');
    for (const call of CALLS) {
      const res = await app.inject(call);
      expect(res.statusCode, `${call.method} ${call.url}`).toBe(404);
      expect(res.json().message).toContain('local edition');
    }
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
    await app.close();
  });

  it.each(['member', 'admin'] as const)('refuse a %s profile session', async (role) => {
    const { app, dropLocalProfileCount } = await build('community-local', role);
    for (const call of CALLS) {
      const res = await app.inject(call);
      expect(res.statusCode, `${call.method} ${call.url}`).toBe(403);
    }
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
    expect(dropLocalProfileCount).not.toHaveBeenCalled();
    await app.close();
  });

  it('list the profiles for the owner', async () => {
    const { app } = await build('community-local', 'owner');
    service.listLocalProfiles.mockResolvedValue([profile(OWNER, 'owner')]);
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ profiles: [profile(OWNER, 'owner')] });
    await app.close();
  });

  it('add a profile and drop the profile count', async () => {
    const { app, dropLocalProfileCount } = await build('community-local', 'owner');
    const spaceId = '00000000-0000-4000-8000-00000000a11a';
    service.addLocalProfile.mockResolvedValue({ profile: profile(SECOND, 'member'), spaceId });
    const res = await app.inject({
      method: 'POST',
      url: '/',
      payload: { displayName: '  Bob  ', avatar: 'owl' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ profile: profile(SECOND, 'member'), spaceId });
    expect(service.addLocalProfile).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ tenantId: 't', displayName: 'Bob', avatar: 'owl' }),
    );
    expect(dropLocalProfileCount).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('refuse an avatar that is not built in, and a blank name', async () => {
    const { app, dropLocalProfileCount } = await build('community-local', 'owner');
    for (const payload of [
      { displayName: 'Bob', avatar: 'https://example.com/me.png' },
      { displayName: '   ', avatar: 'owl' },
    ]) {
      expect((await app.inject({ method: 'POST', url: '/', payload })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: 'PATCH', url: `/${SECOND}`, payload: {} })).statusCode).toBe(
      400,
    );
    expect(service.addLocalProfile).not.toHaveBeenCalled();
    expect(dropLocalProfileCount).not.toHaveBeenCalled();
    await app.close();
  });

  it('rename a profile and change its avatar', async () => {
    const { app } = await build('community-local', 'owner');
    const renamed = { ...profile(SECOND, 'member'), displayName: 'Robert', avatar: 'fox' as const };
    service.updateLocalProfile.mockResolvedValue(renamed);
    const res = await app.inject({
      method: 'PATCH',
      url: `/${SECOND}`,
      payload: { displayName: 'Robert', avatar: 'fox' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(renamed);
    expect(service.updateLocalProfile).toHaveBeenCalledWith(
      {},
      { tenantId: 't', userId: SECOND, displayName: 'Robert', avatar: 'fox' },
    );
    await app.close();
  });

  it('remove a profile and drop the profile count', async () => {
    const { app, dropLocalProfileCount } = await build('community-local', 'owner');
    const removed = { userId: SECOND, spacesDeleted: [], spacesTransferred: [] };
    service.removeLocalProfile.mockResolvedValue(removed);
    const res = await app.inject({ method: 'DELETE', url: `/${SECOND}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(removed);
    expect(dropLocalProfileCount).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('answer a refused removal with its status and leave the count alone', async () => {
    const { app, dropLocalProfileCount } = await build('community-local', 'owner');
    service.removeLocalProfile.mockRejectedValueOnce(
      new LocalProfileError('owner', 'The owner profile cannot be removed.'),
    );
    service.removeLocalProfile.mockRejectedValueOnce(
      new LocalProfileError('not_found', 'No profile with that id on this install.'),
    );
    expect((await app.inject({ method: 'DELETE', url: `/${OWNER}` })).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: `/${SECOND}` })).statusCode).toBe(404);
    expect(dropLocalProfileCount).not.toHaveBeenCalled();
    await app.close();
  });
});
