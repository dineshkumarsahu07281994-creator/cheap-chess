// Serverless random matchmaking over the free public PeerJS broker.
//
// Everyone races to claim one well-known peer ID, the "lobby slot". The broker hands out
// each ID to only one client at a time, so exactly one waiting player holds the slot. The
// next player fails to claim it ("unavailable-id") and connects to the holder instead.
// Once paired, both players drop their broker connection: the WebRTC data channel between
// them stays up, and the slot is free again for the next pair.

export const PROTOCOL_VERSION = 1;

const HANDSHAKE_MS = 10_000;
const MAX_FAILED_ATTEMPTS = 15;

// Set window.CHEAPCHESS_PEER_SERVER = { host, port, path, secure } to use your own broker.
const PEER_OPTIONS = { debug: 0, ...(window.CHEAPCHESS_PEER_SERVER || {}) };

export function lobbyId() {
  // ?lobby=xyz gives a separate queue, e.g. for testing or for a club playing among itself.
  const requested = new URLSearchParams(location.search).get('lobby') || window.CHEAPCHESS_LOBBY || 'main';
  const room = String(requested).replace(/[^a-z0-9]/gi, '').slice(0, 32) || 'main';
  return `cheapchess-v${PROTOCOL_VERSION}-${room.toLowerCase()}`;
}

/**
 * Resolves with { peer, conn, color, opponentName } once paired. `color` is this player's
 * colour ('w' or 'b'). The caller owns `peer` and `conn` afterwards and must destroy them.
 */
export function findOpponent({ name, onStatus = () => {}, signal }) {
  return new Promise((resolve, reject) => {
    const Peer = window.Peer;
    if (!Peer) {
      reject(new Error('Could not load the networking library. Check your connection and reload.'));
      return;
    }

    let peer = null;
    let settled = false;
    let failures = 0;
    const timers = new Set();

    const later = (fn, ms) => {
      const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
      timers.add(id);
      return id;
    };
    const cancelTimer = (id) => { clearTimeout(id); timers.delete(id); };
    const dropPeer = () => {
      // Clear the reference first: destroy() fires 'disconnected'/'close' synchronously, and
      // the handlers ignore events from any peer that is no longer the current one.
      const old = peer;
      peer = null;
      if (old && !old.destroyed) old.destroy();
    };

    const succeed = (result) => {
      settled = true;
      timers.forEach(clearTimeout);
      timers.clear();
      result.peer.disconnect(); // leave the broker; the data channel survives
      resolve(result);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      timers.clear();
      dropPeer();
      reject(err);
    };
    const retry = (counts = true) => {
      if (settled) return;
      dropPeer();
      if (counts && ++failures > MAX_FAILED_ATTEMPTS) {
        fail(new Error('Could not reach the matchmaking service. Check your connection and try again.'));
        return;
      }
      later(tryHost, 300 + Math.random() * 900);
    };

    signal?.addEventListener('abort', () => fail(new DOMException('Cancelled', 'AbortError')));

    function tryHost() {
      if (settled) return;
      onStatus('Looking for an opponent…');
      const me = (peer = new Peer(lobbyId(), PEER_OPTIONS));
      let busy = false; // a guest is mid-handshake

      me.on('open', () => onStatus('Waiting for an opponent…'));

      me.on('connection', (conn) => {
        if (settled || busy) {
          conn.on('open', () => {
            conn.send({ t: 'busy' });
            setTimeout(() => conn.close(), 500);
          });
          return;
        }
        busy = true;
        const release = () => {
          busy = false;
          conn.removeAllListeners();
          conn.close();
        };
        const timeout = later(release, HANDSHAKE_MS);

        conn.on('data', (msg) => {
          if (!msg || msg.t !== 'hello' || settled) return;
          cancelTimer(timeout);
          if (msg.v !== PROTOCOL_VERSION) {
            conn.send({ t: 'busy' });
            release();
            return;
          }
          const color = Math.random() < 0.5 ? 'w' : 'b';
          conn.send({ t: 'start', v: PROTOCOL_VERSION, name, color: color === 'w' ? 'b' : 'w' });
          conn.removeAllListeners();
          succeed({ peer: me, conn, color, opponentName: msg.name });
        });
        conn.on('close', () => { if (!settled) { cancelTimer(timeout); busy = false; } });
        conn.on('error', () => { if (!settled) { cancelTimer(timeout); release(); } });
      });

      me.on('disconnected', () => { if (!settled && me === peer) retry(); });
      me.on('error', (err) => {
        if (settled || me !== peer) return;
        if (err.type === 'unavailable-id') {
          // Someone is already waiting: go and play them.
          dropPeer();
          tryJoin();
        } else {
          retry();
        }
      });
    }

    function tryJoin() {
      if (settled) return;
      onStatus('Opponent found, connecting…');
      const me = (peer = new Peer(PEER_OPTIONS));
      let timeout = null;

      me.on('open', () => {
        const conn = me.connect(lobbyId(), { reliable: true, serialization: 'json' });
        timeout = later(() => retry(false), HANDSHAKE_MS);

        conn.on('open', () => conn.send({ t: 'hello', v: PROTOCOL_VERSION, name }));
        conn.on('data', (msg) => {
          if (!msg || settled || me !== peer) return;
          if (msg.t === 'busy') {
            cancelTimer(timeout);
            retry(false); // the waiting player was just paired with someone else
          } else if (msg.t === 'start' && msg.v === PROTOCOL_VERSION && (msg.color === 'w' || msg.color === 'b')) {
            cancelTimer(timeout);
            conn.removeAllListeners();
            succeed({ peer: me, conn, color: msg.color, opponentName: msg.name });
          }
        });
        conn.on('close', () => { if (!settled && me === peer) { cancelTimer(timeout); retry(false); } });
      });

      me.on('error', (err) => {
        if (settled || me !== peer) return;
        if (timeout) cancelTimer(timeout);
        // 'peer-unavailable': the waiting player left or was paired, so try to take the slot.
        retry(err.type !== 'peer-unavailable');
      });
    }

    tryHost();
  });
}
