/**
 * Search step operation schemas.
 *
 * Web search and page fetch operations.
 */
import { z } from 'zod';

// ============================================================================
// search.web.search — Web Search
// ============================================================================

export const SearchWebInputSchema = z.object({
  /** Search query */
  query: z.string().min(1).max(2000),
  /** Maximum results to return */
  maxResults: z.number().int().positive().max(100).default(10),
  /** Search region/country */
  region: z.string().max(10).optional(),
  /** Search language */
  language: z.string().max(10).optional(),
  /** Time range filter */
  timeRange: z.enum(['day', 'week', 'month', 'year', 'all']).optional(),
  /** Safe search mode */
  safeSearch: z.enum(['off', 'moderate', 'strict']).default('moderate'),
  /** Include images in results */
  includeImages: z.boolean().default(false),
  /** Include news results */
  includeNews: z.boolean().default(false),
  /** Fetch and include page snippets/summaries */
  fetchSnippets: z.boolean().default(true),
});
export type SearchWebInput = z.infer<typeof SearchWebInputSchema>;

export const SearchResultSchema = z.object({
  /** Result title */
  title: z.string(),
  /** Result URL */
  url: z.string().url(),
  /** Snippet/description */
  snippet: z.string().optional(),
  /** Display URL (may differ from actual URL) */
  displayUrl: z.string().optional(),
  /** Source domain */
  domain: z.string().optional(),
  /** Publication/crawl date */
  date: z.string().optional(),
  /** Thumbnail URL */
  thumbnail: z.string().url().optional(),
  /** Relevance score (provider-specific) */
  score: z.number().optional(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const SearchWebOutputSchema = z.object({
  /** Search results */
  results: z.array(SearchResultSchema),
  /** Total results available */
  totalResults: z.number().int().nonnegative().optional(),
  /** Query that was actually executed (may differ from input) */
  executedQuery: z.string(),
  /** Provider used */
  provider: z.string(),
  /** Search duration in milliseconds */
  durationMs: z.number().int().nonnegative(),
  /** Whether results were cached */
  cached: z.boolean().optional(),
});
export type SearchWebOutput = z.infer<typeof SearchWebOutputSchema>;

// ============================================================================
// search.web.fetch — Fetch Web Page Content
// ============================================================================

export const SearchWebFetchInputSchema = z.object({
  /** URL to fetch */
  url: z.string().url().max(4096),
  /** Output format */
  format: z.enum(['markdown', 'text']).default('markdown'),
  /** Maximum content length in characters (truncates to save tokens) */
  maxContentLength: z.number().int().positive().max(500_000).default(50_000),
  /** Include images as markdown references */
  includeImages: z.boolean().default(false),
  /** Include a list of links found on the page */
  includeLinks: z.boolean().default(false),
  /** Take a screenshot of the rendered page (returns a URL) */
  screenshot: z.boolean().default(false),
  /** Timeout in milliseconds */
  timeoutMs: z.number().int().positive().max(60_000).default(30_000),
});
export type SearchWebFetchInput = z.infer<typeof SearchWebFetchInputSchema>;

const FetchLinkSchema = z.object({
  /** Link text */
  text: z.string(),
  /** Link URL */
  url: z.string().url(),
});

export const SearchWebFetchOutputSchema = z.object({
  /** Extracted page content (markdown or plain text) */
  content: z.string(),
  /** Page title */
  title: z.string().optional(),
  /** Meta description */
  description: z.string().optional(),
  /** Canonical URL (may differ from input after redirects) */
  url: z.string().url(),
  /** Site name (e.g., "Wikipedia", "arXiv") */
  siteName: z.string().optional(),
  /** Publication date (if detectable) */
  publishedDate: z.string().optional(),
  /** Word count of extracted content */
  wordCount: z.number().int().nonnegative(),
  /** Whether content was truncated to maxContentLength */
  truncated: z.boolean(),
  /** Screenshot URL (if screenshot=true was requested) */
  screenshotUrl: z.string().url().optional(),
  /** Links found on the page (if includeLinks=true) */
  links: z.array(FetchLinkSchema).optional(),
  /** Provider used */
  provider: z.string(),
  /** Fetch duration in milliseconds */
  durationMs: z.number().int().nonnegative(),
});
export type SearchWebFetchOutput = z.infer<typeof SearchWebFetchOutputSchema>;

// ============================================================================
// search.web.download — Fetch Web Page to Memory
// ============================================================================

export const SearchWebDownloadInputSchema = z.object({
  /** URL to fetch */
  url: z.string().url().max(4096),
  /** Output format for the saved document */
  format: z.enum(['markdown', 'text']).default('markdown'),
  /** Include images as markdown references */
  includeImages: z.boolean().default(false),
  /** Timeout in milliseconds */
  timeoutMs: z.number().int().positive().max(60_000).default(30_000),
  toMemoryPath: z
    .string()
    .min(1)
    .max(1024)
    .refine((p) => !p.startsWith('/run/'), {
      message:
        'Cannot save to virtual /run/ paths — use a persistent path like /workspace/refs/spec.md',
    })
    .describe(
      'Memory path to write the FULL extracted content to, e.g. "/workspace/refs/spec.md" (the ' +
        '/workspace/ prefix is stripped to the underlying Memory path). A page too large to save ' +
        'completely fails instead of saving a partial copy. Read it back with memory.store.get, ' +
        'or mount it into a sandbox via the compute workspace inputs.',
    ),
  indexing: z
    .enum(['auto', 'disabled', 'force'])
    .default('disabled')
    .describe(
      'Memory indexing for the saved doc. Keep "disabled" (the default) for raw reference ' +
        'material; set "auto" only for a document you want semantically searchable.',
    ),
});
export type SearchWebDownloadInput = z.infer<typeof SearchWebDownloadInputSchema>;

export const SearchWebDownloadOutputSchema = z.object({
  savedTo: z
    .string()
    .describe(
      'Memory path the FULL extracted content was written to. The content is NOT returned ' +
        'inline — read it with memory.store.get, or mount it into a sandbox via the compute ' +
        'workspace inputs.',
    ),
  /** Byte size of the saved content */
  sizeBytes: z.number().int().nonnegative(),
  /** Canonical URL (may differ from input after redirects) */
  url: z.string().url(),
  /** Page title */
  title: z.string().optional(),
  /** Meta description */
  description: z.string().optional(),
  /** Site name (e.g., "Wikipedia", "arXiv") */
  siteName: z.string().optional(),
  /** Publication date (if detectable) */
  publishedDate: z.string().optional(),
  /** Word count of the saved content */
  wordCount: z.number().int().nonnegative(),
  /** Provider used */
  provider: z.string(),
  /** Fetch duration in milliseconds */
  durationMs: z.number().int().nonnegative(),
});
export type SearchWebDownloadOutput = z.infer<typeof SearchWebDownloadOutputSchema>;

// ============================================================================

import type { OperationRegistration } from '../catalog/operationCatalog.js';

export const SearchOperationRegistrations: OperationRegistration[] = [
  {
    stepType: 'search',
    group: 'web',
    verb: 'search',
    name: 'Web Search',
    actionLabel: 'Searching the web…',
    semanticDescription:
      'Search the web for real-time information. Returns a list of web pages ' +
      'with titles, URLs, and text snippets. Use for current events, fact-checking, ' +
      'research, finding documentation, or discovering web pages. Results are ' +
      'ranked by relevance. Set timeRange to filter by recency (e.g., "week" for ' +
      'recent news). For searching stored documents, use memory.store.query. ' +
      'For reading the full content of a result, use search.web.fetch.',
    tags: ['search', 'web', 'information'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'Search the web for real-time information.',
      whenToUse: [
        'Gathering real-time information from the internet',
        'Fact-checking claims or finding recent data',
        'Researching topics, finding documentation, or discovering web pages',
      ],
      whenNotToUse: [
        'Searching memory or stored documents — use memory.store.query instead',
        'Reading the full content of a known URL — use search.web.fetch instead',
      ],
      pitfalls: [
        'Keep queries concise and specific — 3-10 words works best',
        'Use timeRange="week" or "month" when freshness matters',
        'Default maxResults=10 is usually sufficient; increase only if you need broad coverage',
        'Results include snippets only — use search.web.fetch to read the full content of specific results',
      ],
      minimalExampleInput: {
        query: 'latest transformer architecture papers 2026',
      },
    },
    accessMode: 'read',
    riskModifiers: ['external_side_effect'],
    inputZod: SearchWebInputSchema,
    outputZod: SearchWebOutputSchema,
  },
  {
    stepType: 'search',
    group: 'web',
    verb: 'fetch',
    name: 'Fetch Web Page',
    actionLabel: 'Fetching page…',
    semanticDescription:
      'Fetch the readable content of a web page as clean markdown or plain text. ' +
      'Strips ads, navigation, and boilerplate — returns just the article content. ' +
      'Handles JavaScript-rendered pages. Use after search.web.search to read ' +
      'specific results in full, or to extract content from a known URL. ' +
      'Set includeImages=true to preserve image references in the output. ' +
      'Set maxContentLength to limit output size for token budgets. ' +
      'For searching the web, use search.web.search first. For calling APIs ' +
      'with authentication, use api.http.call.',
    tags: ['search', 'web', 'fetch', 'scrape', 'reader'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'Fetch the readable content of a web page as clean markdown.',
      whenToUse: [
        'Reading the full content of a page found via search.web.search',
        'Extracting article text, documentation, or blog post content from a URL',
        'Getting structured content from a known web page for analysis',
      ],
      whenNotToUse: [
        'Finding web pages — use search.web.search first, then fetch specific results',
        'Capturing a LARGE document (spec, paper, long reference page) completely — use search.web.download',
        'Calling authenticated APIs — use api.http.call instead (or api.http.download for files)',
        'Downloading binary files — use api.http.download through a bound API',
      ],
      pitfalls: [
        'Some pages block automated access — the operation may return partial or empty content',
        '`content` is ALWAYS truncated to maxContentLength (default 50000 chars ~12K tokens). ' +
          'Re-fetching with a bigger limit is the wrong move for a large document — use ' +
          'search.web.download once and read the full saved copy from Memory.',
        'Set includeImages=true only when you need visual content — increases payload size',
        'JavaScript-heavy SPAs may take longer — allow up to 30s timeout',
      ],
      minimalExampleInput: {
        url: 'https://en.wikipedia.org/wiki/Transformer_(deep_learning_architecture)',
      },
    },
    accessMode: 'read',
    riskModifiers: ['external_side_effect'],
    inputZod: SearchWebFetchInputSchema,
    outputZod: SearchWebFetchOutputSchema,
  },
  {
    stepType: 'search',
    group: 'web',
    verb: 'download',
    name: 'Fetch Page to Memory',
    actionLabel: 'Saving page to memory…',
    semanticDescription:
      'Fetch a web page and write its FULL extracted content (clean markdown or plain text) to ' +
      'a memory path — it is never returned inline. For a document too large to read into ' +
      'context (an OpenAPI spec, a paper, a long reference page), this saves the complete ' +
      'extraction so a later step can read it back (memory.store.get) or grep/parse it in a ' +
      'sandbox via the compute workspace inputs. A page too large to extract completely fails ' +
      'instead of saving a partial copy. For reading a page inline, use search.web.fetch.',
    tags: ['search', 'web', 'fetch', 'download', 'reader'],
    idempotency: 'idempotent',
    mutates: true,
    usage: {
      oneLine:
        'Fetch a web page and save its full extracted content to a memory path (never inline).',
      whenToUse: [
        'Capturing a LARGE document (spec, paper, long reference page) COMPLETELY for later steps',
        'Saving reference material a sandbox step will grep/parse via the compute workspace inputs',
      ],
      whenNotToUse: [
        'Reading a page inline in this turn — use search.web.fetch',
        'Downloading binary files or authenticated resources — use api.http.download through a bound API',
      ],
      pitfalls: [
        'The content is NOT returned inline — read it back with memory.store.get if you need to inspect it.',
        'Keep indexing:"disabled" (the default) for raw reference material; only set "auto" for a document you want semantically searchable.',
        'A page too large to extract completely FAILS rather than saving a partial copy — fetch a more specific page or section instead.',
      ],
      minimalExampleInput: {
        url: 'https://openapi.vercel.sh/',
        toMemoryPath: '/workspace/refs/vercel-openapi.json',
      },
    },
    accessMode: 'write',
    riskModifiers: ['external_side_effect'],
    inputZod: SearchWebDownloadInputSchema,
    outputZod: SearchWebDownloadOutputSchema,
  },
];
