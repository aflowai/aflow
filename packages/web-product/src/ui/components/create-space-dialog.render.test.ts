/**
 * @vitest-environment jsdom
 */
/**
 * Create new workspace is the one way to make a space, and it offers the quick
 * starts beside the blank start (Plan 334 D2). The chooser leads with Blank
 * workspace and lists every shelved template after it. With none on the shelf
 * the dialog opens on the blank form, as it did before the chooser.
 */
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuickStartOffer } from '@aflow/schemas';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const state = vi.hoisted(() => ({
  offer: { applies: false, templates: [] } as unknown,
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('./providers.js', () => ({ useSpace: () => ({ refresh: vi.fn() }) }));
vi.mock('../hooks/use-quick-starts.js', () => ({
  useQuickStartOffer: () => ({ isLoading: false, data: state.offer }),
  useStartQuickStart: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));
vi.mock('../hooks/useSpaceLlmReadiness.js', () => ({
  useSpaceLlmReadiness: () => ({ isLoading: true, readiness: null }),
}));
vi.mock('./create-space-form.js', () => ({
  toSlug: (name: string) => name.toLowerCase(),
  CreateSpaceForm: () => createElement('form', { 'data-testid': 'blank-form' }),
}));
vi.mock('@aflow/design-system', () => {
  const wrapper = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    ...Object.fromEntries(['CardBody', 'Column', 'Row', 'Text'].map((key) => [key, wrapper])),
    Icon: () => null,
    Spinner: () => null,
    Input: () => createElement('input'),
    Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) =>
      createElement('button', { type: 'button', onClick }, children),
    Card: ({
      children,
      onClick,
      'aria-label': ariaLabel,
    }: {
      children?: ReactNode;
      onClick?: () => void;
      'aria-label'?: string;
    }) =>
      createElement(
        'div',
        { role: 'button', 'data-card': '', 'aria-label': ariaLabel, onClick },
        children,
      ),
    Dialog: ({ open, title, children }: { open: boolean; title: string; children?: ReactNode }) =>
      open ? createElement('div', { role: 'dialog', 'aria-label': title }, children) : null,
  };
});

const { CreateSpaceDialog } = await import('./create-space-dialog.js');

const TEMPLATES: QuickStartOffer['templates'] = [
  {
    catalogId: 'coding-with-github',
    version: 1,
    name: 'Coding with GitHub',
    tagline: 'Change a repository through pull requests.',
    spaceName: 'Coding',
  },
  {
    catalogId: 'code-review-local',
    version: 1,
    name: 'Code Review on This Computer',
    tagline: 'Review a branch on this machine.',
    spaceName: 'Code Review',
  },
] as QuickStartOffer['templates'];

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
  document.body.innerHTML = '';
});

function renderDialog(): void {
  act(() => {
    root.render(
      createElement(CreateSpaceDialog, { open: true, onClose: vi.fn(), onCreated: vi.fn() }),
    );
  });
}

function cardTitles(): string[] {
  return Array.from(document.querySelectorAll('[data-card]')).map(
    (card) => card.querySelector('div')?.textContent ?? '',
  );
}

function clickText(text: string): void {
  const target = Array.from(document.querySelectorAll<HTMLElement>('[role="button"], button')).find(
    (element) => element.textContent?.includes(text),
  );
  if (!target) throw new Error(`nothing reads "${text}"`);
  act(() => {
    target.click();
  });
}

describe('CreateSpaceDialog', () => {
  it('opens on a choice: Blank workspace first, then each template', () => {
    state.offer = { applies: false, templates: TEMPLATES };
    renderDialog();

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-label')).toBe('Create new workspace');
    expect(dialog?.textContent).toContain(
      'Start blank, or from a quick start that comes with the skills and directives for one kind of work.',
    );
    const titles = cardTitles();
    expect(titles).toHaveLength(3);
    expect(titles[0]).toContain('Blank workspace');
    expect(titles[0]).toContain('Name it and set it up yourself.');
    expect(titles[1]).toContain('Coding with GitHub');
    expect(titles[1]).toContain('Change a repository through pull requests.');
    expect(titles[2]).toContain('Code Review on This Computer');
    expect(document.querySelector('[data-testid="blank-form"]')).toBeNull();
  });

  it('shows the blank form on Blank workspace, and Back returns to the choice', () => {
    state.offer = { applies: false, templates: TEMPLATES };
    renderDialog();

    clickText('Blank workspace');
    expect(document.querySelector('[data-testid="blank-form"]')).not.toBeNull();
    expect(cardTitles()).toHaveLength(0);

    clickText('Back');
    expect(document.querySelector('[data-testid="blank-form"]')).toBeNull();
    expect(cardTitles()).toHaveLength(3);
  });

  it('names the workspace once a template is chosen', () => {
    state.offer = { applies: false, templates: TEMPLATES };
    renderDialog();

    clickText('Coding with GitHub');
    const text = document.querySelector('[role="dialog"]')?.textContent ?? '';
    expect(text).toContain('Name the new workspace');
    expect(text).toContain('Create workspace');
  });

  it('opens on the blank form directly when no template is on the shelf', () => {
    state.offer = { applies: false, templates: [] };
    renderDialog();

    expect(document.querySelector('[data-testid="blank-form"]')).not.toBeNull();
    expect(cardTitles()).toHaveLength(0);
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('Back');
  });
});
