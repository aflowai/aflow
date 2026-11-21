/**
 * @vitest-environment jsdom
 */
/**
 * The Integrations card and the Workbench readiness read a binding's token
 * from the space's bindings query. A disconnect on the account page must mark
 * that query stale as well as the user's connection list, so both surfaces
 * flip to not connected at once.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseApiMutationOptions } from './useApiQuery.js';

vi.mock('./useApiQuery.js', () => ({
  useApiQuery: () => ({ data: { connections: [] }, isLoading: false, error: null }),
  // Runs the success path the real hook runs: the listed keys, then onSuccess.
  useApiMutation: (opts: UseApiMutationOptions<unknown, unknown>) => {
    const queryClient = useQueryClient();
    return {
      mutateAsync: (input: unknown) => {
        for (const key of opts.invalidate ?? []) {
          void queryClient.invalidateQueries({ queryKey: key });
        }
        opts.onSuccess?.({ deleted: true }, input);
        return Promise.resolve({ deleted: true });
      },
    };
  },
}));

const { OAUTH_CONNECTIONS_KEY, useOAuthConnections } = await import('./use-oauth-connections.js');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SPACE_ID = '00000000-0000-4000-8000-0000000000bb';
const OTHER_SPACE_ID = '00000000-0000-4000-8000-0000000000cc';

type Hook = ReturnType<typeof useOAuthConnections>;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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

describe('useOAuthConnections disconnect', () => {
  it("marks every space's bindings query stale, and leaves other space reads alone", async () => {
    const client = new QueryClient();
    const bindingsKey = ['space', SPACE_ID, 'integrations', 'bindings'];
    const otherBindingsKey = ['space', OTHER_SPACE_ID, 'integrations', 'bindings'];
    const definitionsKey = ['space', SPACE_ID, 'integrations', 'definitions'];
    const mcpBindingsKey = ['space', SPACE_ID, 'integrations', 'mcp', 'bindings'];
    const connectionsKey = [...OAUTH_CONNECTIONS_KEY];
    for (const key of [
      bindingsKey,
      otherBindingsKey,
      definitionsKey,
      mcpBindingsKey,
      connectionsKey,
    ]) {
      client.setQueryData(key, {});
    }

    let hook: Hook | undefined;
    function Probe(): null {
      hook = useOAuthConnections();
      return null;
    }
    act(() => {
      root.render(createElement(QueryClientProvider, { client }, createElement(Probe)));
    });
    expect(client.getQueryState(bindingsKey)?.isInvalidated).toBe(false);

    await act(async () => {
      await hook?.disconnect.mutateAsync({ integrationKind: 'api', resourceKey: 'gmail' });
    });

    expect(client.getQueryState(connectionsKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(bindingsKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(otherBindingsKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(definitionsKey)?.isInvalidated).toBe(false);
    expect(client.getQueryState(mcpBindingsKey)?.isInvalidated).toBe(false);
  });
});
