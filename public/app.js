/* FourChess client. The server is authoritative; this file only renders state
 * and computes move highlights locally (via the shared engine in game.js). */
(function () {
  'use strict';

  // Mount-point aware base path: works at /fourchess/, /, or anywhere else.
  const BASE = location.pathname.replace(/\/index\.html$/, '').replace(/\/+$/, '');

  // U+FE0E forces text presentation so CSS colors apply even where the
  // glyphs would default to emoji rendering.
  const GLYPH = { P: '♟︎', R: '♜︎', N: '♞︎', B: '♝︎', Q: '♛︎', K: '♚︎' };
  const SEAT_LABEL = { north: 'North', east: 'East', south: 'South', west: 'West' };
  const SEAT_COLOR_VAR = {
    north: 'var(--c-north)',
    east: 'var(--c-east)',
    south: 'var(--c-south)',
    west: 'var(--c-west)',
  };
  // Rotation that puts the local player's arm at the bottom of the screen.
  const SEAT_ROTATION = { south: '0deg', east: '90deg', north: '180deg', west: '270deg' };

  const $ = (id) => document.getElementById(id);
  const screens = {
    home: $('screen-home'),
    lobby: $('screen-lobby'),
    game: $('screen-game'),
  };

  // --- Session identity --------------------------------------------------
  // sessionStorage is per-tab so two tabs can hold two seats; localStorage
  // lets the most recent seat survive a full browser restart.

  const SESSION_KEY = 'fourchess-session';

  function parseSession(raw) {
    try {
      const s = raw ? JSON.parse(raw) : null;
      return s && s.code && s.playerId ? s : null;
    } catch (err) {
      return null;
    }
  }

  // Auto-resume only from the per-tab session, so a second tab in the same
  // browser lands on the home screen and can join as its own player.
  function loadTabSession() {
    try { return parseSession(sessionStorage.getItem(SESSION_KEY)); } catch (err) { return null; }
  }

  // The cross-restart copy backs the explicit "Resume last game" button.
  function loadSavedSession() {
    try { return parseSession(localStorage.getItem(SESSION_KEY)); } catch (err) { return null; }
  }

  function saveSession(session) {
    const raw = JSON.stringify(session);
    try { sessionStorage.setItem(SESSION_KEY, raw); } catch (err) { /* private mode */ }
    try { localStorage.setItem(SESSION_KEY, raw); } catch (err) { /* private mode */ }
  }

  // Detaches only this tab from the game; the cross-restart copy stays so
  // "Resume last game" can bring the player back.
  function clearTabSession() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch (err) { /* ignore */ }
  }

  function clearSession() {
    clearTabSession();
    try { localStorage.removeItem(SESSION_KEY); } catch (err) { /* ignore */ }
  }

  // --- State ----------------------------------------------------------------

  let S = null;            // latest server state
  let mySeat = null;       // my seat name, e.g. 'north'
  let selected = null;     // [r, c] of selected own piece
  let legalTargets = [];   // destinations for the selection

  const socket = io({ path: BASE + '/socket.io/' });

  // --- Small UI helpers ---------------------------------------------------

  let toastTimer = null;
  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
  }

  function copyText(text, button) {
    const done = () => {
      const prev = button.textContent;
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = prev; }, 1300);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (err) { toast('Copy failed — select the code manually.'); }
    document.body.removeChild(ta);
  }

  function showScreen(name) {
    for (const key of Object.keys(screens)) {
      screens[key].classList.toggle('hidden', key !== name);
    }
  }

  // --- Board DOM (built once) ------------------------------------------------

  const boardEl = $('board');
  const cells = []; // cells[r][c] -> element

  function armOf(r, c) {
    if (r <= 1) return 'north';
    if (r >= 10) return 'south';
    if (c <= 1) return 'west';
    if (c >= 10) return 'east';
    return null;
  }

  function buildBoard() {
    for (let r = 0; r < 12; r++) {
      cells.push([]);
      for (let c = 0; c < 12; c++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        if (FourChess.isVoid(r, c)) {
          cell.classList.add('void');
        } else {
          cell.classList.add((r + c) % 2 === 0 ? 'c-light' : 'c-dark');
          const arm = armOf(r, c);
          if (arm) cell.classList.add('arm-' + arm);
          cell.dataset.r = r;
          cell.dataset.c = c;
          cell.addEventListener('click', () => onCellClick(r, c));
        }
        boardEl.appendChild(cell);
        cells[r].push(cell);
      }
    }
  }

  function clearSelection() {
    selected = null;
    legalTargets = [];
  }

  function onCellClick(r, c) {
    if (!S || S.phase !== 'active' || !mySeat) return;
    if (S.turn !== mySeat) return; // not your turn — ignore

    if (selected && legalTargets.some(([tr, tc]) => tr === r && tc === c)) {
      const from = selected;
      clearSelection();
      renderBoard();
      socket.emit('move', { from, to: [r, c] }, (res) => {
        if (res && !res.ok && res.error) toast(res.error);
      });
      return;
    }

    const piece = S.board && S.board[r][c];
    if (piece && piece !== 'void' && piece.color === mySeat
        && !(selected && selected[0] === r && selected[1] === c)) {
      selected = [r, c];
      legalTargets = FourChess.legalMovesFrom(S.board, r, c);
    } else {
      clearSelection();
    }
    renderBoard();
  }

  function renderBoard() {
    if (!S || !S.board) return;

    boardEl.style.setProperty('--rot', SEAT_ROTATION[mySeat] || '0deg');

    const last = S.lastMove;
    const myTurn = S.phase === 'active' && S.turn === mySeat;

    for (let r = 0; r < 12; r++) {
      for (let c = 0; c < 12; c++) {
        const cell = cells[r][c];
        if (cell.classList.contains('void')) continue;

        const val = S.board[r][c];
        cell.classList.remove('sel', 'move', 'capture', 'last', 'own-turn');

        if (val && val !== 'void') {
          let span = cell.firstChild;
          if (!span) {
            span = document.createElement('span');
            cell.appendChild(span);
          }
          span.className = 'piece p-' + val.color;
          span.textContent = GLYPH[val.type];
          if (myTurn && val.color === mySeat) cell.classList.add('own-turn');
        } else if (cell.firstChild) {
          cell.removeChild(cell.firstChild);
        }

        if (last && ((last.from[0] === r && last.from[1] === c) || (last.to[0] === r && last.to[1] === c))) {
          cell.classList.add('last');
        }
      }
    }

    if (selected) {
      cells[selected[0]][selected[1]].classList.add('sel');
      for (const [tr, tc] of legalTargets) {
        const occupied = S.board[tr][tc] && S.board[tr][tc] !== 'void';
        cells[tr][tc].classList.add(occupied ? 'capture' : 'move');
      }
    }
  }

  // --- Lobby / HUD rendering -----------------------------------------------------

  function seatCardHTML(seatName, player) {
    if (!player) {
      return `<li class="seat-card empty" style="--seat-color: ${SEAT_COLOR_VAR[seatName]}">
        <span class="seat-name">${SEAT_LABEL[seatName]}</span>
        <span class="seat-sub">Open seat</span></li>`;
    }
    const badges = [];
    if (player.seatName === mySeat) badges.push('<span class="badge you">You</span>');
    if (player.isHost) badges.push('<span class="badge">Host</span>');
    if (!player.connected) badges.push('<span class="badge off">Offline</span>');
    return `<li class="seat-card" style="--seat-color: ${SEAT_COLOR_VAR[seatName]}">
      <span class="seat-name">${SEAT_LABEL[seatName]}</span>
      <span class="seat-sub">${player.connected ? 'Ready' : 'Disconnected'} ${badges.join(' ')}</span></li>`;
  }

  function renderLobby() {
    $('lobby-code').textContent = S.code;
    const bySeat = {};
    for (const p of S.players) bySeat[p.seatName] = p;

    $('lobby-seats').innerHTML = FourChess.SEATS
      .map((seat) => seatCardHTML(seat, bySeat[seat]))
      .join('');

    const iAmHost = !!(S.you && S.you.isHost);
    const enough = S.players.length >= 2;
    const startBtn = $('btn-start');
    startBtn.classList.toggle('hidden', !iAmHost);
    startBtn.disabled = !enough;

    const hint = $('lobby-hint');
    if (!enough) hint.textContent = 'Waiting for players… 2–4 can play.';
    else if (iAmHost) hint.textContent = `${S.players.length} of 4 seats filled. Start when ready.`;
    else hint.textContent = 'Waiting for the host to start…';
  }

  function renderHUD() {
    const banner = $('turn-banner');
    banner.classList.remove('mine');
    if (S.phase === 'active' && S.turn) {
      const color = SEAT_COLOR_VAR[S.turn];
      banner.style.setProperty('--turn-color', color);
      if (S.turn === mySeat) {
        banner.textContent = 'Your turn';
        banner.classList.add('mine');
      } else {
        banner.textContent = `${SEAT_LABEL[S.turn]} to move`;
      }
    } else {
      banner.style.setProperty('--turn-color', 'var(--ink-dim)');
      banner.textContent = 'Game over';
    }

    $('player-list').innerHTML = S.players.map((p) => {
      const rowClasses = ['player-row'];
      if (S.phase === 'active' && S.turn === p.seatName) rowClasses.push('turn');
      if (p.eliminated) rowClasses.push('out');
      const badges = [];
      if (p.seatName === mySeat) badges.push('<span class="badge you">You</span>');
      if (p.eliminated) badges.push('<span class="badge out">Out</span>');
      else if (!p.connected) badges.push('<span class="badge off">Offline</span>');
      return `<li class="${rowClasses.join(' ')}" style="--seat-color: ${SEAT_COLOR_VAR[p.seatName]}">
        <span class="dot"></span>
        <span class="pname">${SEAT_LABEL[p.seatName]}</span>
        ${badges.join(' ')}</li>`;
    }).join('');

    const tray = $('captured-tray');
    if (S.captured && S.captured.length) {
      tray.innerHTML = S.captured
        .map((p) => `<span class="piece p-${p.color}">${GLYPH[p.type]}</span>`)
        .join('');
    } else {
      tray.innerHTML = '<span class="tray-empty">No captures yet</span>';
    }

    $('game-code').textContent = S.code;
  }

  function renderOverlay() {
    const overlay = $('overlay');
    if (S.phase !== 'over') {
      overlay.classList.add('hidden');
      return;
    }
    const card = overlay.querySelector('.overlay-card');
    const title = $('overlay-title');
    const sub = $('overlay-sub');
    if (S.winner) {
      const color = SEAT_COLOR_VAR[S.winner];
      card.style.setProperty('--win-color', color);
      if (S.winner === mySeat) {
        title.textContent = 'You win!';
        sub.textContent = 'Your king is the last one standing.';
      } else {
        title.textContent = `${SEAT_LABEL[S.winner]} wins`;
        sub.textContent = `The ${SEAT_LABEL[S.winner]} king is the last one standing.`;
      }
    } else {
      card.style.setProperty('--win-color', 'var(--ink-dim)');
      title.textContent = 'Draw';
      sub.textContent = 'No player can move.';
    }
    overlay.classList.remove('hidden');
  }

  function render() {
    if (!S) {
      showScreen('home');
      $('btn-resume').classList.toggle('hidden', !loadSavedSession());
      return;
    }
    mySeat = S.you ? S.you.seatName : null;
    if (S.phase === 'lobby') {
      showScreen('lobby');
      renderLobby();
    } else {
      showScreen('game');
      renderBoard();
      renderHUD();
    }
    renderOverlay();
  }

  // --- Socket wiring --------------------------------------------------------------

  function setConn(state) {
    const el = $('conn-status');
    el.dataset.state = state;
    el.textContent = state === 'connected' ? 'online' : state === 'connecting' ? 'connecting…' : 'reconnecting…';
  }

  function attemptResume(session) {
    socket.emit('resume', session, (res) => {
      if (res && res.ok) {
        saveSession({ code: res.code, playerId: res.playerId });
      } else {
        clearSession();
        S = null;
        render();
        if (res && res.error) toast(res.error);
      }
    });
  }

  socket.on('connect', () => {
    setConn('connected');
    const session = loadTabSession();
    if (session) attemptResume(session);
    else render(); // refresh the home screen's resume affordance
  });

  socket.on('disconnect', () => setConn('disconnected'));

  socket.on('state', (state) => {
    S = state;
    // Drop a stale selection (e.g. the piece moved or was captured).
    if (selected) {
      const p = S.board && S.board[selected[0]][selected[1]];
      if (!p || p === 'void' || p.color !== mySeat || S.turn !== (S.you && S.you.seatName)) {
        clearSelection();
      }
    }
    render();
  });

  socket.on('error', (message) => {
    if (typeof message === 'string') toast(message);
  });

  // --- Controls ----------------------------------------------------------------

  $('btn-create').addEventListener('click', () => {
    socket.emit('create', {}, (res) => {
      if (res && res.ok) saveSession({ code: res.code, playerId: res.playerId });
      else toast((res && res.error) || 'Could not create the game.');
    });
  });

  $('join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('join-code').value.trim().toUpperCase();
    if (code.length !== 6) return toast('Invite codes are 6 characters.');
    socket.emit('join', { code }, (res) => {
      if (res && res.ok) saveSession({ code: res.code, playerId: res.playerId });
      else toast((res && res.error) || 'Could not join the game.');
    });
  });

  $('join-code').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z2-9]/g, '');
  });

  $('btn-start').addEventListener('click', () => {
    socket.emit('start', (res) => {
      if (res && !res.ok) toast(res.error || 'Could not start the game.');
    });
  });

  $('btn-resume').addEventListener('click', () => {
    const session = loadSavedSession();
    if (session) attemptResume(session);
  });

  $('btn-copy-lobby').addEventListener('click', (e) => copyText(S ? S.code : '', e.target));
  $('btn-copy-game').addEventListener('click', (e) => copyText(S ? S.code : '', e.target));

  $('btn-new-game').addEventListener('click', () => {
    clearSession();
    location.reload();
  });

  // --- Exit game (with confirmation) -------------------------------------

  const exitConfirm = $('exit-confirm');

  $('btn-exit').addEventListener('click', () => exitConfirm.classList.remove('hidden'));
  $('btn-exit-cancel').addEventListener('click', () => exitConfirm.classList.add('hidden'));
  exitConfirm.addEventListener('click', (e) => {
    if (e.target === exitConfirm) exitConfirm.classList.add('hidden');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') exitConfirm.classList.add('hidden');
  });

  $('btn-exit-confirm').addEventListener('click', () => {
    clearTabSession();
    location.reload();
  });

  buildBoard();
  render();
})();
