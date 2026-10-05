/**
 * @vitest-environment jsdom
 */
/**
 * A profile's settings on the machine page: posture, `unattended` and the
 * origin rules shown from the machine's inventory, and the request each
 * control makes — rendered through the section itself, with the design
 * system's primitives as plain elements and the query hooks recorded.
 */
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MutationOptions {
  path: (input: unknown) => string;
  method?: string;
  serialize?: (input: unknown) => string;
  invalidate?: unknown[];
  onError?: (error: Error, input: unknown) => void;
}

const recorded = vi.hoisted(() => ({
  options: new Map<string, unknown>(),
  mutate: new Map<string, ReturnType<typeof vi.fn>>(),
  status: undefined as unknown,
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
    Row: block('div'),
    Text: block('span'),
    Button: ({ size: _size, variant: _variant, ...props }: Record<string, unknown>) =>
      createElement('button', { type: 'button', ...props }),
    Input: (props: Record<string, unknown>) => createElement('input', props),
    Select: (props: Record<string, unknown>) => createElement('select', props),
    Checkbox: ({ label, ...props }: { label?: ReactNode } & Record<string, unknown>) =>
      createElement('label', null, createElement('input', { type: 'checkbox', ...props }), label),
  };
});

vi.mock('../providers.js', () => ({ useSpace: () => ({ spaces: [] }) }));

vi.mock('../../hooks/useApiQuery.js', async () => {
  const { vi: mocker } = await import('vitest');
  return {
    useApiQuery: () => ({ data: recorded.status }),
    useApiMutation: (options: { method?: string }) => {
      const method = options.method ?? 'POST';
      recorded.options.set(method, options);
      if (!recorded.mutate.has(method)) recorded.mutate.set(method, mocker.fn());
      return { mutate: recorded.mutate.get(method), isPending: false };
    },
  };
});

const { HostBrowserProfiles, HOST_STATUS_KEY } = await import('./HostBrowserProfiles.js');
const { BROWSER_POSTURE_LINES, BROWSER_UNATTENDED_LINE } = await import('@aflow/schemas');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WORK = {
  id: 'work',
  posture: 'ask-to-act',
  window: 'hidden',
  spaces: 'all',
  rules: [{ origin: 'https://mail.example.com', effect: 'deny' }],
  unattended: false,
  idleMinutes: 30,
  running: false,
  windowOpen: false,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  recorded.options.clear();
  recorded.mutate.clear();
  recorded.status = {
    paired: true,
    machines: [{ hostname: 'laptop', observedAt: new Date().toISOString(), browsers: [WORK] }],
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(HostBrowserProfiles));
  });
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

/** What the control asked for, and the request that input makes. */
function lastRequest(method: string): { input: unknown; path: string; body: unknown } {
  const options = recorded.options.get(method) as MutationOptions;
  const input = recorded.mutate.get(method)?.mock.calls.at(-1)?.[0];
  return {
    input,
    path: options.path(input),
    body: JSON.parse(options.serialize?.(input) ?? 'null') as unknown,
  };
}

describe('a browser profile’s settings on the machine page', () => {
  it('show the posture, the unattended choice and the rules the inventory reports', () => {
    for (const [posture, line] of Object.entries(BROWSER_POSTURE_LINES)) {
      expect(button(posture).getAttribute('aria-pressed')).toBe(String(posture === 'ask-to-act'));
      expect(container.textContent).toContain(line);
    }
    const unattended = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(unattended?.checked).toBe(false);
    expect(container.textContent).toContain(BROWSER_UNATTENDED_LINE);
    expect(container.textContent).toContain('deny https://mail.example.com');
    expect(container.textContent).not.toContain('aflow-executor-host browser');
  });

  it('set the posture, the unattended choice and a rule, and remove one, each on its route', async () => {
    await act(async () => {
      button('read-only').click();
    });
    expect(lastRequest('PUT')).toEqual({
      input: {
        hostname: 'laptop',
        profileId: 'work',
        field: 'posture',
        value: { posture: 'read-only' },
      },
      path: '/host/browsers/work/posture',
      body: { hostname: 'laptop', posture: 'read-only' },
    });

    await act(async () => {
      container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();
    });
    expect(lastRequest('PUT')).toMatchObject({
      path: '/host/browsers/work/unattended',
      body: { hostname: 'laptop', choice: 'allow' },
    });

    const origin = container.querySelector<HTMLInputElement>('input[aria-label="Origin"]');
    const effect = container.querySelector<HTMLSelectElement>('select[aria-label="Effect"]');
    if (origin === null || effect === null) throw new Error('no rule form');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        origin,
        '*.example.org',
      );
      origin.dispatchEvent(new Event('input', { bubbles: true }));
      effect.value = 'ask';
      effect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      button('Add rule').click();
    });
    expect(lastRequest('PUT')).toMatchObject({
      path: '/host/browsers/work/rules',
      body: { hostname: 'laptop', origin: '*.example.org', effect: 'ask' },
    });

    await act(async () => {
      button('Remove').click();
    });
    expect(lastRequest('DELETE')).toMatchObject({
      path: '/host/browsers/work/rules',
      body: { hostname: 'laptop', origin: 'https://mail.example.com' },
    });

    for (const method of ['PUT', 'DELETE']) {
      expect((recorded.options.get(method) as MutationOptions).invalidate).toEqual([
        HOST_STATUS_KEY,
      ]);
    }
  });

  it('ask nothing for the posture already in force', async () => {
    await act(async () => {
      button('ask-to-act').click();
    });
    expect(recorded.mutate.get('PUT')).not.toHaveBeenCalled();
  });

  it('show the executor’s refusal beside the profile', async () => {
    const refusal = "'*.example' is not an origin rule's pattern, so no rule names it.";
    await act(async () => {
      (recorded.options.get('PUT') as MutationOptions).onError?.(new Error(refusal), undefined);
    });
    expect(container.textContent).toContain(refusal);
  });
});
