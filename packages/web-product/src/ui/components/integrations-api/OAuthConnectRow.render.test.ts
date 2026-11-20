/**
 * @vitest-environment jsdom
 */
/**
 * An OAuth-code binding's card says whether a token exists and for which
 * account. Before consent it says "Not connected" and offers the provider's
 * Connect button. After consent it names the account, the consent time and
 * the granted scope count. A provider that reported no account gets
 * "Connected" with the time and names nobody.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OAuthBindingConnection } from '@aflow/schemas';
import type { ApiBindingSummary } from '../../hooks/use-integrations.js';

vi.mock('../../hooks/useApiQuery.js', () => ({
  useApiMutation: () => ({ mutateAsync: () => Promise.resolve({}), isPending: false, error: null }),
}));

vi.mock('../../lib/oauthConsentPopup.js', () => ({
  useOAuthConsentPopup: () => ({ launch: vi.fn() }),
}));

const { OAuthConnectRow, describeOAuthConnection } = await import('./OAuthConnectRow.js');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONNECTED_AT = '2026-11-20T09:30:00.000Z';

function gmailBinding(oauthConnection: OAuthBindingConnection | null): ApiBindingSummary {
  return {
    bindingId: 'gmail-default',
    apiId: 'gmail',
    name: 'Gmail',
    description: null,
    scope: {},
    authType: 'oauth2_authorization_code',
    auth: {
      type: 'oauth2_authorization_code',
      issuerKey: 'google',
      ownerScope: 'space',
      clientScope: 'tenant',
    },
    credentialKeys: [],
    egressPolicy: {},
    fulfillment: { mode: 'live' },
    oauthConnection,
    enabled: true,
    createdAt: CONNECTED_AT,
    updatedAt: CONNECTED_AT,
  } as ApiBindingSummary;
}

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

function render(binding: ApiBindingSummary, readOnly = false): void {
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(OAuthConnectRow, { binding, readOnly }),
      ),
    );
  });
}

function statusLine(): string {
  return container.querySelector('[data-testid="oauth-connection-status"]')?.textContent ?? '';
}

function buttons(): string[] {
  return [...container.querySelectorAll('button')].map((b) => b.textContent ?? '');
}

describe('OAuth-code binding card', () => {
  it('says "Not connected" before consent, and offers Connect', () => {
    render(gmailBinding(null));
    expect(statusLine()).toBe('Not connected');
    expect(buttons()).toEqual(['Connect Google']);
  });

  it('says "Not connected" to a viewer too, with no Connect button', () => {
    render(gmailBinding(null), true);
    expect(statusLine()).toBe('Not connected');
    expect(buttons()).toEqual([]);
  });

  it('names the account, the consent time and the scope count once a token exists', () => {
    render(
      gmailBinding({
        account: 'operator@example.com',
        connectedAt: CONNECTED_AT,
        scopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly'],
        status: 'connected',
      }),
    );
    const since = new Date(CONNECTED_AT).toLocaleString([], {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    expect(statusLine()).toBe(`Connected as operator@example.com, since ${since}, scopes 3`);
    expect(buttons()).toEqual([]);
  });

  it('says "Connected" with the time when the provider reported no account', () => {
    render(
      gmailBinding({
        account: null,
        connectedAt: CONNECTED_AT,
        scopes: ['read:user'],
        status: 'connected',
      }),
    );
    expect(statusLine()).toMatch(/^Connected, since .+, scopes 1$/);
    expect(statusLine()).not.toContain(' as ');
  });
});

describe('describeOAuthConnection', () => {
  const at = () => 'T';

  it('states only what the token row records', () => {
    expect(describeOAuthConnection(null, at)).toBe('Not connected');
    expect(describeOAuthConnection(undefined, at)).toBe('Not connected');
    expect(
      describeOAuthConnection(
        { account: 'a@example.com', connectedAt: CONNECTED_AT, scopes: [], status: 'connected' },
        at,
      ),
    ).toBe('Connected as a@example.com, since T, scopes 0');
    expect(
      describeOAuthConnection(
        { account: null, connectedAt: null, scopes: ['x'], status: 'connected' },
        at,
      ),
    ).toBe('Connected, scopes 1');
    expect(
      describeOAuthConnection(
        { account: 'a@example.com', connectedAt: CONNECTED_AT, scopes: [], status: 'expired' },
        at,
      ),
    ).toBe('Connection as a@example.com expired');
  });
});
