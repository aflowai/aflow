/**
 * @vitest-environment jsdom
 */
/**
 * The sidebar's space entries, rendered through the real shell with its
 * providers, the router and the design system replaced: the order (Chat, then
 * Plan, then the rest as before) and the Chat entry's Action Center count,
 * which is shown beside the label, hidden at zero, and part of the Chat link.
 */
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SPACE_ID = '00000000-0000-4000-8000-000000000340';

const state = vi.hoisted(() => ({
  edition: 'community-local' as string | null,
  slug: 'acme',
  activeSlug: 'acme',
  actionable: 0,
  items: [] as unknown[],
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) =>
    createElement('a', { ...rest, href }, children),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ space: state.slug }),
  usePathname: () => `/s/${state.slug}/chat`,
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@aflow/design-system', () => {
  const pass = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    AppShell: ({ sidebar, children }: { sidebar: ReactNode; children?: ReactNode }) =>
      createElement('div', null, sidebar, children),
    SidebarHeader: pass,
    SidebarNav: ({ children }: { children?: ReactNode }) => createElement('nav', null, children),
    SidebarFooter: pass,
    SidebarNavItem: ({
      label,
      href,
      trailing,
      as: As,
    }: {
      label: string;
      href: string;
      trailing?: ReactNode;
      as: (props: { href: string; children?: ReactNode }) => ReactNode;
    }) => createElement(As, { href, 'data-nav-item': label } as never, label, trailing),
    SidebarAction: ({ label }: { label: string }) => createElement('button', null, label),
    useSidebar: () => ({
      collapsed: false,
      railExpanded: true,
      toggle: vi.fn(),
      isMobile: false,
      closeDrawer: vi.fn(),
    }),
    Icon: () => null,
    Logo: () => null,
    Tooltip: ({ children }: { children?: ReactNode }) => children,
    Row: pass,
    Text: pass,
    Badge: ({ children, ...rest }: { children?: ReactNode; [key: string]: unknown }) =>
      createElement('span', rest, children),
  };
});

vi.mock('../providers/theme.js', () => ({
  useTheme: () => ({ resolvedTheme: 'light', setTheme: vi.fn() }),
}));
vi.mock('./blocked-session-notice.js', () => ({ BlockedSessionNotice: () => null }));
vi.mock('./providers.js', () => ({
  useSpace: () => ({
    activeSpace: { id: SPACE_ID, slug: state.activeSlug, name: 'Acme', myRole: 'admin' },
    accessibleSpaces: [{ id: SPACE_ID }],
    isLoading: false,
  }),
}));
vi.mock('./space-selector.js', () => ({ SpaceSelector: () => null }));
vi.mock('./user-avatar.js', () => ({ UserAvatar: () => null, useCurrentUser: () => null }));
vi.mock('./profile-menu.js', () => ({ ProfileMenu: () => null }));
vi.mock('../hooks/useEdition.js', () => ({
  useEdition: () => ({ id: state.edition }),
  useHasSurface: () => false,
}));
vi.mock('../hooks/use-action-center.js', () => ({
  useActionCenter: () => ({
    items: state.items,
    listIsWhole: true,
    counts: { actionable: state.actionable },
  }),
}));

import { AppShellWrapper } from './app-shell.js';

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root.render(createElement(AppShellWrapper, null, null));
  });
}

const order = () =>
  Array.from(container.querySelectorAll('[data-nav-item]')).map((a) =>
    a.getAttribute('data-nav-item'),
  );
const chatLink = () => container.querySelector('[data-nav-item="Chat"]');
const chatCount = () => container.querySelector('[data-chat-nav-count]');

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.edition = 'community-local';
  state.slug = 'acme';
  state.activeSlug = 'acme';
  state.actionable = 0;
  state.items = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('sidebar order', () => {
  it('puts Plan second, after Chat, and keeps the rest in their order', () => {
    render();
    expect(order()).toEqual([
      'Chat',
      'Plan',
      'Skills',
      'Integrations',
      'Store',
      'Memory',
      'Triggers',
      'This Computer',
      'Settings',
    ]);
  });

  it('keeps Plan second where the edition shows no This Computer', () => {
    state.edition = 'enterprise';
    render();
    expect(order()).toEqual([
      'Chat',
      'Plan',
      'Skills',
      'Integrations',
      'Store',
      'Memory',
      'Triggers',
      'Settings',
    ]);
  });
});

describe('Chat entry — Action Center count', () => {
  it('shows the pending count beside the Chat label, drawn as the Plan count is', () => {
    state.actionable = 3;
    render();
    const count = chatCount();
    expect(count?.textContent).toBe('3 pending');
    expect(count?.getAttribute('variant')).toBe('warning');
    expect(count?.getAttribute('title')).toBe('Action Center — 3 pending');
    expect(chatLink()?.textContent).toBe('Chat3 pending');
  });

  it('shows nothing at zero', () => {
    state.actionable = 0;
    render();
    expect(chatCount()).toBeNull();
    expect(chatLink()?.textContent).toBe('Chat');
  });

  it('sits inside the Chat link, so choosing it opens Chat', () => {
    state.actionable = 2;
    render();
    const link = chatCount()?.closest('a');
    expect(link).toBe(chatLink());
    expect(link?.getAttribute('href')).toBe('/s/acme/chat');
  });

  it('stands beside no other entry', () => {
    state.actionable = 4;
    render();
    expect(container.querySelectorAll('[data-chat-nav-count]')).toHaveLength(1);
    // No plan item is open, so the Plan entry carries no count of its own.
    expect(container.querySelector('[data-plan-nav-count]')).toBeNull();
  });

  it('is withheld mid-switch, when the active space is still the previous one', () => {
    state.actionable = 5;
    state.activeSlug = 'previous';
    render();
    expect(chatCount()).toBeNull();
  });
});
