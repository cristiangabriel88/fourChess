'use strict';

/*
 * FourChess test suite:
 *   1. Engine unit checks (geometry, promotion, elimination, rejections).
 *   2. Full end-to-end game over Socket.io against the real server.
 *
 * Run with: npm test  (server must NOT already be running on the test port)
 */

const assert = require('assert');
const FourChess = require('../game');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

function hasMove(moves, r, c) {
  return moves.some(([mr, mc]) => mr === r && mc === c);
}

console.log('engine unit checks');

check('sanityCheck: 128 playable cells, 64 pieces, 4 kings', () => {
  assert.strictEqual(FourChess.sanityCheck(), true);
});

check('void corners block sliding and landing', () => {
  const board = FourChess.createBoard([]);
  board[2][1] = { type: 'R', color: 'west' };
  const moves = FourChess.legalMovesFrom(board, 2, 1);
  assert.ok(!hasMove(moves, 1, 1), 'rook must not enter the void at (1,1)');
  assert.ok(!hasMove(moves, 0, 1), 'rook must not pass through the void');
  assert.ok(hasMove(moves, 2, 0), 'rook can slide within the arm');
  assert.ok(hasMove(moves, 9, 1), 'rook can slide down the arm');
  assert.ok(!hasMove(moves, 10, 1), 'rook stops before the south-west void');
});

check('pawn moves: single, double from start rank, diagonal capture only', () => {
  const board = FourChess.createBoard([]);
  board[1][4] = { type: 'P', color: 'north' };
  let moves = FourChess.legalMovesFrom(board, 1, 4);
  assert.ok(hasMove(moves, 2, 4) && hasMove(moves, 3, 4), 'single and double push');
  assert.strictEqual(moves.length, 2, 'no captures without enemies');

  board[2][5] = { type: 'P', color: 'east' };
  board[2][4] = { type: 'P', color: 'east' };
  moves = FourChess.legalMovesFrom(board, 1, 4);
  assert.ok(!hasMove(moves, 2, 4), 'pawn cannot push into an occupied cell');
  assert.ok(!hasMove(moves, 3, 4), 'double push blocked when first cell occupied');
  assert.ok(hasMove(moves, 2, 5), 'diagonal-forward capture');
  assert.strictEqual(moves.length, 1);
});

check('east pawn moves along -col', () => {
  const board = FourChess.createBoard(['east']);
  const moves = FourChess.legalMovesFrom(board, 5, 10);
  assert.ok(hasMove(moves, 5, 9) && hasMove(moves, 5, 8));
  assert.strictEqual(moves.length, 2);
});

check('pawn auto-promotes to queen on the far edge', () => {
  const game = FourChess.createGame(['north', 'east']);
  game.board[10][5] = { type: 'P', color: 'north' };
  const res = FourChess.applyMove(game, 'north', [10, 5], [11, 5]);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.events.promoted, true);
  assert.deepStrictEqual(game.board[11][5], { type: 'Q', color: 'north' });
});

check('king capture eliminates the seat and sweeps its pieces', () => {
  const game = FourChess.createGame(['north', 'east']);
  game.board[1][7] = { type: 'Q', color: 'east' }; // replace a north pawn
  game.turn = 'east';
  const res = FourChess.applyMove(game, 'east', [1, 7], [0, 6]); // captures north king
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.events.eliminated, 'north');
  assert.strictEqual(game.winner, 'east');
  assert.strictEqual(game.phase, 'over');
  let northPieces = 0;
  for (const row of game.board) {
    for (const cell of row) {
      if (cell && cell !== 'void' && cell.color === 'north') northPieces++;
    }
  }
  assert.strictEqual(northPieces, 0, 'all north pieces swept from the board');
});

check('illegal moves are rejected without state change', () => {
  const game = FourChess.createGame(['north', 'east']);
  const before = JSON.stringify(game.board);
  assert.strictEqual(FourChess.applyMove(game, 'east', [5, 10], [5, 9]).ok, false, 'out of turn');
  assert.strictEqual(FourChess.applyMove(game, 'north', [5, 10], [5, 9]).ok, false, 'not your piece');
  assert.strictEqual(FourChess.applyMove(game, 'north', [0, 2], [5, 2]).ok, false, 'rook through blocker');
  assert.strictEqual(FourChess.applyMove(game, 'north', [1, 2], [1, 3]).ok, false, 'pawn sideways');
  assert.strictEqual(FourChess.applyMove(game, 'north', [0, 0], [0, 1]).ok, false, 'void square');
  assert.strictEqual(JSON.stringify(game.board), before, 'board untouched');
  assert.strictEqual(game.turn, 'north', 'turn untouched');
});

// --- End-to-end over Socket.io ------------------------------------------

const TEST_PORT = 3199;
process.env.PORT = String(TEST_PORT);
process.env.BASE_PATH = '/fourchess';
const { server } = require('../server');
const { io } = require('socket.io-client');

const URL = `http://localhost:${TEST_PORT}`;
const OPTS = { path: '/fourchess/socket.io/', transports: ['websocket'], forceNew: true };

function connect() {
  const socket = io(URL, OPTS);
  socket.latestState = null;
  socket.on('state', (s) => { socket.latestState = s; });
  return socket;
}

function emitAck(socket, event, payload) {
  return new Promise((resolve) => {
    if (payload === undefined) socket.emit(event, resolve);
    else socket.emit(event, payload, resolve);
  });
}

function waitForState(socket, predicate) {
  return new Promise((resolve) => {
    if (socket.latestState && predicate(socket.latestState)) return resolve(socket.latestState);
    const handler = (s) => {
      if (predicate(s)) {
        socket.off('state', handler);
        resolve(s);
      }
    };
    socket.on('state', handler);
  });
}

function waitForEvent(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

async function main() {
  console.log('end-to-end game over sockets');

  const a = connect(); // will be North (seat 0, host)
  const b = connect(); // will be East (seat 1)

  const created = await emitAck(a, 'create', {});
  assert.strictEqual(created.ok, true);
  assert.match(created.code, /^[A-HJ-NP-Z2-9]{6}$/, 'code uses the unambiguous alphabet');
  assert.strictEqual(created.seatName, 'north');
  console.log(`  ok - create -> code ${created.code}, seat north`);

  const badJoin = await emitAck(b, 'join', { code: 'ZZZZZZ' });
  assert.strictEqual(badJoin.ok, false);
  console.log('  ok - joining an unknown code is rejected');

  const joined = await emitAck(b, 'join', { code: created.code });
  assert.strictEqual(joined.ok, true);
  assert.strictEqual(joined.seatName, 'east');
  console.log('  ok - join -> seat east');

  const notHost = await emitAck(b, 'start');
  assert.strictEqual(notHost.ok, false);
  console.log('  ok - non-host cannot start');

  const started = await emitAck(a, 'start');
  assert.strictEqual(started.ok, true);
  const s0 = await waitForState(a, (s) => s.phase === 'active');
  assert.strictEqual(s0.turn, 'north', 'lowest seat moves first');
  assert.strictEqual(s0.you.seatName, 'north', 'state carries the recipient seat');
  assert.strictEqual(s0.board[0][0], 'void', 'voids serialized in the board');
  console.log('  ok - host start, north to move');

  // Server-side rejections, with no state change and an error event.
  const outOfTurn = await emitAck(b, 'move', { from: [5, 10], to: [5, 9] });
  assert.strictEqual(outOfTurn.ok, false);
  const errEvent = waitForEvent(a, 'error');
  const notYours = await emitAck(a, 'move', { from: [5, 10], to: [5, 9] });
  assert.strictEqual(notYours.ok, false);
  assert.strictEqual(typeof (await errEvent), 'string');
  const blocked = await emitAck(a, 'move', { from: [0, 2], to: [5, 2] });
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(a.latestState.turn, 'north', 'turn unchanged after rejections');
  console.log('  ok - illegal / out-of-turn moves rejected server-side');

  // Scripted game: East marches its queen to capture the North king.
  const script = [
    [a, [1, 2], [3, 2]],    // N pawn double push
    [b, [5, 10], [5, 8]],   // E pawn double push clears the queen's file
    [a, [3, 2], [4, 2]],
    [b, [5, 11], [5, 9]],   // E queen out
    [a, [4, 2], [5, 2]],
    [b, [5, 9], [1, 5]],    // E queen takes a north pawn on the diagonal
    [a, [5, 2], [6, 2]],
    [b, [1, 5], [0, 6]],    // E queen captures the North king
  ];
  for (const [socket, from, to] of script) {
    const res = await emitAck(socket, 'move', { from, to });
    assert.strictEqual(res.ok, true, `move ${JSON.stringify(from)}->${JSON.stringify(to)}: ${res.error || 'ok'}`);
  }

  const finalA = await waitForState(a, (s) => s.phase === 'over');
  const finalB = await waitForState(b, (s) => s.phase === 'over');
  assert.strictEqual(finalA.winner, 'east');
  assert.strictEqual(finalB.winner, 'east');
  assert.strictEqual(finalB.players.find((p) => p.seatName === 'north').eliminated, true);
  let northLeft = 0;
  for (const row of finalA.board) {
    for (const cell of row) {
      if (cell && cell !== 'void' && cell.color === 'north') northLeft++;
    }
  }
  assert.strictEqual(northLeft, 0, 'eliminated army removed from the broadcast board');
  console.log('  ok - king captured -> elimination, sweep, east wins, game over');

  // Reconnect: a new socket resumes the same seat with the playerId token.
  const a2 = connect();
  const resumed = await emitAck(a2, 'resume', { code: created.code, playerId: created.playerId });
  assert.strictEqual(resumed.ok, true);
  assert.strictEqual(resumed.seatName, 'north');
  const resumedState = await waitForState(a2, (s) => s.phase === 'over');
  assert.strictEqual(resumedState.you.seatName, 'north');
  console.log('  ok - resume with playerId restores the seat');

  a.close(); b.close(); a2.close();
  server.close();
  console.log(`\nall checks passed (${passed} unit + e2e flow)`);
  process.exit(0);
}

const guard = setTimeout(() => {
  console.error('TEST TIMEOUT after 20s');
  process.exit(1);
}, 20000);
guard.unref();

main().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
