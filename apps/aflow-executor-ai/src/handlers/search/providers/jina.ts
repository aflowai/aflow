/**
 * Jina Reader provider for web page content extraction.
 *
 * Docs: https://jina.ai/reader/
 * Fetches clean, LLM-friendly markdown from any URL.
 * Works without an API key (free tier); key unlocks higher rate limits.
 */
import {
  MAX_EXTRACTED_CONTENT_CHARS,
  type FetchProvider,
  type FetchRequest,
  type FetchProviderResponse,
} from './types.js';

const JINA_BASE_URL = 'https://r.jina.ai';

// Transport bound so a pathological response cannot exhaust executor memory:
// worst-case JSON string escaping expands one content character to six bytes
// ("\uXXXX"), plus headroom for the metadata envelope (title, description,
// links map). Applied while streaming, BEFORE the body is buffered or parsed.
const JSON_ESCAPED_BYTES_PER_CHAR = 6;
const ENVELOPE_HEADROOM_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES =
  MAX_EXTRACTED_CONTENT_CHARS * JSON_ESCAPED_BYTES_PER_CHAR + ENVELOPE_HEADROOM_BYTES;

/** Jina Reader JSON response shape (subset of fields we use) */
interface JinaReaderResponse {
  code?: number;
  data?: {
    content?: string;
    title?: string;
    description?: string;
    url?: string;
    siteName?: string;
    publishedTime?: string;
    screenshotUrl?: string;
    links?: Record<string, string>;
    usage?: { tokens?: number };
  };
}

export class JinaFetchProvider implements FetchProvider {
  readonly name = 'jina';
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;

  constructor(config?: { apiKey?: string; baseUrl?: string }) {
    this.apiKey = config?.apiKey;
    this.baseUrl = config?.baseUrl ?? JINA_BASE_URL;
  }

  async fetch(request: FetchRequest): Promise<FetchProviderResponse> {
    const startMs = Date.now();

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, request.timeoutMs);

    if (request.signal) {
      if (request.signal.aborted) {
        clearTimeout(timeout);
        throw new JinaFetchError('Fetch request aborted before execution', 0, false);
      }
      request.signal.addEventListener(
        'abort',
        () => {
          controller.abort();
        },
        { once: true },
      );
    }

    try {
      const url = `${this.baseUrl}/${request.url}`;
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'X-Return-Format': request.format === 'text' ? 'text' : 'markdown',
      };

      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }
      if (request.includeImages) {
        headers['X-With-Images'] = 'true';
      }
      if (request.includeLinks) {
        headers['X-With-Links'] = 'true';
      }
      if (request.screenshot) {
        headers['X-With-Screenshot'] = 'true';
      }

      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        const status = response.status;
        const body = await response.text().catch(() => '');
        if (status === 402) {
          throw new JinaFetchError('Jina Reader rate limit exceeded', status, true);
        }
        if (status === 404) {
          throw new JinaFetchError(`Page not found: ${request.url}`, status, false);
        }
        throw new JinaFetchError(
          `Jina Reader error: ${String(status)} ${body.slice(0, 200)}`,
          status,
          status >= 500,
        );
      }

      const data = JSON.parse(
        await readBodyWithByteCap(response, MAX_RESPONSE_BYTES, controller),
      ) as JinaReaderResponse;
      const durationMs = Date.now() - startMs;

      let content = data.data?.content ?? '';
      let truncated = false;

      if (content.length > request.maxContentLength) {
        content = content.slice(0, request.maxContentLength);
        truncated = true;
      }

      const wordCount = content.trim() === '' ? 0 : content.split(/\s+/).length;

      // Build links array from Jina's { text: url } map
      let links: Array<{ text: string; url: string }> | undefined;
      if (request.includeLinks && data.data?.links) {
        links = Object.entries(data.data.links).map(([text, linkUrl]) => ({
          text,
          url: linkUrl,
        }));
      }

      const result: FetchProviderResponse = {
        content,
        url: data.data?.url ?? request.url,
        wordCount,
        truncated,
        durationMs,
      };
      if (data.data?.title) result.title = data.data.title;
      if (data.data?.description) result.description = data.data.description;
      if (data.data?.siteName) result.siteName = data.data.siteName;
      if (data.data?.publishedTime) result.publishedDate = data.data.publishedTime;
      if (data.data?.screenshotUrl) result.screenshotUrl = data.data.screenshotUrl;
      if (links && links.length > 0) result.links = links;

      return result;
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readBodyWithByteCap(
  response: Response,
  capBytes: number,
  controller: AbortController,
): Promise<string> {
  const body = response.body;
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > capBytes) {
      controller.abort();
      throw new JinaFetchError(
        `Jina Reader response exceeded the ${String(capBytes)}-byte transport cap — ` +
          'the page is too large to extract. Fetch a more specific page or section.',
        response.status,
        false,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export class JinaFetchError extends Error {
  readonly statusCode: number;
  readonly retryable: boolean;

  constructor(message: string, statusCode: number, retryable: boolean) {
    super(message);
    this.name = 'JinaFetchError';
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}
