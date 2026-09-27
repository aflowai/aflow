/**
 * A step-scoped payload path is deterministic per (tenant, run, step, attempt,
 * kind), so two blobs one step writes under one kind are one object and the
 * second erases the first. The kind enum already carries this rule in prose —
 * `state` vs `state_variable`, `body` vs `raw_body` were each split for exactly
 * this — but nothing exercised it, and the UI artifact handler wrote three
 * blobs under `output` for as long as it existed.
 */
import { describe, expect, it } from 'vitest';
import type { TenantId } from '@aflow/schemas';
import { createMemoryPayloadStore, contentAddressForJson } from '../store.js';

const STEP = {
  tenantId: 'a0000000-0000-0000-0000-000000000001' as TenantId,
  runId: '11111111-1111-4111-8111-111111111111',
  stepExecutionId: '22222222-2222-4222-8222-222222222222',
  attempt: 1,
};

describe('what one step may keep', () => {
  it('loses the first blob when a second is written under the same kind', async () => {
    const store = createMemoryPayloadStore();
    const first = await store.store({ ...STEP, kind: 'artifact_html', data: 'the source' });
    const second = await store.store({ ...STEP, kind: 'artifact_html', data: 'the html' });

    // Same address, so the two refs are one ref and the earlier bytes are gone.
    expect(second).toBe(first);
    expect(await store.retrieve(first)).toBe('the html');
  });

  it('keeps blobs a step gives their own kind', async () => {
    const store = createMemoryPayloadStore();
    const source = await store.store({ ...STEP, kind: 'artifact_source', data: 'the source' });
    const compiled = await store.store({ ...STEP, kind: 'artifact_compiled', data: 'compiled' });
    const html = await store.store({ ...STEP, kind: 'artifact_html', data: 'the html' });

    expect(new Set([source, compiled, html]).size).toBe(3);
    expect(await store.retrieve(source)).toBe('the source');
    expect(await store.retrieve(compiled)).toBe('compiled');
  });

  it('keeps an unbounded set only by addressing each blob with its own bytes', async () => {
    // A hermetic capture writes one blob per captured asset and there is no
    // kind to enumerate N of them, so a step-scoped path cannot hold them.
    const store = createMemoryPayloadStore();
    const assets = ['<script>one</script>', '<script>two</script>', '<script>three</script>'];
    const refs = await Promise.all(
      assets.map((asset) =>
        store.storeContentAddressed({
          tenantId: STEP.tenantId,
          contentHash: contentAddressForJson(asset),
          kind: 'artifact_html',
          persist: true,
          data: asset,
        }),
      ),
    );

    expect(new Set(refs).size).toBe(assets.length);
    for (const [index, ref] of refs.entries()) {
      expect(await store.retrieve(ref)).toBe(assets[index]);
    }
  });
});
