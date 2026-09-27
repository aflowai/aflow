/**
 * Tenant-boundary invariant for payload reads: a ref is caller-supplied data,
 * so the tenant it names must be the tenant the job runs as. Every backend
 * resolves a ref against one configured bucket, so an unchecked ref reaches
 * another tenant's bytes.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  contentAddressForJson,
  createMemoryPayloadStore,
  type PayloadStore,
} from '@aflow/payload-store';
import {
  MAX_INLINE_PAYLOAD_BYTES,
  type PayloadRef,
  type SessionId,
  type StepExecutionId,
  type StepJobMessage,
  type TenantId,
} from '@aflow/schemas';
import { buildExecutionContext } from '../executor/buildContext.js';
import { toAflowError } from '../executor/errors.js';
import type { ExecutorContext, ExecutorDependencies, ExecutorLogger } from '../types.js';

const OWN_TENANT = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const OTHER_TENANT = 'f0000000-0000-0000-0000-0000000000ff' as TenantId;

const log: ExecutorLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const store = createMemoryPayloadStore();

function makeJob(): StepJobMessage {
  return {
    messageVersion: 1,
    tenantId: OWN_TENANT,
    sessionId: 'b0000000-0000-0000-0000-000000000002',
    stepExecutionId: 'c0000000-0000-0000-0000-000000000003',
    stepId: 'render-frame',
    stepType: 'ai',
    operationId: 'ai.media.animate',
    attempt: 1,
    idempotencyKey: 'idem-1',
    inputRef: 'inline:e30=',
    traceId: 'trace-1',
    scheduledAtMs: 1,
  } as StepJobMessage;
}

async function contextFor(payloadStore: PayloadStore): Promise<ExecutorContext> {
  const deps = { payloadStore, redis: {} as never } as unknown as ExecutorDependencies;
  return await buildExecutionContext(deps, makeJob(), log);
}

async function storeRunScoped(tenantId: TenantId, data: unknown): Promise<PayloadRef> {
  return await store.store({
    tenantId,
    runId: 'b0000000-0000-0000-0000-000000000002' as SessionId,
    stepExecutionId: 'c0000000-0000-0000-0000-000000000009' as StepExecutionId,
    attempt: 1,
    kind: 'output',
    data,
  });
}

async function storeContentAddressed(tenantId: TenantId, data: unknown): Promise<PayloadRef> {
  return await store.storeContentAddressed({
    tenantId,
    contentHash: contentAddressForJson(data),
    kind: 'body',
    data,
  });
}

describe('payload reads are bound to the job tenant', () => {
  it('resolves a run-scoped ref belonging to the job tenant', async () => {
    const ref = await storeRunScoped(OWN_TENANT, { data: 'mine-run' });
    const ctx = await contextFor(store);
    await expect(ctx.readPayload(ref)).resolves.toEqual({ data: 'mine-run' });
  });

  it('resolves a content-addressed ref belonging to the job tenant', async () => {
    const ref = await storeContentAddressed(OWN_TENANT, { data: 'mine-content' });
    const ctx = await contextFor(store);
    await expect(ctx.readPayload(ref)).resolves.toEqual({ data: 'mine-content' });
  });

  it('refuses a run-scoped ref belonging to another tenant', async () => {
    const ref = await storeRunScoped(OTHER_TENANT, { data: 'not-yours-run' });
    const ctx = await contextFor(store);
    await expect(ctx.readPayload(ref)).rejects.toThrow(/tenant/i);
  });

  it('refuses a content-addressed ref belonging to another tenant', async () => {
    const ref = await storeContentAddressed(OTHER_TENANT, { data: 'not-yours-content' });
    const ctx = await contextFor(store);
    await expect(ctx.readPayload(ref)).rejects.toThrow(/tenant/i);
  });

  it('refuses before the store is asked, so no refusal can report existence', async () => {
    const ref = await storeRunScoped(OTHER_TENANT, { data: 'not-yours-run' });
    const retrieve = vi.fn(store.retrieve.bind(store));
    const ctx = await contextFor({ ...store, retrieve });
    await expect(ctx.readPayload(ref)).rejects.toThrow(/tenant/i);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('reads an inline ref, which carries its own bytes and names no tenant', async () => {
    const ctx = await contextFor(store);
    const inline = `inline:${Buffer.from(JSON.stringify({ a: 1 })).toString(
      'base64',
    )}` as PayloadRef;
    await expect(ctx.readPayload(inline)).resolves.toEqual({ a: 1 });
  });

  /**
   * Leaving canonicality to the store is only safe if the store actually
   * refuses. An inline ref over the cap is the case where that is load-bearing:
   * it is the one unparseable shape a backend would otherwise answer from the
   * ref itself, so a deferral without a refusal downstream would hand
   * caller-supplied bytes straight to a decode.
   */
  it('refuses an oversized inline ref, which the deferral would otherwise admit', async () => {
    const ctx = await contextFor(store);
    const oversized = `inline:${Buffer.from(
      JSON.stringify({ blob: 'x'.repeat(MAX_INLINE_PAYLOAD_BYTES + 10_000) }),
    ).toString('base64')}` as PayloadRef;
    await expect(ctx.readPayload(oversized)).rejects.toThrow(/invalid inline payload_ref/i);
  });

  it('refuses a ref that is not canonical, as a shape refusal rather than a tenant one', async () => {
    const ctx = await contextFor(store);
    // Asserting the message, not merely that it throws: this ref is absent from
    // the store too, so a bare rejection is also what a missing object looks
    // like and the case would pass with the parse refusal deleted.
    const thrown: unknown = await ctx
      .readPayload('gs://test-bucket/../etc/passwd' as PayloadRef)
      .catch((err: unknown) => err);
    expect(String(thrown)).toMatch(/invalid .*payload_ref format/i);
    // A shape the parser rejects names no tenant, so it cannot be evidence of a
    // cross-tenant read. Answering it as one reports a boundary violation to an
    // operator who does not have one.
    expect(String(thrown)).not.toMatch(/tenant/i);
  });

  it('refuses as a non-retryable permission failure', async () => {
    const ref = await storeRunScoped(OTHER_TENANT, { data: 'not-yours-run' });
    const ctx = await contextFor(store);
    const thrown: unknown = await ctx.readPayload(ref).catch((err: unknown) => err);
    const error = toAflowError(thrown);
    expect(error.classification).toBe('permission');
    expect(error.retryable).toBe(false);
  });
});

describe('no module bypasses the tenant-bound read', () => {
  it('keeps every payload retrieval inside the tenant-bound helper', () => {
    const srcDir = fileURLToPath(new URL('../', import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name === 'payloadAccess.ts') continue;
        if (/\.retrieve\s*\(/.test(readFileSync(full, 'utf-8'))) offenders.push(full);
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });
});
