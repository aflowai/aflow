/**
 * @vitest-environment jsdom
 */
/**
 * Reading further back re-folds the conversation, and every message in the
 * deeper snapshot is a new object. The messages already on the page do not
 * render again. Only the older ones the page adds do.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runViewReducer, initialRunViewState, type RunViewState } from '@aflow/run-view';
import type { Message } from '../../lib/types.js';

const rendered = vi.hoisted(() => [] as string[]);

vi.mock('../providers.js', () => ({
  useApi: () => ({
    apiUrl: 'http://api',
    headers: () => ({}),
    authFetch: () => Promise.resolve(new Response()),
    blockedSession: null,
  }),
  useSpace: () => ({ activeSpaceId: 'space-1', activeSpace: { id: 'space-1', slug: 'main' } }),
}));
vi.mock('../../hooks/useApiQuery.js', () => ({
  useApiQuery: () => ({ data: undefined, error: null, isError: false, isSuccess: false }),
}));
vi.mock('../content-renderer.js', () => ({
  ContentRenderer: ({ content }: { content: string }) => {
    rendered.push(content);
    return null;
  },
}));

const { ChatMessages } = await import('./ChatMessages.js');
const { buildLiveConversationItems } = await import('./conversation-items.js');

function conversation(from: number, to: number): Message[] {
  const out: Message[] = [];
  for (let i = from; i < to; i++) {
    const timestamp = new Date(1_760_000_000_000 + i * 1000).toISOString();
    out.push(
      i % 3 === 1
        ? {
            id: `t${String(i)}`,
            role: 'assistant',
            content: `t${String(i)}`,
            isInterim: true,
            timestamp,
          }
        : {
            id: `m${String(i)}`,
            role: i % 3 === 0 ? 'user' : 'assistant',
            content: `m${String(i)}`,
            timestamp,
          },
    );
  }
  return out;
}

function refold(messages: Message[]): RunViewState {
  return {
    ...initialRunViewState,
    status: 'SUCCEEDED',
    messages: JSON.parse(JSON.stringify(messages)) as Message[],
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  rendered.length = 0;
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function show(state: RunViewState): void {
  const items = buildLiveConversationItems({
    pastItems: [],
    reducer: state,
    isTerminalStatus: false,
    currentRun: null,
    effectiveStatus: null,
  });
  act(() => {
    root.render(
      createElement(ChatMessages, {
        items,
        runStatus: 'SUCCEEDED',
        activity: null,
        requiredInput: null,
        hasOlder: true,
        onLoadOlder: () => {},
        sessionId: 'session-1',
      }),
    );
  });
}

describe('ChatMessages on load-older', () => {
  it('renders only the messages the older page adds', () => {
    const all = conversation(0, 30);
    let state = runViewReducer(initialRunViewState, {
      type: 'HYDRATE_SNAPSHOT',
      snapshot: refold(all.slice(15)),
    });
    show(state);
    expect(new Set(rendered)).toEqual(new Set(all.slice(15).map((m) => m.content)));

    rendered.length = 0;
    state = runViewReducer(state, { type: 'HYDRATE_SNAPSHOT', snapshot: refold(all) });
    show(state);
    expect(new Set(rendered)).toEqual(new Set(all.slice(0, 15).map((m) => m.content)));
  });
});
