/**
 * @vitest-environment jsdom
 */
/**
 * The harness card as a person sees it, rendered: where it is mounted, what it
 * leads with, and what it keeps folded.
 *
 * The run surface's harness task mounts the same card the chat does, fed from
 * the step's activity stream through the surface's provider — a commission's
 * task row reading "has not reported yet" for half an hour while its feed was
 * flowing is the failure this pins (Plan 315 F95). The card leads with what the
 * agent last said and folds its tool lines (F97).
 */
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessActivityLine } from '@aflow/schemas';
import type { HarnessActivityState } from '@aflow/run-view';

vi.mock('./providers.js', () => ({
  useApi: () => ({ apiUrl: 'http://api.test', headers: () => ({}) }),
}));

vi.mock('../lib/fetch-payload.js', () => ({
  // Nothing in these tests has a stored payload; a fetch is a test error.
  fetchPayload: () => Promise.reject(new Error('HTTP 404')),
}));

const { HarnessActivityProvider, HarnessStepCard } = await import('./harness-activity-card.js');
const { TaskExecutionDetails } = await import('./workflow-run-surface/TaskExecutionDetails.js');

const STEP = '00000000-0000-4000-8000-000000000123';

const FEED: HarnessActivityLine[] = [
  { kind: 'status', at: 0, text: 'Model claude-opus-5-5' },
  { kind: 'thought', at: 1_000, text: 'Looking at how the parser handles empty input.' },
  { kind: 'tool', at: 1_400, tool: 'Read', text: 'Read src/parser.ts' },
  {
    kind: 'tool',
    at: 2_000,
    tool: 'Edit',
    text: 'Edit src/parser.ts',
    changes: 'src/parser.ts',
  },
  { kind: 'intent', at: 2_100, text: 'Running the parser tests' },
  { kind: 'tool', at: 2_200, tool: 'Bash', text: 'Bash yarn test:file parser.test.ts' },
  {
    kind: 'tool_result',
    at: 9_000,
    tool: 'Bash',
    ok: false,
    command: true,
    text: 'sandbox: cannot write /tmp/cwd-1234',
  },
];

function feedOf(lines: HarnessActivityLine[]): Record<string, HarnessActivityState> {
  return {
    [STEP]: {
      lines,
      partial: '',
      consumedBytes: 1,
      lastActivityAtMs: Date.now() - 4_000,
      settled: false,
    },
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function render(node: ReactNode, feeds: Record<string, HarnessActivityState>): void {
  act(() => {
    root.render(createElement(HarnessActivityProvider, { feeds, live: true }, node));
  });
}

function leadText(): string | null {
  return container.querySelector('.harness-activity__lead-text')?.textContent ?? null;
}

function toolsDisclosure(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('button.harness-activity__tools');
}

describe('the harness card', () => {
  it('leads with what the agent last said, then the files it is changing', () => {
    render(createElement(HarnessStepCard, { stepExecutionId: STEP, running: true }), feedOf(FEED));

    expect(leadText()).toBe('Running the parser tests');
    expect(container.textContent).toMatch(/last active 4\.\ds ago/);
    expect(container.querySelector('.harness-activity__file')?.textContent).toBe('src/parser.ts');
  });

  it('keeps the tool lines folded until asked, naming the call they end on', () => {
    render(createElement(HarnessStepCard, { stepExecutionId: STEP, running: true }), feedOf(FEED));

    const disclosure = toolsDisclosure();
    expect(disclosure?.getAttribute('aria-expanded')).toBe('false');
    expect(disclosure?.textContent).toContain('3 tool calls · last: Bash yarn test:file');
    expect(container.querySelector('.harness-feed')).toBeNull();

    act(() => {
      disclosure?.click();
    });
    expect(toolsDisclosure()?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.harness-feed')?.textContent).toContain('Read');
  });

  it("does not show a command's non-zero exit as a failure", () => {
    render(createElement(HarnessStepCard, { stepExecutionId: STEP, running: true }), feedOf(FEED));
    act(() => {
      toolsDisclosure()?.click();
    });
    const resultRow = container.querySelector('.harness-feed__row--result');
    expect(resultRow?.textContent).toContain('sandbox: cannot write');
    expect(resultRow?.textContent).toContain('↳');
  });

  it('leads with the last plain-text message where the agent states no plan', () => {
    render(
      createElement(HarnessStepCard, { stepExecutionId: STEP, running: true }),
      feedOf(FEED.slice(0, 4)),
    );
    expect(leadText()).toBe('Looking at how the parser handles empty input.');
  });
});

describe("a run's harness task", () => {
  const task = {
    taskId: 'implement',
    label: 'Implement the change',
    status: 'running',
    attempt: 1,
    taskType: 'operation',
    operationId: 'host.harness.run',
    workerSessionId: STEP,
    startedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
  } as unknown as Parameters<typeof TaskExecutionDetails>[0]['task'];

  it("mounts the chat's card fed from the step's activity stream", () => {
    render(createElement(TaskExecutionDetails, { task }), feedOf(FEED));

    expect(container.querySelector('.harness-activity')).not.toBeNull();
    expect(leadText()).toBe('Running the parser tests');
    expect(container.textContent).not.toContain('has not reported yet');
  });

  it('counts a quiet task from its start rather than reading 0ms', () => {
    render(createElement(TaskExecutionDetails, { task }), {});

    expect(container.textContent).toContain('30.0m');
    expect(container.textContent).not.toContain('0ms');
  });
});
