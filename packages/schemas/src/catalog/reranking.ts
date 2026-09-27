// ============================================================================
// Common Operation Verbs
// ============================================================================

/**
 * Verbs that appear in many operation IDs (e.g., `memory.store.list`, `api.definition.get`).
 * These still participate in normal BM25 scoring (their low IDF naturally penalizes them),
 * but are excluded from the segment-coverage boost to prevent noise.
 */
export const COMMON_OP_VERBS = new Set([
  'list',
  'get',
  'create',
  'put',
  'delete',
  'update',
  'search',
  'read',
  'run',
  'turn',
  'exec',
  'call',
  'set',
  // Structural tokens that appear in many operation IDs but carry no intent.
  // "api" in a query means "I want to call an API", not "show me api.definition.*".
  'api',
  'manage',
  'store',
]);

// ============================================================================
// Segment Coverage Scoring
// ============================================================================

export interface SegmentCoverageResult {
  /** Multiplicative rerank factor to apply to BM25 score */
  boost: number;
  /** Count of non-common-verb query tokens that matched segments */
  rareMatches: number;
  /** Whether a common verb token also matched a segment */
  verbMatch: boolean;
}

/**
 * Compute a proportional segment-coverage boost for an identifier (operation ID,
 * API endpoint ID, etc.) against query tokens.
 *
 * The boost rewards documents where multiple *rare* (non-verb) query tokens match
 * segments of the identifier, and gives a mild bonus for verb matches.
 *
 * Cap: max 4x (rare) * 1.3 (verb) = 5.2x
 *
 * @param queryTokens - Tokenized search query (after stopword removal)
 * @param segments - Tokenized identifier segments (split on . _ -)
 */
export function computeSegmentCoverage(
  queryTokens: string[],
  segments: string[],
): SegmentCoverageResult {
  const boostable = queryTokens.filter((t) => !COMMON_OP_VERBS.has(t));
  let rareMatches = 0;
  for (const t of boostable) {
    if (segments.includes(t)) rareMatches++;
  }

  let verbMatch = false;
  for (const t of queryTokens) {
    if (COMMON_OP_VERBS.has(t) && segments.includes(t)) {
      verbMatch = true;
      break;
    }
  }

  // Coverage-proportional boost, capped at 4x for rare matches + 1.3x for verb
  const coverage = boostable.length > 0 ? rareMatches / boostable.length : 0;
  const rareFactor = 1 + Math.min(coverage * 3.0, 3.0); // max 4x
  const verbFactor = verbMatch ? 1.3 : 1.0;

  return { boost: rareFactor * verbFactor, rareMatches, verbMatch };
}

/**
 * Tokenize an identifier (operation ID, API endpoint ID, API name) into segments.
 * Splits on `.`, `_`, and `-`, lowercases, filters short tokens.
 */
export function tokenizeIdentifier(id: string): string[] {
  return id
    .toLowerCase()
    .split(/[._-]+/)
    .filter((t) => t.length > 1);
}
