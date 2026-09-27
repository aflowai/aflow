/**
 * Hand-authored chess applet fixture — standard chess as a shared applet
 * instance. The platform judges no chess rule: the view carries a legal-move
 * generator purely as a courtesy for humans, the agent is taught the same
 * rules through the action contracts, and the players may agree to deviate.
 * The definition is parsed at module load so an invalid fixture fails the
 * build, never a runtime resolve.
 */
import { AppletDefinitionSchema, type AppletDefinition } from '@aflow/schemas';

export const CHESS_DEFINITION: AppletDefinition = AppletDefinitionSchema.parse({
  appletKey: 'chess',
  version: 1,
  name: 'Chess',
  description:
    'A chess game two players share — humans or the agent on either side, spectators welcome.',
  semanticDescription:
    'A standard chess game under standard chess rules. The board reaches you as a text grid ' +
    "(gridView) — ranks 8..1 by files a..h, 'P'..'K' white, 'p'..'k' black, '.' empty; trust " +
    'the grid, it is always current. Squares are addressed by name ' +
    "('a1'..'h8', e.g. /state/board/d4 in a raw_patch). " +
    'You never write board squares for a move: describe it with the move / castle / en_passant ' +
    'actions and the board applies and checks it. A move outside the board’s own legal-move ' +
    'analysis is refused unless byAgreement is set (an agreed exception — teaching, simulating ' +
    'a famous game, a house variant — always narrated in outcome). state.players records who ' +
    'plays each side (set a seat via raw_patch when agreed — e.g. add /state/players/black); ' +
    'consult turn and players before moving, and moving on a human player’s behalf at their ' +
    'request is normal collaboration — name them in the outcome. state.analysis is the board’s ' +
    'own analysis for the side to move — legal moves, the position as FEN, the game so far ' +
    'in standard notation, and hanging-piece warnings — fresh while analysis.forMoves equals ' +
    'moveHistory.length. moveHistory records from-to pairs in play order. A mating or ' +
    'stalemating move is followed by declare_result — whoever ends the game writes the ending. ' +
    'Position adjustments outside a move (setup, handicaps, corrections) go through raw_patch ' +
    'and are narrated.',
  stateSchema: {
    type: 'object',
    properties: {
      board: {
        type: 'object',
        minProperties: 64,
        maxProperties: 64,
        propertyNames: { pattern: '^[a-h][1-8]$' },
        additionalProperties: {
          enum: ['', 'P', 'N', 'B', 'R', 'Q', 'K', 'p', 'n', 'b', 'r', 'q', 'k'],
        },
        description:
          "All 64 squares, square name ('a1'..'h8') → FEN piece letter, '' when empty — squares are never added or removed, only replaced",
      },
      turn: { enum: ['white', 'black'], description: 'Side to move' },
      analysis: {
        type: 'object',
        properties: {
          forMoves: {
            type: 'integer',
            minimum: 0,
            description: 'moveHistory length this was computed at — stale when it differs',
          },
          inCheck: { type: 'boolean', description: 'Whether the side to move is in check' },
          legalMoves: {
            type: 'array',
            maxItems: 256,
            items: { type: 'string', minLength: 4, maxLength: 5 },
            description: "Legal from-to moves for the side to move, e.g. 'g8f6'",
          },
          legal: {
            type: 'object',
            propertyNames: { pattern: '^[a-h][1-8]$' },
            additionalProperties: {
              type: 'object',
              propertyNames: { pattern: '^[a-h][1-8]$' },
              additionalProperties: { const: true },
            },
            description: 'The same moves as a lookup: legal[from][to] === true',
          },
          fen: {
            type: 'string',
            maxLength: 120,
            description: 'The position in FEN',
          },
          san: {
            type: 'string',
            maxLength: 4096,
            description: "The game so far in standard notation, e.g. '1. d4 d5 2. c4 e6'",
          },
          threats: {
            type: 'array',
            maxItems: 16,
            items: { type: 'string', maxLength: 100 },
            description: 'Attacked pieces on both sides — an UNDEFENDED one is hanging',
          },
        },
        required: ['forMoves', 'inCheck', 'legalMoves', 'legal', 'fen', 'san', 'threats'],
        additionalProperties: false,
        description:
          'The board UI’s own move generator, written whenever it is stale — move actions are checked against it while fresh',
      },
      players: {
        type: 'object',
        properties: {
          white: { type: 'string', maxLength: 120, description: 'Who plays white' },
          black: { type: 'string', maxLength: 120, description: 'Who plays black' },
        },
        additionalProperties: false,
        description: 'Seat labels — who plays each side; an unclaimed seat is absent',
      },
      status: { enum: ['playing', 'ended'] },
      result: {
        type: 'string',
        maxLength: 200,
        description: "How the game ended, e.g. 'checkmate — white wins'",
      },
      moveHistory: {
        type: 'array',
        maxItems: 1024,
        items: { type: 'string', minLength: 4, maxLength: 5 },
        description:
          "From-to square pairs in play order, e.g. 'e2e4'; a promotion appends the piece letter",
      },
      drawOffer: {
        enum: ['white', 'black', null],
        description: 'Side with a pending draw offer',
      },
      takebackRequest: {
        enum: ['white', 'black', null],
        description: 'Side asking to rewind the last move',
      },
      nudge: {
        type: 'string',
        maxLength: 500,
        description: 'Standing ask to the agent, set by nudge_agent',
      },
    },
    required: [
      'board',
      'turn',
      'players',
      'analysis',
      'status',
      'moveHistory',
      'drawOffer',
      'takebackRequest',
      'nudge',
    ],
    additionalProperties: false,
  },
  initialState: {
    board: {
      a8: 'r',
      b8: 'n',
      c8: 'b',
      d8: 'q',
      e8: 'k',
      f8: 'b',
      g8: 'n',
      h8: 'r',
      a7: 'p',
      b7: 'p',
      c7: 'p',
      d7: 'p',
      e7: 'p',
      f7: 'p',
      g7: 'p',
      h7: 'p',
      a6: '',
      b6: '',
      c6: '',
      d6: '',
      e6: '',
      f6: '',
      g6: '',
      h6: '',
      a5: '',
      b5: '',
      c5: '',
      d5: '',
      e5: '',
      f5: '',
      g5: '',
      h5: '',
      a4: '',
      b4: '',
      c4: '',
      d4: '',
      e4: '',
      f4: '',
      g4: '',
      h4: '',
      a3: '',
      b3: '',
      c3: '',
      d3: '',
      e3: '',
      f3: '',
      g3: '',
      h3: '',
      a2: 'P',
      b2: 'P',
      c2: 'P',
      d2: 'P',
      e2: 'P',
      f2: 'P',
      g2: 'P',
      h2: 'P',
      a1: 'R',
      b1: 'N',
      c1: 'B',
      d1: 'Q',
      e1: 'K',
      f1: 'B',
      g1: 'N',
      h1: 'R',
    },
    turn: 'white',
    players: {},
    analysis: {
      forMoves: 0,
      inCheck: false,
      legalMoves: [
        'a2a3',
        'a2a4',
        'b2b3',
        'b2b4',
        'c2c3',
        'c2c4',
        'd2d3',
        'd2d4',
        'e2e3',
        'e2e4',
        'f2f3',
        'f2f4',
        'g2g3',
        'g2g4',
        'h2h3',
        'h2h4',
        'b1a3',
        'b1c3',
        'g1f3',
        'g1h3',
      ],
      legal: {
        a2: { a3: true, a4: true },
        b2: { b3: true, b4: true },
        c2: { c3: true, c4: true },
        d2: { d3: true, d4: true },
        e2: { e3: true, e4: true },
        f2: { f3: true, f4: true },
        g2: { g3: true, g4: true },
        h2: { h3: true, h4: true },
        b1: { a3: true, c3: true },
        g1: { f3: true, h3: true },
      },
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      san: '',
      threats: [],
    },
    status: 'playing',
    moveHistory: [],
    drawOffer: null,
    takebackRequest: null,
    nudge: '',
  },
  // The raw board map and the guard's legal-move lookup stay out of the agent
  // view: the grid IS the board for the agent, and legalMoves carries the same
  // information as the nested lookup at a fraction of the size.
  agentProjection: [
    '/turn',
    '/players',
    '/status',
    '/result',
    '/moveHistory',
    '/drawOffer',
    '/takebackRequest',
    '/nudge',
    '/analysis/forMoves',
    '/analysis/inCheck',
    '/analysis/legalMoves',
    '/analysis/fen',
    '/analysis/san',
    '/analysis/threats',
  ],
  roles: [
    { id: 'white', description: 'Plays the white pieces' },
    { id: 'black', description: 'Plays the black pieces' },
  ],
  actions: [
    {
      name: 'move',
      description: 'Move a piece from one square to another',
      whenToUse: ['It is your side’s turn and you have chosen your move'],
      pitfalls: [
        'Check state.turn and state.players first — never assume which side you play. Moving for a human player at their request is fine; say so in outcome',
        'Pick from state.analysis.legalMoves while analysis.forMoves equals moveHistory.length — the board’s own move generator; when stale, read the grid and verify square by square. Check analysis.threats first: save your UNDEFENDED attacked pieces, and a hanging enemy piece may simply be taken. analysis.fen and analysis.san give you the position and the game in standard notation — reason from those',
        "Describe the move, the board applies it: piece is the letter on from, captures is what sits on to ('' when empty), places is what ends on to (differs from piece only on promotion), notation is from+to plus any promotion letter, nextTurn is the side to move after. Worked g1→f3: { from: 'g1', to: 'f3', piece: 'N', captures: '', places: 'N', notation: 'g1f3', nextTurn: 'black' }",
        'Castling and en passant are their own actions — they change more squares than from and to. A mating or stalemating move: follow with declare_result',
        'byAgreement: true is only for an agreed exception — teaching, simulating a famous game, a house variant — and must be narrated in outcome',
      ],
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', pattern: '^[a-h][1-8]$' },
          to: { type: 'string', pattern: '^[a-h][1-8]$' },
          piece: {
            enum: ['P', 'N', 'B', 'R', 'Q', 'K', 'p', 'n', 'b', 'r', 'q', 'k'],
            description: 'The letter currently on from',
          },
          captures: {
            enum: ['', 'P', 'N', 'B', 'R', 'Q', 'K', 'p', 'n', 'b', 'r', 'q', 'k'],
            description: "What currently sits on to — '' when empty",
          },
          places: {
            enum: ['P', 'N', 'B', 'R', 'Q', 'K', 'p', 'n', 'b', 'r', 'q', 'k'],
            description: 'The letter that ends on to — differs from piece only on promotion',
          },
          notation: {
            type: 'string',
            pattern: '^[a-h][1-8][a-h][1-8][qrbn]?$',
            description: "from+to, plus the promotion letter when promoting, e.g. 'e7e8q'",
          },
          nextTurn: { enum: ['white', 'black'], description: 'The side to move after this move' },
          byAgreement: {
            type: 'boolean',
            description: 'The players agreed to an exception to the rules — narrate it in outcome',
          },
        },
        required: ['from', 'to', 'piece', 'captures', 'places', 'notation', 'nextTurn'],
        additionalProperties: false,
      },
      patch: {
        template: [
          {
            op: 'test',
            pathTemplate: ['/state/board', { from: '/input/from' }],
            valueFrom: '/input/piece',
          },
          {
            op: 'test',
            pathTemplate: ['/state/board', { from: '/input/to' }],
            valueFrom: '/input/captures',
          },
          { op: 'replace', pathTemplate: ['/state/board', { from: '/input/from' }], value: '' },
          {
            op: 'replace',
            pathTemplate: ['/state/board', { from: '/input/to' }],
            valueFrom: '/input/places',
          },
          { op: 'replace', path: '/state/turn', valueFrom: '/input/nextTurn' },
          { op: 'add', path: '/state/moveHistory/-', valueFrom: '/input/notation' },
          { op: 'replace', path: '/state/drawOffer', value: null },
        ],
      },
      guard: {
        assert: ['/state/analysis/legal', { from: '/input/from' }, { from: '/input/to' }],
        equals: true,
        freshness: { stamp: '/state/analysis/forMoves', matchesLengthOf: '/state/moveHistory' },
        onUnverifiable: 'allow',
        bypass: '/input/byAgreement',
        message:
          'Not a legal move for the current position — state.analysis.legalMoves lists what is. For an agreed exception (teaching, a simulated game, a house variant) set byAgreement: true and narrate it in outcome.',
      },
    },
    {
      name: 'castle',
      description: 'Castle — the king and rook move together',
      whenToUse: ['Castling kingside or queenside on your turn'],
      pitfalls: [
        "The four standard castlings: white kingside { kingFrom: 'e1', kingTo: 'g1', rookFrom: 'h1', rookTo: 'f1' }, white queenside { kingFrom: 'e1', kingTo: 'c1', rookFrom: 'a1', rookTo: 'd1' }, black kingside { kingFrom: 'e8', kingTo: 'g8', rookFrom: 'h8', rookTo: 'f8' }, black queenside { kingFrom: 'e8', kingTo: 'c8', rookFrom: 'a8', rookTo: 'd8' }",
        "king and rook are the piece letters ('K'/'R' white, 'k'/'r' black); notation records the king movement, e.g. 'e1g1'; both target squares must be empty",
      ],
      inputSchema: {
        type: 'object',
        properties: {
          kingFrom: { type: 'string', pattern: '^[a-h][1-8]$' },
          kingTo: { type: 'string', pattern: '^[a-h][1-8]$' },
          rookFrom: { type: 'string', pattern: '^[a-h][1-8]$' },
          rookTo: { type: 'string', pattern: '^[a-h][1-8]$' },
          king: { enum: ['K', 'k'] },
          rook: { enum: ['R', 'r'] },
          notation: { type: 'string', pattern: '^[a-h][1-8][a-h][1-8]$' },
          nextTurn: { enum: ['white', 'black'] },
          byAgreement: { type: 'boolean' },
        },
        required: [
          'kingFrom',
          'kingTo',
          'rookFrom',
          'rookTo',
          'king',
          'rook',
          'notation',
          'nextTurn',
        ],
        additionalProperties: false,
      },
      patch: {
        template: [
          {
            op: 'test',
            pathTemplate: ['/state/board', { from: '/input/kingFrom' }],
            valueFrom: '/input/king',
          },
          {
            op: 'test',
            pathTemplate: ['/state/board', { from: '/input/rookFrom' }],
            valueFrom: '/input/rook',
          },
          { op: 'test', pathTemplate: ['/state/board', { from: '/input/kingTo' }], value: '' },
          { op: 'test', pathTemplate: ['/state/board', { from: '/input/rookTo' }], value: '' },
          { op: 'replace', pathTemplate: ['/state/board', { from: '/input/kingFrom' }], value: '' },
          { op: 'replace', pathTemplate: ['/state/board', { from: '/input/rookFrom' }], value: '' },
          {
            op: 'replace',
            pathTemplate: ['/state/board', { from: '/input/kingTo' }],
            valueFrom: '/input/king',
          },
          {
            op: 'replace',
            pathTemplate: ['/state/board', { from: '/input/rookTo' }],
            valueFrom: '/input/rook',
          },
          { op: 'replace', path: '/state/turn', valueFrom: '/input/nextTurn' },
          { op: 'add', path: '/state/moveHistory/-', valueFrom: '/input/notation' },
          { op: 'replace', path: '/state/drawOffer', value: null },
        ],
      },
      guard: {
        assert: ['/state/analysis/legal', { from: '/input/kingFrom' }, { from: '/input/kingTo' }],
        equals: true,
        freshness: { stamp: '/state/analysis/forMoves', matchesLengthOf: '/state/moveHistory' },
        onUnverifiable: 'allow',
        bypass: '/input/byAgreement',
        message:
          'Castling is not legal in the current position — state.analysis.legalMoves lists what is. For an agreed exception set byAgreement: true and narrate it in outcome.',
      },
    },
    {
      name: 'en_passant',
      description: 'Capture en passant — the captured pawn is not on the destination square',
      whenToUse: ["Immediately after the opponent's two-square pawn advance past your pawn"],
      pitfalls: [
        'capturedSquare is where their pawn stands (beside yours); to is the square diagonally behind it; notation records from+to',
      ],
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', pattern: '^[a-h][1-8]$' },
          to: { type: 'string', pattern: '^[a-h][1-8]$' },
          capturedSquare: { type: 'string', pattern: '^[a-h][1-8]$' },
          pawn: { enum: ['P', 'p'], description: 'Your pawn' },
          capturedPawn: { enum: ['P', 'p'], description: 'The pawn being captured' },
          notation: { type: 'string', pattern: '^[a-h][1-8][a-h][1-8]$' },
          nextTurn: { enum: ['white', 'black'] },
          byAgreement: { type: 'boolean' },
        },
        required: ['from', 'to', 'capturedSquare', 'pawn', 'capturedPawn', 'notation', 'nextTurn'],
        additionalProperties: false,
      },
      patch: {
        template: [
          {
            op: 'test',
            pathTemplate: ['/state/board', { from: '/input/from' }],
            valueFrom: '/input/pawn',
          },
          { op: 'test', pathTemplate: ['/state/board', { from: '/input/to' }], value: '' },
          {
            op: 'test',
            pathTemplate: ['/state/board', { from: '/input/capturedSquare' }],
            valueFrom: '/input/capturedPawn',
          },
          { op: 'replace', pathTemplate: ['/state/board', { from: '/input/from' }], value: '' },
          {
            op: 'replace',
            pathTemplate: ['/state/board', { from: '/input/to' }],
            valueFrom: '/input/pawn',
          },
          {
            op: 'replace',
            pathTemplate: ['/state/board', { from: '/input/capturedSquare' }],
            value: '',
          },
          { op: 'replace', path: '/state/turn', valueFrom: '/input/nextTurn' },
          { op: 'add', path: '/state/moveHistory/-', valueFrom: '/input/notation' },
          { op: 'replace', path: '/state/drawOffer', value: null },
        ],
      },
      guard: {
        assert: ['/state/analysis/legal', { from: '/input/from' }, { from: '/input/to' }],
        equals: true,
        freshness: { stamp: '/state/analysis/forMoves', matchesLengthOf: '/state/moveHistory' },
        onUnverifiable: 'allow',
        bypass: '/input/byAgreement',
        message:
          'En passant is not legal in the current position — it is only available immediately after the two-square advance. For an agreed exception set byAgreement: true and narrate it in outcome.',
      },
    },
    {
      name: 'declare_result',
      description: 'Declare the game over — checkmate, stalemate, or another agreed ending',
      whenToUse: [
        'Your move mated or stalemated — declare it right after the move',
        'The players agree the game is over for any other reason',
      ],
      pitfalls: ["result names the ending, e.g. 'checkmate — white wins' or 'draw by stalemate'"],
      inputSchema: {
        type: 'object',
        properties: {
          result: { type: 'string', minLength: 1, maxLength: 200 },
        },
        required: ['result'],
        additionalProperties: false,
      },
      patch: {
        template: [
          { op: 'replace', path: '/state/status', value: 'ended' },
          { op: 'add', path: '/state/result', valueFrom: '/input/result' },
        ],
      },
      notable: true,
      ends: true,
    },
    {
      name: 'refresh_analysis',
      description: 'Write a freshly computed analysis of the current position',
      whenToUse: ['The board view refreshes analysis automatically whenever it is stale'],
      pitfalls: [
        'Computed and written by the board view — the analysis must describe the position exactly as it stands',
      ],
      inputSchema: { type: 'object', additionalProperties: false },
      patch: 'actor_supplied',
      audience: 'human',
    },
    {
      name: 'resign',
      description: 'Resign the game for one side — ends it for everyone',
      whenToUse: ['Your position is lost and you choose to concede'],
      pitfalls: [
        "side is the resigning side; result is the closing line the resigner writes, e.g. 'white resigned — black wins'",
      ],
      inputSchema: {
        type: 'object',
        properties: {
          side: { enum: ['white', 'black'], description: 'The resigning side' },
          result: {
            type: 'string',
            minLength: 1,
            maxLength: 200,
            description: 'Closing line naming who resigned and who wins',
          },
        },
        required: ['side', 'result'],
        additionalProperties: false,
      },
      patch: {
        template: [
          { op: 'replace', path: '/state/status', value: 'ended' },
          { op: 'add', path: '/state/result', valueFrom: '/input/result' },
        ],
      },
      notable: true,
      ends: true,
    },
    {
      name: 'offer_draw',
      description: 'Offer a draw to the other side',
      whenToUse: ['You would settle for a draw and want the other side to decide'],
      pitfalls: [
        'The offer stands until accepted, withdrawn via raw_patch, or cleared by the next move',
      ],
      inputSchema: {
        type: 'object',
        properties: { side: { enum: ['white', 'black'], description: 'The offering side' } },
        required: ['side'],
        additionalProperties: false,
      },
      patch: { template: [{ op: 'replace', path: '/state/drawOffer', valueFrom: '/input/side' }] },
      notable: true,
    },
    {
      name: 'accept_draw',
      description: 'Accept the pending draw offer — ends the game as a draw',
      whenToUse: ['The other side offered a draw and you agree'],
      inputSchema: { type: 'object', additionalProperties: false },
      patch: {
        template: [
          { op: 'replace', path: '/state/status', value: 'ended' },
          { op: 'add', path: '/state/result', value: 'draw by agreement' },
          { op: 'replace', path: '/state/drawOffer', value: null },
        ],
      },
      notable: true,
      ends: true,
    },
    {
      name: 'takeback_request',
      description: 'Ask to rewind the last move',
      whenToUse: ['A slip you want undone — the other side decides'],
      pitfalls: [
        'The request changes no board state; the players (or the agent) arbitrate, and a granted rewind is applied via raw_patch, clearing this field with it',
      ],
      inputSchema: {
        type: 'object',
        properties: { side: { enum: ['white', 'black'], description: 'The side asking' } },
        required: ['side'],
        additionalProperties: false,
      },
      patch: {
        template: [{ op: 'replace', path: '/state/takebackRequest', valueFrom: '/input/side' }],
      },
      notable: true,
    },
    {
      name: 'nudge_agent',
      description: 'Ask the agent to look at the board',
      whenToUse: ['The agent plays a side or advises, and you want its attention now'],
      inputSchema: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            minLength: 1,
            maxLength: 500,
            description: 'What you want the agent to consider',
          },
        },
        required: ['message'],
        additionalProperties: false,
      },
      patch: { template: [{ op: 'replace', path: '/state/nudge', valueFrom: '/input/message' }] },
      audience: 'human',
      notable: true,
      wakes: true,
    },
  ],
  attentionProjection: { status: '/status', waitingOn: '/turn' },
  agentGrid: {
    mapPath: '/board',
    rowLabels: ['8', '7', '6', '5', '4', '3', '2', '1'],
    colLabels: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
    legend: 'uppercase = White, lowercase = Black, . = empty',
  },
  situationProjection: ['/analysis/san', '/analysis/fen', '/analysis/threats'],
});

// The compiler exposes no stable build-time hash for the DS contract yet, so
// the pin rides catalogVersion; 'fallback' marks the hash slot as
// intentionally unpinned. The chess view itself uses no libraries at all.
export const CHESS_CATALOG_PIN = {
  catalogId: 'phoenix-design-system',
  catalogVersion: '2.0.0-artifact',
  catalogHash: 'fallback',
} as const;

export { CHESS_VIEW_SOURCE } from './chessView.js';
