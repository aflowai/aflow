import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_INLINE_PAYLOAD_BYTES } from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';

const mockWarn = vi.fn();

vi.mock('../orchestratorLogger.js', () => ({
  getOrchestratorLogger: () => ({ warn: mockWarn }),
}));

const { encodeTaskInput } = await import('../encodeTaskInput.js');

const META = { tenantId: 'tenant-1', runId: 'run-1', label: 'delegate input task=t1' };

function decodeInlineRef(ref: string): unknown {
  return JSON.parse(Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf8'));
}

function oversizedValue(): Record<string, unknown> {
  return { blob: 'x'.repeat(MAX_INLINE_PAYLOAD_BYTES + 1024) };
}

describe('encodeTaskInput', () => {
  beforeEach(() => {
    mockWarn.mockClear();
  });

  it('at or below the threshold: inlines regardless of payloadStore', async () => {
    const store = vi.fn();
    const value = { input: 'small', config: { runner_model: 'sonnet' } };

    const ref = await encodeTaskInput({ store } as unknown as PayloadStore, META, value);

    expect(ref.startsWith('inline:')).toBe(true);
    expect(decodeInlineRef(ref)).toEqual(value);
    expect(store).not.toHaveBeenCalled();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('above the threshold with a payloadStore: spills and returns the stored ref', async () => {
    const storedRef = 'gs://test-bucket/tenants/tenant-1/runs/run-1/input.json';
    const store = vi.fn().mockResolvedValue(storedRef);
    const value = oversizedValue();

    const ref = await encodeTaskInput({ store } as unknown as PayloadStore, META, value);

    expect(ref).toBe(storedRef);
    expect(store).toHaveBeenCalledOnce();
    const storeArgs = store.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(storeArgs['tenantId']).toBe('tenant-1');
    expect(storeArgs['runId']).toBe('run-1');
    expect(storeArgs['kind']).toBe('input');
    expect(storeArgs['data']).toEqual(value);
    expect(mockWarn).toHaveBeenCalledOnce();
    expect(String(mockWarn.mock.calls[0]?.[0])).toContain('spilling to payload store');
  });

  /**
   * Inlining it anyway traded a fat ref for a lost input, which was the better
   * side of that trade while an oversized inline ref still resolved. The store
   * refuses one now, so the value is lost either way — and lost at the read,
   * which recalls nothing about the encode that produced it.
   */
  it('above the threshold without a payloadStore: refuses rather than encode a ref no read resolves', async () => {
    await expect(encodeTaskInput(undefined, META, oversizedValue())).rejects.toThrow(
      /exceeds the inline cap/i,
    );
  });

  it('spilled payloads get distinct storage paths across encodes', async () => {
    const store = vi.fn().mockResolvedValue('gs://test-bucket/x.json');

    await encodeTaskInput({ store } as unknown as PayloadStore, META, oversizedValue());
    await encodeTaskInput({ store } as unknown as PayloadStore, META, oversizedValue());

    const first = store.mock.calls[0]?.[0] as Record<string, unknown>;
    const second = store.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(first['stepExecutionId']).not.toBe(second['stepExecutionId']);
  });
});
