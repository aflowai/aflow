import type { SkillCatalogEntry } from '@aflow/schemas';
import { CATALOG_EPOCH } from './constants.js';
import { LITERATURE_SCAN_DATA_SCHEMA } from './literatureScanShape.js';
import { SCAN_GATHER_PROMPT, SCAN_COMPOSE_PROMPT } from './literatureScanProse.js';

const LITERATURE_SCAN: SkillCatalogEntry = {
  catalogId: 'literature-review',
  version: 4,
  name: 'Literature Scan',
  tagline:
    'Survey the academic literature on a topic: search arXiv, Semantic Scholar and PubMed, select the key papers, compose a sourced scan — rendered as an inline card.',
  description: `Surveys the academic literature on one topic by searching across arXiv, Semantic Scholar, and PubMed, selecting the most relevant and most influential papers, and composing a scan where every paper traces to a real source URL. One run = one topic (plus an optional focus note narrowing the angle).

**What a scan contains**: a prose synthesis of what the literature says; the key papers, each with its authors, year, venue, citation count (where the source reported one), a linked source URL, and what it contributes; the themes the work clusters into; the open gaps the literature does not resolve; and an honest coverage note on which sources were searched and where they fall short.

**Grounded by construction**: the paper-gathering step is the only task with search tools — it searches the sources it judges relevant, selects the best papers, and gathers their metadata inside its own tool loop; the compose step is a zero-tool synthesis over the gathered papers, held to a typed contract in which every paper's source URL is required (pattern ^https?://), so an unsourced paper cannot validate. The scan the operator sees is the scan the schema enforced.

**One free key**: install the pack and paste a free Semantic Scholar API key (semanticscholar.org/product/api — the key lifts the anonymous tier's low rate limit so more calls land); arXiv and PubMed are keyless.`,
  tags: ['research', 'academic', 'papers', 'citations', 'literature'],
  capabilityHints: [
    {
      apiId: 'arxiv',
      description:
        'arXiv — keyword/author/category search over physics, CS, math, and quantitative-biology preprints (normalized JSON paper records).',
      requiredEndpoints: ['searchPapers'],
      setupNote: 'No credential required — arXiv is a public, keyless API.',
    },
    {
      apiId: 'semantic-scholar',
      description:
        'Semantic Scholar — cross-domain academic-graph search with abstracts and citation counts; walk a paper’s citations.',
      requiredEndpoints: ['searchPapers', 'getPaper', 'getPaperCitations'],
      setupNote:
        'Needs a free Semantic Scholar API key (semanticscholar.org/product/api, sent as the x-api-key header); arXiv and PubMed are keyless. The key lifts the anonymous tier’s low shared rate limit, so far fewer calls hit HTTP 429.',
    },
    {
      apiId: 'pubmed',
      description:
        'PubMed / NCBI E-utilities — search the biomedical literature for ids, then fetch summaries (JSON).',
      requiredEndpoints: ['esearch', 'esummary'],
      setupNote: 'No credential required — the NCBI E-utilities read API is public and keyless.',
    },
  ],
  bundle: {
    workflow: {
      slug: 'literature-scan',
      name: 'Literature Scan',
      description:
        'Survey one topic: search arXiv, Semantic Scholar and PubMed, select the key papers, compose the typed scan, render the seeded card inline.',
      goal: 'Produce one honestly-sourced literature scan per run: every paper traced to a real source URL, composed into the typed scan shape and rendered as the bundled card.',
      mode: 'process' as const,
      outcomes: [
        {
          id: 'scan-composed',
          name: 'Scan composed',
          evaluator: {
            type: 'threshold' as const,
            metric: 'scanComposed',
            operator: 'gte' as const,
            target: 1,
          },
        },
      ],
      runInputs: [
        {
          id: 'topic',
          required: true,
          description:
            'The research topic or question to survey (e.g. "diffusion models for protein structure prediction").',
        },
        {
          id: 'focus',
          required: false,
          description:
            'Optional angle narrowing the scan (e.g. a subfield, "recent work", or a specific method).',
        },
      ],
      tasks: [
        {
          taskId: 'gather-papers',
          name: 'Gather papers',
          goal: SCAN_GATHER_PROMPT,
          type: 'agent' as const,
          inputBindings: {
            topic: { kind: 'run_input' as const, path: 'topic' },
            focus: { kind: 'run_input' as const, path: 'focus' },
          },
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'none' as const,
            capabilities: {
              operations: ['agent.control.signal_blocked'],
              integrations: [
                {
                  capabilityId: 'arxiv-default',
                  binding: { kind: 'binding' as const, bindingId: 'arxiv-default' },
                  sourceKind: 'api' as const,
                  integrationId: 'arxiv',
                  toolNames: [{ toolName: 'searchPapers' }],
                  allTools: false,
                },
                {
                  capabilityId: 'semantic-scholar-default',
                  binding: { kind: 'binding' as const, bindingId: 'semantic-scholar-default' },
                  sourceKind: 'api' as const,
                  integrationId: 'semantic-scholar',
                  toolNames: [
                    { toolName: 'searchPapers' },
                    { toolName: 'getPaper' },
                    { toolName: 'getPaperCitations' },
                  ],
                  allTools: false,
                },
                {
                  capabilityId: 'pubmed-default',
                  binding: { kind: 'binding' as const, bindingId: 'pubmed-default' },
                  sourceKind: 'api' as const,
                  integrationId: 'pubmed',
                  toolNames: [{ toolName: 'esearch' }, { toolName: 'esummary' }],
                  allTools: false,
                },
              ],
            },
          },
          outputContract: {
            schema: {
              type: 'object',
              required: ['papers', 'coverageNote'],
              additionalProperties: false,
              properties: {
                papers: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 24,
                  items: {
                    type: 'object',
                    required: ['title', 'authors', 'year', 'url', 'source', 'keyPoint'],
                    additionalProperties: false,
                    properties: {
                      title: { type: 'string', minLength: 1, maxLength: 500 },
                      authors: {
                        type: 'array',
                        minItems: 1,
                        maxItems: 40,
                        items: { type: 'string', minLength: 1, maxLength: 200 },
                      },
                      year: { type: 'integer', minimum: 1800, maximum: 2100 },
                      venue: { type: 'string', maxLength: 300 },
                      url: {
                        type: 'string',
                        pattern: '^https?://',
                        maxLength: 2048,
                        description:
                          'The real source URL for this paper — arXiv abstract link, Semantic Scholar paper URL, or PubMed link. A paper without a real URL is dropped, never patched.',
                      },
                      citationCount: { type: 'integer', minimum: 0 },
                      source: {
                        type: 'string',
                        enum: ['arxiv', 'semantic_scholar', 'pubmed'],
                      },
                      keyPoint: { type: 'string', minLength: 1, maxLength: 800 },
                    },
                  },
                },
                coverageNote: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 3000,
                  description:
                    'Which sources were searched (and which skipped), how well the gathered papers cover the topic, and every gap — named honestly, never papered over.',
                },
              },
            },
          },
        },

        {
          taskId: 'compose-scan',
          name: 'Compose scan',
          goal: SCAN_COMPOSE_PROMPT,
          type: 'agent' as const,
          dependsOn: ['gather-papers'],
          inputBindings: {
            topic: { kind: 'run_input' as const, path: 'topic' },
            focus: { kind: 'run_input' as const, path: 'focus' },
            papers: { kind: 'task_output' as const, taskId: 'gather-papers', path: 'papers' },
            coverageNote: {
              kind: 'task_output' as const,
              taskId: 'gather-papers',
              path: 'coverageNote',
            },
          },
          // Pure synthesis: no tools — the scan composes from bound inputs
          // only, so every paper is traceable to a gathered source.
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'none' as const,
            capabilities: {
              operations: [],
              integrations: [],
            },
          },
          outputContract: {
            schema: {
              type: 'object',
              required: ['scan', 'brief', 'paperCount', 'scanComposed'],
              additionalProperties: false,
              properties: {
                scan: LITERATURE_SCAN_DATA_SCHEMA,
                brief: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 2500,
                  description: 'A short headline answer to the topic, drawn from scan.summary.',
                },
                paperCount: { type: 'integer', minimum: 1 },
                scanComposed: { type: 'integer', const: 1 },
              },
            },
          },
          promoteOutputs: [
            { kind: 'output_path' as const, path: 'brief', toState: 'brief' },
            { kind: 'output_path' as const, path: 'scanComposed', toState: 'scanComposed' },
          ],
        },

        {
          taskId: 'render-scan-card',
          name: 'Render scan card',
          goal: 'Render the bundle-shipped scan card with the composed scan data — the terminal task mounts the card inline in chat.',
          type: 'operation' as const,
          operation: 'ui.artifact.render',
          dependsOn: ['compose-scan'],
          inputBindings: {
            artifactId: {
              kind: 'artifact_binding' as const,
              bundleId: 'literature-scan',
              bindingId: 'scan-card',
            },
            data: {
              kind: 'task_output' as const,
              taskId: 'compose-scan',
              path: 'scan',
            },
          },
        },
      ],
      stateVariables: [
        {
          variableId: 'brief',
          name: 'Scan headline',
          description: 'A short headline answer to the topic, grounded in the gathered papers.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'scanComposed',
          name: 'Scan composed',
          description: '1 when the typed scan validated and the card render was reached.',
          required: false,
          sensitive: false,
          immutable: false,
        },
      ],
      output: {
        primary: 'brief',
        guidance:
          'The card mounted by the terminal render task IS the deliverable; the brief is its headline answer — report it to the operator without re-narrating every paper. Every paper traces to a real source URL; if the coverage note flagged gaps, relay them honestly.',
      },
      iteration: { auto: false, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
    },
    manifest: {
      skillId: 'literature-scan',
      name: 'Literature Scan',
      goal: {
        type: 'objective' as const,
        criteria: [
          {
            id: 'sourced-papers',
            description:
              'Every paper in the scan carries a real source URL — an arXiv, Semantic Scholar, or PubMed link — nothing invented, no patched links or citation counts.',
          },
          {
            id: 'addresses-topic',
            description:
              'The scan directly surveys the run’s topic (and the focus note when one was given), grounded in the gathered papers.',
          },
          {
            id: 'scan-rendered',
            description:
              'The seeded scan card renders from the composed scan data (the terminal render task succeeds).',
          },
        ],
      },
      mode: 'process' as const,
      uiOutput: { kind: 'artifact' as const, bindingId: 'scan-card' },
    },
    evalSuite: {
      goalCriteria: [],
      taskCriteria: {
        'gather-papers': [
          {
            name: 'papers-carry-source-urls',
            type: 'contains' as const,
            inField: 'papers',
            pattern: 'http',
          },
        ],
        'compose-scan': [
          {
            name: 'scan-addresses-topic',
            type: 'contains' as const,
            inField: 'brief',
            pattern: '\\S',
          },
          {
            name: 'papers-present',
            type: 'threshold' as const,
            metric: 'paperCount',
            operator: 'gte' as const,
            target: 1,
          },
        ],
      },
      trajectoryCriteria: [],
      weights: { goal: 0, task: 1.0, trajectory: 0 },
      createdAt: CATALOG_EPOCH,
      updatedAt: CATALOG_EPOCH,
      createdBy: 'platform',
    },
    activation: {
      triggerPatterns: [
        'literature scan on',
        'find papers on',
        'academic review of',
        'what does the research say about',
        'survey the literature on',
      ],
      activationHint:
        'One run surveys ONE topic: per-run inputs are the topic (required) and an optional focus note narrowing the angle. Produces an inline card — a synthesis, the key papers each linking their source, the themes they cluster into, open gaps, and a coverage note. Needs one free Semantic Scholar API key (arXiv and PubMed are keyless); once that credential is set the pack runs. For several topics, start one run per topic.',
      prerequisites: [],
      priority: 50,
    },
    rationale:
      'The scan earns trust structurally, not by prompt discipline alone: paper gathering is the only task with search tools — the dynamic multi-source search → select → gather loop lives inside that one agent’s own tool-call loop, so the graph stays a fixed three-task line rather than fanning out over a discovered paper list — and composition is a zero-tool synthesis over bound inputs whose output contract embeds the exact JSON Schema the seeded card ships as its dataSchema — one shape, two enforcement points, no drift. Each paper’s source URL is schema-required (pattern ^https?://), so an unsourced paper cannot validate. Semantic Scholar takes one free API key (its keyed tier lifts the anonymous rate limit that was throttling most calls); arXiv and PubMed stay keyless, so the pack installs with a single required credential. The terminal ui.artifact.render task plus manifest.uiOutput makes the card the skill’s declared deliverable.',
  },
};

export { LITERATURE_SCAN };
