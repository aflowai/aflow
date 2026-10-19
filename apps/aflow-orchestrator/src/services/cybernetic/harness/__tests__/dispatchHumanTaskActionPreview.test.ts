import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  MAX_INLINE_PAYLOAD_BYTES,
  WorkflowResumeContractSchema,
  type TenantId,
  type WorkflowTask,
} from '@aflow/schemas';
import { surfaceWorkflowResumeContract } from '@aflow/cybernetic-runtime';
import type { WorkflowRunDetail } from '@aflow/cybernetic-runtime';

const STORED_REF = 'gs://bucket/tenants/t/runs/r/steps/task-1:actionPreview/attempt/1/output.json';
const mockTenantQuery = vi.fn();
vi.mock('@aflow/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aflow/database')>()),
  withTenantSchema: (...args: unknown[]) => mockTenantQuery(...args),
}));

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockEmitTaskUpdate = vi.fn(() => Promise.resolve());
vi.mock('../helpers.js', async () => {
  const actual = await vi.importActual<typeof import('../helpers.js')>('../helpers.js');
  return { ...actual, emitTaskUpdate: (...args: unknown[]) => mockEmitTaskUpdate(...args) };
});

const mockPauseRunOnly = vi.fn(() => Promise.resolve());
vi.mock('../pauseResume.js', async () => {
  const actual = await vi.importActual<typeof import('../pauseResume.js')>('../pauseResume.js');
  return { ...actual, pauseRunOnly: (...args: unknown[]) => mockPauseRunOnly(...args) };
});

const mockClaimHumanTask = vi.fn(() => Promise.resolve(true));
vi.mock('@aflow/cybernetic-runtime', async () => {
  const actual = await vi.importActual<typeof import('@aflow/cybernetic-runtime')>(
    '@aflow/cybernetic-runtime',
  );
  return {
    ...actual,
    claimHumanTask: (...args: unknown[]) => mockClaimHumanTask(...args),
    // Campaign config load needs a real db; this test only exercises preview shaping.
    runContextFromDetail: async () => ({ taskOutputs: new Map(), stateVariables: new Map() }),
  };
});

const { dispatchHumanWorkflowTask } = await import('../dispatchHumanTask.js');

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TENANT = '00000000-0000-0000-0000-000000000001' as TenantId;
const BIG = 'x'.repeat(100 * 1024);

function decodeInline(ref: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf8')) as Record<
    string,
    unknown
  >;
}

const mockStore = vi.fn(async () => STORED_REF);
const mockPayloadStore = {
  shouldStore: vi.fn(() => true),
  store: mockStore,
  retrieve: vi.fn(),
} as unknown as Parameters<typeof dispatchHumanWorkflowTask>[0]['deps']['payloadStore'];

function makeArgs(): Parameters<typeof dispatchHumanWorkflowTask>[0] {
  const run = {
    runId: '11111111-1111-1111-1111-111111111111',
    pauseVersion: 0,
    tasks: [],
  } as unknown as WorkflowRunDetail;
  const task = {
    taskId: 'task-1',
    type: 'human',
    intent: 'approve',
    name: 'Approve submission',
    pauseInstruction: 'Approve the Kaggle submission?',
    // Literal input (no inputBindings) → resolveActionPreview returns it as-is.
    actionPreview: { op: 'mcp.kaggle.submit', input: { fileContent: BIG, message: 'run 2' } },
  } as unknown as WorkflowTask;
  return {
    deps: { db: {} as never, redis: {} as never, payloadStore: mockPayloadStore },
    tenantId: TENANT,
    tenantIdStr: TENANT,
    runId: run.runId,
    taskId: 'task-1',
    attempt: 1,
    run,
    task,
  };
}

beforeEach(() => {
  mockEmitTaskUpdate.mockClear();
  mockPauseRunOnly.mockClear();
  mockClaimHumanTask.mockClear();
  mockStore.mockClear();
  // Sized, not blanket: the preview and the hydration are separate decisions,
  // and a hydration that carries only a ref plus a truncated head is small even
  // when the preview it points at is not. A mock that says yes to everything
  // would claim both take the store.
  (mockPayloadStore.shouldStore as ReturnType<typeof vi.fn>).mockImplementation(
    (data: unknown) => Buffer.byteLength(JSON.stringify(data), 'utf-8') > MAX_INLINE_PAYLOAD_BYTES,
  );
});

describe('dispatchHumanWorkflowTask — large action preview (Plan 186 §5.D)', () => {
  it.each([2538, 25000])(
    'surfaces a valid human pause contract for a %i-character prompt',
    async (length) => {
      const args = makeArgs();
      args.task.pauseInstruction = 'p'.repeat(length);
      await dispatchHumanWorkflowTask(args);
      const ref = mockPauseRunOnly.mock.calls[0]![5] as string;
      const stored = decodeInline(ref);
      expect(WorkflowResumeContractSchema.safeParse(stored).success).toBe(true);
      const parsed = WorkflowResumeContractSchema.parse(stored);
      expect(parsed.pausedTaskInputContract?.prompt?.length).toBe(Math.min(length, 20000));
      expect(parsed.resumePrompt).toBe(args.task.pauseInstruction);
      mockTenantQuery
        .mockResolvedValueOnce({ status: 'paused', pausedPayloadRef: ref, pauseVersion: 1 })
        .mockResolvedValueOnce(null);
      const surfaced = await surfaceWorkflowResumeContract(
        args.deps.db,
        { retrieve: async () => stored } as never,
        TENANT,
        args.runId,
      );
      expect(surfaced?.contract.pausedTaskInputContract).toEqual(parsed.pausedTaskInputContract);
      expect(surfaced?.pauseVersion).toBe(1);
    },
  );

  it('stores the full preview by reference and surfaces only a head/stat inline', async () => {
    await dispatchHumanWorkflowTask(makeArgs());

    // (a) full resolved preview stored by reference.
    expect(mockStore).toHaveBeenCalledTimes(1);
    const stored = mockStore.mock.calls[0]![0] as { kind: string; data: Record<string, unknown> };
    expect(stored.kind).toBe('output');
    expect((stored.data['input'] as Record<string, unknown>)['fileContent']).toBe(BIG);

    // (b) durable hydration carries actionPreviewRef + a head/stat actionPreview,
    //     never the full body.
    expect(mockClaimHumanTask).toHaveBeenCalledTimes(1);
    const claimArgs = mockClaimHumanTask.mock.calls[0]![2] as { humanTaskHydrationRef: string };
    const hydration = decodeInline(claimArgs.humanTaskHydrationRef);
    expect(hydration['actionPreviewRef']).toBe(STORED_REF);
    const hydPreview = hydration['actionPreview'] as { input: Record<string, unknown> };
    expect(hydPreview.input['__previewTruncated']).toBe(true);
    expect(JSON.stringify(hydration)).not.toContain(BIG);

    // (c) the task-update event carries only the head/stat too.
    expect(mockEmitTaskUpdate).toHaveBeenCalledTimes(1);
    const event = mockEmitTaskUpdate.mock.calls[0]![1] as {
      actionPreview?: { input: Record<string, unknown> };
    };
    expect(event.actionPreview?.input['__previewTruncated']).toBe(true);
    expect(JSON.stringify(event)).not.toContain(BIG);
  });

  it('keeps the full preview inline when it fits (shouldStore=false → no actionPreviewRef)', async () => {
    (mockPayloadStore.shouldStore as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const args = makeArgs();
    (args.task as unknown as { actionPreview: { op: string; input: unknown } }).actionPreview = {
      op: 'mcp.kaggle.submit',
      input: { message: 'run 2' },
    };

    await dispatchHumanWorkflowTask(args);

    expect(mockStore).not.toHaveBeenCalled();
    const claimArgs = mockClaimHumanTask.mock.calls[0]![2] as { humanTaskHydrationRef: string };
    const hydration = decodeInline(claimArgs.humanTaskHydrationRef);
    expect(hydration['actionPreviewRef']).toBeUndefined();
    const hydPreview = hydration['actionPreview'] as { input: Record<string, unknown> };
    expect(hydPreview.input['message']).toBe('run 2');
    expect(hydPreview.input['__previewTruncated']).toBeUndefined();
  });
});
