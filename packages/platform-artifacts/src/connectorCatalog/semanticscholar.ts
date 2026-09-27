import type { ConnectorCatalogEntry } from '@aflow/schemas';

const fieldsParam = {
  name: 'fields',
  location: 'query' as const,
  required: false,
  description:
    'Comma-separated list of fields to return on each object (the API returns only paperId ' +
    'and title unless fields are named). Nest sub-fields with a dot, e.g. ' +
    '"title,year,abstract,citationCount,authors.name,tldr". Request only the fields you need — ' +
    'larger field sets are slower and more rate-limited.',
  schema: { type: 'string' },
};

const paperIdParam = {
  name: 'paperId',
  location: 'path' as const,
  required: true,
  description:
    'A paper identifier. Accepts the Semantic Scholar paperId (a 40-char hex sha) or a typed ' +
    'external id: "DOI:10.1145/3197026", "ARXIV:2106.15928", "CorpusId:215416146", ' +
    '"PMID:19872477", or "URL:<semanticscholar-url>".',
  schema: { type: 'string' },
};

const offsetParam = {
  name: 'offset',
  location: 'query' as const,
  required: false,
  description: 'Zero-based index of the first result to return, for paging (default 0).',
  schema: { type: 'integer', minimum: 0 },
};

const limitParam = {
  name: 'limit',
  location: 'query' as const,
  required: false,
  description: 'Maximum number of results to return (default 100, max 100).',
  schema: { type: 'integer', minimum: 1, maximum: 100 },
};

export const SEMANTIC_SCHOLAR_CONNECTOR: ConnectorCatalogEntry = {
  catalogId: 'semantic-scholar',
  version: 2,
  name: 'Semantic Scholar',
  tagline: 'Search 200M+ academic papers, their citations, and authors (free API key).',
  description:
    'Semantic Scholar Academic Graph API. Search the corpus of over 200 million papers by ' +
    'keyword, fetch a single paper with its abstract, TLDR, references, and citation counts, ' +
    'walk a paper’s citations, and search authors. Read-only, returns JSON. Authenticated with a ' +
    'free API key sent as the x-api-key header — the key lifts the low shared rate limit the ' +
    'anonymous tier hits (~1 request/second, frequent HTTP 429), so most calls land instead of ' +
    'being throttled.',
  tags: ['research', 'academic', 'papers', 'citations', 'open-data'],
  vendor: 'Allen Institute for AI',
  category: 'research',
  honestyLabel: 'curated',
  authKind: 'api_key',
  apiKeyHeaderName: 'x-api-key',
  setupNote:
    'Get a free API key at semanticscholar.org/product/api and paste it as the credential. It is ' +
    'sent as the x-api-key request header. The key is free and lifts the low shared rate limit the ' +
    'anonymous tier is throttled to, so far fewer calls hit HTTP 429.',
  credentialPrompts: [
    {
      authField: 'credentialKey',
      label: 'Semantic Scholar API key',
      setupNote: 'Free from semanticscholar.org/product/api. Sent as the x-api-key header.',
    },
  ],
  definition: {
    apiId: 'semantic-scholar',
    name: 'Semantic Scholar',
    description:
      'Semantic Scholar Academic Graph API — paper search, paper/citation lookup, author search.',
    baseUrl: 'https://api.semanticscholar.org',
    version: '1',
    callMode: 'endpoint',
    defaultHeaders: { Accept: 'application/json' },
    suggestedEgressPolicy: { allowedMethods: ['GET'] },
    tags: ['research', 'academic'],
    endpoints: [
      {
        endpointId: 'searchPapers',
        name: 'Search papers',
        description:
          'Relevance-ranked keyword search over the paper corpus. Returns a paged list of ' +
          'matches; name the fields you want on each (searches return only paperId and title by ' +
          'default).',
        method: 'GET',
        pathTemplate: '/graph/v1/paper/search',
        params: [
          {
            name: 'query',
            location: 'query',
            required: true,
            description:
              'Plain-text search query (e.g. "machine learning for protein folding"). Matched ' +
              'against title and abstract; not a boolean/field-query language.',
            schema: { type: 'string' },
          },
          fieldsParam,
          {
            name: 'year',
            location: 'query',
            required: false,
            description:
              'Restrict to a publication year or range, e.g. "2019", "2016-2020", "2015-", "-2020".',
            schema: { type: 'string' },
          },
          {
            name: 'fieldsOfStudy',
            location: 'query',
            required: false,
            description:
              'Comma-separated fields of study to restrict to (e.g. "Computer Science,Medicine").',
            schema: { type: 'string' },
          },
          offsetParam,
          limitParam,
        ],
        pagination: { style: 'offset', cursorParam: 'offset', limitParam: 'limit' },
        tags: ['papers', 'search'],
      },
      {
        endpointId: 'getPaper',
        name: 'Get paper',
        description:
          'Fetch a single paper by id, with whichever fields you name — abstract, tldr, ' +
          'publication venue and year, citation and reference counts, authors, and external ids.',
        method: 'GET',
        pathTemplate: '/graph/v1/paper/{paperId}',
        params: [paperIdParam, fieldsParam],
        tags: ['papers'],
      },
      {
        endpointId: 'getPaperCitations',
        name: 'Get paper citations',
        description:
          'List the papers that cite a given paper (the citing side). Paged; name the fields you ' +
          'want on each citing paper via the fields param (e.g. "title,year,authors.name").',
        method: 'GET',
        pathTemplate: '/graph/v1/paper/{paperId}/citations',
        params: [paperIdParam, fieldsParam, offsetParam, limitParam],
        pagination: { style: 'offset', cursorParam: 'offset', limitParam: 'limit' },
        tags: ['papers', 'citations'],
      },
      {
        endpointId: 'searchAuthors',
        name: 'Search authors',
        description:
          'Search authors by name. Returns a paged list; name the fields you want on each author ' +
          'via the fields param (e.g. "name,paperCount,hIndex,affiliations").',
        method: 'GET',
        pathTemplate: '/graph/v1/author/search',
        params: [
          {
            name: 'query',
            location: 'query',
            required: true,
            description: 'Author name to search for (e.g. "Yann LeCun").',
            schema: { type: 'string' },
          },
          fieldsParam,
          offsetParam,
          limitParam,
        ],
        pagination: { style: 'offset', cursorParam: 'offset', limitParam: 'limit' },
        tags: ['authors', 'search'],
      },
    ],
  },
};
