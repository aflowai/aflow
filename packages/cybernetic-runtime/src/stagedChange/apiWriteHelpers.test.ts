import { describe, it, expect } from 'vitest';
import { ApiDefinitionSchema, type ApiDefinitionDraft } from '@aflow/schemas';
import { buildDefinitionJsonForDraft, oauthClientUnregisteredMessage } from './apiWriteHelpers.js';

const directUrlDraft: ApiDefinitionDraft = {
  name: 'Kaggle Data Fetch',
  baseUrl: 'https://www.kaggle.com',
  authKind: 'none',
  callMode: 'direct_url',
  endpoints: [],
};

describe('buildDefinitionJsonForDraft — callMode persistence', () => {
  it('persists callMode so a direct_url definition reads back as direct_url', () => {
    const json = buildDefinitionJsonForDraft('kaggle-data-fetch', directUrlDraft);
    expect(json['callMode']).toBe('direct_url');
    // The founding bug: without callMode in definition_json, the stored row
    // re-parses as 'endpoint' and ApiDefinitionSchema rejects its empty endpoints.
    const parsed = ApiDefinitionSchema.safeParse(json);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.callMode).toBe('direct_url');
      expect(parsed.data.endpoints).toEqual([]);
    }
  });
});

describe('buildDefinitionJsonForDraft — bridge round-trip invariant', () => {
  // The compiler contract: ANY valid draft must synthesize into a definition the
  // executor's model schema accepts. A failure here = a row the space loader
  // silently skips → "API definition not found in space". Exercise edge caps +
  // every endpoint feature so a draft↔model drift can't slip through unnoticed.
  const cases: Array<{ label: string; draft: ApiDefinitionDraft }> = [
    {
      label: 'max-length summary + path params',
      draft: {
        name: 'API',
        baseUrl: 'https://api.example.com',
        authKind: 'bearer',
        callMode: 'endpoint',
        endpoints: [
          {
            path: '/v1/things/{id}/sub/{childId}',
            method: 'GET',
            endpointId: 'get_thing',
            summary: 'S'.repeat(500),
          },
        ],
      },
    },
    {
      label: 'query params + each body content type',
      draft: {
        name: 'API',
        baseUrl: 'https://api.example.com',
        authKind: 'api_key',
        callMode: 'endpoint',
        endpoints: [
          {
            path: '/search',
            method: 'GET',
            endpointId: 'search',
            queryParams: [
              { name: 'q', required: true, description: 'D'.repeat(500) },
              { name: 'limit' },
            ],
          },
          {
            path: '/orders',
            method: 'POST',
            endpointId: 'create_order',
            body: {
              contentType: 'application/json',
              description: 'B'.repeat(500),
              schema: { type: 'object', additionalProperties: false, properties: {} },
            },
          },
          {
            path: '/orders/form',
            method: 'POST',
            endpointId: 'create_order_form',
            body: {
              contentType: 'application/x-www-form-urlencoded',
              schema: { type: 'object', properties: { q: { type: 'string' } } },
            },
          },
        ],
      },
    },
    {
      label: 'direct_url (no endpoints, auth none)',
      draft: {
        name: 'Blob',
        baseUrl: 'https://example.com',
        authKind: 'none',
        callMode: 'direct_url',
        endpoints: [],
      },
    },
  ];

  for (const { label, draft } of cases) {
    it(`synthesizes a model-valid definition: ${label}`, () => {
      const json = buildDefinitionJsonForDraft('x-api', draft);
      const parsed = ApiDefinitionSchema.safeParse(json);
      if (!parsed.success) {
        throw new Error(JSON.stringify(parsed.error.issues, null, 2));
      }
      expect(parsed.success).toBe(true);
    });
  }
});

describe('buildDefinitionJsonForDraft — body schema is the typed contract', () => {
  const bodySchema = {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'name'],
    properties: {
      type: { const: 'inbox' },
      name: { type: 'string', description: 'File name' },
    },
  };

  it('propagates the draft body schema onto the synthesized body param', () => {
    const draft: ApiDefinitionDraft = {
      name: 'Kaggle',
      baseUrl: 'https://www.kaggle.com',
      authKind: 'basic',
      callMode: 'endpoint',
      endpoints: [
        {
          path: '/api/v1/blobs/upload',
          method: 'POST',
          endpointId: 'request_submission_upload',
          name: 'Upload slot',
          summary: 'Request a resumable upload slot.',
          body: { contentType: 'application/json', schema: bodySchema },
        },
      ],
    };
    const json = buildDefinitionJsonForDraft('kaggle', draft);
    const parsed = ApiDefinitionSchema.safeParse(json);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const ep = parsed.data.endpoints[0]!;
      // name/summary are de-conflated: short name → name, summary → description.
      expect(ep.name).toBe('Upload slot');
      expect(ep.description).toBe('Request a resumable upload slot.');
      const bodyParam = ep.params.find((p) => p.location === 'body')!;
      expect(bodyParam.schema).toEqual(bodySchema);
    }
  });

  it('rejects a synthesized endpoint whose body param carries no schema', () => {
    // The model schema must refuse a body-bearing endpoint with no body schema —
    // the founding guess-the-field-names failure.
    const defWithSchemalessBody = {
      apiId: 'x',
      name: 'X',
      baseUrl: 'https://x.example.com',
      callMode: 'endpoint',
      endpoints: [
        {
          endpointId: 'post_thing',
          name: 'Post thing',
          method: 'POST',
          pathTemplate: '/thing',
          params: [{ name: 'body', location: 'body', required: true }],
        },
      ],
    };
    const parsed = ApiDefinitionSchema.safeParse(defWithSchemalessBody);
    expect(parsed.success).toBe(false);
  });
});

describe('buildDefinitionJsonForDraft — long summary stays model-valid', () => {
  it('clamps a >256-char endpoint summary into a loadable name (full text in description)', () => {
    const longSummary = 'X'.repeat(271); // the length that overflowed the name cap
    const draft: ApiDefinitionDraft = {
      name: 'Kaggle',
      baseUrl: 'https://www.kaggle.com',
      authKind: 'basic',
      callMode: 'endpoint',
      endpoints: [
        {
          path: '/api/v1/competitions/submissions/url/{contentLength}',
          method: 'POST',
          endpointId: 'request_submission_upload',
          summary: longSummary,
        },
      ],
    };
    const json = buildDefinitionJsonForDraft('kaggle', draft);
    // Must round-trip through the EXECUTOR's model schema — otherwise the
    // space loader silently skips it and every call says "not found in space".
    const parsed = ApiDefinitionSchema.safeParse(json);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const ep = parsed.data.endpoints[0]!;
      expect(ep.name.length).toBeLessThanOrEqual(256);
      expect(ep.description).toBe(longSummary); // full text preserved
    }
  });
});

describe('oauthClientUnregisteredMessage', () => {
  const editions = ['community-local', 'enterprise'] as const;
  const scopes = ['tenant', 'space'] as const;
  const sources = ['tenant_default', 'binding'] as const;

  function everyMessage(issuerKey: string): string[] {
    return editions.flatMap((edition) =>
      scopes.flatMap((clientScope) =>
        sources.map((scopeSource) =>
          oauthClientUnregisteredMessage({ edition, clientScope, scopeSource, issuerKey }),
        ),
      ),
    );
  }

  it('never offers the platform client for an API issuer', () => {
    for (const message of everyMessage('google')) expect(message).not.toMatch(/platform/i);
  });

  it('keeps the client secret out of the Helmsman conversation', () => {
    for (const message of everyMessage('slack')) {
      expect(message).toContain('never in chat with the Helmsman');
    }
  });

  it('sends the local operator to instance Settings, then to the Tenant default', () => {
    const message = oauthClientUnregisteredMessage({
      edition: 'community-local',
      clientScope: 'space',
      scopeSource: 'tenant_default',
      issuerKey: 'google',
    });
    expect(message).toContain('Open Settings → OAuth Apps');
    expect(message).toContain('register a Google OAuth app there');
    expect(message).toContain('set Default OAuth app to Tenant');
    expect(message).not.toContain('space’s Settings');
  });

  it('points a local space-scoped binding at its own client choice, not the default', () => {
    // The guard reads the binding's own scope, so the Tenant default cannot
    // clear it. Only switching the binding to the tenant app does.
    const message = oauthClientUnregisteredMessage({
      edition: 'community-local',
      clientScope: 'space',
      scopeSource: 'binding',
      issuerKey: 'google',
    });
    expect(message).toContain('Open Settings → OAuth Apps');
    expect(message).toContain('edit this integration');
    expect(message).toContain('"A tenant-registered OAuth app"');
    expect(message).not.toContain('Default OAuth app');
    expect(message).not.toContain('space’s Settings');
  });

  it('asks for no default change when the scope is already tenant', () => {
    for (const edition of editions) {
      for (const scopeSource of sources) {
        const message = oauthClientUnregisteredMessage({
          edition,
          clientScope: 'tenant',
          scopeSource,
          issuerKey: 'google',
        });
        expect(message).toContain('register a Google OAuth app there');
        expect(message).not.toContain('Default OAuth app');
        expect(message).not.toContain('edit this integration');
      }
    }
  });

  it('names the space page in the hosted edition when the space scope asked', () => {
    const fromDefault = oauthClientUnregisteredMessage({
      edition: 'enterprise',
      clientScope: 'space',
      scopeSource: 'tenant_default',
      issuerKey: 'google',
    });
    expect(fromDefault).toContain('Open the space’s Settings → OAuth Apps');
    expect(fromDefault).toContain('set Default OAuth app to Tenant');

    const fromBinding = oauthClientUnregisteredMessage({
      edition: 'enterprise',
      clientScope: 'space',
      scopeSource: 'binding',
      issuerKey: 'google',
    });
    expect(fromBinding).toContain('Open the space’s Settings → OAuth Apps');
    expect(fromBinding).toContain('"A tenant-registered OAuth app"');
    expect(fromBinding).not.toContain('Default OAuth app');
  });
});
