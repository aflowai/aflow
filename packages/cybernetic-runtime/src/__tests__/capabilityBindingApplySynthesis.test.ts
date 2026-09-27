import { describe, expect, it } from 'vitest';
import { ApiEndpointSchema, AuthProfileSchema } from '@aflow/schemas';
import {
  synthesizeEndpointId,
  synthesizeEndpoints,
  parseHostFromUrl,
  mergeSuggestedEgressIntoBaseline,
  buildPlaceholderAuthJson,
} from '../stagedChange/capabilityBindingApply.js';

describe('synthesizeEndpointId', () => {
  it('produces a readable id from method + path', () => {
    expect(synthesizeEndpointId('GET', '/competitions/{id}/data/download/{fileName}')).toBe(
      'get_competitions_id_data_download_filename',
    );
    expect(synthesizeEndpointId('POST', '/competitions/submissions')).toBe(
      'post_competitions_submissions',
    );
    expect(synthesizeEndpointId('GET', '/competitions/{id}/leaderboard/download')).toBe(
      'get_competitions_id_leaderboard_download',
    );
  });

  it('lowercases and squashes punctuation', () => {
    expect(synthesizeEndpointId('GET', '/v1/Repos/Owner/Name')).toBe('get_v1_repos_owner_name');
  });

  it('truncates ids longer than 128 chars', () => {
    const longPath = '/' + 'a'.repeat(200);
    const id = synthesizeEndpointId('GET', longPath);
    expect(id.length).toBeLessThanOrEqual(128);
  });
});

describe('synthesizeEndpoints', () => {
  it('produces canonical ApiEndpoint shape with endpointId and path params', () => {
    const out = synthesizeEndpoints([
      {
        method: 'GET',
        path: '/competitions/{id}/data/download/{fileName}',
        summary: 'Download a competition data file',
      },
      { method: 'POST', path: '/competitions/submissions' },
      {
        method: 'GET',
        path: '/competitions/{id}/leaderboard/download',
        summary: 'Fetch leaderboard CSV',
      },
    ]);

    expect(out).toHaveLength(3);
    // All three parse against the canonical ApiEndpointSchema.
    for (const ep of out) {
      const parse = ApiEndpointSchema.safeParse(ep);
      if (!parse.success) {
        throw new Error(
          `Synthesized endpoint did not match ApiEndpointSchema: ${parse.error.message}`,
        );
      }
    }

    const downloadFile = out[0]!;
    expect(downloadFile.endpointId).toBe('get_competitions_id_data_download_filename');
    expect(downloadFile.method).toBe('GET');
    expect(downloadFile.pathTemplate).toBe('/competitions/{id}/data/download/{fileName}');
    // Path params extracted from {placeholders}.
    const paramNames = downloadFile.params.map((p) => p.name).sort();
    expect(paramNames).toEqual(['fileName', 'id']);
    expect(downloadFile.params.every((p) => p.location === 'path' && p.required)).toBe(true);

    const submit = out[1]!;
    expect(submit.endpointId).toBe('post_competitions_submissions');
    expect(submit.params).toEqual([]);

    const leaderboard = out[2]!;
    expect(leaderboard.endpointId).toBe('get_competitions_id_leaderboard_download');
    expect(leaderboard.description).toBe('Fetch leaderboard CSV');
  });

  it('disambiguates colliding ids by appending a numeric suffix', () => {
    const out = synthesizeEndpoints([
      { method: 'GET', path: '/items' },
      { method: 'GET', path: '/items' },
    ]);
    expect(out[0]!.endpointId).toBe('get_items');
    expect(out[1]!.endpointId).toBe('get_items_2');
  });

  it('returns an empty array when the draft has no endpoints', () => {
    expect(synthesizeEndpoints([])).toEqual([]);
  });

  it('carries the declared responseTransformPresetId into the canonical endpoint', () => {
    const out = synthesizeEndpoints([
      {
        method: 'GET',
        path: '/api/query',
        endpointId: 'searchPapers',
        summary: 'Search papers',
        responseTransformPresetId: 'arxiv_atom_papers',
      },
      { method: 'GET', path: '/plain' },
    ]);
    expect(out[0]!.responseTransformPresetId).toBe('arxiv_atom_papers');
    expect(out[1]!.responseTransformPresetId).toBeUndefined();
  });

  // ==========================================================================

  // The point of the response carrier: a definition authored from a brief has
  // to be SIMULATABLE, not merely callable. Generation answers against the 2xx
  // schema, so an endpoint without one can only ever read `contract_missing`.
  it('lowers response into responseSchemas under the 2xx status class', () => {
    const out = synthesizeEndpoints([
      {
        method: 'GET',
        path: '/orders/{orderId}',
        summary: 'Fetch one order',
        response: {
          description: 'The order and its instalment plan.',
          schema: {
            type: 'object',
            required: ['orderId'],
            properties: { orderId: { type: 'string', description: 'Our id for the order.' } },
          },
        },
      },
      { method: 'GET', path: '/plain' },
    ]);
    expect(out[0]!.responseSchemas).toEqual({
      '2xx': {
        type: 'object',
        required: ['orderId'],
        properties: { orderId: { type: 'string', description: 'Our id for the order.' } },
        description: 'The order and its instalment plan.',
      },
    });
    expect(out[1]!.responseSchemas).toBeUndefined();
  });

  it('keeps a schema’s own description rather than overwriting it with the carrier’s', () => {
    const out = synthesizeEndpoints([
      {
        method: 'GET',
        path: '/x',
        response: {
          description: 'carrier prose',
          schema: { type: 'object', description: 'schema prose' },
        },
      },
    ]);
    expect((out[0]!.responseSchemas?.['2xx'] as { description?: string }).description).toBe(
      'schema prose',
    );
  });

  it('lowers queryParams into canonical EndpointParam entries with location=query', () => {
    const out = synthesizeEndpoints([
      {
        method: 'GET',
        path: '/v1beta1/news',
        summary: 'Fetch news for one or more symbols',
        queryParams: [
          {
            name: 'symbols',
            required: true,
            description: 'Comma-separated tickers',
            // exampleValue is annotation-only and must not appear in the
            // canonical EndpointParam shape.
            exampleValue: 'AAPL,MSFT',
          },
          { name: 'limit' },
        ],
      },
    ]);

    expect(out).toHaveLength(1);
    const news = out[0]!;
    // Canonical schema parse — proves synthesis emitted a valid endpoint.
    const parse = ApiEndpointSchema.safeParse(news);
    if (!parse.success) {
      throw new Error(`Synthesized endpoint did not match schema: ${parse.error.message}`);
    }

    expect(news.params).toHaveLength(2);
    expect(news.params[0]).toEqual({
      name: 'symbols',
      location: 'query',
      required: true,
      description: 'Comma-separated tickers',
    });
    expect(news.params[1]).toEqual({
      name: 'limit',
      location: 'query',
      required: false,
    });
    // exampleValue must not leak into the canonical param shape.
    expect(news.params[0]).not.toHaveProperty('exampleValue');
  });

  it('preserves path-first ordering when an endpoint has both path and query params', () => {
    const out = synthesizeEndpoints([
      {
        method: 'GET',
        path: '/v2/stocks/{symbol}/bars',
        summary: 'Historical bars',
        queryParams: [
          { name: 'timeframe', required: true, description: '1Min/5Min/1Day/…' },
          { name: 'start' },
          { name: 'end' },
        ],
      },
    ]);

    const bars = out[0]!;
    const parse = ApiEndpointSchema.safeParse(bars);
    if (!parse.success) {
      throw new Error(`Mixed endpoint did not match schema: ${parse.error.message}`);
    }

    expect(bars.params.map((p) => ({ name: p.name, location: p.location }))).toEqual([
      { name: 'symbol', location: 'path' },
      { name: 'timeframe', location: 'query' },
      { name: 'start', location: 'query' },
      { name: 'end', location: 'query' },
    ]);
    expect(bars.params[0]!.required).toBe(true);
    expect(bars.params[1]!.required).toBe(true);
    expect(bars.params[2]!.required).toBe(false);
    expect(bars.params[3]!.required).toBe(false);
  });

  it('omits description when the draft query param does not supply one', () => {
    // exactOptionalPropertyTypes guard: an absent description must be
    // omitted from the EndpointParam, not set to `undefined`.
    const out = synthesizeEndpoints([
      {
        method: 'GET',
        path: '/items',
        queryParams: [{ name: 'cursor' }],
      },
    ]);
    const param = out[0]!.params[0]!;
    expect(param).toEqual({ name: 'cursor', location: 'query', required: false });
    expect(Object.prototype.hasOwnProperty.call(param, 'description')).toBe(false);
  });

  it('omits queryParams entirely when not declared on the draft (regression-safety)', () => {
    // Same input as the original Kaggle test case — the synthesized output
    // must remain byte-for-byte identical to the pre-Plan-139 behaviour.
    const out = synthesizeEndpoints([
      {
        method: 'GET',
        path: '/competitions/{id}/data/download/{fileName}',
        summary: 'Download a competition data file',
      },
    ]);
    const dl = out[0]!;
    expect(dl.params).toHaveLength(2); // both path params
    expect(dl.params.every((p) => p.location === 'path')).toBe(true);
  });

  // ==========================================================================

  it('lowers `body` into a single canonical EndpointParam named body', () => {
    const out = synthesizeEndpoints([
      {
        method: 'POST',
        path: '/v2/orders',
        summary: 'Submit an order',
        body: {
          contentType: 'application/json',
          description: 'Order request payload',
        },
      },
    ]);

    expect(out).toHaveLength(1);
    const ep = out[0]!;
    const parse = ApiEndpointSchema.safeParse(ep);
    if (!parse.success) {
      throw new Error(`Synthesized endpoint did not match schema: ${parse.error.message}`);
    }

    expect(ep.params).toHaveLength(1);
    expect(ep.params[0]).toEqual({
      name: 'body',
      location: 'body',
      required: true,
      description: 'Order request payload',
    });
  });

  it('omits description on the body param when the draft does not supply one', () => {
    const out = synthesizeEndpoints([
      {
        method: 'POST',
        path: '/orders',
        body: { contentType: 'application/json' },
      },
    ]);
    const param = out[0]!.params[0]!;
    expect(param).toEqual({ name: 'body', location: 'body', required: true });
    expect(Object.prototype.hasOwnProperty.call(param, 'description')).toBe(false);
  });

  it('lowers the draft body contentType onto the canonical bodyEncoding', () => {
    const [json, form, multipart] = synthesizeEndpoints([
      { method: 'POST', path: '/a', body: { contentType: 'application/json' } },
      { method: 'POST', path: '/b', body: { contentType: 'application/x-www-form-urlencoded' } },
      { method: 'POST', path: '/c', body: { contentType: 'multipart/form-data' } },
    ]);
    expect(json!.bodyEncoding).toBe('json');
    expect(form!.bodyEncoding).toBe('form-urlencoded');
    expect(multipart!.bodyEncoding).toBe('form-data');
  });

  it('defaults bodyEncoding to json for a body-less endpoint', () => {
    const [ep] = synthesizeEndpoints([{ method: 'GET', path: '/items' }]);
    expect(ep!.bodyEncoding).toBe('json');
  });

  it('propagates the draft body schema onto the canonical body param', () => {
    const bodySchema = { type: 'object', properties: { symbol: { type: 'string' } } };
    const out = synthesizeEndpoints([
      {
        method: 'POST',
        path: '/orders',
        body: { contentType: 'application/json', schema: bodySchema },
      },
    ]);
    const param = out[0]!.params[0]!;
    expect(param.schema).toEqual(bodySchema);
  });

  it('places body params after path and query params (stable, grep-friendly order)', () => {
    const out = synthesizeEndpoints([
      {
        method: 'POST',
        path: '/v2/accounts/{accountId}/orders',
        summary: 'Submit an order for a specific account',
        queryParams: [{ name: 'preview', description: 'Dry-run mode' }],
        body: {
          contentType: 'application/json',
          description: 'Order request payload',
        },
      },
    ]);

    const ep = out[0]!;
    expect(ep.params.map((p) => ({ name: p.name, location: p.location }))).toEqual([
      { name: 'accountId', location: 'path' },
      { name: 'preview', location: 'query' },
      { name: 'body', location: 'body' },
    ]);
  });

  it('omits `body` entirely when the draft does not declare one (regression-safety)', () => {
    const out = synthesizeEndpoints([
      {
        method: 'GET',
        path: '/v1/quotes/{symbol}',
        summary: 'Get latest quote',
      },
    ]);
    const ep = out[0]!;
    expect(ep.params.every((p) => p.location !== 'body')).toBe(true);
  });

  // ==========================================================================

  it('uses the operator-provided endpointId verbatim instead of synthesizing from path', () => {
    const out = synthesizeEndpoints([
      {
        method: 'POST',
        path: '/v2/orders',
        endpointId: 'post_orders',
        summary: 'Submit order (renamed from /orders, ID preserved)',
      },
    ]);
    expect(out[0]!.endpointId).toBe('post_orders');
    // The pathTemplate reflects the NEW path; the ID stays stable.
    expect(out[0]!.pathTemplate).toBe('/v2/orders');
  });

  it('falls back to synthesis when endpointId is omitted', () => {
    const out = synthesizeEndpoints([
      { method: 'POST', path: '/v2/orders', summary: 'Submit order' },
    ]);
    expect(out[0]!.endpointId).toBe('post_v2_orders');
  });

  it('disambiguates colliding operator-provided endpointIds with the same numeric-suffix rule', () => {
    const out = synthesizeEndpoints([
      { method: 'GET', path: '/a', endpointId: 'list' },
      { method: 'GET', path: '/b', endpointId: 'list' },
    ]);
    expect(out[0]!.endpointId).toBe('list');
    expect(out[1]!.endpointId).toBe('list_2');
  });

  it('preserves endpointId through a path edit (the path-rename drift scenario)', () => {
    const before = synthesizeEndpoints([
      { method: 'POST', path: '/orders', summary: 'Submit order' },
    ]);
    const beforeId = before[0]!.endpointId; // post_orders

    const after = synthesizeEndpoints([
      {
        method: 'POST',
        path: '/v2/orders',
        endpointId: beforeId,
        summary: 'Submit order (path moved to /v2)',
      },
    ]);
    expect(after[0]!.endpointId).toBe(beforeId);
    expect(after[0]!.pathTemplate).toBe('/v2/orders');
  });
});

// ============================================================================

describe('parseHostFromUrl', () => {
  it('extracts the host from a normal https URL', () => {
    expect(parseHostFromUrl('https://www.kaggle.com/api/v1')).toBe('www.kaggle.com');
  });

  it('extracts the host from a URL with port', () => {
    expect(parseHostFromUrl('http://localhost:8080/api')).toBe('localhost:8080');
  });

  it('returns null for an unparseable URL', () => {
    expect(parseHostFromUrl('not-a-url')).toBeNull();
    expect(parseHostFromUrl('')).toBeNull();
  });
});

describe('mergeSuggestedEgressIntoBaseline', () => {
  it('returns existing unchanged when no suggested policy is provided', () => {
    const existing = { allowedHosts: ['api.example.com'], maxResponseBodyBytes: 10_485_760 };
    const result = mergeSuggestedEgressIntoBaseline(existing, undefined);
    expect(result).toEqual(existing);
    // Defensive: must NOT mutate input.
    expect(result).not.toBe(existing);
  });

  it('unions allowedHosts with additionalHosts (deduped)', () => {
    const existing = { allowedHosts: ['www.kaggle.com'] };
    const result = mergeSuggestedEgressIntoBaseline(existing, {
      additionalHosts: ['storage.googleapis.com', 'www.kaggle.com'],
    });
    expect(result['allowedHosts']).toEqual(
      expect.arrayContaining(['www.kaggle.com', 'storage.googleapis.com']),
    );
    expect((result['allowedHosts'] as string[]).length).toBe(2);
  });

  it('overrides allowCrossHostRedirects when suggested provides a value', () => {
    const result = mergeSuggestedEgressIntoBaseline(
      { allowCrossHostRedirects: false },
      { allowCrossHostRedirects: true },
    );
    expect(result['allowCrossHostRedirects']).toBe(true);
  });

  it('preserves allowCrossHostRedirects when suggested omits it', () => {
    const result = mergeSuggestedEgressIntoBaseline(
      { allowCrossHostRedirects: false },
      { additionalHosts: ['storage.googleapis.com'] },
    );
    expect(result['allowCrossHostRedirects']).toBe(false);
  });

  it('takes max(existing, suggested.minResponseBodyBytes) — never shrinks the limit', () => {
    // Existing is BIGGER → keep existing.
    const result1 = mergeSuggestedEgressIntoBaseline(
      { maxResponseBodyBytes: 100_000_000 },
      { minResponseBodyBytes: 10_485_760 },
    );
    expect(result1['maxResponseBodyBytes']).toBe(100_000_000);

    // Suggested is BIGGER → take suggested.
    const result2 = mergeSuggestedEgressIntoBaseline(
      { maxResponseBodyBytes: 10_485_760 },
      { minResponseBodyBytes: 100_000_000 },
    );
    expect(result2['maxResponseBodyBytes']).toBe(100_000_000);
  });

  it('takes max(existing, suggested.minTimeoutMs) the same way', () => {
    const result = mergeSuggestedEgressIntoBaseline(
      { timeoutMs: 30_000 },
      { minTimeoutMs: 60_000 },
    );
    expect(result['timeoutMs']).toBe(60_000);
  });

  it('replaces allowedMethods when suggested provides them', () => {
    const result = mergeSuggestedEgressIntoBaseline(
      { allowedMethods: ['GET', 'POST'] },
      { allowedMethods: ['GET', 'POST', 'PUT'] },
    );
    expect(result['allowedMethods']).toEqual(['GET', 'POST', 'PUT']);
  });

  it('full Kaggle scenario — adds GCS host, enables cross-host redirects, bumps response cap', () => {
    // The exact scenario from the live Titanic run: existing binding has
    // only kaggle.com allowed, no cross-host redirects. Proposal carries
    // GCS host + cross-host redirects + a 50MB response cap.
    const existing = {
      allowedHosts: ['www.kaggle.com'],
      allowCrossHostRedirects: false,
      maxResponseBodyBytes: 10_485_760,
      timeoutMs: 30_000,
    };
    const result = mergeSuggestedEgressIntoBaseline(existing, {
      additionalHosts: ['storage.googleapis.com'],
      allowCrossHostRedirects: true,
      minResponseBodyBytes: 52_428_800,
    });
    expect(new Set(result['allowedHosts'] as string[])).toEqual(
      new Set(['www.kaggle.com', 'storage.googleapis.com']),
    );
    expect(result['allowCrossHostRedirects']).toBe(true);
    expect(result['maxResponseBodyBytes']).toBe(52_428_800);
    expect(result['timeoutMs']).toBe(30_000); // untouched
  });
});

// ============================================================================

describe('buildPlaceholderAuthJson', () => {
  it('basic emits both username and password credential keys, schema-valid', () => {
    const auth = buildPlaceholderAuthJson('basic', 'alpaca-default');
    expect(auth).toEqual({
      type: 'basic',
      usernameCredentialKey: 'alpaca-default-username',
      passwordCredentialKey: 'alpaca-default-secret',
    });
    // Round-trips through the canonical AuthProfile schema.
    const parsed = AuthProfileSchema.safeParse(auth);
    expect(parsed.success).toBe(true);
  });

  it('oauth2 emits both client-id and client-secret credential keys', () => {
    const auth = buildPlaceholderAuthJson('oauth2', 'stripe-default');
    expect(auth).toEqual({
      type: 'oauth2_client_credentials',
      clientIdCredentialKey: 'stripe-default-client-id',
      clientSecretCredentialKey: 'stripe-default-client-secret',
    });
    // tokenEndpoint is intentionally omitted — operator must supply it via
    // the UI before the binding works at runtime. The preflight reports
    // 'auth-malformed' until that lands (separate plan).
  });

  it('bearer emits a single token credential key, schema-valid', () => {
    const auth = buildPlaceholderAuthJson('bearer', 'openai-default');
    expect(auth).toEqual({ type: 'bearer', credentialKey: 'openai-default-token' });
    expect(AuthProfileSchema.safeParse(auth).success).toBe(true);
  });

  it('api_key emits a single key credential, schema-valid (defaults fill the rest)', () => {
    const auth = buildPlaceholderAuthJson('api_key', 'anthropic-default');
    expect(auth).toEqual({ type: 'api_key', credentialKey: 'anthropic-default-key' });
    // api_key has defaulted placement + headerName, so the parse fills them.
    const parsed = AuthProfileSchema.safeParse(auth);
    expect(parsed.success).toBe(true);
  });

  it('api_key pins a caller-supplied headerName, surviving the schema round-trip', () => {
    const auth = buildPlaceholderAuthJson('api_key', 'linear-default', {
      apiKeyHeaderName: 'Authorization',
    });
    expect(auth).toEqual({
      type: 'api_key',
      credentialKey: 'linear-default-key',
      headerName: 'Authorization',
    });
    const parsed = AuthProfileSchema.safeParse(auth);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === 'api_key') {
      expect(parsed.data.headerName).toBe('Authorization');
    }
  });

  it('api_key with a query-param name emits query placement, surviving the schema round-trip', () => {
    const auth = buildPlaceholderAuthJson('api_key', 'fred-default', {
      apiKeyQueryParamName: 'api_key',
    });
    expect(auth).toEqual({
      type: 'api_key',
      credentialKey: 'fred-default-key',
      placement: 'query',
      queryParamName: 'api_key',
    });
    const parsed = AuthProfileSchema.safeParse(auth);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === 'api_key') {
      expect(parsed.data.placement).toBe('query');
      expect(parsed.data.queryParamName).toBe('api_key');
    }
  });

  it('api_key_pair emits both header names and both key slots, surviving the schema round-trip', () => {
    const auth = buildPlaceholderAuthJson('api_key_pair', 'etoro-default', {
      apiKeyPairHeaderNames: { primary: 'x-api-key', secondary: 'x-user-key' },
    });
    expect(auth).toEqual({
      type: 'api_key_pair',
      primaryHeaderName: 'x-api-key',
      secondaryHeaderName: 'x-user-key',
      credentialKey: 'etoro-default-key',
      secondaryCredentialKey: 'etoro-default-secondary-key',
    });
    const parsed = AuthProfileSchema.safeParse(auth);
    expect(parsed.success).toBe(true);
  });

  it('api_key_pair refuses to build without header names rather than emitting a half-formed profile', () => {
    expect(() => buildPlaceholderAuthJson('api_key_pair', 'etoro-default')).toThrowError(
      /requires apiKeyPairHeaderNames/,
    );
  });

  it('pinned credential keys replace the per-binding derivation so entries can share one secret', () => {
    const shared = { credentialKey: 'etoro-api-key', secondaryCredentialKey: 'etoro-user-key' };
    const first = buildPlaceholderAuthJson('api_key_pair', 'etoro-market-data-default', {
      apiKeyPairHeaderNames: { primary: 'x-api-key', secondary: 'x-user-key' },
      credentialKeys: shared,
    });
    const second = buildPlaceholderAuthJson('api_key_pair', 'etoro-trading-default', {
      apiKeyPairHeaderNames: { primary: 'x-api-key', secondary: 'x-user-key' },
      credentialKeys: shared,
    });
    expect(first['credentialKey']).toBe('etoro-api-key');
    expect(first['secondaryCredentialKey']).toBe('etoro-user-key');
    expect(second['credentialKey']).toBe(first['credentialKey']);
    expect(second['secondaryCredentialKey']).toBe(first['secondaryCredentialKey']);
  });

  it('an unpinned field still falls back to the per-binding derivation', () => {
    const auth = buildPlaceholderAuthJson('basic', 'alpaca-default', {
      credentialKeys: { usernameCredentialKey: 'alpaca-key-id' },
    });
    expect(auth).toEqual({
      type: 'basic',
      usernameCredentialKey: 'alpaca-key-id',
      passwordCredentialKey: 'alpaca-default-secret',
    });
  });

  it('none emits a structurally minimal entry', () => {
    expect(buildPlaceholderAuthJson('none', 'x')).toEqual({ type: 'none' });
  });

  it('throws on unknown authKind rather than masking with a benign default', () => {
    // The parameter is typed against the draft enum, so reaching this path
    // requires an out-of-band caller. We cast `as never` to simulate that.
    expect(() => buildPlaceholderAuthJson('made-up' as never, 'x')).toThrowError(
      /unhandled authKind/,
    );
  });
});
