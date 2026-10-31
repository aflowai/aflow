/**
 * Plan 335 P2: the profile routes answer only the local edition's owner, and
 * every change to the set of profiles drops the cached profile count.
 *
 * Plan 335 P3: the picker answers the instance secret with no profile session,
 * and it issues a session only for a profile that exists.
 *
 * Plan 335 P4: only the owner sets and resets a PIN, each change drops the
 * count, and a locked profile gets no session without its PIN.
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
  setLocalProfilePin: vi.fn(),
  resetLocalProfilePin: vi.fn(),
}));

const sessions = vi.hoisted(() => ({ readLocalProfileSessionGate: vi.fn() }));

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
const { hashLocalProfilePin } = await import('../services/localProfilePin.js');

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
  hasPin: false,
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

const choice = (p: LocalProfile) => ({
  userId: p.userId,
  displayName: p.displayName,
  avatar: p.avatar,
  isOwner: p.isOwner,
  hasPin: p.hasPin,
});

const CALLS = [
  { method: 'GET', url: '/' },
  { method: 'POST', url: '/', payload: { displayName: 'Bob', avatar: 'owl' } },
  { method: 'PATCH', url: `/${SECOND}`, payload: { displayName: 'Robert' } },
  { method: 'GET', url: `/${SECOND}/removal` },
  { method: 'DELETE', url: `/${SECOND}` },
  { method: 'PUT', url: `/${SECOND}/pin`, payload: { pin: '2468' } },
  { method: 'DELETE', url: `/${SECOND}/pin` },
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
    sessions.readLocalProfileSessionGate.mockResolvedValue({ generation: 3, pinHash: null });
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

  it('issues no session for a profile that does not exist', async () => {
    const { app } = await build('community-local', 'owner');
    service.readLocalProfile.mockResolvedValue(null);
    const res = await app.inject({ method: 'POST', url: `/${SECOND}/session`, headers: WEB });
    expect(res.statusCode).toBe(404);
    expect(res.json()).not.toHaveProperty('session');
    expect(sessions.readLocalProfileSessionGate).not.toHaveBeenCalled();
    await app.close();
  });

  it('issues no session for a profile whose user row has gone', async () => {
    const { app } = await build('community-local', 'owner');
    service.readLocalProfile.mockResolvedValue(profile(SECOND, 'member'));
    sessions.readLocalProfileSessionGate.mockResolvedValue(null);
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

describe('a profile PIN', () => {
  const PIN = '2468';
  const locked = { ...profile(SECOND, 'member'), hasPin: true };
  let pinHash: string;

  beforeAll(async () => {
    pinHash = await hashLocalProfilePin(PIN);
  });

  const choose = (app: FastifyInstance, pin?: string) =>
    app.inject({
      method: 'POST',
      url: `/${SECOND}/session`,
      headers: WEB,
      ...(pin === undefined ? {} : { payload: { pin } }),
    });

  it('is set by the owner, and the change drops the profile count', async () => {
    const { app, dropLocalProfileCount } = await build('community-local', 'owner');
    service.setLocalProfilePin.mockResolvedValue(locked);
    const res = await app.inject({ method: 'PUT', url: `/${SECOND}/pin`, payload: { pin: PIN } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(locked);
    expect(service.setLocalProfilePin).toHaveBeenCalledWith(
      {},
      { tenantId: 't', userId: SECOND, pin: PIN },
    );
    expect(dropLocalProfileCount).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it.each(['123', '1234567', 'abcd', '12 34'])('is refused when it is %j', async (pin) => {
    const { app, dropLocalProfileCount } = await build('community-local', 'owner');
    const res = await app.inject({ method: 'PUT', url: `/${SECOND}/pin`, payload: { pin } });
    expect(res.statusCode).toBe(400);
    expect(service.setLocalProfilePin).not.toHaveBeenCalled();
    expect(dropLocalProfileCount).not.toHaveBeenCalled();
    await app.close();
  });

  it('is reset by the owner, and the reset drops the profile count', async () => {
    const { app, dropLocalProfileCount } = await build('community-local', 'owner');
    service.resetLocalProfilePin.mockResolvedValue(profile(SECOND, 'member'));
    const res = await app.inject({ method: 'DELETE', url: `/${SECOND}/pin` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(expect.objectContaining({ hasPin: false }));
    expect(service.resetLocalProfilePin).toHaveBeenCalledWith(
      {},
      { tenantId: 't', userId: SECOND },
    );
    expect(dropLocalProfileCount).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('answers a change for no such profile with a 404 and leaves the count alone', async () => {
    const { app, dropLocalProfileCount } = await build('community-local', 'owner');
    service.resetLocalProfilePin.mockRejectedValue(
      new LocalProfileError('not_found', 'No profile with that id on this install.'),
    );
    expect((await app.inject({ method: 'DELETE', url: `/${SECOND}/pin` })).statusCode).toBe(404);
    expect(dropLocalProfileCount).not.toHaveBeenCalled();
    await app.close();
  });

  it('keeps a locked profile from starting without its PIN', async () => {
    const { app } = await build('community-local', 'member', { sessionless: true });
    service.readLocalProfile.mockResolvedValue(locked);
    sessions.readLocalProfileSessionGate.mockResolvedValue({ generation: 2, pinHash });
    for (const pin of [undefined, '']) {
      const res = await choose(app, pin);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual(expect.objectContaining({ code: 'PROFILE_PIN_REQUIRED' }));
      expect(res.json()).not.toHaveProperty('session');
    }
    await app.close();
  });

  it('issues nothing for a wrong PIN', async () => {
    const { app } = await build('community-local', 'member', { sessionless: true });
    service.readLocalProfile.mockResolvedValue(locked);
    sessions.readLocalProfileSessionGate.mockResolvedValue({ generation: 2, pinHash });
    const res = await choose(app, '1357');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual(expect.objectContaining({ code: 'PROFILE_PIN_INCORRECT' }));
    expect(res.json()).not.toHaveProperty('session');
    await app.close();
  });

  it('issues the session at the current generation for the right PIN', async () => {
    const { app } = await build('community-local', 'member', { sessionless: true });
    service.readLocalProfile.mockResolvedValue(locked);
    sessions.readLocalProfileSessionGate.mockResolvedValue({ generation: 2, pinHash });
    const res = await choose(app, PIN);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ profile: unknown; session: string }>();
    expect(body.profile).toEqual(choice(locked));
    expect(readLocalProfileSession(body.session, SECRET)).toEqual(
      expect.objectContaining({ userId: SECOND, generation: 2 }),
    );
    await app.close();
  });

  it('starts a profile with no PIN as P3 does, whatever the body says', async () => {
    const { app } = await build('community-local', 'member', { sessionless: true });
    service.readLocalProfile.mockResolvedValue(profile(SECOND, 'member'));
    sessions.readLocalProfileSessionGate.mockResolvedValue({ generation: 0, pinHash: null });
    expect((await choose(app)).statusCode).toBe(200);
    expect((await choose(app, '0000')).statusCode).toBe(200);
    await app.close();
  });

  it('makes a profile wait after repeated wrong PINs, until the owner resets it', async () => {
    const { app } = await build('community-local', 'owner');
    service.readLocalProfile.mockResolvedValue(locked);
    sessions.readLocalProfileSessionGate.mockResolvedValue({ generation: 2, pinHash });
    for (let i = 0; i < 5; i += 1) expect((await choose(app, '0000')).statusCode).toBe(401);
    const waiting = await choose(app, PIN);
    expect(waiting.statusCode).toBe(429);
    expect(waiting.json()).toEqual(expect.objectContaining({ code: 'PROFILE_PIN_THROTTLED' }));
    expect(waiting.headers['retry-after']).toBe('30');
    expect(waiting.json()).not.toHaveProperty('session');

    service.resetLocalProfilePin.mockResolvedValue(profile(SECOND, 'member'));
    expect((await app.inject({ method: 'DELETE', url: `/${SECOND}/pin` })).statusCode).toBe(200);
    expect((await choose(app, PIN)).statusCode).toBe(200);
    await app.close();
  });

  it('lists whether each profile is locked on the picker', async () => {
    const { app } = await build('community-local', 'member', { sessionless: true });
    service.listLocalProfiles.mockResolvedValue([profile(OWNER, 'owner'), locked]);
    const res = await app.inject({ method: 'GET', url: '/picker', headers: WEB });
    expect(res.json()).toEqual({ profiles: [choice(profile(OWNER, 'owner')), choice(locked)] });
    expect(JSON.stringify(res.json())).not.toContain('scrypt');
    await app.close();
  });
});
