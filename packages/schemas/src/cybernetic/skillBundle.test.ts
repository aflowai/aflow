import { describe, it, expect } from 'vitest';
import {
  ApiBindingTemplateSchema,
  BundleArtifactSeedSchema,
  BundledApiDefinitionSchema,
  CredentialSlotSchema,
  MemorySeedSchema,
  PostInstallTaskSchema,
  SkillBundleSchema,
} from './skillBundle.js';

function valid() {
  return {
    bundleId: 'my-bundle',
    version: 1,
    name: 'My Bundle',
    tagline: 'A useful bundle.',
    description: 'A longer description.',
    skillCatalogIds: ['skill-a', 'skill-b'],
  };
}

function validApiDef(apiId = 'my-api') {
  return {
    apiId,
    definition: {
      name: 'My API',
      baseUrl: 'https://api.example.com',
      authKind: 'bearer' as const,
      endpoints: [
        {
          path: '/v1/things',
          method: 'GET' as const,
          summary: 'List things',
        },
      ],
    },
  };
}

function validBasicTemplate(apiId = 'my-api') {
  return {
    bindingId: 'my-api-default',
    apiId,
    name: 'My API default',
    authShape: { type: 'basic' as const },
    credentialSlots: [
      {
        authField: 'usernameCredentialKey',
        credentialKey: 'my-api-key',
        role: 'username' as const,
        label: 'Username',
      },
      {
        authField: 'passwordCredentialKey',
        credentialKey: 'my-api-secret',
        role: 'password' as const,
        label: 'Password',
      },
    ],
    egressPolicy: {
      allowedHosts: ['api.example.com'],
    },
  };
}

// ============================================================================

describe('SkillBundleSchema — Plan 137 invariants', () => {
  it('accepts a minimal valid bundle', () => {
    expect(() => SkillBundleSchema.parse(valid())).not.toThrow();
  });

  it('rejects an empty skillCatalogIds array', () => {
    const bundle = { ...valid(), skillCatalogIds: [] as string[] };
    expect(() => SkillBundleSchema.parse(bundle)).toThrow();
  });

  it('rejects bundleId with invalid characters', () => {
    const bundle = { ...valid(), bundleId: 'My Bundle' };
    expect(() => SkillBundleSchema.parse(bundle)).toThrow();
  });

  it('rejects setupSkillCatalogId not in skillCatalogIds', () => {
    const bundle = { ...valid(), setupSkillCatalogId: 'not-in-the-list' };
    expect(() => SkillBundleSchema.parse(bundle)).toThrow(/setupSkillCatalogId/);
  });

  it('accepts setupSkillCatalogId when it appears in skillCatalogIds', () => {
    const bundle = { ...valid(), setupSkillCatalogId: 'skill-a' };
    expect(() => SkillBundleSchema.parse(bundle)).not.toThrow();
  });

  it('defaults prerequisiteBundleIds + tags to empty arrays', () => {
    const parsed = SkillBundleSchema.parse(valid());
    expect(parsed.prerequisiteBundleIds).toEqual([]);
    expect(parsed.tags).toEqual([]);
  });

  it('rejects more than 50 skillCatalogIds', () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => `skill-${i}`);
    const bundle = { ...valid(), skillCatalogIds: tooMany };
    expect(() => SkillBundleSchema.parse(bundle)).toThrow();
  });
});

// ============================================================================

describe('SkillBundleSchema — Plan 150 defaults are additive', () => {
  it('defaults apiDefinitions / apiBindingTemplates / memorySeed / helmsmanHints to empty arrays', () => {
    const parsed = SkillBundleSchema.parse(valid());
    expect(parsed.apiDefinitions).toEqual([]);
    expect(parsed.apiBindingTemplates).toEqual([]);
    expect(parsed.memorySeed).toEqual([]);
    expect(parsed.helmsmanHints).toEqual([]);
  });

  it('a pre-Plan-150 bundle with no new fields still parses (backward compat)', () => {
    // Mirrors the existing TEST_TWO_SKILL_BUNDLE shape (no API defs, no
    // memory seeds, no helmsmanHints). Sanity check that the widening is
    // strictly additive.
    expect(() =>
      SkillBundleSchema.parse({
        ...valid(),
        tags: ['test'],
        prerequisiteBundleIds: [],
      }),
    ).not.toThrow();
  });
});

describe('BundledApiDefinitionSchema', () => {
  it('accepts a valid bundled definition', () => {
    expect(() => BundledApiDefinitionSchema.parse(validApiDef())).not.toThrow();
  });

  it('defaults conflictPolicy to "skip"', () => {
    const parsed = BundledApiDefinitionSchema.parse(validApiDef());
    expect(parsed.conflictPolicy).toBe('skip');
  });

  it('rejects missing apiId', () => {
    const bad = { definition: validApiDef().definition };
    expect(() => BundledApiDefinitionSchema.parse(bad)).toThrow();
  });
});

describe('ApiBindingTemplateSchema — per-auth-type credential slot constraints', () => {
  it('basic auth requires exactly username + password slots', () => {
    expect(() => ApiBindingTemplateSchema.parse(validBasicTemplate())).not.toThrow();
  });

  it('rejects basic auth with only one slot', () => {
    const bad = {
      ...validBasicTemplate(),
      credentialSlots: [validBasicTemplate().credentialSlots[0]!],
    };
    expect(() => ApiBindingTemplateSchema.parse(bad)).toThrow(/exactly 2/);
  });

  it('rejects basic auth with two slots on the same authField', () => {
    const slots = [
      validBasicTemplate().credentialSlots[0]!,
      { ...validBasicTemplate().credentialSlots[0]!, credentialKey: 'other' },
    ];
    const bad = { ...validBasicTemplate(), credentialSlots: slots };
    expect(() => ApiBindingTemplateSchema.parse(bad)).toThrow(/duplicate/);
  });

  it('bearer auth requires exactly one token slot', () => {
    const ok = {
      ...validBasicTemplate(),
      authShape: { type: 'bearer' as const },
      credentialSlots: [
        {
          authField: 'credentialKey',
          credentialKey: 'my-api-token',
          role: 'token' as const,
          label: 'Token',
        },
      ],
    };
    expect(() => ApiBindingTemplateSchema.parse(ok)).not.toThrow();
  });

  it('api_key auth requires exactly one api_key slot', () => {
    const ok = {
      ...validBasicTemplate(),
      authShape: { type: 'api_key' as const },
      credentialSlots: [
        {
          authField: 'credentialKey',
          credentialKey: 'my-api-key',
          role: 'api_key' as const,
          label: 'API Key',
        },
      ],
    };
    expect(() => ApiBindingTemplateSchema.parse(ok)).not.toThrow();
  });

  it('oauth2 requires client_id + client_secret slots', () => {
    const ok = {
      ...validBasicTemplate(),
      authShape: {
        type: 'oauth2_client_credentials' as const,
        tokenEndpoint: 'https://auth.example.com/token',
      },
      credentialSlots: [
        {
          authField: 'clientIdCredentialKey',
          credentialKey: 'my-client-id',
          role: 'client_id' as const,
          label: 'Client ID',
        },
        {
          authField: 'clientSecretCredentialKey',
          credentialKey: 'my-client-secret',
          role: 'client_secret' as const,
          label: 'Client Secret',
        },
      ],
    };
    expect(() => ApiBindingTemplateSchema.parse(ok)).not.toThrow();
  });

  it('none auth requires zero slots', () => {
    const ok = {
      ...validBasicTemplate(),
      authShape: { type: 'none' as const },
      credentialSlots: [],
    };
    expect(() => ApiBindingTemplateSchema.parse(ok)).not.toThrow();
  });

  it('none auth rejects non-empty slots', () => {
    const bad = {
      ...validBasicTemplate(),
      authShape: { type: 'none' as const },
    };
    // basic-shaped slots inherited from validBasicTemplate
    expect(() => ApiBindingTemplateSchema.parse(bad)).toThrow(/exactly 0/);
  });

  it('rejects oauth2 missing tokenEndpoint', () => {
    const bad = {
      ...validBasicTemplate(),
      authShape: { type: 'oauth2_client_credentials' as const },
      credentialSlots: [
        {
          authField: 'clientIdCredentialKey',
          credentialKey: 'my-client-id',
          role: 'client_id' as const,
          label: 'Client ID',
        },
        {
          authField: 'clientSecretCredentialKey',
          credentialKey: 'my-client-secret',
          role: 'client_secret' as const,
          label: 'Client Secret',
        },
      ],
    };
    expect(() => ApiBindingTemplateSchema.parse(bad)).toThrow();
  });

  it('rejects an empty egressPolicy.allowedHosts array', () => {
    const bad = { ...validBasicTemplate(), egressPolicy: { allowedHosts: [] } };
    expect(() => ApiBindingTemplateSchema.parse(bad)).toThrow();
  });
});

describe('CredentialSlotSchema', () => {
  it('accepts a well-formed slot', () => {
    expect(() =>
      CredentialSlotSchema.parse({
        authField: 'usernameCredentialKey',
        credentialKey: 'alpaca-key-id',
        role: 'username',
        label: 'Alpaca API Key ID',
      }),
    ).not.toThrow();
  });

  it('rejects an unknown role', () => {
    expect(() =>
      CredentialSlotSchema.parse({
        authField: 'fooCredentialKey',
        credentialKey: 'foo',
        role: 'super-secret',
        label: 'Foo',
      }),
    ).toThrow();
  });
});

describe('MemorySeedSchema', () => {
  it('accepts a minimal valid seed', () => {
    expect(() =>
      MemorySeedSchema.parse({
        path: 'policy/portfolio.md',
        content: '# policy',
        docType: 'markdown',
      }),
    ).not.toThrow();
  });

  it('defaults seedPolicy to "skip"', () => {
    const parsed = MemorySeedSchema.parse({
      path: 'policy/portfolio.md',
      content: '# policy',
      docType: 'markdown',
    });
    expect(parsed.seedPolicy).toBe('skip');
  });

  it('rejects an unknown docType', () => {
    expect(() =>
      MemorySeedSchema.parse({
        path: 'x.md',
        content: 'x',
        docType: 'whatever',
      }),
    ).toThrow();
  });
});

describe('PostInstallTaskSchema — discriminated union', () => {
  it('accepts a fill_credentials variant', () => {
    expect(() =>
      PostInstallTaskSchema.parse({
        kind: 'fill_credentials',
        bindingId: 'my-api-default',
        slots: [
          {
            authField: 'credentialKey',
            credentialKey: 'my-api-key',
            role: 'api_key',
            label: 'API Key',
          },
        ],
        description: 'Fill credentials for My API.',
        required: true,
      }),
    ).not.toThrow();
  });

  it('accepts a designate_repo variant (no bindingId/slots — kind is the discriminator)', () => {
    expect(() =>
      PostInstallTaskSchema.parse({
        kind: 'designate_repo',
        description: 'Designate the repository the coding skills push to.',
        required: true,
      }),
    ).not.toThrow();
  });

  it('rejects designate_repo with required: false (always required)', () => {
    expect(() =>
      PostInstallTaskSchema.parse({
        kind: 'designate_repo',
        description: 'Designate the repository the coding skills push to.',
        required: false,
      }),
    ).toThrow();
  });

  it('rejects an unknown kind', () => {
    expect(() =>
      PostInstallTaskSchema.parse({
        kind: 'run_platform_workflow',
        workflowId: 'preflight',
        description: 'Run the preflight.',
      }),
    ).toThrow();
  });

  it('rejects fill_credentials with required: false (always required)', () => {
    expect(() =>
      PostInstallTaskSchema.parse({
        kind: 'fill_credentials',
        bindingId: 'my-api-default',
        slots: [
          {
            authField: 'credentialKey',
            credentialKey: 'my-api-key',
            role: 'api_key',
            label: 'API Key',
          },
        ],
        description: 'Fill credentials for My API.',
        required: false,
      }),
    ).toThrow();
  });
});

describe('SkillBundleSchema — Plan 150 reference validation (schema layer)', () => {
  it('accepts a bundle whose apiBindingTemplates[].apiId references a local apiDefinition', () => {
    expect(() =>
      SkillBundleSchema.parse({
        ...valid(),
        apiDefinitions: [validApiDef('my-api')],
        apiBindingTemplates: [validBasicTemplate('my-api')],
      }),
    ).not.toThrow();
  });

  it('accepts a bundle whose binding template references an apiId NOT in apiDefinitions[]', () => {
    expect(() =>
      SkillBundleSchema.parse({
        ...valid(),
        apiDefinitions: [validApiDef('my-api')],
        apiBindingTemplates: [validBasicTemplate('some-other-api')],
        prerequisiteBundleIds: ['other-bundle'],
      }),
    ).not.toThrow();
  });

  it('accepts a bundle with API definitions but no binding templates', () => {
    expect(() =>
      SkillBundleSchema.parse({
        ...valid(),
        apiDefinitions: [validApiDef('my-api')],
      }),
    ).not.toThrow();
  });
});

describe('ApiBindingTemplateSchema — Plan 150 P2 authField allowlist + role↔field pinning', () => {
  it('rejects basic auth with role=username on authField=passwordCredentialKey (swapped)', () => {
    const swapped = {
      ...validBasicTemplate(),
      credentialSlots: [
        {
          authField: 'passwordCredentialKey',
          credentialKey: 'my-api-key',
          role: 'username' as const,
          label: 'Username',
        },
        {
          authField: 'usernameCredentialKey',
          credentialKey: 'my-api-secret',
          role: 'password' as const,
          label: 'Password',
        },
      ],
    };
    expect(() => ApiBindingTemplateSchema.parse(swapped)).toThrow(/role/);
  });

  it('rejects basic auth using a bogus authField', () => {
    const bad = {
      ...validBasicTemplate(),
      credentialSlots: [
        {
          authField: 'usernameCredentialKey',
          credentialKey: 'u',
          role: 'username' as const,
          label: 'u',
        },
        {
          authField: 'mySecretField', // not allowed for basic
          credentialKey: 'p',
          role: 'password' as const,
          label: 'p',
        },
      ],
    };
    expect(() => ApiBindingTemplateSchema.parse(bad)).toThrow(/does not accept authField/);
  });

  it('rejects basic auth with duplicate usernameCredentialKey entries', () => {
    const dup = {
      ...validBasicTemplate(),
      credentialSlots: [
        {
          authField: 'usernameCredentialKey',
          credentialKey: 'k1',
          role: 'username' as const,
          label: 'l1',
        },
        {
          authField: 'usernameCredentialKey',
          credentialKey: 'k2',
          role: 'username' as const,
          label: 'l2',
        },
      ],
    };
    expect(() => ApiBindingTemplateSchema.parse(dup)).toThrow(/duplicate/);
  });

  it('rejects bearer auth with authField=tokenCredentialKey (must be credentialKey)', () => {
    const bad = {
      ...validBasicTemplate(),
      authShape: { type: 'bearer' as const },
      credentialSlots: [
        {
          authField: 'tokenCredentialKey', // wrong — bearer's runtime field is `credentialKey`
          credentialKey: 't',
          role: 'token' as const,
          label: 'Token',
        },
      ],
    };
    expect(() => ApiBindingTemplateSchema.parse(bad)).toThrow(/does not accept authField/);
  });
});

describe('PostInstallTaskSchema — Plan 150 P3 fill_credentials slot bounds', () => {
  it('rejects fill_credentials with an empty slots array', () => {
    expect(() =>
      PostInstallTaskSchema.parse({
        kind: 'fill_credentials',
        bindingId: 'my-api-default',
        slots: [],
        description: 'Fill credentials for My API.',
        required: true,
      }),
    ).toThrow();
  });
});

describe('SkillBundleSchema — Plan 150 bounds', () => {
  it('rejects more than 20 apiDefinitions', () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => validApiDef(`api-${i}`));
    expect(() => SkillBundleSchema.parse({ ...valid(), apiDefinitions: tooMany })).toThrow();
  });

  it('rejects more than 50 memorySeed entries', () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => ({
      path: `docs/${i}.md`,
      content: 'x',
      docType: 'markdown' as const,
    }));
    expect(() => SkillBundleSchema.parse({ ...valid(), memorySeed: tooMany })).toThrow();
  });

  it('rejects more than 10 helmsmanHints', () => {
    const tooMany = Array.from({ length: 11 }, (_, i) => `hint ${i}`);
    expect(() => SkillBundleSchema.parse({ ...valid(), helmsmanHints: tooMany })).toThrow();
  });
});

/**
 * The installer carries this source inline, so validation and execution have to
 * agree on the same quantity. A character limit cannot state it: JSON escaping
 * is content-dependent, so the encoded size is not a function of the length.
 */
describe('BundleArtifactSeedSchema.source', () => {
  const seed = (source: string) => ({
    bindingId: 'b',
    bundleArtifactKey: 'k',
    name: 'n',
    kind: 'react_tsx' as const,
    source,
    dataSchema: {},
    sampleData: {},
    catalogPin: { catalogId: 'c', catalogVersion: '1', catalogHash: 'h' },
  });

  it('accepts a source whose encoded form fits the inline lane', () => {
    expect(BundleArtifactSeedSchema.safeParse(seed('x'.repeat(1000))).success).toBe(true);
  });

  it('accepts one past the inline cap — the installer content-addresses it instead', () => {
    // Every quote escapes to two bytes once encoded; the schema no longer
    // carries the inline bound because the installer measures the encoded
    // source itself and picks the lane.
    expect(BundleArtifactSeedSchema.safeParse(seed('"'.repeat(70_000))).success).toBe(true);
  });

  it('still refuses a source past the outer character bound', () => {
    expect(BundleArtifactSeedSchema.safeParse(seed('x'.repeat(200_001))).success).toBe(false);
  });
});
