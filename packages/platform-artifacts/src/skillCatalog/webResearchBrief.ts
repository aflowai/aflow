import type { SkillCatalogEntry } from '@aflow/schemas';
import { CATALOG_EPOCH } from './constants.js';
import { WEB_RESEARCH_BRIEF_DATA_SCHEMA } from './webResearchBriefShape.js';
import { BRIEF_GATHER_PROMPT, BRIEF_COMPOSE_PROMPT } from './webResearchBriefProse.js';

const WEB_RESEARCH_BRIEF: SkillCatalogEntry = {
  catalogId: 'web-research-brief',
  version: 1,
  name: 'Web Research Brief',
  tagline:
    'Research any question on the open web: search, read the best sources, compose a sourced brief — rendered as an inline card.',
  description: `Answers one research question by searching the open web, reading the most relevant sources, and composing a brief where every finding traces to a page that was actually fetched. One run = one question (plus an optional focus note narrowing the angle).

**What a brief contains**: a direct prose answer to the question; a set of load-bearing findings, each carrying the exact URL of the source it came from; open questions the fetched sources did not resolve; a deduped bibliography; and an honest coverage note on how well the sources answer the question and where they fall short.

**Grounded by construction**: the evidence-gathering step is the only task with web tools — it searches, selects the best hits, and fetches the chosen pages as markdown inside its own tool loop; the compose step is a zero-tool synthesis over the gathered evidence, held to a typed contract in which every finding's source URL is required (pattern ^https://), so an unsourced finding cannot validate. The brief the operator sees is the brief the schema enforced.

**Prerequisites**: Brave Search and Firecrawl credentials configured once after bundle install.`,
  tags: ['research', 'web-search', 'scraping', 'brief', 'sources'],
  capabilityHints: [
    {
      apiId: 'brave-search',
      description:
        'Brave Search — independent web and news search to find the most relevant, most authoritative pages for a question.',
      requiredEndpoints: ['webSearch', 'newsSearch'],
      authKind: 'api_key',
      setupNote:
        'Paste your Brave Search subscription token (api-dashboard.search.brave.com) as the binding credential. Sent as the X-Subscription-Token header. The free plan covers the search volume one brief needs.',
    },
    {
      apiId: 'firecrawl',
      description:
        'Firecrawl — fetch a chosen page and return its content as clean, LLM-ready markdown.',
      requiredEndpoints: ['scrape'],
      authKind: 'bearer',
      setupNote:
        'Paste your Firecrawl API key (firecrawl.dev, starts with "fc-") as the binding credential. Sent as Authorization: Bearer.',
    },
  ],
  bundle: {
    workflow: {
      slug: 'web-research-brief',
      name: 'Web Research Brief',
      description:
        'Research one question: search the web, select and fetch the best sources, compose the typed sourced brief, render the seeded card inline.',
      goal: 'Produce one honestly-sourced research brief per run: every finding traced to a page that was actually fetched, composed into the typed brief shape and rendered as the bundled card.',
      mode: 'process' as const,
      outcomes: [
        {
          id: 'brief-composed',
          name: 'Brief composed',
          evaluator: {
            type: 'threshold' as const,
            metric: 'briefComposed',
            operator: 'gte' as const,
            target: 1,
          },
        },
      ],
      runInputs: [
        {
          id: 'question',
          required: true,
          description:
            'The research question or topic to brief (e.g. "state of solid-state batteries in 2026").',
        },
        {
          id: 'focus',
          required: false,
          description:
            'Optional angle or constraint narrowing the brief (e.g. "focus on cost per kWh", "only peer-reviewed sources").',
        },
      ],
      tasks: [
        {
          taskId: 'gather-sources',
          name: 'Gather sources',
          goal: BRIEF_GATHER_PROMPT,
          type: 'agent' as const,
          inputBindings: {
            question: { kind: 'run_input' as const, path: 'question' },
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
                  capabilityId: 'brave-default',
                  binding: { kind: 'binding' as const, bindingId: 'brave-default' },
                  sourceKind: 'api' as const,
                  integrationId: 'brave-search',
                  toolNames: [{ toolName: 'webSearch' }, { toolName: 'newsSearch' }],
                  allTools: false,
                },
                {
                  capabilityId: 'firecrawl-default',
                  binding: { kind: 'binding' as const, bindingId: 'firecrawl-default' },
                  sourceKind: 'api' as const,
                  integrationId: 'firecrawl',
                  toolNames: [{ toolName: 'scrape' }],
                  allTools: false,
                },
              ],
            },
          },
          outputContract: {
            schema: {
              type: 'object',
              required: ['findings', 'sources', 'coverageNote'],
              additionalProperties: false,
              properties: {
                findings: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 12,
                  items: {
                    type: 'object',
                    required: ['claim', 'detail', 'sourceUrl', 'sourceTitle'],
                    additionalProperties: false,
                    properties: {
                      claim: { type: 'string', minLength: 1, maxLength: 300 },
                      detail: { type: 'string', minLength: 1, maxLength: 800 },
                      sourceUrl: {
                        type: 'string',
                        pattern: '^https://',
                        maxLength: 2048,
                        description:
                          'The URL of the fetched page this finding traces to — a finding without a real fetched URL is dropped, never patched.',
                      },
                      sourceTitle: { type: 'string', minLength: 1, maxLength: 300 },
                    },
                  },
                },
                sources: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 20,
                  items: {
                    type: 'object',
                    required: ['url', 'title'],
                    additionalProperties: false,
                    properties: {
                      url: { type: 'string', pattern: '^https://', maxLength: 2048 },
                      title: { type: 'string', minLength: 1, maxLength: 300 },
                    },
                  },
                },
                coverageNote: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 1000,
                  description:
                    'How well the fetched pages answer the question and every gap (thin results, a paywalled page, a stale source) — named honestly, never papered over.',
                },
              },
            },
          },
        },

        {
          taskId: 'compose-brief',
          name: 'Compose brief',
          goal: BRIEF_COMPOSE_PROMPT,
          type: 'agent' as const,
          dependsOn: ['gather-sources'],
          inputBindings: {
            question: { kind: 'run_input' as const, path: 'question' },
            focus: { kind: 'run_input' as const, path: 'focus' },
            findings: {
              kind: 'task_output' as const,
              taskId: 'gather-sources',
              path: 'findings',
            },
            sources: { kind: 'task_output' as const, taskId: 'gather-sources', path: 'sources' },
            coverageNote: {
              kind: 'task_output' as const,
              taskId: 'gather-sources',
              path: 'coverageNote',
            },
          },
          // Pure synthesis: no tools — the brief composes from bound inputs
          // only, so every finding is traceable to a fetched source.
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
              required: ['digest', 'brief', 'sourceCount', 'briefComposed'],
              additionalProperties: false,
              properties: {
                digest: WEB_RESEARCH_BRIEF_DATA_SCHEMA,
                brief: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 2000,
                  description: 'The prose answer, identical to digest.summary.',
                },
                sourceCount: { type: 'integer', minimum: 1 },
                briefComposed: { type: 'integer', const: 1 },
              },
            },
          },
          promoteOutputs: [
            { kind: 'output_path' as const, path: 'brief', toState: 'brief' },
            { kind: 'output_path' as const, path: 'briefComposed', toState: 'briefComposed' },
          ],
        },

        {
          taskId: 'render-brief-card',
          name: 'Render brief card',
          goal: 'Render the bundle-shipped brief card with the composed brief data — the terminal task mounts the card inline in chat.',
          type: 'operation' as const,
          operation: 'ui.artifact.render',
          dependsOn: ['compose-brief'],
          inputBindings: {
            artifactId: {
              kind: 'artifact_binding' as const,
              bundleId: 'web-research',
              bindingId: 'brief-card',
            },
            data: {
              kind: 'task_output' as const,
              taskId: 'compose-brief',
              path: 'digest',
            },
          },
        },
      ],
      stateVariables: [
        {
          variableId: 'brief',
          name: 'Research brief',
          description: 'The prose answer to the question, grounded in the fetched sources.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'briefComposed',
          name: 'Brief composed',
          description: '1 when the typed brief validated and the card render was reached.',
          required: false,
          sensitive: false,
          immutable: false,
        },
      ],
      output: {
        primary: 'brief',
        guidance:
          'The card mounted by the terminal render task IS the deliverable; the brief is its prose answer — report it to the operator without re-narrating every finding. Every finding traces to a page that was actually fetched; if the coverage note flagged gaps, relay them honestly.',
      },
      iteration: { auto: false, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
    },
    manifest: {
      skillId: 'web-research-brief',
      name: 'Web Research Brief',
      goal: {
        type: 'objective' as const,
        criteria: [
          {
            id: 'sourced-findings',
            description:
              'Every finding in the brief carries the real URL of a page that was actually fetched — nothing invented, no patched links.',
          },
          {
            id: 'addresses-question',
            description:
              'The brief directly answers the run’s question (and the focus note when one was given), grounded in the fetched sources.',
          },
          {
            id: 'brief-rendered',
            description:
              'The seeded brief card renders from the composed brief data (the terminal render task succeeds).',
          },
        ],
      },
      mode: 'process' as const,
      uiOutput: { kind: 'artifact' as const, bindingId: 'brief-card' },
    },
    evalSuite: {
      goalCriteria: [],
      taskCriteria: {
        'gather-sources': [
          {
            name: 'findings-carry-https-sources',
            type: 'contains' as const,
            inField: 'findings',
            pattern: 'https://',
          },
        ],
        'compose-brief': [
          {
            name: 'brief-answers-question',
            type: 'contains' as const,
            inField: 'brief',
            pattern: '\\S',
          },
          {
            name: 'sources-present',
            type: 'threshold' as const,
            metric: 'sourceCount',
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
        'research',
        'brief on',
        'look into',
        "what's the latest on",
        'what is the latest on',
        'find out about',
      ],
      activationHint:
        'One run briefs ONE question: per-run inputs are the question (required) and an optional focus note narrowing the angle. Produces an inline card — a direct answer, sourced findings each linking their page, open questions, and a bibliography. Requires the Brave Search and Firecrawl credentials configured after bundle install. For several questions, start one run per question.',
      prerequisites: [],
      priority: 50,
    },
    rationale:
      'The brief earns trust structurally, not by prompt discipline alone: evidence gathering is the only task with web tools — the dynamic search → select → fetch loop lives inside that one agent’s own tool-call loop, so the graph stays a fixed three-task line rather than fanning out over a discovered URL list — and composition is a zero-tool synthesis over bound inputs whose output contract embeds the exact JSON Schema the seeded card ships as its dataSchema — one shape, two enforcement points, no drift. Each finding’s source URL is schema-required (pattern ^https://), so an unsourced finding cannot validate. The terminal ui.artifact.render task plus manifest.uiOutput makes the card the skill’s declared deliverable.',
  },
};

export { WEB_RESEARCH_BRIEF };
