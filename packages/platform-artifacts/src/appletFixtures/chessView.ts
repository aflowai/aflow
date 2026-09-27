/**
 * The chess view — plain DOM, zero libraries, hermetically trivial. The shell
 * pushes `{ state, version, viewer }` via the 'aflowstate' CustomEvent and
 * every mutation goes through `window.aflow.act`. The in-view move generator
 * (legality, check, castling, en passant, auto-queen promotion, mate and
 * stalemate detection) is a courtesy layer only: it highlights legal targets
 * and greys out-of-turn play, but the deliberate force-move toggle sends any
 * move through the same 'move' action with the agreement narrated in outcome.
 * The board itself is pure presentation: square tints derived from the DS
 * theme variables (light and dark), coordinate labels, last-move and check
 * tints, click-to-select plus pointer drag, a SAN-ish move list, and
 * captured-piece trays derived from the board against the initial setup.
 */
export const CHESS_VIEW_SOURCE = `
function act(name, input, extras) {
  const bridge = typeof window !== 'undefined' ? window.aflow : undefined;
  if (!bridge || typeof bridge.act !== 'function') {
    return Promise.reject(new Error('aflow host bridge unavailable'));
  }
  return bridge.act(name, input, extras);
}

const FILES = 'abcdefgh';
// Filled glyphs for both sides — CSS paints the color; hollow glyphs render
// thin and unevenly across system fonts.
const GLYPHS = {
  P: '\\u265F', N: '\\u265E', B: '\\u265D', R: '\\u265C', Q: '\\u265B', K: '\\u265A',
  p: '\\u265F', n: '\\u265E', b: '\\u265D', r: '\\u265C', q: '\\u265B', k: '\\u265A',
};
const START = [
  'r', 'n', 'b', 'q', 'k', 'b', 'n', 'r',
  'p', 'p', 'p', 'p', 'p', 'p', 'p', 'p',
  '', '', '', '', '', '', '', '',
  '', '', '', '', '', '', '', '',
  '', '', '', '', '', '', '', '',
  '', '', '', '', '', '', '', '',
  'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P',
  'R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R',
];
const KNIGHT_D = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
const KING_D = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const BISHOP_D = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const ROOK_D = [[-1, 0], [1, 0], [0, -1], [0, 1]];

let current = null;
// The state contract keeps the board as a square-name → piece map (so patches
// never involve index arithmetic); the internal move machinery stays on the
// flat 64-array. boardArr is the array projection of the latest pushed state.
let boardArr = START.slice();
let selected = null;
let targets = [];
let forceMode = false;
let notice = '';

function boardFromState(state) {
  const map = state && state.board && typeof state.board === 'object' ? state.board : null;
  if (!map) return START.slice();
  const arr = [];
  for (let i = 0; i < 64; i++) arr.push('');
  for (const name in map) {
    if (/^[a-h][1-8]$/.test(name)) arr[sqIdx(name)] = map[name];
  }
  return arr;
}

function boardOps(before, after) {
  const ops = [];
  for (let i = 0; i < 64; i++) {
    if (after[i] === before[i]) continue;
    ops.push({ op: 'replace', path: '/state/board/' + sqName(i), value: after[i] });
  }
  return ops;
}

function fenOf(board, history, sideToMove) {
  const rows = [];
  for (let r = 0; r < 8; r++) {
    let row = '';
    let empty = 0;
    for (let c = 0; c < 8; c++) {
      const piece = board[r * 8 + c];
      if (piece === '') { empty += 1; continue; }
      if (empty) { row += String(empty); empty = 0; }
      row += piece;
    }
    if (empty) row += String(empty);
    rows.push(row);
  }
  let castling = '';
  if (!movedFrom(history, 'e1')) {
    if (!movedFrom(history, 'h1') && board[sqIdx('h1')] === 'R') castling += 'K';
    if (!movedFrom(history, 'a1') && board[sqIdx('a1')] === 'R') castling += 'Q';
  }
  if (!movedFrom(history, 'e8')) {
    if (!movedFrom(history, 'h8') && board[sqIdx('h8')] === 'r') castling += 'k';
    if (!movedFrom(history, 'a8') && board[sqIdx('a8')] === 'r') castling += 'q';
  }
  const epIdx = epTargetIndex(board, history);
  return rows.join('/') + ' ' + (sideToMove === 'white' ? 'w' : 'b') + ' ' +
    (castling || '-') + ' ' + (epIdx >= 0 ? sqName(epIdx) : '-') +
    ' 0 ' + String(Math.floor(history.length / 2) + 1);
}

function sanLine(history) {
  const san = sanHistory(history, '');
  const parts = [];
  for (let i = 0; i < san.length; i += 2) {
    parts.push(String(i / 2 + 1) + '. ' + san[i] + (san[i + 1] ? ' ' + san[i + 1] : ''));
  }
  return parts.join(' ');
}

function hangingPieces(board) {
  const out = [];
  for (let i = 0; i < 64; i++) {
    const piece = board[i];
    if (!piece) continue;
    const upper = piece.toUpperCase();
    if (upper === 'P' || upper === 'K') continue;
    const color = colorOf(piece);
    if (!isAttacked(board, i, opponent(color))) continue;
    const defended = isAttacked(board, i, color);
    out.push(color + ' ' + upper + ' on ' + sqName(i) + ' is attacked' +
      (defended ? ' (defended)' : ' (UNDEFENDED)'));
  }
  return out.slice(0, 16);
}

function analysisValue(board, history, sideToMove) {
  const legalMoves = [];
  const legal = {};
  for (let i = 0; i < 64; i++) {
    if (colorOf(board[i]) !== sideToMove) continue;
    const ts = legalTargets(board, history, i);
    if (!ts.length) continue;
    const fromName = sqName(i);
    const entry = {};
    for (let k = 0; k < ts.length; k++) {
      const toName = sqName(ts[k]);
      legalMoves.push(fromName + toName);
      entry[toName] = true;
    }
    legal[fromName] = entry;
  }
  return {
    forMoves: history.length,
    inCheck: inCheck(board, sideToMove),
    legalMoves: legalMoves,
    legal: legal,
    fen: fenOf(board, history, sideToMove),
    san: sanLine(history),
    threats: hangingPieces(board),
  };
}

function colorOf(piece) {
  if (!piece) return null;
  return piece === piece.toUpperCase() ? 'white' : 'black';
}
function opponent(side) { return side === 'white' ? 'black' : 'white'; }
function inBoard(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }
function at(board, r, c) { return board[r * 8 + c]; }
function sqName(i) { return FILES[i % 8] + String(8 - Math.floor(i / 8)); }
function sqIdx(name) { return (8 - Number(name[1])) * 8 + FILES.indexOf(name[0]); }

function movedFrom(history, square) {
  for (let i = 0; i < history.length; i++) {
    if (history[i].slice(0, 2) === square) return true;
  }
  return false;
}

function epTargetIndex(board, history) {
  if (!history.length) return -1;
  const last = history[history.length - 1];
  const from = sqIdx(last.slice(0, 2));
  const to = sqIdx(last.slice(2, 4));
  const piece = board[to];
  if (piece !== 'P' && piece !== 'p') return -1;
  const fr = Math.floor(from / 8);
  const tr = Math.floor(to / 8);
  if (Math.abs(fr - tr) !== 2) return -1;
  return ((fr + tr) / 2) * 8 + (to % 8);
}

function isAttacked(board, target, byColor) {
  const tr = Math.floor(target / 8);
  const tc = target % 8;
  const pawnRow = byColor === 'white' ? tr + 1 : tr - 1;
  const pawn = byColor === 'white' ? 'P' : 'p';
  for (const dc of [-1, 1]) {
    if (inBoard(pawnRow, tc + dc) && at(board, pawnRow, tc + dc) === pawn) return true;
  }
  const knight = byColor === 'white' ? 'N' : 'n';
  for (const d of KNIGHT_D) {
    if (inBoard(tr + d[0], tc + d[1]) && at(board, tr + d[0], tc + d[1]) === knight) return true;
  }
  const king = byColor === 'white' ? 'K' : 'k';
  for (const d of KING_D) {
    if (inBoard(tr + d[0], tc + d[1]) && at(board, tr + d[0], tc + d[1]) === king) return true;
  }
  const diag = byColor === 'white' ? ['B', 'Q'] : ['b', 'q'];
  for (const d of BISHOP_D) {
    let r = tr + d[0]; let c = tc + d[1];
    while (inBoard(r, c)) {
      const t = at(board, r, c);
      if (t !== '') { if (diag.indexOf(t) >= 0) return true; break; }
      r += d[0]; c += d[1];
    }
  }
  const ortho = byColor === 'white' ? ['R', 'Q'] : ['r', 'q'];
  for (const d of ROOK_D) {
    let r = tr + d[0]; let c = tc + d[1];
    while (inBoard(r, c)) {
      const t = at(board, r, c);
      if (t !== '') { if (ortho.indexOf(t) >= 0) return true; break; }
      r += d[0]; c += d[1];
    }
  }
  return false;
}

function inCheck(board, color) {
  const kingIdx = board.indexOf(color === 'white' ? 'K' : 'k');
  return kingIdx >= 0 && isAttacked(board, kingIdx, opponent(color));
}

function pseudoTargets(board, from, epIdx, history) {
  const piece = board[from];
  const color = colorOf(piece);
  if (!color) return [];
  const r = Math.floor(from / 8);
  const c = from % 8;
  const out = [];
  const push = function (rr, cc) {
    if (inBoard(rr, cc) && colorOf(at(board, rr, cc)) !== color) out.push(rr * 8 + cc);
  };
  const upper = piece.toUpperCase();
  if (upper === 'P') {
    const dir = color === 'white' ? -1 : 1;
    const startRow = color === 'white' ? 6 : 1;
    if (inBoard(r + dir, c) && at(board, r + dir, c) === '') {
      out.push((r + dir) * 8 + c);
      if (r === startRow && at(board, r + 2 * dir, c) === '') out.push((r + 2 * dir) * 8 + c);
    }
    for (const dc of [-1, 1]) {
      const rr = r + dir; const cc = c + dc;
      if (!inBoard(rr, cc)) continue;
      const t = at(board, rr, cc);
      if (t !== '' && colorOf(t) !== color) out.push(rr * 8 + cc);
      else if (t === '' && rr * 8 + cc === epIdx) out.push(rr * 8 + cc);
    }
  } else if (upper === 'N') {
    for (const d of KNIGHT_D) push(r + d[0], c + d[1]);
  } else if (upper === 'K') {
    for (const d of KING_D) push(r + d[0], c + d[1]);
    const home = color === 'white' ? 7 : 0;
    const kingSq = color === 'white' ? 'e1' : 'e8';
    if (r === home && c === 4 && !movedFrom(history, kingSq) && !inCheck(board, color)) {
      const enemy = opponent(color);
      const rook = color === 'white' ? 'R' : 'r';
      const kingsideRookSq = color === 'white' ? 'h1' : 'h8';
      if (!movedFrom(history, kingsideRookSq) && at(board, home, 7) === rook &&
          at(board, home, 5) === '' && at(board, home, 6) === '' &&
          !isAttacked(board, home * 8 + 5, enemy) && !isAttacked(board, home * 8 + 6, enemy)) {
        out.push(home * 8 + 6);
      }
      const queensideRookSq = color === 'white' ? 'a1' : 'a8';
      if (!movedFrom(history, queensideRookSq) && at(board, home, 0) === rook &&
          at(board, home, 1) === '' && at(board, home, 2) === '' && at(board, home, 3) === '' &&
          !isAttacked(board, home * 8 + 3, enemy) && !isAttacked(board, home * 8 + 2, enemy)) {
        out.push(home * 8 + 2);
      }
    }
  } else {
    const dirs = upper === 'B' ? BISHOP_D : upper === 'R' ? ROOK_D : BISHOP_D.concat(ROOK_D);
    for (const d of dirs) {
      let rr = r + d[0]; let cc = c + d[1];
      while (inBoard(rr, cc)) {
        const t = at(board, rr, cc);
        if (t === '') out.push(rr * 8 + cc);
        else { if (colorOf(t) !== color) out.push(rr * 8 + cc); break; }
        rr += d[0]; cc += d[1];
      }
    }
  }
  return out;
}

function applyMoveMechanics(board, from, to, epIdx) {
  const next = board.slice();
  const piece = board[from];
  const upper = piece.toUpperCase();
  const color = colorOf(piece);
  let captured = board[to];
  next[from] = '';
  const fr = Math.floor(from / 8); const fc = from % 8;
  const tr = Math.floor(to / 8); const tc = to % 8;
  if (upper === 'P' && to === epIdx && board[to] === '') {
    captured = board[fr * 8 + tc];
    next[fr * 8 + tc] = '';
  }
  if (upper === 'K' && fr === tr && fc === 4 && Math.abs(tc - fc) === 2) {
    if (tc === 6) { next[fr * 8 + 5] = next[fr * 8 + 7]; next[fr * 8 + 7] = ''; }
    else if (tc === 2) { next[fr * 8 + 3] = next[fr * 8 + 0]; next[fr * 8 + 0] = ''; }
  }
  let placed = piece;
  if (upper === 'P' && (tr === 0 || tr === 7)) placed = color === 'white' ? 'Q' : 'q';
  next[to] = placed;
  return { board: next, captured: captured, promoted: placed !== piece };
}

function legalTargets(board, history, from) {
  const color = colorOf(board[from]);
  if (!color) return [];
  const epIdx = epTargetIndex(board, history);
  return pseudoTargets(board, from, epIdx, history).filter(function (to) {
    return !inCheck(applyMoveMechanics(board, from, to, epIdx).board, color);
  });
}

function sideHasLegalMove(board, history, color) {
  for (let i = 0; i < 64; i++) {
    if (colorOf(board[i]) === color && legalTargets(board, history, i).length > 0) return true;
  }
  return false;
}

function replayFromStart(history) {
  let board = START.slice();
  const played = [];
  for (const move of history) {
    const from = sqIdx(move.slice(0, 2));
    const to = sqIdx(move.slice(2, 4));
    board = applyMoveMechanics(board, from, to, epTargetIndex(board, played)).board;
    // A recorded under-promotion letter overrides the auto-queen default —
    // replay must reproduce what was actually played, not what is usual.
    const promo = move.length > 4 ? move[4] : '';
    if (promo) {
      const placed = board[to];
      const isWhite = placed === placed.toUpperCase();
      board[to] = isWhite ? promo.toUpperCase() : promo.toLowerCase();
    }
    played.push(move);
  }
  return board;
}

function mySide(viewer) {
  const roles = viewer && Array.isArray(viewer.appletRoles) ? viewer.appletRoles : [];
  const white = roles.indexOf('white') >= 0;
  const black = roles.indexOf('black') >= 0;
  if (white && !black) return 'white';
  if (black && !white) return 'black';
  return null;
}

function actingSide() {
  const side = mySide(current.viewer);
  return side !== null ? side : current.state.turn;
}

function submit(promise) {
  promise.then(function (res) {
    if (!res) return;
    if (res.status === 'rejected') {
      // A guard rejection says why on \`message\`; only an input-schema violation
      // fills \`validation\`.
      notice = res.message
        ? res.message
        : res.validation && res.validation.length
          ? res.validation.join('; ')
          : 'The action was refused.';
      render();
    } else if (res.status === 'conflict') {
      notice = 'The game changed while you acted \\u2014 try again from the fresh board.';
      render();
    }
  }).catch(function () {
    notice = 'The action could not be sent.';
    render();
  });
}

function performMove(from, to, forced) {
  const state = current.state;
  const board = boardArr;
  const piece = board[from];
  const mover = colorOf(piece);
  if (!mover) return;
  const history = Array.isArray(state.moveHistory) ? state.moveHistory : [];
  const epIdx = epTargetIndex(board, history);
  const applied = applyMoveMechanics(board, from, to, epIdx);
  const next = applied.board;
  const other = opponent(mover);
  const upper = piece.toUpperCase();
  const moveStr = sqName(from) + sqName(to) + (applied.promoted ? 'q' : '');
  const historyAfter = history.concat([moveStr]);

  let outcome = mover + ': ' + sqName(from) + (applied.captured ? 'x' : '-') + sqName(to) +
    (applied.promoted ? '=Q' : '');
  let ending = null;
  if (forced) {
    outcome += ' \\u2014 illegal by agreement';
  } else {
    const oppInCheck = inCheck(next, other);
    if (!sideHasLegalMove(next, historyAfter, other)) {
      ending = oppInCheck ? 'checkmate \\u2014 ' + mover + ' wins' : 'draw by stalemate';
      outcome += oppInCheck ? ', checkmate' : ', stalemate';
    } else if (oppInCheck) {
      outcome += ', check';
    }
  }

  const fr = Math.floor(from / 8);
  const fc = from % 8;
  const tc = to % 8;
  const isCastle = upper === 'K' && fc === 4 && Math.abs(tc - fc) === 2;
  const isEp = upper === 'P' && to === epIdx && board[to] === '';
  const common = { notation: moveStr, nextTurn: other };
  if (forced) common.byAgreement = true;

  let request;
  if (isCastle) {
    const kingside = tc === 6;
    request = act('castle', Object.assign({
      kingFrom: sqName(from),
      kingTo: sqName(to),
      rookFrom: sqName(fr * 8 + (kingside ? 7 : 0)),
      rookTo: sqName(fr * 8 + (kingside ? 5 : 3)),
      king: piece,
      rook: mover === 'white' ? 'R' : 'r',
    }, common), { outcome: outcome });
  } else if (isEp) {
    request = act('en_passant', Object.assign({
      from: sqName(from),
      to: sqName(to),
      capturedSquare: sqName(fr * 8 + tc),
      pawn: piece,
      capturedPawn: mover === 'white' ? 'p' : 'P',
    }, common), { outcome: outcome });
  } else {
    request = act('move', Object.assign({
      from: sqName(from),
      to: sqName(to),
      piece: piece,
      captures: board[to],
      places: applied.promoted ? (mover === 'white' ? 'Q' : 'q') : piece,
    }, common), { outcome: outcome });
  }
  submit(request.then(function (res) {
    if (res && res.status === 'applied' && ending) {
      return act('declare_result', { result: ending }, { outcome: ending });
    }
    return res;
  }));
}

function resign() {
  const side = actingSide();
  submit(act('resign', {
    side: side,
    result: side + ' resigned \\u2014 ' + opponent(side) + ' wins',
  }));
}

function offerDraw() { submit(act('offer_draw', { side: actingSide() })); }

function acceptDraw() { submit(act('accept_draw', {})); }

function declineDraw() {
  submit(act('raw_patch', { summary: 'draw offer declined' }, {
    patch: [{ op: 'replace', path: '/state/drawOffer', value: null }],
    outcome: 'draw offer declined',
  }));
}

function requestTakeback() { submit(act('takeback_request', { side: actingSide() })); }

function grantTakeback() {
  const state = current.state;
  const history = Array.isArray(state.moveHistory) ? state.moveHistory : [];
  if (history.length === 0) { declineTakeback(); return; }
  const last = history[history.length - 1];
  // A rewind is a replay, and a replay is only honest when the live board IS
  // the history's product. A manual raw_patch adjustment (which the rules of
  // the house allow) would be silently reverted wholesale — refuse instead
  // and let the players unwind by agreement.
  const replayed = replayFromStart(history);
  for (let i = 0; i < 64; i++) {
    if (replayed[i] !== boardArr[i]) {
      submit(act('raw_patch', { summary: 'takeback not auto-applied \u2014 position was adjusted manually' }, {
        patch: [{ op: 'replace', path: '/state/takebackRequest', value: null }],
        outcome: 'takeback not auto-applied: the position differs from the move history (manual adjustment) \u2014 rewind by agreement with a manual edit',
      }));
      return;
    }
  }
  const historyRewound = history.slice(0, history.length - 1);
  const rewound = replayFromStart(historyRewound);
  const lastMover = colorOf(boardArr[sqIdx(last.slice(2, 4))]) || opponent(state.turn);
  const ops = boardOps(boardArr, rewound);
  ops.push({ op: 'remove', path: '/state/moveHistory/' + (history.length - 1) });
  ops.push({ op: 'replace', path: '/state/turn', value: lastMover });
  ops.push({
    op: 'replace',
    path: '/state/analysis',
    value: analysisValue(rewound, historyRewound, lastMover),
  });
  ops.push({ op: 'replace', path: '/state/takebackRequest', value: null });
  submit(act('raw_patch', { summary: 'takeback granted \\u2014 rewound ' + last }, {
    patch: ops,
    outcome: 'takeback granted: ' + last + ' rewound',
  }));
}

function declineTakeback() {
  submit(act('raw_patch', { summary: 'takeback declined' }, {
    patch: [{ op: 'replace', path: '/state/takebackRequest', value: null }],
    outcome: 'takeback declined',
  }));
}

function nudge() {
  submit(act('nudge_agent', { message: 'please look at the board' }));
}

function trySelect(i) {
  const state = current.state;
  const color = colorOf(boardArr[i]);
  if (!color) { selected = null; targets = []; render(); return; }
  if (forceMode) { selected = i; targets = []; render(); return; }
  const side = mySide(current.viewer);
  const allowed = side === null ? state.turn : side;
  if (color !== allowed || color !== state.turn) {
    selected = null;
    targets = [];
    notice = 'It is ' + state.turn + '\\u2019s move \\u2014 use force move to play out of turn by agreement.';
    render();
    return;
  }
  notice = '';
  selected = i;
  targets = legalTargets(boardArr, Array.isArray(state.moveHistory) ? state.moveHistory : [], i);
  render();
}

function onSquareClick(i) {
  if (!current) return;
  const state = current.state;
  const viewer = current.viewer;
  if ((viewer && viewer.spaceRole === 'viewer') || state.status === 'ended') return;
  if (selected === null) { trySelect(i); return; }
  if (i === selected) { selected = null; targets = []; render(); return; }
  if (forceMode) {
    const from = selected;
    selected = null; targets = [];
    performMove(from, i, true);
    return;
  }
  if (targets.indexOf(i) >= 0) {
    const from = selected;
    selected = null; targets = [];
    performMove(from, i, false);
    return;
  }
  trySelect(i);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, className, onClick, disabled) {
  const b = el('button', 'chess-btn' + (className ? ' ' + className : ''), label);
  b.type = 'button';
  if (disabled) b.disabled = true;
  else b.onclick = onClick;
  return b;
}

const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

function capturedPieces(board) {
  const tally = function (squares) {
    const counts = {};
    for (let i = 0; i < 64; i++) {
      const piece = squares[i];
      if (piece) counts[piece] = (counts[piece] || 0) + 1;
    }
    return counts;
  };
  const startCounts = tally(START);
  const nowCounts = tally(board);
  const gone = { white: [], black: [] };
  for (const letter in startCounts) {
    const missing = startCounts[letter] - (nowCounts[letter] || 0);
    for (let k = 0; k < missing; k++) gone[colorOf(letter)].push(letter);
  }
  const byValue = function (a, b) {
    return PIECE_VALUES[b.toLowerCase()] - PIECE_VALUES[a.toLowerCase()];
  };
  gone.white.sort(byValue);
  gone.black.sort(byValue);
  let score = 0;
  for (let i = 0; i < 64; i++) {
    const piece = board[i];
    if (piece) score += (colorOf(piece) === 'white' ? 1 : -1) * PIECE_VALUES[piece.toLowerCase()];
  }
  return { white: gone.white, black: gone.black, score: score };
}

function sanHistory(history, endedResult) {
  let board = START.slice();
  const played = [];
  const out = [];
  for (let m = 0; m < history.length; m++) {
    const move = history[m];
    const from = sqIdx(move.slice(0, 2));
    const to = sqIdx(move.slice(2, 4));
    const piece = board[from];
    const applied = applyMoveMechanics(board, from, to, epTargetIndex(board, played));
    let san = move;
    if (piece) {
      const upper = piece.toUpperCase();
      if (upper === 'K' && Math.abs((to % 8) - (from % 8)) === 2) {
        san = to % 8 === 6 ? 'O-O' : 'O-O-O';
      } else if (upper === 'P') {
        san = (applied.captured ? FILES[from % 8] + 'x' : '') + sqName(to);
        if (move.length === 5) san += '=' + move[4].toUpperCase();
        else if (applied.promoted) san += '=Q';
      } else {
        san = upper + (applied.captured ? 'x' : '') + sqName(to);
      }
    }
    board = applied.board;
    played.push(move);
    if (piece && inCheck(board, opponent(colorOf(piece)))) {
      const mated = m === history.length - 1 && endedResult.indexOf('checkmate') >= 0;
      san += mated ? '#' : '+';
    }
    out.push(san);
  }
  return out;
}

let drag = null;
let dragGhostEl = null;
let dragConsumedClick = false;

function removeDragGhost() {
  if (dragGhostEl) {
    dragGhostEl.remove();
    dragGhostEl = null;
  }
}

function squareIndexFromPoint(x, y) {
  const hit = document.elementFromPoint(x, y);
  const sq = hit && hit.closest ? hit.closest('[data-sq]') : null;
  return sq ? Number(sq.getAttribute('data-sq')) : null;
}

function beginDragTracking(event, index) {
  if (!current) return;
  const state = current.state;
  const viewer = current.viewer;
  if ((viewer && viewer.spaceRole === 'viewer') || state.status === 'ended') return;
  if (!boardArr[index]) return;
  if (event.button !== undefined && event.button > 0) return;
  drag = { from: index, x: event.clientX, y: event.clientY, active: false };
}

window.addEventListener('pointermove', function (event) {
  if (!drag) return;
  if (!drag.active) {
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (dx * dx + dy * dy < 36) return;
    trySelect(drag.from);
    if (selected !== drag.from) { drag = null; return; }
    drag.active = true;
    const boardEl = document.querySelector('.chess-board');
    const square = boardEl ? boardEl.clientWidth / 8 : 44;
    const piece = boardArr[drag.from];
    dragGhostEl = el('span', 'chess-ghost');
    dragGhostEl.appendChild(el('span', 'chess-mini ' + colorOf(piece), GLYPHS[piece]));
    dragGhostEl.style.fontSize = Math.round(square * 0.8) + 'px';
    document.body.appendChild(dragGhostEl);
  }
  dragGhostEl.style.left = event.clientX + 'px';
  dragGhostEl.style.top = event.clientY + 'px';
});

window.addEventListener('pointerup', function (event) {
  if (!drag) return;
  const wasActive = drag.active;
  drag = null;
  removeDragGhost();
  if (!wasActive) return;
  dragConsumedClick = true;
  setTimeout(function () { dragConsumedClick = false; }, 0);
  const target = squareIndexFromPoint(event.clientX, event.clientY);
  if (target === null || target === selected) { render(); return; }
  onSquareClick(target);
});

window.addEventListener('pointercancel', function () {
  if (!drag && !dragGhostEl) return;
  drag = null;
  removeDragGhost();
  render();
});

const styleEl = document.createElement('style');
// Square tints mix DS theme variables per theme (there is no dedicated board
// token); each mix is preceded by a plain literal as the fallback for engines
// without color-mix support.
styleEl.textContent = [
  '.chess-root { display: flex; flex-direction: column; gap: 14px; padding: 2px; }',
  '.chess-header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }',
  '.chess-title { font-weight: 650; font-size: 15px; letter-spacing: 0.01em; }',
  '.chess-turn-dot { width: 12px; height: 12px; border-radius: 50%; border: 1px solid var(--ds-border-default, rgba(127, 127, 127, 0.6)); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15); }',
  '.chess-turn-dot.white { background: #f2ecdc; }',
  '.chess-turn-dot.black { background: #262421; }',
  '.chess-status { font-size: 14px; }',
  '.chess-check-flag { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ds-danger, #d43d3d); animation: chess-pulse 1.6s ease-in-out infinite; }',
  '@keyframes chess-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }',
  '.chess-roles { font-size: 12px; color: var(--ds-text-muted, inherit); border: 1px solid var(--ds-border-subtle, rgba(127, 127, 127, 0.3)); border-radius: 999px; padding: 2px 10px; margin-left: auto; background: color-mix(in srgb, var(--ds-bg-panel, #fdfcf9) 55%, transparent); }',
  '.chess-banner { padding: 8px 12px; border-radius: 10px; font-size: 13px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; border: 1px solid color-mix(in srgb, var(--ds-highlight, #d4a030) 35%, transparent); background: color-mix(in srgb, var(--ds-highlight, #d4a030) 12%, var(--ds-bg-panel, #fdfcf9)); backdrop-filter: blur(10px); }',
  '.chess-note { font-size: 12px; color: var(--ds-text-muted, inherit); }',
  '.chess-board-col { min-width: 220px; width: 100%; max-width: 42rem; margin: 0 auto; display: flex; flex-direction: column; gap: 8px; }',
  '.chess-board { display: grid; grid-template-columns: repeat(8, 1fr); grid-template-rows: repeat(8, 1fr); width: 100%; aspect-ratio: 1; border: 1px solid color-mix(in srgb, var(--ds-border-strong, #8a7a5e) 45%, transparent); border-radius: 12px; overflow: hidden; container-type: inline-size; user-select: none; -webkit-user-select: none; touch-action: none; box-shadow: 0 2px 10px rgba(40, 30, 10, 0.12), 0 1px 2px rgba(40, 30, 10, 0.08); }',
  '.chess-board.chess-waiting { opacity: 0.75; }',
  '.chess-sq { position: relative; border: none; margin: 0; padding: 0; font: inherit; color: inherit; line-height: 1; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: background-color 150ms ease; }',
  '.chess-sq.light { background: #f2ebdb; background: color-mix(in srgb, var(--ds-highlight, #d4a030) 7%, var(--ds-bg-panel, #fdfcf9)); }',
  '.chess-sq.dark { background: #b7946c; background: color-mix(in srgb, var(--ds-highlight, #d4a030) 42%, #a08055); }',
  'html[data-theme="dark"] .chess-sq.light { background: #46413a; background: color-mix(in srgb, var(--ds-highlight, #d4a94e) 14%, #3e3a33); }',
  'html[data-theme="dark"] .chess-sq.dark { background: #2b2822; background: color-mix(in srgb, var(--ds-highlight, #d4a94e) 5%, #262320); }',
  '.chess-sq.last::before { content: ""; position: absolute; inset: 0; background: var(--ds-highlight, #d4a030); opacity: 0.3; pointer-events: none; animation: chess-glow 500ms ease-out; }',
  '@keyframes chess-glow { from { opacity: 0; } to { opacity: 0.3; } }',
  '.chess-sq.check-sq::before { content: ""; position: absolute; inset: 0; background: var(--ds-danger, #d43d3d); opacity: 0.35; pointer-events: none; }',
  '.chess-sq.selected { box-shadow: inset 0 0 0 3px var(--ds-accent-primary, #6a48b8); }',
  '.chess-sq.target::after { content: ""; position: absolute; width: 30%; height: 30%; left: 35%; top: 35%; border-radius: 50%; background: var(--ds-accent-primary, #6a48b8); opacity: 0.5; pointer-events: none; animation: chess-dot 140ms ease-out; }',
  '@keyframes chess-dot { from { transform: scale(0.5); opacity: 0; } to { transform: scale(1); opacity: 0.5; } }',
  '.chess-sq.target.has-piece::after { width: 90%; height: 90%; left: 5%; top: 5%; background: transparent; border: 3px solid var(--ds-accent-primary, #6a48b8); opacity: 0.6; animation: none; }',
  '.chess-piece, .chess-mini { position: relative; z-index: 1; pointer-events: none; }',
  '.chess-piece { font-size: clamp(16px, 5.2vw, 34px); font-size: 9.6cqw; transition: transform 130ms ease; }',
  '.chess-sq:hover .chess-piece { transform: translateY(-1px) scale(1.05); }',
  '.chess-piece.white, .chess-mini.white { color: #f6f1e2; -webkit-text-stroke: 1px rgba(46, 38, 24, 0.7); text-shadow: 0 1px 2px rgba(30, 22, 8, 0.45); }',
  '.chess-piece.black, .chess-mini.black { color: #262421; -webkit-text-stroke: 1px rgba(246, 241, 226, 0.28); text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4); }',
  '.chess-coord { position: absolute; font-size: 9px; font-size: 2.9cqw; font-weight: 600; opacity: 0.6; pointer-events: none; }',
  '.chess-coord.rank { top: 4%; left: 5%; }',
  '.chess-coord.file { bottom: 4%; right: 5%; }',
  '.chess-tray { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; min-height: 20px; font-size: 16px; line-height: 1; padding: 0 2px; }',
  '.chess-tray-label { font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ds-text-muted, inherit); margin-right: 4px; }',
  '.chess-adv { font-size: 11px; font-weight: 700; color: var(--ds-highlight, #d4a030); margin-left: 4px; }',
  '.chess-bar { display: flex; align-items: center; gap: 7px; margin-top: 2px; }',
  '.chess-bar-spacer { flex: 1; }',
  '.chess-btn.on { border-color: var(--ds-accent-primary, #6a48b8); background: color-mix(in srgb, var(--ds-accent-primary, #6a48b8) 10%, var(--ds-bg-panel, #fdfcf9)); }',
  '.chess-kebab { min-width: 30px; font-size: 15px; padding: 3px 10px; }',
  '.chess-menu-wrap { position: relative; display: inline-flex; }',
  '.chess-menu { position: absolute; right: 0; bottom: calc(100% + 6px); z-index: 5; display: flex; flex-direction: column; align-items: stretch; gap: 4px; min-width: 200px; padding: 8px; border-radius: 12px; border: 1px solid color-mix(in srgb, var(--ds-border-default, #e0dcd1) 80%, transparent); background: var(--ds-bg-panel, #fdfcf9); box-shadow: 0 6px 20px rgba(40, 30, 10, 0.16); }',
  '.chess-menu-item { text-align: left; border-radius: 8px; }',
  '.chess-moves { border: 1px solid color-mix(in srgb, var(--ds-border-default, #e0dcd1) 70%, transparent); background: color-mix(in srgb, var(--ds-bg-panel, #fdfcf9) 55%, transparent); backdrop-filter: blur(12px) saturate(1.05); border-radius: 12px; padding: 10px 12px; max-height: 336px; overflow-y: auto; box-shadow: 0 1px 4px rgba(40, 30, 10, 0.06); }',
  '.chess-moves-empty { font-size: 12px; color: var(--ds-text-muted, inherit); }',
  '.chess-moves-grid { display: grid; grid-template-columns: auto 1fr 1fr; gap: 3px 10px; align-items: baseline; font-size: 13px; }',
  '.chess-move-num { font-size: 11px; color: var(--ds-text-muted, inherit); }',
  '.chess-move { padding: 1px 5px; border-radius: 5px; }',
  '.chess-move.current { font-weight: 700; background: color-mix(in srgb, var(--ds-highlight, #d4a030) 22%, transparent); }',
  '.chess-controls { display: flex; gap: 7px; align-items: center; flex-wrap: wrap; }',
  '.chess-btn { font: inherit; font-size: 12.5px; padding: 5px 13px; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--ds-border-default, #e0dcd1) 80%, transparent); background: color-mix(in srgb, var(--ds-bg-panel, #fdfcf9) 60%, transparent); backdrop-filter: blur(8px); color: inherit; cursor: pointer; transition: border-color 130ms ease, background-color 130ms ease, transform 130ms ease; }',
  '.chess-btn:hover:not(:disabled) { border-color: var(--ds-accent-primary, #6a48b8); background: color-mix(in srgb, var(--ds-accent-primary, #6a48b8) 8%, var(--ds-bg-panel, #fdfcf9)); transform: translateY(-1px); }',
  '.chess-btn:active:not(:disabled) { transform: translateY(0); }',
  '.chess-btn:disabled { opacity: 0.45; cursor: default; }',
  '.chess-btn.danger { color: var(--ds-danger, #d43d3d); border-color: color-mix(in srgb, var(--ds-danger, #d43d3d) 45%, transparent); }',
  '.chess-btn.danger:hover:not(:disabled) { border-color: var(--ds-danger, #d43d3d); background: color-mix(in srgb, var(--ds-danger, #d43d3d) 8%, var(--ds-bg-panel, #fdfcf9)); }',
  '.chess-force { font-size: 12px; display: inline-flex; align-items: center; gap: 6px; padding: 5px 11px; border-radius: 999px; border: 1px dashed color-mix(in srgb, var(--ds-danger, #d43d3d) 60%, transparent); color: var(--ds-danger, #d43d3d); cursor: pointer; transition: background-color 130ms ease; }',
  '.chess-force.on { font-weight: 600; background: color-mix(in srgb, var(--ds-danger, #d43d3d) 12%, transparent); }',
  '.chess-force input { accent-color: var(--ds-danger, #d43d3d); margin: 0; }',

  '.chess-ghost { position: fixed; z-index: 10; pointer-events: none; transform: translate(-50%, -60%); line-height: 1; filter: drop-shadow(0 3px 5px rgba(0, 0, 0, 0.35)); }',
].join('\\n');
document.head.appendChild(styleEl);

const root = el('div', 'chess-root');
document.body.appendChild(root);

function trayRow(sideColor, captured) {
  const row = el('div', 'chess-tray');
  row.appendChild(el('span', 'chess-tray-label', sideColor === 'white' ? 'White' : 'Black'));
  const taken = sideColor === 'white' ? captured.black : captured.white;
  for (let i = 0; i < taken.length; i++) {
    row.appendChild(el('span', 'chess-mini ' + colorOf(taken[i]), GLYPHS[taken[i]]));
  }
  const lead = sideColor === 'white' ? captured.score : -captured.score;
  if (lead > 0) row.appendChild(el('span', 'chess-adv', '+' + lead));
  return row;
}

function buildBoard(board, waiting, readOnly, flipped, checkIdx, lastFrom, lastTo) {
  const grid = el('div', 'chess-board' + (waiting ? ' chess-waiting' : ''));
  for (let d = 0; d < 64; d++) {
    const i = flipped ? 63 - d : d;
    const r = Math.floor(i / 8); const c = i % 8;
    let cls = 'chess-sq ' + ((r + c) % 2 === 0 ? 'light' : 'dark');
    if (i === selected) cls += ' selected';
    if (targets.indexOf(i) >= 0) cls += ' target';
    if (board[i]) cls += ' has-piece';
    if (i === lastFrom || i === lastTo) cls += ' last';
    if (i === checkIdx) cls += ' check-sq';
    const sq = el('button', cls);
    sq.type = 'button';
    sq.setAttribute('data-sq', String(i));
    sq.setAttribute('aria-label', sqName(i) + (board[i] ? ' ' + board[i] : ''));
    if (board[i]) {
      sq.appendChild(el('span', 'chess-piece ' + colorOf(board[i]), GLYPHS[board[i]]));
    }
    const dr = Math.floor(d / 8); const dc = d % 8;
    if (dc === 0) sq.appendChild(el('span', 'chess-coord rank', sqName(i)[1]));
    if (dr === 7) sq.appendChild(el('span', 'chess-coord file', sqName(i)[0]));
    if (!readOnly) {
      sq.onclick = (function (index) {
        return function () {
          if (dragConsumedClick) return;
          onSquareClick(index);
        };
      })(i);
      sq.onpointerdown = (function (index) {
        return function (event) { beginDragTracking(event, index); };
      })(i);
    }
    grid.appendChild(sq);
  }
  return grid;
}

function movesPanel(history, state) {
  const panel = el('div', 'chess-moves');
  if (!history.length) {
    panel.appendChild(el('div', 'chess-moves-empty', 'No moves yet.'));
    return panel;
  }
  const san = sanHistory(history, state.status === 'ended' ? state.result || '' : '');
  const grid = el('div', 'chess-moves-grid');
  for (let i = 0; i < san.length; i += 2) {
    grid.appendChild(el('span', 'chess-move-num', String(i / 2 + 1) + '.'));
    grid.appendChild(el('span', 'chess-move' + (i === san.length - 1 ? ' current' : ''), san[i]));
    const black = i + 1 < san.length ? san[i + 1] : '';
    grid.appendChild(el('span', 'chess-move' + (i + 1 === san.length - 1 ? ' current' : ''), black));
  }
  panel.appendChild(grid);
  return panel;
}

// The board is the content; controls are occasions. Everything that happens
// once a game lives behind the kebab; the log opens on demand; the bar keeps
// only what a live game actually uses.
let movesOpen = false;
let menuOpen = false;

function menuItem(label, className, onClick) {
  return button(label, 'chess-menu-item' + (className ? ' ' + className : ''), function () {
    menuOpen = false;
    onClick();
  });
}

function actionBar(history) {
  const bar = el('div', 'chess-bar');

  bar.appendChild(
    button(
      'Moves' + (history.length ? ' (' + String(history.length) + ')' : ''),
      movesOpen ? 'on' : '',
      function () {
        movesOpen = !movesOpen;
        render();
      },
    ),
  );

  bar.appendChild(el('span', 'chess-bar-spacer'));

  bar.appendChild(button('Nudge agent', '', nudge));

  const menuWrap = el('span', 'chess-menu-wrap');
  const kebab = button('\\u22ee', 'chess-kebab' + (menuOpen ? ' on' : ''), function () {
    menuOpen = !menuOpen;
    render();
  });
  kebab.setAttribute('aria-label', 'Game actions');
  menuWrap.appendChild(kebab);

  if (menuOpen) {
    const menu = el('div', 'chess-menu');
    menu.appendChild(menuItem('Offer draw', '', offerDraw));
    menu.appendChild(menuItem('Request takeback', '', requestTakeback));
    const forceLabel = el('label', 'chess-force' + (forceMode ? ' on' : ''));
    const forceBox = document.createElement('input');
    forceBox.type = 'checkbox';
    forceBox.checked = forceMode;
    forceBox.onchange = function () {
      forceMode = forceBox.checked;
      selected = null;
      targets = [];
      menuOpen = false;
      render();
    };
    forceLabel.appendChild(forceBox);
    forceLabel.appendChild(document.createTextNode(' force move (by agreement)'));
    menu.appendChild(forceLabel);
    menu.appendChild(menuItem('Resign', 'danger', resign));
    menuWrap.appendChild(menu);
  }
  bar.appendChild(menuWrap);
  return bar;
}

function render() {
  root.textContent = '';
  if (!current) {
    root.appendChild(el('div', 'chess-note', 'Waiting for the game state\\u2026'));
    return;
  }
  const state = current.state || {};
  const viewer = current.viewer || {};
  const board = boardArr;
  const history = Array.isArray(state.moveHistory) ? state.moveHistory : [];
  const ended = state.status === 'ended';
  const readOnly = viewer.spaceRole === 'viewer' || ended;
  const side = mySide(viewer);
  const flipped = side === 'black';
  const bottomSide = flipped ? 'black' : 'white';
  const inCheckNow = !ended && inCheck(board, state.turn);

  const header = el('div', 'chess-header');
  header.appendChild(el('div', 'chess-title', 'Chess'));
  if (!ended) header.appendChild(el('span', 'chess-turn-dot ' + state.turn));
  const statusText = ended
    ? (state.result || 'game over')
    : (state.turn === 'white' ? 'White' : 'Black') + ' to move';
  header.appendChild(el('div', 'chess-status', statusText));
  if (inCheckNow) header.appendChild(el('span', 'chess-check-flag', 'check'));
  const players = state.players && typeof state.players === 'object' ? state.players : {};
  const bound = {};
  (Array.isArray(current.seats) ? current.seats : []).forEach(function (seat) {
    if (seat && seat.roleId && seat.displayName) bound[seat.roleId] = seat.displayName;
  });
  const seatLine = [];
  const whiteName = bound.white || players.white;
  const blackName = bound.black || players.black;
  if (whiteName) seatLine.push('White: ' + whiteName);
  if (blackName) seatLine.push('Black: ' + blackName);
  if (seatLine.length) header.appendChild(el('div', 'chess-note', seatLine.join(' \\u00b7 ')));
  if (viewer.appletRoles && viewer.appletRoles.length) {
    header.appendChild(el('div', 'chess-roles', 'You: ' + viewer.appletRoles.join(', ')));
  }
  root.appendChild(header);

  if (state.drawOffer && !ended) {
    const banner = el('div', 'chess-banner');
    banner.appendChild(el('span', '', state.drawOffer + ' offers a draw'));
    if (!readOnly) {
      banner.appendChild(button('Accept', '', acceptDraw, side !== null && side === state.drawOffer));
      banner.appendChild(button('Decline', '', declineDraw));
    }
    root.appendChild(banner);
  }
  if (state.takebackRequest && !ended) {
    const banner = el('div', 'chess-banner');
    banner.appendChild(el('span', '', state.takebackRequest + ' asks to take back the last move'));
    if (!readOnly) {
      banner.appendChild(button('Grant', '', grantTakeback, side !== null && side === state.takebackRequest));
      banner.appendChild(button('Decline', '', declineTakeback));
    }
    root.appendChild(banner);
  }
  if (notice) root.appendChild(el('div', 'chess-note', notice));

  const waiting = !ended && !forceMode && side !== null && state.turn !== side;
  const last = history.length ? history[history.length - 1] : null;
  const lastFrom = last ? sqIdx(last.slice(0, 2)) : -1;
  const lastTo = last ? sqIdx(last.slice(2, 4)) : -1;
  const checkIdx = inCheckNow ? board.indexOf(state.turn === 'white' ? 'K' : 'k') : -1;
  const captured = capturedPieces(board);

  const boardCol = el('div', 'chess-board-col');
  boardCol.appendChild(trayRow(opponent(bottomSide), captured));
  boardCol.appendChild(buildBoard(board, waiting, readOnly, flipped, checkIdx, lastFrom, lastTo));
  boardCol.appendChild(trayRow(bottomSide, captured));
  if (!readOnly) boardCol.appendChild(actionBar(history));
  let moves = null;
  if (movesOpen || readOnly) {
    moves = movesPanel(history, state);
    boardCol.appendChild(moves);
  }
  root.appendChild(boardCol);

  if (viewer.spaceRole === 'viewer') {
    root.appendChild(el('div', 'chess-note', 'View-only \\u2014 you can watch, but only editors can play.'));
  }
  if (moves) moves.scrollTop = moves.scrollHeight;
}

// The view is the analysis oracle: whenever the pushed state's analysis does
// not describe the current position (an agent move, a raw_patch adjustment),
// any open board recomputes and writes it. baseVersion CAS makes concurrent
// tabs safe — one write lands, the rest conflict silently and re-check on the
// next push.
let refreshedAtVersion = -1;
function maybeRefreshAnalysis() {
  if (!current) return;
  const state = current.state;
  const viewer = current.viewer;
  if (viewer && viewer.spaceRole === 'viewer') return;
  if (state.status !== 'playing') return;
  const history = Array.isArray(state.moveHistory) ? state.moveHistory : [];
  const expected = analysisValue(boardArr, history, state.turn);
  const held = state.analysis && typeof state.analysis === 'object' ? state.analysis : null;
  if (
    held &&
    held.forMoves === expected.forMoves &&
    Array.isArray(held.legalMoves) &&
    held.legalMoves.slice().sort().join(',') === expected.legalMoves.slice().sort().join(',')
  ) {
    return;
  }
  if (refreshedAtVersion === current.version) return;
  refreshedAtVersion = current.version;
  act('refresh_analysis', {}, {
    patch: [{ op: 'replace', path: '/state/analysis', value: expected }],
    outcome: 'analysis refreshed',
    silent: true,
  }).catch(function () {});
}

window.addEventListener('aflowstate', function (event) {
  current = event.detail;
  boardArr = boardFromState(current && current.state);
  selected = null;
  targets = [];
  notice = '';
  drag = null;
  removeDragGhost();
  render();
  maybeRefreshAnalysis();
});

render();
`;
