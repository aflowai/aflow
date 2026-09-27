import { describe, it, expect, vi } from 'vitest';
import type { ApiBinding, ApiCallInput, ApiDefinition } from '@aflow/schemas';
import type { ExecutorContext } from '@aflow/executor-runtime';

// Credential storage is envelope-encrypted; decryption is a separate concern
// from header assembly, which is what these tests are about.
vi.mock('./credentials.js', () => ({
  resolveCredentialOrThrow: (
    store: ReadonlyMap<string, string>,
    _apiId: string,
    key: string,
  ): Promise<string> => {
    const value = store.get(key);
    if (value === undefined) throw new Error(`missing credential ${key}`);
    return Promise.resolve(value);
  },
}));

import { buildHeaders, applyAuth } from './headers.js';
import { assertNoAuthMaterialInInput } from './authAssert.js';
import { mintRequestId } from './requestId.js';

const CREDENTIALS = new Map([
  ['etoro-api-key', 'app-key-value'],
  ['etoro-user-key', 'user-key-value'],
]);

const definition = {
  apiId: 'etoro-trading',
  name: 'eToro',
  baseUrl: 'https://public-api.etoro.com',
  version: '1',
  callMode: 'endpoint',
  requestIdHeader: 'x-request-id',
  defaultHeaders: { Accept: 'application/json' },
  tags: [],
  endpoints: [
    {
      endpointId: 'getPortfolio',
      name: 'Get portfolio',
      method: 'GET',
      pathTemplate: '/api/v1/trading/info/portfolio',
      params: [],
    },
  ],
} as unknown as ApiDefinition;

const binding = {
  bindingId: 'etoro-trading-default',
  apiId: 'etoro-trading',
  name: 'eToro',
  scope: { spaceId: 'space-1' },
  auth: {
    type: 'api_key_pair',
    primaryHeaderName: 'x-api-key',
    secondaryHeaderName: 'x-user-key',
    credentialKey: 'etoro-api-key',
    secondaryCredentialKey: 'etoro-user-key',
  },
  enabled: true,
} as unknown as ApiBinding;

const ctx = {
  runId: 'run-1',
  logicalExecutionId: 'step:abc',
  job: { attempt: 1 },
} as unknown as ExecutorContext;

function call(input: Partial<ApiCallInput> = {}): ApiCallInput {
  return { endpointId: 'getPortfolio', ...input } as ApiCallInput;
}

describe('api_key_pair on the wire', () => {
  it('sends both secrets under their own header names', async () => {
    const { headers } = await buildHeaders(
      CREDENTIALS,
      undefined,
      undefined,
      definition,
      call(),
      binding,
      ctx,
      'etoro-trading',
    );
    expect(headers['x-api-key']).toBe('app-key-value');
    expect(headers['x-user-key']).toBe('user-key-value');
    expect(headers['Authorization']).toBeUndefined();
  });

  it('mints the request-id header the definition declares', async () => {
    const { headers } = await buildHeaders(
      CREDENTIALS,
      undefined,
      undefined,
      definition,
      call(),
      binding,
      ctx,
      'etoro-trading',
    );
    expect(headers['x-request-id']).toBe(mintRequestId(ctx));
  });

  it('mints nothing when the definition declares no request-id header', async () => {
    const { requestIdHeader, ...withoutHeader } = definition as ApiDefinition & {
      requestIdHeader?: string;
    };
    void requestIdHeader;
    const { headers } = await buildHeaders(
      CREDENTIALS,
      undefined,
      undefined,
      withoutHeader as ApiDefinition,
      call(),
      binding,
      ctx,
      'etoro-trading',
    );
    expect(headers['x-request-id']).toBeUndefined();
  });

  it('auth wins over a caller header that reached the merge', async () => {
    const { headers } = await buildHeaders(
      CREDENTIALS,
      undefined,
      undefined,
      definition,
      call({ headers: { 'x-api-key': 'spoofed', 'x-request-id': 'spoofed' } }),
      binding,
      ctx,
      'etoro-trading',
    );
    expect(headers['x-api-key']).toBe('app-key-value');
    expect(headers['x-request-id']).toBe(mintRequestId(ctx));
  });

  it('leaves no differing-case duplicate for undici to comma-join', async () => {
    // A plain assignment would leave BOTH `X-Api-Key` and `x-api-key` on the
    // record; undici combines them into `spoofed, real` with the caller's
    // value first, which a gateway reading the first token would honour.
    const { headers } = await buildHeaders(
      CREDENTIALS,
      undefined,
      undefined,
      definition,
      call({
        headers: {
          'X-Api-Key': 'spoofed',
          'X-User-Key': 'spoofed',
          'X-Request-Id': 'spoofed',
        },
      }),
      binding,
      ctx,
      'etoro-trading',
    );
    const collisions = Object.keys(headers).filter((k) =>
      ['x-api-key', 'x-user-key', 'x-request-id'].includes(k.toLowerCase()),
    );
    expect(collisions.sort()).toEqual(['x-api-key', 'x-request-id', 'x-user-key']);
    expect(new Headers(headers).get('x-api-key')).toBe('app-key-value');
    expect(new Headers(headers).get('x-user-key')).toBe('user-key-value');
    expect(new Headers(headers).get('x-request-id')).toBe(mintRequestId(ctx));
  });

  it('applies auth and the minted id on the direct-URL path too', async () => {
    // callMode gates none of the resolution routes, so an endpoint-mode
    // definition is reachable by URL — a path that never touches buildHeaders
    // or the input assert. applyAuth is the chokepoint all three share.
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Api-Key': 'spoofed',
      'x-request-id': 'caller-chosen',
    };
    await applyAuth(
      CREDENTIALS,
      undefined,
      undefined,
      headers,
      binding,
      ctx,
      'etoro-trading',
      undefined,
      'x-request-id',
    );
    expect(new Headers(headers).get('x-api-key')).toBe('app-key-value');
    expect(new Headers(headers).get('x-user-key')).toBe('user-key-value');
    expect(new Headers(headers).get('x-request-id')).toBe(mintRequestId(ctx));
  });

  it('refuses a caller-supplied value for either key header', () => {
    for (const header of ['x-api-key', 'x-user-key', 'X-User-Key']) {
      expect(() =>
        assertNoAuthMaterialInInput(call({ headers: { [header]: 'x' } }), binding, 'etoro-trading'),
      ).toThrowError(/authentication headers/);
    }
  });

  it('refuses a caller-supplied request id, in headers or params', () => {
    expect(() =>
      assertNoAuthMaterialInInput(
        call({ headers: { 'x-request-id': 'caller-chosen' } }),
        binding,
        'etoro-trading',
        definition,
      ),
    ).toThrowError(/authentication headers/);

    expect(() =>
      assertNoAuthMaterialInInput(
        call({ params: { 'x-request-id': 'caller-chosen' } }),
        binding,
        'etoro-trading',
        definition,
      ),
    ).toThrowError(/authentication values/);
  });
});
