/**
 * Eval and Coach feedback doc loaders — small wrappers around the memory repo.
 * Each returns `null` (or `[]`) when the doc is missing or malformed; the
 * inspector renders empty-state UI rather than 404'ing.
 */
import type { MemoryDocRepository } from '@aflow/database';
import {
  CyberneticEvalSuiteSchema,
  EvalBaselineSchema,
  EvalResultSchema,
  CoachObservationSchema,
  type CyberneticEvalSuite,
  type EvalBaseline,
  type EvalResult,
  type CoachObservation,
} from '@aflow/schemas';

export async function loadEvalSuite(
  repo: MemoryDocRepository,
  spaceId: string,
  slug: string,
): Promise<CyberneticEvalSuite | null> {
  const doc = await repo.getByPath(`/evals/${slug}/suite.json`, spaceId);
  if (!doc || doc.deletedAt || doc.inlineContent === null) return null;
  try {
    const parsed = CyberneticEvalSuiteSchema.safeParse(JSON.parse(doc.inlineContent));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function loadEvalBaseline(
  repo: MemoryDocRepository,
  spaceId: string,
  slug: string,
): Promise<EvalBaseline | null> {
  const doc = await repo.getByPath(`/evals/${slug}/baseline.json`, spaceId);
  if (!doc || doc.deletedAt || doc.inlineContent === null) return null;
  try {
    const parsed = EvalBaselineSchema.safeParse(JSON.parse(doc.inlineContent));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Hard cap on raw doc reads, regardless of `limit`. Result paths use a runId
 * UUID so the repo's alphabetical ordering is unrelated to recency — we
 * fetch a wider window, parse, sort by `evaluatedAt`, then slice. Retention
 * keeps the eval result set bounded so this stays cheap.
 */
const MAX_RESULTS_SCAN = 200;

export async function loadRecentEvalResults(
  repo: MemoryDocRepository,
  spaceId: string,
  slug: string,
  limit: number,
): Promise<EvalResult[]> {
  const summaries = await repo.list({
    pathPrefix: `/evals/${slug}/results/`,
    scope: { spaceId },
    limit: MAX_RESULTS_SCAN,
  });

  const parsed: EvalResult[] = [];
  for (const s of summaries) {
    const doc = await repo.getById(s.id, spaceId);
    if (!doc || doc.deletedAt || doc.inlineContent === null) continue;
    try {
      const result = EvalResultSchema.safeParse(JSON.parse(doc.inlineContent));
      if (result.success) parsed.push(result.data);
    } catch {
      // skip malformed result
    }
  }

  parsed.sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt));
  return parsed.slice(0, limit);
}

/**
 * Coach observation docs (`/coach/observations/<uuid>.json`) are
 * stored at UUID paths, so `repo.list` orders them alphabetically
 * by UUID rather than by `createdAt`. The skill association lives
 * inside the doc, so we have to fetch + parse before we know
 * whether to keep a doc. A single capped call would silently drop
 * the skill's most recent feedback whenever its docs sort after
 * the cap.
 *
 * Pagination strategy: keep pulling pages of `SCAN_PAGE_SIZE` (path
 * cursor) until either we exhaust the prefix or hit a hard
 * `MAX_SCANNED` cap (defense-in-depth against runaway loops on
 * spaces with very large Coach histories). Parse every doc and run
 * the caller's matcher; sort matches by `createdAt` at the end and
 * slice to the requested limit.
 */
const COACH_FEEDBACK_SCAN_PAGE_SIZE = 200;
const COACH_FEEDBACK_MAX_SCANNED = 5000;

async function scanCoachFeedbackPrefix<T>(
  repo: MemoryDocRepository,
  spaceId: string,
  pathPrefix: string,
  parse: (content: string) => T | null,
  matches: (parsed: T) => boolean,
  createdAtOf: (parsed: T) => string,
  limit: number,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined = undefined;
  let scanned = 0;
  while (scanned < COACH_FEEDBACK_MAX_SCANNED) {
    const page: Awaited<ReturnType<typeof repo.list>> = await repo.list({
      pathPrefix,
      scope: { spaceId },
      limit: COACH_FEEDBACK_SCAN_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    if (page.length === 0) break;
    scanned += page.length;
    for (const s of page) {
      const doc = await repo.getById(s.id, spaceId);
      if (!doc || doc.deletedAt || doc.inlineContent === null) continue;
      try {
        const parsed = parse(doc.inlineContent);
        if (parsed && matches(parsed)) out.push(parsed);
      } catch {
        // skip malformed doc
      }
    }
    cursor = page[page.length - 1]?.path;
    if (page.length < COACH_FEEDBACK_SCAN_PAGE_SIZE) break;
  }
  out.sort((a, b) => createdAtOf(b).localeCompare(createdAtOf(a)));
  return out.slice(0, limit);
}

export async function loadRecentObservations(
  repo: MemoryDocRepository,
  spaceId: string,
  slug: string,
  limit: number,
): Promise<CoachObservation[]> {
  return scanCoachFeedbackPrefix<CoachObservation>(
    repo,
    spaceId,
    '/coach/observations/',
    (content) => {
      const r = CoachObservationSchema.safeParse(JSON.parse(content));
      return r.success ? r.data : null;
    },
    (o) => o.workflowSlug === slug,
    (o) => o.createdAt,
    limit,
  );
}
