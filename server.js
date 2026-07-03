'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const FourChess = require('./game');

FourChess.sanityCheck();

// --- Config ------------------------------------------------------------

const PORT = parseInt(process.env.PORT, 10) || 3000;

let BASE_PATH = process.env.BASE_PATH !== undefined ? process.env.BASE_PATH : '/fourchess';
BASE_PATH = BASE_PATH.trim();
if (BASE_PATH === '/' ) BASE_PATH = '';
if (BASE_PATH && !BASE_PATH.startsWith('/')) BASE_PATH = '/' + BASE_PATH;
BASE_PATH = BASE_PATH.replace(/\/+$/, '');

// --- HTTP + Socket.io --------------------------------------------------

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  path: `${BASE_PATH}/socket.io/`,
  serveClient: false,
});

// The socket.io browser client, served locally from node_modules (no CDN).
const socketIoClientDist = path.join(
  path.dirname(require.resolve('socket.io/package.json')),
  'client-dist'
);
app.use(`${BASE_PATH}/vendor`, express.static(socketIoClientDist));

// The rules engine is shared verbatim with the browser.
app.get(`${BASE_PATH}/game.js`, (req, res) => {
  res.sendFile(path.join(__dirname, 'game.js'));
});

app.use(BASE_PATH || '/', express.static(path.join(__dirname, 'public')));

// Bare /fourchess (no trailing slash) must redirect so the page's relative
// asset URLs resolve under the subpath.
if (BASE_PATH) {
  app.get(BASE_PATH, (req, res) => res.redirect(`${BASE_PATH}/`));
}

// --- Game sessions (in-memory; resets on restart) ----------------------

const games = new Map(); // code -> game record

// Unambiguous alphabet: no O, 0, I, 1.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    }
    if (!games.has(code)) return code;
  }
}

function seatName(seatIndex) {
  return FourChess.SEATS[seatIndex];
}

function findPlayer(game, playerId) {
  return game.players.find((p) => p.id === playerId) || null;
}

function viewFor(game, player) {
  const engine = game.engine;
  return {
    code: game.code,
    phase: game.phase,
    players: game.players.map((p) => ({
      seat: p.seat,
      seatName: seatName(p.seat),
      connected: p.connected,
      eliminated: engine ? !!engine.eliminated[seatName(p.seat)] : false,
      isHost: p.id === game.hostId,
    })),
    board: engine ? engine.board : null,
    turn: engine ? engine.turn : null,
    winner: engine ? engine.winner : null,
    captured: engine ? engine.captured : [],
    lastMove: engine ? engine.lastMove : null,
    you: player ? { seat: player.seat, seatName: seatName(player.seat), isHost: player.id === game.hostId } : null,
  };
}

// Full authoritative state to every connected socket in the room, each with
// its own seat attached.
async function broadcast(game) {
  let sockets;
  try {
    sockets = await io.in(game.code).fetchSockets();
  } catch (err) {
    return;
  }
  for (const s of sockets) {
    const player = findPlayer(game, s.data.playerId);
    s.emit('state', viewFor(game, player));
  }
}

function attach(socket, game, player) {
  socket.data.code = game.code;
  socket.data.playerId = player.id;
  player.connected = true;
  player.socketId = socket.id;
  game.lastActivity = Date.now();
  socket.join(game.code);
}

function currentGame(socket) {
  const game = games.get(socket.data.code);
  if (!game) return null;
  const player = findPlayer(game, socket.data.playerId);
  if (!player) return null;
  return { game, player };
}

io.on('connection', (socket) => {
  const ack = (cb) => (typeof cb === 'function' ? cb : () => {});

  socket.on('create', (payload, cb) => {
    cb = ack(typeof payload === 'function' ? payload : cb);
    try {
      const game = {
        code: generateCode(),
        phase: 'lobby',
        players: [],
        hostId: null,
        engine: null,
        lastActivity: Date.now(),
      };
      const player = { id: crypto.randomUUID(), seat: 0, connected: true, socketId: socket.id };
      game.players.push(player);
      game.hostId = player.id;
      games.set(game.code, game);
      attach(socket, game, player);
      cb({ ok: true, code: game.code, playerId: player.id, seat: player.seat, seatName: seatName(player.seat) });
      broadcast(game);
    } catch (err) {
      cb({ ok: false, error: 'Could not create the game.' });
    }
  });

  socket.on('join', (payload, cb) => {
    cb = ack(cb);
    try {
      const code = String((payload && payload.code) || '').trim().toUpperCase();
      const game = games.get(code);
      if (!game) return cb({ ok: false, error: 'No game found with that code.' });

      // Same identity rejoining counts as a resume, whatever the phase.
      const existing = payload && payload.playerId ? findPlayer(game, payload.playerId) : null;
      if (existing) {
        attach(socket, game, existing);
        cb({ ok: true, code: game.code, playerId: existing.id, seat: existing.seat, seatName: seatName(existing.seat) });
        return broadcast(game);
      }

      if (game.phase !== 'lobby') return cb({ ok: false, error: 'That game has already started.' });
      if (game.players.length >= 4) return cb({ ok: false, error: 'That game is full.' });

      const taken = new Set(game.players.map((p) => p.seat));
      let seat = 0;
      while (taken.has(seat)) seat++;
      const player = { id: crypto.randomUUID(), seat, connected: true, socketId: socket.id };
      game.players.push(player);
      attach(socket, game, player);
      cb({ ok: true, code: game.code, playerId: player.id, seat: player.seat, seatName: seatName(player.seat) });
      broadcast(game);
    } catch (err) {
      cb({ ok: false, error: 'Could not join the game.' });
    }
  });

  socket.on('resume', (payload, cb) => {
    cb = ack(cb);
    try {
      const code = String((payload && payload.code) || '').trim().toUpperCase();
      const game = games.get(code);
      const player = game ? findPlayer(game, payload && payload.playerId) : null;
      if (!game || !player) return cb({ ok: false, error: 'That game is no longer available.' });
      attach(socket, game, player);
      cb({ ok: true, code: game.code, playerId: player.id, seat: player.seat, seatName: seatName(player.seat) });
      broadcast(game);
    } catch (err) {
      cb({ ok: false, error: 'Could not resume the game.' });
    }
  });

  socket.on('start', (cb) => {
    cb = ack(cb);
    try {
      const ctx = currentGame(socket);
      if (!ctx) return cb({ ok: false, error: 'You are not in a game.' });
      const { game, player } = ctx;
      if (player.id !== game.hostId) return cb({ ok: false, error: 'Only the host can start the game.' });
      if (game.phase !== 'lobby') return cb({ ok: false, error: 'The game has already started.' });
      if (game.players.length < 2) return cb({ ok: false, error: 'You need at least 2 players to start.' });

      const seats = game.players
        .slice()
        .sort((a, b) => a.seat - b.seat)
        .map((p) => seatName(p.seat));
      game.engine = FourChess.createGame(seats);
      game.phase = 'active';
      game.lastActivity = Date.now();
      cb({ ok: true });
      broadcast(game);
    } catch (err) {
      cb({ ok: false, error: 'Could not start the game.' });
    }
  });

  socket.on('move', (payload, cb) => {
    cb = ack(cb);
    try {
      const ctx = currentGame(socket);
      if (!ctx) return cb({ ok: false, error: 'You are not in a game.' });
      const { game, player } = ctx;
      if (game.phase !== 'active' || !game.engine) {
        return cb({ ok: false, error: 'The game is not in progress.' });
      }

      const result = FourChess.applyMove(
        game.engine,
        seatName(player.seat),
        payload && payload.from,
        payload && payload.to
      );
      if (!result.ok) {
        socket.emit('error', result.error);
        return cb({ ok: false, error: result.error });
      }

      game.lastActivity = Date.now();
      if (game.engine.phase === 'over') game.phase = 'over';
      cb({ ok: true, events: result.events });
      broadcast(game);
    } catch (err) {
      cb({ ok: false, error: 'Could not apply the move.' });
    }
  });

  socket.on('disconnect', () => {
    try {
      const ctx = currentGame(socket);
      if (!ctx) return;
      const { game, player } = ctx;
      // Only flag disconnected if this socket is still the player's active
      // one (a reconnect may already have replaced it).
      if (player.socketId === socket.id) {
        player.connected = false;
        broadcast(game);
      }
    } catch (err) {
      // Never let a disconnect take the server down.
    }
  });
});

// Sweep abandoned games: everyone disconnected and no activity for 2 hours.
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [code, game] of games) {
    const allGone = game.players.every((p) => !p.connected);
    if (allGone && now - game.lastActivity > STALE_AFTER_MS) games.delete(code);
  }
}, SWEEP_INTERVAL_MS).unref();

server.listen(PORT, () => {
  console.log(`FourChess listening on http://localhost:${PORT}${BASE_PATH || '/'}`);
});

module.exports = { server, io, games };
