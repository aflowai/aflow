/**
 * @vitest-environment jsdom
 */
/**
 * The Workbench reads an API binding's readiness from the OAuth connection the
 * bindings query carries. A consent finished from the Workbench's Connect card
 * must mark that query stale, so the Workbench refetches it and flips to
 * connected at once.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OAuthConsentLaunchArgs } from '../../lib/oauthConsentPopup.js';
import type {
  ActionCenterItem,
  OAuthConsentExtension,
} from '../../hooks/use-action-center-types.js';

const launched: OAuthConsentLaunchArgs[] = [];

vi.mock('../../hooks/useApiQuery.js', () => ({
  useApiMutation: () => ({ mutateAsync: () => Promise.resolve({}), isPending: false, error: null }),
}));

vi.mock('../../lib/oauthConsentPopup.js', () => ({
  useOAuthConsentPopup: () => ({
    launch: (args: OAuthConsentLaunchArgs) => {
      launched.push(args);
    },
  }),
}));

const { OAuthConsentCard } = await import('./OAuthConsentCard.js');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SPACE_ID = '00000000-0000-4000-8000-0000000000bb';
const OTHER_SPACE_ID = '00000000-0000-4000-8000-0000000000cc';

const EXTENSION: OAuthConsentExtension = {
  kind: 'oauth_consent',
  integrationKind: 'api',
  resourceKey: 'gmail',
  bindingId: 'gmail-default',
  ownerScope: 'space',
  reason: 'never_connected',
};

const ITEM = {
  id: 'item-1',
  spaceId: SPACE_ID,
  kind: 'oauth_consent',
  origin: { type: 'step', runId: 'run-1' },
  title: 'Connect Google',
  summary: 'The run needs a Google account.',
  extension: EXTENSION,
  requestedAt: '2026-11-20T09:30:00.000Z',
  requestedBy: { kind: 'agent', label: 'Helmsman' },
  priority: 'normal',
  relatesTo: [],
  allowedActions: ['connect'],
} as unknown as ActionCenterItem;

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
  launched.length = 0;
});

describe('OAuthConsentCard', () => {
  it("marks the space's bindings query stale when the consent popup closes", () => {
    const client = new QueryClient();
    const bindingsKey = ['space', SPACE_ID, 'integrations', 'bindings'];
    const otherBindingsKey = ['space', OTHER_SPACE_ID, 'integrations', 'bindings'];
    client.setQueryData(bindingsKey, { bindings: [] });
    client.setQueryData(otherBindingsKey, { bindings: [] });

    act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(OAuthConsentCard, { item: ITEM, extension: EXTENSION }),
        ),
      );
    });

    const connect = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Connect',
    );
    act(() => {
      connect?.click();
    });
    expect(launched).toHaveLength(1);
    expect(client.getQueryState(bindingsKey)?.isInvalidated).toBe(false);

    act(() => {
      launched[0]?.onClosed();
    });

    expect(client.getQueryState(bindingsKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(otherBindingsKey)?.isInvalidated).toBe(false);
  });
});
