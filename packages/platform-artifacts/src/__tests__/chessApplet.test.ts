/**
 * The curated chess applet: the definition is validated at module load (an
 * invalid fixture fails the import), the attention/effect contract carries the
 * design — a pawn push never wakes or floods the room, exactly one
 * human-audience action wakes the agent, endings are declared — and the store
 * listing wraps the fixture identity-coherently.
 */
import { describe, it, expect } from 'vitest';
import { AppletDefinitionSchema } from '@aflow/schemas';
import { CHESS_DEFINITION, CHESS_VIEW_SOURCE } from '../appletFixtures/chess.js';
import { getCatalogEntry, listCatalog } from '../storeCatalog/index.js';

function action(name: string) {
  const found = CHESS_DEFINITION.actions.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`chess declares no action '${name}'`);
  return found;
}

describe('chess applet definition', () => {
  it('parses at module load and re-parses clean', () => {
    expect(CHESS_DEFINITION.appletKey).toBe('chess');
    expect(AppletDefinitionSchema.parse(CHESS_DEFINITION)).toEqual(CHESS_DEFINITION);
  });

  it('is born as a standard game: full board, white to move, playing, seats open', () => {
    const board = CHESS_DEFINITION.initialState['board'] as Record<string, string>;
    expect(Object.keys(board)).toHaveLength(64);
    expect(board['a8']).toBe('r');
    expect(board['e1']).toBe('K');
    expect(board['e4']).toBe('');
    expect(CHESS_DEFINITION.initialState['turn']).toBe('white');
    expect(CHESS_DEFINITION.initialState['players']).toEqual({});
    expect(CHESS_DEFINITION.initialState['status']).toBe('playing');
    expect(CHESS_DEFINITION.roles?.map((role) => role.id)).toEqual(['white', 'black']);
  });

  it('ships the opening analysis: all twenty legal white moves, computed at zero history', () => {
    const analysis = CHESS_DEFINITION.initialState['analysis'] as {
      forMoves: number;
      inCheck: boolean;
      legalMoves: string[];
    };
    expect(analysis.forMoves).toBe(0);
    expect(analysis.inCheck).toBe(false);
    expect(analysis.legalMoves).toHaveLength(20);
    expect(analysis.legalMoves).toContain('e2e4');
    expect(analysis.legalMoves).toContain('g1f3');
    const legal = (
      CHESS_DEFINITION.initialState['analysis'] as {
        legal: Record<string, Record<string, boolean>>;
      }
    ).legal;
    expect(legal['e2']).toEqual({ e3: true, e4: true });
    expect(legal['g1']).toEqual({ f3: true, h3: true });
  });

  it('analysis speaks the notations the model knows: FEN, SAN, and threat warnings', () => {
    const analysis = CHESS_DEFINITION.initialState['analysis'] as {
      fen: string;
      san: string;
      threats: string[];
    };
    expect(analysis.fen).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    expect(analysis.san).toBe('');
    expect(analysis.threats).toEqual([]);
    expect(CHESS_DEFINITION.situationProjection).toEqual([
      '/analysis/san',
      '/analysis/fen',
      '/analysis/threats',
    ]);
  });

  it('move is a guarded template and never notable — forty moves must not flood the room', () => {
    const move = action('move');
    expect(move.patch).not.toBe('actor_supplied');
    const template = (move.patch as { template: Array<{ op: string }> }).template;
    expect(template.filter((op) => op.op === 'test')).toHaveLength(2);
    expect(move.guard?.onUnverifiable).toBe('allow');
    expect(move.guard?.bypass).toBe('/input/byAgreement');
    expect(move.notable).toBe(false);
    expect(move.wakes).toBe(false);
    expect(move.ends).toBe(false);
  });

  it('every board-writing move action is guarded by the legal map with the byAgreement bypass', () => {
    for (const name of ['move', 'castle', 'en_passant']) {
      const guarded = action(name);
      expect(guarded.guard?.equals).toBe(true);
      expect(guarded.guard?.freshness).toEqual({
        stamp: '/state/analysis/forMoves',
        matchesLengthOf: '/state/moveHistory',
      });
      expect(guarded.guard?.onUnverifiable).toBe('allow');
      expect(guarded.guard?.bypass).toBe('/input/byAgreement');
    }
  });

  it('renders for the agent: the grid declaration covers the whole board', () => {
    expect(CHESS_DEFINITION.agentGrid?.mapPath).toBe('/board');
    expect(CHESS_DEFINITION.agentGrid?.rowLabels).toHaveLength(8);
    expect(CHESS_DEFINITION.agentGrid?.colLabels).toHaveLength(8);
  });

  it('exactly one action wakes the agent: the human-audience nudge', () => {
    const waking = CHESS_DEFINITION.actions.filter((candidate) => candidate.wakes);
    expect(waking.map((candidate) => candidate.name)).toEqual(['nudge_agent']);
    const nudge = action('nudge_agent');
    expect(nudge.audience).toBe('human');
    expect(nudge.notable).toBe(true);
    expect(nudge.ends).toBe(false);
  });

  it('endings are declared: resign, accept_draw, and declare_result end, all notably', () => {
    for (const name of ['resign', 'accept_draw', 'declare_result']) {
      const ending = action(name);
      expect(ending.ends).toBe(true);
      expect(ending.notable).toBe(true);
    }
    const offer = action('offer_draw');
    expect(offer.ends).toBe(false);
    expect(offer.notable).toBe(true);
    const takeback = action('takeback_request');
    expect(takeback.ends).toBe(false);
    expect(takeback.notable).toBe(true);
  });

  it('the board is a square-name map — no index arithmetic anywhere in the contract', () => {
    const boardSchema = (
      CHESS_DEFINITION.stateSchema as { properties: Record<string, Record<string, unknown>> }
    ).properties['board'];
    expect(boardSchema?.['type']).toBe('object');
    expect(boardSchema?.['propertyNames']).toEqual({ pattern: '^[a-h][1-8]$' });
    const taught = `${CHESS_DEFINITION.semanticDescription} ${(action('move').pitfalls ?? []).join('\n')}`;
    expect(taught).not.toMatch(/index/i);
  });

  it('move pitfalls teach describe-not-patch, the analysis contract, and seat awareness', () => {
    const pitfalls = (action('move').pitfalls ?? []).join('\n');
    expect(pitfalls).toContain('Describe the move, the board applies it');
    expect(pitfalls).toContain("{ from: 'g1', to: 'f3', piece: 'N'");
    expect(pitfalls).toContain('analysis.forMoves equals moveHistory.length');
    expect(pitfalls).toContain('follow with declare_result');
    expect(pitfalls).toContain('never assume which side you play');
    expect(pitfalls).toContain('byAgreement: true is only for an agreed exception');
  });

  it('projects attention from status and the side to move', () => {
    expect(CHESS_DEFINITION.attentionProjection).toEqual({
      status: '/status',
      waitingOn: '/turn',
    });
  });
});

describe('curated chess store listing', () => {
  it('is a published applet entry wrapping the fixture', () => {
    const entry = getCatalogEntry('chess');
    expect(entry).not.toBeNull();
    if (entry === null || entry.kind !== 'applet') {
      throw new Error(`expected applet entry, got ${entry?.kind ?? 'null'}`);
    }
    expect(entry.status).toBe('published');
    expect(entry.honestyLabel).toBe('curated');
    expect(entry.payload.appletDefinition).toEqual(CHESS_DEFINITION);
    expect(entry.payload.viewSource).toBe(CHESS_VIEW_SOURCE);
    expect(entry.payload.artifactKind).toBe('applet');
    expect(entry.payload.libraries ?? []).toEqual([]);
  });

  it('surfaces through kind-filtered browse', () => {
    expect(listCatalog({ kind: 'applet' }).map((entry) => entry.catalogId)).toContain('chess');
  });
});
