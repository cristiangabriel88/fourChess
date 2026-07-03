# FourChess

A 4-player online chess variant on a 12×12 cross-shaped board. All four armies start in
staging arms **outside** the central 8×8 — the middle of the board begins completely empty.
Capture the last king standing to win.

- **Server**: Node.js + Express + Socket.io, fully authoritative (every move is validated
  server-side; the client is display-only).
- **Frontend**: plain HTML/CSS/vanilla JS, no build step. The rules engine (`game.js`) is
  shared verbatim between server and browser, so move highlights always match server legality.
- **Sessions**: in-memory, keyed by 6-character invite codes.

## Rules in brief

- 12×12 grid: an empty central 8×8, four 16-cell staging arms (one per player), and four
  unplayable 2×2 void corners that block movement — nothing may land on or slide through them.
- Each player has a standard 16-piece army in their arm: back rank `R N B Q K B N R` on the
  outer edge, pawns on the inner row facing the center.
- Standard piece movement across the whole playable area. Pawns move along their owner's
  forward axis (North ↓, East ←, South ↑, West →), may double-push from their start rank, and
  capture diagonally-forward. **No castling, no en passant, no check** — kings are captured
  like any other piece. A pawn reaching the opposite edge auto-promotes to a queen.
- Turns rotate clockwise **North → East → South → West**, skipping empty and eliminated seats.
  (Edge case: a seat with zero legal moves forfeits that turn so play can't stall.)
- When a king is captured, its owner is eliminated and **all of their pieces leave the board**.
  Last player with a king wins. Works with 2, 3, or 4 players.

## Run it

```sh
npm install
npm start          # http://localhost:3000/fourchess/
```

Open the URL in two or more browser tabs: create a game in one, join with the invite code in
the others, and start from the lobby (2–4 players).

Tests (engine unit checks + a full scripted game over real sockets):

```sh
npm test
```

## Environment variables

| Variable    | Default      | Meaning                                                    |
| ----------- | ------------ | ---------------------------------------------------------- |
| `PORT`      | `3000`       | HTTP port to listen on                                      |
| `BASE_PATH` | `/fourchess` | Subpath the app, its assets, and Socket.io are served under (set to `/` or empty to serve at the root) |

## Caveats

- **Game state is held in memory** — restarting the server ends all games and invalidates all
  invite codes. There is no database by design.
- Players who disconnect keep their seat and can rejoin (identity is a `playerId` token kept in
  the browser's storage); abandoned games are swept after ~2 hours of everyone being offline.
- Reloading a tab resumes its seat automatically (per-tab session), so multiple tabs in one
  browser can hold different seats. After a full browser restart, use **Resume last game** on
  the home screen to reclaim the most recent seat.

## Deploying at cristiangabriel.dev/fourchess

Run the server as a service, then reverse-proxy the subpath with WebSocket upgrade support.

### PM2

```sh
pm2 start server.js --name fourchess --env PORT=3000 --env BASE_PATH=/fourchess
pm2 save
```

### systemd (alternative)

```ini
# /etc/systemd/system/fourchess.service
[Unit]
Description=FourChess
After=network.target

[Service]
WorkingDirectory=/var/www/fourchess
ExecStart=/usr/bin/node server.js
Environment=PORT=3000
Environment=BASE_PATH=/fourchess
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

### nginx

```nginx
# inside the server { } block for cristiangabriel.dev
location /fourchess/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 86400;
}

# bare /fourchess (no slash) — the app itself also redirects, this just avoids a proxy hop
location = /fourchess {
    return 301 /fourchess/;
}
```

Everything (page, assets, `socket.io`) lives under `BASE_PATH`, so no other routes need
forwarding.

## Project layout

```
package.json
server.js          Express + Socket.io wiring, rooms, invite codes, reconnects
game.js            rules engine (board setup, legality, turns, elimination, win) — shared with the browser
public/index.html  single page: home / lobby / game + winner overlay
public/app.js      rendering, board rotation, move UX
public/style.css   dark theme, four seat accent colors
test/e2e.js        engine unit checks + scripted end-to-end game
```
"# fourChess" 
