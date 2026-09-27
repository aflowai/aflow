import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { successWithData, failureWithError } from '@aflow/executor-runtime';
import { validationError } from '@aflow/executor-runtime';
import type {
  MemoryDocRepository,
  MemoryDocQueryOptions,
  MemoryDirRepository,
} from '@aflow/database';
import type { MemoryQueryInput } from '@aflow/schemas';
import { isVirtualPath, listVirtualOutputs } from '@aflow/memory-paths';
import { canonicalizeTarget, INDEX_NOTE_PATH } from '@aflow/memory-store';
import type { MemoryLinkRepository } from '@aflow/database';
import { stripUndefined } from '../utils.js';
import { buildProviders } from '../providers.js';
import type { MemoryHandlerDeps } from './types.js';
import { buildResolveContext } from './resolveContext.js';
import { applyByteBudget, DEFAULT_MAX_TOTAL_BYTES } from './byteBudget.js';
import {
  distinctSeeds,
  perSeedCap,
  selectExpandedNeighbors,
  type ExpandedItem,
  type NeighborDoc,
} from './linkExpansion.js';

/**
 * mode="links" — graph queries, not document listings, so `items` is always
 * []. With linkFilter.target we list the referrer edges pointing at that path
 * (getLinkEdges); without a target we aggregate distinct targets into the
 * hub/agenda view (getLinkTargets), where unresolvedOnly narrows to ghosts.
 * pathPrefix filters the referrer side in both. Keyset-paginated via cursor.
 */
async function handleLinksMode(
  ctx: ExecutorContext,
  input: MemoryQueryInput,
  deps: MemoryHandlerDeps,
  spaceId: string,
  limit: number,
  maxTotalBytes: number,
): Promise<StepResult> {
  const linkRepo: MemoryLinkRepository = deps.linkRepo;
  const rawTarget = input.linkFilter?.target;

  if (rawTarget !== undefined) {
    // Writes store edge targets in the canonical form (extensionless → `.md`,
    // `.` / `..` normalized), so the query target must be canonicalized the same
    // way or an extensionless target never matches. A rejected target (control /
    // bidi / byte-cap) matches no stored edge → empty page.
    const target = canonicalizeTarget(rawTarget, INDEX_NOTE_PATH);
    if (target === null) {
      return await successWithData(ctx, { items: [], linkEdges: [] });
    }
    const page = await linkRepo.getLinkEdges(target, spaceId, {
      limit,
      ...(input.pathPrefix !== undefined ? { pathPrefix: input.pathPrefix } : {}),
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    });
    const budgeted = applyByteBudget(page.items, maxTotalBytes);
    const linkEdges = budgeted.items.map((e) => ({
      fromPath: e.fromPath,
      occurrenceCount: e.occurrenceCount,
      updatedAt: e.updatedAt.toISOString(),
      ...(e.firstContext !== undefined ? { context: e.firstContext } : {}),
    }));
    const lastKept = budgeted.items[budgeted.items.length - 1];
    const nextCursor = budgeted.truncated ? lastKept?.cursor : page.nextCursor;
    return await successWithData(ctx, {
      items: [],
      linkEdges,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
      ...(budgeted.truncated ? { truncatedByBudget: true } : {}),
    });
  }

  const page = await linkRepo.getLinkTargets(spaceId, {
    limit,
    ...(input.pathPrefix !== undefined ? { pathPrefix: input.pathPrefix } : {}),
    ...(input.linkFilter?.unresolvedOnly !== undefined
      ? { unresolvedOnly: input.linkFilter.unresolvedOnly }
      : {}),
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
  });
  const budgeted = applyByteBudget(page.items, maxTotalBytes);
  const linkTargets = budgeted.items.map((t) => ({
    targetPath: t.targetPath,
    resolved: t.resolved,
    referenceCount: t.referenceCount,
    referrers: t.referrers.map((r) => ({
      path: r.path,
      ...(r.firstContext !== undefined ? { context: r.firstContext } : {}),
    })),
    ...(t.resolvedDoc !== undefined
      ? {
          resolvedDoc: {
            id: t.resolvedDoc.id,
            docType: t.resolvedDoc.docType,
            updatedAt: t.resolvedDoc.updatedAt.toISOString(),
            ...(t.resolvedDoc.summary !== undefined ? { summary: t.resolvedDoc.summary } : {}),
          },
        }
      : {}),
  }));
  const lastKept = budgeted.items[budgeted.items.length - 1];
  const nextCursor = budgeted.truncated ? lastKept?.cursor : page.nextCursor;
  return await successWithData(ctx, {
    items: [],
    linkTargets,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
    ...(budgeted.truncated ? { truncatedByBudget: true } : {}),
  });
}

/** Extract optional scope fields from a DB row (null → omitted). */
function scopeFields(r: {
  spaceId?: string | null | undefined;
  userId?: string | null | undefined;
  agentId?: string | null | undefined;
  sessionId?: string | null | undefined;
}): Record<string, string> {
  const out: Record<string, string> = {};
  if (r.spaceId) out['spaceId'] = r.spaceId;
  if (r.userId) out['userId'] = r.userId;
  if (r.agentId) out['agentId'] = r.agentId;
  if (r.sessionId) out['sessionId'] = r.sessionId;
  return out;
}

/**
 * Finalize a mode="search" page: append opt-in 1-hop link-expanded neighbors
 * after the RRF-fused seed items, then apply the byte budget over the whole
 * envelope (seeds + expanded). Expansion is off unless `input.expand?.links`
 * is 1. Neighbor metadata is fetched with the SAME scope+filters predicate as
 * the seeds (repo.listByPaths), so a neighbor failing the filter is dropped.
 */
async function finalizeSearch(
  ctx: ExecutorContext,
  repo: MemoryDocRepository,
  input: MemoryQueryInput,
  deps: MemoryHandlerDeps,
  spaceId: string,
  seeds: ReadonlyArray<{ id: string; path: string }>,
  maxTotalBytes: number,
  maxSnippetBytes: number,
): Promise<StepResult> {
  let expanded: ExpandedItem[] = [];

  if (input.expand?.links === 1 && seeds.length > 0) {
    const maxLinkedItems = input.budget?.maxLinkedItems ?? 10;
    const seedDocs = distinctSeeds(seeds, Math.min(seeds.length, 10));
    const cap = perSeedCap(maxLinkedItems);
    const neighborsBySeed = await deps.linkRepo.getNeighborsForExpansion(
      seedDocs.map((s) => s.docId),
      spaceId,
      input.expand.direction,
      cap,
    );

    const neighborPaths = new Set<string>();
    for (const list of neighborsBySeed.values()) {
      for (const n of list) neighborPaths.add(n.path);
    }

    const neighborDocByPath = new Map<string, NeighborDoc>();
    if (neighborPaths.size > 0) {
      const docs = await repo.listByPaths([...neighborPaths], {
        scope: { spaceId },
        ...(input.filters != null ? { filters: stripUndefined(input.filters) } : {}),
      });
      for (const d of docs) {
        neighborDocByPath.set(d.path, {
          path: d.path,
          id: d.id,
          docType: d.docType,
          mimeType: d.mimeType,
          sizeBytes: d.sizeBytes,
          updatedAt: d.updatedAt.toISOString(),
          preview: d.preview ? d.preview.substring(0, maxSnippetBytes) : undefined,
          scope: scopeFields(d),
        });
      }
    }

    expanded = selectExpandedNeighbors(
      seedDocs,
      neighborsBySeed,
      neighborDocByPath,
      maxLinkedItems,
    );
  }

  const budgeted = applyByteBudget([...seeds, ...expanded], maxTotalBytes);
  return await successWithData(ctx, {
    items: budgeted.items,
    ...(budgeted.truncated ? { truncatedByBudget: true } : {}),
  });
}

export async function handleQuery(
  ctx: ExecutorContext,
  repo: MemoryDocRepository,
  input: MemoryQueryInput,
  deps: MemoryHandlerDeps,
  dirRepo?: MemoryDirRepository,
): Promise<StepResult> {
  const mode = input.mode;
  const limit = input.budget?.limit ?? 50;
  const maxSnippetBytes = input.budget?.maxSnippetBytes ?? 500;
  const maxTotalBytes = input.budget?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

  // Virtual /run/outputs/* listing resolves from the run's own hot state and
  // needs no space — handle it before the persistent, space-gated path.
  if (mode === 'list') {
    const pathPrefix = input.pathPrefix ?? '/';
    if (
      isVirtualPath(pathPrefix) ||
      pathPrefix === '/run/outputs/' ||
      pathPrefix === '/run/outputs'
    ) {
      const resolveCtx = buildResolveContext(ctx, deps);
      const virtualEntries = await listVirtualOutputs(resolveCtx);
      const allItems = virtualEntries.map((entry) => ({
        entryType: entry.entryType === 'directory' ? ('directory' as const) : ('document' as const),
        path: entry.path,
        id: '00000000-0000-0000-0000-000000000000',
        name: entry.name,
        docType: 'text' as const,
        mimeType: 'application/octet-stream',
        sizeBytes: entry.sizeBytes,
        updatedAt: new Date().toISOString(),
        ...(entry.metadata?.operation
          ? {
              description: `${entry.metadata.operation} → ${entry.metadata.fields?.join(', ') ?? ''}`,
            }
          : {}),
      }));
      const budgeted = applyByteBudget(allItems, maxTotalBytes);
      return await successWithData(ctx, {
        items: budgeted.items,
        ...(budgeted.truncated ? { truncatedByBudget: true } : {}),
      });
    }
  }

  // Space scope is enforced from run context via deps.spaceId.
  const spaceId = deps.spaceId;
  if (!spaceId) {
    return await failureWithError(
      ctx,
      validationError('MEMORY_NO_SPACE: memory operations require a space context'),
    );
  }
  const scope = { spaceId };

  if (mode === 'links') {
    return await handleLinksMode(ctx, input, deps, spaceId, limit, maxTotalBytes);
  }

  const queryOptions: MemoryDocQueryOptions = {
    limit: limit + 1,
    scope,
    ...(input.pathPrefix != null ? { pathPrefix: input.pathPrefix } : {}),
    ...(input.filters != null ? { filters: stripUndefined(input.filters) } : {}),
    ...(input.cursor != null ? { cursor: input.cursor } : {}),
  };

  if (mode === 'list') {
    const isRecursive = input.recursive === true;

    if (!isRecursive && dirRepo) {
      const parentPath = input.pathPrefix ?? '/';
      const dirItems = await dirRepo.listDir(parentPath, {
        scope,
        limit: limit + 1,
        cursor: input.cursor,
      });

      const hasMore = dirItems.length > limit;
      const pagedItems = dirItems.slice(0, limit).map((item) => {
        if (item.entryType === 'directory') {
          return {
            entryType: 'directory' as const,
            path: item.path,
            id: item.id,
            name: item.name,
            docType: 'directory' as const,
            mimeType: 'inode/directory',
            sizeBytes: 0,
            updatedAt: item.updatedAt.toISOString(),
            description: item.description ?? undefined,
            childCount: item.childCount,
            ...scopeFields(item),
          };
        }
        return {
          entryType: 'document' as const,
          path: item.path,
          id: item.id,
          name: item.name,
          docType: item.docType!,
          mimeType: item.mimeType!,
          sizeBytes: item.sizeBytes!,
          updatedAt: item.updatedAt.toISOString(),
          preview: item.preview ? item.preview.substring(0, maxSnippetBytes) : undefined,
          ...scopeFields(item),
        };
      });

      const budgeted = applyByteBudget(pagedItems, maxTotalBytes);
      const lastItem = budgeted.items[budgeted.items.length - 1];
      const moreToPage = hasMore || budgeted.truncated;
      return await successWithData(ctx, {
        items: budgeted.items,
        nextCursor: moreToPage && lastItem ? lastItem.name : undefined,
        ...(budgeted.truncated ? { truncatedByBudget: true } : {}),
      });
    }

    // Recursive (flat) listing — original behavior
    const results = await repo.list(queryOptions);
    const hasMore = results.length > limit;
    const pagedItems = results.slice(0, limit).map((r) => ({
      entryType: 'document' as const,
      path: r.path,
      id: r.id,
      docType: r.docType,
      mimeType: r.mimeType,
      sizeBytes: r.sizeBytes,
      updatedAt: r.updatedAt.toISOString(),
      preview: r.preview ? r.preview.substring(0, maxSnippetBytes) : undefined,
      ...scopeFields(r),
    }));

    const budgeted = applyByteBudget(pagedItems, maxTotalBytes);
    const lastItem = budgeted.items[budgeted.items.length - 1];
    const moreToPage = hasMore || budgeted.truncated;
    return await successWithData(ctx, {
      items: budgeted.items,
      nextCursor: moreToPage && lastItem ? lastItem.path : undefined,
      ...(budgeted.truncated ? { truncatedByBudget: true } : {}),
    });
  }

  if (mode === 'grep') {
    if (!input.query) {
      return await failureWithError(ctx, validationError('query is required for grep mode'));
    }

    let ftsResults: Array<{
      path: string;
      docId: string;
      docType: string;
      mimeType: string;
      sizeBytes: number;
      updatedAt: Date;
      score: number;
      snippet: string;
      chunkId: string;
      chunkIndex: number;
      searchBackend: string;
      spaceId: string | null;
      userId: string | null;
      agentId: string | null;
      sessionId: string | null;
    }> = [];

    try {
      ftsResults = await repo.searchFts({ ...queryOptions, query: input.query });
    } catch {
      /* FTS not available */
    }

    if (ftsResults.length > 0) {
      const pagedItems = ftsResults.slice(0, limit).map((r) => ({
        path: r.path,
        id: r.docId,
        docType: r.docType,
        mimeType: r.mimeType,
        sizeBytes: r.sizeBytes,
        updatedAt: r.updatedAt.toISOString(),
        hit: {
          score: r.score,
          snippet: r.snippet.substring(0, maxSnippetBytes),
          chunkId: r.chunkId,
          chunkIndex: r.chunkIndex,
        },
        searchBackend: r.searchBackend,
        ...scopeFields(r),
      }));
      const budgeted = applyByteBudget(pagedItems, maxTotalBytes);
      return await successWithData(ctx, {
        items: budgeted.items,
        ...(budgeted.truncated ? { truncatedByBudget: true } : {}),
      });
    }

    const results = await repo.grep({ ...queryOptions, query: input.query });
    const pagedItems = results.slice(0, limit).map((r) => ({
      path: r.path,
      id: r.id,
      docType: r.docType,
      mimeType: r.mimeType,
      sizeBytes: r.sizeBytes,
      updatedAt: r.updatedAt.toISOString(),
      hit: {
        score: r.score,
        snippet: r.snippet.substring(0, maxSnippetBytes),
      },
      ...scopeFields(r),
    }));

    const budgeted = applyByteBudget(pagedItems, maxTotalBytes);
    return await successWithData(ctx, {
      items: budgeted.items,
      ...(budgeted.truncated ? { truncatedByBudget: true } : {}),
    });
  } else {
    if (!input.query) {
      return await failureWithError(ctx, validationError('query is required for search mode'));
    }

    // Try hybrid search (vector + FTS fused via RRF)
    let queryEmbedding: number[] | undefined;
    let embedColumn: string | undefined;

    try {
      const resolved = await repo.resolveEmbeddingModel({
        spaceId,
        pathPrefix: input.pathPrefix,
      });

      // Budget exhaustion degrades to FTS via the same catch as a missing key.
      if (deps.loadEmbeddingBudgetLimits) {
        const { consumeEmbeddingBudget, estimateEmbeddingTokens } = await import('@aflow/redis');
        const budget = await consumeEmbeddingBudget(deps.redis, {
          tenantId: ctx.tenantId,
          spaceId,
          tokens: estimateEmbeddingTokens([input.query]),
          limits: await deps.loadEmbeddingBudgetLimits(ctx.tenantId),
        });
        if (!budget.allowed) {
          throw new Error(`embedding budget exhausted (${budget.exceededScope ?? 'unknown'})`);
        }
      }

      const { createAIClient } = await import('@aflow/ai-client');
      const client = createAIClient({
        providers: buildProviders(),
        defaultProvider: process.env['OPENAI_API_KEY'] ? 'openai' : 'google',
      });

      const embResp = await client.generateEmbedding({
        model: resolved.model,
        input: input.query,
        tenantId: ctx.tenantId,
        runId: ctx.runId,
        stepExecutionId: ctx.stepExecutionId,
      });

      if (embResp.embeddings.length > 0 && embResp.embeddings[0]) {
        queryEmbedding = embResp.embeddings[0];
        embedColumn = resolved.column;
      }
    } catch {
      ctx.log.debug('Vector embedding unavailable, search will use FTS only');
    }

    let hybridResults: Array<{
      path: string;
      docId: string;
      docType: string;
      mimeType: string;
      sizeBytes: number;
      updatedAt: Date;
      score: number;
      snippet: string;
      chunkId: string;
      chunkIndex: number;
      searchBackend: string;
      spaceId: string | null;
      userId: string | null;
      agentId: string | null;
      sessionId: string | null;
    }> = [];

    try {
      hybridResults = await repo.searchHybrid({
        ...queryOptions,
        query: input.query,
        ...(queryEmbedding != null ? { queryEmbedding } : {}),
        ...(embedColumn != null ? { embedColumn } : {}),
      });
    } catch {
      ctx.log.debug('Hybrid search failed, falling back to ILIKE grep');
    }

    if (hybridResults.length > 0) {
      const pagedItems = hybridResults.slice(0, limit).map((r) => ({
        path: r.path,
        id: r.docId,
        docType: r.docType,
        mimeType: r.mimeType,
        sizeBytes: r.sizeBytes,
        updatedAt: r.updatedAt.toISOString(),
        hit: {
          score: r.score,
          snippet: r.snippet.substring(0, maxSnippetBytes),
          chunkId: r.chunkId,
          chunkIndex: r.chunkIndex,
        },
        searchBackend: r.searchBackend,
        ...scopeFields(r),
      }));
      return await finalizeSearch(
        ctx,
        repo,
        input,
        deps,
        spaceId,
        pagedItems,
        maxTotalBytes,
        maxSnippetBytes,
      );
    }

    // Final fallback: ILIKE grep (no chunks/embeddings available)
    const results = await repo.grep({ ...queryOptions, query: input.query });
    const pagedItems = results.slice(0, limit).map((r) => ({
      path: r.path,
      id: r.id,
      docType: r.docType,
      mimeType: r.mimeType,
      sizeBytes: r.sizeBytes,
      updatedAt: r.updatedAt.toISOString(),
      hit: {
        score: r.score,
        snippet: r.snippet.substring(0, maxSnippetBytes),
      },
      searchBackend: 'ilike',
      ...scopeFields(r),
    }));

    return await finalizeSearch(
      ctx,
      repo,
      input,
      deps,
      spaceId,
      pagedItems,
      maxTotalBytes,
      maxSnippetBytes,
    );
  }

  return await failureWithError(ctx, validationError(`Unknown query mode: ${mode}`));
}
