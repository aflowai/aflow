#!/usr/bin/env npx tsx

const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const DEFAULT_TENANT = process.env.X_TENANT_ID ?? 'a0000000-0000-0000-0000-000000000001';

function parseArgs(): {
  runId: string;
  apiUrl: string;
  tenantId: string;
  limit: number;
  hydrate: boolean;
  follow: boolean;
  timing: boolean;
} {
  const args = process.argv.slice(2);
  const runId = args.find((a) => !a.startsWith('--'));
  if (!runId) {
    console.error(
      'Usage: npx tsx scripts/tail-run-events.ts <runId> [--hydrate] [--follow] [--timing]',
    );
    process.exit(1);
  }

  let apiUrl = API_URL;
  let tenantId = DEFAULT_TENANT;
  let limit = 50;
  let hydrate = false;
  let follow = false;
  let timing = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--api-url') apiUrl = args[++i] ?? apiUrl;
    else if (args[i] === '--tenant-id') tenantId = args[++i] ?? tenantId;
    else if (args[i] === '--limit') limit = parseInt(args[++i] ?? '50', 10);
    else if (args[i] === '--hydrate') hydrate = true;
    else if (args[i] === '--follow') follow = true;
    else if (args[i] === '--timing') timing = true;
  }

  return { runId, apiUrl, tenantId, limit, hydrate, follow, timing };
}

// ── Step timing tracker ────────────────────────────────────────────────────

interface StepTiming {
  stepId: string;
  stepType: string;
  operationId: string;
  scheduledAt?: number;
  startedAt?: number;
  completedAt?: number;
  status?: string;
}

const stepTimings = new Map<string, StepTiming>();
let firstEventTs: number | undefined;
let lastEventTs: number | undefined;

function parseTimestamp(ts: string): number {
  const d = new Date(ts);
  return d.getTime();
}

function trackTiming(e: {
  eventType: string;
  timestamp: string;
  data?: Record<string, unknown>;
}): string {
  const data = e.data ?? {};
  const stepId = data.stepId as string | undefined;
  if (!stepId) return '';

  const ts = parseTimestamp(e.timestamp);
  if (firstEventTs === undefined) firstEventTs = ts;
  lastEventTs = ts;

  let entry = stepTimings.get(stepId);
  if (!entry) {
    entry = {
      stepId,
      stepType: (data.stepType as string) ?? '',
      operationId: (data.operationId as string) ?? '',
    };
    stepTimings.set(stepId, entry);
  }

  // Update operationId/stepType from metadata if available
  const meta = data.metadata as Record<string, unknown> | undefined;
  if (meta?.operationId) entry.operationId = meta.operationId as string;
  if (data.stepType) entry.stepType = data.stepType as string;

  let timingStr = '';

  switch (e.eventType) {
    case 'StepScheduled':
      entry.scheduledAt = ts;
      break;
    case 'StepStarted':
      entry.startedAt = ts;
      if (entry.scheduledAt !== undefined) {
        const queueWait = ts - entry.scheduledAt;
        timingStr = `  +${String(queueWait)}ms (queue wait)`;
      }
      break;
    case 'StepSucceeded':
    case 'StepFailed':
    case 'StepPausedForInput':
      entry.completedAt = ts;
      entry.status = e.eventType.replace('Step', '').toUpperCase();
      if (entry.startedAt !== undefined) {
        const exec = ts - entry.startedAt;
        const total = entry.scheduledAt !== undefined ? ts - entry.scheduledAt : exec;
        timingStr = `  +${String(exec)}ms (execution)  total=${String(total)}ms`;
      }
      break;
  }

  return timingStr;
}

function printTimingSummary(): void {
  const steps = Array.from(stepTimings.values());
  const completed = steps.filter((s) => s.completedAt !== undefined);
  const succeeded = completed.filter((s) => s.status === 'SUCCEEDED');
  const failed = completed.filter((s) => s.status === 'FAILED');

  console.log('');
  console.log('── Summary ──');
  console.log(`Steps: ${String(succeeded.length)} succeeded, ${String(failed.length)} failed`);

  if (firstEventTs !== undefined && lastEventTs !== undefined) {
    console.log(`Total wall: ${String(lastEventTs - firstEventTs)}ms`);
  }

  if (completed.length > 0) {
    const durations = completed
      .map((s) => ({
        stepId: s.stepId,
        total:
          s.scheduledAt !== undefined && s.completedAt !== undefined
            ? s.completedAt - s.scheduledAt
            : s.startedAt !== undefined && s.completedAt !== undefined
              ? s.completedAt - s.startedAt
              : 0,
      }))
      .sort((a, b) => b.total - a.total);

    const slowest = durations[0];
    const fastest = durations[durations.length - 1];
    console.log(`Slowest step: ${slowest.stepId} (${String(slowest.total)}ms)`);
    console.log(`Fastest step: ${fastest.stepId} (${String(fastest.total)}ms)`);

    // Orchestrator overhead: time between one step completing and the next scheduling
    const sortedBySchedule = steps
      .filter((s) => s.scheduledAt !== undefined)
      .sort((a, b) => a.scheduledAt - b.scheduledAt);

    const gaps: number[] = [];
    for (let i = 1; i < sortedBySchedule.length; i++) {
      const prev = sortedBySchedule[i - 1];
      const curr = sortedBySchedule[i];
      if (prev.completedAt !== undefined && curr.scheduledAt !== undefined) {
        const gap = curr.scheduledAt - prev.completedAt;
        if (gap >= 0) gaps.push(gap);
      }
    }

    if (gaps.length > 0) {
      const totalGap = gaps.reduce((a, b) => a + b, 0);
      const avgGap = Math.round(totalGap / gaps.length);
      console.log(
        `Orchestrator overhead: ${String(totalGap)}ms (avg ${String(avgGap)}ms between steps)`,
      );
    }
  }
}

// ── Event formatting ───────────────────────────────────────────────────────

function formatEvent(
  e: {
    eventId: string;
    eventType: string;
    timestamp: string;
    data?: Record<string, unknown>;
  },
  showTiming: boolean,
): string {
  const data = e.data ?? {};
  const parts: string[] = [e.eventType.padEnd(18)];
  const safeStr = (v: unknown) =>
    typeof v === 'object' && v !== null
      ? JSON.stringify(v)
      : String((v ?? '') as string | number | boolean);
  if (data.stepId) parts.push(`step=${safeStr(data.stepId).padEnd(16)}`);
  if (data.stepType) parts.push(safeStr(data.stepType));

  const meta = data.metadata as Record<string, unknown> | undefined;
  if (meta?.operationId) parts.push(safeStr(meta.operationId));
  else if (data.operationId) parts.push(safeStr(data.operationId));

  if (data.attempt) parts.push(`attempt=${safeStr(data.attempt)}`);
  if (data.outputRef) parts.push(`outputRef=${safeStr(data.outputRef).slice(0, 40)}...`);
  if (data.errorRef) parts.push(`errorRef=${safeStr(data.errorRef).slice(0, 40)}...`);

  const timingStr = showTiming ? trackTiming(e) : '';
  const ts = new Date(e.timestamp).toLocaleTimeString('en-US', { hour12: false });
  return `[${ts}] ${parts.join(' ')}${timingStr}`;
}

async function fetchPayload(apiUrl: string, tenantId: string, ref: string): Promise<string> {
  try {
    const enc = encodeURIComponent(ref);
    const res = await fetch(`${apiUrl}/v1/payloads?ref=${enc}`, {
      headers: { 'X-Tenant-ID': tenantId },
    });
    if (!res.ok) return `(fetch failed: ${res.status})`;
    const data = await res.json();
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    return str.length > 300 ? str.slice(0, 300) + '...' : str;
  } catch {
    return '(fetch error)';
  }
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const headers = { 'X-Tenant-ID': opts.tenantId };
  let after: string | undefined;
  const terminal = ['FlowRunSucceeded', 'FlowRunFailed', 'FlowRunCancelled', 'FlowRunStalled'];

  const poll = async (): Promise<boolean> => {
    const url = new URL(`${opts.apiUrl}/v1/sessions/${opts.runId}/events`);
    url.searchParams.set('limit', String(opts.limit));
    if (after) url.searchParams.set('after', after);

    const res = await fetch(url.toString(), { headers });
    if (!res.ok) {
      console.error(`HTTP ${res.status}: ${await res.text()}`);
      return false;
    }

    const data = (await res.json()) as {
      events: Array<{
        eventId: string;
        eventType: string;
        timestamp: string;
        data?: Record<string, unknown>;
      }>;
      nextCursor?: string;
      hasMore: boolean;
    };

    for (const e of data.events) {
      console.log(formatEvent(e, opts.timing));
      if (opts.hydrate) {
        const ref = e.data?.outputRef ?? e.data?.errorRef;
        if (typeof ref === 'string') {
          const payload = await fetchPayload(opts.apiUrl, opts.tenantId, ref);
          console.log(`  └─ payload: ${payload}`);
        }
      }
      after = e.eventId;
    }

    if (data.events.some((e) => terminal.includes(e.eventType))) return false; // done
    if (!opts.follow) return false;
    return true;
  };

  let keepGoing = true;
  while (keepGoing) {
    keepGoing = await poll();
    if (keepGoing) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  if (opts.timing) {
    printTimingSummary();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
