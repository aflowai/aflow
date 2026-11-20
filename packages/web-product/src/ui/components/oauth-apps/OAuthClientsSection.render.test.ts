/**
 * @vitest-environment jsdom
 */
/**
 * Both OAuth Apps pages host this section, and both show the redirect URI the
 * list read returns, copyable, on the page and beside the registration form.
 * The server fills it from `resolveOAuthCallbackUrl()` (its route test pins
 * that), and this pins that the section shows exactly what it was given.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuthClientsSection } from './OAuthClientsSection.js';
import { REDIRECT_URI_INSTRUCTION } from './RedirectUriNotice.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REDIRECT_URI = 'http://localhost:3000/v1/oauth/callback';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // The register dialog sizes itself by a media query, which jsdom lacks.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

function render(redirectUri: string | null): void {
  act(() => {
    root.render(
      createElement(OAuthClientsSection, {
        title: 'Tenant OAuth apps',
        description: 'Register apps.',
        clients: [],
        redirectUri,
        onRegister: () => Promise.resolve(),
        onRotateSecret: () => Promise.resolve(),
        onDelete: () => Promise.resolve(),
      }),
    );
  });
}

function shownRedirectUris(): string[] {
  return [...document.querySelectorAll<HTMLInputElement>('input[aria-label="Redirect URI"]')].map(
    (input) => input.value,
  );
}

describe('OAuthClientsSection redirect URI', () => {
  it('shows the redirect URI it is given, with the instruction and a Copy button', () => {
    render(REDIRECT_URI);
    expect(shownRedirectUris()).toEqual([REDIRECT_URI]);
    expect(container.textContent).toContain(REDIRECT_URI_INSTRUCTION);
    const copy = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Copy');
    expect(copy).toBeDefined();
  });

  it('shows it again beside the registration form', () => {
    render(REDIRECT_URI);
    const register = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Register app',
    );
    act(() => {
      register?.click();
    });
    expect(shownRedirectUris()).toEqual([REDIRECT_URI, REDIRECT_URI]);
  });

  it('shows no redirect URI until the list read has returned one', () => {
    render(null);
    expect(shownRedirectUris()).toEqual([]);
  });
});
