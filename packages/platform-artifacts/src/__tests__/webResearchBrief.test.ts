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
import { BRAVE_CONNECTOR } from '../connectorCatalog/brave.js';
import { FIRECRAWL_CONNECTOR } from '../connectorCatalog/firecrawl.js';
import { WEB_RESEARCH_BRIEF_DATA_SCHEMA } from '../skillCatalog/webResearchBriefShape.js';
import { WEB_RESEARCH_BRIEF } from '../skillCatalog/webResearchBrief.js';
import { WEB_RESEARCH_BRIEF_CARD_SEED } from '../skillBundleCatalog/webResearchBriefArtifactSeed.js';

const BRIEF_SLUG = 'web-research-brief';
const BUNDLE_ID = 'web-research';

describe('WEB_RESEARCH_BRIEF', () => {
  const entry = getSkillCatalogEntry(BRIEF_SLUG);
  if (!entry) {
    throw new Error(`skill catalog entry "${BRIEF_SLUG}" not found`);
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

  it('has the expected 3-task graph', () => {
    expect(new Set(wf.tasks.map((t) => t.taskId))).toEqual(
      new Set(['gather-sources', 'compose-brief', 'render-brief-card']),
    );
  });

  it('gather and compose are agents; render is a deterministic operation task', () => {
    expect(task('gather-sources')?.type).toBe('agent');
    expect(task('compose-brief')?.type).toBe('agent');
    expect(task('render-brief-card')?.type).toBe('operation');
  });

  it('declares question (required) + focus (optional) run inputs, and every run_input binding is covered', () => {
    const inputs = new Map(wf.runInputs?.map((i) => [i.id, i]) ?? []);
    expect(inputs.get('question')?.required).toBe(true);
    expect(inputs.get('focus')?.required).toBe(false);
    for (const t of wf.tasks) {
      for (const [key, binding] of Object.entries(t.inputBindings ?? {})) {
        const b = binding as { kind: string; path?: string };
        if (b.kind !== 'run_input') continue;
        expect(inputs.has(b.path ?? ''), `task ${t.taskId} binding ${key}`).toBe(true);
      }
    }
  });

  it('gather-sources is the only task with web tools: brave web+news search and firecrawl scrape, all scoped', () => {
    const grants = task('gather-sources')?.context?.capabilities?.integrations ?? [];
    expect(grants.every((g) => g.sourceKind === 'api' && g.allTools === false)).toBe(true);
    const byApi = new Map(grants.map((g) => [g.integrationId, g]));
    expect(byApi.get('brave-search')?.toolNames?.map((t) => t.toolName)).toEqual([
      'webSearch',
      'newsSearch',
    ]);
    expect(byApi.get('firecrawl')?.toolNames?.map((t) => t.toolName)).toEqual(['scrape']);
  });

  it('compose-brief is a zero-tool synthesis over bound inputs', () => {
    const caps = task('compose-brief')?.context?.capabilities;
    expect(caps?.operations).toEqual([]);
    expect(caps?.integrations).toEqual([]);
  });

  it('no agent task grants opTaskOnly tools', () => {
    expect(validateAgentOpTaskOnlyTools(wf.tasks)).toBeNull();
  });

  it('the terminal render task consumes the seeded card and matches manifest.uiOutput', () => {
    const render = task('render-brief-card');
    expect(render?.operation).toBe('ui.artifact.render');
    expect(render?.inputBindings?.['artifactId']).toEqual({
      kind: 'artifact_binding',
      bundleId: BUNDLE_ID,
      bindingId: 'brief-card',
    });
    expect(render?.inputBindings?.['data']).toEqual({
      kind: 'task_output',
      taskId: 'compose-brief',
      path: 'digest',
    });
    expect(entry.bundle.manifest.uiOutput).toEqual({ kind: 'artifact', bindingId: 'brief-card' });
    expect(
      validateSkillUiOutputShape(
        entry.bundle.manifest.uiOutput,
        wf.tasks as unknown as Parameters<typeof validateSkillUiOutputShape>[1],
      ),
    ).toEqual([]);
  });

  it('compose-brief is held to the exact card dataSchema (one shape, two surfaces)', () => {
    // Identity on the raw modules: both import the same constant.
    const rawSchema = (
      WEB_RESEARCH_BRIEF.bundle.workflow.tasks.find((t) => t.taskId === 'compose-brief')
        ?.outputContract?.schema as { properties: Record<string, unknown> }
    ).properties['digest'];
    expect(rawSchema).toBe(WEB_RESEARCH_BRIEF_DATA_SCHEMA);
    expect(WEB_RESEARCH_BRIEF_CARD_SEED.dataSchema).toBe(WEB_RESEARCH_BRIEF_DATA_SCHEMA);
    // Equality through the parsed catalog registries (parse deep-copies).
    const parsedSchema = (
      task('compose-brief')?.outputContract?.schema as { properties: Record<string, unknown> }
    ).properties['digest'];
    expect(parsedSchema).toEqual(WEB_RESEARCH_BRIEF_DATA_SCHEMA);
  });

  it('every finding in the digest shape requires an https source url', () => {
    const findings = (
      WEB_RESEARCH_BRIEF_DATA_SCHEMA.properties as {
        findings: {
          items: { required: readonly string[]; properties: Record<string, { pattern?: string }> };
        };
      }
    ).findings.items;
    expect(findings.required).toContain('sourceUrl');
    expect(findings.properties['sourceUrl']?.pattern).toBe('^https://');
  });
});

describe('web-research-brief bundle', () => {
  const bundle = getSkillBundleEntry(BUNDLE_ID);
  if (!bundle) {
    throw new Error(`bundle "${BUNDLE_ID}" not found`);
  }
  const skill = getSkillCatalogEntry(BRIEF_SLUG);
  if (!skill) {
    throw new Error(`skill catalog entry "${BRIEF_SLUG}" not found`);
  }

  it('installs exactly the research-brief skill and revalidates through SkillBundleSchema', () => {
    expect(bundle.skillCatalogIds).toEqual([BRIEF_SLUG]);
    expect(bundle.hidden).toBeUndefined();
    expect(() => SkillBundleSchema.parse(bundle)).not.toThrow();
  });

  it('carries the brave + firecrawl definitions derived from the connector catalog (no hand-mirrored endpoints)', () => {
    expect(bundle.apiDefinitions.map((d) => d.apiId).sort()).toEqual(['brave-search', 'firecrawl']);
    for (const connector of [BRAVE_CONNECTOR, FIRECRAWL_CONNECTOR]) {
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
      expect.arrayContaining(['brave-search', 'brave-default', 'firecrawl', 'firecrawl-default']),
    );
  });

  it('every granted toolName is a bundle-carried endpoint (agent context grants)', () => {
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

  it('binding templates pin the connector hosts, brave via the X-Subscription-Token header', () => {
    const brave = bundle.apiBindingTemplates.find((t) => t.bindingId === 'brave-default');
    expect(brave?.authShape).toMatchObject({ type: 'api_key', headerName: 'X-Subscription-Token' });
    expect(brave?.egressPolicy.allowedHosts).toEqual(['api.search.brave.com']);
    expect(brave?.egressPolicy.allowedMethods).toEqual(['GET']);
    const firecrawl = bundle.apiBindingTemplates.find((t) => t.bindingId === 'firecrawl-default');
    expect(firecrawl?.authShape.type).toBe('bearer');
    expect(firecrawl?.egressPolicy.allowedHosts).toEqual(['api.firecrawl.dev']);
    expect(firecrawl?.egressPolicy.allowedMethods).toEqual(['GET', 'POST']);
  });

  it('ships no memory seed and no MCP surface', () => {
    expect(bundle.memorySeed).toEqual([]);
    expect(bundle.mcpDefinitions).toEqual([]);
    expect(bundle.mcpBindingTemplates).toEqual([]);
  });
});

describe('web-research-brief artifact seed', () => {
  const bundle = getSkillBundleEntry(BUNDLE_ID) as SkillBundle;
  const seed = bundle.artifactSeed[0]!;

  it('the bundle seeds exactly the brief card and the manifest binding resolves into it', () => {
    expect(bundle.artifactSeed.map((s) => s.bindingId)).toEqual(['brief-card']);
    expect(seed.bundleArtifactKey).toBe('web-research:brief-card');
    expect(seed.bundleArtifactKey).toContain(seed.bindingId);
    const skill = getSkillCatalogEntry(BRIEF_SLUG)!;
    const uiOutput = skill.bundle.manifest.uiOutput;
    expect(uiOutput?.kind).toBe('artifact');
    if (uiOutput?.kind === 'artifact') {
      expect(bundle.artifactSeed.map((s) => s.bindingId)).toContain(uiOutput.bindingId);
    }
  });

  it('parses against BundleArtifactSeedSchema', () => {
    expect(() => BundleArtifactSeedSchema.parse(seed)).not.toThrow();
  });

  it('sampleData covers every required dataSchema field', () => {
    const schema = seed.dataSchema as {
      required?: readonly string[];
      properties?: Record<string, { required?: readonly string[] }>;
    };
    const sample = seed.sampleData as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      expect(sample, `sampleData missing required key "${key}"`).toHaveProperty(key);
    }
  });

  it('every sample finding carries an https source url (the sourced-findings contract)', () => {
    const findings = (seed.sampleData as { findings: Array<{ sourceUrl: string }> }).findings;
    expect(findings.length).toBeGreaterThan(0);
    for (const item of findings) {
      expect(item.sourceUrl).toMatch(/^https:\/\//);
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
