import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, sql, and, isNull, gt, inArray } from 'drizzle-orm';
import type { TenantId, TaskContextSpec, TaskCapabilityGrant } from '@aflow/schemas';
import { createTenantContext, withTenantSchema, memoryDocs } from '@aflow/database';
import { getCyberneticLogger } from './logger.js';
import { selectActiveLearningSetForRun } from './activeLearningSet.js';
import { renderActiveLearningEntry, type InjectedLearning } from './learningRender.js';

// ============================================================================
// Types
// ============================================================================

export interface AssembledContext {
  /** Memory documents loaded for this task. */
  memoryContent: Array<{ path: string; content: string; preview?: string }>;
  /** Tool IDs the Runner should have access to (merged from tools + capabilities.operations). */
  tools: string[];
  /**
   * Structured capability grants (104n). Present when the task context spec
   * declares `capabilities`. Used by the Runner catalog builder to promote
   * API endpoints and MCP tools as native callable tools.
   */
  capabilityGrants?: TaskCapabilityGrant;
  /** Learnings to inject into Runner context. */
  learnings: InjectedLearning[];
  /** Strategy used. */
  strategy: 'static' | 'scoped' | 'curated';
}

// ============================================================================
// Internal helpers
// ============================================================================

interface MemoryDocResult {
  path: string;
  inlineContent: string | null;
  preview: string | null;
}

/**
 * Load memory documents by exact paths.
 */
async function loadDocsByPaths(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  paths: string[],
): Promise<MemoryDocResult[]> {
  if (paths.length === 0) return [];

  const tenantContext = createTenantContext(tenantId as TenantId);

  return withTenantSchema(db, tenantContext, async (tx) =>
    tx
      .select({
        path: memoryDocs.path,
        inlineContent: memoryDocs.inlineContent,
        preview: memoryDocs.preview,
      })
      .from(memoryDocs)
      .where(
        and(
          eq(memoryDocs.spaceId, spaceId),
          inArray(memoryDocs.path, paths),
          isNull(memoryDocs.deletedAt),
        ),
      )
      .limit(50),
  );
}

/**
 * Parse a recency string (e.g., '7d', '1h', '30m') into a Date threshold.
 */
function parseRecencyThreshold(recency: string): Date | undefined {
  const match = /^(\d+)([dhm])$/.exec(recency);
  if (!match?.[1] || !match[2]) return undefined;

  const value = parseInt(match[1], 10);
  const unit = match[2];
  const now = Date.now();

  switch (unit) {
    case 'd':
      return new Date(now - value * 24 * 60 * 60 * 1000);
    case 'h':
      return new Date(now - value * 60 * 60 * 1000);
    case 'm':
      return new Date(now - value * 60 * 1000);
    default:
      return undefined;
  }
}

/**
 * Execute a scoped search query against memory docs.
 */
async function executeSearch(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  search: {
    pathPrefix?: string;
    tags?: string[];
    recency?: string;
    limit: number;
    mode: 'list' | 'search';
    query?: string;
  },
): Promise<MemoryDocResult[]> {
  const tenantContext = createTenantContext(tenantId as TenantId);

  return withTenantSchema(db, tenantContext, async (tx) => {
    const conditions = [eq(memoryDocs.spaceId, spaceId), isNull(memoryDocs.deletedAt)];

    if (search.pathPrefix) {
      conditions.push(sql`${memoryDocs.path} LIKE ${search.pathPrefix + '%'}`);
    }

    if (search.tags && search.tags.length > 0) {
      // Match any of the provided tags using JSONB containment
      conditions.push(
        sql`${memoryDocs.tags} ?| array[${sql.join(
          search.tags.map((t) => sql`${t}`),
          sql`, `,
        )}]`,
      );
    }

    if (search.recency) {
      const threshold = parseRecencyThreshold(search.recency);
      if (threshold) {
        conditions.push(gt(memoryDocs.updatedAt, threshold));
      }
    }

    return tx
      .select({
        path: memoryDocs.path,
        inlineContent: memoryDocs.inlineContent,
        preview: memoryDocs.preview,
      })
      .from(memoryDocs)
      .where(and(...conditions))
      .limit(search.limit);
  });
}

async function loadLearnings(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  workflowSlug: string,
  learningsMode: 'none' | 'active',
  runId?: string,
  taskId?: string,
): Promise<InjectedLearning[]> {
  if (learningsMode === 'none') return [];

  try {
    const { selected } = await selectActiveLearningSetForRun({
      db,
      tenantId,
      spaceId,
      skillSlug: workflowSlug,
      ...(runId !== undefined ? { runId } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
    });
    return selected.map(renderActiveLearningEntry);
  } catch {
    getCyberneticLogger().warn(
      `contextAssembler: failed to load learnings for workflow=${workflowSlug}`,
    );
    return [];
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Assemble context for the Runner based on a TaskContextSpec.
 *
 * Resolves memory references, executes scoped searches, loads learnings,
 * and returns the assembled content ready for delegation context building.
 */
export async function assembleContext(params: {
  tenantId: string;
  spaceId: string;
  taskContextSpec: TaskContextSpec;
  workflowSlug: string;
  runId?: string;
  taskId?: string;
  db: PostgresJsDatabase;
}): Promise<AssembledContext> {
  const { tenantId, spaceId, taskContextSpec, workflowSlug, runId, taskId, db } = params;
  const spec = taskContextSpec;
  const strategy = spec.strategy ?? 'curated';

  const logger = getCyberneticLogger();
  logger.debug(
    `contextAssembler: assembling context for workflow=${workflowSlug}, strategy=${strategy}`,
  );

  try {
    // 1. Load static refs (all strategies)
    const staticPaths = spec.staticRefs ?? [];
    const staticDocsPromise = loadDocsByPaths(db, tenantId, spaceId, staticPaths);

    // 2. Load the active learning set (campaign resolved off runId when present)
    const learningsMode = spec.learnings ?? 'active';
    const learningsPromise = loadLearnings(
      db,
      tenantId,
      spaceId,
      workflowSlug,
      learningsMode,
      runId,
      taskId,
    );

    // 3. Execute scoped searches (scoped + curated strategies)
    const searchResults: MemoryDocResult[] = [];
    if (
      (strategy === 'scoped' || strategy === 'curated') &&
      spec.search &&
      spec.search.length > 0
    ) {
      const searchPromises = spec.search.map((s) =>
        executeSearch(db, tenantId, spaceId, {
          limit: s.limit,
          mode: s.mode,
          ...(s.pathPrefix != null ? { pathPrefix: s.pathPrefix } : {}),
          ...(s.tags != null ? { tags: s.tags } : {}),
          ...(s.recency != null ? { recency: s.recency } : {}),
          ...(s.query != null ? { query: s.query } : {}),
        }),
      );
      const searchArrays = await Promise.all(searchPromises);
      for (const arr of searchArrays) {
        searchResults.push(...arr);
      }
    }

    const [staticDocs, learnings] = await Promise.all([staticDocsPromise, learningsPromise]);

    // 4. Merge static + search results, dedup by path
    const seenPaths = new Set<string>();
    const mergedDocs: Array<{ path: string; content: string; preview?: string }> = [];

    for (const doc of staticDocs) {
      if (seenPaths.has(doc.path)) continue;
      seenPaths.add(doc.path);
      mergedDocs.push({
        path: doc.path,
        content: doc.inlineContent ?? '',
        ...(doc.preview ? { preview: doc.preview } : {}),
      });
    }

    for (const doc of searchResults) {
      if (seenPaths.has(doc.path)) continue;
      seenPaths.add(doc.path);
      mergedDocs.push({
        path: doc.path,
        content: doc.inlineContent ?? '',
        ...(doc.preview ? { preview: doc.preview } : {}),
      });
    }

    // 5. Collect tools — merge legacy `tools` with `capabilities.operations` (104n)
    const toolSet = new Set<string>(spec.tools ?? []);
    if (spec.capabilities?.operations) {
      for (const op of spec.capabilities.operations) {
        toolSet.add(op);
      }
    }
    const tools = [...toolSet];
    // toolGroups expansion is deferred to the delegation layer / capability resolution

    // 5b. Pass through structured capability grants (104n)
    const capabilityGrants: TaskCapabilityGrant | undefined = spec.capabilities;

    // TODO (Phase 2, curated strategy): Run attention function LLM call to filter
    // the merged candidate set down to the budget. For v1, curated returns the
    // same results as scoped.

    const result: AssembledContext = {
      memoryContent: mergedDocs,
      tools,
      ...(capabilityGrants ? { capabilityGrants } : {}),
      learnings,
      strategy,
    };

    return result;
  } catch (error) {
    logger.warn(
      `contextAssembler: failed for workflow=${workflowSlug}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    // Return empty context on failure — Runner can still function with just its goal.
    // Preserve tool grants (both legacy and structured) so Runners keep their
    // declared capability surface even when memory/search fails.
    const fallbackToolSet = new Set<string>(spec.tools ?? []);
    if (spec.capabilities?.operations) {
      for (const op of spec.capabilities.operations) {
        fallbackToolSet.add(op);
      }
    }
    return {
      memoryContent: [],
      tools: [...fallbackToolSet],
      ...(spec.capabilities ? { capabilityGrants: spec.capabilities } : {}),
      learnings: [],
      strategy,
    };
  }
}
