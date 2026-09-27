/**
 * arXiv Atom feed → compact typed paper records (`arxiv_atom_papers` preset).
 *
 * Parsed with fast-xml-parser, which performs no external entity resolution,
 * so untrusted feed content cannot trigger XXE-style fetches. Tag values stay
 * strings (`parseTagValue: false`) — numeric-looking titles must not coerce —
 * and OpenSearch counters are converted explicitly.
 */
import { XMLParser, XMLValidator } from 'fast-xml-parser';

export interface ArxivPaper {
  arxivId: string;
  title: string;
  authors: string[];
  abstract: string;
  published?: string;
  updated?: string;
  categories: string[];
  abstractUrl: string;
  pdfUrl?: string;
  doi?: string;
}

export interface ArxivAtomPapers {
  totalResults?: number;
  startIndex?: number;
  itemsPerPage?: number;
  papers: ArxivPaper[];
}

const ARRAY_TAGS = new Set(['entry', 'author', 'category', 'link']);

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A tag parsed with attributes may be a plain string or `{ '#text': ... }`. */
function tagText(value: unknown): string | undefined {
  if (typeof value === 'string') return value !== '' ? value : undefined;
  const record = asRecord(value);
  return record !== undefined ? asString(record['#text']) : undefined;
}

function asInteger(value: unknown): number | undefined {
  const text = tagText(value);
  if (text === undefined) return undefined;
  const parsed = Number(text);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function parseAuthors(entry: Record<string, unknown>): string[] {
  const authors: string[] = [];
  for (const author of toArray(entry['author'])) {
    const name = asRecord(author) !== undefined ? tagText(asRecord(author)!['name']) : undefined;
    if (name !== undefined) authors.push(collapseWhitespace(name));
  }
  return authors;
}

function parseCategories(entry: Record<string, unknown>): string[] {
  const categories: string[] = [];
  for (const category of toArray(entry['category'])) {
    const term =
      asRecord(category) !== undefined ? asString(asRecord(category)!['@_term']) : undefined;
    if (term !== undefined && !categories.includes(term)) categories.push(term);
  }
  const primary = asRecord(entry['primary_category']);
  const primaryTerm = primary !== undefined ? asString(primary['@_term']) : undefined;
  if (primaryTerm !== undefined && !categories.includes(primaryTerm)) {
    categories.unshift(primaryTerm);
  }
  return categories;
}

function parseLinks(entry: Record<string, unknown>): { abstractUrl?: string; pdfUrl?: string } {
  let abstractUrl: string | undefined;
  let pdfUrl: string | undefined;
  for (const link of toArray(entry['link'])) {
    const record = asRecord(link);
    if (record === undefined) continue;
    const href = asString(record['@_href']);
    if (href === undefined) continue;
    if (record['@_rel'] === 'alternate' && abstractUrl === undefined) {
      abstractUrl = href;
    } else if (
      (record['@_title'] === 'pdf' || record['@_type'] === 'application/pdf') &&
      pdfUrl === undefined
    ) {
      pdfUrl = href;
    }
  }
  return {
    ...(abstractUrl !== undefined ? { abstractUrl } : {}),
    ...(pdfUrl !== undefined ? { pdfUrl } : {}),
  };
}

function parseEntry(value: unknown): ArxivPaper | undefined {
  const entry = asRecord(value);
  if (entry === undefined) return undefined;

  const id = tagText(entry['id']);
  const title = tagText(entry['title']);
  const abstract = tagText(entry['summary']);
  if (id === undefined || title === undefined) return undefined;

  const arxivId = id.replace(/^https?:\/\/arxiv\.org\/abs\//, '');
  const links = parseLinks(entry);
  const published = tagText(entry['published']);
  const updated = tagText(entry['updated']);
  const doi = tagText(entry['doi']);

  return {
    arxivId,
    title: collapseWhitespace(title),
    authors: parseAuthors(entry),
    abstract: abstract !== undefined ? collapseWhitespace(abstract) : '',
    ...(published !== undefined ? { published } : {}),
    ...(updated !== undefined ? { updated } : {}),
    categories: parseCategories(entry),
    abstractUrl: links.abstractUrl ?? id,
    ...(links.pdfUrl !== undefined ? { pdfUrl: links.pdfUrl } : {}),
    ...(doi !== undefined ? { doi } : {}),
  };
}

/** Throws on malformed XML or a non-Atom root — the caller owns the fail-loud error envelope. */
export function parseArxivAtomFeed(xml: string): ArxivAtomPapers {
  // Atom feeds never carry a DOCTYPE; rejecting one up front closes the
  // entity-amplification (billion-laughs) hole while keeping the predefined
  // entities (&amp; &lt; …) that real feeds use.
  if (/<!DOCTYPE/i.test(xml)) {
    throw new Error('DOCTYPE declarations are not accepted in Atom feeds');
  }
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new Error(`invalid XML at line ${String(validation.err.line)}: ${validation.err.msg}`);
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    parseTagValue: false,
    parseAttributeValue: false,
    isArray: (name) => ARRAY_TAGS.has(name),
  });
  const document: unknown = parser.parse(xml);
  const feed = asRecord(asRecord(document)?.['feed']);
  if (feed === undefined) {
    throw new Error('document has no Atom <feed> root');
  }

  const papers: ArxivPaper[] = [];
  for (const entry of toArray(feed['entry'])) {
    const paper = parseEntry(entry);
    if (paper !== undefined) papers.push(paper);
  }

  const totalResults = asInteger(feed['totalResults']);
  const startIndex = asInteger(feed['startIndex']);
  const itemsPerPage = asInteger(feed['itemsPerPage']);

  return {
    ...(totalResults !== undefined ? { totalResults } : {}),
    ...(startIndex !== undefined ? { startIndex } : {}),
    ...(itemsPerPage !== undefined ? { itemsPerPage } : {}),
    papers,
  };
}
