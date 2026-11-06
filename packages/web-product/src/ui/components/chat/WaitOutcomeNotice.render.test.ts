/**
 * @vitest-environment jsdom
 */
/**
 * A wait's room message renders in the chat as one folded line. The agent's
 * full text sits behind a button that a keyboard reaches and toggles, and
 * expanding it shows the text whole.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WAIT_OUTCOME_ACTOR_ID } from '@aflow/schemas';
import type { Message } from '../../lib/types.js';

vi.mock('../providers.js', () => ({
  useApi: () => ({
    apiUrl: 'http://api',
    headers: () => ({}),
    authFetch: () => Promise.resolve(new Response()),
    blockedSession: null,
  }),
  useSpace: () => ({ activeSpaceId: 'space-1', activeSpace: { id: 'space-1', slug: 'main' } }),
}));
vi.mock('../../hooks/useApiQuery.js', () => ({
  useApiQuery: () => ({ data: undefined, error: null, isError: false }),
}));

const { MessageWithCopy } = await import('./MessageWithCopy.js');

const INSTRUCTION =
  'Run a Local PR Shepherd pass aimed at it: workflow.run.start with slug local-pr-shepherd, bindingId: hb_aflow.';
const BODY =
  'Your wait 23e0cfeb-0000-4000-8000-000000000339 on pull_request.changed on aflowai/aflow#315 has ended: ' +
  'the event arrived at 2026-11-06T08:00:00.000Z (change: checks_green, url: https://github.com/aflowai/aflow/pull/315, headSha: abc123). ' +
  `You own the subject, so the platform declared this wait for you. ${INSTRUCTION}`;

const message: Message = {
  id: 'room-1',
  role: 'user',
  content: BODY,
  timestamp: '2026-11-06T08:00:01.000Z',
  authorUserId: WAIT_OUTCOME_ACTOR_ID,
  authorDisplayName: 'Wait',
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      createElement(MessageWithCopy, { message, userAvatar: null, showSubflowHeader: false }),
    );
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function toggle(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('.chat-wait-notice__toggle');
  expect(button).not.toBeNull();
  return button!;
}

function body(): HTMLElement {
  const controlled = document.getElementById(toggle().getAttribute('aria-controls') ?? '');
  expect(controlled).not.toBeNull();
  return controlled!;
}

/**
 * Press a key on the focused element. jsdom does not run a button's keyboard
 * activation, so this runs it as the HTML standard does: Enter clicks on
 * keydown, Space on keyup, and a cancelled key clicks nothing.
 */
function press(key: 'Enter' | ' '): void {
  const target = document.activeElement;
  if (!(target instanceof HTMLButtonElement)) throw new Error('no button has focus');
  act(() => {
    const down = target.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
    if (key === 'Enter' && down) target.click();
    const up = target.dispatchEvent(
      new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }),
    );
    if (key === ' ' && down && up) target.click();
  });
}

describe('a wait outcome in the chat', () => {
  it('folds to one line that names the pull request, with the instruction hidden', () => {
    expect(container.querySelector('[data-wait-notice]')?.getAttribute('data-wait-notice')).toBe(
      'folded',
    );
    expect(toggle().textContent).toContain(
      'Wait for pull request aflowai/aflow#315 ended: its checks passed.',
    );
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(body().hidden).toBe(true);
    expect(container.querySelector('.ds-chat-message--peer')).toBeNull();
    expect(container.textContent).not.toContain('Someone');
  });

  it('shows the full text, instruction included, once expanded, and folds again', () => {
    act(() => {
      toggle().click();
    });

    expect(container.querySelector('[data-wait-notice]')?.getAttribute('data-wait-notice')).toBe(
      'expanded',
    );
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(body().hidden).toBe(false);
    expect(body().textContent).toBe(BODY);
    expect(body().textContent).toContain(INSTRUCTION);

    act(() => {
      toggle().click();
    });
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(body().hidden).toBe(true);
  });

  it('is a native button, so the keyboard reaches it and Enter or Space toggles it', () => {
    const button = toggle();
    expect(button.tagName).toBe('BUTTON');
    expect(button.type).toBe('button');
    expect(button.tabIndex).toBe(0);
    button.focus();
    expect(document.activeElement).toBe(button);

    press('Enter');
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(body().hidden).toBe(false);

    press(' ');
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(body().hidden).toBe(true);

    press(' ');
    expect(toggle().getAttribute('aria-expanded')).toBe('true');

    press('Enter');
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
  });
});
