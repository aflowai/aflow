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
const clicks: Array<{ noWaitAfter?: boolean }> = [];
const located: string[] = [];
const shots: Array<{ type: string; mask: unknown[]; fullPage?: boolean }> = [];

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
  click: (options: { noWaitAfter?: boolean }) => {
    clicks.push(options);
    return Promise.resolve();
  },
  screenshot: (options: { type: string; mask: unknown[] }) => {
    shots.push(options);
    return Promise.resolve(Buffer.alloc(0));
  },
  hover: () => Promise.resolve(),
};

/** An ordinary element that went away between the outline and the action. */
const detachedInput = {
  ...passwordInput,
  evaluate: (): Promise<never> => Promise.reject(new Error('Element is not attached to the DOM')),
};

let underRef: typeof passwordInput = passwordInput;

const page = {
  locator: (selector: string) => {
    located.push(selector);
    return underRef;
  },
  screenshot: (options: { type: string; mask: unknown[]; fullPage: boolean }) => {
    shots.push(options);
    return Promise.resolve(Buffer.alloc(0));
  },
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

describe('the engine after an action that starts no navigation', () => {
  it('asks Playwright not to wait, and returns without waiting on a navigation', async () => {
    const enginePage = await openPage();
    const startedAt = Date.now();
    await enginePage.act('e5', { kind: 'click' });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(clicks.at(-1)).toMatchObject({ noWaitAfter: true });
  });
});

describe('the engine reading a page’s text fields', () => {
  const field = (properties: Record<string, unknown>): typeof passwordInput => ({
    ...passwordInput,
    evaluate: <R>(fn: (element: unknown) => R): Promise<R> =>
      Promise.resolve(fn({ tagName: 'INPUT', maxLength: -1, ...properties })),
  });

  it.each([
    ['a password field', { type: 'password' }, true, true],
    ['a one-time-code field', { type: 'text', autocomplete: 'one-time-code' }, false, true],
    ['a passkey field', { type: 'text', autocomplete: 'username webauthn' }, false, true],
    ['a short numeric field', { type: 'tel', inputMode: 'numeric', maxLength: 6 }, false, true],
    ['a long numeric field', { type: 'text', inputMode: 'numeric', maxLength: 20 }, false, false],
    ['a search field', { type: 'search', autocomplete: 'off' }, false, false],
  ])('reads %s', async (_name, properties, masked, credential) => {
    underRef = field(properties);
    const read = await (await openPage()).snapshot();
    underRef = passwordInput;
    expect(read.maskedRefs.has('e5')).toBe(masked);
    expect(read.holdsCredentialField).toBe(credential);
  });

  it('takes a field it could not read as one that might take a credential', async () => {
    underRef = detachedInput;
    const read = await (await openPage()).snapshot();
    underRef = passwordInput;
    expect(read.maskedRefs.has('e5')).toBe(true);
    expect(read.holdsCredentialField).toBe(true);
  });
});

describe('the engine taking a screenshot', () => {
  it('masks every password field, of the page or of one element', async () => {
    const enginePage = await openPage();
    located.length = 0;
    await enginePage.screenshot({ fullPage: true });
    await enginePage.screenshot({ ref: 'e5', fullPage: false, jpegQuality: 60 });
    expect(located.filter((selector) => selector === 'input[type=password]')).toHaveLength(2);
    expect(shots.map((shot) => [shot.type, shot.mask.length, shot.fullPage])).toEqual([
      ['png', 1, true],
      ['jpeg', 1, undefined],
    ]);
  });
});
