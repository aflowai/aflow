// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  CapabilityBundleEditor,
  bundleCurrentCost,
  type OfferedBundle,
} from './CapabilityBundleEditor.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const bundle: OfferedBundle = {
  id: 'memory_write',
  label: 'Memory write',
  hint: 'Write notes',
  tier: 'on_demand',
  defaultPlacement: 'on_demand',
  operationCount: 2,
  alwaysOnTokens: 300,
  authoredPinnedTokens: 0,
  authoredPinnedCount: 0,
  operations: [
    { operationId: 'memory.store.put', tokens: 200, defaultPinned: false },
    { operationId: 'memory.store.patch', tokens: 100, defaultPinned: false },
  ],
};
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(() => root?.unmount());
  document.body.innerHTML = '';
});

describe('capability placement controls', () => {
  it('distinguishes inheriting the default from an explicit equal placement and resetting it', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    root = createRoot(target);
    const changes: Array<string | undefined> = [];
    await act(() =>
      root!.render(
        createElement(CapabilityBundleEditor, {
          bundles: [bundle],
          placements: {},
          showHints: true,
          onPlace: (_id, value) => changes.push(value),
        }),
      ),
    );
    const select = target.querySelector<HTMLSelectElement>(
      'select[aria-label="Memory write placement"]',
    )!;
    expect(select.value).toBe('default');
    await act(() => {
      select.value = 'on_demand';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(() => {
      select.value = 'default';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(changes).toEqual(['on_demand', undefined]);
    expect(target.textContent).toContain('300 estimated tokens');
  });
  it('prices an individual pinned operation and keeps group Off stronger than an old override', () => {
    expect(bundleCurrentCost(bundle, {}, { 'memory.store.put': 'always_on' })).toEqual({
      tools: 1,
      tokens: 200,
    });
    expect(bundleCurrentCost(bundle, { memory_write: 'always_on' })).toEqual({
      tools: 2,
      tokens: 300,
    });
    expect(
      bundleCurrentCost(bundle, { memory_write: 'off' }, { 'memory.store.put': 'always_on' }),
    ).toEqual({ tools: 0, tokens: 0 });
  });
});
