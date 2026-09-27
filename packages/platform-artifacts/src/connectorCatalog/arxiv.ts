import type { ConnectorCatalogEntry } from '@aflow/schemas';

export const ARXIV_CONNECTOR: ConnectorCatalogEntry = {
  catalogId: 'arxiv',
  version: 2,
  name: 'arXiv',
  tagline: 'search arXiv scientific paper preprints',
  description:
    'arXiv preprint search API. Query the arXiv corpus of physics, mathematics, computer ' +
    'science, quantitative biology, and other e-prints by keyword, author, title, category, ' +
    'or arXiv id. Read-only, keyless — no credentials required. Search results are returned ' +
    'as compact typed JSON records: pagination counters plus a papers[] array with the id, ' +
    'title, authors, abstract, categories, and abstract/PDF links.',
  tags: ['research', 'papers', 'preprints', 'science', 'arxiv'],
  vendor: 'arXiv (Cornell University)',
  category: 'research',
  honestyLabel: 'curated',
  authKind: 'none',
  definition: {
    apiId: 'arxiv',
    name: 'arXiv',
    description: 'arXiv preprint search API — keyword/author/category search over e-prints.',
    baseUrl: 'https://export.arxiv.org',
    version: '2',
    callMode: 'endpoint',
    defaultHeaders: { Accept: 'application/atom+xml' },
    suggestedEgressPolicy: { allowedMethods: ['GET'] },
    tags: ['research', 'arxiv'],
    endpoints: [
      {
        endpointId: 'searchPapers',
        name: 'Search papers',
        description:
          'Search arXiv e-prints. Returns normalized JSON: { totalResults, startIndex, ' +
          'itemsPerPage, papers: [{ arxivId, title, authors[], abstract, published?, ' +
          'updated?, categories[], abstractUrl, pdfUrl?, doi? }] }. Use search_query for ' +
          'the query and id_list to fetch specific papers by id.',
        method: 'GET',
        pathTemplate: '/api/query',
        responseTransformPresetId: 'arxiv_atom_papers',
        params: [
          {
            name: 'search_query',
            location: 'query',
            required: false,
            description:
              'The search expression. Prefix fields with ti: (title), au: (author), abs: ' +
              '(abstract), cat: (category, e.g. cs.LG), or all: (any field), combined with ' +
              'AND / OR / ANDNOT — e.g. "all:transformer AND cat:cs.LG". At least one of ' +
              'search_query or id_list must be provided.',
            schema: { type: 'string' },
          },
          {
            name: 'id_list',
            location: 'query',
            required: false,
            description:
              'Comma-separated arXiv ids to fetch specific papers directly (e.g. ' +
              '"2101.00001,1706.03762"), optionally instead of or alongside search_query.',
            schema: { type: 'string' },
          },
          {
            name: 'start',
            location: 'query',
            required: false,
            description: 'Zero-based index of the first result to return (for paging).',
            schema: { type: 'integer', minimum: 0 },
          },
          {
            name: 'max_results',
            location: 'query',
            required: false,
            description:
              'Maximum number of results to return (default 10). For agent searches 10–15 is ' +
              'the right size — inspect a batch before paging or widening. The large upstream ' +
              'ceiling exists for intentional bulk paging, not for first queries.',
            schema: { type: 'integer', minimum: 1, maximum: 2000 },
          },
          {
            name: 'sortBy',
            location: 'query',
            required: false,
            description: 'Sort field: relevance, lastUpdatedDate, or submittedDate.',
            schema: { type: 'string', enum: ['relevance', 'lastUpdatedDate', 'submittedDate'] },
          },
          {
            name: 'sortOrder',
            location: 'query',
            required: false,
            description: 'Sort direction: ascending or descending.',
            schema: { type: 'string', enum: ['ascending', 'descending'] },
          },
        ],
        pagination: { style: 'offset', cursorParam: 'start', limitParam: 'max_results' },
        tags: ['search', 'papers'],
      },
    ],
  },
};
