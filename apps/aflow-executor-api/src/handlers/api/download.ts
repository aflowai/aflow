/**
 * api.http.download — the destination-mandated narrowing of api.http.call.
 *
 * The op has no inline surface: it validates a required `toMemoryPath`, then
 * synthesizes the equivalent ApiCallInput with `response.saveTo` forced. The
 * handler runs that synthesized call through the SAME resolve → egress → retry
 * → saveResponseBodyToMemory path (no duplicated HTTP/egress/security logic),
 * then maps the result to the destination-only { path, sizeBytes, contentType }
 * output.
 */
import { ApiCallInputSchema, buildOperationId } from '@aflow/schemas';
import type { ApiCallInput, ApiHttpDownloadInput, ApiHttpDownloadOutput } from '@aflow/schemas';
import { apiError } from '../../lib/api-errors.js';
import { ApiExecutionError } from './types.js';
import type { ApiCallResultData } from './execution.js';

export const API_HTTP_DOWNLOAD_OPERATION_ID = buildOperationId('api', 'http', 'download');

/**
 * Narrow an api.http.download request into the equivalent api.http.call with a
 * forced `saveTo` destination. Returns a fully-parsed ApiCallInput so the rest
 * of the handler is oblivious to which op it was invoked as.
 */
export function buildDownloadApiCallInput(download: ApiHttpDownloadInput): ApiCallInput {
  return ApiCallInputSchema.parse({
    ...(download.apiId !== undefined ? { apiId: download.apiId } : {}),
    ...(download.endpointId !== undefined ? { endpointId: download.endpointId } : {}),
    ...(download.bindingId !== undefined ? { bindingId: download.bindingId } : {}),
    ...(download.url !== undefined ? { url: download.url } : {}),
    ...(download.params !== undefined ? { params: download.params } : {}),
    ...(download.queryParams !== undefined ? { queryParams: download.queryParams } : {}),
    ...(download.headers !== undefined ? { headers: download.headers } : {}),
    timeoutMs: download.timeoutMs,
    response: {
      saveTo: {
        path: download.toMemoryPath,
        ...(download.docType !== undefined ? { docType: download.docType } : {}),
        ...(download.mimeType !== undefined ? { mimeType: download.mimeType } : {}),
        indexing: download.indexing,
      },
    },
  });
}

/** Map the shared HTTP result to the download op's destination-only output. */
export function mapDownloadOutput(data: ApiCallResultData): ApiHttpDownloadOutput {
  if (data.savedTo === undefined) {
    // Only a 2xx/3xx response streams to memory; a non-ok download has no file.
    throw new ApiExecutionError(
      apiError(
        'API_DOWNLOAD_FAILED',
        `Download did not produce a file — the server returned HTTP ${String(data.statusCode)} ` +
          'and only a 2xx/3xx response streams to a memory path. Check the URL/endpoint and retry.',
        { retryable: false, details: { statusCode: data.statusCode } },
      ),
    );
  }
  return {
    path: data.savedTo,
    sizeBytes: data.sizeBytes ?? 0,
    ...(data.parsedMeta?.contentType !== undefined
      ? { contentType: data.parsedMeta.contentType }
      : {}),
  };
}
