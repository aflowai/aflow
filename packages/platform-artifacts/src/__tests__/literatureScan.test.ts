import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  deriveFirstTaskInputContract,
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
import { ARXIV_CONNECTOR } from '../connectorCatalog/arxiv.js';
import { SEMANTIC_SCHOLAR_CONNECTOR } from '../connectorCatalog/semanticscholar.js';
import { PUBMED_CONNECTOR } from '../connectorCatalog/pubmed.js';
import { LITERATURE_SCAN_DATA_SCHEMA } from '../skillCatalog/literatureScanShape.js';
import { LITERATURE_SCAN } from '../skillCatalog/literatureScan.js';
import { LITERATURE_SCAN_CARD_SEED } from '../skillBundleCatalog/literatureScanArtifactSeed.js';

const SKILL_SLUG = 'literature-review';
const BUNDLE_ID = 'literature-scan';

describe('LITERATURE_SCAN', () => {
  const entry = getSkillCatalogEntry(SKILL_SLUG);
  if (!entry) {
    throw new Error(`skill catalog entry "${SKILL_SLUG}" not found`);
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
      new Set(['gather-papers', 'compose-scan', 'render-scan-card']),
    );
  });

  it('gather and compose are agents; render is a deterministic operation task', () => {
    expect(task('gather-papers')?.type).toBe('agent');
    expect(task('compose-scan')?.type).toBe('agent');
    expect(task('render-scan-card')?.type).toBe('operation');
  });

  it('declares topic (required) + focus (optional) run inputs, and every run_input binding is covered', () => {
    const inputs = new Map(wf.runInputs?.map((i) => [i.id, i]) ?? []);
    expect(inputs.get('topic')?.required).toBe(true);
    expect(inputs.get('focus')?.required).toBe(false);
    for (const t of wf.tasks) {
      for (const [key, binding] of Object.entries(t.inputBindings ?? {})) {
        const b = binding as { kind: string; path?: string };
        if (b.kind !== 'run_input') continue;
        expect(inputs.has(b.path ?? ''), `task ${t.taskId} binding ${key}`).toBe(true);
      }
    }
  });

  it('surfaces a firstTaskInputContract (topic required, focus optional) from inputBindings + runInputs', () => {
    // The entry task declares its run inputs via `inputBindings` only (no
    // hand-authored inputContract); the contract Helmsman reads must still
    // derive so a start passes `inputs.topic` instead of prose.
    const contract = deriveFirstTaskInputContract({
      slug: wf.slug,
      tasks: wf.tasks as unknown as WorkflowTask[],
      runInputs: wf.runInputs,
    }) as { properties: Record<string, unknown>; required: string[] } | null;
    expect(contract).not.toBeNull();
    expect(Object.keys(contract!.properties).sort()).toEqual(['focus', 'topic']);
    expect(contract!.required).toEqual(['topic']);
  });

  it('gather-papers is the only task with search tools across all three sources, all scoped', () => {
    const grants = task('gather-papers')?.context?.capabilities?.integrations ?? [];
    expect(grants.every((g) => g.sourceKind === 'api' && g.allTools === false)).toBe(true);
    const byApi = new Map(grants.map((g) => [g.integrationId, g]));
    expect(byApi.get('arxiv')?.toolNames?.map((t) => t.toolName)).toEqual(['searchPapers']);
    expect(byApi.get('semantic-scholar')?.toolNames?.map((t) => t.toolName)).toEqual([
      'searchPapers',
      'getPaper',
      'getPaperCitations',
    ]);
    expect(byApi.get('pubmed')?.toolNames?.map((t) => t.toolName)).toEqual(['esearch', 'esummary']);
  });

  it('compose-scan is a zero-tool synthesis over bound inputs', () => {
    const caps = task('compose-scan')?.context?.capabilities;
    expect(caps?.operations).toEqual([]);
    expect(caps?.integrations).toEqual([]);
  });

  it('no agent task grants opTaskOnly tools', () => {
    expect(validateAgentOpTaskOnlyTools(wf.tasks)).toBeNull();
  });

  it('the terminal render task consumes the seeded card and matches manifest.uiOutput', () => {
    const render = task('render-scan-card');
    expect(render?.operation).toBe('ui.artifact.render');
    expect(render?.inputBindings?.['artifactId']).toEqual({
      kind: 'artifact_binding',
      bundleId: BUNDLE_ID,
      bindingId: 'scan-card',
    });
    expect(render?.inputBindings?.['data']).toEqual({
      kind: 'task_output',
      taskId: 'compose-scan',
      path: 'scan',
    });
    expect(entry.bundle.manifest.uiOutput).toEqual({ kind: 'artifact', bindingId: 'scan-card' });
    expect(
      validateSkillUiOutputShape(
        entry.bundle.manifest.uiOutput,
        wf.tasks as unknown as Parameters<typeof validateSkillUiOutputShape>[1],
      ),
    ).toEqual([]);
  });

  it('compose-scan is held to the exact card dataSchema (one shape, two surfaces)', () => {
    // Identity on the raw modules: both import the same constant.
    const rawSchema = (
      LITERATURE_SCAN.bundle.workflow.tasks.find((t) => t.taskId === 'compose-scan')?.outputContract
        ?.schema as { properties: Record<string, unknown> }
    ).properties['scan'];
    expect(rawSchema).toBe(LITERATURE_SCAN_DATA_SCHEMA);
    expect(LITERATURE_SCAN_CARD_SEED.dataSchema).toBe(LITERATURE_SCAN_DATA_SCHEMA);
    // Equality through the parsed catalog registries (parse deep-copies).
    const parsedSchema = (
      task('compose-scan')?.outputContract?.schema as { properties: Record<string, unknown> }
    ).properties['scan'];
    expect(parsedSchema).toEqual(LITERATURE_SCAN_DATA_SCHEMA);
  });

  it('every paper in the scan shape requires a source url (pattern ^https?://)', () => {
    const papers = (
      LITERATURE_SCAN_DATA_SCHEMA.properties as {
        papers: {
          items: { required: readonly string[]; properties: Record<string, { pattern?: string }> };
        };
      }
    ).papers.items;
    expect(papers.required).toContain('url');
    expect(papers.properties['url']?.pattern).toBe('^https?://');
  });
});

describe('literature-scan bundle', () => {
  const bundle = getSkillBundleEntry(BUNDLE_ID);
  if (!bundle) {
    throw new Error(`bundle "${BUNDLE_ID}" not found`);
  }
  const skill = getSkillCatalogEntry(SKILL_SLUG);
  if (!skill) {
    throw new Error(`skill catalog entry "${SKILL_SLUG}" not found`);
  }

  it('installs exactly the literature-scan skill and revalidates through SkillBundleSchema', () => {
    expect(bundle.skillCatalogIds).toEqual([SKILL_SLUG]);
    expect(bundle.hidden).toBeUndefined();
    expect(() => SkillBundleSchema.parse(bundle)).not.toThrow();
  });

  it('carries the arxiv + semantic-scholar + pubmed definitions derived from the connector catalog (no hand-mirrored endpoints)', () => {
    expect(bundle.apiDefinitions.map((d) => d.apiId).sort()).toEqual([
      'arxiv',
      'pubmed',
      'semantic-scholar',
    ]);
    for (const connector of [ARXIV_CONNECTOR, SEMANTIC_SCHOLAR_CONNECTOR, PUBMED_CONNECTOR]) {
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
        // A declared response transform must survive the draft lowering — a
        // dropped preset silently reverts the endpoint to raw source format
        // at install.
        expect(lowered?.responseTransformPresetId, source.endpointId).toBe(
          source.responseTransformPresetId,
        );
      }
    }
    const arxivSearch = bundle.apiDefinitions
      .find((d) => d.apiId === 'arxiv')!
      .definition.endpoints.find((e) => e.endpointId === 'searchPapers');
    expect(arxivSearch?.responseTransformPresetId).toBe('arxiv_atom_papers');
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
    // Non-vacuous: the derivation names all three integrations and their bindings.
    expect(required).toEqual(
      expect.arrayContaining([
        'arxiv',
        'arxiv-default',
        'semantic-scholar',
        'semantic-scholar-default',
        'pubmed',
        'pubmed-default',
      ]),
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

  it('only semantic-scholar is keyed (x-api-key header, one slot); arXiv + PubMed stay keyless', () => {
    const s2 = bundle.apiBindingTemplates.find((t) => t.bindingId === 'semantic-scholar-default');
    expect(s2?.authShape).toEqual({
      type: 'api_key',
      placement: 'header',
      headerName: 'x-api-key',
    });
    expect(
      s2?.credentialSlots.map((slot) => ({ authField: slot.authField, role: slot.role })),
    ).toEqual([{ authField: 'credentialKey', role: 'api_key' }]);
    for (const bindingId of ['arxiv-default', 'pubmed-default']) {
      const tpl = bundle.apiBindingTemplates.find((t) => t.bindingId === bindingId);
      expect(tpl?.authShape.type, bindingId).toBe('none');
      expect(tpl?.credentialSlots, bindingId).toEqual([]);
    }
  });

  it('the required-credentials set is exactly the one free Semantic Scholar key', () => {
    const requiredCredentialKeys = bundle.apiBindingTemplates.flatMap((t) =>
      t.credentialSlots.map((s) => s.credentialKey),
    );
    expect(requiredCredentialKeys).toEqual(['semantic-scholar-api-key']);
  });

  it('binding templates pin each connector host, egress GET-only', () => {
    const arxiv = bundle.apiBindingTemplates.find((t) => t.bindingId === 'arxiv-default');
    expect(arxiv?.egressPolicy.allowedHosts).toEqual(['export.arxiv.org']);
    expect(arxiv?.egressPolicy.allowedMethods).toEqual(['GET']);
    const s2 = bundle.apiBindingTemplates.find((t) => t.bindingId === 'semantic-scholar-default');
    expect(s2?.egressPolicy.allowedHosts).toEqual(['api.semanticscholar.org']);
    expect(s2?.egressPolicy.allowedMethods).toEqual(['GET']);
    const pubmed = bundle.apiBindingTemplates.find((t) => t.bindingId === 'pubmed-default');
    expect(pubmed?.egressPolicy.allowedHosts).toEqual(['eutils.ncbi.nlm.nih.gov']);
    expect(pubmed?.egressPolicy.allowedMethods).toEqual(['GET']);
  });

  it('ships no memory seed and no MCP surface', () => {
    expect(bundle.memorySeed).toEqual([]);
    expect(bundle.mcpDefinitions).toEqual([]);
    expect(bundle.mcpBindingTemplates).toEqual([]);
  });
});

describe('literature-scan artifact seed', () => {
  const bundle = getSkillBundleEntry(BUNDLE_ID) as SkillBundle;
  const seed = bundle.artifactSeed[0]!;

  it('the bundle seeds exactly the scan card and the manifest binding resolves into it', () => {
    expect(bundle.artifactSeed.map((s) => s.bindingId)).toEqual(['scan-card']);
    expect(seed.bundleArtifactKey).toBe('literature-scan:scan-card');
    expect(seed.bundleArtifactKey).toContain(seed.bindingId);
    const skill = getSkillCatalogEntry(SKILL_SLUG)!;
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

  it('every sample paper carries a source url (the sourced-papers contract)', () => {
    const papers = (seed.sampleData as { papers: Array<{ url: string }> }).papers;
    expect(papers.length).toBeGreaterThan(0);
    for (const item of papers) {
      expect(item.url).toMatch(/^https?:\/\//);
    }
  });

  it('the sample spans all three sources', () => {
    const papers = (seed.sampleData as { papers: Array<{ source: string }> }).papers;
    expect(new Set(papers.map((p) => p.source))).toEqual(
      new Set(['arxiv', 'semantic_scholar', 'pubmed']),
    );
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
