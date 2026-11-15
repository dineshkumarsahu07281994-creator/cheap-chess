// Click-to-move chess board. Pure DOM, no images: pieces are Unicode glyphs.

const TEXT_STYLE = '\uFE0E'; // stops iOS/Android from drawing the pawn as an emoji
const GLYPHS = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const NAMES = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };
const FILES = 'abcdefgh';

export class Board {
  constructor(root, { onMove }) {
    this.root = root;
    this.onMove = onMove;
    this.state = null;
    this.selected = null;
    this.promo = null;

    this.grid = document.createElement('div');
    this.grid.className = 'grid';
    root.append(this.grid);
    this.grid.addEventListener('click', (e) => {
      const sq = e.target.closest('[data-square]');
      if (sq) this.click(sq.dataset.square);
    });
  }

  /** state: { chess, myColor, interactive, lastMove: {from,to} | null } */
  render(state) {
    this.state = state;
    if (!state.interactive) {
      this.selected = null;
      this.closePromotion();
    }
    this.draw();
  }

  legalFromSelected() {
    if (!this.selected) return [];
    return this.state.chess.moves({ square: this.selected, verbose: true });
  }

  click(square) {
    const { chess, myColor, interactive } = this.state || {};
    if (!interactive || this.promo) return;

    if (this.selected) {
      const moves = this.legalFromSelected().filter((m) => m.to === square);
      if (moves.length) {
        const from = this.selected;
        if (moves.some((m) => m.promotion)) {
          this.openPromotion(from, square, myColor);
        } else {
          this.selected = null;
          this.onMove(from, square);
        }
        return;
      }
    }
    const piece = chess.get(square);
    this.selected = piece && piece.color === myColor && square !== this.selected ? square : null;
    this.draw();
  }

  draw() {
    const { chess, myColor, lastMove } = this.state;
    const targets = new Map(this.legalFromSelected().map((m) => [m.to, m]));
    const checkSquare = chess.inCheck() ? findKing(chess, chess.turn()) : null;
    const ranks = myColor === 'w' ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
    const files = myColor === 'w' ? [...FILES] : [...FILES].reverse();

    const cells = [];
    ranks.forEach((rank, row) => {
      files.forEach((file, col) => {
        const square = `${file}${rank}`;
        const piece = chess.get(square);
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.dataset.square = square;
        cell.className = `sq ${(FILES.indexOf(file) + rank) % 2 ? 'dark' : 'light'}`;
        if (lastMove && (square === lastMove.from || square === lastMove.to)) cell.classList.add('last');
        if (square === this.selected) cell.classList.add('selected');
        if (square === checkSquare) cell.classList.add('check');
        if (targets.has(square)) cell.classList.add(piece || targets.get(square).flags.includes('e') ? 'capture' : 'target');

        if (col === 0) cell.append(label('rank', rank));
        if (row === 7) cell.append(label('file', file));
        if (piece) {
          const glyph = document.createElement('span');
          glyph.className = `pc ${piece.color}`;
          glyph.textContent = GLYPHS[piece.type] + TEXT_STYLE;
          cell.append(glyph);
        }
        cell.setAttribute('aria-label', piece ? `${square}, ${colorWord(piece.color)} ${NAMES[piece.type]}` : square);
        cells.push(cell);
      });
    });
    this.grid.replaceChildren(...cells);
  }

  openPromotion(from, to, color) {
    const box = document.createElement('div');
    box.className = 'promo';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Choose a piece to promote to');
    for (const type of ['q', 'r', 'b', 'n']) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `pc ${color}`;
      btn.textContent = GLYPHS[type] + TEXT_STYLE;
      btn.setAttribute('aria-label', `Promote to ${NAMES[type]}`);
      btn.addEventListener('click', () => {
        this.closePromotion();
        this.selected = null;
        this.onMove(from, to, type);
      });
      box.append(btn);
    }
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'promo-cancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => { this.closePromotion(); this.draw(); });
    box.append(cancel);

    this.promo = box;
    this.root.append(box);
    box.querySelector('button').focus();
  }

  closePromotion() {
    this.promo?.remove();
    this.promo = null;
  }
}

function label(kind, text) {
  const span = document.createElement('span');
  span.className = `coord ${kind}`;
  span.textContent = text;
  span.setAttribute('aria-hidden', 'true');
  return span;
}

function findKing(chess, color) {
  for (const row of chess.board()) {
    for (const p of row) if (p && p.type === 'k' && p.color === color) return p.square;
  }
  return null;
}

export function colorWord(c) {
  return c === 'w' ? 'white' : 'black';
}
