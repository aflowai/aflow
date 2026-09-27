import { APPLET_RECENT_ACTIONS_MAX, type AppletActionReceipt } from '@aflow/schemas';
import { describe, expect, it } from 'vitest';
import {
  projectAppletAttention,
  projectAppletState,
  projectRecentReceipts,
} from '../projection.js';

function receipt(seq: number): AppletActionReceipt {
  return {
    actionId: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    seq,
    actor: { kind: 'user', userId: '11111111-1111-4111-8111-111111111111' },
    name: 'move',
    input: {},
    beforeVersion: seq - 1,
    afterVersion: seq,
    patch: [],
    effects: { notable: false, waking: false, ending: false },
    at: new Date(1700000000000 + seq).toISOString(),
  };
}

describe('projectAppletState', () => {
  const state = {
    board: { squares: ['e2', 'e4'] },
    players: { white: 'karim', black: 'sara' },
    secretEval: 0.42,
    tasks: [{ owner: 'karim' }, { owner: 'sara', done: false }],
    'we/ird': 1,
  };

  it('returns the full state as a detached clone when no projection is declared', () => {
    const projected = projectAppletState(state);
    expect(projected).toEqual(state);
    expect(projected).not.toBe(state);
    (projected['board'] as Record<string, unknown>)['squares'] = [];
    expect(state.board.squares).toEqual(['e2', 'e4']);
  });

  it('bounds the state to the declared pointers', () => {
    const projected = projectAppletState(state, ['/board', '/players/white']);
    expect(projected).toEqual({
      board: { squares: ['e2', 'e4'] },
      players: { white: 'karim' },
    });
    expect(projected).not.toHaveProperty('secretEval');
  });

  it('mirrors arrays as arrays', () => {
    const projected = projectAppletState(state, ['/tasks/1/owner']);
    const tasks = projected['tasks'];
    expect(Array.isArray(tasks)).toBe(true);
    expect((tasks as unknown[]).length).toBe(2);
    expect((tasks as Record<string, unknown>[])[1]).toEqual({ owner: 'sara' });
  });

  it('omits unresolvable pointers', () => {
    expect(projectAppletState(state, ['/absent', '/board/missing'])).toEqual({});
  });

  it('treats a whole-document pointer as the full state', () => {
    expect(projectAppletState(state, ['', '/board'])).toEqual(state);
  });

  it('merges overlapping pointers', () => {
    const projected = projectAppletState(state, ['/players/white', '/players']);
    expect(projected).toEqual({ players: { white: 'karim', black: 'sara' } });
  });

  it('resolves escaped pointers', () => {
    expect(projectAppletState(state, ['/we~1ird'])).toEqual({ 'we/ird': 1 });
  });

  it('clones projected values', () => {
    const projected = projectAppletState(state, ['/board']);
    ((projected['board'] as Record<string, unknown>)['squares'] as string[]).push('d4');
    expect(state.board.squares).toEqual(['e2', 'e4']);
  });
});

describe('projectRecentReceipts', () => {
  it('returns the last N receipts oldest first, defaulting the limit', () => {
    const receipts = Array.from({ length: 25 }, (_, i) => receipt(i + 1));
    const projected = projectRecentReceipts(receipts);
    expect(projected).toHaveLength(20);
    expect(projected[0]?.seq).toBe(6);
    expect(projected[19]?.seq).toBe(25);
  });

  it('sorts unordered input by seq', () => {
    const projected = projectRecentReceipts([receipt(3), receipt(1), receipt(2)], 2);
    expect(projected.map((r) => r.seq)).toEqual([2, 3]);
  });

  it('returns everything when the limit exceeds the journal', () => {
    const projected = projectRecentReceipts([receipt(1), receipt(2)], 10);
    expect(projected.map((r) => r.seq)).toEqual([1, 2]);
  });

  it('caps the limit at the platform maximum', () => {
    const receipts = Array.from({ length: APPLET_RECENT_ACTIONS_MAX + 5 }, (_, i) =>
      receipt(i + 1),
    );
    const projected = projectRecentReceipts(receipts, 1000);
    expect(projected).toHaveLength(APPLET_RECENT_ACTIONS_MAX);
    expect(projected[0]?.seq).toBe(6);
  });

  it('returns nothing for a non-positive limit', () => {
    expect(projectRecentReceipts([receipt(1)], 0)).toEqual([]);
  });
});

describe('projectAppletAttention', () => {
  const state = {
    title: 'Karim vs Sara',
    phase: { label: 'midgame', moveCount: 24 },
    waitingOn: null,
  };

  it('returns undefined when no projection is declared', () => {
    expect(projectAppletAttention(state)).toBeUndefined();
  });

  it('reads declared pointers without interpretation', () => {
    expect(
      projectAppletAttention(state, {
        title: '/title',
        status: '/phase/label',
        waitingOn: '/waitingOn',
      }),
    ).toEqual({ title: 'Karim vs Sara', status: 'midgame' });
  });

  it('stringifies non-string values', () => {
    expect(
      projectAppletAttention(state, { status: '/phase/moveCount', waitingOn: '/phase' }),
    ).toEqual({ status: '24', waitingOn: '{"label":"midgame","moveCount":24}' });
  });

  it('omits unresolvable pointers and truncates long values', () => {
    const projected = projectAppletAttention(
      { title: 'x'.repeat(500) },
      { title: '/title', status: '/absent' },
    );
    expect(projected?.title).toBe('x'.repeat(200));
    expect(projected?.status).toBeUndefined();
  });
});
