#!/usr/bin/node

//
// Patchwork — a UCI chess engine in pure Node.js, no dependencies, no build step.
//
// Single-file, all-globals design: every function and table is at module scope
// and mutates shared g_* globals. There are no classes (one constructor —
// nodeStruct — for per-ply search state). The CommonJS exports at the bottom
// (uciExecLine, position, perft, evaluate, getNodes) are a thin surface for
// the bench.js / perft.js / eval.js drivers; the engine itself does not call
// into them.
//
// Roughly top-to-bottom: constants → board state globals → Zobrist hashing →
// transposition table → per-ply node struct → board setup → attack detection
// → make / unmake → move generation → move ordering → perft → time control →
// evaluation → search / qsearch → UCI driver → bottom-of-file init.
//

const INF = 31000;
const MATE = 30000;
const MATEISH = 29000;
const MAX_MOVES = 256;
const MAX_PLY = 64;

//
// Piece encoding. Low 3 bits are the piece type (PAWN=1 .. KING=6), bit 3 is
// the colour (WHITE=0, BLACK=8). So `piece & 7` extracts the type and
// `piece & 8` (or `piece & BLACK`) extracts the colour. The Wxxx / Bxxx
// macros below are the combined values. Tables that index by piece (PSTs,
// Zobrist) are sized `15 * 128` and indexed as `piece * 128 + sq` so the
// colour bit is part of the index.
//

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

//
// Move encoding. A move is a single 32-bit int:
//   bits 0..6   = to square (0x88-indexed)
//   bits 7..13  = from square (0x88-indexed)
//   bits 14..17 = flags (CAPTURE / EPCAPTURE / CASTLE / PROMOTE)
//   bits 20+    = promotion piece type (KNIGHT..QUEEN), when PROMOTE is set
// MOVE_FLAG_NOISY = PROMOTE|CAPTURE is the "is this a tactical move" test
// used by qsearch entry, move ordering, LMR, and futility/late-move pruning.
//

const MOVE_FLAG_CAPTURE = 1 << 14;
const MOVE_FLAG_EPCAPTURE = 2 << 14;  // will also have MOVE_FLAG_CAPTURE set
const MOVE_FLAG_CASTLE = 4 << 14;
const MOVE_FLAG_PROMOTE = 8 << 14; // may also have MOVE_FLAG_CAPTURE set
const MOVE_FLAG_SPECIAL = MOVE_FLAG_PROMOTE | MOVE_FLAG_EPCAPTURE | MOVE_FLAG_CASTLE;
const MOVE_FLAG_NOISY = MOVE_FLAG_PROMOTE | MOVE_FLAG_CAPTURE;
const PROMOTE_SHIFT = 20; // KNIGHT, BISHOP, ROOK, QUEEN

const RIGHTS_TABLE = new Uint8Array(128);
RIGHTS_TABLE.fill(15);
RIGHTS_TABLE[0x00] = 15 & ~WHITE_RIGHTS_QUEEN;                        // a1
RIGHTS_TABLE[0x04] = 15 & ~(WHITE_RIGHTS_KING | WHITE_RIGHTS_QUEEN);  // e1
RIGHTS_TABLE[0x07] = 15 & ~WHITE_RIGHTS_KING;                         // h1
RIGHTS_TABLE[0x70] = 15 & ~BLACK_RIGHTS_QUEEN;                        // a8
RIGHTS_TABLE[0x74] = 15 & ~(BLACK_RIGHTS_KING | BLACK_RIGHTS_QUEEN);  // e8
RIGHTS_TABLE[0x77] = 15 & ~BLACK_RIGHTS_KING;                         // h8

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

//
// 0x88 board. g_board has 128 entries; on-board squares are 0x00..0x77 with
// the low nibble = file (0..7) and the high nibble = rank (0..7). Off-board
// squares have bit 0x88 set, so `if (sq & 0x88)` is the standard off-board
// test. Loops over the board use `for (sq = 0; sq < 128; sq++) { if (sq & 0x88)
// { sq += 7; continue; } ... }` to skip the off-board half.
//
// There is no piece list — move generation, evaluation, isDraw all walk
// g_board directly. The only piece location tracked outside g_board is the
// king square: g_kingSq[colour] is kept in sync by make / unmake so the
// in-check test `isAttacked(g_kingSq[stm], nstm)` is cheap.
//
// All board state below (g_stm, g_rights, g_ep, g_loHash, g_hiHash, g_kingSq)
// is mutated incrementally by make / unmake — there is no copy-make.
//

const g_board = new Uint8Array(128);
const g_kingSq = new Uint8Array(16); // king square indexed by colour (WHITE=0 or BLACK=8)
let g_stm = 0;
let g_rights = 0;
let g_ep = 0;
let g_loHash = 0;
let g_hiHash = 0;

// time control globals

let g_nodes = 0; // node counter (init to 0)
let g_maxNodes = 0; // node target if given (else 0)
let g_maxDepth = 0; // target depth if given (set to MAX_PLY otherwise)
let g_startTime = 0; // always set via now()
let g_finishTime = 0; // finish time if appropriate (else 0)
let g_finished = 0; // 1 when time/nodes reached (else 0)

function now() {
  return performance.now() | 0;
}

//
// Zobrist hashing. JS has no native 64-bit integer, so a 64-bit Zobrist hash
// is split into two independent 32-bit halves (g_loHash / g_hiHash) with
// parallel tables (g_loPieces / g_hiPieces, g_loRights / g_hiRights, g_loEP /
// g_hiEP, plus side-to-move toggles g_loStm / g_hiStm). XOR updates run on
// each half independently. Tables are seeded once at load via Mulberry32
// from g_seed.
//
// position() builds the hash from scratch; make / unmake update it
// incrementally and push prior hashes onto the g_loHH / g_hiHH stack so
// isDraw can detect repetition.
//

let g_seed = 1;

let g_loStm = 0;
let g_hiStm = 0;

const g_loPieces = Array(15);
const g_hiPieces = Array(15);

const g_loRights = new Int32Array(16);
const g_hiRights = new Int32Array(16);

const g_loEP = new Int32Array(128);
const g_hiEP = new Int32Array(128);

function rand32(seed) { // Mulberry32
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

//
// Transposition table. Struct-of-arrays for cache friendliness — seven
// parallel typed arrays of TT_SIZE = 2^TT_BITS entries (~1M entries, ~18 MB).
// The arrays are sized as top-level consts so the allocation happens at load
// time. Lookup is by `g_loHash & TT_MASK` with both halves of the hash
// verified on hit.
//
// The type byte packs the bound kind (TT_EXACT / TT_ALPHA / TT_BETA in the
// low 2 bits, masked by TT_TYPE_MASK) plus a TT_INCHECK flag in bit 2 — this
// lets search skip the relatively expensive isAttacked() call on TT hits and
// restore in-check state without recomputing.
//

const TT_EXACT = 1;
const TT_ALPHA = 2;
const TT_BETA = 3;
const TT_TYPE_MASK = 3;
const TT_INCHECK = 4;

const TT_BITS = 20;
const TT_SIZE = 1 << TT_BITS;  // 1,048,576 entries × 18 bytes ≈ 18 MB
const TT_MASK = TT_SIZE - 1;

const g_ttLoHash = new Int32Array(TT_SIZE); // 4 bytes
const g_ttHiHash = new Int32Array(TT_SIZE); // 4 bytes
const g_ttType   = new Uint8Array(TT_SIZE); // 1 byte  (bound type + TT_INCHECK flag)
const g_ttDepth  = new Int8Array(TT_SIZE);  // 1 byte
const g_ttMove   = new Uint32Array(TT_SIZE);// 4 bytes
const g_ttEval   = new Int16Array(TT_SIZE); // 2 bytes
const g_ttScore  = new Int16Array(TT_SIZE); // 2 bytes

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

//
// Mate scores are stored ply-relative in the TT and unwound on retrieval so
// "mate in N" stays correct regardless of which ply the score came from.
//

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

//
// Per-ply search state. One nodeStruct is allocated for each of MAX_PLY plies
// (g_ss[0..MAX_PLY-1]) at init and then reused. It holds the move list, the
// per-move ranks for ordering, the played-moves trail (for history bonus /
// malus on beta cutoff), the move-iterator state (stage / nextMove / ttMove
// / inCheck / noisyOnly), the principal variation collected at this ply, and
// the undo fields the matching unmake call needs to restore exactly.
//

function nodeStruct() {

  this.numMoves = 0;
  this.moves = new Uint32Array(MAX_MOVES);
  this.ranks = new Int32Array(MAX_MOVES);
  this.playedMoves = new Uint32Array(MAX_MOVES); // for applying penalties on beta cutoff
  this.nextMove = 0; // for move iterator
  this.ttMove = 0;  // for move iterator
  this.inCheck = 0; // for move iterator (gen castling moves when not in check)
  this.noisyOnly = 0; // for move iterator (qsearch skips quiets)
  this.stage = 0; // for move iterator
  this.pv = new Uint32Array(MAX_MOVES);
  this.pvLen = 0;
  this.undoRights = 0; // undo* for unmake()
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
charPiece[80] = WPAWN;    // P
charPiece[78] = WKNIGHT;  // N
charPiece[66] = WBISHOP;  // B
charPiece[82] = WROOK;    // R
charPiece[81] = WQUEEN;   // Q
charPiece[75] = WKING;    // K
charPiece[112] = BPAWN;   // p
charPiece[110] = BKNIGHT; // n
charPiece[98] = BBISHOP;  // b
charPiece[114] = BROOK;   // r
charPiece[113] = BQUEEN;  // q
charPiece[107] = BKING;   // k

function position(boardStr, stmStr, rightsStr, epStr, moves) {

  g_hhNext = 0;
  g_hmClock = 0;

  g_board.fill(0);

  let rank = 7;
  let file = 0;

  for (let i = 0; i < boardStr.length; i++) {
    const cc = boardStr.charCodeAt(i);
    if (cc === 47) { // /
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
    if (cc === 75)       // K
      g_rights |= WHITE_RIGHTS_KING;
    else if (cc === 81)  // Q
      g_rights |= WHITE_RIGHTS_QUEEN;
    else if (cc === 107) // k
      g_rights |= BLACK_RIGHTS_KING;
    else if (cc === 113) // q
      g_rights |= BLACK_RIGHTS_QUEEN;
  }

  if (epStr === '-')
    g_ep = 0;
  else
    g_ep = (epStr.charCodeAt(1) - 49) * 16 + (epStr.charCodeAt(0) - 97);

  // find king squares

  const b = g_board;

  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) { sq += 7; continue; }
    const piece = b[sq];
    if (!piece) continue;
    if ((piece & 7) === KING)
      g_kingSq[piece & BLACK] = sq;
  }

  // init hash

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

  // pawn

  const pawnDir = byColour === WHITE ? -16 : 16;
  const pawnPiece = PAWN | byColour;

  for (let i = -1; i <= 1; i += 2) {
    const from = sq + pawnDir + i;
    if (!(from & 0x88) && b[from] === pawnPiece)
      return 1;
  }

  // knight

  const knightPiece = KNIGHT | byColour;

  for (let i = 0; i < 8; i++) {
    const from = sq + KNIGHT_OFFSETS[i];
    if (!(from & 0x88) && b[from] === knightPiece)
      return 1;
  }

  // king

  const kingPiece = KING | byColour;

  for (let i = 0; i < 8; i++) {
    const from = sq + KING_OFFSETS[i];
    if (!(from & 0x88) && b[from] === kingPiece)
      return 1;
  }

  // diagonal rays (bishop, queen)

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

  // orthogonal rays (rook, queen)

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

//
// Repetition and draw bookkeeping. g_loHH / g_hiHH is a stack of prior hashes,
// pushed by make / make_null and popped by unmake / unmake_null; g_hhNext is
// the next slot. g_hmClock counts halfmoves since the last irreversible move
// (pawn push or capture) — pawn moves and captures reset it to 0, position()
// resets both. isDraw only walks the history back as far as g_hmClock — once
// you cross an irreversible move you cannot repeat.
//
// Note: isDraw treats 2-fold repetition as a draw, not 3-fold. This is
// load-bearing inside search (more aggressive draw avoidance) and should not
// be relaxed casually.
//

const g_loHH = new Int32Array(1024);
const g_hiHH = new Int32Array(1024);
let g_hhNext = 0;
let g_hmClock = 0;

function isDraw() {

  // 50-move rule

  if (g_hmClock >= 100)
    return 1;

  // 2-fold repetition

  const lo = g_loHash;
  const hi = g_hiHash;
  const stop = g_hhNext - g_hmClock;
  for (let i = g_hhNext - 2; i >= 0 && i >= stop; i -= 2) {
    if (g_loHH[i] === lo && g_hiHH[i] === hi)
      return 1;
  }

  // insufficient material - count non-king pieces by type

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
      else bHeavy++; // rook or queen
    }
    else {
      if (t === PAWN) wPawns++;
      else if (t === KNIGHT) wKnights++;
      else if (t === BISHOP) { wBishops++; wBishopSq = sq; }
      else wHeavy++;
    }
  }

  // any pawn or major piece means there is enough material
  if (wPawns || bPawns || wHeavy || bHeavy)
    return 0;

  const wMinor = wKnights + wBishops;
  const bMinor = bKnights + bBishops;

  // KvK
  if (wMinor === 0 && bMinor === 0) return 1;
  // K + single minor vs K
  if (wMinor + bMinor === 1) return 1;
  // KN vs KN
  if (wKnights === 1 && bKnights === 1 && wBishops === 0 && bBishops === 0) return 1;
  // KB vs KB on same-coloured squares
  if (wBishops === 1 && bBishops === 1 && wKnights === 0 && bKnights === 0) {
    if (((wBishopSq ^ (wBishopSq >> 4)) & 1) === ((bBishopSq ^ (bBishopSq >> 4)) & 1))
      return 1;
  }
  // KNN vs K
  if (bMinor === 0 && wKnights === 2 && wBishops === 0) return 1;
  if (wMinor === 0 && bKnights === 2 && bBishops === 0) return 1;

  return 0;

}

//
// make / unmake invariants. make() mutates g_board, g_stm, g_rights, g_ep,
// g_kingSq, g_loHash / g_hiHash, g_hmClock, and pushes the prior hash onto
// the history stack. It stores enough into the passed-in node (undoRights /
// undoEp / undoCaptured / undoLoHash / undoHiHash / undoHmClock) for unmake
// to invert the operation exactly — there is no copy-make.
//
// Three special cases tagged via MOVE_FLAG_SPECIAL: PROMOTE, EPCAPTURE,
// CASTLE. Everything else (quiet moves and normal captures) takes the fast
// path at the bottom of make.
//
// make_null / unmake_null support null-move pruning in search: they toggle
// the side to move, clear EP, and push/pop the hash without otherwise
// touching the board.
//

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

  // hash: update rights

  g_loHash ^= g_loRights[g_rights];
  g_hiHash ^= g_hiRights[g_rights];
  g_rights &= RIGHTS_TABLE[fr] & RIGHTS_TABLE[to];
  g_loHash ^= g_loRights[g_rights];
  g_hiHash ^= g_hiRights[g_rights];

  // hash: remove old ep

  if (g_ep) {
    g_loHash ^= g_loEP[g_ep];
    g_hiHash ^= g_hiEP[g_ep];
  }
  g_ep = 0;

  // hash: toggle stm

  g_loHash ^= g_loStm;
  g_hiHash ^= g_hiStm;

  // king tracking (king is the moving piece in a normal king move or castle;
  // promotions and ep captures are pawn moves so never touch a king)
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

    // castle - move king then move rook

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

  // quiet move or normal capture

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

  // stm was flipped by make; the mover's colour is g_stm ^ BLACK
  const stm = g_stm ^ BLACK;

  // king tracking: if a king is now at `to` it moved this turn — restore to `fr`
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

      // castle - move king back, move rook back
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

    // quiet move or normal capture
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

//
// Move generation. Three pseudo-legal generators, mutually exclusive in what
// they emit:
//   genNoisy    — captures (including en passant) and promotions
//   genQuiets   — non-captures excluding promotions
//   genCastling — castling moves only (separate so qsearch can skip them)
// Each appends to node.moves and updates node.numMoves. None of them filter
// for own-king-in-check legality — the caller (search / qsearch / perft) is
// responsible for making the move, testing isAttacked(g_kingSq[stm], nstm),
// and unmaking if illegal.
//

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

        // push promotions

        if (!b[to1] && (to1 & 0x70) === promoteR) {
          moves[numMoves++] = from | to1 | MOVE_FLAG_PROMOTE | (QUEEN  << PROMOTE_SHIFT);
          moves[numMoves++] = from | to1 | MOVE_FLAG_PROMOTE | (ROOK   << PROMOTE_SHIFT);
          moves[numMoves++] = from | to1 | MOVE_FLAG_PROMOTE | (BISHOP << PROMOTE_SHIFT);
          moves[numMoves++] = from | to1 | MOVE_FLAG_PROMOTE | (KNIGHT << PROMOTE_SHIFT);
        }

        // captures

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

        // single push (non-promote)

        if (!b[to1] && (to1 & 0x70) !== promoteR) {

          moves[numMoves++] = from | to1;

          // double push

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

//
// Quiet move history ("quiet piece-to history"). g_qpth[piece][to] is a
// per-piece, per-target-square score used to order quiet moves. On a beta
// cutoff by a quiet move, that move gets `+depth*depth` and the earlier
// quiet moves that didn't cut off get `-depth*depth` via updateQpth.
//
// There is no separate killer-move table — quiet ordering rides entirely on
// this history. clearQpth runs at the start of each `go` so scores do not
// persist across UCI search invocations.
//

const g_qpth = Array(15); // quiet piece to history

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

function rankQuiets(node) {

  const b = g_board;
  const moves = node.moves;
  const ranks = node.ranks;
  const n = node.numMoves;

  for (let i=0; i < n; i++) {

    const m = moves[i];
    const fr = (m >> 7) & 0x7F;
    const to = m & 0x7F;
    const piece = b[fr];

    ranks[i] = g_qpth[piece][to];

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

//
// Move ordering stage machine. getNextMove walks node.stage:
//   0  return the TT move if present
//   1  generate noisy moves, rank them MVV/LVA-ish via rankNoisy, fall
//      through to stage 2
//   2  drain best-ranked noisy move; with noisyOnly=1 (qsearch outside
//      check) stop here
//   3  generate quiet moves and castling, rank quiets by g_qpth history,
//      fall through to stage 4
//   4  drain best-ranked quiet move
// The case fall-throughs are deliberate — stages 1 and 3 set up the list
// and immediately serve the first move from it.
//
// Caller must initSearch(node, inCheck, ttMove, noisyOnly) before the first
// call. removeTTMove deduplicates the TT move out of the freshly generated
// list since stage 0 already returned it.
//

function getNextMove(node) {

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
      rankQuiets(node);

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
  const inCheck = isAttacked(g_kingSq[stm], nstm); // to exercise the move iterator

  let move = 0;
  let total = 0;

  initSearch(node, inCheck, 0, 0);

  while ((move = getNextMove(node))) {

    make(node, move);
    if (!isAttacked(g_kingSq[stm], nstm))
      total += perft(ply + 1, depth - 1);
    unmake(node, move);
  }

  return total;
}

//
// Time control. initTimeControl parses UCI `go` params (depth/d, nodes,
// movetime, infinite, ponder, wtime/btime/winc/binc/movestogo) into one of:
// fixed depth, fixed nodes, fixed movetime, or time-and-increment. The
// time-and-increment branch budgets `myTime/movestogo + myInc` capped at
// half the remaining time.
//
// Mid-search, search and qsearch call checkTime every 1024 nodes (the
// `g_nodes & 1023` gate). On expiry it sets g_finished, which is the
// universal abort flag — every caller in the recursion checks g_finished
// after a recursive call and returns 0 without trusting the score when set.
//

function checkTime() {

    if (g_finishTime && now() >= g_finishTime)
      g_finished = 1;
    
    if (g_maxNodes && g_nodes >= g_maxNodes)
      g_finished = 1;
      
}

function initTimeControl(tokens) {

  // defaults

  g_nodes = 0;
  g_maxNodes = 0;
  g_maxDepth = MAX_PLY;
  g_startTime = now();
  g_finishTime = 0;
  g_finished = 0;

  // parse go params into a map

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

  // fixed depth

  if (params.depth) {
    g_maxDepth = params.depth;
    return;
  }
  if (params.d) {
    g_maxDepth = params.d;
    return;
  }

  // fixed nodes

  if (params.nodes) {
    g_maxNodes = params.nodes;
    return;
  }

  // fixed move time

  if (params.movetime) {
    g_finishTime = g_startTime + params.movetime;
    return;
  }

  // infinite or ponder - no limits

  if (params.infinite || params.ponder) {
    return;
  }

  // time + inc based

  const wtime = params.wtime || 0;
  const btime = params.btime || 0;
  const winc = params.winc || 0;
  const binc = params.binc || 0;
  const movestogo = Math.max(params.movestogo || 20, 2);

  const myTime = g_stm === WHITE ? wtime : btime;
  const myInc = g_stm === WHITE ? winc : binc;

  const alloc = myTime / movestogo + myInc;

  // don't use more than half the remaining time

  const limit = myTime / 2;

  const ms = Math.max(Math.min(alloc, limit), 1);

  g_finishTime = g_startTime + ms;

}
//
// Evaluation. evaluate() returns a centipawn score from the side-to-move
// perspective (positive = side to move is winning). It walks g_board once,
// accumulating mg/eg PST contributions per colour and a phase total from
// PHASE_INC (knight/bishop=1, rook=2, queen=4, clamped to 24). The final
// score is tapered: `(mgScore*mgPhase + egScore*egPhase) / 24`.
//
// Two PSTs (mgPST, egPST), each 15*128 Int16, are built once by initEval
// from compact 8x8 source tables. White / black indexing flips the rank so
// the same source table works for both colours. initEval is called at the
// bottom of this section so the tables are populated at load time.
//
// The baseline is Tomasz Michniewski's Simplified Evaluation Function: PST
// + material, with mg/eg tables identical for every piece except the king.
// There are no pawn-structure, mobility, or king-safety terms.
//

const mgPST = new Int16Array(15 * 128);
const egPST = new Int16Array(15 * 128);

const PHASE_INC = new Uint8Array(7);
PHASE_INC[KNIGHT] = 1;
PHASE_INC[BISHOP] = 1;
PHASE_INC[ROOK]   = 2;
PHASE_INC[QUEEN]  = 4;

function initEval() {

  // material values indexed by piece type (PAWN=1 .. KING=6)
  const matVal = [0, 100, 320, 330, 500, 900, 0];

  // raw 8x8 PSTs, row 0 = rank 8 (black's back rank), row 7 = rank 1
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

  // index per piece type: 0 unused, PAWN..QUEEN identical for mg/eg, only king differs
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
        const wIdx = (7 - rank) * 8 + file; // white sees rank 1 at row 7
        const bIdx = rank * 8 + file;       // black sees rank 8 at row 0
        mgPST[wBase + sq88] = v + mgT[wIdx];
        egPST[wBase + sq88] = v + egT[wIdx];
        mgPST[bBase + sq88] = v + mgT[bIdx];
        egPST[bBase + sq88] = v + egT[bIdx];
      }
    }
  }
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

  // tapered eval
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

//
// Search. Negamax with PVS (principal variation search). go() drives plain
// iterative deepening — search(0, depth, -INF, INF) per depth, no aspiration
// windows. search recurses into itself for non-leaf nodes and into qsearch
// when depth <= 0.
//
// Pruning and reduction features (the gating conditions are load-bearing —
// the !isPV && !inCheck && score-against-MATEISH guards keep mate scores
// from corrupting):
//   - TT cutoff (non-PV only). TT moves are trusted without legality
//     re-validation; a Zobrist collision producing an illegal move is
//     astronomically unlikely and is not defended against.
//   - Mate distance pruning.
//   - Static beta pruning, null-move pruning (R=3), late-move pruning,
//     futility pruning — all !isPV && !inCheck, score-bounded.
//   - Late move reductions, inline:
//       R = floor(0.75 + log(depth) * log(played) / 2.25)
//       then -inCheck, -isPV, clamped to depth - 2.
//   - IID-ish PV reduction when no TT move: depth>5 && isPV && !ttMove → d--.
//   - Quiet history bonus/malus on beta cutoff (via updateQpth). No separate
//     killer-move table.
//

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
  
  // mate distance pruning
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

  if (depth > 5 && isPV && !ttMove)
    depth--;

  let move = 0;
  let played = 0;
  let bestMove = 0;
  let bestScore = -INF;
  let score = 0;
  
  // beta pruning
  if (!isPV && !inCheck && beta < MATEISH && depth <= 8 && (ev - depth * 100) >= beta)
    return ev;

  // null move pruning
  if (!isPV && !inCheck && beta < MATEISH && depth > 2 && ev > beta) {
  
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

  while ((move = getNextMove(node))) {

    const noisy = move & MOVE_FLAG_NOISY;

    // late move pruning
    if (depth > 1 && !inCheck && !noisy && alpha > -MATEISH && played > depth * depth * depth)
      continue;

    // futility pruning
    if (played && !inCheck && depth <= 1 && !noisy && alpha > -MATEISH && ev + 100 < alpha)
      continue;

    make(node, move);
    if (isAttacked(g_kingSq[stm], nstm)) {
      unmake(node, move);
      continue;
    }

    playedMoves[played++] = move;

    // late move reductions
    let R = 0;
    if (depth >= 3 && played > 3) {
      R = Math.floor(0.75 + Math.log(depth) * Math.log(played) / 2.25);
      R -= inCheck;
      if (isPV)
        R -= 1;
      if (R > depth - 2)
        R = depth - 2;
    }

    if (isPV) {
      if (played === 1) {
        score = -search(ply + 1, depth - 1, -beta, -alpha);
      }
      else {
        score = -search(ply + 1, depth - 1 - R, -alpha - 1, -alpha);
        if (!g_finished && score > alpha)
          score = -search(ply + 1, depth - 1, -beta, -alpha);
      }  
    }
    else {
      score = -search(ply + 1, depth - 1 - R, -beta, -alpha);
      if (!g_finished && score > alpha)
        score = -search(ply + 1, depth - 1, -beta, -alpha);
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

//
// Quiescence search. Recurses on noisy moves only (captures + promotions)
// to settle tactics at the leaves of the main search. When not in check we
// stand pat on the static eval — if `ev >= beta` we return immediately,
// otherwise alpha is raised to ev. When in check we generate all moves
// (escapes) and there is no stand-pat. Delta pruning skips clearly losing
// captures.
//

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

  while ((move = getNextMove(node))) {

    // delta pruning

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

  //ttPut(alpha > origAlpha ? TT_EXACT : TT_ALPHA, 0, putAdjustedScore(ply, bestScore), bestMove, ev);

  return bestScore;

}

function go() {

  clearQpth();

  let bm = 0; // best move from last completed iteration

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
      console.log('id name Patchwork');
      console.log('id author Colin Jenkins');
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

