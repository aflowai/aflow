/**
 * The ONE literature-scan shape. The compose task's `outputContract` embeds
 * this as `properties.scan` and the bundle's seeded card ships it verbatim as
 * `dataSchema` — the render step validates the composed data against the exact
 * schema the producer was held to, so the two surfaces cannot drift.
 *
 * Every paper carries a `url` (pattern ^https?://, required): an unsourced
 * paper cannot validate, so a scan with an invented paper never reaches the
 * card. arXiv abstract links and NCBI/PubMed links may be http or https, so
 * the pattern allows either — but the field is never optional.
 */
export const LITERATURE_SCAN_DATA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['topic', 'summary', 'papers', 'themes', 'gaps', 'coverageNote'],
  properties: {
    topic: {
      type: 'string',
      minLength: 1,
      maxLength: 600,
      description: 'The research topic or question the scan surveys.',
    },
    summary: {
      type: 'string',
      minLength: 1,
      maxLength: 5000,
      description:
        'The prose synthesis answering the topic — what the literature says, where it agrees, where it is contested — 4–10 sentences, every claim grounded in the gathered papers.',
    },
    papers: {
      type: 'array',
      minItems: 1,
      maxItems: 24,
      description: 'The papers the scan rests on, each traced to a real source URL.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'authors', 'year', 'url', 'source', 'keyPoint'],
        properties: {
          title: {
            type: 'string',
            minLength: 1,
            maxLength: 500,
            description: 'The paper title.',
          },
          authors: {
            type: 'array',
            minItems: 1,
            maxItems: 40,
            description: 'The paper’s authors, as listed by the source.',
            items: { type: 'string', minLength: 1, maxLength: 200 },
          },
          year: {
            type: 'integer',
            minimum: 1800,
            maximum: 2100,
            description: 'Publication year.',
          },
          venue: {
            type: 'string',
            maxLength: 300,
            description: 'The journal, conference, or preprint venue, when the source gives one.',
          },
          url: {
            type: 'string',
            pattern: '^https?://',
            maxLength: 2048,
            description:
              'The real source URL for this paper — an arXiv abstract link, a Semantic Scholar paper URL, or a PubMed link. Never invented. A paper without a real URL cannot be included.',
          },
          citationCount: {
            type: 'integer',
            minimum: 0,
            description:
              'The citation count as reported by the source (Semantic Scholar). Omit when the source did not carry one — never invent a number.',
          },
          source: {
            type: 'string',
            enum: ['arxiv', 'semantic_scholar', 'pubmed'],
            description: 'Which source this paper and its URL came from.',
          },
          keyPoint: {
            type: 'string',
            minLength: 1,
            maxLength: 800,
            description:
              'What this paper contributes to the topic — its finding, method, or claim, in one or two sentences.',
          },
        },
      },
    },
    themes: {
      type: 'array',
      maxItems: 12,
      description:
        'The themes or clusters the papers group into — how the literature organizes around the topic.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          description: {
            type: 'string',
            minLength: 1,
            maxLength: 800,
            description: 'What this theme covers and which papers sit in it.',
          },
        },
      },
    },
    gaps: {
      type: 'array',
      maxItems: 12,
      description:
        'Open gaps the literature does not resolve — questions the gathered papers leave unanswered.',
      items: { type: 'string', minLength: 1, maxLength: 400 },
    },
    coverageNote: {
      type: 'string',
      minLength: 1,
      maxLength: 3000,
      description:
        'How well the gathered papers cover the topic, which sources were searched, and every gap — a thin result set, a source that returned nothing, a subfield left uncovered — named honestly, never papered over.',
    },
  },
} as const;
