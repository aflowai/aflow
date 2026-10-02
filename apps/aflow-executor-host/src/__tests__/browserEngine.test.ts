/**
 * The engine's own check on the element under a reference, at the moment of
 * the action. The driver's check reads the snapshot the agent saw; this one
 * holds when that snapshot is older than the field now on the page.
 */
import { describe, expect, it, vi } from 'vitest';

import { createPlaywrightEngine } from '../browser/engine.js';
import { EngineCredentialField, EngineFieldUnchecked, type EnginePage } from '../browser/types.js';

const pressed: string[] = [];
const filled: string[] = [];

const passwordInput = {
  evaluate: <R>(fn: (element: unknown) => R): Promise<R> =>
    Promise.resolve(fn({ tagName: 'INPUT', type: 'password' })),
  count: () => Promise.resolve(1),
  press: (key: string) => {
    pressed.push(key);
    return Promise.resolve();
  },
  fill: (text: string) => {
    filled.push(text);
    return Promise.resolve();
  },
  selectOption: () => Promise.resolve([]),
  click: () => Promise.resolve(),
  hover: () => Promise.resolve(),
};

/** An ordinary element that went away between the outline and the action. */
const detachedInput = {
  ...passwordInput,
  evaluate: (): Promise<never> => Promise.reject(new Error('Element is not attached to the DOM')),
};

let underRef: typeof passwordInput = passwordInput;

const page = {
  locator: () => underRef,
  ariaSnapshot: () => Promise.resolve('- textbox "Passphrase" [ref=e5]'),
  waitForLoadState: () => Promise.resolve(),
  url: () => 'https://example.com/',
  on: () => undefined,
  off: () => undefined,
};

vi.mock('playwright-core', () => ({
  chromium: {
    connectOverCDP: () =>
      Promise.resolve({
        contexts: () => [{ newPage: () => Promise.resolve(page), cookies: () => [] }],
      }),
  },
}));

async function openPage(): Promise<EnginePage> {
  const browser = await createPlaywrightEngine().connect('ws://chrome', 1_000);
  return await browser.newPage({ console: () => undefined, request: () => undefined });
}

describe('the engine on a password input', () => {
  it('refuses a character key though the snapshot did not mask the field', async () => {
    const enginePage = await openPage();
    await expect(enginePage.act('e5', { kind: 'press', key: 'h' })).rejects.toBeInstanceOf(
      EngineCredentialField,
    );
    await expect(
      enginePage.act('e5', { kind: 'type', text: 'abc', submit: false }),
    ).rejects.toBeInstanceOf(EngineCredentialField);
    await expect(enginePage.act('e5', { kind: 'select', values: ['x'] })).rejects.toBeInstanceOf(
      EngineCredentialField,
    );
    expect(pressed).toEqual([]);
    expect(filled).toEqual([]);
  });

  it('presses Enter on it', async () => {
    const enginePage = await openPage();
    await enginePage.act('e5', { kind: 'press', key: 'Enter' });
    expect(pressed).toEqual(['Enter']);
  });
});

describe('the engine on an element it cannot check', () => {
  it('refuses a value as unchecked, not as a password field, and enters nothing', async () => {
    underRef = detachedInput;
    const enginePage = await openPage();
    const before = { pressed: pressed.length, filled: filled.length };
    for (const action of [
      { kind: 'press', key: 'h' },
      { kind: 'type', text: 'abc', submit: false },
      { kind: 'select', values: ['x'] },
    ] as const) {
      const refused = await enginePage.act('e5', action).catch((error: unknown) => error);
      expect(refused, action.kind).toBeInstanceOf(EngineFieldUnchecked);
      expect(refused, action.kind).not.toBeInstanceOf(EngineCredentialField);
      expect((refused as EngineFieldUnchecked).reason).toBe('Element is not attached to the DOM');
    }
    expect(pressed.length).toBe(before.pressed);
    expect(filled.length).toBe(before.filled);
    underRef = passwordInput;
  });
});
