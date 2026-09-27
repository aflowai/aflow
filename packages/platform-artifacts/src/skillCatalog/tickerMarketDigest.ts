import type { SkillCatalogEntry } from '@aflow/schemas';
import { CATALOG_EPOCH } from './constants.js';
import { TICKER_DIGEST_DATA_SCHEMA } from './tickerMarketDigestShape.js';
import { DIGEST_GATHER_CONTEXT_PROMPT, DIGEST_COMPOSE_PROMPT } from './tickerMarketDigestProse.js';

const TICKER_MARKET_DIGEST: SkillCatalogEntry = {
  catalogId: 'ticker-market-digest',
  version: 2,
  name: 'Ticker Market Digest',
  tagline:
    'One-ticker market digest: price trend, sourced news, watch items — rendered as an inline card.',
  description: `Produces a grounded market digest for one ticker and renders it as an inline card. One run = one ticker (plus an optional focus note steering the emphasis).

**What a digest contains**: a price summary (last close, 1-day and ~30-day change, window high/low, average volume) computed from fetched daily bars; a trend strip of the fetched closes; up to 12 news items merged from the market-data provider's ticker feed and a keyword search on the general news source — every item carrying its real article URL; 1–6 concrete watch items, each grounded in a fetched number or a cited article; and a short prose brief quoting the key numbers.

**Grounded by construction**: the previous-session bar is fetched deterministically first (an invalid ticker fails fast), the evidence-gathering step reports gaps honestly in a coverage note, and the compose step's output contract carries the exact schema the seeded card validates against — the digest the operator sees is the digest the schema enforced.

**Prerequisites**: Polygon.io and NewsAPI credentials configured once after bundle install.`,
  tags: ['market-data', 'news', 'stocks', 'digest', 'research'],
  capabilityHints: [
    {
      apiId: 'polygon',
      description:
        'Polygon.io market data — previous close, daily aggregate bars, ticker reference details, and ticker news.',
      requiredEndpoints: [
        'getPreviousClose',
        'getAggregates',
        'getTickerDetails',
        'listTickerNews',
      ],
      authKind: 'api_key',
      setupNote:
        'Paste your Polygon.io API key (polygon.io dashboard → API Keys) as the binding credential. Sent as the apiKey query parameter. Free-tier keys serve end-of-day data, which is all this skill needs.',
    },
    {
      apiId: 'newsapi',
      description:
        'NewsAPI article search — keyword coverage on the ticker and company name beyond the market-data feed.',
      requiredEndpoints: ['searchEverything'],
      authKind: 'api_key',
      setupNote:
        'Paste your NewsAPI key (newsapi.org → Get API Key) as the binding credential. Sent as the X-API-Key header. The free Developer plan covers the recent-articles window this skill searches.',
    },
  ],
  bundle: {
    workflow: {
      slug: 'ticker-market-digest',
      name: 'Ticker Market Digest',
      description:
        'Digest one ticker: fetch the previous close deterministically, gather bars + reference + sourced news, compose the typed digest, render the seeded card inline.',
      goal: 'Produce one honestly-grounded market digest per run: every number traced to fetched market data, every news item carrying its real source URL, composed into the typed digest shape and rendered as the bundled card.',
      mode: 'process' as const,
      outcomes: [
        {
          id: 'digest-composed',
          name: 'Digest composed',
          evaluator: {
            type: 'threshold' as const,
            metric: 'digestComposed',
            operator: 'gte' as const,
            target: 1,
          },
        },
      ],
      runInputs: [
        {
          id: 'ticker',
          required: true,
          description: 'The ticker symbol to digest (uppercase, e.g. AAPL).',
        },
        {
          id: 'focus',
          required: false,
          description:
            'Optional focus note steering the digest (e.g. "earnings reaction", "the recent selloff").',
        },
      ],
      tasks: [
        {
          taskId: 'ingest-previous-close',
          name: 'Ingest previous close',
          goal: 'Fetch the ticker’s previous-session bar — the deterministic anchor for the digest window, and the fail-fast validation that the ticker exists.',
          type: 'operation' as const,
          operation: 'api.http.call',
          retryability: 'safe' as const,
          inputBindings: {
            ticker: { kind: 'run_input' as const, path: 'ticker' },
          },
          // The entry task's contract is the skill's callable input surface: a run
          // input absent from it is refused at start, whatever runInputs declares.
          // `focus` is read by a later task and declared here for that reason.
          inputContract: {
            bindings: {
              ticker: {
                kind: 'run_input' as const,
                bindAs: 'ticker',
                path: 'ticker',
                schema: { type: 'string', minLength: 1, maxLength: 32 },
              },
              focus: {
                kind: 'run_input' as const,
                bindAs: 'focus',
                path: 'focus',
                schema: { type: 'string', minLength: 1, maxLength: 2000 },
              },
            },
          },
          inputTemplate: {
            apiId: 'polygon',
            endpointId: 'getPreviousClose',
            params: { ticker: { $bind: 'ticker' } },
            response: { format: 'json' },
          },
          outputProjection: {
            symbol: { path: 'data.ticker', onMissing: 'error' as const },
            prevBar: { path: 'data.results', onMissing: 'error' as const },
          },
          // minItems 1 makes an unknown ticker (an empty results array) fail
          // here with a teaching error instead of three tasks later.
          outputContract: {
            schema: {
              type: 'object',
              required: ['symbol', 'prevBar'],
              additionalProperties: false,
              properties: {
                symbol: { type: 'string' },
                prevBar: { type: 'array', minItems: 1, items: { type: 'object' } },
              },
            },
          },
        },

        {
          taskId: 'gather-context',
          name: 'Gather market context',
          goal: DIGEST_GATHER_CONTEXT_PROMPT,
          type: 'agent' as const,
          dependsOn: ['ingest-previous-close'],
          inputBindings: {
            ticker: { kind: 'run_input' as const, path: 'ticker' },
            focus: { kind: 'run_input' as const, path: 'focus' },
            symbol: {
              kind: 'task_output' as const,
              taskId: 'ingest-previous-close',
              path: 'symbol',
            },
            prevBar: {
              kind: 'task_output' as const,
              taskId: 'ingest-previous-close',
              path: 'prevBar',
            },
          },
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'none' as const,
            capabilities: {
              operations: ['agent.control.signal_blocked'],
              integrations: [
                {
                  capabilityId: 'polygon-default',
                  binding: { kind: 'binding' as const, bindingId: 'polygon-default' },
                  sourceKind: 'api' as const,
                  integrationId: 'polygon',
                  toolNames: [
                    { toolName: 'getAggregates' },
                    { toolName: 'getTickerDetails' },
                    { toolName: 'listTickerNews' },
                  ],
                  allTools: false,
                },
                {
                  capabilityId: 'newsapi-default',
                  binding: { kind: 'binding' as const, bindingId: 'newsapi-default' },
                  sourceKind: 'api' as const,
                  integrationId: 'newsapi',
                  toolNames: [{ toolName: 'searchEverything' }],
                  allTools: false,
                },
              ],
            },
          },
          outputContract: {
            schema: {
              type: 'object',
              required: ['company', 'bars', 'news', 'dataNotes'],
              additionalProperties: false,
              properties: {
                company: {
                  type: 'object',
                  required: ['name', 'description', 'primaryExchange', 'marketCap'],
                  additionalProperties: false,
                  properties: {
                    name: { type: 'string', minLength: 1, maxLength: 200 },
                    description: { type: ['string', 'null'], maxLength: 2000 },
                    primaryExchange: { type: ['string', 'null'], maxLength: 64 },
                    marketCap: { type: ['number', 'null'] },
                  },
                },
                bars: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 45,
                  items: {
                    type: 'object',
                    required: ['date', 'open', 'high', 'low', 'close', 'volume'],
                    additionalProperties: false,
                    properties: {
                      date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
                      open: { type: 'number' },
                      high: { type: 'number' },
                      low: { type: 'number' },
                      close: { type: 'number' },
                      volume: { type: 'number' },
                    },
                  },
                },
                news: {
                  type: 'array',
                  maxItems: 12,
                  items: {
                    type: 'object',
                    required: ['title', 'source', 'url', 'publishedAt', 'summary'],
                    additionalProperties: false,
                    properties: {
                      title: { type: 'string', minLength: 1, maxLength: 300 },
                      source: { type: 'string', minLength: 1, maxLength: 128 },
                      url: {
                        type: 'string',
                        pattern: '^https://',
                        maxLength: 2048,
                        description:
                          'The article URL exactly as the feed returned it — an item without a real URL is dropped, never patched.',
                      },
                      publishedAt: { type: 'string', minLength: 1, maxLength: 64 },
                      summary: { type: ['string', 'null'], maxLength: 500 },
                    },
                  },
                },
                dataNotes: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 1000,
                  description:
                    'What was fetched and every gap (empty news search, missing market cap, thin bar window) — named honestly, never papered over.',
                },
              },
            },
          },
        },

        {
          taskId: 'compose-digest',
          name: 'Compose digest',
          goal: DIGEST_COMPOSE_PROMPT,
          type: 'agent' as const,
          dependsOn: ['gather-context'],
          inputBindings: {
            ticker: { kind: 'run_input' as const, path: 'ticker' },
            focus: { kind: 'run_input' as const, path: 'focus' },
            symbol: {
              kind: 'task_output' as const,
              taskId: 'ingest-previous-close',
              path: 'symbol',
            },
            prevBar: {
              kind: 'task_output' as const,
              taskId: 'ingest-previous-close',
              path: 'prevBar',
            },
            company: { kind: 'task_output' as const, taskId: 'gather-context', path: 'company' },
            bars: { kind: 'task_output' as const, taskId: 'gather-context', path: 'bars' },
            news: { kind: 'task_output' as const, taskId: 'gather-context', path: 'news' },
            dataNotes: {
              kind: 'task_output' as const,
              taskId: 'gather-context',
              path: 'dataNotes',
            },
          },
          // Pure synthesis: no tools — the digest composes from bound inputs
          // only, so every number is traceable to a fetched value.
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
              required: ['digest', 'brief', 'newsCount', 'digestComposed'],
              additionalProperties: false,
              properties: {
                digest: TICKER_DIGEST_DATA_SCHEMA,
                brief: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 1500,
                  description: 'The prose brief, identical to digest.brief.',
                },
                newsCount: { type: 'integer', minimum: 0 },
                digestComposed: { type: 'integer', const: 1 },
              },
            },
          },
          promoteOutputs: [
            { kind: 'output_path' as const, path: 'brief', toState: 'brief' },
            { kind: 'output_path' as const, path: 'digestComposed', toState: 'digestComposed' },
          ],
        },

        {
          taskId: 'render-digest-card',
          name: 'Render digest card',
          goal: 'Render the bundle-shipped digest card with the composed digest data — the terminal task mounts the card inline in chat.',
          type: 'operation' as const,
          operation: 'ui.artifact.render',
          dependsOn: ['compose-digest'],
          inputBindings: {
            artifactId: {
              kind: 'artifact_binding' as const,
              bundleId: 'ticker-digest',
              bindingId: 'digest-card',
            },
            data: {
              kind: 'task_output' as const,
              taskId: 'compose-digest',
              path: 'digest',
            },
          },
        },
      ],
      stateVariables: [
        {
          variableId: 'brief',
          name: 'Digest brief',
          description: 'The prose brief: what the price did, what the news says, what to watch.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'digestComposed',
          name: 'Digest composed',
          description: '1 when the typed digest validated and the card render was reached.',
          required: false,
          sensitive: false,
          immutable: false,
        },
      ],
      output: {
        primary: 'brief',
        guidance:
          'The card mounted by the terminal render task IS the deliverable; the brief is its prose summary — report it to the operator without re-narrating the card’s numbers. Every figure in the digest traces to fetched market data and every news item carries its source URL; if the coverage note flagged gaps, relay them honestly.',
      },
      iteration: { auto: false, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
    },
    manifest: {
      skillId: 'ticker-market-digest',
      name: 'Ticker Market Digest',
      goal: {
        type: 'objective' as const,
        criteria: [
          {
            id: 'grounded-numbers',
            description:
              'Every number in the digest appears in, or derives arithmetically from, the fetched market data (previous close, daily bars, reference details) — nothing invented.',
          },
          {
            id: 'sourced-news',
            description:
              'Every news item in the digest carries its real article URL exactly as a fetched feed returned it.',
          },
          {
            id: 'digest-rendered',
            description:
              'The seeded digest card renders from the composed digest data (the terminal render task succeeds).',
          },
        ],
      },
      mode: 'process' as const,
      uiOutput: { kind: 'artifact' as const, bindingId: 'digest-card' },
    },
    evalSuite: {
      goalCriteria: [],
      taskCriteria: {
        'gather-context': [
          {
            name: 'data-notes-present',
            type: 'contains' as const,
            inField: 'dataNotes',
            pattern: '\\S',
          },
        ],
        'compose-digest': [
          {
            name: 'brief-cites-numbers',
            type: 'contains' as const,
            inField: 'brief',
            pattern: '[0-9]',
          },
          {
            name: 'news-items-present',
            type: 'threshold' as const,
            metric: 'newsCount',
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
        'market digest',
        'ticker digest',
        'digest for',
        'how is the stock doing',
        'price and news summary',
        'stock snapshot',
      ],
      activationHint:
        'One run digests ONE ticker: per-run inputs are the ticker symbol (required, uppercase) and an optional focus note. Produces an inline card — price summary, ~30-day trend, sourced news, watch items, prose brief. Requires the Polygon.io and NewsAPI credentials configured after bundle install. For several tickers, start one run per ticker.',
      prerequisites: [],
      priority: 50,
    },
    rationale:
      'The digest earns trust structurally, not by prompt discipline alone: the previous close is a deterministic op task (fail-fast on an unknown ticker), evidence gathering is the only task with external tools, and composition is a zero-tool synthesis over bound inputs whose output contract embeds the exact JSON Schema the seeded card ships as its dataSchema — one shape, two enforcement points, no drift. News URLs are schema-required (pattern ^https://), so an unsourced item cannot validate. The terminal ui.artifact.render task plus manifest.uiOutput makes the card the skill’s declared deliverable.',
  },
};

export { TICKER_MARKET_DIGEST };
