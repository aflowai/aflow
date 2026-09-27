import { describe, it, expect } from 'vitest';
import type { SkillBundle, SkillBundleId } from '@aflow/schemas';
import {
  validateBundleInstallPreconditions,
  type ValidateBundleInstallOpts,
} from './bundleInstallValidator.js';

// ============================================================================
// Test factory helpers — keep individual tests small + readable
// ============================================================================

function mkBundle(overrides: Partial<SkillBundle> = {}): SkillBundle {
  return {
    bundleId: 'b' as SkillBundleId,
    version: 1,
    name: 'B',
    tagline: 'B',
    description: 'B',
    tags: [],
    skillCatalogIds: ['skill-a'],
    prerequisiteBundleIds: [],
    apiDefinitions: [],
    apiBindingTemplates: [],
    memorySeed: [],
    helmsmanHints: [],
    ...overrides,
  } as SkillBundle;
}

function mkApiDef(apiId: string) {
  return {
    apiId,
    definition: {
      name: apiId,
      baseUrl: 'https://api.example.com',
      authKind: 'none' as const,
      endpoints: [{ path: '/x', method: 'GET' as const }],
    },
    conflictPolicy: 'skip' as const,
  };
}

function mkBindingTpl(bindingId: string, apiId: string) {
  return {
    bindingId,
    apiId,
    name: bindingId,
    authShape: { type: 'none' as const },
    credentialSlots: [],
    egressPolicy: { allowedHosts: ['api.example.com'] },
    conflictPolicy: 'skip' as const,
  };
}

/**
 * Mock tx — `execute` returns whatever rows the per-test setup queues up.
 * Each test pushes one or more row sets into the queue (in the order the
 * validator will fire SELECTs).
 */
function mkTx(rowSets: Array<unknown[]> = []) {
  const queue = [...rowSets];
  return {
    execute: async () => {
      const rows = queue.shift() ?? [];
      return rows as unknown as never[];
    },
  } as unknown as ValidateBundleInstallOpts['tx'];
}

const SPACE = '00000000-0000-0000-0000-000000000001';

// ============================================================================
// Tests
// ============================================================================

describe('validateBundleInstallPreconditions — happy paths', () => {
  it('ok on a Plan 137 v1 bundle with no prereqs, no apis, no bindings', async () => {
    const result = await validateBundleInstallPreconditions({
      bundle: mkBundle(),
      spaceId: SPACE,
      tx: mkTx(),
      resolveBundle: () => null,
      checkSkillInstalled: async () => true,
    });
    expect(result.ok).toBe(true);
  });

  it('ok when binding template references a local apiDefinition', async () => {
    const result = await validateBundleInstallPreconditions({
      bundle: mkBundle({
        apiDefinitions: [mkApiDef('local-api')],
        apiBindingTemplates: [mkBindingTpl('local-api-default', 'local-api')],
      }),
      spaceId: SPACE,
      tx: mkTx(),
      resolveBundle: () => null,
      checkSkillInstalled: async () => true,
    });
    expect(result.ok).toBe(true);
  });
});

describe('validateBundleInstallPreconditions — prereq bundle existence', () => {
  it('errors when a declared prereq bundle is not in the catalog', async () => {
    const result = await validateBundleInstallPreconditions({
      bundle: mkBundle({ prerequisiteBundleIds: ['missing-prereq' as SkillBundleId] }),
      spaceId: SPACE,
      tx: mkTx(),
      resolveBundle: () => null,
      checkSkillInstalled: async () => true,
    });
    expect(result.ok).toBe(false);
    expect((result as { errors: string[] }).errors[0]).toMatch(/not registered in the catalog/);
  });
});

describe('validateBundleInstallPreconditions — prereq skills must be installed', () => {
  it('errors when a prereq bundle requires a skill that is not installed', async () => {
    const prereq = mkBundle({
      bundleId: 'prereq' as SkillBundleId,
      skillCatalogIds: ['needed-skill'],
    });
    const result = await validateBundleInstallPreconditions({
      bundle: mkBundle({ prerequisiteBundleIds: ['prereq' as SkillBundleId] }),
      spaceId: SPACE,
      tx: mkTx(),
      resolveBundle: (id) => (id === 'prereq' ? prereq : null),
      checkSkillInstalled: async () => false,
    });
    expect(result.ok).toBe(false);
    expect((result as { errors: string[] }).errors[0]).toMatch(/requires skill "needed-skill"/);
  });

  it('ok when all prereq skills are installed', async () => {
    const prereq = mkBundle({
      bundleId: 'prereq' as SkillBundleId,
      skillCatalogIds: ['s1', 's2'],
    });
    const result = await validateBundleInstallPreconditions({
      bundle: mkBundle({ prerequisiteBundleIds: ['prereq' as SkillBundleId] }),
      spaceId: SPACE,
      tx: mkTx(),
      resolveBundle: (id) => (id === 'prereq' ? prereq : null),
      checkSkillInstalled: async () => true,
    });
    expect(result.ok).toBe(true);
  });
});

describe('validateBundleInstallPreconditions — prereq apis must be installed', () => {
  it('errors when a prereq bundle requires an apiDefinition that is not present', async () => {
    const prereq = mkBundle({
      bundleId: 'prereq' as SkillBundleId,
      apiDefinitions: [mkApiDef('alpaca-account-read')],
    });
    // First SELECT returns empty (the apiDefinition is missing).
    const result = await validateBundleInstallPreconditions({
      bundle: mkBundle({ prerequisiteBundleIds: ['prereq' as SkillBundleId] }),
      spaceId: SPACE,
      tx: mkTx([[]]),
      resolveBundle: (id) => (id === 'prereq' ? prereq : null),
      checkSkillInstalled: async () => true,
    });
    expect(result.ok).toBe(false);
    expect((result as { errors: string[] }).errors[0]).toMatch(
      /API definition "alpaca-account-read"/,
    );
  });

  it('ok when the prereq apiDefinition is present', async () => {
    const prereq = mkBundle({
      bundleId: 'prereq' as SkillBundleId,
      apiDefinitions: [mkApiDef('alpaca-account-read')],
    });
    const result = await validateBundleInstallPreconditions({
      bundle: mkBundle({ prerequisiteBundleIds: ['prereq' as SkillBundleId] }),
      spaceId: SPACE,
      tx: mkTx([[{ api_id: 'alpaca-account-read' }]]),
      resolveBundle: (id) => (id === 'prereq' ? prereq : null),
      checkSkillInstalled: async () => true,
    });
    expect(result.ok).toBe(true);
  });
});

describe('validateBundleInstallPreconditions — prereq bindings must be installed', () => {
  it('errors when a prereq bundle requires a binding that is not present', async () => {
    const prereq = mkBundle({
      bundleId: 'prereq' as SkillBundleId,
      apiDefinitions: [mkApiDef('alpaca-account-read')],
      apiBindingTemplates: [mkBindingTpl('alpaca-account-read-default', 'alpaca-account-read')],
    });
    // First SELECT (apiDefinitions) finds the def; second SELECT (bindings) returns empty.
    const result = await validateBundleInstallPreconditions({
      bundle: mkBundle({ prerequisiteBundleIds: ['prereq' as SkillBundleId] }),
      spaceId: SPACE,
      tx: mkTx([[{ api_id: 'alpaca-account-read' }], []]),
      resolveBundle: (id) => (id === 'prereq' ? prereq : null),
      checkSkillInstalled: async () => true,
    });
    expect(result.ok).toBe(false);
    expect((result as { errors: string[] }).errors[0]).toMatch(
      /API binding "alpaca-account-read-default"/,
    );
  });

  it('errors when the installed binding row points at a different api_id (stale row guard)', async () => {
    const prereq = mkBundle({
      bundleId: 'prereq' as SkillBundleId,
      apiDefinitions: [mkApiDef('alpaca-account-read')],
      apiBindingTemplates: [mkBindingTpl('alpaca-account-read-default', 'alpaca-account-read')],
    });
    const result = await validateBundleInstallPreconditions({
      bundle: mkBundle({ prerequisiteBundleIds: ['prereq' as SkillBundleId] }),
      spaceId: SPACE,
      tx: mkTx([
        [{ api_id: 'alpaca-account-read' }],
        // Binding exists, but points at the wrong API.
        [{ binding_id: 'alpaca-account-read-default', api_id: 'some-other-api' }],
      ]),
      resolveBundle: (id) => (id === 'prereq' ? prereq : null),
      checkSkillInstalled: async () => true,
    });
    expect(result.ok).toBe(false);
    expect((result as { errors: string[] }).errors[0]).toMatch(
      /expects binding "alpaca-account-read-default" to target api_id="alpaca-account-read"/,
    );
  });
});

describe('validateBundleInstallPreconditions — cross-bundle apiId resolution', () => {
  it("ok when this bundle's binding template references a prereq bundle's apiId", async () => {
    // The work the schema-level refine used to do — now correctly resolved
    // here with prereq state available.
    const prereq = mkBundle({
      bundleId: 'prereq' as SkillBundleId,
      apiDefinitions: [mkApiDef('alpaca-account-read')],
    });
    const result = await validateBundleInstallPreconditions({
      bundle: mkBundle({
        prerequisiteBundleIds: ['prereq' as SkillBundleId],
        // Note: this bundle declares no apiDefinitions; the apiId comes from prereq.
        apiBindingTemplates: [mkBindingTpl('alpaca-account-read-default', 'alpaca-account-read')],
      }),
      spaceId: SPACE,
      tx: mkTx([[{ api_id: 'alpaca-account-read' }]]),
      resolveBundle: (id) => (id === 'prereq' ? prereq : null),
      checkSkillInstalled: async () => true,
    });
    expect(result.ok).toBe(true);
  });

  it('errors when binding template references an apiId neither local nor in any prereq', async () => {
    const result = await validateBundleInstallPreconditions({
      bundle: mkBundle({
        apiBindingTemplates: [mkBindingTpl('orphan-default', 'orphan-api')],
      }),
      spaceId: SPACE,
      tx: mkTx(),
      resolveBundle: () => null,
      checkSkillInstalled: async () => true,
    });
    expect(result.ok).toBe(false);
    expect((result as { errors: string[] }).errors[0]).toMatch(/does not resolve/);
  });
});

describe('validateBundleInstallPreconditions — authShape ↔ authKind alignment (P2)', () => {
  function mkApiDefWithAuth(
    apiId: string,
    authKind: 'none' | 'bearer' | 'api_key' | 'basic' | 'oauth2',
  ) {
    return {
      apiId,
      definition: {
        name: apiId,
        baseUrl: 'https://api.example.com',
        authKind,
        endpoints: [{ path: '/x', method: 'GET' as const }],
      },
      conflictPolicy: 'skip' as const,
    };
  }

  function mkBearerTpl(bindingId: string, apiId: string) {
    return {
      bindingId,
      apiId,
      name: bindingId,
      authShape: { type: 'bearer' as const },
      credentialSlots: [
        {
          authField: 'credentialKey',
          credentialKey: `${bindingId}-token`,
          role: 'token' as const,
          label: 'Token',
        },
      ],
      egressPolicy: { allowedHosts: ['api.example.com'] },
      conflictPolicy: 'skip' as const,
    };
  }

  it('errors when a basic API has a bearer binding template (Plan 150 §3.4.2)', async () => {
    const result = await validateBundleInstallPreconditions({
      bundle: mkBundle({
        apiDefinitions: [mkApiDefWithAuth('basic-api', 'basic')],
        apiBindingTemplates: [mkBearerTpl('basic-api-default', 'basic-api')],
      }),
      spaceId: SPACE,
      tx: mkTx(),
      resolveBundle: () => null,
      checkSkillInstalled: async () => true,
    });
    expect(result.ok).toBe(false);
    expect((result as { errors: string[] }).errors[0]).toMatch(
      /authShape\.type='bearer' does not match.+authKind='basic'/,
    );
  });

  it('accepts oauth2 authKind paired with oauth2_client_credentials authShape (the only non-identity mapping)', async () => {
    const tpl = {
      bindingId: 'oauth2-default',
      apiId: 'oauth2-api',
      name: 'oauth2-default',
      authShape: {
        type: 'oauth2_client_credentials' as const,
        tokenEndpoint: 'https://auth.example.com/token',
      },
      credentialSlots: [
        {
          authField: 'clientIdCredentialKey',
          credentialKey: 'oauth2-client-id',
          role: 'client_id' as const,
          label: 'Client ID',
        },
        {
          authField: 'clientSecretCredentialKey',
          credentialKey: 'oauth2-client-secret',
          role: 'client_secret' as const,
          label: 'Client Secret',
        },
      ],
      egressPolicy: { allowedHosts: ['api.example.com'] },
      conflictPolicy: 'skip' as const,
    };
    const result = await validateBundleInstallPreconditions({
      bundle: mkBundle({
        apiDefinitions: [mkApiDefWithAuth('oauth2-api', 'oauth2')],
        apiBindingTemplates: [tpl],
      }),
      spaceId: SPACE,
      tx: mkTx(),
      resolveBundle: () => null,
      checkSkillInstalled: async () => true,
    });
    expect(result.ok).toBe(true);
  });

  it('accepts identity mapping (bearer apiDef + bearer authShape)', async () => {
    const result = await validateBundleInstallPreconditions({
      bundle: mkBundle({
        apiDefinitions: [mkApiDefWithAuth('bearer-api', 'bearer')],
        apiBindingTemplates: [mkBearerTpl('bearer-api-default', 'bearer-api')],
      }),
      spaceId: SPACE,
      tx: mkTx(),
      resolveBundle: () => null,
      checkSkillInstalled: async () => true,
    });
    expect(result.ok).toBe(true);
  });
});

describe('validateBundleInstallPreconditions — multi-error accumulation', () => {
  it('accumulates all failing checks rather than short-circuiting', async () => {
    const prereq = mkBundle({
      bundleId: 'prereq' as SkillBundleId,
      skillCatalogIds: ['skill-needed'],
      apiDefinitions: [mkApiDef('api-needed')],
    });
    // skill not installed AND api not present
    const result = await validateBundleInstallPreconditions({
      bundle: mkBundle({
        prerequisiteBundleIds: ['prereq' as SkillBundleId],
        apiBindingTemplates: [mkBindingTpl('orphan-default', 'orphan-api')],
      }),
      spaceId: SPACE,
      tx: mkTx([[]]),
      resolveBundle: (id) => (id === 'prereq' ? prereq : null),
      checkSkillInstalled: async () => false,
    });
    expect(result.ok).toBe(false);
    const errors = (result as { errors: string[] }).errors;
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.some((e) => /requires skill "skill-needed"/.test(e))).toBe(true);
    expect(errors.some((e) => /API definition "api-needed"/.test(e))).toBe(true);
    expect(errors.some((e) => /does not resolve/.test(e))).toBe(true);
  });
});

// ============================================================================

function mkUiArtifactSkill(opts: {
  catalogId: string;
  bindingId: string;
  terminalOperation?: string;
}): {
  manifest: import('@aflow/schemas').SkillManifest;
  workflow: import('@aflow/schemas').Workflow;
} {
  return {
    manifest: {
      schemaVersion: 2,
      skillId: opts.catalogId,
      name: opts.catalogId,
      goal: 'render an artifact',
      origin: 'platform',
      workflowSlug: opts.catalogId,
      requiredCapabilities: [],
      uiOutput: { kind: 'artifact', bindingId: opts.bindingId },
      createdAt: '2026-05-22T00:00:00.000Z',
      updatedAt: '2026-05-22T00:00:00.000Z',
    } as import('@aflow/schemas').SkillManifest,
    workflow: {
      slug: opts.catalogId,
      tasks: [
        {
          taskId: 'render',
          operation: opts.terminalOperation ?? 'ui.artifact.render',
          // PR #355 review fix — the validator now requires the
          // terminal task to declare `inputBindings.artifactId` with
          // `kind: 'artifact_binding'` whose `bindingId` matches
          // `uiOutput.bindingId`. Fixture mirrors the canonical Phase
          // 5b skill shape unless the test deliberately overrides
          // `terminalOperation` (the wrong-operation case below); for
          // that case the binding is dropped so the wrong_operation
          // branch fires first.
          ...(opts.terminalOperation === undefined ||
          opts.terminalOperation === 'ui.artifact.render'
            ? {
                inputBindings: {
                  artifactId: {
                    kind: 'artifact_binding',
                    bundleId: 'test-bundle',
                    bindingId: opts.bindingId,
                  },
                },
              }
            : {}),
        },
      ],
    } as unknown as import('@aflow/schemas').Workflow,
  };
}

function mkArtifactSeed(bindingId: string) {
  return {
    bindingId,
    bundleArtifactKey: `b:${bindingId}`,
    name: bindingId,
    kind: 'react_tsx' as const,
    source: 'export default function C() { return null; }',
    dataSchema: { type: 'object' },
    sampleData: {},
    catalogPin: { catalogId: 'phoenix-ds', catalogVersion: '1.0.0', catalogHash: 'h' },
    tags: [],
  };
}

describe('validateBundleInstallPreconditions — uiOutput cross-reference (Plan 158 §4.1)', () => {
  it('ok when skill uiOutput.bindingId matches an artifactSeed', async () => {
    const result = await validateBundleInstallPreconditions({
      bundle: mkBundle({
        skillCatalogIds: ['render-card'],
        artifactSeed: [mkArtifactSeed('hello-card')],
      }),
      spaceId: SPACE,
      tx: mkTx(),
      resolveBundle: () => null,
      checkSkillInstalled: async () => true,
      resolveSkill: (id) =>
        id === 'render-card' ? mkUiArtifactSkill({ catalogId: id, bindingId: 'hello-card' }) : null,
    });
    expect(result.ok).toBe(true);
  });

  it('errors when bindingId references no artifactSeed', async () => {
    const result = await validateBundleInstallPreconditions({
      bundle: mkBundle({
        skillCatalogIds: ['render-card'],
        artifactSeed: [mkArtifactSeed('other-card')],
      }),
      spaceId: SPACE,
      tx: mkTx(),
      resolveBundle: () => null,
      checkSkillInstalled: async () => true,
      resolveSkill: (id) =>
        id === 'render-card' ? mkUiArtifactSkill({ catalogId: id, bindingId: 'hello-card' }) : null,
    });
    expect(result.ok).toBe(false);
    const errors = (result as { errors: string[] }).errors;
    expect(errors.some((e) => /bindingId='hello-card' has no matching artifactSeed/.test(e))).toBe(
      true,
    );
  });

  it('errors when terminal task does not match uiOutput.kind', async () => {
    const result = await validateBundleInstallPreconditions({
      bundle: mkBundle({
        skillCatalogIds: ['render-card'],
        artifactSeed: [mkArtifactSeed('hello-card')],
      }),
      spaceId: SPACE,
      tx: mkTx(),
      resolveBundle: () => null,
      checkSkillInstalled: async () => true,
      resolveSkill: (id) =>
        id === 'render-card'
          ? mkUiArtifactSkill({
              catalogId: id,
              bindingId: 'hello-card',
              terminalOperation: 'memory.store.put',
            })
          : null,
    });
    expect(result.ok).toBe(false);
    const errors = (result as { errors: string[] }).errors;
    expect(errors.some((e) => /uiOutput\.wrong_operation.*ui\.artifact\.render/.test(e))).toBe(
      true,
    );
  });

  it('ok when bindingId resolves via a prerequisite bundle artifactSeed', async () => {
    const prereq = mkBundle({
      bundleId: 'prereq' as SkillBundleId,
      artifactSeed: [mkArtifactSeed('hello-card')],
    });
    const result = await validateBundleInstallPreconditions({
      bundle: mkBundle({
        prerequisiteBundleIds: ['prereq' as SkillBundleId],
        skillCatalogIds: ['render-card'],
        // tx queue: prereq apiDefinitions + bindings (both empty); we mock empty
        artifactSeed: [],
      }),
      spaceId: SPACE,
      tx: mkTx([[]]), // prereq apis empty
      resolveBundle: (id) => (id === 'prereq' ? prereq : null),
      checkSkillInstalled: async () => true,
      resolveSkill: (id) =>
        id === 'render-card' ? mkUiArtifactSkill({ catalogId: id, bindingId: 'hello-card' }) : null,
    });
    expect(result.ok).toBe(true);
  });

  it("errors when terminal task's inputBindings.artifactId.bindingId doesn't match manifest (PR #355 review)", async () => {
    // Mismatch — the skill's manifest declares uiOutput.bindingId='hello-card'
    // but the terminal task's inputBindings.artifactId.bindingId is
    // 'hello_card' (typo). The validator must catch this at install time
    // rather than letting it fail at runtime with the resolver's opaque
    // "no matching row" error.
    const result = await validateBundleInstallPreconditions({
      bundle: mkBundle({
        skillCatalogIds: ['render-card'],
        artifactSeed: [mkArtifactSeed('hello-card')],
      }),
      spaceId: SPACE,
      tx: mkTx(),
      resolveBundle: () => null,
      checkSkillInstalled: async () => true,
      resolveSkill: (id) =>
        id === 'render-card'
          ? {
              ...mkUiArtifactSkill({ catalogId: id, bindingId: 'hello-card' }),
              workflow: {
                slug: id,
                tasks: [
                  {
                    taskId: 'render',
                    operation: 'ui.artifact.render',
                    inputBindings: {
                      artifactId: {
                        kind: 'artifact_binding',
                        bundleId: 'test-bundle',
                        bindingId: 'hello_card', // typo
                      },
                    },
                  },
                ],
              } as unknown as import('@aflow/schemas').Workflow,
            }
          : null,
    });
    expect(result.ok).toBe(false);
    const errors = (result as { errors: string[] }).errors;
    expect(errors.some((e) => /mismatched_binding_id/.test(e))).toBe(true);
    expect(errors.some((e) => /hello-card/.test(e) && /hello_card/.test(e))).toBe(true);
  });
});
