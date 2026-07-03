/*
 * FourChess rules engine.
 *
 * Pure logic, no transport: the server (Node) and the client (browser, for
 * move-highlight UX) share this exact file, so legality is computed from a
 * single source of truth. The server remains the only authority — the client
 * copy is a convenience.
 *
 * Board model: 12x12 array indexed [row][col], row 0 = top, col 0 = left.
 * Each cell is null (empty), the string 'void' (unplayable 2x2 corner), or a
 * piece object { type: 'P'|'N'|'B'|'R'|'Q'|'K', color: seat }.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FourChess = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SIZE = 12;

  // Fixed clockwise turn order.
  const SEATS = ['north', 'east', 'south', 'west'];

  // Forward axis per seat: pawns advance toward the far side of the board.
  const FORWARD = {
    north: [1, 0],   // down
    east: [0, -1],   // left
    south: [-1, 0],  // up
    west: [0, 1],    // right
  };

  const BACK_RANK = ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'];

  const ORTHO = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const KNIGHT = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];

  function isVoid(r, c) {
    return (r <= 1 || r >= 10) && (c <= 1 || c >= 10);
  }

  function onGrid(r, c) {
    return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
  }

  function isPlayable(r, c) {
    return onGrid(r, c) && !isVoid(r, c);
  }

  // Cell accessor that folds "off the grid" into a sentinel so movement code
  // can treat off-grid and void uniformly as blockers.
  function cellAt(board, r, c) {
    if (!onGrid(r, c)) return 'void';
    return board[r][c];
  }

  function createBoard(seats) {
    const board = [];
    for (let r = 0; r < SIZE; r++) {
      const row = [];
      for (let c = 0; c < SIZE; c++) row.push(isVoid(r, c) ? 'void' : null);
      board.push(row);
    }
    for (const seat of seats) {
      for (let i = 0; i < 8; i++) {
        const back = { type: BACK_RANK[i], color: seat };
        const pawn = { type: 'P', color: seat };
        if (seat === 'north') { board[0][2 + i] = back; board[1][2 + i] = pawn; }
        else if (seat === 'south') { board[11][2 + i] = back; board[10][2 + i] = pawn; }
        else if (seat === 'west') { board[2 + i][0] = back; board[2 + i][1] = pawn; }
        else if (seat === 'east') { board[2 + i][11] = back; board[2 + i][10] = pawn; }
      }
    }
    return board;
  }

  // A pawn on its own start rank has necessarily never moved: pawns never move
  // backward along their forward axis, and no capture can bring one back.
  function onPawnStartRank(seat, r, c) {
    return (seat === 'north' && r === 1)
      || (seat === 'south' && r === 10)
      || (seat === 'west' && c === 1)
      || (seat === 'east' && c === 10);
  }

  function isPromotionCell(seat, r, c) {
    return (seat === 'north' && r === 11)
      || (seat === 'south' && r === 0)
      || (seat === 'west' && c === 11)
      || (seat === 'east' && c === 0);
  }

  function legalMovesFrom(board, r, c) {
    const piece = cellAt(board, r, c);
    if (!piece || piece === 'void') return [];
    const moves = [];

    const step = (rr, cc) => {
      const t = cellAt(board, rr, cc);
      if (t === 'void') return;
      if (t && t.color === piece.color) return;
      moves.push([rr, cc]);
    };

    const ray = (dr, dc) => {
      let rr = r + dr, cc = c + dc;
      for (;;) {
        const t = cellAt(board, rr, cc);
        if (t === 'void') break;
        if (t) {
          if (t.color !== piece.color) moves.push([rr, cc]);
          break;
        }
        moves.push([rr, cc]);
        rr += dr; cc += dc;
      }
    };

    switch (piece.type) {
      case 'N':
        for (const [dr, dc] of KNIGHT) step(r + dr, c + dc);
        break;
      case 'K':
        for (const [dr, dc] of ORTHO) step(r + dr, c + dc);
        for (const [dr, dc] of DIAG) step(r + dr, c + dc);
        break;
      case 'R':
        for (const [dr, dc] of ORTHO) ray(dr, dc);
        break;
      case 'B':
        for (const [dr, dc] of DIAG) ray(dr, dc);
        break;
      case 'Q':
        for (const [dr, dc] of ORTHO) ray(dr, dc);
        for (const [dr, dc] of DIAG) ray(dr, dc);
        break;
      case 'P': {
        const [fr, fc] = FORWARD[piece.color];
        if (cellAt(board, r + fr, c + fc) === null) {
          moves.push([r + fr, c + fc]);
          if (onPawnStartRank(piece.color, r, c) && cellAt(board, r + 2 * fr, c + 2 * fc) === null) {
            moves.push([r + 2 * fr, c + 2 * fc]);
          }
        }
        // Diagonal-forward captures: forward axis combined with each
        // perpendicular direction.
        const perps = fr === 0 ? [[1, 0], [-1, 0]] : [[0, 1], [0, -1]];
        for (const [pr, pc] of perps) {
          const rr = r + fr + pr, cc = c + fc + pc;
          const t = cellAt(board, rr, cc);
          if (t && t !== 'void' && t.color !== piece.color) moves.push([rr, cc]);
        }
        break;
      }
    }
    return moves;
  }

  function hasAnyMove(board, seat) {
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const p = board[r][c];
        if (p && p !== 'void' && p.color === seat && legalMovesFrom(board, r, c).length > 0) {
          return true;
        }
      }
    }
    return false;
  }

  function createGame(seatNames) {
    const order = SEATS.filter((s) => seatNames.indexOf(s) !== -1);
    if (order.length < 2 || order.length > 4 || order.length !== seatNames.length) {
      throw new Error('createGame needs 2-4 valid distinct seats');
    }
    return {
      phase: 'active',
      board: createBoard(order),
      order,
      eliminated: {},
      turn: order[0],
      winner: null,
      captured: [],
      lastMove: null,
    };
  }

  function isCoord(x) {
    return Array.isArray(x) && x.length === 2
      && Number.isInteger(x[0]) && Number.isInteger(x[1]);
  }

  /*
   * Validate and apply a move. Returns { ok: true, events } or
   * { ok: false, error } — on failure the game state is untouched.
   */
  function applyMove(game, seat, from, to) {
    if (game.phase !== 'active') return { ok: false, error: 'The game is not in progress.' };
    if (seat !== game.turn) return { ok: false, error: 'It is not your turn.' };
    if (!isCoord(from) || !isCoord(to)) return { ok: false, error: 'Malformed move.' };
    const [fr, fc] = from, [tr, tc] = to;
    if (!isPlayable(fr, fc) || !isPlayable(tr, tc)) return { ok: false, error: 'Move is off the board.' };

    const piece = game.board[fr][fc];
    if (!piece || piece === 'void') return { ok: false, error: 'There is no piece on that square.' };
    if (piece.color !== seat) return { ok: false, error: 'That piece is not yours.' };

    const legal = legalMovesFrom(game.board, fr, fc)
      .some(([r, c]) => r === tr && c === tc);
    if (!legal) return { ok: false, error: 'That piece cannot move there.' };

    const events = {};
    const target = game.board[tr][tc];

    if (target) {
      game.captured.push({ type: target.type, color: target.color, by: seat });
      events.captured = { type: target.type, color: target.color };
    }

    game.board[fr][fc] = null;
    if (piece.type === 'P' && isPromotionCell(seat, tr, tc)) {
      game.board[tr][tc] = { type: 'Q', color: seat };
      events.promoted = true;
    } else {
      game.board[tr][tc] = piece;
    }
    game.lastMove = { from: [fr, fc], to: [tr, tc] };

    // King captured: the owner is eliminated immediately and all of their
    // remaining pieces leave the board.
    if (target && target.type === 'K') {
      const dead = target.color;
      game.eliminated[dead] = true;
      events.eliminated = dead;
      for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
          const p = game.board[r][c];
          if (p && p !== 'void' && p.color === dead) game.board[r][c] = null;
        }
      }
    }

    const alive = game.order.filter((s) => !game.eliminated[s]);
    if (alive.length === 1) {
      game.winner = alive[0];
      game.phase = 'over';
      game.turn = null;
      events.winner = game.winner;
      return { ok: true, events };
    }

    // Advance clockwise, skipping eliminated seats. A seat with zero legal
    // moves is also skipped (its turn is forfeited) so the game cannot stall;
    // with check unenforced this is a rare corner case.
    const idx = game.order.indexOf(seat);
    let next = null;
    for (let i = 1; i <= game.order.length; i++) {
      const cand = game.order[(idx + i) % game.order.length];
      if (game.eliminated[cand]) continue;
      if (!hasAnyMove(game.board, cand)) continue;
      next = cand;
      break;
    }
    if (next === null) {
      // Nobody at all can move — declare a draw rather than hang.
      game.phase = 'over';
      game.winner = null;
      game.turn = null;
      events.draw = true;
    } else {
      game.turn = next;
    }
    return { ok: true, events };
  }

  // Boot-time sanity assertions on the geometry and starting layout.
  function sanityCheck() {
    let playable = 0;
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) if (isPlayable(r, c)) playable++;
    }
    if (playable !== 128) throw new Error(`sanityCheck: expected 128 playable cells, got ${playable}`);

    const board = createBoard(SEATS);
    let pieces = 0, kings = 0, pawns = 0;
    const perSeat = { north: 0, east: 0, south: 0, west: 0 };
    for (let r = 2; r <= 9; r++) {
      for (let c = 2; c <= 9; c++) {
        if (board[r][c] !== null) throw new Error('sanityCheck: central 8x8 must start empty');
      }
    }
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const p = board[r][c];
        if (!p || p === 'void') continue;
        pieces++;
        perSeat[p.color]++;
        if (p.type === 'K') kings++;
        if (p.type === 'P') pawns++;
      }
    }
    if (pieces !== 64) throw new Error(`sanityCheck: expected 64 pieces, got ${pieces}`);
    if (kings !== 4) throw new Error(`sanityCheck: expected 4 kings, got ${kings}`);
    if (pawns !== 32) throw new Error(`sanityCheck: expected 32 pawns, got ${pawns}`);
    for (const seat of SEATS) {
      if (perSeat[seat] !== 16) throw new Error(`sanityCheck: ${seat} should have 16 pieces`);
    }
    return true;
  }

  return {
    SIZE,
    SEATS,
    FORWARD,
    isVoid,
    isPlayable,
    createBoard,
    legalMovesFrom,
    hasAnyMove,
    createGame,
    applyMove,
    sanityCheck,
  };
});
