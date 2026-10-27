// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const state = vi.hoisted(() => ({
  installed: false,
  folder: false,
  agent: false,
  schedule: false,
  role: 'admin',
  install: vi.fn(),
  preview: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ catalogId: 'coding-loop' }) }));
vi.mock('../components/providers.js', () => ({
  useSpaceFromRoute: () => ({ id: 'space', slug: 'space', myRole: state.role }),
}));
vi.mock('../components/navigation-provider.js', () => ({
  useNavigation: () => ({ push: vi.fn() }),
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
vi.mock('../hooks/useApiQuery.js', () => ({ useApiMutation: () => ({}) }));
vi.mock('../lib/oauthConsentPopup.js', () => ({ useOAuthConsentPopup: () => ({}) }));
vi.mock('../components/app-page-header.js', () => ({ AppPageHeader: () => null }));
vi.mock('../components/markdown-renderer.js', () => ({ MarkdownRenderer: () => null }));
vi.mock('../components/store-detail/inside.js', () => ({
  BundleInside: () => null,
  ConnectorInside: () => null,
}));
vi.mock('../components/setup-checklist.js', () => ({
  SetupChecklist: ({ tasks }: { tasks: { step: string }[] }) =>
    createElement('div', null, tasks.map((task) => task.step).join(' ')),
}));
vi.mock('@aflow/design-system', () => {
  const wrapper = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    ...Object.fromEntries(
      ['Badge', 'Card', 'CardBody', 'Column', 'Heading', 'PageContainer', 'Row', 'Text'].map(
        (key) => [key, wrapper],
      ),
    ),
    Icon: () => null,
    ListingAvatar: () => null,
    Spinner: () => null,
    Button: ({
      children,
      onClick,
      disabled,
    }: {
      children?: ReactNode;
      onClick?: () => void;
      disabled?: boolean;
    }) => createElement('button', { onClick, disabled }, children),
    Dialog: ({
      open,
      children,
      footer,
    }: {
      open: boolean;
      children?: ReactNode;
      footer?: ReactNode;
    }) => (open ? createElement('div', { role: 'dialog' }, children, footer) : null),
  };
});
vi.mock('../hooks/use-store.js', async (original) => ({
  ...(await original<typeof import('../hooks/use-store.js')>()),
  useStoreListing: () => ({
    data: {
      entry: {
        catalogId: 'coding-loop',
        name: 'Coding Loop',
        version: 7,
        kind: 'bundle',
        status: 'published',
        tags: [],
        payload: { apiDefinitions: [], mcpDefinitions: [] },
      },
      installedState: { installed: state.installed, installedVersion: 7, updateAvailable: false },
      requirements: { credentialKeys: [], oauthIssuers: [] },
      readiness: { status: 'needs_setup', tasks: tasks() },
    },
  }),
  useStoreListings: () => ({ data: { listings: [] } }),
  useStoreInstallPreview: () => ({ mutateAsync: state.preview }),
  useStoreInstall: () => ({ mutateAsync: state.install }),
  useStoreUpdatePreview: () => ({}),
  useStoreUpdate: () => ({}),
  useStoreUninstallPreview: () => ({}),
  useStoreUninstall: () => ({}),
}));

function tasks() {
  return [
    ...(!state.folder ? [{ step: 'folder' }] : []),
    ...(!state.agent ? [{ step: 'agent' }] : []),
    ...(!state.schedule ? [{ step: 'schedule' }] : []),
  ];
}

import { StoreListingPage } from './space-store-detail.js';

describe('Store installation repair', () => {
  it('completes a current-version install made before connecting a folder through the repair action', async () => {
    state.preview.mockImplementation(async () => ({
      catalogVersion: 7,
      creates: [],
      conflicts: [],
      missingCapabilities: [],
      setupChecklist: tasks(),
      readiness: tasks().length ? 'needs_setup' : 'ready',
    }));
    state.install.mockImplementation(async () => {
      state.installed = true;
      if (state.folder) state.agent = true;
      return { result: { kind: 'bundle', warnings: [] }, setupChecklist: tasks() };
    });
    const container = document.createElement('div');
    document.body.append(container);
    let root = createRoot(container);
    const render = async () => {
      await act(async () => root.render(createElement(StoreListingPage)));
    };
    const click = async (label: string) => {
      const scope = container.querySelector('[role="dialog"]') ?? container;
      const button = [...scope.querySelectorAll('button')].find(
        (node) => node.textContent === label,
      );
      expect(button).toBeDefined();
      await act(async () => button?.click());
    };
    try {
      await render();
      await click('Install');
      await click('Install');
      expect(state.installed).toBe(true);
      expect(state.agent).toBe(false);
      expect(container.textContent).toContain('folder agent schedule');
      state.install.mockClear();
      state.folder = true;
      await act(async () => root.unmount());
      root = createRoot(container);
      await render();
      expect(container.textContent).toContain('agent schedule');
      await click('Repair installation');
      expect(state.install).not.toHaveBeenCalled();
      await click('Install');
      expect(state.install).toHaveBeenCalledWith({
        catalogId: 'coding-loop',
        expectedVersion: 7,
        idempotencyKey: expect.any(String),
      });
      expect(state.agent).toBe(true);
      expect(container.textContent).not.toContain('agent schedule');
      expect(container.textContent).toContain('schedule');
      state.schedule = true;
      await act(async () => root.unmount());
      root = createRoot(container);
      await render();
      await click('Check setup again');
      expect(container.textContent).toContain('Everything this needs is set up in this space.');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
