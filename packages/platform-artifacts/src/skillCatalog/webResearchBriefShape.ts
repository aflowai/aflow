/**
 * The ONE research-brief shape. The compose task's `outputContract` embeds
 * this as `properties.digest` and the bundle's seeded card ships it verbatim
 * as `dataSchema` — the render step validates the composed data against the
 * exact schema the producer was held to, so the two surfaces cannot drift.
 *
 * Every finding carries a `sourceUrl` (pattern ^https://, required): an
 * unsourced finding cannot validate, so a brief with an invented claim never
 * reaches the card.
 */
export const WEB_RESEARCH_BRIEF_DATA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary', 'findings', 'openQuestions', 'sources', 'coverageNote'],
  properties: {
    title: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      description: 'A concise title naming the question the brief answers.',
    },
    summary: {
      type: 'string',
      minLength: 1,
      maxLength: 2000,
      description:
        'The prose answer to the question, grounded in the findings — 3–8 sentences, every claim traceable to a fetched source.',
    },
    findings: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      description: 'The load-bearing claims, each traced to the fetched source it came from.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'detail', 'sourceUrl', 'sourceTitle'],
        properties: {
          claim: {
            type: 'string',
            minLength: 1,
            maxLength: 300,
            description: 'The claim in one sentence.',
          },
          detail: {
            type: 'string',
            minLength: 1,
            maxLength: 800,
            description: 'The supporting detail — the specifics the fetched source carried.',
          },
          sourceUrl: {
            type: 'string',
            pattern: '^https://',
            maxLength: 2048,
            description:
              'The URL of the fetched page this finding traces to — exactly as it was scraped. An unsourced finding cannot validate.',
          },
          sourceTitle: {
            type: 'string',
            minLength: 1,
            maxLength: 300,
            description: 'The title of the source page.',
          },
        },
      },
    },
    openQuestions: {
      type: 'array',
      maxItems: 8,
      description:
        'What the fetched sources did not resolve — honest gaps the reader should know the brief does not cover.',
      items: { type: 'string', minLength: 1, maxLength: 300 },
    },
    sources: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      description: 'Every page fetched and used, deduped — the brief’s bibliography.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['url', 'title'],
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
        'How well the fetched sources cover the question, and every gap — a thin result set, a paywalled page, a stale source — named honestly, never papered over.',
    },
  },
} as const;
