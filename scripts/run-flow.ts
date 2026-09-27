#!/usr/bin/env npx tsx

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const DEFAULT_TENANT = process.env.X_TENANT_ID ?? 'a0000000-0000-0000-0000-000000000001';

interface ParsedArgs {
  apiUrl: string;
  tenantId: string;
  agentId?: string;
  version?: string;
  agentConfigPath?: string;
  input: Record<string, unknown>;
  wait: boolean;
  parallel: number;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  const out: ParsedArgs = {
    apiUrl: API_URL,
    tenantId: DEFAULT_TENANT,
    input: {},
    wait: false,
    parallel: 1,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--api-url') out.apiUrl = args[++i] ?? out.apiUrl;
    else if (arg === '--tenant-id') out.tenantId = args[++i] ?? out.tenantId;
    else if (arg === '--flow-id' || arg === '--agent-id') out.agentId = args[++i];
    else if (arg === '--version') out.version = args[++i];
    else if (arg === '--flow-config' || arg === '--agent-config') out.agentConfigPath = args[++i];
    else if (arg === '--input') {
      const val = args[++i];
      out.input = val ? (JSON.parse(val) as Record<string, unknown>) : {};
    } else if (arg === '--wait') out.wait = true;
    else if (arg === '--parallel') out.parallel = parseInt(args[++i] ?? '1', 10);
  }

  return out;
}

function buildBody(opts: ParsedArgs): Record<string, unknown> {
  if (opts.agentConfigPath) {
    const path = resolve(process.cwd(), opts.agentConfigPath);
    const content = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const fileInput =
      typeof parsed.input === 'object' && parsed.input
        ? (parsed.input as Record<string, unknown>)
        : {};
    const input = { ...fileInput, ...opts.input };
    return parsed.agentConfig ? { ...parsed, input } : { agentConfig: parsed, input };
  }
  return {
    agentId: opts.agentId,
    version: opts.version,
    input: opts.input,
  };
}

interface RunResponse {
  sessionId: string;
  traceId: string;
  eventsUrl: string;
  status: string;
  outputRef?: string;
  errorRef?: string;
  requiredInput?: { stepExecutionId: string; prompt?: string };
  next?: { kind: string; eventsUrl?: string; requiredInput?: unknown };
}

async function startRun(opts: ParsedArgs, body: Record<string, unknown>): Promise<RunResponse> {
  const res = await fetch(`${opts.apiUrl}/v1/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tenant-ID': opts.tenantId,
      'Idempotency-Key': `run-flow-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`POST /runs failed: HTTP ${res.status} — ${err}`);
  }

  return (await res.json()) as RunResponse;
}

async function waitForTerminal(
  opts: ParsedArgs,
  runId: string,
): Promise<{ status: string; durationMs: number }> {
  const terminal = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'STALLED'];
  const maxWaitMs = 120_000;
  const pollIntervalMs = 500;
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));

    const runRes = await fetch(`${opts.apiUrl}/v1/sessions/${runId}`, {
      headers: { 'X-Tenant-ID': opts.tenantId },
    });
    if (!runRes.ok) continue;
    const run = (await runRes.json()) as { status: string };

    if (terminal.includes(run.status) || run.status === 'PAUSED') {
      return { status: run.status, durationMs: Date.now() - start };
    }
  }

  return { status: 'TIMEOUT', durationMs: Date.now() - start };
}

// ── Parallel mode ──────────────────────────────────────────────────────────

async function runParallel(opts: ParsedArgs): Promise<void> {
  const body = buildBody(opts);
  console.log(`Starting ${String(opts.parallel)} parallel runs...`);

  const starts = Array.from({ length: opts.parallel }, () =>
    startRun(opts, body).catch((err: unknown) => err),
  );
  const responses = await Promise.all(starts);

  const results: Array<{
    runId: string;
    status: string;
    durationMs: number;
    error?: string;
  }> = [];

  const waitPromises = responses.map(async (resp, idx) => {
    if (resp instanceof Error) {
      results[idx] = {
        runId: '(failed)',
        status: 'START_ERROR',
        durationMs: 0,
        error: resp.message,
      };
      return;
    }
    if (opts.wait) {
      const { status, durationMs } = await waitForTerminal(opts, resp.sessionId);
      results[idx] = { sessionId: resp.sessionId, status, durationMs };
    } else {
      results[idx] = { sessionId: resp.sessionId, status: resp.status, durationMs: 0 };
    }
  });

  await Promise.all(waitPromises);

  // Print results
  let succeeded = 0;
  let totalMs = 0;
  let maxMs = 0;

  for (const r of results) {
    if (!r) continue;
    const ms = r.durationMs;
    const suffix = r.error ? `  error: ${r.error}` : '';
    console.log(`  run ${r.sessionId.slice(0, 9)}...  ${r.status}  ${String(ms)}ms${suffix}`);
    if (r.status === 'SUCCEEDED') succeeded++;
    totalMs += ms;
    maxMs = Math.max(maxMs, ms);
  }

  const validResults = results.filter((r): r is NonNullable<typeof r> => r != null);
  const avgMs = validResults.length > 0 ? Math.round(totalMs / validResults.length) : 0;

  // Overlap %: if all runs ran sequentially, total time = sum of durations
  // With parallelism, wall clock = maxMs. Overlap = 1 - maxMs / totalMs
  const overlap = totalMs > 0 ? Math.round((1 - maxMs / totalMs) * 100) : 0;

  console.log('');
  console.log(
    `Summary: ${String(succeeded)}/${String(opts.parallel)} succeeded, avg=${String(avgMs)}ms, max=${String(maxMs)}ms, overlap=${String(overlap)}%`,
  );

  if (succeeded < opts.parallel) process.exit(1);
}

// ── Single run mode ────────────────────────────────────────────────────────

async function runSingle(opts: ParsedArgs): Promise<void> {
  const body = buildBody(opts);
  const data = await startRun(opts, body);

  console.log(`sessionId: ${data.sessionId}`);
  console.log(`traceId: ${data.traceId}`);
  console.log(`eventsUrl: ${data.eventsUrl}`);
  console.log(`status: ${data.status}`);

  if (data.requiredInput) {
    console.log(`requiredInput: stepExecutionId=${data.requiredInput.stepExecutionId}`);
  }
  if (data.next) {
    console.log(`next: ${data.next.kind}`);
  }

  console.log('');
  console.log(
    `Watch: curl "${opts.apiUrl}/v1/sessions/${data.sessionId}/events?limit=50" -H "X-Tenant-ID: ${opts.tenantId}"`,
  );
  console.log(
    `Debug: curl "${opts.apiUrl}/v1/sessions/${data.sessionId}/debug" -H "X-Tenant-ID: ${opts.tenantId}"`,
  );

  if (!opts.wait) return;

  const { status, durationMs } = await waitForTerminal(opts, data.sessionId);
  console.log('');
  console.log(`Final status: ${status} (${String(durationMs)}ms)`);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs();

  if (!opts.agentId && !opts.agentConfigPath) {
    console.error('Error: Either --flow-id or --flow-config is required');
    process.exit(1);
  }

  if (opts.parallel > 1) {
    await runParallel(opts);
  } else {
    await runSingle(opts);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
