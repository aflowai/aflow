/**
 * Streaming persistence - NDJSON format for AI response chunks.
 * Persists streaming chunks to GCS for auditability and replay.
 */
import type { PayloadStore } from '@aflow/payload-store';
import type { PayloadRef, TenantId, SessionId, StepExecutionId } from '@aflow/schemas';
import type { TextStreamChunk, TokenUsage, FinishReason, GenerateTextResponse } from './types.js';

// ============================================================================
// Stream Chunk Types
// ============================================================================

/**
 * NDJSON chunk format for persisted streams.
 */
export interface StreamChunk {
  /** Timestamp in milliseconds */
  ts: number;
  /** Chunk type */
  type: 'text_delta' | 'thinking_delta' | 'tool_call_delta' | 'usage' | 'done' | 'error';
  /** Text delta (for text_delta) */
  delta?: string | undefined;
  /** Tool call ID (for tool_call_delta) */
  toolCallId?: string | undefined;
  /** Tool call name (for tool_call_delta) */
  toolCallName?: string | undefined;
  /** Tool call arguments (for tool_call_delta) */
  toolCallArguments?: string | undefined;
  /** Usage data (for usage) */
  usage?: TokenUsage | undefined;
  /** Finish reason (for done) */
  finishReason?: FinishReason | undefined;
  /** Error details (for error) */
  error?: { code: string; message: string } | undefined;
  /** Provider metadata */
  providerMetadata?: Record<string, unknown> | undefined;
}

/**
 * Stream summary written at the end of streaming.
 */
export interface StreamSummary {
  /** Total chunks */
  totalChunks: number;
  /** Total text length */
  totalTextLength: number;
  /** Start timestamp */
  startedAt: number;
  /** End timestamp */
  finishedAt: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** Final usage */
  usage: TokenUsage;
  /** Finish reason */
  finishReason: FinishReason;
  /** Assembled output */
  output: GenerateTextResponse;
}

// ============================================================================
// Stream Writer
// ============================================================================

/**
 * Configuration for stream writer.
 */
export interface StreamWriterConfig {
  payloadStore: PayloadStore;
  tenantId: TenantId;
  runId: SessionId;
  stepExecutionId: StepExecutionId;
  attempt: number;
}

/**
 * Writer for persisting streaming chunks as NDJSON.
 */
export interface StreamWriter {
  /**
   * Write a chunk to the stream.
   */
  writeChunk(chunk: TextStreamChunk): void;

  /**
   * Write an error chunk.
   */
  writeError(error: { code: string; message: string }): void;

  /**
   * Finalize the stream and persist to GCS.
   * Returns the payload reference for the stored stream.
   */
  finalize(response: GenerateTextResponse): Promise<{
    streamRef: PayloadRef;
    summaryRef: PayloadRef;
  }>;

  /**
   * Get all chunks written so far.
   */
  getChunks(): StreamChunk[];

  /**
   * Get assembled text content.
   */
  getAssembledText(): string;
}

/**
 * Create a stream writer for persisting NDJSON chunks.
 */
export function createStreamWriter(config: StreamWriterConfig): StreamWriter {
  const chunks: StreamChunk[] = [];
  const startedAt = Date.now();
  let assembledText = '';

  return {
    writeChunk(chunk: TextStreamChunk) {
      const streamChunk: StreamChunk = {
        ts: Date.now(),
        type: chunk.type,
      };

      if (chunk.delta !== undefined) {
        streamChunk.delta = chunk.delta;
        assembledText += chunk.delta;
      }
      if (chunk.toolCallId !== undefined) {
        streamChunk.toolCallId = chunk.toolCallId;
      }
      if (chunk.toolCallName !== undefined) {
        streamChunk.toolCallName = chunk.toolCallName;
      }
      if (chunk.toolCallArguments !== undefined) {
        streamChunk.toolCallArguments = chunk.toolCallArguments;
      }
      if (chunk.usage !== undefined) {
        streamChunk.usage = chunk.usage;
      }
      if (chunk.finishReason !== undefined) {
        streamChunk.finishReason = chunk.finishReason;
      }

      chunks.push(streamChunk);
    },

    writeError(error: { code: string; message: string }) {
      chunks.push({
        ts: Date.now(),
        type: 'error',
        error,
      });
    },

    async finalize(response: GenerateTextResponse) {
      const finishedAt = Date.now();

      // Build summary
      const summary: StreamSummary = {
        totalChunks: chunks.length,
        totalTextLength: assembledText.length,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
        usage: response.usage,
        finishReason: response.finishReason,
        output: response,
      };

      // Convert chunks to NDJSON
      const ndjson = chunks.map((c) => JSON.stringify(c)).join('\n');

      // Store the stream
      const streamRef = await config.payloadStore.store({
        tenantId: config.tenantId,
        runId: config.runId,
        stepExecutionId: config.stepExecutionId,
        attempt: config.attempt,
        kind: 'logs', // Using logs kind for stream data
        data: ndjson,
      });

      // Store the summary
      const summaryRef = await config.payloadStore.store({
        tenantId: config.tenantId,
        runId: config.runId,
        stepExecutionId: config.stepExecutionId,
        attempt: config.attempt,
        kind: 'output', // Using output kind for summary
        data: summary,
      });

      return { streamRef, summaryRef };
    },

    getChunks() {
      return [...chunks];
    },

    getAssembledText() {
      return assembledText;
    },
  };
}

// ============================================================================
// Stream Reader
// ============================================================================

/**
 * Reader for loading persisted NDJSON streams.
 */
export interface StreamReader {
  /**
   * Load and parse chunks from a stream reference.
   */
  loadChunks(streamRef: PayloadRef): Promise<StreamChunk[]>;

  /**
   * Load stream summary.
   */
  loadSummary(summaryRef: PayloadRef): Promise<StreamSummary>;

  /**
   * Replay chunks as an async iterable.
   */
  replayChunks(streamRef: PayloadRef): AsyncIterable<StreamChunk>;
}

/**
 * Create a stream reader for loading persisted NDJSON streams.
 */
export function createStreamReader(payloadStore: PayloadStore): StreamReader {
  return {
    async loadChunks(streamRef: PayloadRef): Promise<StreamChunk[]> {
      const ndjson = await payloadStore.retrieve(streamRef);
      if (typeof ndjson !== 'string') {
        throw new Error('Stream data is not a string');
      }

      const lines = ndjson.split('\n').filter((line) => line.trim() !== '');
      const chunks: StreamChunk[] = [];

      for (const line of lines) {
        try {
          chunks.push(JSON.parse(line) as StreamChunk);
        } catch {
          // Skip invalid lines
        }
      }

      return chunks;
    },

    async loadSummary(summaryRef: PayloadRef): Promise<StreamSummary> {
      const summary = await payloadStore.retrieve(summaryRef);
      return summary as StreamSummary;
    },

    async *replayChunks(streamRef: PayloadRef): AsyncIterable<StreamChunk> {
      const chunks = await this.loadChunks(streamRef);
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

// ============================================================================
// Streaming Wrapper for AIClient
// ============================================================================

/**
 * Wrap a streaming response to persist chunks as NDJSON.
 */
export function wrapStreamingResponse<T extends object>(
  streamWriter: StreamWriter,
  originalStream: AsyncIterable<TextStreamChunk>,
  responsePromise: Promise<T>,
): {
  stream: AsyncIterable<TextStreamChunk>;
  response: Promise<
    T & { streamRef?: PayloadRef | undefined; summaryRef?: PayloadRef | undefined }
  >;
} {
  async function* wrappedStream(): AsyncGenerator<TextStreamChunk> {
    for await (const chunk of originalStream) {
      streamWriter.writeChunk(chunk);
      yield chunk;
    }
  }

  const wrappedResponse = responsePromise.then(async (response) => {
    // Finalize the stream after response is complete
    if ('usage' in response && 'finishReason' in response) {
      const { streamRef, summaryRef } = await streamWriter.finalize(
        response as unknown as GenerateTextResponse,
      );
      return {
        ...response,
        streamRef,
        summaryRef,
      };
    }
    return response as T & { streamRef?: PayloadRef; summaryRef?: PayloadRef };
  });

  return {
    stream: wrappedStream(),
    response: wrappedResponse,
  };
}
