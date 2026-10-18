/**
 * Contract: a job log's tail is taken without reading the whole log under the
 * inline budget. A log over that budget still yields its last 300 lines within
 * Plan 321 P0.3's 60 KB bound, the excerpt read from a stream's end is the one
 * the whole log gives, wherever its chunks break, and a small log reads as it
 * always has.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ExecutorContext } from '@aflow/executor-runtime';
import {
  ApiCallInputSchema,
  JOB_LOG_EXCERPT_MAX_BYTES,
  JOB_LOG_EXCERPT_MAX_LINES,
  JOB_LOG_TAIL_PRESET,
  type JobLogExcerpt,
  JobLogExcerptSchema,
} from '@aflow/schemas';
import { readBodyTail } from './bodyTail.js';
import { DEFAULT_INLINE_RESPONSE_BYTES } from './config.js';
import { JOB_LOG_READ_WINDOW_BYTES, jobLogTail } from './githubShepherd.js';
import { processResponse } from './response.js';
import type { ResolvedCall } from './types.js';

function makeCtx(): ExecutorContext {
  return {
    job: { spaceId: 'space-1' },
    tenantId: 'tenant-1',
    runId: 'run-1',
    stepExecutionId: 'step-1',
    attempt: 0,
    writePayload: vi.fn(async (kind: string) => `payload:${kind}`),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as ExecutorContext;
}

const RESOLVED = {
  url: 'https://api.github.com/repos/aflowai/aflow/actions/jobs/7/logs',
  method: 'GET',
  headers: {},
  body: undefined,
  egressPolicy: {} as never,
  apiId: 'github',
  endpointId: 'getJobLogs',
  endpoint: {
    endpointId: 'getJobLogs',
    name: "Get a job's log",
    method: 'GET',
    pathTemplate: '/repos/{owner}/{repo}/actions/jobs/{job_id}/logs',
    params: [],
    tags: [],
    responseTransformPresetId: JOB_LOG_TAIL_PRESET,
  } as never,
} as ResolvedCall;

const INPUT = ApiCallInputSchema.parse({ apiId: 'github', endpointId: 'getJobLogs' });

/** A runner's log: numbered, coloured lines with CRLF breaks. */
function runnerLog(lines: number): string {
  return Array.from(
    { length: lines },
    (_, i) =>
      `2026-10-18T10:00:00Z \u001b[36mstep\u001b[0m line ${String(i)} ${'.'.repeat(40)}\r\n`,
  ).join('');
}

/** The log as a stream in `chunkBytes` pieces, which fall wherever they fall. */
function streamed(log: string, chunkBytes: number, headers: Record<string, string> = {}): Response {
  const bytes = new TextEncoder().encode(log);
  let at = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(at, at + chunkBytes));
      at += chunkBytes;
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...headers },
  });
}

async function readTail(response: Response, maxBytes?: number): Promise<JobLogExcerpt> {
  const input =
    maxBytes === undefined ? INPUT : { ...INPUT, response: { ...INPUT.response, maxBytes } };
  const result = await processResponse(makeCtx(), input, response, 5, RESOLVED.url, RESOLVED);
  return JobLogExcerptSchema.parse(result.data);
}

describe('getJobLogs — the tail of a log over the inline budget', () => {
  const LINES = 160_000;
  const big = runnerLog(LINES);

  it('the log is over the inline budget', () => {
    expect(Buffer.byteLength(big)).toBeGreaterThan(DEFAULT_INLINE_RESPONSE_BYTES);
  });

  it('still yields its last 300 lines under 60 KB, streamed with no length given', async () => {
    const tail = await readTail(streamed(big, 64 * 1024));
    expect(tail.lines).toBe(JOB_LOG_EXCERPT_MAX_LINES);
    expect(tail.totalLines).toBe(LINES);
    expect(tail.truncated).toBe(true);
    expect(tail.excerpt.split('\n').at(-1)).toMatch(new RegExp(`line ${String(LINES - 1)} `));
    expect(tail.excerpt.split('\n')[0]).toMatch(new RegExp(`line ${String(LINES - 300)} `));
    expect(tail.excerpt).not.toContain('\u001b');
    expect(tail.bytes).toBeLessThanOrEqual(JOB_LOG_EXCERPT_MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify(tail.excerpt))).toBeLessThanOrEqual(
      JOB_LOG_EXCERPT_MAX_BYTES,
    );
  });

  it('is not refused for a Content-Length over the inline budget', async () => {
    const length = String(Buffer.byteLength(big));
    const tail = await readTail(streamed(big, 256 * 1024, { 'content-length': length }));
    expect(tail.lines).toBe(JOB_LOG_EXCERPT_MAX_LINES);
    expect(tail.totalLines).toBe(LINES);
  });

  it('an explicit maxBytes still bounds what is streamed', async () => {
    await expect(readTail(streamed(big, 64 * 1024), 1_000_000)).rejects.toMatchObject({
      aflowError: { code: 'API_RESPONSE_TOO_LARGE' },
    });
  });
});

describe('getJobLogs — the tail read from a stream is the whole log’s', () => {
  const log = runnerLog(30_000);

  it.each([13, 4096, 65_536, JOB_LOG_READ_WINDOW_BYTES - 1, JOB_LOG_READ_WINDOW_BYTES + 3])(
    'wherever %i-byte chunks break',
    async (chunkBytes) => {
      const tail = await readBodyTail(
        streamed(log, chunkBytes),
        JOB_LOG_READ_WINDOW_BYTES,
        Number.MAX_SAFE_INTEGER,
      );
      const fromTail = jobLogTail(tail.text, tail.skipped);
      const whole = jobLogTail(log);
      expect(tail.skipped.bytes).toBeGreaterThan(0);
      expect(fromTail).toEqual(whole);
    },
  );
});

describe('getJobLogs — a small log', () => {
  it('reads as it always has: the whole log, its tail taken from it', async () => {
    const log = runnerLog(1_000);
    expect(await readTail(streamed(log, 4096))).toEqual(jobLogTail(log));
    expect(await readTail(streamed('a\nb\n', 4096))).toMatchObject({
      excerpt: 'a\nb',
      lines: 2,
      totalLines: 2,
      truncated: false,
    });
  });
});
