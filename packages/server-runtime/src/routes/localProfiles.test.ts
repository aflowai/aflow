/**
 * Plan 335 P2: the profile routes answer only the local edition's owner, and
 * every change to the set of profiles drops the cached profile count.
 *
 * Plan 335 P3: the picker answers the instance secret with no profile session,
 * and it issues a session only for a profile that exists.
 *
 * The service is a double here. `localProfiles.pg.test.ts` runs it on a real
 * database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { LOCAL_BROWSER_CALLER_HEADER, type EditionId, type LocalProfile } from '@aflow/schemas';

const service = vi.hoisted(() => ({
  listLocalProfiles: vi.fn(),
  addLocalProfile: vi.fn(),
  updateLocalProfile: vi.fn(),
  previewLocalProfileRemoval: vi.fn(),
  removeLocalProfile: vi.fn(),
  readLocalProfile: vi.fn(),
}));

const sessions = vi.hoisted(() => ({ readLocalProfileSessionGeneration: vi.fn() }));

vi.mock('../services/localProfiles.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/localProfiles.js')>();
  return { ...actual, ...service };
});

vi.mock('../plugins/localProfiles.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../plugins/localProfiles.js')>();
  return { ...actual, ...sessions };
});

const { localProfileRoutes } = await import('./localProfiles.js');
const { LocalProfileError } = await import('../services/localProfiles.js');
const { readLocalProfileSession } = await import('../plugins/localProfiles.js');

const OWNER = '00000000-0000-4000-8000-0000000ed1c1';
const SECOND = '00000000-0000-4000-8000-000000000b0b';
const SECRET = 's'.repeat(48);

/** What the web process sends: the secret, and the mark on a browser's call. */
const WEB = { authorization: `Bearer ${SECRET}` };
const PROXIED_BROWSER = { ...WEB, [LOCAL_BROWSER_CALLER_HEADER]: '1' };

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
  opts: { sessionless?: boolean } = {},
): Promise<{ app: FastifyInstance; dropLocalProfileCount: ReturnType<typeof vi.fn> }> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const dropLocalProfileCount = vi.fn();
  app.decorate('edition', { edition, tenancy: { mode: 'fixed', tenantId: 't' } } as never);
  app.decorate('dropLocalProfileCount', dropLocalProfileCount);
  app.decorate('audit', { record: vi.fn() } as never);
  app.decorate('authenticate', async (request: { authUser?: unknown }, reply: FastifyReply) => {
    // What the auth plugin answers a browser with no session once a second
    // profile exists.
    if (opts.sessionless === true) {
      await reply.status(401).send({ error: 'Unauthorized', code: 'PROFILE_SESSION_REQUIRED' });
      return;
    }
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

const PICKER_CALLS = [
  { method: 'GET', url: '/picker' },
  { method: 'POST', url: `/${SECOND}/session` },
] as const;

let savedSecret: string | undefined;
beforeAll(() => {
  savedSecret = process.env['PHOENIX_INSTANCE_SECRET'];
  process.env['PHOENIX_INSTANCE_SECRET'] = SECRET;
});
afterAll(() => {
  if (savedSecret === undefined) delete process.env['PHOENIX_INSTANCE_SECRET'];
  else process.env['PHOENIX_INSTANCE_SECRET'] = savedSecret;
});

beforeEach(() => {
  for (const fn of Object.values(service)) fn.mockReset();
  for (const fn of Object.values(sessions)) fn.mockReset();
});

describe('local profile routes', () => {
  it('are refused outside the local edition, before any profile is read', async () => {
    const { app } = await build('enterprise', 'owner');
    for (const call of [...CALLS, ...PICKER_CALLS]) {
      const res = await app.inject({ ...call, headers: WEB });
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

describe('the profile picker', () => {
  const choice = (p: LocalProfile) => ({
    userId: p.userId,
    displayName: p.displayName,
    avatar: p.avatar,
    isOwner: p.isOwner,
  });

  it('answers a browser that authentication refuses for want of a session', async () => {
    const { app } = await build('community-local', 'member', { sessionless: true });
    expect(
      (await app.inject({ method: 'GET', url: '/', headers: PROXIED_BROWSER })).json(),
    ).toEqual(expect.objectContaining({ code: 'PROFILE_SESSION_REQUIRED' }));
    service.listLocalProfiles.mockResolvedValue([
      profile(OWNER, 'owner'),
      profile(SECOND, 'member'),
    ]);
    const res = await app.inject({ method: 'GET', url: '/picker', headers: PROXIED_BROWSER });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      profiles: [choice(profile(OWNER, 'owner')), choice(profile(SECOND, 'member'))],
    });
    expect(service.listLocalProfiles).toHaveBeenCalledWith({}, 't');
    await app.close();
  });

  it('answers the instance secret alone, never an API key or nothing', async () => {
    const { app } = await build('community-local', 'owner');
    for (const headers of [
      {},
      { authorization: 'Bearer phx_somekey' },
      { authorization: 'Bearer not-the-secret' },
    ]) {
      for (const call of PICKER_CALLS) {
        const res = await app.inject({ ...call, headers });
        expect(res.statusCode, `${call.method} ${call.url}`).toBe(401);
      }
    }
    expect(service.listLocalProfiles).not.toHaveBeenCalled();
    expect(service.readLocalProfile).not.toHaveBeenCalled();
    await app.close();
  });

  it('issues a session that names the chosen profile at its generation', async () => {
    const { app } = await build('community-local', 'member', { sessionless: true });
    service.readLocalProfile.mockResolvedValue(profile(SECOND, 'member'));
    sessions.readLocalProfileSessionGeneration.mockResolvedValue(3);
    const res = await app.inject({ method: 'POST', url: `/${SECOND}/session`, headers: WEB });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ profile: unknown; session: string }>();
    expect(body.profile).toEqual(choice(profile(SECOND, 'member')));
    expect(readLocalProfileSession(body.session, SECRET)).toEqual(
      expect.objectContaining({ userId: SECOND, generation: 3 }),
    );
    expect(service.readLocalProfile).toHaveBeenCalledWith({}, 't', SECOND);
    await app.close();
  });

  // One tap on a tile is one call. No profile asks for anything more.
  it.each([
    ['the owner', OWNER, 'owner'],
    ['a member', SECOND, 'member'],
  ] as const)('starts %s with one call and no body', async (_label, userId, role) => {
    const { app } = await build('community-local', 'member', { sessionless: true });
    service.readLocalProfile.mockResolvedValue(profile(userId, role));
    sessions.readLocalProfileSessionGeneration.mockResolvedValue(0);
    const res = await app.inject({ method: 'POST', url: `/${userId}/session`, headers: WEB });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(['profile', 'session']);
    expect(readLocalProfileSession(body['session'] as string, SECRET)).toEqual(
      expect.objectContaining({ userId, generation: 0 }),
    );
    await app.close();
  });

  it('serves no PIN route', async () => {
    const { app } = await build('community-local', 'owner');
    const put = await app.inject({
      method: 'PUT',
      url: `/${SECOND}/pin`,
      headers: WEB,
      payload: { pin: '2468' },
    });
    expect(put.statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'DELETE', url: `/${SECOND}/pin`, headers: WEB })).statusCode,
    ).toBe(404);
    await app.close();
  });

  it('issues no session for a profile that does not exist', async () => {
    const { app } = await build('community-local', 'owner');
    service.readLocalProfile.mockResolvedValue(null);
    const res = await app.inject({ method: 'POST', url: `/${SECOND}/session`, headers: WEB });
    expect(res.statusCode).toBe(404);
    expect(res.json()).not.toHaveProperty('session');
    expect(sessions.readLocalProfileSessionGeneration).not.toHaveBeenCalled();
    await app.close();
  });

  it('issues no session for a profile whose user row has gone', async () => {
    const { app } = await build('community-local', 'owner');
    service.readLocalProfile.mockResolvedValue(profile(SECOND, 'member'));
    sessions.readLocalProfileSessionGeneration.mockResolvedValue(null);
    const res = await app.inject({ method: 'POST', url: `/${SECOND}/session`, headers: WEB });
    expect(res.statusCode).toBe(404);
    expect(res.json()).not.toHaveProperty('session');
    await app.close();
  });

  it('hands no session to a call the web process proxied for a browser', async () => {
    const { app } = await build('community-local', 'owner');
    service.readLocalProfile.mockResolvedValue(profile(SECOND, 'member'));
    const res = await app.inject({
      method: 'POST',
      url: `/${SECOND}/session`,
      headers: PROXIED_BROWSER,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).not.toHaveProperty('session');
    expect(service.readLocalProfile).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses a choice that is not a user id', async () => {
    const { app } = await build('community-local', 'owner');
    const res = await app.inject({ method: 'POST', url: '/not-a-user/session', headers: WEB });
    expect(res.statusCode).toBe(400);
    expect(service.readLocalProfile).not.toHaveBeenCalled();
    await app.close();
  });
});
