import type { OperationDescriptor } from './operationCatalog.js';
import { getAllOperations } from './registry.js';
import { toJsonSchemaSync } from '../utils/jsonSchema.js';
import { COMMON_OP_VERBS, computeSegmentCoverage, tokenizeIdentifier } from './reranking.js';
import { QUERY_STOPWORDS, scoreFieldWeightedBM25, tokenize, tokenizeQuery } from './bm25.js';

// ============================================================================
// Field weights
// ============================================================================

/** Field weights for BM25 scoring */
const FIELD_WEIGHTS: Record<string, number> = {
  operationId: 2.0,
  semanticDescription: 1.5,
  whenToUse: 1.5,
  exampleInputKeys: 1.0,
  inputSchemaKeys: 0.8,
  entityType: 1.0,
};

// ============================================================================
// Tokenization
// ============================================================================

/** Tokenize an operationId: memory.store.put → ["memory", "store", "put"], kaggle.list_competitions → ["kaggle", "list", "competitions"] */
function tokenizeOperationId(opId: string): string[] {
  return opId
    .toLowerCase()
    .split(/[._-]+/)
    .filter((t) => t.length > 1);
}

// ============================================================================
// BM25 Index
// ============================================================================

interface IndexedDocument {
  operationId: string;
  fields: Record<string, string[]>; // field name → tokens
  totalTokens: number;
}

interface BM25Index {
  documents: IndexedDocument[];
  /** term → document indices where it appears */
  invertedIndex: Map<string, Set<number>>;
  /** Average document length across all docs */
  avgDocLength: number;
  /** Total number of documents */
  docCount: number;
}

let _cachedIndex: BM25Index | null = null;

function buildIndex(): BM25Index {
  if (_cachedIndex) return _cachedIndex;

  const allOps = getAllOperations();
  const documents: IndexedDocument[] = [];
  const invertedIndex = new Map<string, Set<number>>();

  for (const op of allOps.values()) {
    // Skip internal ops and non-agent-tool ops
    if (op.internal) continue;
    if (!op.agentTool) continue;

    const fields: Record<string, string[]> = {};

    // operationId tokens
    fields['operationId'] = tokenizeOperationId(op.operationId);

    // semanticDescription
    fields['semanticDescription'] = tokenize(op.semanticDescription);

    // whenToUse (positive signal)
    if (op.usage.whenToUse.length > 0) {
      fields['whenToUse'] = tokenize(op.usage.whenToUse.join(' '));
    }

    // Example input property names (skip empty objects — still truthy in JS)
    const minimalExample = op.usage.minimalExampleInput;
    if (Object.keys(minimalExample).length > 0) {
      fields['exampleInputKeys'] = tokenize(Object.keys(minimalExample).join(' '));
    }

    // Input schema property names and descriptions
    try {
      const schema = toJsonSchemaSync(op.inputZod);
      const props = (schema as Record<string, unknown>)['properties'] as
        Record<string, { description?: string }> | undefined;
      if (props) {
        const parts: string[] = [];
        for (const [key, val] of Object.entries(props)) {
          parts.push(key);
          if (val.description) parts.push(val.description);
        }
        fields['inputSchemaKeys'] = tokenize(parts.join(' '));
      }
    } catch {
      // skip schema extraction errors
    }

    // CRUD entity type
    if (op.crudView?.entityType) {
      fields['entityType'] = tokenize(op.crudView.entityType);
    }

    // NOTE: whenNotToUse and pitfalls are EXCLUDED from the index
    // (they would cause false matches: "don't use X for Y" matches query "Y")

    let totalTokens = 0;
    for (const tokens of Object.values(fields)) {
      totalTokens += tokens.length;
    }

    const docIdx = documents.length;
    documents.push({ operationId: op.operationId, fields, totalTokens });

    // Build inverted index
    for (const tokens of Object.values(fields)) {
      for (const token of tokens) {
        let docSet = invertedIndex.get(token);
        if (!docSet) {
          docSet = new Set();
          invertedIndex.set(token, docSet);
        }
        docSet.add(docIdx);
      }
    }
  }

  const totalLength = documents.reduce((sum, d) => sum + d.totalTokens, 0);
  const avgDocLength = documents.length > 0 ? totalLength / documents.length : 1;

  _cachedIndex = {
    documents,
    invertedIndex,
    avgDocLength,
    docCount: documents.length,
  };
  return _cachedIndex;
}

// ============================================================================
// BM25 Search
// ============================================================================

interface SearchResult {
  operationId: string;
  score: number;
  matchReason: string;
}

/**
 * Compute BM25 score for a single document against query tokens.
 */
function scoreBM25(
  doc: IndexedDocument,
  queryTokens: string[],
  index: BM25Index,
): { score: number; matchedFields: Set<string> } {
  return scoreFieldWeightedBM25(
    doc,
    queryTokens,
    {
      docCount: index.docCount,
      avgDocLength: index.avgDocLength,
      documentFrequency: (term) => index.invertedIndex.get(term)?.size ?? 0,
    },
    FIELD_WEIGHTS,
  );
}

/**
 * Build a human-readable match reason from matched fields.
 */
function buildMatchReason(
  op: OperationDescriptor,
  matchedFields: Set<string>,
  queryTokens: string[],
): string {
  const parts: string[] = [];

  if (matchedFields.has('operationId')) {
    // Show which query tokens actually matched the operationId segments
    const opSegments = tokenizeIdentifier(op.operationId);
    const matchedTokens = queryTokens.filter((t) => opSegments.includes(t));
    if (matchedTokens.length > 0) {
      parts.push(`ID matches: ${matchedTokens.join(', ')}`);
    } else {
      parts.push('partial ID match');
    }
  }
  if (matchedFields.has('semanticDescription')) {
    parts.push('matches description');
  }
  if (matchedFields.has('whenToUse')) {
    parts.push('matches use case');
  }
  if (matchedFields.has('entityType') && op.crudView?.entityType) {
    parts.push(`operates on ${op.crudView.entityType}`);
  }
  if (matchedFields.has('inputSchemaKeys')) {
    parts.push('matches input fields');
  }

  return parts.length > 0 ? parts.join('; ') : 'general match';
}

// ============================================================================
// Public API
// ============================================================================

export interface CatalogSearchInput {
  /** Structural filters */
  stepTypes?: string[];
  groupIds?: string[];
  operationIds?: string[];

  /** Intent-based search */
  query?: string;
  maxResults?: number;
}

export interface CatalogSearchResult {
  operationId: string;
  description: string;
  matchReason: string;
  caution?: string;
  /** Internal BM25 score (not exposed to agents, used for cross-source interleaving) */
  score: number;
}

/**
 * Search the operation catalog using BM25 intent search + structural filtering.
 *
 * Returns operations ranked by relevance with match reasons and cautions.
 */
export function searchCatalog(input: CatalogSearchInput): CatalogSearchResult[] {
  const maxResults = Math.min(input.maxResults ?? 5, 10);
  const allOps = getAllOperations();

  // Build structural filter sets
  const stepTypeFilter = input.stepTypes ? new Set(input.stepTypes) : undefined;
  const groupIdFilter = input.groupIds ? new Set(input.groupIds) : undefined;
  const operationIdFilter = input.operationIds ? new Set(input.operationIds) : undefined;

  // If only structural filters (no query), return filtered ops directly
  if (!input.query) {
    const results: CatalogSearchResult[] = [];
    for (const op of allOps.values()) {
      if (op.internal || !op.agentTool) continue;
      if (stepTypeFilter && !stepTypeFilter.has(op.stepType)) continue;
      if (groupIdFilter) {
        const gid = `${op.stepType}.${op.group ?? ''}`;
        if (!groupIdFilter.has(gid) && !groupIdFilter.has(op.stepType)) continue;
      }
      if (operationIdFilter && !operationIdFilter.has(op.operationId)) continue;

      results.push(buildResultEntry(op));
      if (results.length >= maxResults) break;
    }
    return results;
  }

  // BM25 intent search
  const index = buildIndex();
  const queryTokens = tokenizeQuery(input.query);
  // Also tokenize as potential operationId segments — but only if the query
  // actually contains identifier separators (. _ -). For natural language
  // queries like "list kaggle competitions", this adds nothing.
  let allQueryTokens = queryTokens;
  if (/[._-]/.test(input.query)) {
    const opIdTokens = input.query
      .toLowerCase()
      .split(/[._-]+/)
      .filter((t) => t.length > 1 && !QUERY_STOPWORDS.has(t));
    allQueryTokens = [...new Set([...queryTokens, ...opIdTokens])];
  }

  const scored: SearchResult[] = [];

  for (const [_docIdx, doc] of index.documents.entries()) {
    // Apply structural filters
    const op = allOps.get(doc.operationId);
    if (!op) continue;
    if (stepTypeFilter && !stepTypeFilter.has(op.stepType)) continue;
    if (groupIdFilter) {
      const gid = `${op.stepType}.${op.group ?? ''}`;
      if (!groupIdFilter.has(gid) && !groupIdFilter.has(op.stepType)) continue;
    }
    if (operationIdFilter && !operationIdFilter.has(op.operationId)) continue;

    const { score, matchedFields } = scoreBM25(doc, allQueryTokens, index);
    if (score <= 0) continue;

    // Post-retrieval ranking adjustments
    let adjustedScore = score;

    // Proportional segment-coverage boost (replaces old binary 2x boost)
    const opSegments = tokenizeIdentifier(doc.operationId);
    const { boost: segmentBoost, rareMatches } = computeSegmentCoverage(allQueryTokens, opSegments);
    adjustedScore *= segmentBoost;

    // If the query has rare (non-verb) tokens but NONE matched this operation's
    // ID segments, the match is driven entirely by common verbs — heavily demote.
    // This prevents "list kaggle competitions" from surfacing every .list operation
    // when "kaggle" and "competitions" don't appear anywhere in the operation.
    const boostableInQuery = allQueryTokens.filter((t) => !COMMON_OP_VERBS.has(t));
    if (boostableInQuery.length > 0 && rareMatches === 0) {
      adjustedScore *= 0.15; // 85% penalty for verb-only matches
    }

    // Demote operations with external_side_effect
    if (op.riskModifiers.includes('external_side_effect')) {
      adjustedScore *= 0.8;
    }

    // Boost idempotent operations
    if (op.idempotency === 'idempotent') {
      adjustedScore *= 1.1;
    }

    const matchReason = buildMatchReason(op, matchedFields, allQueryTokens);
    scored.push({ operationId: doc.operationId, score: adjustedScore, matchReason });
  }

  // Sort by score descending, take top maxResults
  scored.sort((a, b) => b.score - a.score);
  const topResults = scored.slice(0, maxResults);

  return topResults.map((r) => {
    const op = allOps.get(r.operationId)!;
    return {
      ...buildResultEntry(op),
      matchReason: r.matchReason,
      score: r.score,
    };
  });
}

/**
 * Build a single lean search result entry from an operation descriptor.
 * No input schemas — search is for discovery, not schema retrieval.
 * Use catalog.tool.list with operationIds for full schemas.
 */
function buildResultEntry(op: OperationDescriptor): CatalogSearchResult {
  // Build caution string
  let caution: string | undefined;
  const cautions: string[] = [];
  if (op.riskModifiers.includes('external_side_effect')) {
    cautions.push('has external side effects');
  }
  if (op.idempotency === 'non_idempotent') {
    cautions.push('not idempotent — calling twice may duplicate effects');
  }
  if (op.riskModifiers.includes('privileged')) {
    cautions.push('privileged operation');
  }
  if (cautions.length > 0) {
    caution = cautions.join('; ');
  }

  return {
    operationId: op.operationId,
    description: op.semanticDescription,
    matchReason: 'structural filter',
    score: 0,
    ...(caution ? { caution } : {}),
  };
}

/**
 * Reset the cached index (for testing or after registry changes).
 */
export function resetSearchIndex(): void {
  _cachedIndex = null;
}
