import type { AflowError } from '@aflow/schemas';
import {
  SearchWebInputSchema,
  SearchWebFetchInputSchema,
  SearchWebDownloadInputSchema,
} from '@aflow/schemas';
import type { StepHandler, ExecutorContext, StepResult } from '@aflow/executor-runtime';
import {
  successWithData,
  failureWithError,
  validationError,
  providerError,
} from '@aflow/executor-runtime';
import {
  type CredentialResolver,
  type CredentialContext,
  credentialMissingMessage,
} from '@aflow/credential-resolver';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PayloadStore } from '@aflow/payload-store';
import type { Redis } from '@aflow/redis';
import { saveBytesToMemoryDoc, runOrigin, MemoryWriteDeniedError } from '@aflow/memory-store';

import {
  MAX_EXTRACTED_CONTENT_CHARS,
  type SearchRequest,
  type FetchRequest,
} from './providers/types.js';
import { BraveSearchProvider, BraveSearchError } from './providers/brave.js';
import { JinaFetchProvider, JinaFetchError } from './providers/jina.js';

export interface SearchHandlerDeps {
  credentialResolver: CredentialResolver;
  /** Required for toMemoryPath saves; fetch works inline-only without them. */
  db?: PostgresJsDatabase;
  payloadStore?: PayloadStore;
  redis?: Redis;
}

export class SearchHandler implements StepHandler {
  readonly stepType = 'search';
  private readonly resolver: CredentialResolver;
  private readonly db?: PostgresJsDatabase;
  private readonly payloadStore?: PayloadStore;
  private readonly redis?: Redis;

  constructor(deps: SearchHandlerDeps) {
    this.resolver = deps.credentialResolver;
    if (deps.db) this.db = deps.db;
    if (deps.payloadStore) this.payloadStore = deps.payloadStore;
    if (deps.redis) this.redis = deps.redis;
  }

  async validate(ctx: ExecutorContext): Promise<AflowError | null> {
    const input = await ctx.readPayload(ctx.job.inputRef);
    if (typeof input !== 'object' || input === null) {
      return validationError('Input must be an object');
    }

    if (ctx.operationId === 'search.web.fetch') {
      const parsed = SearchWebFetchInputSchema.safeParse(input);
      if (!parsed.success) {
        return validationError(`Invalid fetch input: ${parsed.error.message}`);
      }
    } else if (ctx.operationId === 'search.web.download') {
      const parsed = SearchWebDownloadInputSchema.safeParse(input);
      if (!parsed.success) {
        return validationError(`Invalid download input: ${parsed.error.message}`);
      }
    } else {
      const parsed = SearchWebInputSchema.safeParse(input);
      if (!parsed.success) {
        return validationError(`Invalid search input: ${parsed.error.message}`);
      }
    }

    return null;
  }

  async execute(ctx: ExecutorContext): Promise<StepResult> {
    if (ctx.operationId === 'search.web.fetch') {
      return this.executeFetch(ctx);
    }
    if (ctx.operationId === 'search.web.download') {
      return this.executeDownload(ctx);
    }
    return this.executeSearch(ctx);
  }

  /**
   * Build a CredentialContext from the step job message.
   */
  private buildCredCtx(ctx: ExecutorContext): CredentialContext {
    const { tenantId, credentialOwnerId, spaceId } = ctx.job;
    if (!credentialOwnerId || !spaceId) {
      throw new Error(
        'Step job is missing credentialOwnerId or spaceId. ' +
          'This run may have been created before BYOK credentials were enabled.',
      );
    }
    return { tenantId, credentialOwnerId, spaceId };
  }

  // ---------------------------------------------------------------------------
  // search.web.search
  // ---------------------------------------------------------------------------

  private async executeSearch(ctx: ExecutorContext): Promise<StepResult> {
    const inputRaw = await ctx.readPayload(ctx.job.inputRef);
    const parsed = SearchWebInputSchema.safeParse(inputRaw);
    if (!parsed.success) {
      return failureWithError(ctx, validationError(`Invalid input: ${parsed.error.message}`));
    }
    const input = parsed.data;

    // Resolve Brave Search credentials
    const credCtx = this.buildCredCtx(ctx);
    const resolved = await this.resolver.resolve('brave', credCtx);
    if (!resolved) {
      return failureWithError(
        ctx,
        providerError(credentialMissingMessage('brave'), { retryable: false }),
      );
    }
    const apiKey = resolved.secrets['api_key'];
    if (!apiKey) {
      return failureWithError(
        ctx,
        providerError(
          'Brave Search credential exists but has no api_key. Update it in Settings → Credentials.',
          { retryable: false },
        ),
      );
    }

    const searchProvider = new BraveSearchProvider({ apiKey });

    try {
      const request: SearchRequest = {
        query: input.query,
        maxResults: input.maxResults,
        safeSearch: input.safeSearch,
        includeImages: input.includeImages,
        includeNews: input.includeNews,
        fetchSnippets: input.fetchSnippets,
        signal: ctx.signal,
      };
      if (input.region !== undefined) request.region = input.region;
      if (input.language !== undefined) request.language = input.language;
      if (input.timeRange !== undefined) request.timeRange = input.timeRange;

      const response = await searchProvider.search(request);

      const output: Record<string, unknown> = {
        results: response.results,
        executedQuery: response.executedQuery,
        provider: searchProvider.name,
        durationMs: response.durationMs,
      };
      if (response.totalResults != null) {
        output['totalResults'] = response.totalResults;
      }

      return await successWithData(ctx, output);
    } catch (error) {
      const isBraveError = error instanceof BraveSearchError;
      const retryable = isBraveError ? error.retryable : true;
      const msg = error instanceof Error ? error.message : String(error);

      ctx.log.error('Search failed', {
        error: msg,
        provider: searchProvider.name,
        retryable,
      });

      return failureWithError(ctx, providerError(`Search failed: ${msg}`, { retryable }));
    }
  }

  // ---------------------------------------------------------------------------
  // search.web.fetch
  // ---------------------------------------------------------------------------

  private async executeFetch(ctx: ExecutorContext): Promise<StepResult> {
    const inputRaw = await ctx.readPayload(ctx.job.inputRef);
    const parsed = SearchWebFetchInputSchema.safeParse(inputRaw);
    if (!parsed.success) {
      return failureWithError(ctx, validationError(`Invalid fetch input: ${parsed.error.message}`));
    }
    const input = parsed.data;

    const fetchProvider = await this.buildFetchProvider(ctx);

    try {
      const request: FetchRequest = {
        url: input.url,
        format: input.format,
        maxContentLength: input.maxContentLength,
        includeImages: input.includeImages,
        includeLinks: input.includeLinks,
        screenshot: input.screenshot,
        timeoutMs: input.timeoutMs,
        signal: ctx.signal,
      };

      const response = await fetchProvider.fetch(request);

      const output: Record<string, unknown> = {
        content: response.content,
        url: response.url,
        wordCount: response.wordCount,
        truncated: response.truncated,
        provider: fetchProvider.name,
        durationMs: response.durationMs,
      };
      if (response.title) output['title'] = response.title;
      if (response.description) output['description'] = response.description;
      if (response.siteName) output['siteName'] = response.siteName;
      if (response.publishedDate) output['publishedDate'] = response.publishedDate;
      if (response.screenshotUrl) output['screenshotUrl'] = response.screenshotUrl;
      if (response.links) output['links'] = response.links;

      return await successWithData(ctx, output);
    } catch (error) {
      const isJinaError = error instanceof JinaFetchError;
      const retryable = isJinaError ? error.retryable : true;
      const msg = error instanceof Error ? error.message : String(error);

      ctx.log.error('Fetch failed', {
        error: msg,
        url: input.url.substring(0, 200),
        provider: fetchProvider.name,
        retryable,
      });

      return failureWithError(ctx, providerError(`Fetch failed: ${msg}`, { retryable }));
    }
  }

  // ---------------------------------------------------------------------------
  // search.web.download
  // ---------------------------------------------------------------------------

  private async executeDownload(ctx: ExecutorContext): Promise<StepResult> {
    const inputRaw = await ctx.readPayload(ctx.job.inputRef);
    const parsed = SearchWebDownloadInputSchema.safeParse(inputRaw);
    if (!parsed.success) {
      return failureWithError(
        ctx,
        validationError(`Invalid download input: ${parsed.error.message}`),
      );
    }
    const input = parsed.data;

    if (!this.db || !this.payloadStore) {
      return failureWithError(
        ctx,
        validationError(
          'search.web.download requires database + payload store access (server misconfiguration).',
        ),
      );
    }
    const spaceId = ctx.job.spaceId;
    if (!spaceId) {
      return failureWithError(
        ctx,
        validationError('search.web.download requires a space context.'),
      );
    }

    const fetchProvider = await this.buildFetchProvider(ctx);

    try {
      const response = await fetchProvider.fetch({
        url: input.url,
        format: input.format,
        maxContentLength: MAX_EXTRACTED_CONTENT_CHARS,
        includeImages: input.includeImages,
        includeLinks: false,
        screenshot: false,
        timeoutMs: input.timeoutMs,
        signal: ctx.signal,
      });

      if (response.truncated) {
        return await failureWithError(
          ctx,
          providerError(
            `Extracted content exceeds the ${String(MAX_EXTRACTED_CONTENT_CHARS)}-char ` +
              'extraction cap — the full document cannot be saved completely. Fetch a more ' +
              'specific page/section, or use api.http.download through a bound API for raw files.',
            { retryable: false },
          ),
        );
      }

      let saved: { savedTo: string; sizeBytes: number };
      try {
        saved = await saveBytesToMemoryDoc({
          db: this.db,
          payloadStore: this.payloadStore,
          ...(this.redis ? { redis: this.redis } : {}),
          log: ctx.log,
          tenantId: ctx.tenantId,
          origin: runOrigin(ctx),
          spaceId,
          path: input.toMemoryPath,
          mimeType: input.format === 'markdown' ? 'text/markdown' : 'text/plain',
          indexing: input.indexing,
          tags: ['web_fetch'],
          content: { kind: 'text', text: response.content },
          contentType: null,
        });
      } catch (err) {
        if (err instanceof MemoryWriteDeniedError) {
          return await failureWithError(ctx, validationError(err.message));
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith('MEMORY_')) {
          return await failureWithError(ctx, validationError(msg));
        }
        throw err;
      }

      const output: Record<string, unknown> = {
        savedTo: saved.savedTo,
        sizeBytes: saved.sizeBytes,
        url: response.url,
        wordCount: response.wordCount,
        provider: fetchProvider.name,
        durationMs: response.durationMs,
      };
      if (response.title) output['title'] = response.title;
      if (response.description) output['description'] = response.description;
      if (response.siteName) output['siteName'] = response.siteName;
      if (response.publishedDate) output['publishedDate'] = response.publishedDate;

      return await successWithData(ctx, output);
    } catch (error) {
      const isJinaError = error instanceof JinaFetchError;
      const retryable = isJinaError ? error.retryable : true;
      const msg = error instanceof Error ? error.message : String(error);

      ctx.log.error('Download failed', {
        error: msg,
        url: input.url.substring(0, 200),
        provider: fetchProvider.name,
        retryable,
      });

      return failureWithError(ctx, providerError(`Download failed: ${msg}`, { retryable }));
    }
  }

  /** Jina credentials are optional — the free tier works without a key. */
  private async buildFetchProvider(ctx: ExecutorContext): Promise<JinaFetchProvider> {
    const credCtx = this.buildCredCtx(ctx);
    const resolved = await this.resolver.resolve('jina', credCtx);
    const apiKey = resolved?.secrets['api_key'];
    return new JinaFetchProvider(apiKey ? { apiKey } : undefined);
  }
}
