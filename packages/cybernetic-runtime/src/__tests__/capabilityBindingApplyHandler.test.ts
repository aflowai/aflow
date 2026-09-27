import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StagedChange, ApiDefinitionDraft } from '@aflow/schemas';

// ============================================================================
// Captured SQL state
// ============================================================================

/** All param values (one entry per `${expr}` slot) across every tx.execute call. */
const capturedParams: unknown[][] = [];

function resetCaptures(): void {
  capturedParams.length = 0;
}

/**
 * Pull every interpolated value out of a drizzle `SQL` instance.
 *
 * drizzle's `sql` tag produces `queryChunks` interleaving `StringChunk`
 * (literal SQL fragments — `.value` is an array of strings) with the raw
 * `${expr}` interpolations. The handler passes JSON-stringified payloads as
 * plain string interpolations (e.g. `${placeholderAuth}`), so they appear
 * verbatim in the chunks array — NOT wrapped in `Param`. We collect:
 *  - plain primitives (string / number / boolean / null)
 *  - `.value` from `Param` instances (defensive — drizzle's internal calls
 *     can produce these even if the handler doesn't).
 */
function extractParamValues(query: unknown): unknown[] {
  const out: unknown[] = [];
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  for (const chunk of chunks) {
    if (chunk === null || chunk === undefined) continue;
    if (typeof chunk === 'string' || typeof chunk === 'number' || typeof chunk === 'boolean') {
      out.push(chunk);
      continue;
    }
    if (typeof chunk === 'object' && 'value' in chunk) {
      const value = (chunk as { value: unknown }).value;
      // StringChunk's `.value` is an array of literal SQL strings — skip.
      if (Array.isArray(value)) continue;
      out.push(value);
    }
  }
  return out;
}

// ============================================================================
// Mocks (must be declared before importing the handler)
// ============================================================================

vi.mock('@aflow/database', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    createTenantContext: (tenantId: string) => ({ tenantId, schema: 'test' }),
    apiBindings: { bindingId: 'binding_id' },
    withTenantSchema: async <T>(
      _db: unknown,
      _tenantCtx: unknown,
      callback: (tx: unknown) => Promise<T>,
    ): Promise<T> => {
      const mockTx = {
        execute: async (query: unknown) => {
          capturedParams.push(extractParamValues(query));
          // No SELECT result needed for the placeholder INSERT path; the
          // suggestedEgressPolicy branch (which SELECTs first) isn't covered
          // here.
          return [];
        },
      };
      return callback(mockTx);
    },
  };
});

vi.mock('../logger.js', () => ({
  getCyberneticLogger: () => ({
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  }),
}));

const { applyCapabilityBindingOps } = await import('../stagedChange/capabilityBindingApply.js');

// ============================================================================
// Fixtures
// ============================================================================

const ctx = {
  tenantId: '00000000-0000-0000-0000-000000000001',
  spaceId: '00000000-0000-0000-0000-000000000010',
  // The write path reads the tenant integration policy first; 'open' keeps
  // these placeholder-shape tests policy-neutral.
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [{ mode: 'open' }] }) }),
    }),
  } as never,
};

function makeDraft(authKind: ApiDefinitionDraft['authKind']): ApiDefinitionDraft {
  return {
    name: 'Test API',
    baseUrl: 'https://api.test.example/v1',
    authKind,
    endpoints: [{ method: 'GET', path: '/ping', summary: 'Health check' }],
  };
}

function makeProposal(authKind: ApiDefinitionDraft['authKind'], apiId: string): StagedChange {
  return {
    id: '00000000-0000-0000-0000-000000000aaa',
    kind: 'capability_binding',
    status: 'proposed',
    proposal: {
      summary: `Bind ${apiId}`,
      rationale: 'unit test',
      confidence: 'high',
      ops: [
        {
          op: 'capability.definition.upsert',
          kind: 'api',
          apiId,
          definition: makeDraft(authKind),
          rationale: 'unit test',
        },
      ],
    },
    evidence: { sourceSessionIds: [] },
    authorityLevel: 'require_operator',
    resolutionRoute: 'tenant_ratification',
    proposedAt: '2026-05-13T00:00:00.000Z',
    expiresAt: '2026-05-20T00:00:00.000Z',
    coachSessionId: '00000000-0000-0000-0000-000000000bbb',
  } as StagedChange;
}

/** Find the auth_json payload across all captured INSERT params. */
function findAuthJsonPayload(): Record<string, unknown> | null {
  for (const params of capturedParams) {
    for (const value of params) {
      if (typeof value !== 'string') continue;
      // The auth payload starts with `{` — every binding-related JSON
      // payload does. We identify the auth one by the `type` discriminator.
      if (!value.startsWith('{')) continue;
      try {
        const parsed = JSON.parse(value) as Record<string, unknown>;
        if (typeof parsed['type'] === 'string') return parsed;
      } catch {
        // Not JSON — skip.
      }
    }
  }
  return null;
}

// ============================================================================
// Tests
// ============================================================================

describe('applyCapabilityBindingOps — placeholder auth shape (Plan 142)', () => {
  beforeEach(resetCaptures);

  it('writes a basic-auth placeholder with BOTH username + password credential keys', async () => {
    const sc = makeProposal('basic', 'alpaca');
    const result = await applyCapabilityBindingOps(ctx, sc);

    expect(result.applied).toBe(true);
    expect(result.appliedOps).toEqual(['capability.definition.upsert']);

    const auth = findAuthJsonPayload();
    expect(auth).not.toBeNull();
    expect(auth).toEqual({
      type: 'basic',
      usernameCredentialKey: 'alpaca-default-username',
      passwordCredentialKey: 'alpaca-default-secret',
    });
  });

  it('writes an oauth2_client_credentials placeholder with BOTH client-id + client-secret keys', async () => {
    const sc = makeProposal('oauth2', 'stripe');
    await applyCapabilityBindingOps(ctx, sc);

    const auth = findAuthJsonPayload();
    expect(auth).toEqual({
      type: 'oauth2_client_credentials',
      clientIdCredentialKey: 'stripe-default-client-id',
      clientSecretCredentialKey: 'stripe-default-client-secret',
    });
  });

  it('writes a bearer placeholder with a single token credential key', async () => {
    const sc = makeProposal('bearer', 'openai');
    await applyCapabilityBindingOps(ctx, sc);

    const auth = findAuthJsonPayload();
    expect(auth).toEqual({ type: 'bearer', credentialKey: 'openai-default-token' });
  });

  it('writes an api_key placeholder with a single key credential', async () => {
    const sc = makeProposal('api_key', 'anthropic');
    await applyCapabilityBindingOps(ctx, sc);

    const auth = findAuthJsonPayload();
    expect(auth).toEqual({ type: 'api_key', credentialKey: 'anthropic-default-key' });
  });

  it('writes a none-auth placeholder with just the type discriminator', async () => {
    const sc = makeProposal('none', 'public-api');
    await applyCapabilityBindingOps(ctx, sc);

    const auth = findAuthJsonPayload();
    expect(auth).toEqual({ type: 'none' });
  });

  it('does NOT regress to the legacy `{ kind }` shape', async () => {
    const sc = makeProposal('basic', 'regression-check');
    await applyCapabilityBindingOps(ctx, sc);

    const auth = findAuthJsonPayload();
    expect(auth).not.toBeNull();
    expect(auth).not.toHaveProperty('kind');
    expect(auth).toHaveProperty('type');
  });
});
