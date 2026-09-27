/**
 * What the core composition root serves, and that it boots as the appliance
 * runs it.
 *
 * The hosted half of this proof — that a hosted artifact serves both tiers and
 * strictly fewer as `community-local` — is `editionComposition.hosted.test.ts`,
 * which a public core does not carry because it has no second tier to compare.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { ENTERPRISE_ONLY_ENV_KEYS } from '@aflow/schemas';
import { coreComposition, coreSurfaceTier } from '../../compose/coreSurfaces.js';

// Read from the resolver rather than copied. A second copy is how the refusal
// came to name a key nothing consumes while the four that switch OpenFGA on
// went unchecked — and this list also scrubs the ambient environment below, so
// a stale copy leaves a real key set and the local build refuses to start.
const ENTERPRISE_ONLY_VARS = ENTERPRISE_ONLY_ENV_KEYS;

describe('core composition root', () => {
  it('names every surface exactly once', () => {
    const names = [
      ...coreSurfaceTier.root,
      ...coreSurfaceTier.v1({ actionCenterAggregator: null }),
    ].map((s) => s.name);
    expect(names).toHaveLength(new Set(names).size);
  });

  it('contributes the core tier and nothing else', () => {
    expect(coreComposition.tiers.map((tier) => tier.tier)).toEqual(['core']);
  });
});

describe('composed core application', () => {
  const saved = new Map<string, string | undefined>();

  beforeAll(() => {
    for (const key of [
      'USE_MOCK_CONTEXT',
      'PHOENIX_EDITION',
      'PHOENIX_INSTANCE_SECRET',
      'NODE_ENV',
      'CREDENTIAL_ENCRYPTION_KEY',
      ...ENTERPRISE_ONLY_VARS,
    ]) {
      saved.set(key, process.env[key]);
    }
    process.env['USE_MOCK_CONTEXT'] = 'true';
  });

  afterAll(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function localRouteTree(): Promise<string> {
    process.env['PHOENIX_EDITION'] = 'community-local';
    process.env['PHOENIX_INSTANCE_SECRET'] = 'x'.repeat(48);
    for (const key of ENTERPRISE_ONLY_VARS) delete process.env[key];
    const { buildApp } = await import('../../app.js');
    const app = await buildApp(coreComposition, { logger: false });
    await app.ready();
    const tree = app.printRoutes({ commonPrefix: false });
    await app.close();
    return tree;
  }

  const enterpriseOnlyPaths = [
    '/v1/invites',
    '/v1/invite-requests',
    'members/transfer-ownership',
    '/v1/audit',
    '/v1/admin/dlq',
    '/v1/admin/errors',
    '/v1/admin/authz/simulate',
    '/v1/admin/runs/:runId/quarantine-clear',
    '/v1/admin/capability-grants',
    '/v1/admin/capability-ceiling',
    '/v1/admin/tenant-quotas',
    'integration-allowlist',
    'store-policy',
    '/v1/voice/token',
    '/members (GET, HEAD, POST)',
    '/share (POST)',
  ];

  const corePaths = [
    '/health',
    '/v1/sessions',
    '/v1/catalog/operations',
    '/v1/credentials',
    '/v1/memory/docs',
    '/v1/store/listings',
    '/v1/admin/capability-profiles',
    '/v1/admin/spaces/:spaceId/capability-assignment',
    '/v1/tenant (GET, HEAD, PATCH)',
    // The chat model picker reads this, and renders no options without it.
    // Matched on the prefix: the hosted tree adds the governance PUT beside it.
    'agent-models (GET, HEAD',
  ];

  it('serves the core tier, and no enterprise path at all', async () => {
    const tree = await localRouteTree();
    for (const path of corePaths) {
      expect(tree, `expected ${path}`).toContain(path);
    }
    for (const path of enterpriseOnlyPaths) {
      expect(tree, `expected ${path} to be absent`).not.toContain(path);
    }
  }, 60_000);

  // The appliance's only credential is the generated instance secret, so
  // booting without one would leave the API reachable with none at all.
  it('refuses to boot the local edition without an instance secret', async () => {
    process.env['PHOENIX_EDITION'] = 'community-local';
    delete process.env['PHOENIX_INSTANCE_SECRET'];
    for (const key of ENTERPRISE_ONLY_VARS) delete process.env[key];
    const { buildApp } = await import('../../app.js');
    await expect(buildApp(coreComposition, { logger: false })).rejects.toThrow(
      /PHOENIX_INSTANCE_SECRET/,
    );
  }, 60_000);

  // The shipped image sets NODE_ENV=production, so the appliance meets the
  // production security floor rather than sidestepping it — a floor that used
  // to demand the Auth0 configuration this edition refuses to accept.
  it('boots the local edition under a production NODE_ENV', async () => {
    process.env['PHOENIX_EDITION'] = 'community-local';
    process.env['PHOENIX_INSTANCE_SECRET'] = 'x'.repeat(48);
    process.env['NODE_ENV'] = 'production';
    process.env['CREDENTIAL_ENCRYPTION_KEY'] = Buffer.alloc(32, 7).toString('base64');
    for (const key of ENTERPRISE_ONLY_VARS) delete process.env[key];

    const { buildApp } = await import('../../app.js');
    const app = await buildApp(coreComposition, { logger: false });
    await app.ready();
    const tree = app.printRoutes({ commonPrefix: false });
    await app.close();

    expect(tree).toContain('/v1/sessions');
    expect(tree).not.toContain('/v1/invites');
  }, 60_000);
});
