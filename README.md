# CheapChess

Online chess against a random opponent that costs nothing to run. The whole site is a handful
of static files: host them anywhere free and there is no server, database, or bill.

Play: <https://dineshkumarsahu07281994-creator.github.io/cheap-chess/>

## How it works

| Piece | What does it | Cost |
|---|---|---|
| Hosting | Any static host (GitHub Pages, Netlify, Cloudflare Pages) | Free |
| Matchmaking | The public PeerJS broker at `0.peerjs.com` (see `js/net.js` for the lobby-slot trick) | Free |
| Moves, clocks, resign/draw/rematch | A WebRTC data channel straight between the two browsers | Free |
| Chess rules | [chess.js](https://github.com/jhlywa/chess.js) 1.4.0, run by both players | Free |

Both browsers run the full rules, so each one checks every move the other sends. An illegal or
out-of-turn move ends the game as a win for the honest side.

Diagrams of the system, matchmaking, how moves are checked, the game states and the code layout
are in [docs/architecture.md](docs/architecture.md).

Features: 10-minute clocks, a 30-second first-move abort, legal-move dots, promotion picker, check and
last-move highlights, draw offers, two-click resign, rematch with colours swapped, abandonment
detection, and a "Your move" tab title when the page is in the background.

## Run it locally

ES modules don't load from `file://`, so serve the folder:

```sh
cd cheap-chess
python3 -m http.server 8000
```

Open <http://localhost:8000> in two browser windows (or two different browsers) and click **Play** in
each. To keep test games away from real players, add `?lobby=test` to both URLs.

## Deploy for free

GitHub Pages: push the folder to a repo, then **Settings → Pages → Deploy from a branch → main / root**.
The site is live at `https://<you>.github.io/<repo>/` within a minute.

Netlify: drag the folder onto <https://app.netlify.com/drop>.

## Configuration

| Setting | Where |
|---|---|
| Time control, first-move limit, lag allowance | constants at the top of `js/app.js` |
| Separate queue for a club or classroom | `?lobby=<name>` in the URL |
| TURN relay for strict networks | `CHEAPCHESS_TURN_CREDENTIALS_URL` in `config.js` |
| Own PeerJS broker | set `window.CHEAPCHESS_PEER_SERVER = { host, port, path, secure }` before `js/app.js` loads |

## Limitations of a server-free design

- The public broker is shared and best-effort. Anyone can claim the lobby ID `cheapchess-v1-main`; if
  that becomes a problem, pick a different lobby name or run [PeerServer](https://github.com/peers/peerjs-server)
  on a free tier.
- Players on strict networks (many mobile carriers, offices) need a TURN relay to connect. PeerJS
  [no longer runs its free TURN servers](https://github.com/orgs/peers/discussions/1172), so add your
  own in `config.js` (Metered's free tier gives 20 GB/month).
- Each player's browser is the referee, so engine use can't be detected and a modified client could
  misreport its own clock (capped at a 3-second lag allowance).
- No accounts, ratings, or saved games.

## Next steps, roughly by cost

1. Play-a-friend links (`?game=<id>`): reuse `findOpponent` with a per-game lobby ID.
2. Sounds, drag-and-drop, and a time-control picker.
3. A small PeerServer on a free tier to stop depending on the shared broker.
4. A real server (accounts, Elo, anti-cheat), the point where hosting stops being free.
