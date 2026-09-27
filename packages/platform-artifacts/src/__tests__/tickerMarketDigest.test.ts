import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  deriveOpBoundProducerShapes,
  deriveRequiredCapabilities,
  validateAgentOpTaskOnlyTools,
  validateWorkflowGraph,
} from '@aflow/cybernetic-runtime';
import { validateAndCompile } from '@aflow/ui-artifact-compiler';
import {
  BundleArtifactSeedSchema,
  SkillBundleSchema,
  SkillComposeBundleSchema,
  validateSkillUiOutputShape,
  type SkillBundle,
  type WorkflowTask,
} from '@aflow/schemas';
import { getSkillCatalogEntry } from '../skillCatalog.js';
import { getSkillBundleEntry } from '../skillBundleCatalog.js';
import { POLYGON_CONNECTOR } from '../connectorCatalog/polygon.js';
import { NEWSAPI_CONNECTOR } from '../connectorCatalog/newsapi.js';
import { TICKER_DIGEST_DATA_SCHEMA } from '../skillCatalog/tickerMarketDigestShape.js';
import { TICKER_MARKET_DIGEST } from '../skillCatalog/tickerMarketDigest.js';
import { TICKER_DIGEST_CARD_SEED } from '../skillBundleCatalog/tickerDigestArtifactSeed.js';

const DIGEST_SLUG = 'ticker-market-digest';
const BUNDLE_ID = 'ticker-digest';

describe('TICKER_MARKET_DIGEST', () => {
  const entry = getSkillCatalogEntry(DIGEST_SLUG);
  if (!entry) {
    throw new Error(`skill catalog entry "${DIGEST_SLUG}" not found`);
  }
  const wf = entry.bundle.workflow;
  const task = (id: string) => wf.tasks.find((t) => t.taskId === id);

  it('parses as a SkillComposeBundle workflow', () => {
    const parsed = SkillComposeBundleSchema.safeParse(entry.bundle);
    if (!parsed.success) {
      throw new Error(JSON.stringify(parsed.error.issues.slice(0, 5), null, 2));
    }
    expect(parsed.success).toBe(true);
  });

  it('passes validateWorkflowGraph after Phase D materialization', () => {
    const tasks = deriveOpBoundProducerShapes(wf.tasks as unknown as WorkflowTask[]);
    const errors = validateWorkflowGraph(tasks, wf.stateVariables, wf.output);
    expect(errors).toEqual([]);
  });

  it('has the expected 4-task graph', () => {
    expect(new Set(wf.tasks.map((t) => t.taskId))).toEqual(
      new Set(['ingest-previous-close', 'gather-context', 'compose-digest', 'render-digest-card']),
    );
  });

  it('ingest and render are deterministic operation tasks; gather and compose are agents', () => {
    expect(task('ingest-previous-close')?.type).toBe('operation');
    expect(task('render-digest-card')?.type).toBe('operation');
    expect(task('gather-context')?.type).toBe('agent');
    expect(task('compose-digest')?.type).toBe('agent');
  });

  it('declares ticker (required) + focus (optional) run inputs, and every run_input binding is covered', () => {
    const inputs = new Map(wf.runInputs?.map((i) => [i.id, i]) ?? []);
    expect(inputs.get('ticker')?.required).toBe(true);
    expect(inputs.get('focus')?.required).toBe(false);
    for (const t of wf.tasks) {
      for (const [key, binding] of Object.entries(t.inputBindings ?? {})) {
        const b = binding as { kind: string; path?: string };
        if (b.kind !== 'run_input') continue;
        expect(inputs.has(b.path ?? ''), `task ${t.taskId} binding ${key}`).toBe(true);
      }
    }
  });

  it('ingest-previous-close is a polygon getPreviousClose call keyed by the run ticker', () => {
    const ingest = task('ingest-previous-close');
    expect(ingest?.operation).toBe('api.http.call');
    expect(ingest?.retryability).toBe('safe');
    expect(ingest?.inputBindings?.['ticker']).toEqual({ kind: 'run_input', path: 'ticker' });
    const template = ingest?.inputTemplate as Record<string, unknown>;
    expect(template['apiId']).toBe('polygon');
    expect(template['endpointId']).toBe('getPreviousClose');
    // minItems 1 on prevBar is the fail-fast for an unknown ticker.
    const schema = ingest?.outputContract?.schema as {
      properties: Record<string, { minItems?: number }>;
      required: string[];
    };
    expect(schema.required).toContain('prevBar');
    expect(schema.properties['prevBar']?.minItems).toBe(1);
  });

  it('gather-context grants exactly the four fetch tools across polygon + newsapi', () => {
    const grants = task('gather-context')?.context?.capabilities?.integrations ?? [];
    expect(grants.every((g) => g.sourceKind === 'api' && g.allTools === false)).toBe(true);
    const byApi = new Map(grants.map((g) => [g.integrationId, g]));
    expect(byApi.get('polygon')?.toolNames?.map((t) => t.toolName)).toEqual([
      'getAggregates',
      'getTickerDetails',
      'listTickerNews',
    ]);
    expect(byApi.get('newsapi')?.toolNames?.map((t) => t.toolName)).toEqual(['searchEverything']);
  });

  it('compose-digest is a zero-tool synthesis over bound inputs', () => {
    const caps = task('compose-digest')?.context?.capabilities;
    expect(caps?.operations).toEqual([]);
    expect(caps?.integrations).toEqual([]);
  });

  it('no agent task grants opTaskOnly tools', () => {
    expect(validateAgentOpTaskOnlyTools(wf.tasks)).toBeNull();
  });

  it('the terminal render task consumes the seeded card and matches manifest.uiOutput', () => {
    const render = task('render-digest-card');
    expect(render?.operation).toBe('ui.artifact.render');
    expect(render?.inputBindings?.['artifactId']).toEqual({
      kind: 'artifact_binding',
      bundleId: BUNDLE_ID,
      bindingId: 'digest-card',
    });
    expect(render?.inputBindings?.['data']).toEqual({
      kind: 'task_output',
      taskId: 'compose-digest',
      path: 'digest',
    });
    expect(entry.bundle.manifest.uiOutput).toEqual({ kind: 'artifact', bindingId: 'digest-card' });
    expect(
      validateSkillUiOutputShape(
        entry.bundle.manifest.uiOutput,
        wf.tasks as unknown as Parameters<typeof validateSkillUiOutputShape>[1],
      ),
    ).toEqual([]);
  });

  it('compose-digest is held to the exact card dataSchema (one shape, two surfaces)', () => {
    // Identity on the raw modules: both import the same constant.
    const rawSchema = (
      TICKER_MARKET_DIGEST.bundle.workflow.tasks.find((t) => t.taskId === 'compose-digest')
        ?.outputContract?.schema as { properties: Record<string, unknown> }
    ).properties['digest'];
    expect(rawSchema).toBe(TICKER_DIGEST_DATA_SCHEMA);
    expect(TICKER_DIGEST_CARD_SEED.dataSchema).toBe(TICKER_DIGEST_DATA_SCHEMA);
    // Equality through the parsed catalog registries (parse deep-copies).
    const parsedSchema = (
      task('compose-digest')?.outputContract?.schema as { properties: Record<string, unknown> }
    ).properties['digest'];
    expect(parsedSchema).toEqual(TICKER_DIGEST_DATA_SCHEMA);
  });
});

describe('ticker-digest bundle', () => {
  const bundle = getSkillBundleEntry(BUNDLE_ID);
  if (!bundle) {
    throw new Error(`bundle "${BUNDLE_ID}" not found`);
  }
  const skill = getSkillCatalogEntry(DIGEST_SLUG);
  if (!skill) {
    throw new Error(`skill catalog entry "${DIGEST_SLUG}" not found`);
  }

  it('installs exactly the digest skill and revalidates through SkillBundleSchema', () => {
    expect(bundle.skillCatalogIds).toEqual([DIGEST_SLUG]);
    expect(bundle.hidden).toBeUndefined();
    expect(() => SkillBundleSchema.parse(bundle)).not.toThrow();
  });

  it('carries the polygon + newsapi definitions derived from the connector catalog (no hand-mirrored endpoints)', () => {
    expect(bundle.apiDefinitions.map((d) => d.apiId).sort()).toEqual(['newsapi', 'polygon']);
    for (const connector of [POLYGON_CONNECTOR, NEWSAPI_CONNECTOR]) {
      const carried = bundle.apiDefinitions.find((d) => d.apiId === connector.definition.apiId);
      expect(carried?.definition.baseUrl).toBe(connector.definition.baseUrl);
      expect(carried?.definition.endpoints.map((e) => e.endpointId)).toEqual(
        connector.definition.endpoints.map((e) => e.endpointId),
      );
      // Per-endpoint fidelity: path template and declared query params survive
      // the draft lowering (path params are re-derived from {placeholder}s at
      // install by synthesizeEndpoints).
      for (const source of connector.definition.endpoints) {
        const lowered = carried?.definition.endpoints.find(
          (e) => e.endpointId === source.endpointId,
        );
        expect(lowered?.path, source.endpointId).toBe(source.pathTemplate);
        expect(
          (lowered?.queryParams ?? []).map((qp) => qp.name),
          source.endpointId,
        ).toEqual(source.params.filter((p) => p.location === 'query').map((p) => p.name));
      }
    }
  });

  it('every capability the skill requires is carried by the bundle', () => {
    const surfaceable = new Set<string>();
    for (const d of bundle.apiDefinitions) surfaceable.add(d.apiId);
    for (const t of bundle.apiBindingTemplates) {
      surfaceable.add(t.apiId);
      surfaceable.add(t.bindingId);
    }
    const required = deriveRequiredCapabilities(skill.bundle);
    const leftover = required.filter((cap) => !surfaceable.has(cap));
    expect(leftover).toEqual([]);
    // Non-vacuous: the derivation names both integrations and both bindings.
    expect(required).toEqual(
      expect.arrayContaining(['polygon', 'polygon-default', 'newsapi', 'newsapi-default']),
    );
  });

  it('every granted toolName and templated endpointId is a bundle-carried endpoint', () => {
    const endpointsByApi = new Map(
      bundle.apiDefinitions.map((d) => [
        d.apiId,
        new Set(d.definition.endpoints.map((e) => e.endpointId)),
      ]),
    );
    for (const t of skill.bundle.workflow.tasks) {
      for (const grant of t.context?.capabilities?.integrations ?? []) {
        if (grant.sourceKind !== 'api' || !grant.integrationId) continue;
        const endpoints = endpointsByApi.get(grant.integrationId);
        expect(endpoints, `${t.taskId}: unknown api ${grant.integrationId}`).toBeDefined();
        for (const named of grant.toolNames ?? []) {
          expect(
            endpoints!.has(named.toolName),
            `${t.taskId} grants "${named.toolName}" on "${grant.integrationId}"`,
          ).toBe(true);
        }
      }
      const template = t.inputTemplate as { apiId?: string; endpointId?: string } | undefined;
      if (t.operation === 'api.http.call' && template?.apiId) {
        expect(
          endpointsByApi.get(template.apiId)?.has(template.endpointId ?? ''),
          `${t.taskId} calls "${template.endpointId}" on "${template.apiId}"`,
        ).toBe(true);
      }
    }
  });

  it('binding templates pin the connector hosts read-only', () => {
    const polygon = bundle.apiBindingTemplates.find((t) => t.bindingId === 'polygon-default');
    expect(polygon?.authShape).toMatchObject({
      type: 'api_key',
      placement: 'query',
      queryParamName: 'apiKey',
    });
    expect(polygon?.egressPolicy.allowedHosts).toEqual(['api.polygon.io']);
    expect(polygon?.egressPolicy.allowedMethods).toEqual(['GET']);
    const newsapi = bundle.apiBindingTemplates.find((t) => t.bindingId === 'newsapi-default');
    expect(newsapi?.authShape).toMatchObject({ type: 'api_key', headerName: 'X-API-Key' });
    expect(newsapi?.egressPolicy.allowedHosts).toEqual(['newsapi.org']);
    expect(newsapi?.egressPolicy.allowedMethods).toEqual(['GET']);
  });

  it('ships no memory seed and no MCP surface', () => {
    expect(bundle.memorySeed).toEqual([]);
    expect(bundle.mcpDefinitions).toEqual([]);
    expect(bundle.mcpBindingTemplates).toEqual([]);
  });
});

describe('ticker-digest artifact seed', () => {
  const bundle = getSkillBundleEntry(BUNDLE_ID) as SkillBundle;
  const seed = bundle.artifactSeed[0]!;

  it('the bundle seeds exactly the digest card and the manifest binding resolves into it', () => {
    expect(bundle.artifactSeed.map((s) => s.bindingId)).toEqual(['digest-card']);
    expect(seed.bundleArtifactKey).toBe('ticker-digest:digest-card');
    expect(seed.bundleArtifactKey).toContain(seed.bindingId);
    const skill = getSkillCatalogEntry(DIGEST_SLUG)!;
    const uiOutput = skill.bundle.manifest.uiOutput;
    expect(uiOutput?.kind).toBe('artifact');
    if (uiOutput?.kind === 'artifact') {
      expect(bundle.artifactSeed.map((s) => s.bindingId)).toContain(uiOutput.bindingId);
    }
  });

  it('parses against BundleArtifactSeedSchema', () => {
    expect(() => BundleArtifactSeedSchema.parse(seed)).not.toThrow();
  });

  it('sampleData covers every required dataSchema field (top level and priceSummary)', () => {
    const schema = seed.dataSchema as {
      required?: readonly string[];
      properties?: Record<string, { required?: readonly string[] }>;
    };
    const sample = seed.sampleData as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      expect(sample, `sampleData missing required key "${key}"`).toHaveProperty(key);
    }
    const summarySchema = schema.properties?.['priceSummary'];
    const summarySample = sample['priceSummary'] as Record<string, unknown>;
    for (const key of summarySchema?.required ?? []) {
      expect(summarySample, `priceSummary missing required key "${key}"`).toHaveProperty(key);
    }
  });

  it('every sample news item carries an https URL (the sourced-news contract)', () => {
    const news = (seed.sampleData as { news: Array<{ url: string }> }).news;
    expect(news.length).toBeGreaterThan(0);
    for (const item of news) {
      expect(item.url).toMatch(/^https:\/\//);
    }
  });

  it('pins the phoenix-design-system catalog at the compact contract version', () => {
    expect(seed.catalogPin.catalogId).toBe('phoenix-design-system');
    const require = createRequire(import.meta.url);
    const contract = JSON.parse(
      readFileSync(require.resolve('@aflow/design-system/contract-compact.json'), 'utf8'),
    ) as { catalogVersion: string };
    expect(seed.catalogPin.catalogVersion).toBe(contract.catalogVersion);
  });

  it('source imports only allowed specifiers and exports a default function component', () => {
    expect(seed.source).toContain("from '@aflow/design-system'");
    expect(seed.source).toContain("from 'react'");
    expect(seed.source).toMatch(/export\s+default\s+function/);
  });

  it('compiles through validateAndCompile against the DS catalog with no unknown components', async () => {
    const require = createRequire(import.meta.url);
    const contract = JSON.parse(
      readFileSync(require.resolve('@aflow/design-system/contract-compact.json'), 'utf8'),
    ) as { components: Array<{ name: string }> };
    const result = await validateAndCompile(
      seed.source,
      'react_tsx',
      [],
      contract.components.map((c) => c.name),
      seed.sampleData,
    );
    expect(
      result.diagnostics.filter((d) => d.severity === 'error' || d.code === 'UNKNOWN_COMPONENT'),
    ).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.standaloneHtml).toBeTruthy();
  });
});
