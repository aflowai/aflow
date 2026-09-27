import { describe, expect, it } from 'vitest';
import {
  applyAppletStatePatch,
  checkAppletConformance,
  evaluateAppletActionGuard,
  extractAppletActCallSites,
  materializeAppletTemplatePatch,
  renderAppletAgentGrid,
  validateAgainstAppletSchema,
} from '@aflow/applet-runtime';
import { CHESS_DEFINITION, CHESS_VIEW_SOURCE } from '@aflow/platform-artifacts';
import type { AppletTemplatePatch } from '@aflow/schemas';

function action(name: string) {
  const found = CHESS_DEFINITION.actions.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`chess declares no action '${name}'`);
  return found;
}

function template(name: string) {
  const patch = action(name).patch;
  if (patch === 'actor_supplied') throw new Error(`'${name}' is not a template action`);
  return (patch as AppletTemplatePatch).template;
}

const LEGAL_E2E4 = {
  from: 'e2',
  to: 'e4',
  piece: 'P',
  captures: '',
  places: 'P',
  notation: 'e2e4',
  nextTurn: 'black',
};

describe('chess fixture conformance', () => {
  it('passes the conformance gate — every square-shaped move input replays, none is skipped', () => {
    const result = checkAppletConformance({
      definition: CHESS_DEFINITION,
      source: CHESS_VIEW_SOURCE,
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('sees every declared action as a literal call site through the view wrapper', () => {
    const literalNames = new Set(
      extractAppletActCallSites(CHESS_VIEW_SOURCE)
        .map((site) => site.name)
        .filter((name): name is string => name !== null),
    );
    for (const act of CHESS_DEFINITION.actions) {
      expect(literalNames.has(act.name)).toBe(true);
    }
    // The view also drives the built-in escape hatch (draw/takeback arbitration).
    expect(literalNames.has('raw_patch')).toBe(true);
  });

  it('a described legal move materializes, applies, and validates — the agent authors no patch', () => {
    const state = CHESS_DEFINITION.initialState;
    const guarded = evaluateAppletActionGuard({
      guard: action('move').guard!,
      state,
      input: LEGAL_E2E4,
    });
    expect(guarded).toEqual({ ok: true });
    const patch = materializeAppletTemplatePatch(template('move'), LEGAL_E2E4);
    const next = applyAppletStatePatch(state, patch);
    const board = next['board'] as Record<string, string>;
    expect(board['e2']).toBe('');
    expect(board['e4']).toBe('P');
    expect(next['turn']).toBe('black');
    expect(next['moveHistory']).toEqual(['e2e4']);
    const check = validateAgainstAppletSchema({
      schema: CHESS_DEFINITION.stateSchema,
      cacheKey: 'chess-round-trip-test',
      data: next,
    });
    expect(check.errors).toEqual([]);
    expect(check.valid).toBe(true);
  });

  it('an illegal move is refused by the guard while the analysis is fresh — byAgreement bypasses it', () => {
    const state = CHESS_DEFINITION.initialState;
    const illegal = { ...LEGAL_E2E4, to: 'e5', notation: 'e2e5' };
    const refused = evaluateAppletActionGuard({
      guard: action('move').guard!,
      state,
      input: illegal,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toContain('byAgreement');
    expect(
      evaluateAppletActionGuard({
        guard: action('move').guard!,
        state,
        input: { ...illegal, byAgreement: true },
      }),
    ).toEqual({ ok: true });
  });

  it('a stale analysis never blocks play — the guard enforces only what it can prove', () => {
    const stale = { ...CHESS_DEFINITION.initialState, moveHistory: ['d2d4'] };
    expect(
      evaluateAppletActionGuard({
        guard: action('move').guard!,
        state: stale,
        input: LEGAL_E2E4,
      }),
    ).toEqual({ ok: true });
  });

  it('a misread board fails the template preconditions — the own-goal class rejects, never corrupts', () => {
    // The mover claims a pawn on e3 (there is none) — the origin test refuses.
    expect(() =>
      applyAppletStatePatch(
        CHESS_DEFINITION.initialState,
        materializeAppletTemplatePatch(template('move'), {
          ...LEGAL_E2E4,
          from: 'e3',
          byAgreement: true,
        }),
      ),
    ).toThrow();
    // The destination holds the mover's own pawn — the '' test refuses the overwrite.
    expect(() =>
      applyAppletStatePatch(
        CHESS_DEFINITION.initialState,
        materializeAppletTemplatePatch(template('move'), {
          from: 'e1',
          to: 'e2',
          piece: 'K',
          captures: '',
          places: 'K',
          notation: 'e1e2',
          nextTurn: 'black',
          byAgreement: true,
        }),
      ),
    ).toThrow();
  });

  it('renders the starting board as the agent grid', () => {
    const grid = renderAppletAgentGrid(CHESS_DEFINITION.agentGrid!, CHESS_DEFINITION.initialState);
    expect(grid).toContain('8 r n b q k b n r');
    expect(grid).toContain('2 P P P P P P P P');
    expect(grid).toContain('5 . . . . . . . .');
    expect(grid).toContain('uppercase = White');
  });
});
