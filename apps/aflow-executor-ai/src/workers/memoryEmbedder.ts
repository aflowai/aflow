/**
 * Memory Embedding Worker
 *
 * Consumes embedding jobs from Redis Streams and generates embeddings
 * asynchronously for memory entries.
 */
import type { Redis } from 'ioredis';
import type { PayloadStore } from '@aflow/payload-store';
import {
  readMemoryEmbedJobs,
  ackMemoryEmbedJob,
  claimPendingMemoryEmbedJobs,
  publishMemoryEmbedJobToDlq,
  ensureMemoryEmbedConsumerGroup,
  type BlockingRedisConnection,
} from '@aflow/redis';
import {
  createTenantContext,
  createMemoryRepository,
  createEmbeddingBudgetLimitsLoader,
} from '@aflow/database';
import {
  createAIClient,
  type AIClient,
  type ProviderConfig,
  AIClientError,
} from '@aflow/ai-client';
import { hashContent, extractTextForEmbedding } from '@aflow/schemas/utils/memoryEmbed';
import type { MemoryEmbedJob, SessionId, StepExecutionId } from '@aflow/schemas';

// ============================================================================
// Configuration
// ============================================================================

interface MemoryEmbedderConfig {
  /** Consumer name (unique per worker instance) */
  consumerName: string;
  /** Concurrency (number of jobs to process in parallel) */
  concurrency: number;
  /** Max retries before DLQ */
  maxRetries: number;
  /** Max inline content size (bytes) */
  maxInlineBytes: number;
  /** Block time for stream reads (ms) */
  blockMs: number;
  /** Min idle time before claiming pending jobs (ms) */
  claimMinIdleMs: number;
}

function getConfig(): MemoryEmbedderConfig {
  return {
    consumerName: process.env['HOSTNAME'] ?? `memory-embedder-${String(process.pid)}`,
    concurrency: parseInt(process.env['MEMORY_EMBEDDER_CONCURRENCY'] ?? '5', 10),
    maxRetries: parseInt(process.env['MEMORY_EMBEDDER_MAX_RETRIES'] ?? '3', 10),
    maxInlineBytes: parseInt(process.env['MEMORY_EMBED_MAX_INLINE_BYTES'] ?? '16384', 10),
    blockMs: 5000,
    claimMinIdleMs: 60_000, // 1 minute
  };
}

// ============================================================================
// AI Client Singleton
// ============================================================================

let aiClient: AIClient | null = null;

function getAIClient(): AIClient {
  if (aiClient) {
    return aiClient;
  }

  const providers: Partial<
    Record<'openai' | 'google' | 'openrouter' | 'fireworks', ProviderConfig>
  > = {};

  if (process.env['OPENAI_API_KEY']) {
    providers.openai = {
      apiKey: process.env['OPENAI_API_KEY'],
      organization: process.env['OPENAI_ORG_ID'],
    };
  }

  if (process.env['GEMINI_API_KEY']) {
    providers.google = {
      apiKey: process.env['GEMINI_API_KEY'],
    };
  }

  if (process.env['OPENROUTER_API_KEY']) {
    providers.openrouter = {
      apiKey: process.env['OPENROUTER_API_KEY'],
    };
  }

  if (process.env['FIREWORKS_API_KEY']) {
    providers.fireworks = {
      apiKey: process.env['FIREWORKS_API_KEY'],
    };
  }

  const defaultProvider = process.env['OPENAI_API_KEY'] ? 'openai' : 'google';

  aiClient = createAIClient({
    providers,
    defaultProvider,
  });

  return aiClient;
}

// ============================================================================
// Worker Implementation
// ============================================================================

type PostgresJsDatabase = Parameters<typeof createMemoryRepository>[0];

export interface MemoryEmbedderDependencies {
  /**
   * Regular Redis connection — XACK, consumer-group setup, DLQ publish.
   * Must NOT be used for blocking reads (see `blockingRedis`).
   */
  redis: Redis;
  blockingRedis: BlockingRedisConnection;
  payloadStore: PayloadStore;
  db: PostgresJsDatabase;
}

export class MemoryEmbedder {
  private running = false;
  private config: MemoryEmbedderConfig;
  private loadBudgetLimits!: ReturnType<typeof createEmbeddingBudgetLimitsLoader>;
  private processing = new Set<Promise<void>>();
  private processLoopPromise: Promise<void> | null = null;
  private claimLoopPromise: Promise<void> | null = null;

  constructor(
    private deps: MemoryEmbedderDependencies,
    config?: Partial<MemoryEmbedderConfig>,
  ) {
    this.config = { ...getConfig(), ...config };
    this.loadBudgetLimits = createEmbeddingBudgetLimitsLoader(deps.db);
  }

  /**
   * Start the embedding worker loop.
   */
  async start(): Promise<void> {
    if (this.running) {
      throw new Error('Memory embedder is already running');
    }

    this.running = true;

    // Ensure consumer group exists
    await ensureMemoryEmbedConsumerGroup(this.deps.redis);

    console.info('Memory Embedder started', {
      consumerName: this.config.consumerName,
      concurrency: this.config.concurrency,
      maxRetries: this.config.maxRetries,
    });

    this.processLoopPromise = this.processLoop();
    this.claimLoopPromise = this.claimPendingLoop();
  }

  /**
   * Stop the worker gracefully.
   */
  async stop(): Promise<void> {
    this.running = false;
    console.info('Stopping memory embedder, waiting for in-flight jobs...');

    await Promise.allSettled([this.processLoopPromise, this.claimLoopPromise]);
    await Promise.allSettled(this.processing);

    console.info('Memory embedder stopped');
  }

  /**
   * Main processing loop: read jobs and process them.
   */
  private async processLoop(): Promise<void> {
    while (this.running) {
      try {
        // Wait if at concurrency limit
        if (this.processing.size >= this.config.concurrency) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }

        // Read jobs from stream — runs on the dedicated `blockingRedis`
        const jobs = await readMemoryEmbedJobs(this.deps.blockingRedis, this.config.consumerName, {
          count: Math.max(1, this.config.concurrency - this.processing.size),
          blockMs: this.config.blockMs,
        });

        if (!this.running) {
          break;
        }

        // Process each job
        for (const { id, job } of jobs) {
          const promise = this.processJob(id, job).finally(() => {
            this.processing.delete(promise);
          });
          this.processing.add(promise);
        }
      } catch (error) {
        console.error('Error in memory embedder process loop:', error);
        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  /**
   * Claim pending jobs from dead consumers.
   */
  private async claimPendingLoop(): Promise<void> {
    while (this.running) {
      try {
        // Claim pending jobs (run less frequently, every 30s)
        await new Promise((resolve) => setTimeout(resolve, 30_000));

        const jobs = await claimPendingMemoryEmbedJobs(this.deps.redis, this.config.consumerName, {
          minIdleMs: this.config.claimMinIdleMs,
          count: this.config.concurrency,
        });

        if (!this.running) {
          break;
        }

        for (const { id, job } of jobs) {
          if (this.processing.size >= this.config.concurrency) break;

          const promise = this.processJob(id, job).finally(() => {
            this.processing.delete(promise);
          });
          this.processing.add(promise);
        }
      } catch (error) {
        console.error('Error in memory embedder claim loop:', error);
      }
    }
  }

  /**
   * Process a single embedding job.
   */
  private async processJob(messageId: string, job: MemoryEmbedJob): Promise<void> {
    const startTime = Date.now();
    const logContext = {
      tenantId: job.tenantId,
      entryId: job.entryId,
      embeddingModel: job.embeddingModel,
      messageId,
    };

    try {
      // Load memory entry from DB
      const tenantContext = createTenantContext(job.tenantId);
      const memoryRepo = createMemoryRepository(this.deps.db, tenantContext);

      const entry = await memoryRepo.readById(job.entryId);

      if (!entry) {
        console.warn('Memory entry not found', logContext);
        await ackMemoryEmbedJob(this.deps.redis, messageId);
        return;
      }

      // Extract text to embed
      let textToEmbed: string;
      if (job.contentText) {
        // Inline content provided
        textToEmbed = job.contentText;
      } else if (job.contentRef) {
        // Fetch from payload store
        try {
          const content = await this.deps.payloadStore.retrieve(job.contentRef);
          if (typeof content === 'string') {
            textToEmbed = content;
          } else {
            textToEmbed = JSON.stringify(content);
          }
        } catch (error) {
          throw new Error(
            `Failed to fetch content from payload store: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } else {
        // Extract from entry value
        textToEmbed = extractTextForEmbedding({
          value: entry.value,
          contentType: entry.contentType ?? null,
        });
      }

      // Verify content hash matches (idempotency check)
      const computedHash = hashContent(textToEmbed);
      if (computedHash !== job.contentHash) {
        console.warn('Content hash mismatch, skipping', {
          ...logContext,
          expected: job.contentHash,
          computed: computedHash,
        });
        await ackMemoryEmbedJob(this.deps.redis, messageId);
        return;
      }

      // Daily budget — exhaustion defers this entry (DLQ-free skip; the row
      // stays unembedded and FTS covers it), it never fails the entry.
      {
        const { consumeEmbeddingBudget, estimateEmbeddingTokens } = await import('@aflow/redis');
        const limits = await this.loadBudgetLimits(job.tenantId);
        const budget = await consumeEmbeddingBudget(this.deps.redis, {
          tenantId: job.tenantId,
          spaceId: (entry as { spaceId?: string | null }).spaceId ?? null,
          tokens: estimateEmbeddingTokens([textToEmbed]),
          limits,
        });
        if (!budget.allowed) {
          console.info('MemoryEmbedder: embedding deferred — daily budget exhausted', {
            ...logContext,
            exceededScope: budget.exceededScope,
          });
          await ackMemoryEmbedJob(this.deps.redis, messageId);
          return;
        }
      }

      // Generate embedding using AI client
      const client = getAIClient();
      const embeddingResponse = await client.generateEmbedding({
        model: job.embeddingModel,
        input: textToEmbed,
        tenantId: job.tenantId,
        runId: job.entryId as SessionId,
        stepExecutionId: job.entryId as StepExecutionId,
      });

      if (embeddingResponse.embeddings.length === 0) {
        throw new Error('No embeddings returned from provider');
      }

      const embedding = embeddingResponse.embeddings[0];
      if (!embedding) {
        throw new Error('No embeddings returned from provider');
      }

      // Upsert embedding into database
      await memoryRepo.upsertEmbedding({
        entryId: job.entryId,
        embeddingModel: job.embeddingModel,
        dims: embedding.length,
        embedding,
        contentHash: job.contentHash,
      });

      // Update entry status to 'ready'
      await memoryRepo.updateEmbeddingStatus({
        entryId: job.entryId,
        status: 'ready',
        contentHash: job.contentHash,
      });

      // Acknowledge job
      await ackMemoryEmbedJob(this.deps.redis, messageId);

      const durationMs = Date.now() - startTime;
      console.info('Embedding job completed', {
        ...logContext,
        durationMs,
        dims: embedding.length,
      });
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      console.error('Embedding job failed', {
        ...logContext,
        error: errorMessage,
        durationMs,
      });

      // Update entry status to 'failed'
      try {
        const tenantContext = createTenantContext(job.tenantId);
        const memoryRepo = createMemoryRepository(this.deps.db, tenantContext);
        await memoryRepo.updateEmbeddingStatus({
          entryId: job.entryId,
          status: 'failed',
          embedError: {
            code: error instanceof AIClientError ? error.code : 'UNKNOWN',
            message: errorMessage,
            timestamp: new Date().toISOString(),
          },
        });
      } catch (updateError) {
        console.error('Failed to update embedding status', {
          ...logContext,
          updateError: updateError instanceof Error ? updateError.message : String(updateError),
        });
      }

      // Publish to DLQ
      try {
        await publishMemoryEmbedJobToDlq(this.deps.redis, job, {
          code: error instanceof AIClientError ? error.code : 'EMBEDDING_FAILED',
          message: errorMessage,
          details: {
            durationMs,
            embeddingModel: job.embeddingModel,
          },
        });
      } catch (dlqError) {
        console.error('Failed to publish to DLQ', {
          ...logContext,
          dlqError: dlqError instanceof Error ? dlqError.message : String(dlqError),
        });
      }

      // Acknowledge job even on failure (we've handled it)
      await ackMemoryEmbedJob(this.deps.redis, messageId);
    }
  }
}
