/**
 * @vitest-environment jsdom
 */
/**
 * A conversation's row in the Workbench, rendered: it says whether the
 * conversation is live — the agent mid-turn, a commission it started still
 * running and at what phase — so the operator need not open each one to find
 * out (Plan 315 F75).
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../../lib/types.js';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined }) }));

const { WorkbenchConversationRow } = await import('./WorkbenchConversationRow.js');
const { conversationLiveState, runsByConversation } = await import('./conversationLiveState.js');

const SESSION: Session = {
  sessionId: '00000000-0000-4000-8000-0000000000c1',
  agentId: 'cybernetic-helmsman',
  agentVersion: '1',
  status: 'PAUSED',
  createdAt: '2026-10-16T09:00:00.000Z',
  lastActivityAt: '2026-10-16T10:00:00.000Z',
  metadata: {
    title: 'Fix the parser',
    summary: 'Guarding the empty input case',
    titleSource: 'generated',
    revision: 1,
  } as Session['metadata'],
};

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

function renderRow(session: Session, runs: Parameters<typeof runsByConversation>[0]): void {
  const live = conversationLiveState(
    session,
    runsByConversation(runs, new Map([['local-code-change', 'Local Code Change']])),
  );
  act(() => {
    root.render(
      createElement(WorkbenchConversationRow, {
        session,
        ownerName: null,
        presence: [],
        personFor: () => undefined,
        unread: 0,
        unreadLabel: '0',
        onOpen: () => undefined,
        onRename: () => undefined,
        onRegenerate: () => undefined,
        canEdit: false,
        live,
      }),
    );
  });
}

function liveLine(): string | null {
  return container.querySelector('[data-testid="conversation-live"]')?.textContent ?? null;
}

const COMMISSION = {
  runId: 'run-1',
  status: 'running',
  workflowSlug: 'local-code-change',
  workflowRevision: 1,
  startedAt: '2026-10-16T10:00:00.000Z',
  completedAt: null,
  durationMs: null,
  totalCostCents: null,
  totalTokens: null,
  evalScore: null,
  evalVerdict: null,
  taskCount: 3,
  pausedReason: null,
  initiatedByUserId: null,
  sessionId: SESSION.sessionId,
  rootSessionId: SESSION.sessionId,
};

describe("a conversation's row", () => {
  it('renders the phase of a commission the conversation is running', () => {
    renderRow(SESSION, [COMMISSION]);
    expect(liveLine()).toContain('Local Code Change · running');
  });

  it('says what a paused commission is waiting on', () => {
    renderRow(SESSION, [{ ...COMMISSION, status: 'paused', pausedReason: 'needs_decision' }]);
    expect(liveLine()).toContain('Local Code Change · Needs a decision');
  });

  it('says the agent is working while it is mid-turn', () => {
    renderRow({ ...SESSION, status: 'RUNNING' }, []);
    expect(liveLine()).toContain('Working');
  });

  it('says nothing live about a conversation at rest', () => {
    renderRow(SESSION, []);
    expect(liveLine()).toBeNull();
    expect(container.textContent).toContain('Fix the parser');
  });
});
