import type { ConnectorCatalogEntry } from '@aflow/schemas';

const dbParam = {
  name: 'db',
  location: 'query' as const,
  required: true,
  description: 'The Entrez database to query. Always "pubmed" for these endpoints.',
  schema: { type: 'string', enum: ['pubmed'] },
};

export const PUBMED_CONNECTOR: ConnectorCatalogEntry = {
  catalogId: 'pubmed',
  version: 1,
  name: 'PubMed',
  tagline: 'search biomedical literature via NCBI E-utilities',
  description:
    'PubMed / NCBI Entrez E-utilities read API for the biomedical literature. Two-step flow: ' +
    'esearch a query to get matching PubMed ids (PMIDs), then esummary those PMIDs for titles, ' +
    'authors, journals, and dates, or efetch them for full records. Read-only, keyless — no ' +
    'credentials required. Response format is per-endpoint: esearch and esummary return JSON ' +
    '(retmode=json); efetch returns XML (retmode=xml, the agent parses it).',
  tags: ['research', 'medical', 'biomedical', 'literature', 'pubmed', 'ncbi'],
  vendor: 'NCBI (U.S. National Library of Medicine)',
  category: 'research',
  honestyLabel: 'curated',
  authKind: 'none',
  definition: {
    apiId: 'pubmed',
    name: 'PubMed',
    description:
      'PubMed NCBI Entrez E-utilities — esearch (PMIDs) → esummary (summaries) / efetch (records).',
    baseUrl: 'https://eutils.ncbi.nlm.nih.gov',
    version: '1',
    callMode: 'endpoint',
    defaultHeaders: { Accept: 'application/json' },
    suggestedEgressPolicy: { allowedMethods: ['GET'] },
    tags: ['research', 'pubmed'],
    endpoints: [
      {
        endpointId: 'esearch',
        name: 'Search (get PMIDs)',
        description:
          'Step 1 of the search flow. Search PubMed for a term and get back the matching PubMed ' +
          'ids (PMIDs) under esearchresult.idlist[]. Feed those ids into esummary or efetch. ' +
          'Response is JSON (retmode=json).',
        method: 'GET',
        pathTemplate: '/entrez/eutils/esearch.fcgi',
        params: [
          dbParam,
          {
            name: 'term',
            location: 'query',
            required: true,
            description:
              'The search query. Supports PubMed field tags and boolean logic, e.g. ' +
              '"crispr AND (2023[pdat]) AND review[pt]".',
            schema: { type: 'string' },
          },
          {
            name: 'retmode',
            location: 'query',
            required: true,
            description: 'Response format. Use "json" so the PMID list is JSON.',
            schema: { type: 'string', enum: ['json'] },
          },
          {
            name: 'retmax',
            location: 'query',
            required: false,
            description: 'Maximum number of PMIDs to return (default 20, max 10000).',
            schema: { type: 'integer', minimum: 1, maximum: 10000 },
          },
          {
            name: 'retstart',
            location: 'query',
            required: false,
            description: 'Zero-based offset into the result set (for paging).',
            schema: { type: 'integer', minimum: 0 },
          },
          {
            name: 'sort',
            location: 'query',
            required: false,
            description: 'Sort order, e.g. "relevance" or "pub_date".',
            schema: { type: 'string' },
          },
        ],
        pagination: { style: 'offset', cursorParam: 'retstart', limitParam: 'retmax' },
        tags: ['search'],
      },
      {
        endpointId: 'esummary',
        name: 'Summaries for PMIDs',
        description:
          'Step 2 of the search flow. Fetch document summaries (title, authors, journal source, ' +
          'publication date, doi) for one or more PMIDs from esearch. Summaries are keyed by ' +
          'PMID under result[pmid]. Response is JSON (retmode=json).',
        method: 'GET',
        pathTemplate: '/entrez/eutils/esummary.fcgi',
        params: [
          dbParam,
          {
            name: 'id',
            location: 'query',
            required: true,
            description:
              'Comma-separated PubMed ids (PMIDs) to summarize, e.g. "39000000,38000000".',
            schema: { type: 'string' },
          },
          {
            name: 'retmode',
            location: 'query',
            required: true,
            description: 'Response format. Use "json" so the summaries are JSON.',
            schema: { type: 'string', enum: ['json'] },
          },
        ],
        tags: ['read'],
      },
      {
        endpointId: 'efetch',
        name: 'Full records for PMIDs',
        description:
          'Fetch full PubMed records (including abstracts and MeSH terms) for one or more PMIDs. ' +
          'The response is XML (retmode=xml), NOT JSON — the agent parses the XML. Use esummary ' +
          'instead when a lightweight JSON summary is enough.',
        method: 'GET',
        pathTemplate: '/entrez/eutils/efetch.fcgi',
        params: [
          dbParam,
          {
            name: 'id',
            location: 'query',
            required: true,
            description: 'Comma-separated PubMed ids (PMIDs) to fetch, e.g. "39000000,38000000".',
            schema: { type: 'string' },
          },
          {
            name: 'retmode',
            location: 'query',
            required: true,
            description: 'Response format. Use "xml" for full records (the response is XML).',
            schema: { type: 'string', enum: ['xml'] },
          },
          {
            name: 'rettype',
            location: 'query',
            required: false,
            description: 'Record type, e.g. "abstract" for abstract-only records.',
            schema: { type: 'string' },
          },
        ],
        tags: ['read', 'xml'],
      },
    ],
  },
};
