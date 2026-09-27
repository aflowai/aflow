#!/usr/bin/env npx tsx

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const DEFAULT_TENANT = process.env.X_TENANT_ID ?? 'a0000000-0000-0000-0000-000000000001';

function parseArgs(): {
  runId: string;
  apiUrl: string;
  tenantId: string;
  outDir: string;
} {
  const args = process.argv.slice(2);
  const runId = args.find((a) => !a.startsWith('--'));
  if (!runId) {
    console.error('Usage: npx tsx scripts/export-run-debug-bundle.ts <runId> [--out .debug/runs]');
    process.exit(1);
  }

  let apiUrl = API_URL;
  let tenantId = DEFAULT_TENANT;
  let outDir = '.debug/runs';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--api-url') apiUrl = args[++i] ?? apiUrl;
    else if (args[i] === '--tenant-id') tenantId = args[++i] ?? tenantId;
    else if (args[i] === '--out') outDir = args[++i] ?? outDir;
  }

  return { runId, apiUrl, tenantId, outDir };
}

function sanitizeRef(ref: string): string {
  return ref.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const headers = { 'X-Tenant-ID': opts.tenantId };
  const base = opts.apiUrl;

  console.log(`Fetching debug view for run ${opts.runId}...`);
  const debug = (await fetchJson(
    `${base}/v1/sessions/${opts.runId}/debug?eventsLimit=500`,
    headers,
  )) as {
    run: Record<string, unknown>;
    recentEvents: Array<Record<string, unknown>>;
    runtimeState?: Record<string, unknown>;
    agent?: Record<string, { conversationStateRef?: string }>;
    refs: { inputRef?: string; outputRef?: string; errorRef?: string; requestedInputRef?: string };
    warnings?: string[];
  };

  const refs = new Set<string>();
  const addRefs = (r: string | undefined) => {
    if (r) refs.add(r);
  };

  addRefs(debug.refs.inputRef);
  addRefs(debug.refs.outputRef);
  addRefs(debug.refs.errorRef);
  addRefs(debug.refs.requestedInputRef);

  function extractRefs(obj: unknown): void {
    if (typeof obj !== 'object' || obj === null) return;
    const o = obj as Record<string, unknown>;
    if (typeof o.payloadRef === 'string') addRefs(o.payloadRef);
    if (o.ref && typeof o.ref === 'object') extractRefs(o.ref);
    if (Array.isArray(o.value)) (o.value as unknown[]).forEach(extractRefs);
    else if (o.value) extractRefs(o.value);
    if (o.changed)
      (o.changed as unknown[]).forEach((ch) => {
        extractRefs((ch as Record<string, unknown>).value);
      });
  }

  for (const e of debug.recentEvents) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    if (d.outputRef) addRefs(d.outputRef as string);
    if (d.errorRef) addRefs(d.errorRef as string);
    if (d.requestedInputRef) addRefs(d.requestedInputRef as string);
    extractRefs(d.runtimeStatePatch);
  }

  if (debug.agent) {
    for (const a of Object.values(debug.agent)) {
      addRefs(a.conversationStateRef);
    }
  }

  const outRoot = resolve(process.cwd(), opts.outDir, opts.runId);
  await mkdir(resolve(outRoot, 'payloads'), { recursive: true });

  const payloadSummaries: Record<string, { path: string; summary?: string }> = {};
  for (const ref of refs) {
    const safe = sanitizeRef(ref);
    const path = `payloads/${safe}.json`;
    try {
      const enc = encodeURIComponent(ref);
      const payload = await fetchJson(`${base}/v1/payloads?ref=${enc}`, headers);
      await writeFile(resolve(outRoot, path), JSON.stringify(payload, null, 2));
      const str = JSON.stringify(payload);
      payloadSummaries[ref] = { path, summary: str.length > 100 ? str.slice(0, 100) + '...' : str };
    } catch (err) {
      await writeFile(
        resolve(outRoot, path),
        JSON.stringify({ _error: `Fetch failed: ${String(err)}` }),
      );
      payloadSummaries[ref] = { path, summary: `(fetch failed)` };
    }
  }

  const bundle = {
    runId: opts.runId,
    exportedAt: new Date().toISOString(),
    session: debug.session,
    recentEvents: debug.recentEvents,
    runtimeState: debug.runtimeState,
    agent: debug.agent,
    refs: debug.refs,
    warnings: debug.warnings,
    payloadRefs: Object.fromEntries(
      Array.from(refs).map((r) => [
        r,
        payloadSummaries[r] ?? { path: 'payloads/' + sanitizeRef(r) + '.json' },
      ]),
    ),
  };

  await writeFile(resolve(outRoot, 'bundle.json'), JSON.stringify(bundle, null, 2));

  console.log(`Exported to ${outRoot}/`);
  console.log(`  bundle.json`);
  console.log(`  payloads/ (${refs.size} files)`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
