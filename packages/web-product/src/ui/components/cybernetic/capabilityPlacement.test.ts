// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  CapabilityBundleEditor,
  bundleCurrentCost,
  bundlePlacementOf,
  nestBundles,
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
    await act(() =>
      target.querySelector<HTMLButtonElement>('section[aria-label="On demand"] > button')!.click(),
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
    expect(target.textContent).toContain('300 tok');
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
  it('groups by resolved tool placements, including overrides, group Off and required tools', () => {
    expect(bundlePlacementOf(bundle, {})).toBe('on_demand');
    expect(bundlePlacementOf(bundle, {}, { 'memory.store.put': 'always_on' })).toBe('mixed');
    expect(
      bundlePlacementOf(bundle, { memory_write: 'off' }, { 'memory.store.put': 'always_on' }),
    ).toBe('off');
    const required = {
      ...bundle,
      lockedReason: 'Required for chat',
      defaultPlacement: 'always_on' as const,
      operations: bundle.operations.map((op) => ({ ...op, defaultPinned: true })),
    };
    expect(
      bundlePlacementOf(required, { memory_write: 'off' }, { 'memory.store.put': 'off' }),
    ).toBe('always_on');
  });
  it('shows state sections, a custom group, and consistently locked required controls', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    root = createRoot(target);
    const required = {
      ...bundle,
      id: 'chat',
      label: 'Chat',
      lockedReason: 'Required for replies',
      defaultPlacement: 'always_on' as const,
      operations: [{ operationId: 'chat.reply', tokens: 100, defaultPinned: true }],
    };
    await act(() =>
      root!.render(
        createElement(CapabilityBundleEditor, {
          bundles: [bundle, required],
          placements: {},
          operationPlacements: { 'memory.store.put': 'always_on' },
          showHints: false,
          onPlace: () => {},
        }),
      ),
    );
    expect(
      [...target.querySelectorAll('section')].map((section) => section.getAttribute('aria-label')),
    ).toEqual(['Always on', 'On demand', 'Off', 'Custom']);
    await act(() =>
      target.querySelector<HTMLButtonElement>('section[aria-label="Always on"] > button')!.click(),
    );
    const locked = target.querySelector<HTMLSelectElement>('select[aria-label="Chat placement"]')!;
    expect(locked.disabled).toBe(true);
    expect(locked.value).toBe('always_on');
    expect(locked.title).toBe('Required for replies');
    await act(() =>
      target.querySelector<HTMLButtonElement>('section[aria-label="Custom"] > button')!.click(),
    );
    expect(
      target.querySelector<HTMLSelectElement>('select[aria-label="Memory write placement"]')!.value,
    ).toBe('custom');
  });
  it('searches operation IDs and opens matching groups without changing placements', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    root = createRoot(target);
    const changes: string[] = [];
    await act(() =>
      root!.render(
        createElement(CapabilityBundleEditor, {
          bundles: [bundle],
          placements: {},
          showHints: false,
          onPlace: (id) => changes.push(id),
        }),
      ),
    );
    const input = target.querySelector('input')!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'memory.store.patch',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(
      target.querySelector('select[aria-label="memory.store.patch placement"]'),
    ).not.toBeNull();
    expect(
      target
        .querySelector('button[aria-label="Tools in Memory write"]')
        ?.getAttribute('aria-expanded'),
    ).toBe('true');
    expect(changes).toEqual([]);
    expect(target.querySelector('section[aria-label="Always on"]')).toBeNull();
    expect(target.querySelector('section[aria-label="Off"]')).toBeNull();
  });
  it('nests a bundle under the offered bundle its parentId names, and leaves family keys flat', async () => {
    const make = (id: string, label: string, parentId?: string): OfferedBundle => ({
      ...bundle,
      id,
      label,
      ...(parentId ? { parentId } : {}),
      operations: [{ operationId: `${id}.op`, tokens: 10, defaultPinned: false }],
    });
    const visuals = make('visuals', 'Visuals', 'visuals');
    const artifacts = make('artifacts', 'Build artifacts', 'visuals');
    const runSkills = make('run_skills', 'Run skills', 'skills');
    const agents = make('agents', 'Agents');
    expect(
      nestBundles([artifacts, runSkills, visuals, agents]).map(({ bundle: b, children }) => [
        b.id,
        children.map((c) => c.id),
      ]),
    ).toEqual([
      ['agents', []],
      ['run_skills', []],
      ['visuals', ['artifacts']],
    ]);
    expect(nestBundles([artifacts]).map(({ bundle: b }) => b.id)).toEqual(['artifacts']);

    const target = document.createElement('div');
    document.body.appendChild(target);
    root = createRoot(target);
    await act(() =>
      root!.render(
        createElement(CapabilityBundleEditor, {
          bundles: [artifacts, agents, visuals],
          placements: {},
          showHints: false,
          onPlace: () => {},
        }),
      ),
    );
    await act(() =>
      target.querySelector<HTMLButtonElement>('section[aria-label="On demand"] > button')!.click(),
    );
    const within = target.querySelector('[role="group"][aria-label="Within Visuals"]');
    expect(within?.querySelector('select[aria-label="Build artifacts placement"]')).not.toBeNull();
    const order = [...target.querySelectorAll('select')].map((s) => s.getAttribute('aria-label'));
    expect(order.indexOf('Build artifacts placement')).toBe(order.indexOf('Visuals placement') + 1);
    expect(order.indexOf('Agents placement')).toBeLessThan(order.indexOf('Visuals placement'));
  });
});
