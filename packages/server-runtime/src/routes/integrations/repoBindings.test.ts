/**
 * Repo-designation route — security-invariant coverage (Plan 219 §0.3, Plan 222 P3).
 *
 * The route is the authority boundary the coding lane references, so the tests pin
 * the NON-NEGOTIABLE rejections: an unparseable coordinate, an unsafe git host, a
 * pattern that would admit the default branch, neither-connection-nor-credential,
 * and linking a disabled / non-github connection. It also covers the two create
 * modes: BOOTSTRAP a connection from a named credential, and LINK an existing one.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

interface RepoBindingRecord {
  repoDesignationId: string;
  spaceId: string;
  coordinate: string;
  description: string | null;
  defaultBranch: string;
  allowedPushBranchPatterns: string[];
  egressHosts: string[];
  checkProfilesJson: Array<{ name: string; commands: string[] }>;
  connectionBindingId: string;
  credentialKey: string | null;
  status: string;
  lastValidatedAt: Date | null;
  lastErrorAt: Date | null;
  lastErrorCode: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

interface ApiBindingRecord {
  bindingId: string;
  spaceId: string;
  apiId: string;
  enabled: number;
  authJson: Record<string, unknown>;
}

interface ApiDefinitionRecord {
  apiId: string;
  spaceId: string;
  baseUrl: string;
}

const store = vi.hoisted(() => ({
  bindings: [] as RepoBindingRecord[],
  apiBindings: [] as ApiBindingRecord[],
  apiDefinitions: [] as ApiDefinitionRecord[],
  credentialKeys: new Set<string>(),
}));

const tableMarkers = vi.hoisted(() => ({
  repoBindings: {
    __table: 'repo_bindings',
    repoDesignationId: 'repoDesignationId',
    coordinate: 'coordinate',
    spaceId: 'spaceId',
  },
  apiBindings: {
    __table: 'api_bindings',
    bindingId: 'bindingId',
    spaceId: 'spaceId',
    apiId: 'apiId',
    enabled: 'enabled',
    authJson: 'authJson',
  },
  apiDefinitions: {
    __table: 'api_definitions',
    apiId: 'apiId',
    spaceId: 'spaceId',
    baseUrl: 'baseUrl',
  },
  apiCredentials: {
    __table: 'api_credentials',
    credentialKey: 'credentialKey',
    spaceId: 'spaceId',
  },
}));

interface Predicate {
  kind: string;
  column?: unknown;
  value?: unknown;
  args?: Predicate[];
}

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ kind: 'and', args }),
  eq: (column: unknown, value: unknown) => ({ kind: 'eq', column, value }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ kind: 'sql', strings, values }),
}));

vi.mock('@aflow/database', () => ({
  createTenantContext: (tenantId: string) => ({ tenantId }),
  withTenantSchema: async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn(makeFakeTx()),
  repoBindings: tableMarkers.repoBindings,
  apiBindings: tableMarkers.apiBindings,
  apiDefinitions: tableMarkers.apiDefinitions,
  apiCredentials: tableMarkers.apiCredentials,
}));

// The route reaches the github connector + api-write helpers ONLY on the bootstrap
// path. Stub them so the test stays isolated from those packages' (drizzle-/db-
// importing) graphs, which the global drizzle-orm + @aflow/database mocks break.
vi.mock('@aflow/cybernetic-runtime', () => ({
  writeApiDefinition: vi.fn(async () => ({ status: 'skipped' })),
  writePlaceholderBinding: vi.fn(async () => ({ status: 'skipped' })),
  parseHostFromUrl: (url: string) => {
    try {
      return new URL(url).host || null;
    } catch {
      return null;
    }
  },
  mergeSuggestedEgressIntoBaseline: (base: Record<string, unknown>) => base,
  collectRepoDesignationHosts: (input: { gitHost: string }) => [input.gitHost],
  enforceIntegrationHostPolicy: vi.fn(async () => undefined),
  IntegrationHostPolicyError: class IntegrationHostPolicyError extends Error {},
}));

vi.mock('@aflow/platform-artifacts', () => ({
  getConnectorCatalogEntry: (id: string) =>
    id === 'github'
      ? { definition: { apiId: 'github', name: 'GitHub', baseUrl: 'https://api.github.com' } }
      : null,
}));

vi.mock('@aflow/redis', () => ({
  publishApiCatalogInvalidation: vi.fn(),
}));

const SPACE_ID = '00000000-0000-4000-8000-000000000002';
const USER_ID = '00000000-0000-4000-8000-0000000000aa';

function matchesPredicate(row: Record<string, unknown>, pred: Predicate | undefined): boolean {
  if (!pred) return true;
  if (pred.kind === 'and') return (pred.args ?? []).every((p) => matchesPredicate(row, p));
  if (pred.kind === 'eq') {
    if (pred.column === 'spaceId') return pred.value === SPACE_ID;
    return row[pred.column as string] === pred.value;
  }
  return true;
}

function makeFakeTx() {
  return {
    select: (_shape?: unknown) => ({
      from: (table: unknown) => ({
        where: (predicate: Predicate) => {
          const resolve = () => rowsFor(table, predicate);
          const limited = { limit: (_n: number) => Promise.resolve(resolve()) };
          return Object.assign(Promise.resolve(resolve()), limited);
        },
      }),
    }),
    execute: async (query: { kind: string; strings: TemplateStringsArray; values: unknown[] }) =>
      applyExecute(query),
  };
}

function rowsFor(table: unknown, predicate: Predicate): unknown[] {
  if (table === tableMarkers.apiCredentials) {
    return [...store.credentialKeys]
      .map((credentialKey) => ({ credentialKey, spaceId: SPACE_ID }))
      .filter((row) => matchesPredicate(row, predicate));
  }
  if (table === tableMarkers.apiBindings) {
    return store.apiBindings.filter((row) =>
      matchesPredicate(row as unknown as Record<string, unknown>, predicate),
    );
  }
  if (table === tableMarkers.apiDefinitions) {
    return store.apiDefinitions.filter((row) =>
      matchesPredicate(row as unknown as Record<string, unknown>, predicate),
    );
  }
  if (table === tableMarkers.repoBindings) {
    return store.bindings.filter((row) =>
      matchesPredicate(row as unknown as Record<string, unknown>, predicate),
    );
  }
  return [];
}

function applyExecute(query: { strings: TemplateStringsArray; values: unknown[] }): unknown[] {
  const text = query.strings.join('?');
  if (text.includes('INSERT INTO repo_bindings')) {
    const [
      id,
      ,
      coordinate,
      description,
      defaultBranch,
      patterns,
      egress,
      checks,
      connBindingId,
      credKey,
    ] = query.values as [
      string,
      unknown,
      string,
      string | null,
      string,
      string,
      string,
      string,
      string,
      string | null,
      ...unknown[],
    ];
    const now = new Date();
    const existingIdx = store.bindings.findIndex((b) => b.coordinate === coordinate);
    const persistedId = existingIdx >= 0 ? store.bindings[existingIdx]!.repoDesignationId : id;
    const record: RepoBindingRecord = {
      repoDesignationId: persistedId,
      spaceId: SPACE_ID,
      coordinate,
      description: description ?? null,
      defaultBranch,
      allowedPushBranchPatterns: JSON.parse(patterns) as string[],
      egressHosts: JSON.parse(egress) as string[],
      checkProfilesJson: JSON.parse(checks) as Array<{ name: string; commands: string[] }>,
      connectionBindingId: connBindingId,
      credentialKey: credKey,
      status: 'ready',
      lastValidatedAt: null,
      lastErrorAt: null,
      lastErrorCode: null,
      createdBy: USER_ID,
      createdAt: existingIdx >= 0 ? store.bindings[existingIdx]!.createdAt : now,
      updatedAt: now,
    };
    if (existingIdx >= 0) store.bindings[existingIdx] = record;
    else store.bindings.push(record);
    return [{ repo_designation_id: persistedId }];
  }
  if (text.includes("UPDATE repo_bindings SET status = 'archived'")) {
    const id = query.values[0] as string;
    const rec = store.bindings.find((b) => b.repoDesignationId === id);
    if (rec) rec.status = 'archived';
    return [];
  }
  // Bootstrap writes the github definition + binding via writeApiDefinition /
  // writePlaceholderBinding (conflictPolicy 'skip'); the empty result reads as
  // "already present" — fine, the test only asserts the repo_bindings row + reply.
  return [];
}

const { registerRepoBindingRoutes } = await import('./repoBindings.js');

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  (app as unknown as { appContext: unknown }).appContext = {
    db: {} as never,
    // A publish stub so the bootstrap path's publishApiCatalogInvalidation is a no-op.
    redis: { publish: () => Promise.resolve(0) } as never,
  };

  app.addHook('onRequest', async (request: FastifyRequest) => {
    (request as unknown as { requireTenant: () => Promise<{ tenantId: string }> }).requireTenant =
      async () => ({ tenantId: '00000000-0000-4000-8000-000000000001' });
    (request as unknown as { requireSpace: () => Promise<{ spaceId: string }> }).requireSpace =
      async () => ({ spaceId: SPACE_ID });
    request.authUser = { userId: USER_ID } as FastifyRequest['authUser'];
  });

  registerRepoBindingRoutes(app);
  await app.ready();
  return app;
}

// Bootstrap mode: a named credential, no connectionBindingId.
const VALID_BODY = {
  repo: 'example/repo',
  defaultBranch: 'main',
  allowedPushBranchPatterns: ['agent/*'],
  credentialKey: 'git-pat',
};

function seedGithubConnection(over: Partial<ApiBindingRecord> = {}): void {
  store.apiBindings.push({
    bindingId: 'github-default',
    spaceId: SPACE_ID,
    apiId: 'github',
    enabled: 1,
    authJson: { type: 'bearer', credentialKey: 'git-pat' },
    ...over,
  });
  store.apiDefinitions.push({
    apiId: 'github',
    spaceId: SPACE_ID,
    baseUrl: 'https://api.github.com',
  });
}

describe('repo-designations route', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    store.bindings = [];
    store.apiBindings = [];
    store.apiDefinitions = [];
    store.credentialKeys = new Set(['git-pat']);
    app = await buildApp();
  });

  it('bootstraps a connection from a credential and sets status=ready', async () => {
    const res = await app.inject({ method: 'POST', url: '/repo-bindings', payload: VALID_BODY });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.coordinate).toBe('github.com/example/repo');
    expect(body.status).toBe('ready');
    expect(typeof body.repoDesignationId).toBe('string');
    expect(store.bindings).toHaveLength(1);
    expect(store.bindings[0]!.status).toBe('ready');
    expect(store.bindings[0]!.coordinate).toBe('github.com/example/repo');
    // Bootstrap puts the credential on the CONNECTION; the designation override is null.
    expect(store.bindings[0]!.connectionBindingId).toBe('github-default');
    expect(store.bindings[0]!.credentialKey).toBeNull();
    expect(store.bindings[0]!.createdBy).toBe(USER_ID);
  });

  it('links an existing GitHub connection (no credential on the repo)', async () => {
    seedGithubConnection();
    const { credentialKey: _omit, ...withoutCred } = VALID_BODY;
    const res = await app.inject({
      method: 'POST',
      url: '/repo-bindings',
      payload: { ...withoutCred, connectionBindingId: 'github-default' },
    });
    expect(res.statusCode).toBe(200);
    expect(store.bindings).toHaveLength(1);
    expect(store.bindings[0]!.connectionBindingId).toBe('github-default');
    expect(store.bindings[0]!.credentialKey).toBeNull();
  });

  it('rejects linking a disabled connection', async () => {
    seedGithubConnection({ enabled: 0 });
    const { credentialKey: _omit, ...withoutCred } = VALID_BODY;
    const res = await app.inject({
      method: 'POST',
      url: '/repo-bindings',
      payload: { ...withoutCred, connectionBindingId: 'github-default' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/disabled/i);
    expect(store.bindings).toHaveLength(0);
  });

  it('HARD-FAILS linking a connection with a per-repo credential that differs (no silent skip)', async () => {
    seedGithubConnection(); // connection bearer key = 'git-pat'
    store.credentialKeys = new Set(['git-pat', 'other-pat']);
    const res = await app.inject({
      method: 'POST',
      url: '/repo-bindings',
      payload: { ...VALID_BODY, connectionBindingId: 'github-default', credentialKey: 'other-pat' },
    });
    expect(res.statusCode).toBe(400);
    expect(store.bindings).toHaveLength(0);
  });

  it('HARD-FAILS bootstrap when a github-default with a DIFFERENT credential already exists', async () => {
    seedGithubConnection({ authJson: { type: 'bearer', credentialKey: 'other-key' } });
    const res = await app.inject({ method: 'POST', url: '/repo-bindings', payload: VALID_BODY });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/different credential/i);
    expect(store.bindings).toHaveLength(0);
  });

  it('bootstrap REUSES a matching enabled github-default without a second binding', async () => {
    seedGithubConnection(); // matching key 'git-pat', enabled
    const res = await app.inject({ method: 'POST', url: '/repo-bindings', payload: VALID_BODY });
    expect(res.statusCode).toBe(200);
    expect(store.apiBindings).toHaveLength(1); // reused, not a second connection
    expect(store.bindings[0]!.connectionBindingId).toBe('github-default');
    expect(store.bindings[0]!.credentialKey).toBeNull();
  });

  it('HARD-FAILS bootstrap-reuse of a DISABLED github-default (ready stays honest)', async () => {
    seedGithubConnection({ enabled: 0 }); // matching key but disabled
    const res = await app.inject({ method: 'POST', url: '/repo-bindings', payload: VALID_BODY });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/disabled/i);
    expect(store.bindings).toHaveLength(0);
  });

  it('rejects linking a non-github connection', async () => {
    store.apiBindings.push({
      bindingId: 'github-default',
      spaceId: SPACE_ID,
      apiId: 'jira',
      enabled: 1,
      authJson: { type: 'bearer', credentialKey: 'git-pat' },
    });
    const { credentialKey: _omit, ...withoutCred } = VALID_BODY;
    const res = await app.inject({
      method: 'POST',
      url: '/repo-bindings',
      payload: { ...withoutCred, connectionBindingId: 'github-default' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not a github connection/i);
    expect(store.bindings).toHaveLength(0);
  });

  it('rejects when neither a connection nor a credential is supplied (schema boundary)', async () => {
    const { credentialKey: _omit, ...neither } = VALID_BODY;
    const res = await app.inject({ method: 'POST', url: '/repo-bindings', payload: neither });
    expect(res.statusCode).toBe(400);
    expect(store.bindings).toHaveLength(0);
  });

  it('accepts an https remote URL and canonicalizes it to a coordinate', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/repo-bindings',
      payload: { ...VALID_BODY, repo: 'https://github.com/example/repo.git' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().coordinate).toBe('github.com/example/repo');
  });

  it('upsert by coordinate keeps the surrogate id and updates the policy (the re-key invariant)', async () => {
    const create = await app.inject({ method: 'POST', url: '/repo-bindings', payload: VALID_BODY });
    const id1 = create.json().repoDesignationId;

    const update = await app.inject({
      method: 'POST',
      url: '/repo-bindings',
      payload: {
        ...VALID_BODY,
        defaultBranch: 'develop',
        allowedPushBranchPatterns: ['feature/*'],
      },
    });
    const id2 = update.json().repoDesignationId;

    expect(id2).toBe(id1);
    expect(store.bindings).toHaveLength(1);
    expect(store.bindings[0]!.defaultBranch).toBe('develop');
    expect(store.bindings[0]!.allowedPushBranchPatterns).toEqual(['feature/*']);
  });

  it('rejects an unparseable repo coordinate (schema boundary, 400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/repo-bindings',
      payload: { ...VALID_BODY, repo: 'ext::sh -c id' },
    });
    expect(res.statusCode).toBe(400);
    expect(store.bindings).toHaveLength(0);
  });

  it('rejects an unsafe git host (localhost / metadata IP) at the route', async () => {
    for (const repo of ['localhost/x/y', '169.254.169.254/x/y', '127.0.0.1/x/y']) {
      const res = await app.inject({
        method: 'POST',
        url: '/repo-bindings',
        payload: { ...VALID_BODY, repo },
      });
      expect(res.statusCode, `repo ${JSON.stringify(repo)}`).toBe(400);
      expect(res.json().error).toMatch(/allowed git host/i);
    }
    expect(store.bindings).toHaveLength(0);
  });

  /**
   * Host-safe and https is not the same question as reachable. The lane runs one
   * egress allowlist for the deployment, so a designation for a host absent from
   * it would store, report `ready`, and fail at its first clone with a proxy
   * refusal naming nothing the operator set.
   */
  it('rejects a host-safe git host the coding lane cannot reach', async () => {
    for (const repo of ['github.example.com/acme/app', 'gitlab.com/acme/app']) {
      const res = await app.inject({
        method: 'POST',
        url: '/repo-bindings',
        payload: { ...VALID_BODY, repo },
      });
      expect(res.statusCode, `repo ${JSON.stringify(repo)}`).toBe(400);
      expect(res.json().error).toMatch(/cannot reach/i);
    }
    expect(store.bindings).toHaveLength(0);
  });

  it('rejects a non-empty egressHosts rather than storing one nothing applies', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/repo-bindings',
      payload: { ...VALID_BODY, egressHosts: ['github.com'] },
    });
    expect(res.statusCode).toBe(400);
    expect(store.bindings).toHaveLength(0);
  });

  it('rejects allowedPushBranchPatterns that would admit the default branch', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/repo-bindings',
      payload: { ...VALID_BODY, allowedPushBranchPatterns: ['mai*'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/default branch/i);
    expect(store.bindings).toHaveLength(0);
  });

  it('rejects an exact-default-branch pattern too', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/repo-bindings',
      payload: { ...VALID_BODY, allowedPushBranchPatterns: ['agent/*', 'main'] },
    });
    expect(res.statusCode).toBe(400);
    expect(store.bindings).toHaveLength(0);
  });

  it('rejects case- and whitespace-variant patterns that would admit the default branch', async () => {
    for (const pattern of ['Main', 'mAin', '*ain', 'main ']) {
      const res = await app.inject({
        method: 'POST',
        url: '/repo-bindings',
        payload: { ...VALID_BODY, allowedPushBranchPatterns: [pattern] },
      });
      expect(res.statusCode, `pattern ${JSON.stringify(pattern)}`).toBe(400);
      expect(store.bindings).toHaveLength(0);
    }
  });

  it('rejects an invalid defaultBranch (whitespace, range, refspec injection)', async () => {
    for (const defaultBranch of ['bad branch', 'a..b', 'a:b', '-x']) {
      const res = await app.inject({
        method: 'POST',
        url: '/repo-bindings',
        payload: { ...VALID_BODY, defaultBranch },
      });
      expect(res.statusCode, `defaultBranch ${JSON.stringify(defaultBranch)}`).toBe(400);
      expect(store.bindings).toHaveLength(0);
    }
  });

  it('rejects an invalid allowedPushBranchPatterns entry', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/repo-bindings',
      payload: { ...VALID_BODY, allowedPushBranchPatterns: ['agent/..//x'] },
    });
    expect(res.statusCode).toBe(400);
    expect(store.bindings).toHaveLength(0);
  });

  it('rejects a credentialKey that does not resolve in the space', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/repo-bindings',
      payload: { ...VALID_BODY, credentialKey: 'missing-cred' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/credentialKey/);
    expect(store.bindings).toHaveLength(0);
  });

  it('lists and fetches a created designation without leaking a secret', async () => {
    const create = await app.inject({ method: 'POST', url: '/repo-bindings', payload: VALID_BODY });
    const { repoDesignationId } = create.json();

    const list = await app.inject({ method: 'GET', url: '/repo-bindings' });
    expect(list.statusCode).toBe(200);
    expect(list.json().repoBindings).toHaveLength(1);

    const detail = await app.inject({
      method: 'GET',
      url: `/repo-bindings/${repoDesignationId}`,
    });
    expect(detail.statusCode).toBe(200);
    const binding = detail.json().repoBinding;
    expect(binding.coordinate).toBe('github.com/example/repo');
    expect(binding.remoteUrl).toBe('https://github.com/example/repo.git');
    expect(binding.connectionBindingId).toBe('github-default');
    expect(binding.credentialKey).toBeNull();
    expect(JSON.stringify(binding)).not.toMatch(/encrypted|token|secret/i);
  });

  it('404s an unknown designation detail', async () => {
    const res = await app.inject({ method: 'GET', url: '/repo-bindings/nope' });
    expect(res.statusCode).toBe(404);
  });

  it('archives on DELETE (soft delete, not hard-delete)', async () => {
    const create = await app.inject({ method: 'POST', url: '/repo-bindings', payload: VALID_BODY });
    const { repoDesignationId } = create.json();

    const del = await app.inject({
      method: 'DELETE',
      url: `/repo-bindings/${repoDesignationId}`,
    });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ repoDesignationId, status: 'archived' });
    expect(store.bindings).toHaveLength(1);
    expect(store.bindings[0]!.status).toBe('archived');
  });

  it('404s DELETE for an unknown designation', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/repo-bindings/nope' });
    expect(res.statusCode).toBe(404);
  });
});
