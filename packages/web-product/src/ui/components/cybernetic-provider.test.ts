/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SPACE = '00000000-0000-4000-8000-000000000338';

const net = vi.hoisted(() => ({
  first: 'error' as 'error' | 'empty' | null,
  pending: null as null | (() => void),
}));

function reply(ok: boolean, withDirectives = true) {
  const body = ok
    ? JSON.stringify(withDirectives ? { id: SPACE, directives: {} } : { id: SPACE })
    : '';
  return {
    ok,
    status: ok ? 200 : 500,
    statusText: '',
    headers: { get: () => null },
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(ok ? (JSON.parse(body) as unknown) : {}),
  };
}

const space = { id: SPACE, name: 'Demo', slug: 'demo', memberCount: 1, defaultAgentId: null };
const api = {
  apiUrl: '/api',
  spaceId: SPACE,
  headers: () => ({}),
  // The first read fails, or answers without directives, at once. A later
  // read waits for the test to answer it, so the test can see what the screen
  // shows while it is in flight.
  authFetch: () => {
    const first = net.first;
    net.first = null;
    if (first) return Promise.resolve(reply(first === 'empty', false));
    return new Promise((resolve) => {
      net.pending = () => resolve(reply(true));
    });
  },
};
const spaceContext = { spaces: [space], isLoading: false };

vi.mock('./providers.js', () => ({
  useApi: () => api,
  useSpace: () => spaceContext,
}));

vi.mock('../lib/realtimeClient.js', () => {
  const client = {
    subscribeStatus: () => () => undefined,
    getStatus: () => ({ isConnected: true }),
  };
  return { getRealtimeClient: () => client };
});

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  net.pending = null;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  client.clear();
});

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('CyberneticProvider', () => {
  it.each(['error', 'empty'] as const)(
    'shows the spinner while Retry reads again (first read: %s)',
    async (first) => {
      net.first = first;
      const { CyberneticProvider } = await import('./cybernetic-provider.js');
      await act(async () => {
        root.render(
          createElement(
            QueryClientProvider,
            { client },
            createElement(CyberneticProvider, {
              spaceId: SPACE,
              loadingFallback: createElement('p', null, 'loading'),
              children: createElement('p', null, 'ready'),
            }),
          ),
        );
      });
      await flush();
      const retry = [...container.querySelectorAll('button')].find(
        (b) => b.textContent === 'Retry',
      );
      expect(retry).toBeDefined();
      expect(container.textContent).toContain("Couldn't load this space");

      await act(async () => {
        retry?.click();
      });
      await flush();
      expect(net.pending).not.toBeNull();
      expect(container.textContent).toBe('loading');

      await act(async () => {
        net.pending?.();
      });
      await flush();
      expect(container.textContent).toBe('ready');
    },
  );
});
