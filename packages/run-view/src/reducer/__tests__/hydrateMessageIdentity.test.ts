/**
 * Reading further back re-folds the conversation, so every message in the
 * snapshot is a new object. The transcript memoizes on identity, so the
 * reducer keeps the object it already holds for each message that came back
 * unchanged.
 */
import { describe, expect, it } from 'vitest';
import { runViewReducer, initialRunViewState, type RunViewState } from '../../reducer.js';
import type { Message } from '../../types.js';
import { reuseUnchangedMessages, sameMessageValue } from '../messageIdentity.js';

function message(id: string, content: string, extra: Partial<Message> = {}): Message {
  return { id, role: 'assistant', content, timestamp: '2026-11-07T10:00:00.000Z', ...extra };
}

function refolded(messages: Message[]): Message[] {
  return JSON.parse(JSON.stringify(messages)) as Message[];
}

function snapshot(messages: Message[]): RunViewState {
  return { ...initialRunViewState, status: 'SUCCEEDED', messages };
}

describe('HYDRATE_SNAPSHOT message identity', () => {
  it('keeps the held object for every message a deeper page carries unchanged', () => {
    const shown = [message('m2', 'two', { richContent: { rows: [1, 2] } }), message('m3', 'three')];
    const state = runViewReducer(initialRunViewState, {
      type: 'HYDRATE_SNAPSHOT',
      snapshot: snapshot(shown),
    });
    const [m2, m3] = state.messages;

    const older = message('m1', 'one');
    const next = runViewReducer(state, {
      type: 'HYDRATE_SNAPSHOT',
      snapshot: snapshot(refolded([older, ...state.messages])),
    });

    expect(next.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(next.messages[1]).toBe(m2);
    expect(next.messages[2]).toBe(m3);
    expect(next.messages[0]).toEqual(older);
  });

  it('takes the snapshot object for a message whose content changed', () => {
    const state = runViewReducer(initialRunViewState, {
      type: 'HYDRATE_SNAPSHOT',
      snapshot: snapshot([message('m1', 'draft')]),
    });
    const changed = message('m1', 'final');
    const next = runViewReducer(state, {
      type: 'HYDRATE_SNAPSHOT',
      snapshot: snapshot([changed]),
    });
    expect(next.messages[0]).toBe(changed);
  });

  it('keeps the held array when the snapshot changes no message', () => {
    const state = runViewReducer(initialRunViewState, {
      type: 'HYDRATE_SNAPSHOT',
      snapshot: snapshot([message('m1', 'one'), message('m2', 'two')]),
    });
    const next = runViewReducer(state, {
      type: 'HYDRATE_SNAPSHOT',
      snapshot: snapshot(refolded(state.messages)),
    });
    expect(next.messages).toBe(state.messages);
  });

  it('drops a held message the snapshot no longer carries', () => {
    const held = [message('m1', 'one'), message('m2', 'two')];
    const next = reuseUnchangedMessages(held, refolded([held[1] as Message]));
    expect(next).toEqual([held[1]]);
    expect(next[0]).toBe(held[1]);
  });
});

describe('sameMessageValue', () => {
  it('compares nested values structurally and ignores key order', () => {
    expect(sameMessageValue({ a: [1, { b: 2 }], c: 'x' }, { c: 'x', a: [1, { b: 2 }] })).toBe(true);
    expect(sameMessageValue({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
    expect(sameMessageValue([1, 2], { 0: 1, 1: 2 })).toBe(false);
  });

  it('reads a key holding undefined as absent, as a JSON round trip does', () => {
    expect(sameMessageValue({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(sameMessageValue({ a: 1, b: null }, { a: 1 })).toBe(false);
  });
});
