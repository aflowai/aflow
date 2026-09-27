import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMemoryPayloadStore } from '@aflow/payload-store';
import type { TenantId, SessionId, StepExecutionId, PayloadKind } from '@aflow/schemas';

const mockGetByPath = vi.fn();

vi.mock('@aflow/database', async () => {
  const actual = await vi.importActual<typeof import('@aflow/database')>('@aflow/database');
  return {
    ...actual,
    createTenantContext: () => ({}),
    createMemoryDocRepository: () => ({ getByPath: mockGetByPath }),
  };
});

const { resolveBodyFromMemory, bodyPathToMemoryPath, buildContentRangeHeader } =
  await import('./bodyFromPath.js');

const TENANT = 'tenant-1' as TenantId;
const SPACE = 'space-1';
const db = {} as never;

const storeRefBase = {
  tenantId: TENANT,
  runId: 'run-1' as SessionId,
  stepExecutionId: 'step-1' as StepExecutionId,
  attempt: 0,
  kind: 'body' as PayloadKind,
};

beforeEach(() => mockGetByPath.mockReset());

describe('bodyPathToMemoryPath', () => {
  it('strips the /workspace mount prefix; leaves a bare Memory path alone', () => {
    expect(bodyPathToMemoryPath('/workspace/data/project/submission.csv')).toBe(
      '/data/project/submission.csv',
    );
    expect(bodyPathToMemoryPath('/data/x.csv')).toBe('/data/x.csv');
    expect(bodyPathToMemoryPath('/workspace')).toBe('/');
  });
});

describe('buildContentRangeHeader (Plan 194 §4.5a)', () => {
  it('derives bytes 0-(N-1)/N from the body byte length', () => {
    expect(buildContentRangeHeader(23)).toBe('bytes 0-22/23');
    expect(buildContentRangeHeader(1)).toBe('bytes 0-0/1');
    expect(buildContentRangeHeader(34_864)).toBe('bytes 0-34863/34864');
  });

  it('uses the no-bytes form for an empty body', () => {
    expect(buildContentRangeHeader(0)).toBe('bytes */0');
  });
});

describe('resolveBodyFromMemory', () => {
  it('materializes an inline text doc as UTF-8 bytes and reports its mimeType', async () => {
    mockGetByPath.mockResolvedValue({
      inlineContent: 'PassengerId,Survived\n892,0\n',
      payloadRef: null,
      mimeType: 'text/csv',
      sizeBytes: 27,
    });
    const { bytes, mimeType } = await resolveBodyFromMemory({
      db,
      payloadStore: createMemoryPayloadStore(),
      tenantId: TENANT,
      spaceId: SPACE,
      fromPath: '/workspace/data/submission.csv',
      maxBytes: 10_000,
    });
    expect(bytes.toString('utf-8')).toBe('PassengerId,Survived\n892,0\n');
    expect(mimeType).toBe('text/csv');
    // The /workspace prefix was stripped before the Memory lookup.
    expect(mockGetByPath).toHaveBeenCalledWith('/data/submission.csv', SPACE);
  });

  it('materializes a binary .bin doc via retrieveBytes — exact bytes', async () => {
    const store = createMemoryPayloadStore();
    const raw = Buffer.from([0x00, 0xff, 0x80, 0x01, 0xfe, 0x90]); // non-UTF-8
    const ref = await store.storeBytes({ ...storeRefBase, data: raw });
    mockGetByPath.mockResolvedValue({
      inlineContent: null,
      payloadRef: ref,
      mimeType: 'application/octet-stream',
      sizeBytes: raw.length,
    });
    const { bytes } = await resolveBodyFromMemory({
      db,
      payloadStore: store,
      tenantId: TENANT,
      spaceId: SPACE,
      fromPath: '/workspace/models/m.bin',
      maxBytes: 10_000,
    });
    expect(bytes.equals(raw)).toBe(true);
  });

  it('throws API_BODY_SOURCE_NOT_FOUND for a missing path', async () => {
    mockGetByPath.mockResolvedValue(null);
    await expect(
      resolveBodyFromMemory({
        db,
        payloadStore: createMemoryPayloadStore(),
        tenantId: TENANT,
        spaceId: SPACE,
        fromPath: '/workspace/nope.csv',
        maxBytes: 10_000,
      }),
    ).rejects.toMatchObject({ aflowError: { code: 'API_BODY_SOURCE_NOT_FOUND' } });
  });

  it('rejects (API_REQUEST_TOO_LARGE) when the doc exceeds the cap WITHOUT reading bytes', async () => {
    const retrieveBytes = vi.fn();
    const store = { ...createMemoryPayloadStore(), retrieveBytes };
    mockGetByPath.mockResolvedValue({
      inlineContent: null,
      payloadRef: 'gs://bucket/x/body.bin',
      mimeType: 'application/octet-stream',
      sizeBytes: 5_000,
    });
    await expect(
      resolveBodyFromMemory({
        db,
        payloadStore: store as never,
        tenantId: TENANT,
        spaceId: SPACE,
        fromPath: '/workspace/big.bin',
        maxBytes: 1_000,
      }),
    ).rejects.toMatchObject({ aflowError: { code: 'API_REQUEST_TOO_LARGE' } });
    expect(retrieveBytes).not.toHaveBeenCalled(); // size-gated before any read
  });
});
