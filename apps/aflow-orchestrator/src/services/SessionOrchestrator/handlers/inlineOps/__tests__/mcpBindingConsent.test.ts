import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InlineHandlerArgs } from '../types.js';

const mockAddStepResult = vi.fn();
let mockBindingRows: Array<Record<string, unknown>> = [];
let mockDefinitionRows: Array<Record<string, unknown>> = [];
const mockStartConsent = vi.fn();

vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
}));

vi.mock('@aflow/database', () => {
  const mcpServerBindings = {
    __table: 'mcpServerBindings',
    bindingId: 'bindingId',
    spaceId: 'spaceId',
  };
  const mcpServerDefinitions = {
    __table: 'mcpServerDefinitions',
    serverId: 'serverId',
    spaceId: 'spaceId',
  };

  function buildTx(): unknown {
    return {
      select: () => ({
        from: (table: { __table: string }) => ({
          where: () => ({
            limit: () => {
              switch (table.__table) {
                case 'mcpServerBindings':
                  return Promise.resolve(mockBindingRows);
                case 'mcpServerDefinitions':
                  return Promise.resolve(mockDefinitionRows);
                default:
                  return Promise.resolve([]);
              }
            },
          }),
        }),
      }),
    };
  }

  return {
    getDatabase: vi.fn(() => ({})),
    createTenantContext: vi.fn(() => ({})),
    withTenantSchema: vi.fn(async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(buildTx()),
    ),
    mcpServerBindings,
    mcpServerDefinitions,
  };
});

vi.mock('@aflow/oauth', () => ({
  startConsent: (...args: unknown[]) => mockStartConsent(...args),
  resolveOAuthCallbackUrl: () => 'https://api.aflow.ai/v1/oauth/callback',
  resolveOAuthOwner: (ownerScope: string, ctx: { spaceId: string; tenantId: string }) => {
    if (ownerScope === 'user') return { needsConsent: 'no_user_identity' };
    return { ownerId: ctx.spaceId };
  },
  buildMcpOAuthDescriptor: () => ({
    discovery: { serverUrl: 'https://kaggle.com/mcp' },
    issuerKey: 'https://kaggle.com',
    platformClientId: 'https://api.aflow.ai/.well-known/cimd',
  }),
}));

import { handleMcpBindingConsentInline } from '../mcpBindingConsent.js';

const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const SPACE_ID = '41be431d-6011-495b-a4f2-6de539a6a0df';

function inlineRef(value: unknown): string {
  return `inline:${Buffer.from(JSON.stringify(value)).toString('base64')}`;
}

function decodeOutput(ref: string): Record<string, unknown> {
  const decoded = Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf8');
  return JSON.parse(decoded) as Record<string, unknown>;
}

function makeArgs(input: unknown): InlineHandlerArgs {
  return {
    redis: {} as never,
    payloadStore: {
      retrieve: vi.fn(async () => input),
      shouldStore: () => false,
    } as never,
    context: {
      tenantId: TENANT_ID,
      runId: 'session-1',
      traceId: 'trace-1',
      spaceId: SPACE_ID,
      actorContext: {},
      agentDefinition: { steps: [] },
    } as never,
    stepDef: {
      stepId: 'step-1',
      stepType: 'mcp',
      operation: 'mcp.binding.consent',
    } as never,
    stepExecutionId: 'sx-1' as never,
    idempotencyKey: 'idem-1' as never,
    resolvedInputRef: inlineRef(input),
    attempt: 1,
    scheduledAtMs: Date.now(),
  };
}

function bindingRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    bindingId: 'kaggle-default',
    serverId: 'kaggle',
    name: 'Kaggle',
    scopeJson: { tenantId: TENANT_ID, spaceId: SPACE_ID },
    spaceId: SPACE_ID,
    authJson: { type: 'oauth2_pkce' },
    connectionPolicyJson: {},
    subscribeListChanged: 1,
    samplingPolicy: 'off',
    ownerScope: 'space',
    clientScope: 'platform',
    pinnedOrigin: 'https://kaggle.com',
    enabled: 1,
    ...overrides,
  };
}

function definitionRow(): Record<string, unknown> {
  return {
    definitionJson: {
      serverId: 'kaggle',
      name: 'Kaggle',
      serverUrl: 'https://kaggle.com/mcp',
      transport: 'streamable_http',
      tags: [],
      source: 'custom',
    },
  };
}

beforeEach(() => {
  mockAddStepResult.mockReset();
  mockStartConsent.mockReset();
  mockBindingRows = [];
  mockDefinitionRows = [];
});

describe('handleMcpBindingConsentInline', () => {
  it('rejects missing bindingId', async () => {
    await handleMcpBindingConsentInline(makeArgs({}));
    expect(mockAddStepResult).toHaveBeenCalledTimes(1);
    const msg = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    expect(msg['status']).toBe('FAILED');
    const errorRef = msg['errorRef'] as string;
    const err = decodeOutput(errorRef);
    expect(err['code']).toBe('MCP_CONSENT_INVALID_INPUT');
  });

  it('rejects when binding not found in space', async () => {
    mockBindingRows = [];
    await handleMcpBindingConsentInline(makeArgs({ bindingId: 'missing' }));
    const msg = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    expect(msg['status']).toBe('FAILED');
    expect(decodeOutput(msg['errorRef'] as string)['code']).toBe('MCP_CONSENT_BINDING_NOT_FOUND');
  });

  it('rejects bindings with non-OAuth auth type', async () => {
    mockBindingRows = [bindingRow({ authJson: { type: 'bearer', credentialKey: 'k' } })];
    await handleMcpBindingConsentInline(makeArgs({ bindingId: 'kaggle-default' }));
    const msg = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    expect(decodeOutput(msg['errorRef'] as string)['code']).toBe(
      'MCP_CONSENT_UNSUPPORTED_AUTH_TYPE',
    );
  });

  it('rejects when definition missing in space', async () => {
    mockBindingRows = [bindingRow()];
    mockDefinitionRows = [];
    await handleMcpBindingConsentInline(makeArgs({ bindingId: 'kaggle-default' }));
    const msg = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    expect(decodeOutput(msg['errorRef'] as string)['code']).toBe(
      'MCP_CONSENT_DEFINITION_NOT_FOUND',
    );
  });

  it('happy path — calls startConsent and emits authorizationUrl + state', async () => {
    mockBindingRows = [bindingRow()];
    mockDefinitionRows = [definitionRow()];
    const expiresAt = new Date('2030-01-01T00:00:00Z');
    mockStartConsent.mockResolvedValue({
      authorizationUrl: 'https://as.example.com/authorize?state=abc',
      state: 'abc',
      expiresAt,
      prm: {},
      asMetadata: {},
    });

    await handleMcpBindingConsentInline(makeArgs({ bindingId: 'kaggle-default' }));

    expect(mockStartConsent).toHaveBeenCalledTimes(1);
    const callArgs = mockStartConsent.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs['tenantId']).toBe(TENANT_ID);
    expect(callArgs['spaceId']).toBe(SPACE_ID);
    // The handler MUST resolve the redirect URI itself — never trust caller.
    expect(callArgs['redirectUri']).toContain('/v1/oauth/callback');

    const msg = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    expect(msg['status']).toBe('SUCCEEDED');
    const out = decodeOutput(msg['outputRef'] as string);
    expect(out['bindingId']).toBe('kaggle-default');
    expect(out['authorizationUrl']).toBe('https://as.example.com/authorize?state=abc');
    expect(out['state']).toBe('abc');
    expect(out['expiresAt']).toBe(expiresAt.toISOString());
  });

  it('surfaces startConsent failure as MCP_CONSENT_FAILED with internal classification', async () => {
    mockBindingRows = [bindingRow()];
    mockDefinitionRows = [definitionRow()];
    mockStartConsent.mockRejectedValue(new Error('oauth_no_authorization_server'));

    await handleMcpBindingConsentInline(makeArgs({ bindingId: 'kaggle-default' }));

    const msg = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    expect(msg['status']).toBe('FAILED');
    const err = decodeOutput(msg['errorRef'] as string);
    expect(err['code']).toBe('MCP_CONSENT_FAILED');
    // Upstream/transient failures past the input-shape gate get 'internal'
    // classification so the orchestrator doesn't treat a 5xx from the AS the
    // same as a malformed bindingId. `emitStepError` masks the raw message
    // on internal errors — assert on the code, not the masked message.
    expect(err['classification']).toBe('internal');
  });
});
