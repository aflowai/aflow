/**
 * Contract: an endpoint's redirect hosts are where its response may send the
 * call, followed without the binding's credential — and they are the
 * endpoint's alone. A binding's allowedHosts receive its token on a
 * direct-URL call, so a host a signed download sits on is never one of them:
 * no other endpoint of the binding may be redirected there, and the
 * endpoint itself may be redirected nowhere outside its list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutorContext } from '@aflow/executor-runtime';
import {
  ApiEndpointSchema,
  type ApiCallInput,
  type ApiEndpoint,
  type EgressPolicy,
} from '@aflow/schemas';
import type { ResolvedCall } from './types.js';
import { ApiExecutionError } from './types.js';

vi.mock('@aflow/network-safety', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/network-safety')>();
  return {
    ...actual,
    // The allowlist exactly as the real one judges it, without a DNS lookup.
    validateUrl: async (rawUrl: string, allowedHosts: string[]) => {
      const url = new URL(rawUrl);
      if (allowedHosts.length > 0 && !actual.isHostAllowed(url.hostname, allowedHosts)) {
        throw new actual.SsrfBlockedError(`Blocked: host ${url.hostname}`, rawUrl, {
          kind: 'allowlist-host',
        });
      }
      return { url, resolvedHost: { hostname: url.hostname, ip: '140.82.112.6', family: 4 } };
    },
  };
});

vi.mock('./response.js', () => ({
  processResponse: async (
    _ctx: unknown,
    _input: unknown,
    response: Response,
    _durationMs: number,
    finalUrl: string,
  ) => ({ statusCode: response.status, finalUrl }),
}));

const { executeSingle } = await import('./execution.js');

const LOG_HOSTS = ['*.blob.core.windows.net', '*.actions.githubusercontent.com'];
const SIGNED_LOG = 'https://productionresultssa1.blob.core.windows.net/actions-results/x?sig=s';

const GITHUB_BINDING_EGRESS: EgressPolicy = {
  allowedHosts: ['api.github.com'],
  allowedMethods: ['GET', 'POST', 'PUT', 'PATCH'],
  maxRequestBodyBytes: 1_048_576,
  maxResponseBodyBytes: 10_485_760,
  timeoutMs: 30_000,
  maxRedirects: 5,
  allowCrossHostRedirects: false,
  retryPolicy: {
    maxRetries: 0,
    retryableStatusCodes: [429, 502, 503, 504],
    retryOnlyIdempotent: true,
    backoffBaseMs: 1000,
    backoffMaxMs: 30_000,
  },
};

function endpoint(endpointId: string, redirectHosts?: string[]): ApiEndpoint {
  return ApiEndpointSchema.parse({
    endpointId,
    name: endpointId,
    method: 'GET',
    pathTemplate: `/${endpointId}`,
    ...(redirectHosts !== undefined ? { redirectHosts } : {}),
  });
}

function call(ep: ApiEndpoint): ResolvedCall {
  return {
    url: `https://api.github.com/${ep.endpointId}`,
    method: 'GET',
    headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ghp_secret' },
    body: undefined,
    egressPolicy: GITHUB_BINDING_EGRESS,
    apiId: 'github',
    bindingId: 'github-default',
    endpointId: ep.endpointId,
    endpoint: ep,
    credentialHeaders: ['Authorization'],
  };
}

const ctx = {
  job: { spaceId: 'space-1', tenantId: 'tenant-1' },
  signal: new AbortController().signal,
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
} as unknown as ExecutorContext;

const input = { timeoutMs: 30_000 } as unknown as ApiCallInput;

let fetched: { url: string; headers: Record<string, string> }[];

function redirectingTo(location: string) {
  return vi.fn(async (url: string, init: RequestInit) => {
    fetched.push({ url, headers: init.headers as Record<string, string> });
    return fetched.length === 1
      ? new Response(null, { status: 302, headers: { location } })
      : new Response('log', { status: 200 });
  });
}

beforeEach(() => {
  fetched = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function blockKindOf(promise: Promise<unknown>): Promise<unknown> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiExecutionError);
  return (err as ApiExecutionError).aflowError.details?.['blockKind'];
}

describe("an endpoint's redirect hosts", () => {
  it('are followed from a binding that allows only the API, without its credential', async () => {
    vi.stubGlobal('fetch', redirectingTo(SIGNED_LOG));

    const result = await executeSingle(ctx, input, call(endpoint('getJobLogs', LOG_HOSTS)));

    expect(result.finalUrl).toBe(SIGNED_LOG);
    expect(fetched.map((f) => new URL(f.url).hostname)).toEqual([
      'api.github.com',
      'productionresultssa1.blob.core.windows.net',
    ]);
    expect(fetched[0]!.headers['Authorization']).toBe('Bearer ghp_secret');
    expect(Object.keys(fetched[1]!.headers).map((h) => h.toLowerCase())).not.toContain(
      'authorization',
    );
  });

  it('are no other endpoint’s: a redirect there from one without them is blocked', async () => {
    vi.stubGlobal('fetch', redirectingTo(SIGNED_LOG));

    expect(await blockKindOf(executeSingle(ctx, input, call(endpoint('getPullRequest'))))).toBe(
      'cross_host_redirect_blocked',
    );
    expect(fetched).toHaveLength(1);
  });

  it('are the only hosts the endpoint may be redirected to off the API', async () => {
    vi.stubGlobal('fetch', redirectingTo('https://attacker.example.com/collect'));

    expect(
      await blockKindOf(executeSingle(ctx, input, call(endpoint('getJobLogs', LOG_HOSTS)))),
    ).toBe('cross_host_redirect_blocked');
    expect(fetched).toHaveLength(1);
  });
});
