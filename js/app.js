import { Chess } from 'https://cdn.jsdelivr.net/npm/chess.js@1.4.0/+esm';
import { findOpponent } from './net.js';
import { Board, colorWord } from './board.js';

// There is no server to referee the game, so each browser runs the full rules itself and
// checks every move the opponent sends. An illegal or out-of-turn move ends the game.

const START_MS = 10 * 60 * 1000;      // 10 minutes per side
const FIRST_MOVE_MS = 30 * 1000;      // abort if a side doesn't make its first move in time
const CLOCK_GRACE_MS = 3000;          // allowance for network lag when judging the opponent's clock
const PING_EVERY_MS = 4000;
const OPPONENT_TIMEOUT_MS = 20000;
const NAME_KEY = 'cheapchess-name';
const TITLE = document.title;

const $ = (id) => document.getElementById(id);
const el = {
  name: $('name'), play: $('play'), lobbyError: $('lobby-error'),
  searchStatus: $('search-status'), searchTime: $('search-time'), cancel: $('cancel'),
  oppName: $('opp-name'), oppDot: $('opp-dot'), oppClock: $('opp-clock'),
  meName: $('me-name'), meDot: $('me-dot'), meClock: $('me-clock'),
  status: $('status'), moves: $('moves'),
  offer: $('offer'), offerText: $('offer-text'), offerYes: $('offer-yes'), offerNo: $('offer-no'),
  draw: $('draw'), resign: $('resign'), rematch: $('rematch'), newOpp: $('new-opp'),
};

const board = new Board($('board'), { onMove: playMyMove });
let search = null; // AbortController while matchmaking
let g = null;      // the current match

// ---------------------------------------------------------------- lobby & matchmaking

el.name.value = localStorage.getItem(NAME_KEY) || `Guest${Math.floor(1000 + Math.random() * 9000)}`;
el.play.addEventListener('click', startSearch);
el.newOpp.addEventListener('click', startSearch);
el.cancel.addEventListener('click', () => search?.abort());

function show(screen) {
  for (const id of ['lobby', 'searching', 'game']) $(id).hidden = id !== screen;
}

async function startSearch() {
  if (search) return; // already looking; a second search would grab a second lobby slot
  leaveMatch();
  const name = cleanName(el.name.value, 'Guest');
  el.name.value = name;
  localStorage.setItem(NAME_KEY, name);
  el.lobbyError.hidden = true;
  show('searching');

  const started = Date.now();
  el.searchTime.textContent = '';
  const ticker = setInterval(() => {
    el.searchTime.textContent = `${Math.floor((Date.now() - started) / 1000)}s`;
  }, 1000);
  search = new AbortController();
  try {
    const match = await findOpponent({
      name,
      signal: search.signal,
      onStatus: (text) => { el.searchStatus.textContent = text; },
    });
    startMatch({ ...match, myName: name });
  } catch (err) {
    show('lobby');
    if (err.name !== 'AbortError') {
      el.lobbyError.textContent = err.message;
      el.lobbyError.hidden = false;
    }
  } finally {
    clearInterval(ticker);
    search = null;
  }
}

function startMatch({ peer, conn, color, opponentName, myName }) {
  g = {
    peer, conn, myName,
    myColor: color,
    oppName: cleanName(opponentName, 'Opponent'),
    connected: true,
    lastSeen: Date.now(),
  };
  conn.on('data', onMessage);
  conn.on('close', () => opponentGone('left'));
  conn.on('error', () => opponentGone('lost connection'));
  g.pinger = setInterval(heartbeat, PING_EVERY_MS);
  g.ticker = setInterval(tick, 200);
  newGame();
  show('game');
}

function newGame() {
  Object.assign(g, {
    chess: new Chess(),
    clocks: { w: START_MS, b: START_MS },
    turnStart: performance.now(),
    over: false,
    result: null,
    lastMove: null,
    drawOffer: null,      // 'me' | 'opp' | null
    drawOfferPly: -1,     // one offer per move
    rematch: { me: false, opp: false },
  });
  resetResign();
  render();
}

function leaveMatch() {
  if (!g) return;
  clearInterval(g.pinger);
  clearInterval(g.ticker);
  g.connected = false;
  g.conn.removeAllListeners();
  g.conn.close();
  g.peer.destroy();
  g = null;
  document.title = TITLE;
}

window.addEventListener('pagehide', leaveMatch);

// ---------------------------------------------------------------- moves & clocks

function plies() {
  return g.chess.history().length;
}

// Clocks only start once each side has made its first move (the abort timer covers that).
function clockRunning() {
  return !g.over && plies() >= 2;
}

function timeLeft(color) {
  const stored = g.clocks[color];
  return clockRunning() && g.chess.turn() === color ? stored - (performance.now() - g.turnStart) : stored;
}

function playMyMove(from, to, promotion) {
  if (!g || g.over || !g.connected || g.chess.turn() !== g.myColor) return;
  const now = performance.now();
  const left = timeLeft(g.myColor);
  if (left <= 0) return; // the ticker is about to call the flag

  let move;
  try {
    move = g.chess.move({ from, to, promotion });
  } catch {
    render();
    return;
  }
  g.clocks[g.myColor] = left;
  g.turnStart = now;
  if (g.drawOffer === 'opp') g.drawOffer = null; // moving declines a pending offer
  send({ t: 'move', from: move.from, to: move.to, promotion: move.promotion, ply: plies(), clock: Math.round(left) });
  afterMove(move);
}

function onOpponentMove(msg) {
  if (g.over) return;
  const mover = g.chess.turn();
  if (mover === g.myColor || msg.ply !== plies() + 1) return cheated('moved out of turn');

  const ticking = clockRunning();
  const localEstimate = timeLeft(mover);
  let move;
  try {
    move = g.chess.move({
      from: String(msg.from),
      to: String(msg.to),
      promotion: msg.promotion ? String(msg.promotion) : undefined,
    });
  } catch {
    return cheated('sent an illegal move');
  }

  if (ticking) {
    // Trust the opponent's own clock reading, but never more than our estimate plus lag.
    const ceiling = Math.min(g.clocks[mover], localEstimate + CLOCK_GRACE_MS);
    const reported = Number(msg.clock);
    g.clocks[mover] = Math.max(0, Number.isFinite(reported) ? Math.min(reported, ceiling) : localEstimate);
  }
  g.turnStart = performance.now();
  if (g.drawOffer === 'me') g.drawOffer = null;
  afterMove(move);
}

function afterMove(move) {
  g.lastMove = { from: move.from, to: move.to };
  const c = g.chess;
  if (c.isCheckmate()) endGame(move.color, 'by checkmate');
  else if (c.isStalemate()) endGame(null, 'by stalemate');
  else if (c.isInsufficientMaterial()) endGame(null, 'by insufficient material');
  else if (c.isThreefoldRepetition()) endGame(null, 'by threefold repetition');
  else if (c.isDraw()) endGame(null, 'by the 50-move rule');
  render();
  if (!g.over && c.turn() === g.myColor && document.hidden) document.title = '● Your move · CheapChess';
}

function tick() {
  if (!g || g.over) return;
  const turn = g.chess.turn();
  const mine = turn === g.myColor;

  if (plies() < 2) {
    const waited = performance.now() - g.turnStart;
    if (waited > FIRST_MOVE_MS + (mine ? 0 : CLOCK_GRACE_MS)) {
      send({ t: 'abort' });
      endGame(null, `${mine ? 'you' : g.oppName} didn't make a first move`, { aborted: true });
    }
    renderClocks();
    return;
  }

  if (timeLeft(turn) <= (mine ? 0 : -CLOCK_GRACE_MS)) {
    send({ t: 'timeout', loser: turn });
    g.clocks[turn] = 0;
    endGame(other(turn), `on time`);
    return;
  }
  renderClocks();
}

function endGame(winner, reason, { aborted = false, gone = false } = {}) {
  if (g.over) return;
  const turn = g.chess.turn();
  g.clocks[turn] = Math.max(0, timeLeft(turn)); // freeze the running clock
  g.over = true;
  g.drawOffer = null;
  g.result = { winner, reason, aborted, gone };
  document.title = TITLE;
  render();
}

// ---------------------------------------------------------------- messages

function send(msg) {
  if (g?.connected && g.conn.open) g.conn.send(msg);
}

function onMessage(msg) {
  if (!g || !msg || typeof msg.t !== 'string') return;
  g.lastSeen = Date.now();
  switch (msg.t) {
    case 'ping':
      return;
    case 'move':
      return onOpponentMove(msg);
    case 'resign':
      if (!g.over) endGame(g.myColor, `${g.oppName} resigned`);
      return;
    case 'draw-offer':
      if (!g.over && g.chess.turn() !== g.myColor) { g.drawOffer = 'opp'; render(); }
      return;
    case 'draw-accept':
      if (!g.over && g.drawOffer === 'me') endGame(null, 'by agreement');
      return;
    case 'draw-decline':
      if (!g.over && g.drawOffer === 'me') { g.drawOffer = null; render(); }
      return;
    case 'timeout':
      if (g.over || (msg.loser !== 'w' && msg.loser !== 'b')) return;
      // Only believe "you flagged" if our own clock agrees, give or take network lag.
      if (msg.loser === g.myColor && timeLeft(g.myColor) > CLOCK_GRACE_MS) return;
      g.clocks[msg.loser] = 0;
      endGame(other(msg.loser), 'on time');
      return;
    case 'abort':
      if (!g.over && plies() < 2) endGame(null, 'no first move', { aborted: true });
      return;
    case 'rematch':
      if (g.over) { g.rematch.opp = true; maybeRematch(); }
      return;
    case 'invalid':
      if (!g.over) endGame(null, 'the game got out of sync', { aborted: true });
      closeConnection();
      return;
    default:
      return;
  }
}

function cheated(what) {
  send({ t: 'invalid' });
  endGame(g.myColor, `${g.oppName} ${what}`);
  closeConnection();
}

function heartbeat() {
  if (!g?.connected) return;
  send({ t: 'ping' });
  if (Date.now() - g.lastSeen > OPPONENT_TIMEOUT_MS) opponentGone('stopped responding');
}

function opponentGone(how) {
  if (!g?.connected) return;
  closeConnection();
  if (!g.over) {
    if (plies() < 2) endGame(null, `${g.oppName} ${how}`, { aborted: true, gone: true });
    else endGame(g.myColor, `${g.oppName} ${how}`, { gone: true });
  }
  render();
}

function closeConnection() {
  if (!g?.connected) return;
  g.connected = false;
  clearInterval(g.pinger);
  const { conn } = g;
  conn.removeAllListeners();
  setTimeout(() => conn.close(), 1000); // let a last message (e.g. 'invalid') get through first
}

// ---------------------------------------------------------------- buttons

let resignArmed = null;
el.resign.addEventListener('click', () => {
  if (!g || g.over) return;
  if (!resignArmed) {
    el.resign.textContent = 'Confirm resign';
    el.resign.classList.add('danger');
    resignArmed = setTimeout(resetResign, 3000);
    return;
  }
  resetResign();
  send({ t: 'resign' });
  endGame(other(g.myColor), 'you resigned');
});

function resetResign() {
  clearTimeout(resignArmed);
  resignArmed = null;
  el.resign.textContent = 'Resign';
  el.resign.classList.remove('danger');
}

el.draw.addEventListener('click', () => {
  if (!g || g.over || g.drawOffer || g.drawOfferPly === plies()) return;
  if (g.chess.turn() !== g.myColor) return; // offer on your own move, like over the board
  g.drawOffer = 'me';
  g.drawOfferPly = plies();
  send({ t: 'draw-offer' });
  render();
});

el.offerYes.addEventListener('click', () => {
  if (!g || g.over || g.drawOffer !== 'opp') return;
  send({ t: 'draw-accept' });
  endGame(null, 'by agreement');
});

el.offerNo.addEventListener('click', () => {
  if (!g || g.drawOffer !== 'opp') return;
  g.drawOffer = null;
  send({ t: 'draw-decline' });
  render();
});

el.rematch.addEventListener('click', () => {
  if (!g?.over || !g.connected || g.rematch.me) return;
  g.rematch.me = true;
  send({ t: 'rematch' });
  maybeRematch();
});

function maybeRematch() {
  if (g.rematch.me && g.rematch.opp) {
    g.myColor = other(g.myColor);
    newGame();
  } else {
    render();
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) document.title = TITLE;
});

// ---------------------------------------------------------------- rendering

function render() {
  if (!g) return;
  const myTurn = !g.over && g.connected && g.chess.turn() === g.myColor;
  board.render({ chess: g.chess, myColor: g.myColor, interactive: myTurn, lastMove: g.lastMove });

  el.meName.textContent = `${g.myName} (you)`;
  el.oppName.textContent = g.oppName;
  el.meDot.className = `dot ${g.myColor}`;
  el.oppDot.className = `dot ${other(g.myColor)}`;
  el.meDot.title = colorWord(g.myColor);
  el.oppDot.title = colorWord(other(g.myColor));
  renderClocks();

  el.status.textContent = statusText(myTurn);
  el.status.className = `status${g.over ? ' final' : ''}`;

  const offerVisible = !g.over && g.drawOffer === 'opp';
  el.offer.hidden = !offerVisible;
  if (offerVisible) el.offerText.textContent = `${g.oppName} offers a draw.`;

  renderMoves();

  el.draw.hidden = el.resign.hidden = g.over;
  el.draw.disabled = !myTurn || Boolean(g.drawOffer) || g.drawOfferPly === plies();
  el.draw.textContent = g.drawOffer === 'me' ? 'Draw offered' : 'Offer draw';
  el.rematch.hidden = !g.over || !g.connected;
  el.rematch.disabled = g.rematch.me;
  el.rematch.textContent = g.rematch.me ? 'Waiting for opponent…' : g.rematch.opp ? 'Accept rematch' : 'Rematch';
  el.newOpp.hidden = !g.over;
}

function statusText(myTurn) {
  if (g.over) {
    const { winner, reason, aborted, gone } = g.result;
    let text;
    if (aborted) text = `Game aborted: ${reason}.`;
    else if (winner === null) text = `Draw ${reason}.`;
    else text = `${winner === g.myColor ? 'You won' : 'You lost'} ${reason.startsWith('by') || reason.startsWith('on') ? reason : `(${reason})`}.`;
    if (!g.connected && !gone) text += ` ${g.oppName} has left.`;
    else if (g.rematch.opp && !g.rematch.me) text += ` ${g.oppName} wants a rematch.`;
    return text;
  }
  let text = myTurn ? 'Your move' : `${g.oppName} is thinking…`;
  if (g.chess.inCheck()) text += myTurn ? ' (you are in check)' : ' (check!)';
  if (plies() < 2) text += ` · first move within ${FIRST_MOVE_MS / 1000}s`;
  if (g.drawOffer === 'me') text += ' · draw offered';
  return text;
}

function renderClocks() {
  if (!g) return;
  for (const [node, color] of [[el.meClock, g.myColor], [el.oppClock, other(g.myColor)]]) {
    const ms = Math.max(0, timeLeft(color));
    node.textContent = formatClock(ms);
    node.classList.toggle('running', clockRunning() && g.chess.turn() === color);
    node.classList.toggle('low', ms < 30_000);
  }
}

function renderMoves() {
  const history = g.chess.history();
  const items = [];
  for (let i = 0; i < history.length; i += 2) {
    const li = document.createElement('li');
    li.textContent = history[i] + (history[i + 1] ? `  ${history[i + 1]}` : '');
    items.push(li);
  }
  el.moves.replaceChildren(...items);
  el.moves.scrollTop = el.moves.scrollHeight;
}

// ---------------------------------------------------------------- helpers

function other(color) {
  return color === 'w' ? 'b' : 'w';
}

function cleanName(value, fallback) {
  // eslint-disable-next-line no-control-regex
  const name = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 20);
  return name || fallback;
}

function formatClock(ms) {
  if (ms < 10_000) return `0:0${(ms / 1000).toFixed(1)}`;
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
