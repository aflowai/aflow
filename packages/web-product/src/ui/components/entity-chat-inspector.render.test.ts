/**
 * @vitest-environment jsdom
 */
/**
 * The chat inspector's tab strip, rendered. Its tabs are named by scope: Space
 * is space-wide, and a divider sets it apart from Timeline and Context, which
 * belong to this conversation.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./providers.js', () => ({
  useSpace: () => ({ spaces: [], activeSpace: null }),
}));
vi.mock('../hooks/useApiQuery.js', () => ({
  useApiQuery: () => ({ data: undefined, refetch: () => Promise.resolve() }),
}));
vi.mock('../hooks/use-connection-notice.js', () => ({
  useConnectionNotice: () => 'live',
}));
vi.mock('./cybernetic-provider.js', () => ({
  useCybernetic: () => ({ spaceId: 'space-1', registerImperativeRefresh: () => () => {} }),
}));
vi.mock('../hooks/use-space-entity-events.js', () => ({
  useSpaceEntityEvents: () => ({ events: [], isConnected: true }),
}));
vi.mock('./workbench/index.js', async () => {
  const folds = await import('./workbench/WorkbenchSection.js');
  return {
    Workbench: () => null,
    WorkbenchFoldsContext: folds.WorkbenchFoldsContext,
    useWorkbenchFolds: folds.useWorkbenchFolds,
  };
});
vi.mock('./cascade-feed.js', () => ({ CascadeFeed: () => null }));
vi.mock('./cascade-session-timeline.js', () => ({ CascadeSessionTimeline: () => null }));
vi.mock('./chat/AgentChatHistory.js', () => ({ AgentChatHistory: () => null }));

const { EntityChatInspector } = await import('./entity-chat-inspector.js');

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

describe('EntityChatInspector tab strip', () => {
  it('names the tabs Space, Timeline and Context, with a divider before the session tabs', () => {
    act(() => {
      root.render(createElement(EntityChatInspector, { rootSessionId: null }));
    });
    const tablist = container.querySelector('[role="tablist"]');
    expect(tablist).not.toBeNull();
    const strip = Array.from(tablist?.children ?? []).map((el) =>
      el.hasAttribute('data-inspector-tab-divider') ? '|' : (el.textContent ?? ''),
    );
    expect(strip).toEqual(['Space', '|', 'Timeline', 'Context']);
    const divider = tablist?.querySelector('[data-inspector-tab-divider]');
    expect(divider?.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps the attention badge on the Space tab', () => {
    act(() => {
      root.render(createElement(EntityChatInspector, { rootSessionId: null, attentionCount: 2 }));
    });
    const tabs = Array.from(container.querySelectorAll('[role="tab"]'));
    expect(tabs[0]?.querySelector('[aria-label="2 awaiting you"]')).not.toBeNull();
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
  });
});
