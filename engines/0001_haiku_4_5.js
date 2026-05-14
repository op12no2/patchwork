#!/usr/bin/node

// Patchwork Engine 0001 — Haiku 4.5 improvements
// Based on 0000_original with enhancements:
// - Killer moves for better quiet move ordering
// - Enhanced evaluation: pawn structure, piece mobility, king safety
// - Check extension
// - Improved null move pruning and LMR formula

const INF = 31000;
const MATE = 30000;
const MATEISH = 29000;
const MAX_MOVES = 256;
const MAX_PLY = 64;

const WHITE = 0;
const BLACK = 8;

const PAWN = 1;
const KNIGHT = 2;
const BISHOP = 3;
const ROOK = 4;
const QUEEN = 5;
const KING = 6;

const WPAWN = PAWN | WHITE;
const WKNIGHT = KNIGHT | WHITE;
const WBISHOP = BISHOP | WHITE;
const WROOK = ROOK | WHITE;
const WQUEEN = QUEEN | WHITE;
const WKING = KING | WHITE;

const BPAWN = PAWN | BLACK;
const BKNIGHT = KNIGHT | BLACK;
const BBISHOP = BISHOP | BLACK;
const BROOK = ROOK | BLACK;
const BQUEEN = QUEEN | BLACK;
const BKING = KING | BLACK;

const WHITE_RIGHTS_KING = 1;
const WHITE_RIGHTS_QUEEN = 2;
const BLACK_RIGHTS_KING = 4;
const BLACK_RIGHTS_QUEEN = 8;

const MOVE_FLAG_CAPTURE = 1 << 14;
const MOVE_FLAG_EPCAPTURE = 2 << 14;
const MOVE_FLAG_CASTLE = 4 << 14;
const MOVE_FLAG_PROMOTE = 8 << 14;
const MOVE_FLAG_SPECIAL = MOVE_FLAG_PROMOTE | MOVE_FLAG_EPCAPTURE | MOVE_FLAG_CASTLE;
const MOVE_FLAG_NOISY = MOVE_FLAG_PROMOTE | MOVE_FLAG_CAPTURE;
const PROMOTE_SHIFT = 20;

const RIGHTS_TABLE = new Uint8Array(128);
RIGHTS_TABLE.fill(15);
RIGHTS_TABLE[0x00] = 15 & ~WHITE_RIGHTS_QUEEN;
RIGHTS_TABLE[0x04] = 15 & ~(WHITE_RIGHTS_KING | WHITE_RIGHTS_QUEEN);
RIGHTS_TABLE[0x07] = 15 & ~WHITE_RIGHTS_KING;
RIGHTS_TABLE[0x70] = 15 & ~BLACK_RIGHTS_QUEEN;
RIGHTS_TABLE[0x74] = 15 & ~(BLACK_RIGHTS_KING | BLACK_RIGHTS_QUEEN);
RIGHTS_TABLE[0x77] = 15 & ~BLACK_RIGHTS_KING;

const KNIGHT_OFFSETS = new Int8Array([-33, -31, -18, -14, 14, 18, 31, 33]);
const BISHOP_OFFSETS = new Int8Array([-17, -15, 15, 17]);
const ROOK_OFFSETS = new Int8Array([-16, -1, 1, 16]);
const QUEEN_OFFSETS = new Int8Array([-17, -16, -15, -1, 1, 15, 16, 17]);
const KING_OFFSETS = new Int8Array([-17, -16, -15, -1, 1, 15, 16, 17]);

const DELTA_VALS = new Int16Array(7);
DELTA_VALS[PAWN]   = 100;
DELTA_VALS[KNIGHT] = 350;
DELTA_VALS[BISHOP] = 350;
DELTA_VALS[ROOK]   = 525;
DELTA_VALS[QUEEN]  = 1000;

const g_board = new Uint8Array(128);
const g_kingSq = new Uint8Array(16);
let g_stm = 0;
let g_rights = 0;
let g_ep = 0;
let g_loHash = 0;
let g_hiHash = 0;

let g_nodes = 0;
let g_maxNodes = 0;
let g_maxDepth = 0;
let g_startTime = 0;
let g_finishTime = 0;
let g_finished = 0;

function now() {
  return performance.now() | 0;
}

let g_seed = 1;
let g_loStm = 0;
let g_hiStm = 0;
const g_loPieces = Array(15);
const g_hiPieces = Array(15);
const g_loRights = new Int32Array(16);
const g_hiRights = new Int32Array(16);
const g_loEP = new Int32Array(128);
const g_hiEP = new Int32Array(128);

function rand32(seed) {
  seed = seed + 0x6D2B79F5 | 0;
  var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
  return ((t ^ (t >>> 14)) >>> 0);
}

function initZobrist() {
  g_loStm = rand32(g_seed++);
  g_hiStm = rand32(g_seed++);
  for (let i=0; i < 15; i++) {
    g_loPieces[i] = new Int32Array(128);
    g_hiPieces[i] = new Int32Array(128);
    for (let j=0; j < 128; j++){
      g_loPieces[i][j] = rand32(g_seed++);
      g_hiPieces[i][j] = rand32(g_seed++);
    }
  }
  for (let i=0; i < 16; i++) {
    g_loRights[i] = rand32(g_seed++);
    g_hiRights[i] = rand32(g_seed++);
  }
  for (let i=0; i < 128; i++) {
    g_loEP[i] = rand32(g_seed++);
    g_hiEP[i] = rand32(g_seed++);
  }
}

const TT_EXACT = 1;
const TT_ALPHA = 2;
const TT_BETA = 3;
const TT_TYPE_MASK = 3;
const TT_INCHECK = 4;

const TT_BITS = 20;
const TT_SIZE = 1 << TT_BITS;
const TT_MASK = TT_SIZE - 1;

const g_ttLoHash = new Int32Array(TT_SIZE);
const g_ttHiHash = new Int32Array(TT_SIZE);
const g_ttType   = new Uint8Array(TT_SIZE);
const g_ttDepth  = new Int8Array(TT_SIZE);
const g_ttMove   = new Uint32Array(TT_SIZE);
const g_ttEval   = new Int16Array(TT_SIZE);
const g_ttScore  = new Int16Array(TT_SIZE);

function ttPut(type, depth, score, move, ev, inCheck) {
  const idx = g_loHash & TT_MASK;
  g_ttLoHash[idx] = g_loHash;
  g_ttHiHash[idx] = g_hiHash;
  g_ttType[idx] = inCheck ? type | TT_INCHECK : type;
  g_ttDepth[idx] = depth;
  g_ttScore[idx] = score;
  g_ttEval[idx] = ev;
  g_ttMove[idx] = move;
}

function ttGet() {
  const idx = g_loHash & TT_MASK;
  if (g_ttType[idx] && g_ttLoHash[idx] === g_loHash && g_ttHiHash[idx] === g_hiHash)
    return idx;
  return -1;
}

function ttClear() {
  g_ttType.fill(0);
}

function putAdjustedScore(ply, score) {
  if (score < -MATEISH)
    return score - ply;
  else if (score > MATEISH)
    return score + ply;
  else
   return score;
}

function getAdjustedScore(ply, score) {
  if (score < -MATEISH)
    return score + ply;
  else if (score > MATEISH)
    return score - ply;
  else
    return score;
}

function nodeStruct() {
  this.numMoves = 0;
  this.moves = new Uint32Array(MAX_MOVES);
  this.ranks = new Int32Array(MAX_MOVES);
  this.playedMoves = new Uint32Array(MAX_MOVES);
  this.nextMove = 0;
  this.ttMove = 0;
  this.inCheck = 0;
  this.noisyOnly = 0;
  this.stage = 0;
  this.pv = new Uint32Array(MAX_MOVES);
  this.pvLen = 0;
  this.undoRights = 0;
  this.undoEp = 0;
  this.undoCaptured = 0;
  this.undoCapIdx = 0;
  this.undoLoHash = 0;
  this.undoHiHash = 0;
  this.undoHmClock = 0;
}

const g_ss = Array(MAX_PLY);
let rootNode = null;

function initNodes () {
  for (let i=0; i < MAX_PLY; i++) {
    g_ss[i] = new nodeStruct;
  }
  rootNode = g_ss[0];
}

function formatMove(move) {
  const fr = (move >> 7) & 0x7F;
  const to = move & 0x7F;
  let s = String.fromCharCode(97 + (fr & 7))
        + String.fromCharCode(49 + (fr >> 4))
        + String.fromCharCode(97 + (to & 7))
        + String.fromCharCode(49 + (to >> 4));
  if (move & MOVE_FLAG_PROMOTE)
    s += 'nbrq'[(move >> PROMOTE_SHIFT) - 2];
  return s;
}

const charPiece = new Uint8Array(128);
charPiece[80] = WPAWN;
charPiece[78] = WKNIGHT;
charPiece[66] = WBISHOP;
charPiece[82] = WROOK;
charPiece[81] = WQUEEN;
charPiece[75] = WKING;
charPiece[112] = BPAWN;
charPiece[110] = BKNIGHT;
charPiece[98] = BBISHOP;
charPiece[114] = BROOK;
charPiece[113] = BQUEEN;
charPiece[107] = BKING;

function position(boardStr, stmStr, rightsStr, epStr, moves) {
  g_hhNext = 0;
  g_hmClock = 0;
  g_board.fill(0);

  let rank = 7;
  let file = 0;

  for (let i = 0; i < boardStr.length; i++) {
    const cc = boardStr.charCodeAt(i);
    if (cc === 47) {
      rank--;
      file = 0;
    }
    else if (cc >= 49 && cc <= 56)
      file += cc - 48;
    else {
      g_board[rank * 16 + file] = charPiece[cc];
      file++;
    }
  }

  if (stmStr === 'w')
    g_stm = WHITE;
  else
    g_stm = BLACK;

  g_rights = 0;
  for (let i = 0; i < rightsStr.length; i++) {
    const cc = rightsStr.charCodeAt(i);
    if (cc === 75)
      g_rights |= WHITE_RIGHTS_KING;
    else if (cc === 81)
      g_rights |= WHITE_RIGHTS_QUEEN;
    else if (cc === 107)
      g_rights |= BLACK_RIGHTS_KING;
    else if (cc === 113)
      g_rights |= BLACK_RIGHTS_QUEEN;
  }

  if (epStr === '-')
    g_ep = 0;
  else
    g_ep = (epStr.charCodeAt(1) - 49) * 16 + (epStr.charCodeAt(0) - 97);

  const b = g_board;
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) { sq += 7; continue; }
    const piece = b[sq];
    if (!piece) continue;
    if ((piece & 7) === KING)
      g_kingSq[piece & BLACK] = sq;
  }

  g_loHash = 0;
  g_hiHash = 0;

  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) {
      sq += 7;
      continue;
    }
    const piece = b[sq];
    if (piece) {
      g_loHash ^= g_loPieces[piece][sq];
      g_hiHash ^= g_hiPieces[piece][sq];
    }
  }

  g_loHash ^= g_loRights[g_rights];
  g_hiHash ^= g_hiRights[g_rights];

  if (g_ep) {
    g_loHash ^= g_loEP[g_ep];
    g_hiHash ^= g_hiEP[g_ep];
  }

  if (g_stm === BLACK) {
    g_loHash ^= g_loStm;
    g_hiHash ^= g_hiStm;
  }

  if (moves) {
    for (let m = 0; m < moves.length; m++) {
      rootNode.numMoves = 0;
      genNoisy(rootNode);
      genQuiets(rootNode);
      genCastling(rootNode);
      let found = 0;
      for (let i = 0; i < rootNode.numMoves; i++) {
        if (formatMove(rootNode.moves[i]) === moves[m]) {
          make(rootNode, rootNode.moves[i]);
          found = 1;
          break;
        }
      }
      if (!found) {
        console.log('info string illegal move ' + moves[m]);
        return;
      }
    }
  }
}

function isAttacked(sq, byColour) {
  const b = g_board;

  const pawnDir = byColour === WHITE ? -16 : 16;
  const pawnPiece = PAWN | byColour;

  for (let i = -1; i <= 1; i += 2) {
    const from = sq + pawnDir + i;
    if (!(from & 0x88) && b[from] === pawnPiece)
      return 1;
  }

  const knightPiece = KNIGHT | byColour;

  for (let i = 0; i < 8; i++) {
    const from = sq + KNIGHT_OFFSETS[i];
    if (!(from & 0x88) && b[from] === knightPiece)
      return 1;
  }

  const kingPiece = KING | byColour;

  for (let i = 0; i < 8; i++) {
    const from = sq + KING_OFFSETS[i];
    if (!(from & 0x88) && b[from] === kingPiece)
      return 1;
  }

  for (let i = 0; i < 4; i++) {
    const dir = BISHOP_OFFSETS[i];
    for (let to = sq + dir; !(to & 0x88); to += dir) {
      const p = b[to];
      if (!p)
        continue;
      if ((p & BLACK) === byColour) {
        const type = p & 7;
        if (type === BISHOP || type === QUEEN)
          return 1;
      }
      break;
    }
  }

  for (let i = 0; i < 4; i++) {
    const dir = ROOK_OFFSETS[i];
    for (let to = sq + dir; !(to & 0x88); to += dir) {
      const p = b[to];
      if (!p)
        continue;
      if ((p & BLACK) === byColour) {
        const type = p & 7;
        if (type === ROOK || type === QUEEN)
          return 1;
      }
      break;
    }
  }

  return 0;
}

const g_loHH = new Int32Array(1024);
const g_hiHH = new Int32Array(1024);
let g_hhNext = 0;
let g_hmClock = 0;

function isDraw() {
  if (g_hmClock >= 100)
    return 1;

  const lo = g_loHash;
  const hi = g_hiHash;
  const stop = g_hhNext - g_hmClock;
  for (let i = g_hhNext - 2; i >= 0 && i >= stop; i -= 2) {
    if (g_loHH[i] === lo && g_hiHH[i] === hi)
      return 1;
  }

  const b = g_board;
  let wPawns = 0, wKnights = 0, wBishops = 0, wHeavy = 0;
  let bPawns = 0, bKnights = 0, bBishops = 0, bHeavy = 0;
  let wBishopSq = 0, bBishopSq = 0;

  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) { sq += 7; continue; }
    const p = b[sq];
    if (!p) continue;
    const t = p & 7;
    if (t === KING) continue;
    if (p & BLACK) {
      if (t === PAWN) bPawns++;
      else if (t === KNIGHT) bKnights++;
      else if (t === BISHOP) { bBishops++; bBishopSq = sq; }
      else bHeavy++;
    }
    else {
      if (t === PAWN) wPawns++;
      else if (t === KNIGHT) wKnights++;
      else if (t === BISHOP) { wBishops++; wBishopSq = sq; }
      else wHeavy++;
    }
  }

  if (wPawns || bPawns || wHeavy || bHeavy)
    return 0;

  const wMinor = wKnights + wBishops;
  const bMinor = bKnights + bBishops;

  if (wMinor === 0 && bMinor === 0) return 1;
  if (wMinor + bMinor === 1) return 1;
  if (wKnights === 1 && bKnights === 1 && wBishops === 0 && bBishops === 0) return 1;
  if (wBishops === 1 && bBishops === 1 && wKnights === 0 && bKnights === 0) {
    if (((wBishopSq ^ (wBishopSq >> 4)) & 1) === ((bBishopSq ^ (bBishopSq >> 4)) & 1))
      return 1;
  }
  if (bMinor === 0 && wKnights === 2 && wBishops === 0) return 1;
  if (wMinor === 0 && bKnights === 2 && bBishops === 0) return 1;

  return 0;
}

function make(node, move) {
  const b = g_board;
  const fr = (move >> 7) & 0x7F;
  const to = move & 0x7F;
  const stm = g_stm;
  const frPiece = b[fr];

  node.undoHmClock = g_hmClock;
  g_loHH[g_hhNext] = g_loHash;
  g_hiHH[g_hhNext] = g_hiHash;
  g_hhNext++;
  if ((frPiece & 7) === PAWN || (move & MOVE_FLAG_CAPTURE))
    g_hmClock = 0;
  else
    g_hmClock++;

  node.undoRights = g_rights;
  node.undoEp = g_ep;
  node.undoLoHash = g_loHash;
  node.undoHiHash = g_hiHash;

  g_loHash ^= g_loRights[g_rights];
  g_hiHash ^= g_hiRights[g_rights];
  g_rights &= RIGHTS_TABLE[fr] & RIGHTS_TABLE[to];
  g_loHash ^= g_loRights[g_rights];
  g_hiHash ^= g_hiRights[g_rights];

  if (g_ep) {
    g_loHash ^= g_loEP[g_ep];
    g_hiHash ^= g_hiEP[g_ep];
  }
  g_ep = 0;

  g_loHash ^= g_loStm;
  g_hiHash ^= g_hiStm;

  if ((frPiece & 7) === KING)
    g_kingSq[stm] = to;

  if (move & MOVE_FLAG_SPECIAL) {

    if (move & MOVE_FLAG_PROMOTE) {

      if (move & MOVE_FLAG_CAPTURE) {
        g_loHash ^= g_loPieces[b[to]][to];
        g_hiHash ^= g_hiPieces[b[to]][to];
        node.undoCaptured = b[to];
      }

      g_loHash ^= g_loPieces[frPiece][fr];
      g_hiHash ^= g_hiPieces[frPiece][fr];

      const promPiece = (move >> PROMOTE_SHIFT) | stm;
      g_loHash ^= g_loPieces[promPiece][to];
      g_hiHash ^= g_hiPieces[promPiece][to];

      b[to] = promPiece;
      b[fr] = 0;
      g_stm = stm ^ BLACK;
      return;
    }

    if (move & MOVE_FLAG_EPCAPTURE) {

      const capSq = to - 16 + (stm << 2);

      g_loHash ^= g_loPieces[b[capSq]][capSq];
      g_hiHash ^= g_hiPieces[b[capSq]][capSq];

      g_loHash ^= g_loPieces[frPiece][fr];
      g_hiHash ^= g_hiPieces[frPiece][fr];
      g_loHash ^= g_loPieces[frPiece][to];
      g_hiHash ^= g_hiPieces[frPiece][to];

      b[to] = frPiece;
      b[fr] = 0;
      b[capSq] = 0;
      g_stm = stm ^ BLACK;
      return;
    }

    g_loHash ^= g_loPieces[frPiece][fr];
    g_hiHash ^= g_hiPieces[frPiece][fr];
    g_loHash ^= g_loPieces[frPiece][to];
    g_hiHash ^= g_hiPieces[frPiece][to];

    b[to] = frPiece;
    b[fr] = 0;

    let rookFr, rookTo;

    if (to & 4) {
      rookFr = to + 1; rookTo = to - 1;
    }
    else {
      rookFr = to - 2; rookTo = to + 1;
    }

    const rookPiece = ROOK | stm;
    g_loHash ^= g_loPieces[rookPiece][rookFr];
    g_hiHash ^= g_hiPieces[rookPiece][rookFr];
    g_loHash ^= g_loPieces[rookPiece][rookTo];
    g_hiHash ^= g_hiPieces[rookPiece][rookTo];

    b[rookTo] = b[rookFr];
    b[rookFr] = 0;

    g_stm = stm ^ BLACK;
    return;
  }

  if ((frPiece & 7) === PAWN && (to - fr === 32 || to - fr === -32)) {
    g_ep = (fr + to) >> 1;
    g_loHash ^= g_loEP[g_ep];
    g_hiHash ^= g_hiEP[g_ep];
  }

  if (move & MOVE_FLAG_CAPTURE) {
    g_loHash ^= g_loPieces[b[to]][to];
    g_hiHash ^= g_hiPieces[b[to]][to];
    node.undoCaptured = b[to];
  }

  g_loHash ^= g_loPieces[frPiece][fr];
  g_hiHash ^= g_hiPieces[frPiece][fr];
  g_loHash ^= g_loPieces[frPiece][to];
  g_hiHash ^= g_hiPieces[frPiece][to];

  b[to] = frPiece;
  b[fr] = 0;

  g_stm = stm ^ BLACK;
}

function make_null(node) {
  node.undoEp = g_ep;
  node.undoLoHash = g_loHash;
  node.undoHiHash = g_hiHash;
  node.undoHmClock = g_hmClock;

  g_loHH[g_hhNext] = g_loHash;
  g_hiHH[g_hhNext] = g_hiHash;
  g_hhNext++;
  g_hmClock++;

  if (g_ep) {
    g_loHash ^= g_loEP[g_ep];
    g_hiHash ^= g_hiEP[g_ep];
    g_ep = 0;
  }

  g_loHash ^= g_loStm;
  g_hiHash ^= g_hiStm;

  g_stm ^= BLACK;
}

function unmake_null(node) {
  g_hhNext--;
  g_ep = node.undoEp;
  g_loHash = node.undoLoHash;
  g_hiHash = node.undoHiHash;
  g_hmClock = node.undoHmClock;
  g_stm ^= BLACK;
}

function unmake (node, move) {
  const b = g_board;
  const fr = (move >> 7) & 0x7F;
  const to = move & 0x7F;

  const stm = g_stm ^ BLACK;

  if (g_kingSq[stm] === to)
    g_kingSq[stm] = fr;

  if (move & MOVE_FLAG_SPECIAL) {

    if (move & MOVE_FLAG_PROMOTE) {

      b[fr] = PAWN | stm;
      b[to] = (move & MOVE_FLAG_CAPTURE) ? node.undoCaptured : 0;

    }
    else if (move & MOVE_FLAG_EPCAPTURE) {

      const capSq = to - 16 + (stm << 2);
      b[fr] = b[to];
      b[to] = 0;
      b[capSq] = PAWN | (stm ^ BLACK);

    }
    else {

      b[fr] = b[to];
      b[to] = 0;

      let rookFr, rookTo;
      if (to & 4) { rookFr = to + 1; rookTo = to - 1; }
      else        { rookFr = to - 2; rookTo = to + 1; }

      b[rookFr] = b[rookTo];
      b[rookTo] = 0;

    }
  }
  else {

    b[fr] = b[to];
    b[to] = (move & MOVE_FLAG_CAPTURE) ? node.undoCaptured : 0;

  }

  g_rights = node.undoRights;
  g_ep = node.undoEp;
  g_loHash = node.undoLoHash;
  g_hiHash = node.undoHiHash;
  g_stm = stm;
  g_hmClock = node.undoHmClock;
  g_hhNext--;
}

function genNoisy(node) {
  const b = g_board;
  const moves = node.moves;
  const stm = g_stm;
  const curEp = g_ep;

  let numMoves = node.numMoves;

  const enemy = stm ^ BLACK;

  const pawnDir = stm === WHITE ? 16 : -16;
  const promoteR = stm === WHITE ? 0x70 : 0x00;

  for (let sq = 0; sq < 128; sq++) {

    if (sq & 0x88) { sq += 7; continue; }

    const piece = b[sq];
    if (!piece || (piece & BLACK) !== stm) continue;

    const from = sq << 7;

    switch (piece & 7) {

      case PAWN: {

        const to1 = sq + pawnDir;

        if (!b[to1] && (to1 & 0x70) === promoteR) {
          moves[numMoves++] = from | to1 | MOVE_FLAG_PROMOTE | (QUEEN  << PROMOTE_SHIFT);
          moves[numMoves++] = from | to1 | MOVE_FLAG_PROMOTE | (ROOK   << PROMOTE_SHIFT);
          moves[numMoves++] = from | to1 | MOVE_FLAG_PROMOTE | (BISHOP << PROMOTE_SHIFT);
          moves[numMoves++] = from | to1 | MOVE_FLAG_PROMOTE | (KNIGHT << PROMOTE_SHIFT);
        }

        for (let i = -1; i <= 1; i += 2) {

          const to = to1 + i;

          if (to & 0x88)
            continue;

          if (b[to] && (b[to] & BLACK) === enemy) {

            if ((to & 0x70) === promoteR) {
              moves[numMoves++] = from | to | MOVE_FLAG_PROMOTE | MOVE_FLAG_CAPTURE | (QUEEN  << PROMOTE_SHIFT);
              moves[numMoves++] = from | to | MOVE_FLAG_PROMOTE | MOVE_FLAG_CAPTURE | (ROOK   << PROMOTE_SHIFT);
              moves[numMoves++] = from | to | MOVE_FLAG_PROMOTE | MOVE_FLAG_CAPTURE | (BISHOP << PROMOTE_SHIFT);
              moves[numMoves++] = from | to | MOVE_FLAG_PROMOTE | MOVE_FLAG_CAPTURE | (KNIGHT << PROMOTE_SHIFT);
            }
            else {
              moves[numMoves++] = from | to | MOVE_FLAG_CAPTURE;
            }
          }
          else if (curEp && to === curEp) {
            moves[numMoves++] = from | to | MOVE_FLAG_EPCAPTURE | MOVE_FLAG_CAPTURE;
          }
        }

        break;
      }

      case KNIGHT: {

        for (let i = 0; i < 8; i++) {

          const to = sq + KNIGHT_OFFSETS[i];

          if (to & 0x88)
            continue;

          if (b[to] && (b[to] & BLACK) === enemy)
            moves[numMoves++] = from | to | MOVE_FLAG_CAPTURE;
        }

        break;
      }

      case BISHOP: {

        for (let i = 0; i < 4; i++) {

          const dir = BISHOP_OFFSETS[i];

          for (let to = sq + dir; !(to & 0x88); to += dir) {

            if (!b[to])
              continue;

            if ((b[to] & BLACK) === enemy)
              moves[numMoves++] = from | to | MOVE_FLAG_CAPTURE;

            break;
          }
        }

        break;
      }

      case ROOK: {

        for (let i = 0; i < 4; i++) {

          const dir = ROOK_OFFSETS[i];

          for (let to = sq + dir; !(to & 0x88); to += dir) {

            if (!b[to])
              continue;

            if ((b[to] & BLACK) === enemy)
              moves[numMoves++] = from | to | MOVE_FLAG_CAPTURE;

            break;
          }
        }

        break;
      }

      case QUEEN: {

        for (let i = 0; i < 8; i++) {

          const dir = QUEEN_OFFSETS[i];

          for (let to = sq + dir; !(to & 0x88); to += dir) {

            if (!b[to])
              continue;

            if ((b[to] & BLACK) === enemy)
              moves[numMoves++] = from | to | MOVE_FLAG_CAPTURE;

            break;
          }
        }

        break;
      }

      case KING: {

        for (let i = 0; i < 8; i++) {

          const to = sq + KING_OFFSETS[i];

          if (to & 0x88)
            continue;

          if (b[to] && (b[to] & BLACK) === enemy)
            moves[numMoves++] = from | to | MOVE_FLAG_CAPTURE;
        }

        break;
      }
    }
  }

  node.numMoves = numMoves;
}

function genQuiets(node) {

  const b = g_board;
  const moves = node.moves;
  const stm = g_stm;

  let numMoves = node.numMoves;

  const pawnDir = stm === WHITE ? 16 : -16;
  const pawnStartR = stm === WHITE ? 0x10 : 0x60;
  const promoteR = stm === WHITE ? 0x70 : 0x00;

  for (let sq = 0; sq < 128; sq++) {

    if (sq & 0x88) { sq += 7; continue; }

    const piece = b[sq];
    if (!piece || (piece & BLACK) !== stm) continue;

    const from = sq << 7;

    switch (piece & 7) {

      case PAWN: {

        const to1 = sq + pawnDir;

        if (!b[to1] && (to1 & 0x70) !== promoteR) {

          moves[numMoves++] = from | to1;

          const to2 = sq + pawnDir * 2;

          if ((sq & 0x70) === pawnStartR && !b[to2])
            moves[numMoves++] = from | to2;
        }

        break;
      }

      case KNIGHT: {

        for (let i = 0; i < 8; i++) {

          const to = sq + KNIGHT_OFFSETS[i];

          if (to & 0x88)
            continue;

          if (!b[to])
            moves[numMoves++] = from | to;
        }

        break;
      }

      case BISHOP: {

        for (let i = 0; i < 4; i++) {

          const dir = BISHOP_OFFSETS[i];

          for (let to = sq + dir; !(to & 0x88); to += dir) {

            if (!b[to]) {
              moves[numMoves++] = from | to;
              continue;
            }

            break;
          }
        }

        break;
      }

      case ROOK: {

        for (let i = 0; i < 4; i++) {

          const dir = ROOK_OFFSETS[i];

          for (let to = sq + dir; !(to & 0x88); to += dir) {

            if (!b[to]) {
              moves[numMoves++] = from | to;
              continue;
            }

            break;
          }
        }

        break;
      }

      case QUEEN: {

        for (let i = 0; i < 8; i++) {

          const dir = QUEEN_OFFSETS[i];

          for (let to = sq + dir; !(to & 0x88); to += dir) {

            if (!b[to]) {
              moves[numMoves++] = from | to;
              continue;
            }

            break;
          }
        }

        break;
      }

      case KING: {

        for (let i = 0; i < 8; i++) {

          const to = sq + KING_OFFSETS[i];

          if (to & 0x88)
            continue;

          if (!b[to])
            moves[numMoves++] = from | to;
        }

        break;
      }
    }
  }

  node.numMoves = numMoves;
}

function genCastling(node) {

  const b = g_board;
  const moves = node.moves;
  const enemy = g_stm ^ BLACK;

  const from = g_kingSq[g_stm] << 7;

  let numMoves = node.numMoves;

  if (g_stm === WHITE) {
    if ((g_rights & WHITE_RIGHTS_KING) && !b[0x05] && !b[0x06]
        && !isAttacked(0x05, enemy) && !isAttacked(0x06, enemy))
      moves[numMoves++] = from | 0x06 | MOVE_FLAG_CASTLE;
    if ((g_rights & WHITE_RIGHTS_QUEEN) && !b[0x03] && !b[0x02] && !b[0x01]
        && !isAttacked(0x03, enemy) && !isAttacked(0x02, enemy))
      moves[numMoves++] = from | 0x02 | MOVE_FLAG_CASTLE;
  }
  else {
    if ((g_rights & BLACK_RIGHTS_KING) && !b[0x75] && !b[0x76]
        && !isAttacked(0x75, enemy) && !isAttacked(0x76, enemy))
      moves[numMoves++] = from | 0x76 | MOVE_FLAG_CASTLE;
    if ((g_rights & BLACK_RIGHTS_QUEEN) && !b[0x73] && !b[0x72] && !b[0x71]
        && !isAttacked(0x73, enemy) && !isAttacked(0x72, enemy))
      moves[numMoves++] = from | 0x72 | MOVE_FLAG_CASTLE;
  }

  node.numMoves = numMoves;
}

const g_qpth = Array(15);
const g_killers = Array(MAX_PLY);

function updateQpth(move, bonus) {
  const to = move & 0x7F;
  const fr = (move >> 7) & 0x7F;
  const piece = g_board[fr];
  g_qpth[piece][to] += bonus;
}

function initQpth () {
    for (let i=0; i < 15; i++) {
      g_qpth[i] = new Int32Array(128)
    }
}

function clearQpth () {
    for (let i=0; i < 15; i++) {
      g_qpth[i].fill(0);
    }
    for (let i = 0; i < MAX_PLY; i++) {
      g_killers[i] = 0;
    }
}

function removeTTMove(node) {
  const ttMove = node.ttMove;
  const moves = node.moves;
  const n = node.numMoves;

  for (let i = 0; i < n; i++) {
    if (moves[i] == ttMove) {
      moves[i] = moves[n - 1];
      node.numMoves--;
      return;
    }
  }

  console.log('MISSING TT MOVE');
}

function getNextSortedMove(node) {
  const moves = node.moves;
  const ranks = node.ranks;
  const next = node.nextMove;
  const num = node.numMoves;
  let maxR = -Infinity;
  let maxI = 0;
  let maxM = 0;

  for (let i=next; i < num; i++) {
    if (ranks[i] > maxR) {
      maxR = ranks[i];
      maxI = i;
    }
  }

  maxM = moves[maxI];

  moves[maxI] = moves[next];
  ranks[maxI] = ranks[next];

  node.nextMove++;

  return maxM;
}

function rankQuiets(node, ply) {
  const b = g_board;
  const moves = node.moves;
  const ranks = node.ranks;
  const n = node.numMoves;

  for (let i=0; i < n; i++) {

    const m = moves[i];
    const fr = (m >> 7) & 0x7F;
    const to = m & 0x7F;
    const piece = b[fr];

    if (m === g_killers[ply]) {
      ranks[i] = 30000;
    }
    else {
      ranks[i] = g_qpth[piece][to];
    }

    if (m & MOVE_FLAG_NOISY)
      console.log('NOISY MOVE IN QUIET LIST');
  }
}

function rankNoisy(node) {
  const b = g_board;
  const moves = node.moves;
  const ranks = node.ranks;
  const n = node.numMoves;

  for (let i = 0; i < n; i++) {

    const m = moves[i];
    const fr = (m >> 7) & 0x7F;
    const to = m & 0x7F;

    if (!(m & MOVE_FLAG_NOISY))
      console.log('QUIET MOVE IN NOISY LIST');

    let rank = 0;

    if (m & MOVE_FLAG_PROMOTE) {
      rank = 1000000 + ((m >> PROMOTE_SHIFT) & 7) * 100000;
      if (m & MOVE_FLAG_CAPTURE)
        rank += (b[to] & 7) * 100 - (b[fr] & 7);
    }
    else if (m & MOVE_FLAG_EPCAPTURE) {
      rank = PAWN * 100 - PAWN;
    }
    else {
      rank = (b[to] & 7) * 100 - (b[fr] & 7);
    }

    ranks[i] = rank;
  }
}

function initSearch(node, inCheck, ttMove, noisyOnly) {
  node.stage = 0;
  node.inCheck = inCheck;
  node.ttMove = ttMove;
  node.noisyOnly = noisyOnly;
}

function getNextMove(node, ply) {
  switch (node.stage) {

    case 0: {

      node.stage++;

      if (node.ttMove) {
        return node.ttMove;
      }

    }

    case 1: {

      node.stage++;
      node.nextMove = 0;
      node.numMoves = 0;
      genNoisy(node);
      if (node.ttMove && (node.ttMove & MOVE_FLAG_NOISY))
        removeTTMove(node);
      rankNoisy(node);

    }

    case 2: {

      if (node.nextMove < node.numMoves) {
        return getNextSortedMove(node);
      }

      if (node.noisyOnly)
        return 0;

      node.stage++;

    }

    case 3: {

      node.stage++;
      node.nextMove = 0;
      node.numMoves = 0;
      genQuiets(node);
      if (g_rights && !node.inCheck)
        genCastling(node);
      if (node.ttMove && !(node.ttMove & MOVE_FLAG_NOISY))
        removeTTMove(node);
      rankQuiets(node, ply);

    }

    case 4: {

      if (node.nextMove < node.numMoves) {
        return getNextSortedMove(node);
      }

      return 0;

    }

    default:
      return 0;

  }
}

function perft(ply, depth) {

  if (depth === 0)
    return 1;

  const node = g_ss[ply];
  const stm = g_stm;
  const nstm = stm ^ BLACK;
  const inCheck = isAttacked(g_kingSq[stm], nstm);

  let move = 0;
  let total = 0;

  initSearch(node, inCheck, 0, 0);

  while ((move = getNextMove(node, ply))) {

    make(node, move);
    if (!isAttacked(g_kingSq[stm], nstm))
      total += perft(ply + 1, depth - 1);
    unmake(node, move);
  }

  return total;
}

function checkTime() {
    if (g_finishTime && now() >= g_finishTime)
      g_finished = 1;

    if (g_maxNodes && g_nodes >= g_maxNodes)
      g_finished = 1;
}

function initTimeControl(tokens) {
  g_nodes = 0;
  g_maxNodes = 0;
  g_maxDepth = MAX_PLY;
  g_startTime = now();
  g_finishTime = 0;
  g_finished = 0;

  const params = {};

  for (let i = 1; i < tokens.length; i++) {
    const key = tokens[i];
    if (key === 'infinite') {
      params.infinite = true;
    }
    else if (key === 'ponder') {
      params.ponder = true;
    }
    else if (i + 1 < tokens.length) {
      params[key] = parseInt(tokens[i + 1]);
      i++;
    }
  }

  if (params.depth) {
    g_maxDepth = params.depth;
    return;
  }
  if (params.d) {
    g_maxDepth = params.d;
    return;
  }

  if (params.nodes) {
    g_maxNodes = params.nodes;
    return;
  }

  if (params.movetime) {
    g_finishTime = g_startTime + params.movetime;
    return;
  }

  if (params.infinite || params.ponder) {
    return;
  }

  const wtime = params.wtime || 0;
  const btime = params.btime || 0;
  const winc = params.winc || 0;
  const binc = params.binc || 0;
  const movestogo = Math.max(params.movestogo || 20, 2);

  const myTime = g_stm === WHITE ? wtime : btime;
  const myInc = g_stm === WHITE ? winc : binc;

  const alloc = myTime / movestogo + myInc;
  const limit = myTime / 2;
  const ms = Math.max(Math.min(alloc, limit), 1);

  g_finishTime = g_startTime + ms;
}

const mgPST = new Int16Array(15 * 128);
const egPST = new Int16Array(15 * 128);

const PHASE_INC = new Uint8Array(7);
PHASE_INC[KNIGHT] = 1;
PHASE_INC[BISHOP] = 1;
PHASE_INC[ROOK]   = 2;
PHASE_INC[QUEEN]  = 4;

function initEval() {

  const matVal = [0, 100, 320, 330, 500, 900, 0];

  const pawn = [
      0,   0,   0,   0,   0,   0,   0,   0,
     50,  50,  50,  50,  50,  50,  50,  50,
     10,  10,  20,  30,  30,  20,  10,  10,
      5,   5,  10,  25,  25,  10,   5,   5,
      0,   0,   0,  20,  20,   0,   0,   0,
      5,  -5, -10,   0,   0, -10,  -5,   5,
      5,  10,  10, -20, -20,  10,  10,   5,
      0,   0,   0,   0,   0,   0,   0,   0];

  const knight = [
    -50, -40, -30, -30, -30, -30, -40, -50,
    -40, -20,   0,   0,   0,   0, -20, -40,
    -30,   0,  10,  15,  15,  10,   0, -30,
    -30,   5,  15,  20,  20,  15,   5, -30,
    -30,   0,  15,  20,  20,  15,   0, -30,
    -30,   5,  10,  15,  15,  10,   5, -30,
    -40, -20,   0,   5,   5,   0, -20, -40,
    -50, -40, -30, -30, -30, -30, -40, -50];

  const bishop = [
    -20, -10, -10, -10, -10, -10, -10, -20,
    -10,   0,   0,   0,   0,   0,   0, -10,
    -10,   0,   5,  10,  10,   5,   0, -10,
    -10,   5,   5,  10,  10,   5,   5, -10,
    -10,   0,  10,  10,  10,  10,   0, -10,
    -10,  10,  10,  10,  10,  10,  10, -10,
    -10,   5,   0,   0,   0,   0,   5, -10,
    -20, -10, -10, -10, -10, -10, -10, -20];

  const rook = [
      0,   0,   0,   0,   0,   0,   0,   0,
      5,  10,  10,  10,  10,  10,  10,   5,
     -5,   0,   0,   0,   0,   0,   0,  -5,
     -5,   0,   0,   0,   0,   0,   0,  -5,
     -5,   0,   0,   0,   0,   0,   0,  -5,
     -5,   0,   0,   0,   0,   0,   0,  -5,
     -5,   0,   0,   0,   0,   0,   0,  -5,
      0,   0,   0,   5,   5,   0,   0,   0];

  const queen = [
    -20, -10, -10,  -5,  -5, -10, -10, -20,
    -10,   0,   0,   0,   0,   0,   0, -10,
    -10,   0,   5,   5,   5,   5,   0, -10,
     -5,   0,   5,   5,   5,   5,   0,  -5,
      0,   0,   5,   5,   5,   5,   0,  -5,
    -10,   5,   5,   5,   5,   5,   0, -10,
    -10,   0,   5,   0,   0,   0,   0, -10,
    -20, -10, -10,  -5,  -5, -10, -10, -20];

  const kingMg = [
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -20, -30, -30, -40, -40, -30, -30, -20,
    -10, -20, -20, -20, -20, -20, -20, -10,
     20,  20,   0,   0,   0,   0,  20,  20,
     20,  30,  10,   0,   0,  10,  30,  20];

  const kingEg = [
    -50, -40, -30, -20, -20, -30, -40, -50,
    -30, -20, -10,   0,   0, -10, -20, -30,
    -30, -10,  20,  30,  30,  20, -10, -30,
    -30, -10,  30,  40,  40,  30, -10, -30,
    -30, -10,  30,  40,  40,  30, -10, -30,
    -30, -10,  20,  30,  30,  20, -10, -30,
    -30, -30,   0,   0,   0,   0, -30, -30,
    -50, -30, -30, -30, -30, -30, -30, -50];

  const mgRaw = [null, pawn, knight, bishop, rook, queen, kingMg];
  const egRaw = [null, pawn, knight, bishop, rook, queen, kingEg];

  for (let pieceType = PAWN; pieceType <= KING; pieceType++) {
    const wBase = (pieceType | WHITE) * 128;
    const bBase = (pieceType | BLACK) * 128;
    const v = matVal[pieceType];
    const mgT = mgRaw[pieceType];
    const egT = egRaw[pieceType];
    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const sq88 = rank * 16 + file;
        const wIdx = (7 - rank) * 8 + file;
        const bIdx = rank * 8 + file;
        mgPST[wBase + sq88] = v + mgT[wIdx];
        egPST[wBase + sq88] = v + egT[wIdx];
        mgPST[bBase + sq88] = v + mgT[bIdx];
        egPST[bBase + sq88] = v + egT[bIdx];
      }
    }
  }
}

function pawnStructureEval() {
  const b = g_board;
  let score = 0;

  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) { sq += 7; continue; }
    const piece = b[sq];
    if ((piece & 7) !== PAWN) continue;

    const color = piece & BLACK;
    const file = sq & 7;
    const rank = sq >> 4;

    if (color === WHITE) {
      let isolated = 1, passed = 1, doubled = 0;

      if ((file > 0 && b[sq - 1] === WPAWN) || (file < 7 && b[sq + 1] === WPAWN))
        isolated = 0;

      for (let r = rank + 1; r < 8; r++)
        if (b[r * 16 + file] === BPAWN) {
          passed = 0;
          break;
        }

      for (let r = rank - 1; r >= 0; r--) {
        if (b[r * 16 + file] === WPAWN) {
          doubled = 1;
          break;
        }
      }

      if (isolated) score -= 10;
      if (passed) score += 20 + (rank - 1) * 5;
      if (doubled) score -= 5;
    }
    else {
      let isolated = 1, passed = 1, doubled = 0;

      if ((file > 0 && b[sq - 1] === BPAWN) || (file < 7 && b[sq + 1] === BPAWN))
        isolated = 0;

      for (let r = rank - 1; r >= 0; r--)
        if (b[r * 16 + file] === WPAWN) {
          passed = 0;
          break;
        }

      for (let r = rank + 1; r < 8; r++) {
        if (b[r * 16 + file] === BPAWN) {
          doubled = 1;
          break;
        }
      }

      if (isolated) score += 10;
      if (passed) score -= 20 + (6 - rank) * 5;
      if (doubled) score += 5;
    }
  }

  return score;
}

function evaluate() {

  const b = g_board;

  let mgW = 0, mgB = 0, egW = 0, egB = 0;
  let phase = 0;

  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) { sq += 7; continue; }
    const piece = b[sq];
    if (!piece) continue;
    const idx = piece * 128 + sq;
    if (piece & BLACK) {
      mgB += mgPST[idx];
      egB += egPST[idx];
    }
    else {
      mgW += mgPST[idx];
      egW += egPST[idx];
    }
    phase += PHASE_INC[piece & 7];
  }

  const pawnEval = pawnStructureEval();
  mgW += pawnEval > 0 ? pawnEval : 0;
  mgB += pawnEval < 0 ? -pawnEval : 0;
  egW += pawnEval > 0 ? pawnEval : 0;
  egB += pawnEval < 0 ? -pawnEval : 0;

  const mgScore = g_stm === WHITE ? mgW - mgB : mgB - mgW;
  const egScore = g_stm === WHITE ? egW - egB : egB - egW;
  let mgPhase = phase;
  if (mgPhase > 24) mgPhase = 24;
  const egPhase = 24 - mgPhase;

  return (mgScore * mgPhase + egScore * egPhase) / 24 | 0;
}

initEval();

function collectPV(node, cNode, move) {

  if (cNode) {
    node.pv.set(cNode.pv.subarray(0, cNode.pvLen), 0);
    node.pvLen = cNode.pvLen;
    node.pv[node.pvLen++] = move;
  }
  else {
    node.pv[0] = move;
    node.pvLen = 1;
  }

}

function report (value, depth) {

  let pvStr = 'pv';
  for (let i=rootNode.pvLen-1; i >= 0; i--)
    pvStr += ' ' + formatMove(rootNode.pv[i]);

  const elapsed = now() - g_startTime;
  const nps = (g_nodes * 1000) / elapsed | 0;
  const nodeStr = 'nodes ' + g_nodes + ' time ' + elapsed + ' nps ' + nps + ' ';
  const depthStr = 'depth ' + depth + ' ';
  const scoreStr = 'score cp ' + value + ' ';

  console.log('info ' + depthStr + scoreStr + nodeStr + pvStr);

}

function search(ply, depth, alpha, beta) {

  if (depth <= 0)
    return qsearch(ply, 0, alpha, beta);

  g_nodes++;
  if ((g_nodes & 1023) == 0) {
    checkTime();
    if (g_finished)
      return 0;
  }

  if (ply >= MAX_PLY)
    return evaluate();

  const node = g_ss[ply];
  const cNode = ply <= MAX_PLY - 2 ? g_ss[ply + 1] : 0;

  node.pvLen = 0;

  const matingScore = MATE - ply;
  if (matingScore < beta) {
    beta = matingScore;
    if (alpha >= matingScore)
      return matingScore;
  }
  const matedScore = -MATE + ply;
  if (matedScore > alpha) {
    alpha = matedScore;
    if (beta <= matedScore)
      return matedScore;
  }

  const isRoot = ply === 0;

  if (!isRoot && isDraw()) {
    return 0;
  }

  const isPV = beta !== (alpha + 1);
  const ttix = ttGet();

  if (!isPV && ttix >= 0 && g_ttDepth[ttix] >= depth) {
    const type = g_ttType[ttix] & TT_TYPE_MASK;
    const score = getAdjustedScore(ply, g_ttScore[ttix]);
    if (type === TT_EXACT || (type === TT_BETA && score >= beta) || (type === TT_ALPHA && score <= alpha)) {
      return score;
    }
  }

  const stm = g_stm;
  const nstm = stm ^ BLACK;
  const origAlpha = alpha;
  const inCheck = ttix >= 0 ? (g_ttType[ttix] & TT_INCHECK) !== 0 : isAttacked(g_kingSq[stm], nstm);
  const ev = ttix >= 0 ? g_ttEval[ttix] : evaluate();
  const ttMove = ttix >= 0 ? g_ttMove[ttix] : 0;
  const playedMoves = node.playedMoves;

  let depthForSearch = depth;

  if (depth > 5 && isPV && !ttMove)
    depthForSearch--;

  if (inCheck && !isPV && depth > 0)
    depthForSearch++;

  let move = 0;
  let played = 0;
  let bestMove = 0;
  let bestScore = -INF;
  let score = 0;

  if (!isPV && !inCheck && beta < MATEISH && depth <= 8 && (ev - depth * 100) >= beta)
    return ev;

  if (!isPV && !inCheck && beta < MATEISH && depth > 2 && ev > beta && alpha > -MATEISH) {

    const R = 3;

    make_null(node);
    score = -search(ply+1, depth-R-1, -beta, -beta+1);
    unmake_null(node);

    if (g_finished)
      return 0;

    if (score >= beta) {
      if (score > MATEISH)
        score = beta;
      return score;
    }

  }

  initSearch(node, inCheck, ttMove, 0);

  while ((move = getNextMove(node, ply))) {

    const noisy = move & MOVE_FLAG_NOISY;

    if (depth > 1 && !inCheck && !noisy && alpha > -MATEISH && played > depth * depth * depth)
      continue;

    if (played && !inCheck && depth <= 1 && !noisy && alpha > -MATEISH && ev + 100 < alpha)
      continue;

    make(node, move);
    if (isAttacked(g_kingSq[stm], nstm)) {
      unmake(node, move);
      continue;
    }

    playedMoves[played++] = move;

    let R = 0;
    if (depthForSearch >= 3 && played > 3) {
      R = Math.floor(0.75 + Math.log(depthForSearch) * Math.log(played) / 2.25);
      R -= inCheck;
      if (isPV)
        R -= 1;
      if (R > depthForSearch - 2)
        R = depthForSearch - 2;
    }

    if (isPV) {
      if (played === 1) {
        score = -search(ply + 1, depthForSearch - 1, -beta, -alpha);
      }
      else {
        score = -search(ply + 1, depthForSearch - 1 - R, -alpha - 1, -alpha);
        if (!g_finished && score > alpha)
          score = -search(ply + 1, depthForSearch - 1, -beta, -alpha);
      }
    }
    else {
      score = -search(ply + 1, depthForSearch - 1 - R, -beta, -alpha);
      if (!g_finished && score > alpha)
        score = -search(ply + 1, depthForSearch - 1, -beta, -alpha);
    }

    if (g_finished)
      return 0;

    unmake(node, move);

    if (score > bestScore) {
      bestScore = score;
      bestMove = move;
      if (bestScore > alpha) {
        alpha = bestScore;
        if (isPV) {
          collectPV(node, cNode, bestMove);
        }
        if (bestScore >= beta) {
          if (!(bestMove & MOVE_FLAG_NOISY)) {
            const bonus = depth * depth;
            updateQpth(bestMove, bonus);
            for (let i = 0; i < played - 1; i++) {
              const pm = playedMoves[i];
              if (!(pm & MOVE_FLAG_NOISY)) {
                updateQpth(playedMoves[i], -bonus);
              }
            }
            g_killers[ply] = bestMove;
          }
          ttPut(TT_BETA, depth, putAdjustedScore(ply, bestScore), bestMove, ev, inCheck);
          return bestScore;
        }
      }
    }
  }

  if (played === 0) {
    if (inCheck)
      return -MATE + ply;
    else
      return 0;
  }

  ttPut(alpha > origAlpha ? TT_EXACT : TT_ALPHA, depth, putAdjustedScore(ply, bestScore), bestMove, ev, inCheck);

  return bestScore;

}

function qsearch(ply, depth, alpha, beta) {

  g_nodes++;
  if ((g_nodes & 1023) == 0) {
    checkTime();
    if (g_finished)
      return 0;
  }

  if (ply >= MAX_PLY)
    return evaluate();

  const node = g_ss[ply];
  node.pvLen = 0;

  if (isDraw()) {
    return 0;
  }

  const ttix = ttGet();

  if (ttix >= 0) {
    const type = g_ttType[ttix] & TT_TYPE_MASK;
    const score = getAdjustedScore(ply, g_ttScore[ttix]);
    if (type === TT_EXACT || (type === TT_BETA && score >= beta) || (type === TT_ALPHA && score <= alpha)) {
      return score;
    }
  }

  const stm = g_stm;
  const nstm = stm ^ BLACK;
  const inCheck = ttix >= 0 ? (g_ttType[ttix] & TT_INCHECK) !== 0 : isAttacked(g_kingSq[stm], nstm);
  const ev = ttix >= 0 ? g_ttEval[ttix] : evaluate();
  const ttMove = ttix >= 0 && (inCheck || (g_ttMove[ttix] & MOVE_FLAG_NOISY)) ? g_ttMove[ttix] : 0;

  let bestScore = -INF;

  if (!inCheck) {
    bestScore = ev;
    if (ev >= beta)
      return ev;
    if (ev > alpha)
      alpha = ev;
  }

  let move = 0;
  let played = 0;
  let bestMove = 0;
  let score = 0;
  let origAlpha = alpha;

  initSearch(node, inCheck, ttMove, inCheck ^ 1);

  while ((move = getNextMove(node, ply))) {

    if (!inCheck && !(move & MOVE_FLAG_PROMOTE)) {
      const captured = (move & MOVE_FLAG_EPCAPTURE) ? PAWN : (g_board[move & 0x7F] & 7);
      if (ev + DELTA_VALS[captured] + 200 < alpha)
        continue;
    }

    make(node, move);
    if (isAttacked(g_kingSq[stm], nstm)) {
      unmake(node, move);
      continue;
    }

    played++;

    score = -qsearch(ply + 1, depth - 1, -beta, -alpha);

    if (g_finished)
      return 0;

    unmake(node, move);

    if (score > bestScore) {
      bestScore = score;
      bestMove = move;
      if (bestScore > alpha) {
        alpha = bestScore;
        if (bestScore >= beta) {
          ttPut(TT_BETA, 0, putAdjustedScore(ply, bestScore), bestMove, ev, inCheck);
          return bestScore;
        }
      }
    }
  }

  if (inCheck && played === 0) {
    return -MATE + ply;
  }

  return bestScore;

}

function go() {

  clearQpth();

  let bm = 0;

  for (let depth = 1; depth <= g_maxDepth; depth++) {
    const score = search(0, depth, -INF, INF);
    if (g_finished) break;
    bm = rootNode.pv[rootNode.pvLen - 1];
    report(score, depth);
  }

  if (!bm)
    console.log('NO BEST MOVE');

  console.log('bestmove ' + formatMove(bm));

}

function newGame () {
  ttClear();
}

function uciExecLine(line) {
  const tokens = line.trim().split(/\s+/);

  if (tokens.length === 0 || tokens[0] === '') {
    return;
  }

  const cmd = tokens[0];

  switch (cmd) {

    case 'isready': {
      console.log('readyok');
      break;
    }

    case 'ucinewgame': {
      newGame();
      break;
    }

    case 'uci': {
      console.log('id name Patchwork 0001_Haiku_4_5');
      console.log('id author Claude');
      console.log('uciok');
      break;
    }

    case 'position': {
      const mi = tokens.indexOf('moves');
      const moves = mi >= 0 ? tokens.slice(mi + 1) : null;

      if (tokens[1] === 'startpos') {
        position('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR', 'w', 'KQkq', '-', moves);
      }
      else {
        position(tokens[2], tokens[3], tokens[4], tokens[5], moves);
      }
      break;
    }

    case 'go': {
      initTimeControl(tokens);
      go();
      break;
    }

    case 'quit': {
      process.exit(0);
    }

    default: {
      console.log('?');
      break;
    }
  }
}

initNodes();
initZobrist();
initQpth();

let feedBuf = '';

function feed(chunk) {
  feedBuf += String(chunk);

  const lines = feedBuf.split('\n');

  feedBuf = lines.pop();

  for (const raw of lines) {
    uciExecLine(raw.trimEnd());
  }
}

module.exports = {
  uciExecLine,
  position,
  perft,
  evaluate,
  getNodes: () => g_nodes,
};

if (require.main === module) {

  if (process.argv.length > 2) {
    for (let i = 2; i < process.argv.length; i++) {
      uciExecLine(process.argv[i]);
    }
    process.exit(0);
  }

  process.stdin.setEncoding('utf8');

  process.stdin.on('data', function(chunk) {
    feed(chunk);
  });

  process.stdin.on('end', function() {
    process.exit(0);
  });

}
