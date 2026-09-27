import { describe, it, expect, beforeAll } from 'vitest';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { configureLogging } from '@aflow/observability';
import { enforceIntegrationHostPolicy } from './enforce.js';
import { IntegrationHostPolicyError } from './assertHostsAllowed.js';

beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const SPACE_ID = '00000000-0000-4000-8000-000000000002';

interface FakeDbOpts {
  mode: 'open' | 'allowlist';
  allowRows?: Array<{ kind: string; hostPattern: string }>;
  grantRows?: Array<{ artifact_type: string; artifact_key: string; host_manifest_json: unknown }>;
}

function fakeDb(opts: FakeDbOpts): PostgresJsDatabase {
  let selectCall = 0;
  const grantTx = {
    execute: async (query: unknown) => {
      const text = JSON.stringify(query);
      if (text.includes('search_path')) return [];
      return opts.grantRows ?? [];
    },
  };
  return {
    select: () => ({
      from: () => ({
        where: () => {
          selectCall += 1;
          if (selectCall === 1) {
            return { limit: async () => [{ mode: opts.mode }] };
          }
          return Promise.resolve(opts.allowRows ?? []);
        },
      }),
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(grantTx),
  } as unknown as PostgresJsDatabase;
}

function base(db: PostgresJsDatabase) {
  return { db, tenantId: TENANT_ID, spaceId: SPACE_ID, kind: 'api' as const };
}

describe('enforceIntegrationHostPolicy', () => {
  it('passes everything in open mode without consulting rows', async () => {
    await expect(
      enforceIntegrationHostPolicy({
        ...base(fakeDb({ mode: 'open' })),
        hosts: ['anywhere.example'],
      }),
    ).resolves.toBeUndefined();
  });

  it('denies an uncovered host in allowlist mode with the teaching payload', async () => {
    const db = fakeDb({
      mode: 'allowlist',
      allowRows: [{ kind: 'api', hostPattern: 'ok.example.com' }],
    });
    try {
      await enforceIntegrationHostPolicy({
        ...base(db),
        hosts: ['ok.example.com', 'blocked.example'],
      });
      expect.unreachable('expected a denial');
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationHostPolicyError);
      const denial = (err as IntegrationHostPolicyError).denial;
      expect(denial.deniedHosts).toEqual(['blocked.example']);
      expect(denial.message).toContain('Tenant Admin → Integrations Policy');
    }
  });

  it('exempts hosts covered by the captured grant resolved through grantRefs', async () => {
    const db = fakeDb({
      mode: 'allowlist',
      grantRows: [
        {
          artifact_type: 'api_definition',
          artifact_key: 'github',
          host_manifest_json: {
            apiHosts: ['api.github.com'],
            oauthHosts: ['github.com'],
            mcpHosts: [],
            redirectHosts: [],
          },
        },
      ],
    });
    await expect(
      enforceIntegrationHostPolicy({
        ...base(db),
        hosts: ['api.github.com', 'github.com'],
        grantRefs: [{ artifactType: 'api_definition', artifactKey: 'github' }],
      }),
    ).resolves.toBeUndefined();
  });

  it('still denies hosts beyond the grant (custom edit drops to allowlist rules)', async () => {
    const db = fakeDb({
      mode: 'allowlist',
      grantRows: [
        {
          artifact_type: 'api_definition',
          artifact_key: 'github',
          host_manifest_json: {
            apiHosts: ['api.github.com'],
            oauthHosts: [],
            mcpHosts: [],
            redirectHosts: [],
          },
        },
      ],
    });
    await expect(
      enforceIntegrationHostPolicy({
        ...base(db),
        hosts: ['api.github.com', 'exfil.example'],
        grantRefs: [{ artifactType: 'api_definition', artifactKey: 'github' }],
      }),
    ).rejects.toBeInstanceOf(IntegrationHostPolicyError);
  });

  it('an explicit catalogGrant (store install) short-circuits the lookup', async () => {
    await expect(
      enforceIntegrationHostPolicy({
        ...base(fakeDb({ mode: 'allowlist' })),
        hosts: ['listing.example.com'],
        catalogGrant: {
          apiHosts: ['listing.example.com'],
          oauthHosts: [],
          mcpHosts: [],
          redirectHosts: [],
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('an empty host set never reads policy', async () => {
    const db = {
      select: () => {
        throw new Error('should not read');
      },
    } as unknown as PostgresJsDatabase;
    await expect(enforceIntegrationHostPolicy({ ...base(db), hosts: [] })).resolves.toBeUndefined();
  });
});
