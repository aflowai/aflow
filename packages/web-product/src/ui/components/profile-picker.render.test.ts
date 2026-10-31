/**
 * @vitest-environment jsdom
 */
/**
 * Who is using Aflow? starts a profile with one tap (Plan 335 D1). Each tile
 * is a submit button that posts the profile's id to the web process, and the
 * picker asks for nothing else.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LocalProfileChoice } from '@aflow/schemas';
import { LOCAL_PROFILE_CHOICE_FIELD, LOCAL_PROFILE_CHOICE_PATH } from '@aflow/web-product';

import { ProfilePicker } from './profile-picker.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const PROFILES: LocalProfileChoice[] = [
  {
    userId: '00000000-0000-4000-8000-0000000ed1c1',
    displayName: 'Local user',
    avatar: null,
    isOwner: true,
  },
  {
    userId: '00000000-0000-4000-8000-00000000a0a0',
    displayName: 'Research',
    avatar: 'owl',
    isOwner: false,
  },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('the profile picker', () => {
  it('starts each profile with one tap on its tile', () => {
    act(() => root.render(createElement(ProfilePicker, { profiles: PROFILES })));
    const forms = container.querySelectorAll('form');
    expect(forms).toHaveLength(1);
    const form = forms[0] as HTMLFormElement;
    expect(form.getAttribute('method')).toBe('post');
    expect(form.getAttribute('action')).toBe(LOCAL_PROFILE_CHOICE_PATH);

    const tiles = [...form.querySelectorAll('button')];
    expect(tiles.map((tile) => tile.getAttribute('aria-label'))).toEqual([
      'Continue as Local user',
      'Continue as Research',
    ]);
    for (const [index, tile] of tiles.entries()) {
      expect(tile.type).toBe('submit');
      expect(tile.name).toBe(LOCAL_PROFILE_CHOICE_FIELD);
      expect(tile.value).toBe(PROFILES[index]?.userId);
    }
  });

  it('asks for nothing but the tap', () => {
    act(() => root.render(createElement(ProfilePicker, { profiles: PROFILES })));
    expect(container.querySelectorAll('input, select, textarea')).toHaveLength(0);
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.textContent).not.toMatch(/PIN/);
  });
});
