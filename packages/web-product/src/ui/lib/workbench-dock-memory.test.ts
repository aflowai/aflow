import { describe, expect, it } from 'vitest';
import {
  WORKBENCH_COLLAPSED_LIMIT,
  WORKBENCH_COLLAPSED_STORAGE_KEY,
  readCollapsedConversations,
  rememberWorkbenchState,
  workbenchOpenOnLanding,
  writeCollapsedConversations,
} from './workbench-dock-memory.js';

const landing = (over: Partial<Parameters<typeof workbenchOpenOnLanding>[0]>) =>
  workbenchOpenOnLanding({
    conversationId: null,
    collapsed: [],
    phone: false,
    askedOpen: false,
    ...over,
  });

describe('workbenchOpenOnLanding', () => {
  it('opens on a new conversation', () => {
    expect(landing({})).toBe(true);
    // A collapse remembered elsewhere does not reach a new chat.
    expect(landing({ collapsed: ['a', 'b'] })).toBe(true);
  });

  it('keeps an existing conversation collapsed where the operator collapsed it', () => {
    expect(landing({ conversationId: 'a', collapsed: ['a'] })).toBe(false);
    expect(landing({ conversationId: 'b', collapsed: ['a'] })).toBe(true);
  });

  it('keeps the chat first on a phone unless the arrival asked for the Workbench', () => {
    expect(landing({ phone: true })).toBe(false);
    expect(landing({ phone: true, askedOpen: true })).toBe(true);
    expect(landing({ conversationId: 'a', collapsed: ['a'], askedOpen: true })).toBe(true);
  });
});

describe('rememberWorkbenchState', () => {
  it('records a collapse once, newest first, and forgets it on open', () => {
    const one = rememberWorkbenchState([], 'a', false);
    const two = rememberWorkbenchState(one, 'b', false);
    expect(two).toEqual(['b', 'a']);
    expect(rememberWorkbenchState(two, 'a', false)).toEqual(['a', 'b']);
    expect(rememberWorkbenchState(two, 'a', true)).toEqual(['b']);
  });

  it('drops the oldest choice past the limit', () => {
    let list: string[] = [];
    for (let i = 0; i <= WORKBENCH_COLLAPSED_LIMIT; i++) {
      list = rememberWorkbenchState(list, String(i), false);
    }
    expect(list).toHaveLength(WORKBENCH_COLLAPSED_LIMIT);
    expect(list).not.toContain('0');
    expect(list[0]).toBe(String(WORKBENCH_COLLAPSED_LIMIT));
  });
});

describe('the stored list', () => {
  it('round-trips, and reads anything malformed as empty', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    };
    writeCollapsedConversations(storage, ['a', 'b']);
    expect(readCollapsedConversations(storage)).toEqual(['a', 'b']);

    store.set(WORKBENCH_COLLAPSED_STORAGE_KEY, '{not json');
    expect(readCollapsedConversations(storage)).toEqual([]);
    store.set(WORKBENCH_COLLAPSED_STORAGE_KEY, JSON.stringify(['a', 3, null]));
    expect(readCollapsedConversations(storage)).toEqual(['a']);
    expect(readCollapsedConversations(null)).toEqual([]);
  });

  it('survives storage that refuses', () => {
    const refusing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('full');
      },
    };
    expect(readCollapsedConversations(refusing)).toEqual([]);
    expect(() => {
      writeCollapsedConversations(refusing, ['a']);
    }).not.toThrow();
  });
});
