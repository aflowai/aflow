#!/usr/bin/env npx tsx
/**
 * perf-check.ts — Performance regression checker
 *
 * Runs a flow N times, computes p50/p95/p99 latency, fails if p95 > threshold.
 * Useful in CI or locally to catch performance regressions early.
 *
 * Usage:
 *   npx tsx scripts/perf-check.ts --flow-config scripts/test-flows/memory-put-get.json --runs 10 --max-p95 500
 *   npx tsx scripts/perf-check.ts --flow-id my-flow --runs 20 --max-p95 2000
 *
 * Options:
 *   --api-url      API base URL (default: http://localhost:3000)
 *   --tenant-id    X-Tenant-ID header
 *   --flow-id      Saved flow ID
 *   --flow-config  Path to JSON file with inline flowConfig
 *   --input        JSON input (default: {})
 *   --runs         Number of sequential runs (default: 10)
 *   --max-p95      p95 latency threshold in ms — exit 1 if exceeded (default: no threshold)
 *   --concurrency  Run N at a time instead of sequentially (default: 1)
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const DEFAULT_TENANT = process.env.X_TENANT_ID ?? 'a0000000-0000-0000-0000-000000000001';

interface PerfOpts {
  apiUrl: string;
  tenantId: string;
  flowId?: string;
  flowConfigPath?: string;
  input: Record<string, unknown>;
  runs: number;
  maxP95?: number;
  concurrency: number;
}

function parseArgs(): PerfOpts {
  const args = process.argv.slice(2);
  const out: PerfOpts = {
    apiUrl: API_URL,
    tenantId: DEFAULT_TENANT,
    input: {},
    runs: 10,
    concurrency: 1,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--api-url') out.apiUrl = args[++i] ?? out.apiUrl;
    else if (arg === '--tenant-id') out.tenantId = args[++i] ?? out.tenantId;
    else if (arg === '--flow-id') out.flowId = args[++i];
    else if (arg === '--flow-config') out.flowConfigPath = args[++i];
    else if (arg === '--input') {
      const val = args[++i];
      out.input = val ? (JSON.parse(val) as Record<string, unknown>) : {};
    } else if (arg === '--runs') out.runs = parseInt(args[++i] ?? '10', 10);
    else if (arg === '--max-p95') out.maxP95 = parseInt(args[++i] ?? '0', 10);
    else if (arg === '--concurrency') out.concurrency = parseInt(args[++i] ?? '1', 10);
  }

  return out;
}

function buildBody(opts: PerfOpts): Record<string, unknown> {
  if (opts.flowConfigPath) {
    const path = resolve(process.cwd(), opts.flowConfigPath);
    const content = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const fileInput =
      typeof parsed.input === 'object' && parsed.input
        ? (parsed.input as Record<string, unknown>)
        : {};
    const input = { ...fileInput, ...opts.input };
    return parsed.flowConfig ? { ...parsed, input } : { flowConfig: parsed, input };
  }
  return { flowId: opts.flowId, input: opts.input };
}

interface RunResult {
  runId: string;
  status: string;
  durationMs: number;
}

async function executeRun(opts: PerfOpts, body: Record<string, unknown>): Promise<RunResult> {
  const start = Date.now();

  const res = await fetch(`${opts.apiUrl}/v1/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tenant-ID': opts.tenantId,
      'Idempotency-Key': `perf-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    return { runId: '(failed)', status: 'START_ERROR', durationMs: Date.now() - start };
  }

  const data = (await res.json()) as { runId: string; status: string };
  const terminal = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'STALLED'];
  const maxWaitMs = 120_000;
  const pollIntervalMs = 300;

  while (Date.now() - start < maxWaitMs) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const runRes = await fetch(`${opts.apiUrl}/v1/sessions/${data.runId}`, {
      headers: { 'X-Tenant-ID': opts.tenantId },
    });
    if (!runRes.ok) continue;
    const run = (await runRes.json()) as { status: string };
    if (terminal.includes(run.status) || run.status === 'PAUSED') {
      return { runId: data.runId, status: run.status, durationMs: Date.now() - start };
    }
  }

  return { runId: data.runId, status: 'TIMEOUT', durationMs: Date.now() - start };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function main(): Promise<void> {
  const opts = parseArgs();

  if (!opts.flowId && !opts.flowConfigPath) {
    console.error('Error: Either --flow-id or --flow-config is required');
    process.exit(1);
  }

  const body = buildBody(opts);
  const results: RunResult[] = [];

  console.log(
    `Running ${String(opts.runs)} iterations (concurrency=${String(opts.concurrency)})...`,
  );
  console.log('');

  if (opts.concurrency <= 1) {
    // Sequential
    for (let i = 0; i < opts.runs; i++) {
      const r = await executeRun(opts, body);
      results.push(r);
      const num = String(i + 1).padStart(String(opts.runs).length);
      console.log(
        `  [${num}/${String(opts.runs)}] ${r.runId.slice(0, 9)}... ${r.status} ${String(r.durationMs)}ms`,
      );
    }
  } else {
    // Concurrent batches
    let completed = 0;
    const tasks: Array<Promise<void>> = [];
    const semaphore = { active: 0 };

    for (let i = 0; i < opts.runs; i++) {
      while (semaphore.active >= opts.concurrency) {
        await new Promise((r) => setTimeout(r, 50));
      }
      semaphore.active++;
      const task = executeRun(opts, body).then((r) => {
        semaphore.active--;
        results.push(r);
        completed++;
        const num = String(completed).padStart(String(opts.runs).length);
        console.log(
          `  [${num}/${String(opts.runs)}] ${r.runId.slice(0, 9)}... ${r.status} ${String(r.durationMs)}ms`,
        );
      });
      tasks.push(task);
    }
    await Promise.all(tasks);
  }

  // Compute stats
  const succeeded = results.filter((r) => r.status === 'SUCCEEDED');
  const failed = results.filter((r) => r.status !== 'SUCCEEDED');
  const durations = succeeded.map((r) => r.durationMs).sort((a, b) => a - b);

  console.log('');
  console.log('── Results ──');
  console.log(`Runs: ${String(succeeded.length)} succeeded, ${String(failed.length)} failed`);

  if (durations.length > 0) {
    const p50 = percentile(durations, 50);
    const p95 = percentile(durations, 95);
    const p99 = percentile(durations, 99);
    const min = durations[0];
    const max = durations[durations.length - 1];
    const avg = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);

    console.log(`  min:  ${String(min)}ms`);
    console.log(`  avg:  ${String(avg)}ms`);
    console.log(`  p50:  ${String(p50)}ms`);
    console.log(`  p95:  ${String(p95)}ms`);
    console.log(`  p99:  ${String(p99)}ms`);
    console.log(`  max:  ${String(max)}ms`);

    if (opts.maxP95 !== undefined && p95 > opts.maxP95) {
      console.log('');
      console.error(`FAIL: p95 (${String(p95)}ms) exceeds threshold (${String(opts.maxP95)}ms)`);
      process.exit(1);
    }
  }

  if (failed.length > 0) {
    console.log('');
    console.error(`WARN: ${String(failed.length)} run(s) did not succeed`);
    for (const r of failed) {
      console.error(`  ${r.runId.slice(0, 9)}... ${r.status}`);
    }
  }

  console.log('');
  console.log('PASS');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
