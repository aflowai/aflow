/**
 * @vitest-environment jsdom
 */
/**
 * The Timeline tab folds each agent turn's tool rows under the turn. Closed,
 * the fold is one line with the count and what the turn spent. Open, it shows
 * the rows the flat list shows. The session page keeps the flat list.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionEvent } from '../lib/types.js';

vi.mock('./run-timeline/StepGroupCard', () => ({
  StepGroupCard: ({ group }: { group: { stepId: string } }) =>
    createElement('div', { 'data-step-row': group.stepId }, group.stepId),
}));

const { RunTimeline } = await import('./run-timeline.js');

let seq = 0;
function event(
  eventType: string,
  stepId: string,
  operationId: string,
  extra: {
    metadata?: Record<string, unknown>;
    usage?: Record<string, unknown>;
    exec?: string;
    stepType?: string;
  } = {},
): SessionEvent {
  seq += 1;
  return {
    eventId: `evt-${String(seq)}`,
    eventType,
    sessionId: 'session-1',
    stepExecutionId: `exec-${stepId}-${extra.exec ?? '1'}`,
    timestamp: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    sequenceNumber: seq,
    eventVersion: 1,
    data: { stepId, stepType: extra.stepType ?? 'ai' },
    metadata: { stepName: stepId, operationId, ...(extra.metadata ?? {}) },
    ...(extra.usage ? { usage: extra.usage } : {}),
  } as unknown as SessionEvent;
}

const events = [
  event('StepScheduled', 'agent-1', 'ai.agent.turn'),
  event('StepSucceeded', 'agent-1', 'ai.agent.turn', {
    metadata: { agentAction: 'invoke_steps' },
    usage: { provider: 'anthropic', totalTokens: 2000, totalCostUsd: 0.04 },
  }),
  event('StepScheduled', 'search', 'catalog.tool.search'),
  event('StepSucceeded', 'search', 'catalog.tool.search'),
  event('StepScheduled', 'read', 'memory.read'),
  event('StepSucceeded', 'read', 'memory.read'),
  event('StepScheduled', 'agent-1', 'ai.agent.turn', { exec: '2' }),
  event('StepSucceeded', 'agent-1', 'ai.agent.turn', {
    exec: '2',
    metadata: { agentAction: 'complete' },
  }),
];

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

function render(foldTurnTools: boolean, timeline: SessionEvent[] = events) {
  act(() => {
    root.render(createElement(RunTimeline, { events: timeline, withTabs: false, foldTurnTools }));
  });
}

/** One turn whose two tool calls end as given. */
function turnWithTools(ends: [string, string]): SessionEvent[] {
  return [
    event('StepScheduled', 'agent-9', 'ai.agent.turn'),
    event('StepSucceeded', 'agent-9', 'ai.agent.turn', {
      metadata: { agentAction: 'invoke_steps' },
    }),
    event('StepScheduled', 'fetch', 'search.web.fetch'),
    event(ends[0], 'fetch', 'search.web.fetch'),
    event('StepScheduled', 'write', 'memory.write'),
    event(ends[1], 'write', 'memory.write'),
  ];
}

const rows = () =>
  [...container.querySelectorAll('[data-step-row]')].map((el) => el.getAttribute('data-step-row'));

describe('the turn fold', () => {
  it('shows the turns with one closed fold, labelled with the tool calls and what the turn spent', () => {
    render(true);
    expect(rows()).toEqual(['agent-1', 'agent-1']);
    const folds = container.querySelectorAll('[data-turn-tools-fold]');
    expect(folds).toHaveLength(1);
    const toggle = folds[0]?.querySelector('button');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(toggle?.textContent).toBe('2 tool calls · 2.0k tok · $0.040');
  });

  it('shows the tool rows under their turn once opened', () => {
    render(true);
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-turn-tools-fold] button')?.click();
    });
    expect(rows()).toEqual(['agent-1', 'search', 'read', 'agent-1']);
  });

  it('shows a failed tool call on the closed fold line, and hides it once the rows show', () => {
    render(true, turnWithTools(['StepPaused', 'StepFailed']));
    const fold = container.querySelector('[data-turn-tools-fold]');
    const status = fold?.querySelector('[data-turn-tools-status]');
    expect(status?.getAttribute('data-turn-tools-status')).toBe('failed');
    expect(fold?.querySelector('button')?.textContent).toBe('2 tool callsFailed');

    act(() => {
      fold?.querySelector<HTMLButtonElement>('button')?.click();
    });
    expect(fold?.querySelector('[data-turn-tools-status]')).toBeNull();
  });

  it('shows a paused tool call on the closed fold line', () => {
    render(true, turnWithTools(['StepSucceeded', 'StepPaused']));
    const status = container.querySelector('[data-turn-tools-fold] [data-turn-tools-status]');
    expect(status?.getAttribute('data-turn-tools-status')).toBe('paused');
    expect(status?.textContent).toBe('Awaiting input');
  });

  it('shows a tool call waiting on its executor on the closed fold line', () => {
    render(true, [
      ...turnWithTools(['StepSucceeded', 'StepSucceeded']).slice(0, 4),
      event('StepScheduled', 'shell', 'host.shell.run', { stepType: 'host' }),
      event('StepWaitingOnExecutor', 'shell', 'host.shell.run', { stepType: 'host' }),
    ]);
    const status = container.querySelector('[data-turn-tools-fold] [data-turn-tools-status]');
    expect(status?.getAttribute('data-turn-tools-status')).toBe('waiting_on_executor');
    expect(status?.textContent).toBe('Waiting for the host executor');
  });

  it('shows a retrying tool call on the closed fold line', () => {
    render(true, [
      ...turnWithTools(['StepSucceeded', 'StepSucceeded']).slice(0, 4),
      event('StepScheduled', 'write', 'memory.write'),
      event('StepFailed', 'write', 'memory.write', { metadata: { willRetry: true } }),
    ]);
    const status = container.querySelector('[data-turn-tools-fold] [data-turn-tools-status]');
    expect(status?.getAttribute('data-turn-tools-status')).toBe('retrying');
    expect(status?.textContent).toBe('Retrying…');
  });

  it('shows a paused tool call over one waiting on its executor', () => {
    render(true, [
      ...turnWithTools(['StepPaused', 'StepSucceeded']).slice(0, 4),
      event('StepScheduled', 'shell', 'host.shell.run', { stepType: 'host' }),
      event('StepWaitingOnExecutor', 'shell', 'host.shell.run', { stepType: 'host' }),
    ]);
    const status = container.querySelector('[data-turn-tools-fold] [data-turn-tools-status]');
    expect(status?.getAttribute('data-turn-tools-status')).toBe('paused');
  });

  it('shows no status on the fold line of a turn whose tool calls are all clear', () => {
    render(true, turnWithTools(['StepSucceeded', 'StepSucceeded']));
    const fold = container.querySelector('[data-turn-tools-fold]');
    expect(fold?.querySelector('[data-turn-tools-status]')).toBeNull();
    expect(fold?.querySelector('button')?.textContent).toBe('2 tool calls');
  });

  it('keeps the flat list where the caller does not fold', () => {
    render(false);
    expect(container.querySelector('[data-turn-tools-fold]')).toBeNull();
    expect(rows()).toEqual(['agent-1', 'search', 'read', 'agent-1']);
  });
});
