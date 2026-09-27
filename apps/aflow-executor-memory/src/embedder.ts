/**
 * Memory v2 Doc Embedding Worker.
 *
 * Runs as a background loop inside the memory executor process.
 * Consumes embed jobs from Redis stream, reads chunks from DB,
 * generates embeddings via ai-client, and writes them back.
 */
import {
  ensureMemoryDocEmbedConsumerGroup,
  readMemoryDocEmbedJobs,
  ackMemoryDocEmbedJob,
  claimPendingMemoryDocEmbedJobs,
  type BlockingRedisConnection,
} from '@aflow/redis';
import {
  createTenantContext,
  createMemoryDocRepository,
  createEmbeddingBudgetLimitsLoader,
  claimDueTenants,
  releaseTenantDueClaim,
  settleTenantDue,
  MEMORY_EMBED_DUE_POINTER,
  EMBEDDING_COLUMNS,
} from '@aflow/database';
import {
  backgroundWorkVerboseLogsEnabled,
  createBackgroundTaskRunner,
  type BackgroundTaskCycleResult,
  type BackgroundTaskRunner,
} from '@aflow/lib';
import { backgroundTaskControlPlane } from '@aflow/schemas';
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { consumeEmbeddingBudget, estimateEmbeddingTokens } from '@aflow/redis';
import { createAIClient, type AIClient, type ProviderConfig } from '@aflow/ai-client';
import { publishMemoryDocEmbedJob } from '@aflow/redis';
import type { MemoryDocEmbedJob, SessionId, StepExecutionId, TenantId } from '@aflow/schemas';
import { splitForTokenSafety } from '@aflow/memory-store';

// ============================================================================
// Configuration
// ============================================================================

const BACKFILL_TASK_ID = 'executor.memory.embed_backfill';

interface DocEmbedderConfig {
  consumerName: string;
  concurrency: number;
  blockMs: number;
  claimMinIdleMs: number;
  backfillIntervalMs: number;
  backfillBatchSize: number;
}

function getConfig(): DocEmbedderConfig {
  return {
    consumerName: process.env['HOSTNAME'] ?? `memory-doc-embedder-${String(process.pid)}`,
    concurrency: parseInt(process.env['MEMORY_EMBEDDER_CONCURRENCY'] ?? '3', 10),
    blockMs: 5000,
    claimMinIdleMs: 60_000,
    backfillIntervalMs: 30_000,
    backfillBatchSize: 20,
  };
}

// ============================================================================
// AI Client Singleton
// ============================================================================

let aiClient: AIClient | null = null;

function getAIClient(): AIClient {
  if (aiClient) return aiClient;

  const providers: Partial<Record<'openai' | 'google' | 'openrouter', ProviderConfig>> = {};

  if (process.env['OPENAI_API_KEY']) {
    providers.openai = {
      apiKey: process.env['OPENAI_API_KEY'],
      organization: process.env['OPENAI_ORG_ID'],
    };
  }

  if (process.env['GEMINI_API_KEY']) {
    providers.google = { apiKey: process.env['GEMINI_API_KEY'] };
  }

  if (process.env['OPENROUTER_API_KEY']) {
    providers.openrouter = { apiKey: process.env['OPENROUTER_API_KEY'] };
  }

  const defaultProvider = process.env['OPENAI_API_KEY'] ? 'openai' : 'google';

  aiClient = createAIClient({ providers, defaultProvider });
  return aiClient;
}

// ============================================================================
// Worker
// ============================================================================

type PostgresJsDatabase = Parameters<typeof createMemoryDocRepository>[0];
type PostgresSql = Parameters<typeof claimDueTenants>[0];

export interface DocEmbedderDependencies {
  redis: BlockingRedisConnection;
  db: PostgresJsDatabase;
  /** Raw postgres.Sql client for the backfill's due-pointer claim. */
  sqlClient?: PostgresSql;
  /**
   * Non-blocking connection for the budget counters — the stream connection
   * blocks in XREADGROUP and must not carry other commands.
   */
  budgetRedis?: Redis;
}

export class MemoryDocEmbedder {
  private running = false;
  private config: DocEmbedderConfig;
  private loadBudgetLimits: (
    tenantId: string,
  ) => ReturnType<ReturnType<typeof createEmbeddingBudgetLimitsLoader>>;
  private processing = new Set<Promise<void>>();
  private processLoopPromise: Promise<void> | null = null;
  private claimLoopPromise: Promise<void> | null = null;
  private backfill: BackgroundTaskRunner | null = null;
  private stopSignal: { promise: Promise<void>; resolve: () => void } | null = null;

  constructor(
    private deps: DocEmbedderDependencies,
    config?: Partial<DocEmbedderConfig>,
  ) {
    this.config = { ...getConfig(), ...config };
    this.loadBudgetLimits = createEmbeddingBudgetLimitsLoader(deps.db);
  }

  private makeStopSignal(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  private async sleepOrStop(ms: number): Promise<void> {
    const stopPromise = this.stopSignal?.promise;
    if (!stopPromise) {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve();
      }, ms);

      void stopPromise.then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopSignal = this.makeStopSignal();

    await ensureMemoryDocEmbedConsumerGroup(this.deps.redis);

    console.info('[MemoryDocEmbedder] Started', {
      consumerName: this.config.consumerName,
      concurrency: this.config.concurrency,
    });

    this.processLoopPromise = this.processLoop();
    this.claimLoopPromise = this.claimPendingLoop();
    if (this.deps.sqlClient) {
      this.backfill = this.createBackfillRunner();
      this.backfill.start();
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopSignal?.resolve();

    // Best-effort: abort any blocking XREADGROUP promptly so shutdown doesn't wait
    // for the full BLOCK window.
    const maybeDisconnect = (
      value: unknown,
    ): value is { disconnect(reconnect?: boolean): void } => {
      if (typeof value !== 'object' || value === null) return false;
      if (!('disconnect' in value)) return false;
      return typeof (value as { disconnect?: unknown }).disconnect === 'function';
    };
    if (maybeDisconnect(this.deps.redis)) {
      try {
        // Match quitRedisWithTimeout() fallback: disconnect without reconnect attempts.
        this.deps.redis.disconnect(false);
      } catch {
        // best-effort only
      }
    }

    await this.backfill?.stop();
    await Promise.allSettled([this.processLoopPromise, this.claimLoopPromise]);
    await Promise.allSettled(this.processing);
    console.info('[MemoryDocEmbedder] Stopped');
  }

  private async processLoop(): Promise<void> {
    while (this.running) {
      try {
        if (this.processing.size >= this.config.concurrency) {
          await this.sleepOrStop(100);
          continue;
        }

        const jobs = await readMemoryDocEmbedJobs(this.deps.redis, this.config.consumerName, {
          count: Math.max(1, this.config.concurrency - this.processing.size),
          blockMs: this.config.blockMs,
        });

        if (!this.running) break;

        for (const { id, job } of jobs) {
          const promise = this.processJob(id, job).finally(() => {
            this.processing.delete(promise);
          });
          this.processing.add(promise);
        }
      } catch (error) {
        if (!this.running) break;
        console.error('[MemoryDocEmbedder] Process loop error:', error);
        await this.sleepOrStop(2000);
      }
    }
  }

  private async claimPendingLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.sleepOrStop(30_000);
        if (!this.running) break;
        const jobs = await claimPendingMemoryDocEmbedJobs(
          this.deps.redis,
          this.config.consumerName,
          { minIdleMs: this.config.claimMinIdleMs, count: this.config.concurrency },
        );
        if (!this.running) break;
        for (const { id, job } of jobs) {
          if (this.processing.size >= this.config.concurrency) break;
          const promise = this.processJob(id, job).finally(() => {
            this.processing.delete(promise);
          });
          this.processing.add(promise);
        }
      } catch (error) {
        if (!this.running) break;
        console.error('[MemoryDocEmbedder] Claim loop error:', error);
      }
    }
  }

  /**
   * Re-publish embed jobs for documents left marked pending — a job that was
   * never enqueued, or one lost before it was claimed.
   *
   * Candidates come from the memory-embed due pointer, so a cycle asks which
   * tenants hold a pending document instead of asking every tenant whether it
   * holds one. The pointer nominates; `getStaleDocsForReembed` remains the
   * authority, and the settle recomputes the tenant's next due time from it.
   */
  private createBackfillRunner(): BackgroundTaskRunner {
    const runtime = backgroundTaskControlPlane().resolve(BACKFILL_TASK_ID);
    return createBackgroundTaskRunner(
      {
        taskId: BACKFILL_TASK_ID,
        scope: runtime.scope,
        intervalMs: this.config.backfillIntervalMs,
        maxBatch: runtime.maxBatch,
        maxCycleMs: runtime.maxCycleMs,
        mode: runtime.mode,
      },
      async (ctx): Promise<BackgroundTaskCycleResult> => {
        const sqlClient = this.deps.sqlClient;
        if (!sqlClient) return { candidates: 0 };
        const claimToken = randomUUID();
        const claimed = await claimDueTenants(sqlClient, MEMORY_EMBED_DUE_POINTER, {
          limit: ctx.maxBatch,
          leaseMs: runtime.maxCycleMs,
          claimToken,
        });
        if (claimed.length === 0) return { candidates: 0 };
        if (ctx.mode === 'observe') {
          // Holding a lease is itself a side effect: it keeps the tenant away
          // from whatever else is draining while this one only watches.
          for (const claim of claimed) {
            await releaseTenantDueClaim(
              sqlClient,
              MEMORY_EMBED_DUE_POINTER,
              claim.tenantId,
              claimToken,
            );
          }
          return { candidates: claimed.length };
        }

        let processed = 0;
        let failed = 0;
        for (const claim of claimed) {
          if (ctx.budgetExhausted()) {
            await releaseTenantDueClaim(
              sqlClient,
              MEMORY_EMBED_DUE_POINTER,
              claim.tenantId,
              claimToken,
            );
            continue;
          }
          try {
            processed += await this.republishStaleDocs(claim.tenantId as TenantId);
          } catch (error) {
            failed++;
            console.error('[MemoryDocEmbedder] Backfill tenant failed:', error);
          }
          try {
            await settleTenantDue(sqlClient, MEMORY_EMBED_DUE_POINTER, claim, claimToken);
          } catch (error) {
            console.error('[MemoryDocEmbedder] Backfill settle failed:', error);
          }
        }

        if (backgroundWorkVerboseLogsEnabled()) {
          console.info('[background-work] memory embed backfill cycle', {
            trigger: 'candidate',
            claimed: claimed.length,
            processed,
            failed,
          });
        }

        return {
          candidates: claimed.length,
          processed,
          failed,
          hasMore: claimed.length === ctx.maxBatch,
        };
      },
    );
  }

  private async republishStaleDocs(tenantId: TenantId): Promise<number> {
    const repo = createMemoryDocRepository(this.deps.db, createTenantContext(tenantId));
    const staleDocs = await repo.getStaleDocsForReembed(this.config.backfillBatchSize);
    if (staleDocs.length === 0) return 0;

    console.info('[MemoryDocEmbedder] Backfill: found stale docs', {
      tenantId,
      count: staleDocs.length,
    });

    for (const doc of staleDocs) {
      const resolved = await repo.resolveEmbeddingModel({
        spaceId: doc.spaceId,
        agentId: doc.agentId ?? undefined,
        pathPrefix: doc.path,
      });

      const job: MemoryDocEmbedJob = {
        messageVersion: 1,
        tenantId,
        spaceId: doc.spaceId,
        docId: doc.id,
        docVersionId: doc.latestVersionId,
        version: doc.currentVersion,
        path: doc.path,
        contentHash: doc.contentHash,
        embeddingModel: resolved.model,
        createdAt: new Date().toISOString(),
      };

      await publishMemoryDocEmbedJob(this.deps.redis, job);
    }
    return staleDocs.length;
  }

  private async processJob(messageId: string, job: MemoryDocEmbedJob): Promise<void> {
    const startTime = Date.now();
    const logCtx = {
      tenantId: job.tenantId,
      docId: job.docId,
      path: job.path,
      version: job.version,
      messageId,
    };

    try {
      const tenantContext = createTenantContext(job.tenantId);
      const repo = createMemoryDocRepository(this.deps.db, tenantContext);

      // Idempotency: check doc still exists and hash matches
      const doc = await repo.getById(job.docId, job.spaceId);
      if (doc?.contentHash !== job.contentHash) {
        console.info(
          '[MemoryDocEmbedder] Stale job (hash mismatch or doc missing), skipping',
          logCtx,
        );
        await ackMemoryDocEmbedJob(this.deps.redis, messageId);
        return;
      }

      // Read chunks for this version
      const allChunks = await repo.getChunksForVersion(job.docVersionId);
      if (allChunks.length === 0) {
        console.warn('[MemoryDocEmbedder] No chunks found for version, skipping', logCtx);
        await repo.updateDocEmbeddingStatus(job.docId, 'failed');
        await ackMemoryDocEmbedJob(this.deps.redis, messageId);
        return;
      }

      // Filter out chunks marked as skip_embedding (FTS-only chunks, e.g. CSV row data)
      const embeddableChunks = allChunks.filter((c) => !c.skipEmbedding);
      if (embeddableChunks.length === 0) {
        // All chunks are FTS-only — mark as indexed (FTS is auto-generated by Postgres)
        await repo.updateDocEmbeddingStatus(job.docId, 'indexed');
        await ackMemoryDocEmbedJob(this.deps.redis, messageId);
        console.info('[MemoryDocEmbedder] All chunks FTS-only, marked indexed', logCtx);
        return;
      }

      const textsToEmbed: string[] = [];
      const chunkMapping: Array<{ chunkId: string; subIndex: number }> = [];

      for (const chunk of embeddableChunks) {
        const subTexts = splitForTokenSafety(chunk.text);
        for (let si = 0; si < subTexts.length; si++) {
          textsToEmbed.push(subTexts[si]!);
          chunkMapping.push({ chunkId: chunk.id, subIndex: si });
        }
        if (subTexts.length > 1) {
          console.info('[MemoryDocEmbedder] Chunk split for token safety', {
            ...logCtx,
            chunkId: chunk.id,
            chunkIndex: chunk.chunkIndex,
            originalChars: chunk.text.length,
            subChunks: subTexts.length,
          });
        }
      }

      // Daily budget — exhaustion defers the embed (doc stays 'pending' for the
      // next backfill pass), it never fails the doc.
      if (this.deps.budgetRedis) {
        const limits = await this.loadBudgetLimits(job.tenantId);
        const budget = await consumeEmbeddingBudget(this.deps.budgetRedis, {
          tenantId: job.tenantId,
          spaceId: job.spaceId,
          tokens: estimateEmbeddingTokens(textsToEmbed),
          limits,
        });
        if (!budget.allowed) {
          await repo.updateDocEmbeddingStatus(job.docId, 'pending');
          await ackMemoryDocEmbedJob(this.deps.redis, messageId);
          console.info('[MemoryDocEmbedder] Embedding deferred — daily budget exhausted', {
            ...logCtx,
            exceededScope: budget.exceededScope,
          });
          return;
        }
      }

      // Generate embeddings
      const client = getAIClient();

      const embeddingResponse = await client.generateEmbedding({
        model: job.embeddingModel,
        input: textsToEmbed,
        tenantId: job.tenantId,
        runId: job.docId as SessionId,
        stepExecutionId: job.docVersionId as StepExecutionId,
      });

      if (embeddingResponse.embeddings.length !== textsToEmbed.length) {
        throw new Error(
          `Embedding count mismatch: expected ${String(textsToEmbed.length)}, got ${String(embeddingResponse.embeddings.length)}`,
        );
      }

      const embedColumn = EMBEDDING_COLUMNS[embeddingResponse.dimensions];
      if (!embedColumn) {
        throw new Error(
          `Unsupported embedding dimension ${String(embeddingResponse.dimensions)} from model ${job.embeddingModel}. Supported: ${Object.keys(EMBEDDING_COLUMNS).join(', ')}`,
        );
      }

      // Write embeddings back — for split chunks, use the first sub-chunk's embedding
      const writtenChunks = new Set<string>();
      for (let i = 0; i < chunkMapping.length; i++) {
        const mapping = chunkMapping[i]!;
        // Only write the first sub-chunk embedding for each original chunk
        if (writtenChunks.has(mapping.chunkId)) continue;
        writtenChunks.add(mapping.chunkId);

        const embedding = embeddingResponse.embeddings[i]!;
        try {
          await repo.updateChunkEmbedding(
            mapping.chunkId,
            embedding,
            job.embeddingModel,
            embeddingResponse.dimensions,
            embedColumn,
          );
        } catch (vectorErr) {
          console.warn('[MemoryDocEmbedder] Failed to write embedding', {
            ...logCtx,
            chunkId: mapping.chunkId,
            column: embedColumn,
            error: vectorErr instanceof Error ? vectorErr.message : String(vectorErr),
          });
          await repo.updateDocEmbeddingStatus(job.docId, 'failed');
          await ackMemoryDocEmbedJob(this.deps.redis, messageId);
          return;
        }
      }

      await repo.updateDocEmbeddingStatus(job.docId, 'indexed');
      await ackMemoryDocEmbedJob(this.deps.redis, messageId);

      const durationMs = Date.now() - startTime;
      console.info('[MemoryDocEmbedder] Embedding complete', {
        ...logCtx,
        chunks: embeddableChunks.length,
        skippedChunks: allChunks.length - embeddableChunks.length,
        dims: embeddingResponse.dimensions,
        durationMs,
      });
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error('[MemoryDocEmbedder] Job failed', {
        ...logCtx,
        error: errMsg,
        durationMs,
      });

      try {
        const tenantContext = createTenantContext(job.tenantId);
        const repo = createMemoryDocRepository(this.deps.db, tenantContext);
        await repo.updateDocEmbeddingStatus(job.docId, 'failed');
      } catch {
        // best-effort status update
      }

      await ackMemoryDocEmbedJob(this.deps.redis, messageId);
    }
  }
}
