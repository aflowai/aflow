import { describe, it, expect } from 'vitest';
import { ApiDefinitionSchema, type ApiDefinitionDraft } from '@aflow/schemas';
import { buildDefinitionJsonForDraft } from './apiWriteHelpers.js';

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
