/**
 * @vitest-environment jsdom
 */
/**
 * The Workbench and the Integrations card read one OAuth token per binding:
 * the one the bindings read resolves by the binding's own owner scope. They
 * agree for a space-owned token and for a user-owned one. The signed-in user's
 * own token list answers neither, so each case below gives it the opposite
 * answer, and a hook that still read it would disagree with the card.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OAuthBindingConnection, OAuthConnection } from '@aflow/schemas';
import type { ApiBindingSummary, ApiDefinitionSummary } from './use-integrations.js';
import type { SpaceIntegration } from './use-space-integrations.js';

const SPACE_ID = '00000000-0000-4000-8000-0000000000bb';

let bindings: ApiBindingSummary[] = [];
let userConnections: OAuthConnection[] = [];

const GMAIL: ApiDefinitionSummary = {
  apiId: 'gmail',
  name: 'Gmail',
  description: null,
  baseUrl: 'https://gmail.googleapis.com/gmail/v1',
  version: '1',
  tags: [],
  enabled: true,
  endpointCount: 7,
  createdAt: '2026-11-20T00:00:00.000Z',
  updatedAt: '2026-11-20T00:00:00.000Z',
};

vi.mock('./use-integrations.js', () => ({
  useIntegrations: () => ({ definitions: [GMAIL], bindings, credentials: [], isLoading: false }),
}));
vi.mock('./use-mcp-servers.js', () => ({
  useMcpServers: () => ({ servers: [], bindings: [], isLoading: false }),
}));
vi.mock('./use-repo-bindings.js', () => ({
  useRepoBindings: () => ({ repoBindings: [], isLoading: false }),
}));
vi.mock('./use-oauth-connections.js', () => ({
  OAUTH_CONNECTIONS_KEY: ['users', 'me', 'oauth-connections'],
  useOAuthConnections: () => ({ connections: userConnections, isLoading: false }),
}));
vi.mock('./useApiQuery.js', () => ({
  useApiMutation: () => ({ mutateAsync: () => Promise.resolve({}), isPending: false, error: null }),
}));
vi.mock('../lib/oauthConsentPopup.js', () => ({
  useOAuthConsentPopup: () => ({ launch: vi.fn() }),
}));

const { useSpaceIntegrations } = await import('./use-space-integrations.js');
const { OAuthConnectRow } = await import('../components/integrations-api/OAuthConnectRow.js');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function gmailBinding(
  ownerScope: 'user' | 'space',
  oauthConnection: OAuthBindingConnection | null,
): ApiBindingSummary {
  return {
    bindingId: 'gmail-default',
    apiId: 'gmail',
    name: 'Gmail',
    description: null,
    scope: { spaceId: SPACE_ID },
    authType: 'oauth2_authorization_code',
    auth: {
      type: 'oauth2_authorization_code',
      issuerKey: 'google',
      ownerScope,
      clientScope: 'tenant',
    },
    credentialKeys: [],
    egressPolicy: {},
    fulfillment: { mode: 'live' },
    oauthConnection,
    enabled: true,
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
  };
}

function connected(account: string): OAuthBindingConnection {
  return {
    account,
    connectedAt: '2026-11-20T09:30:00.000Z',
    scopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly'],
    status: 'connected',
  };
}

/** A token the signed-in user owns for Gmail, which no space-owned binding resolves. */
const USERS_OWN_GMAIL: OAuthConnection = {
  integrationKind: 'api',
  resourceKey: 'gmail',
  displayName: 'Google',
  scopes: ['openid', 'email'],
  expiresAt: '2026-11-20T13:00:00.000Z',
  status: 'connected',
};

let container: HTMLDivElement;
let root: Root;
let workbench: SpaceIntegration[] = [];

function Workbench() {
  workbench = useSpaceIntegrations(SPACE_ID).integrations;
  return null;
}

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
  bindings = [];
  userConnections = [];
  workbench = [];
});

/** What both surfaces say about the one Gmail binding. */
function bothSurfaces(): { workbench: string; card: string } {
  const binding = bindings[0]!;
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(Workbench),
        createElement(OAuthConnectRow, { binding }),
      ),
    );
  });
  const card =
    container.querySelector('[data-testid="oauth-connection-status"]')?.textContent ?? '';
  const gmail = workbench.find((i) => i.key === 'api:gmail');
  return { workbench: gmail?.detail ?? '', card };
}

describe('Workbench readiness agrees with the Integrations card', () => {
  it('reads a space-owned token as connected though the user owns none', () => {
    bindings = [gmailBinding('space', connected('ops@example.com'))];
    userConnections = [];

    const said = bothSurfaces();
    expect(said.workbench).toBe('Ready');
    expect(said.card).toMatch(/^Connected as ops@example\.com, since /);
    expect(workbench.find((i) => i.key === 'api:gmail')?.readiness).toBe('ready');
  });

  it('reads a space binding with no token as not connected though the user owns one', () => {
    bindings = [gmailBinding('space', null)];
    userConnections = [USERS_OWN_GMAIL];

    expect(bothSurfaces()).toEqual({ workbench: 'Not connected', card: 'Not connected' });
  });

  it('reads a user-owned binding as connected for the owner the server resolved', () => {
    bindings = [gmailBinding('user', connected('alice@example.com'))];
    userConnections = [];

    const said = bothSurfaces();
    expect(said.workbench).toBe('Ready');
    expect(said.card).toMatch(/^Connected as alice@example\.com, since /);
  });

  it('reads a user-owned binding the server resolved no token for as not connected', () => {
    // The bindings read resolves the signed-in user's token by owner scope.
    // The user's own list stands in for the old source and disagrees.
    bindings = [gmailBinding('user', null)];
    userConnections = [USERS_OWN_GMAIL];

    expect(bothSurfaces()).toEqual({ workbench: 'Not connected', card: 'Not connected' });
  });
});
