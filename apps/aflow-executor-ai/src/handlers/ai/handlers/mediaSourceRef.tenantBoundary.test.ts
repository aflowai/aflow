/**
 * A media source ref arrives on operation input the agent wrote, so a ref
 * naming another tenant must be refused — and refused as a statement about the
 * field it arrived on, so the agent fixes its input instead of retrying.
 */
import { describe, expect, it } from 'vitest';
import { assertPayloadRefTenant } from '@aflow/executor-runtime';
import type { ExecutorContext } from '@aflow/executor-runtime';
import { contentAddressForJson, createMemoryPayloadStore } from '@aflow/payload-store';
import type { PayloadRef, SessionId, StepExecutionId, TenantId } from '@aflow/schemas';
import { MediaSourceResolver } from './mediaSourceRef.js';
import type { MediaPersistenceTarget } from './mediaPersist.js';

const OWN_TENANT = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const OTHER_TENANT = 'f0000000-0000-0000-0000-0000000000ff' as TenantId;
const RUN_ID = 'b0000000-0000-0000-0000-000000000002' as SessionId;

const store = createMemoryPayloadStore();

const frame = { data: Buffer.from('frame-bytes').toString('base64'), mimeType: 'image/png' };

function makeCtx(): ExecutorContext {
  return {
    tenantId: OWN_TENANT,
    readPayload: async (ref: PayloadRef) => {
      assertPayloadRefTenant(ref, OWN_TENANT);
      return await store.retrieve(ref);
    },
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as unknown as ExecutorContext;
}

function makeTarget(): MediaPersistenceTarget {
  return { payloadStore: store } as unknown as MediaPersistenceTarget;
}

async function storeRunScoped(tenantId: TenantId): Promise<PayloadRef> {
  return await store.store({
    tenantId,
    runId: RUN_ID,
    stepExecutionId: 'c0000000-0000-0000-0000-000000000009' as StepExecutionId,
    attempt: 1,
    kind: 'output',
    data: frame,
  });
}

async function storeContentAddressed(tenantId: TenantId): Promise<PayloadRef> {
  // The same bytes filed under two tenants: the tenant segment is the only
  // thing telling the two refs apart.
  return await store.storeContentAddressed({
    tenantId,
    contentHash: contentAddressForJson(frame),
    kind: 'body',
    data: frame,
  });
}

async function resolveRef(ref: PayloadRef): Promise<ReturnType<MediaSourceResolver['resolve']>> {
  const resolver = new MediaSourceResolver(makeCtx(), makeTarget());
  return await resolver.resolve({ ref, role: 'first_frame', field: 'imageRef' });
}

describe('a media source ref is read as the run tenant', () => {
  it('resolves a run-scoped ref this tenant owns', async () => {
    const resolved = await resolveRef(await storeRunScoped(OWN_TENANT));
    expect(resolved).toMatchObject({ ok: true, source: { data: frame.data } });
  });

  it('resolves a content-addressed ref this tenant owns', async () => {
    const resolved = await resolveRef(await storeContentAddressed(OWN_TENANT));
    expect(resolved).toMatchObject({ ok: true, source: { data: frame.data } });
  });

  it('refuses a run-scoped ref another tenant owns, naming the field', async () => {
    const resolved = await resolveRef(await storeRunScoped(OTHER_TENANT));
    if (resolved.ok) throw new Error('expected a refusal');
    expect(resolved.error.classification).toBe('permission');
    expect(resolved.error.retryable).toBe(false);
    expect(resolved.error.message).toMatch(/^imageRef: /);
    expect(resolved.error.details).toMatchObject({ field: 'imageRef' });
  });

  it('refuses a content-addressed ref another tenant owns', async () => {
    const resolved = await resolveRef(await storeContentAddressed(OTHER_TENANT));
    if (resolved.ok) throw new Error('expected a refusal');
    expect(resolved.error.classification).toBe('permission');
    expect(resolved.error.message).toMatch(/^imageRef: /);
  });
});
