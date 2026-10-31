/**
 * @vitest-environment jsdom
 */
/**
 * A folder's preview on the machine page (Plan 320 D18): the declaration the
 * machine publishes, with its defaults read in; "preview not declared" where
 * the machine found a web app and none is declared; and the request each
 * control makes — rendered through the section and through the page, with the
 * design system's primitives as plain elements and the query hooks recorded.
 */
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MutationOptions {
  path: (input: unknown) => string;
  method?: string;
  spaceId?: string;
  serialize?: (input: unknown) => string;
  invalidate?: unknown[];
}

const recorded = vi.hoisted(() => ({
  options: new Map<string, unknown>(),
  mutate: new Map<string, ReturnType<typeof vi.fn>>(),
  page: undefined as unknown,
}));

vi.mock('@aflow/design-system', () => {
  const block =
    (tag: string) =>
    ({ children }: { children?: ReactNode }) =>
      createElement(tag, null, children);
  return {
    Badge: block('span'),
    Card: block('div'),
    CardBody: block('div'),
    Column: block('div'),
    Heading: block('h3'),
    HelperText: block('p'),
    PageContainer: block('main'),
    Row: block('div'),
    Text: block('span'),
    Button: ({ size: _size, variant: _variant, ...props }: Record<string, unknown>) =>
      createElement('button', { type: 'button', ...props }),
    Input: (props: Record<string, unknown>) => createElement('input', props),
    Textarea: (props: Record<string, unknown>) => createElement('textarea', props),
  };
});

vi.mock('../../hooks/useApiQuery.js', async () => {
  const { vi: mocker } = await import('vitest');
  return {
    useApiQuery: () => ({ data: recorded.page, isLoading: false }),
    useApiMutation: (options: { method?: string }) => {
      const method = options.method ?? 'POST';
      recorded.options.set(method, options);
      if (!recorded.mutate.has(method)) recorded.mutate.set(method, mocker.fn());
      return { mutate: recorded.mutate.get(method), mutateAsync: mocker.fn(), isPending: false };
    },
  };
});

vi.mock('../providers.js', () => ({
  useSpace: () => ({ activeSpaceId: SPACE, isLoading: false, spaces: [] }),
  useSpaceFromRoute: () => ({ id: SPACE }),
}));
vi.mock('../../hooks/useEdition.js', () => ({ useEdition: () => ({ id: 'community-local' }) }));
vi.mock('./HostBrowserProfiles.js', () => ({ HostBrowserProfiles: () => null }));
vi.mock('./HostLocalModels.js', () => ({ HostLocalModels: () => null }));
vi.mock('./HostCodingAgent.js', () => ({ HostCodingAgent: () => null }));

const SPACE = '6f1d2c3b-4a5e-4f60-9a7b-8c9d0e1f2a3b';

const { HostFolderPreview, PREVIEW_NOT_DECLARED } = await import('./HostFolderPreview.js');
const { SpaceHostBindingsPage } = await import('../../screens/space-host-bindings.js');
const { declareFolderPreviewCommand, defaultFolderUiPaths } = await import('@aflow/schemas');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Listing = {
  hostname: string;
  declared: Record<string, unknown> | null;
  detectedWebApps: string[];
} | null;

let container: HTMLDivElement;
let root: Root;

async function show(listing: Listing, allowsExecution = true): Promise<void> {
  await act(async () => {
    root.render(
      createElement(HostFolderPreview, {
        spaceId: SPACE,
        bindingId: 'hb_site',
        allowsExecution,
        listing: listing as never,
      }),
    );
  });
}

beforeEach(() => {
  recorded.options.clear();
  recorded.mutate.clear();
  recorded.page = undefined;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent === name);
  if (found === undefined) throw new Error(`no button ${name}`);
  return found;
}

function hasButton(name: string): boolean {
  return [...container.querySelectorAll('button')].some((b) => b.textContent === name);
}

async function type(label: string, value: string): Promise<void> {
  const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[aria-label="${label}"]`,
  );
  if (field === null) throw new Error(`no field ${label}`);
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function lastRequest(method: string): { path: string; body: unknown } | undefined {
  const options = recorded.options.get(method) as MutationOptions;
  const calls = recorded.mutate.get(method)?.mock.calls ?? [];
  if (calls.length === 0) return undefined;
  const input = calls.at(-1)?.[0];
  return {
    path: options.path(input),
    body: JSON.parse(options.serialize?.(input) ?? 'null') as unknown,
  };
}

describe('a folder’s preview on the machine page', () => {
  it('shows the declaration with its defaults read in, and clears it on its route', async () => {
    await show({
      hostname: 'laptop',
      declared: { command: 'yarn dev --port {port}' },
      detectedWebApps: [],
    });
    const text = container.textContent ?? '';
    expect(text).toContain('yarn dev --port {port}');
    expect(text).toContain('free port, a new one each run');
    expect(text).toContain('Ready at / (default)');
    expect(text).toContain('Within 120 s (default)');
    expect(text).toContain(`UI files (default): ${defaultFolderUiPaths().join(', ')}`);
    expect(text).not.toContain(PREVIEW_NOT_DECLARED);
    expect(text).not.toContain('aflow folder hb_site preview');

    await act(async () => {
      button('Clear preview').click();
    });
    expect(lastRequest('DELETE')).toEqual({
      path: '/host/folders/hb_site/preview',
      body: { hostname: 'laptop' },
    });
    expect((recorded.options.get('DELETE') as MutationOptions).invalidate).toEqual([
      ['space', SPACE, 'hostBindings'],
    ]);
    expect((recorded.options.get('DELETE') as MutationOptions).spaceId).toBe(SPACE);
    expect((recorded.options.get('PUT') as MutationOptions).spaceId).toBe(SPACE);
  });

  it('shows a fixed port and the folder’s own ready path and UI paths as declared', async () => {
    await show({
      hostname: 'laptop',
      declared: {
        command: 'pnpm dev',
        port: 4321,
        readyPath: '/health',
        readyWithinSeconds: 900,
        uiPaths: ['src/**'],
      },
      detectedWebApps: [],
    });
    const text = container.textContent ?? '';
    expect(text).toContain('Port: 4321');
    expect(text).toContain('Ready at /health');
    expect(text).toContain('Within 900 s');
    expect(text).not.toContain('(default)');
    expect(text).toContain('UI files: src/**');
  });

  it('says the preview is not declared where the machine found a web app, and declares one', async () => {
    await show({ hostname: 'laptop', declared: null, detectedWebApps: ['apps/web'] });
    expect(container.textContent).toContain(PREVIEW_NOT_DECLARED);
    expect(container.textContent).toContain('apps/web');
    // The command that declares it on the machine, as the review's needs_setup finding names it (D21).
    expect(container.textContent).toContain(declareFolderPreviewCommand('hb_site'));
    expect(container.textContent).toContain(
      'aflow folder hb_site preview --command "<the command that serves it, with {port}>"',
    );
    expect(container.textContent).toContain('needs_setup');
    expect(hasButton('Clear preview')).toBe(false);

    await act(async () => {
      button('Declare preview').click();
    });
    await type('Preview command', 'yarn dev --port {port}');
    await type('Ready path', '/health');
    await type('Ready within seconds', '900');
    await type('UI paths', 'apps/web/**\n\n  src/**/*.css ');
    await type('Web app directories', 'apps/web');
    await act(async () => {
      button('Save preview').click();
    });
    expect(lastRequest('PUT')).toEqual({
      path: '/host/folders/hb_site/preview',
      body: {
        hostname: 'laptop',
        preview: {
          command: 'yarn dev --port {port}',
          readyPath: '/health',
          readyWithinSeconds: 900,
          uiPaths: ['apps/web/**', 'src/**/*.css'],
          webAppDirs: ['apps/web'],
        },
      },
    });
  });

  it('refuses on the page what the shared schema refuses, asking nothing of the machine', async () => {
    await show({ hostname: 'laptop', declared: null, detectedWebApps: [] });
    expect(container.textContent).not.toContain(PREVIEW_NOT_DECLARED);
    // No web app found: nothing to declare is asked of the person but the form.
    expect(container.textContent).not.toContain('aflow folder hb_site preview');
    await act(async () => {
      button('Declare preview').click();
    });
    await type('Preview command', 'yarn dev');
    await act(async () => {
      button('Save preview').click();
    });
    expect(lastRequest('PUT')).toBeUndefined();
    expect(container.textContent).toContain('{port}');

    await type('Preview port', '99999x');
    await act(async () => {
      button('Save preview').click();
    });
    expect(lastRequest('PUT')).toBeUndefined();
    expect(container.textContent).toContain('is not a port');

    await type('Preview port', '5173');
    await type('Ready within seconds', '15m');
    await act(async () => {
      button('Save preview').click();
    });
    expect(lastRequest('PUT')).toBeUndefined();
    expect(container.textContent).toContain('is not a number of seconds');

    await type('Ready within seconds', '1801');
    await act(async () => {
      button('Save preview').click();
    });
    expect(lastRequest('PUT')).toBeUndefined();
    expect(container.textContent).toContain('at most 1800 seconds');

    await type('Ready within seconds', '');
    await act(async () => {
      button('Save preview').click();
    });
    expect(lastRequest('PUT')?.body).toEqual({
      hostname: 'laptop',
      preview: { command: 'yarn dev', port: 5173 },
    });
  });

  it('shows nothing where no machine holding the folder runs, or the folder runs no commands and declares none', async () => {
    await show(null);
    expect(container.textContent).toBe('');
    await show({ hostname: 'laptop', declared: null, detectedWebApps: ['.'] }, false);
    expect(container.textContent).toBe('');
  });

  it('is part of each connected folder on the page', async () => {
    recorded.page = {
      machines: [],
      bindings: [
        {
          hostBindingId: 'hb_site',
          label: 'site',
          root: '/Users/someone/site',
          writable: true,
          allowsExecution: true,
          branchPrefix: null,
          pushApproval: null,
          mergePosture: null,
          mergePostureIdleReason: null,
          preview: { hostname: 'laptop', declared: null, detectedWebApps: ['.'] },
        },
      ],
    };
    await act(async () => {
      root.render(createElement(SpaceHostBindingsPage));
    });
    expect(container.textContent).toContain('Connected folders');
    expect(container.textContent).toContain(PREVIEW_NOT_DECLARED);
    expect(hasButton('Declare preview')).toBe(true);
  });
});
