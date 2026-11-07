/**
 * @vitest-environment jsdom
 */
/**
 * A run card mounted from the chat snapshot renders as it stands.
 *
 * The snapshot hydrates each card's run, so the card has its graph and does not
 * read the run detail on mount. Its output rows render from whichever field
 * holds the bag, so a state in the earlier shape renders the same rows.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowRunSurfaceState } from '@aflow/run-view';

const RUN_ID = '82f35556-0000-4000-8000-0000000000a1';
const SPACE_ID = '82f35556-0000-4000-8000-0000000000ff';
const PR_URL = 'https://example.test/pr/1';

// One object, as the real provider memoizes it: a fresh `headers` per render
// would re-run every effect keyed on it.
const api = {
  apiUrl: 'http://api.test',
  headers: () => ({}),
  authFetch: (...args: Parameters<typeof fetch>) => fetch(...args),
};
const space = { spaces: [], activeSpace: { id: SPACE_ID, slug: 'space', role: 'owner' } };

vi.mock('../providers.js', () => ({
  useApi: () => api,
  useSpace: () => space,
}));

const { WorkflowRunSurface } = await import('./WorkflowRunSurface.js');
const { ThemeProvider } = await import('../../providers/theme.js');

/** A completed run in the shape the mount snapshot carries it. */
function snapshotRun(overrides: Partial<WorkflowRunSurfaceState> = {}): WorkflowRunSurfaceState {
  return {
    runId: RUN_ID,
    slug: 'commission-change',
    workflowTitle: 'Commission a change',
    status: 'completed',
    pauseVersion: 0,
    startedAt: '2026-11-01T09:00:00.000Z',
    completedAt: '2026-11-01T09:30:00.000Z',
    tasks: {
      plan: {
        taskId: 'plan',
        label: 'Plan the change',
        status: 'succeeded',
        attempt: 1,
        taskType: 'agent',
        stepCount: 14,
        totalTokens: 52_000,
        lastMutatedAtMs: 0,
      },
    },
    graphFidelity: 'full',
    workflowGraph: { taskIds: ['plan'], edges: [] },
    outputs: { prUrl: PR_URL },
    result: { summary: 'Shipped the change.', primaryOutput: 'prUrl' },
    isFrozen: true,
    needsHydration: false,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  fetchSpy = vi.fn(() => Promise.reject(new Error('no request expected')));
  vi.stubGlobal('fetch', fetchSpy);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mount(state: WorkflowRunSurfaceState | undefined): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          ThemeProvider,
          null,
          createElement(WorkflowRunSurface, {
            runId: RUN_ID,
            state,
            spaceId: SPACE_ID,
            onHydrate: () => undefined,
          }),
        ),
      ),
    );
  });
}

function runDetailReads(): number {
  return fetchSpy.mock.calls.filter(([url]) => String(url).includes(`/workflow-runs/${RUN_ID}`))
    .length;
}

describe('a run card mounted from the snapshot', () => {
  it('renders without reading the run detail', async () => {
    vi.useFakeTimers();
    mount(snapshotRun());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(container.textContent).toContain('Commission a change');
    expect(runDetailReads()).toBe(0);
  });

  it('reads the run detail when the state has no graph, as a live-only mount does', async () => {
    const live = snapshotRun();
    delete live.graphFidelity;
    delete live.workflowGraph;
    mount(live);
    await act(async () => {
      await Promise.resolve();
    });
    expect(runDetailReads()).toBe(1);
  });

  it('renders the output rows from `outputs` when `result.output` is absent', () => {
    mount(snapshotRun());
    expect(container.querySelector('.workflow-run-surface__output')?.textContent).toContain(PR_URL);
  });

  it('renders the same output rows from `result.output` when `outputs` is absent', () => {
    const earlier = snapshotRun({
      result: { summary: 'Shipped the change.', primaryOutput: 'prUrl', output: { prUrl: PR_URL } },
    });
    delete earlier.outputs;
    mount(earlier);
    expect(container.querySelector('.workflow-run-surface__output')?.textContent).toContain(PR_URL);
  });

  it('renders one row per output when both fields carry the bag', () => {
    mount(
      snapshotRun({
        result: {
          summary: 'Shipped the change.',
          primaryOutput: 'prUrl',
          output: { prUrl: PR_URL },
        },
      }),
    );
    const text = container.querySelector('.workflow-run-surface__output')?.textContent ?? '';
    expect(text.split(PR_URL).length - 1).toBe(1);
  });

  it('reads an elided ref only when the operator opens the execution', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            run: { runId: RUN_ID },
            tasks: [
              {
                taskId: 'verify',
                attempt: 1,
                outputRef: `inline:output:${btoa(JSON.stringify({ verified: 'from-the-detail' }))}`,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    mount(
      snapshotRun({
        tasks: {
          verify: {
            taskId: 'verify',
            label: 'Verify the change',
            status: 'succeeded',
            attempt: 1,
            taskType: 'operation',
            operationId: 'host.command.run',
            refsElided: true,
            lastMutatedAtMs: 0,
          },
        },
        workflowGraph: { taskIds: ['verify'], edges: [] },
      }),
    );
    expect(runDetailReads()).toBe(0);
    const open = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'View execution',
    );
    expect(open).toBeDefined();
    await act(async () => {
      open?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(runDetailReads()).toBe(1);
    // The panel shows the payload the detail's ref carries, folded by the viewer.
    expect(container.textContent).toContain('{ 1 key }');
  });
});
