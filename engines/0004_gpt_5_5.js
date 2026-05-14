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
// → SEE → make / unmake → move generation → move ordering → perft → time
// control → evaluation → search / qsearch → UCI driver → bottom-of-file init.
//
// [Sonnet 4.6] Engine: 0002_Sonnet_4_6 — aspiration windows, 2 killers,
// countermove table, enhanced eval (pawn structure + bishop pair + rook files),
// LMR skip captures/promotions.
//
// [Opus 4.7] Engine: 0003_Opus_4_7 — built on top of 0002_Sonnet_4_6 with the
// following improvements (every change in this file is marked with
// "[Opus 4.7]" so a diff against 0002 is easy to read):
//
//   Search:
//     * Static Exchange Evaluator (SEE) — seeGE() decides whether a capture
//       sequence at the target square yields >= threshold material for the
//       side to move. Used to:
//         (a) skip captures with SEE < 0 inside qsearch (filters losing
//             captures out of the qsearch tree at non-check nodes)
//         (b) rank bad-SEE captures behind quiets in move ordering
//         (c) prune obviously losing captures at shallow main-search depth
//     * Counter-move history (CMH) — quiet-move ordering uses a per-(prev
//       piece, prev to-sq, this piece, this to-sq) score in addition to the
//       plain piece-to history. Continuation history captures "given the
//       opponent just played X, this reply was good".
//     * Improving heuristic — track per-ply static eval; "improving" means
//       eval(ply) > eval(ply-2). Used to relax LMR and RFP when improving.
//     * Better LMR formula — log-based base, with adjustments for isPV,
//       improving, in-check, history score.
//     * Reverse-futility-pruning margin tightens when improving.
//     * Larger TT: 2^21 entries (~36 MB) for better hit rate at long games.
//     * History gravity — bonus formula caps history values, prevents
//       saturation. Each update applies `bonus - h * |bonus| / max`.
//     * Aspiration windows start tighter (±15cp) with smaller growth (×4/3).
//
//   Evaluation:
//     * Piece mobility — knight, bishop, rook, queen mobility counts
//       contribute mg/eg scores. Computed inline in the main board scan so
//       the cost is one extra inner loop per slider (cheap).
//     * Knight outposts — knight on rank 4-6, supported by friendly pawn,
//       not attackable by an enemy pawn → bonus.
//     * Tempo bonus — +10 cp (mg) for the side to move at end of evaluate.
//     * Improved king safety — pawn shield score for kings on the back two
//       ranks; pawns in the three files in front of the king and one rank
//       up are credited.
//     * Connected/protected passed pawn bonus — if a passed pawn has a
//       friendly pawn supporting it, the passed-pawn bonus is increased.
//
//   Time management:
//     * Per-move "overhead" reserve subtracted from the allocation so we do
//       not lose on time when the host's tc margin is tight.
//
// All correctness-critical code (move generation, make/unmake, zobrist,
// attack detection, draw rules) is unchanged from 0002 so perft results
// match exactly.
//
// [GPT-5.5] Engine: 0004_GPT_5_5 — started from 0003_Opus_4_7 and keeps its
// correctness-critical board core intact. Strength changes in this file are
// tagged "[GPT-5.5]" and focus on safer table retention and preserving
// forcing checks during late-move reductions:
//
//   Search:
//     * Depth-preferred TT replacement so a shallow collision does not evict
//       a useful deeper entry.
//     * Check-aware LMR: legal quiet moves that give check are reduced one ply
//       less, preserving forcing checks without changing move legality.
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

// [Opus 4.7] TT bumped from 2^20 to 2^21 entries (~36 MB). At 10+0.1 long
// searches still see ~1-5M nodes per move; the extra capacity reduces
// collision rate without bloating the allocation past comfortable limits.
const TT_BITS = 21;
const TT_SIZE = 1 << TT_BITS;  // 2,097,152 entries × 18 bytes ≈ 36 MB
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

  // [GPT-5.5] Depth-preferred replacement. 0003 always overwrote the indexed
  // slot, which is simple but lets a shallow leaf collision erase a much more
  // valuable deep entry from the current game. Keep an unrelated entry when it
  // is at least three plies deeper than the value we are about to store. Exact
  // same-position updates still replace normally so newer bounds and moves for
  // this hash are not stranded.
  if (g_ttType[idx] && (g_ttLoHash[idx] !== g_loHash || g_ttHiHash[idx] !== g_hiHash)) {
    if (g_ttDepth[idx] >= depth + 3)
      return;
  }

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
  // [Sonnet 4.6] 2 killers per ply + move made to reach this ply (for countermove lookup)
  this.killer1 = 0;
  this.killer2 = 0;
  this.move = 0;
  // [Opus 4.7] Cached static eval at this ply for the improving heuristic.
  // search() writes this before children are explored; search() at ply+2
  // reads this to detect "static eval is improving vs grandparent".
  // Sentinel -INF means "not yet set" (e.g. in_check or null move).
  this.staticEv = -INF;

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
// [Opus 4.7] Static Exchange Evaluator (SEE).
//
// seeGE(move, threshold) returns 1 iff the static exchange evaluation of
// `move` is >= threshold (in centipawns). This is the "threshold SEE" form
// used by modern engines — it's cheaper than computing the exact SEE and
// answers the only question we ever ask ("is this capture losing material?").
//
// Approach: walk the capture sequence on the target square. At each step the
// side to move picks its least-valuable attacker (LVA) and swaps. As pieces
// leave the board, sliding pieces behind them can become new attackers, so
// after each step we re-scan attackers using the working occupancy mask
// (g_seeOcc — a sparse "is this square occupied by a piece we have not yet
// removed?" view; piece colour/type still come from g_board since we never
// move pieces, only zero out squares).
//
// Promotion and en-passant: SEE is only called on noisy moves in the engine.
// For en passant we account for the captured pawn at the ep-capture square
// (not at `to`). For promotions we boost the moving pawn's "value" by the
// promotion gain so the swap accounting matches a queen being on `to` after
// the move. Promotion capture pieces other than queen are rare enough to
// be treated as queen — a conservative approximation that does not change
// the sign of SEE in any realistic position.
//
// SEE_VALS uses simple integer values aligned with eval-style centipawns.
// These deliberately differ slightly from PST material to avoid SEE thinking
// it can "win" a piece-vs-pawn trade for 1 cp.
//

const SEE_VALS = new Int16Array(7);
SEE_VALS[PAWN]   = 100;
SEE_VALS[KNIGHT] = 320;
SEE_VALS[BISHOP] = 330;
SEE_VALS[ROOK]   = 500;
SEE_VALS[QUEEN]  = 950;
SEE_VALS[KING]   = 20000; // captures by king only allowed if no defenders remain

// [Opus 4.7] Working occupancy mask for SEE. Bit-per-square would be cleaner
// but a Uint8Array is simpler with the 0x88 board (and the JIT inlines
// typed-array indexing well).
const g_seeOcc = new Uint8Array(128);

// Find the least-valuable attacker of `sq` from `byColour`. Only considers
// squares marked occupied in g_seeOcc. Returns the from-square (0..127) of
// the LVA or -1 if none. attackerType (out) is written to g_seeLvaType[0].
//
// Order: pawn → knight → bishop → rook → queen → king. We deliberately scan
// bishops before queens (and rooks before queens) so we pick up the less-
// valuable diagonal/orthogonal attacker first. A queen on a diagonal is
// caught by the bishop scan only if it matches BISHOP, so it falls through
// to the queen scan — that's correct (queen is more valuable than bishop).

const g_seeLvaType = new Int32Array(1);

function seeLVA(sq, byColour) {

  const b = g_board;
  const occ = g_seeOcc;

  // pawn
  const pawnDir = byColour === WHITE ? -16 : 16;
  const pawnPiece = PAWN | byColour;
  for (let i = -1; i <= 1; i += 2) {
    const from = sq + pawnDir + i;
    if (!(from & 0x88) && occ[from] && b[from] === pawnPiece) {
      g_seeLvaType[0] = PAWN;
      return from;
    }
  }

  // knight
  const knightPiece = KNIGHT | byColour;
  for (let i = 0; i < 8; i++) {
    const from = sq + KNIGHT_OFFSETS[i];
    if (!(from & 0x88) && occ[from] && b[from] === knightPiece) {
      g_seeLvaType[0] = KNIGHT;
      return from;
    }
  }

  // bishop along diagonals — skip empty (occ==0) squares
  const bishopPiece = BISHOP | byColour;
  for (let i = 0; i < 4; i++) {
    const dir = BISHOP_OFFSETS[i];
    for (let to = sq + dir; !(to & 0x88); to += dir) {
      if (!occ[to]) continue;
      if (b[to] === bishopPiece) {
        g_seeLvaType[0] = BISHOP;
        return to;
      }
      break; // blocked by some other piece
    }
  }

  // rook along ranks/files
  const rookPiece = ROOK | byColour;
  for (let i = 0; i < 4; i++) {
    const dir = ROOK_OFFSETS[i];
    for (let to = sq + dir; !(to & 0x88); to += dir) {
      if (!occ[to]) continue;
      if (b[to] === rookPiece) {
        g_seeLvaType[0] = ROOK;
        return to;
      }
      break;
    }
  }

  // queen along all 8 directions
  const queenPiece = QUEEN | byColour;
  for (let i = 0; i < 8; i++) {
    const dir = QUEEN_OFFSETS[i];
    for (let to = sq + dir; !(to & 0x88); to += dir) {
      if (!occ[to]) continue;
      if (b[to] === queenPiece) {
        g_seeLvaType[0] = QUEEN;
        return to;
      }
      break;
    }
  }

  // king (always last — only used if no other defenders remain)
  const kingPiece = KING | byColour;
  for (let i = 0; i < 8; i++) {
    const from = sq + KING_OFFSETS[i];
    if (!(from & 0x88) && occ[from] && b[from] === kingPiece) {
      g_seeLvaType[0] = KING;
      return from;
    }
  }

  return -1;
}

// [Opus 4.7] Classic SEE swap-list algorithm — reordered so the forward
// loop's gain[d] only ever describes ACTUAL captures.
//
// Invariant: at the start of each forward iteration, `pieceOnTo` is the
// piece type currently sitting on `to` (left behind by the most recent
// capture). We then look up the LVA for `side`; if found, we increment d
// and record gain[d] = V[pieceOnTo] - gain[d-1]. The LVA becomes the new
// pieceOnTo for the next iteration.
//
// This is the "find LVA first, then commit the swap" arrangement. It avoids
// the speculative-break correctness pitfall present in the literal
// CPW pseudocode (which can break out at d=1 before the retreat formula
// gets a chance to fold gain[1] into gain[0]).
//
// Minimax retreat: `while (d > 0) gain[d-1] = -max(-gain[d-1], gain[d]); d--`
// runs `d` iterations and processes every committed capture, which is
// what we want because every gain[d] in the array corresponds to a real
// recapture.
//
// X-rays: handled implicitly. seeLVA re-scans the working occupancy each
// call, so when a slider is removed, a slider behind it on the same line
// becomes visible.
//
// King: the king may not recapture into check. If the LVA is a KING but
// the opposing side still has any attacker on `to`, the sequence ends.

const g_seeGain = new Int32Array(32);

function see(move) {

  const b = g_board;
  const fr = (move >> 7) & 0x7F;
  const to = move & 0x7F;
  const stm = g_stm;

  // Initial capture: compute what's won and what type now sits on `to`.
  let captured;
  let pieceOnTo;

  if (move & MOVE_FLAG_EPCAPTURE) {
    captured = SEE_VALS[PAWN];
    pieceOnTo = PAWN;
  } else if (move & MOVE_FLAG_PROMOTE) {
    const promType = (move >> PROMOTE_SHIFT) & 7;
    const capV = (move & MOVE_FLAG_CAPTURE) ? SEE_VALS[b[to] & 7] : 0;
    captured = capV + SEE_VALS[promType] - SEE_VALS[PAWN];
    pieceOnTo = promType;
  } else {
    captured = SEE_VALS[b[to] & 7];
    pieceOnTo = b[fr] & 7;
  }

  // Build working occupancy. The mover from `fr` has just moved to `to`,
  // so `fr` becomes empty and the ep-victim square (if any) becomes empty.
  // `to` stays occupied (now by the mover).
  const occ = g_seeOcc;
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) { sq += 7; continue; }
    occ[sq] = b[sq] ? 1 : 0;
  }
  occ[fr] = 0;
  if (move & MOVE_FLAG_EPCAPTURE) {
    const capSq = to - 16 + (stm << 2);
    occ[capSq] = 0;
  }

  const gain = g_seeGain;
  gain[0] = captured;
  let d = 0;
  let side = stm ^ BLACK; // opponent gets first recapture

  for (;;) {
    // Find side's least-valuable attacker on `to`.
    const lvaFrom = seeLVA(to, side);
    if (lvaFrom < 0) break;

    // King may not capture into check.
    if (g_seeLvaType[0] === KING) {
      occ[lvaFrom] = 0;
      const otherAttacker = seeLVA(to, side ^ BLACK);
      occ[lvaFrom] = 1;
      if (otherAttacker >= 0) break;
    }

    // Commit the capture: side takes pieceOnTo.
    d++;
    if (d >= 32) { d--; break; } // safety: 32-deep swaps don't happen in real positions
    gain[d] = SEE_VALS[pieceOnTo] - gain[d - 1];

    pieceOnTo = g_seeLvaType[0];
    occ[lvaFrom] = 0;
    side ^= BLACK;
  }

  // Minimax retreat: each level's side chooses capture (gain[d]) or stop
  // (negation of previous gain). gain[d-1] := -max(-gain[d-1], gain[d]).
  while (d > 0) {
    const a = -gain[d - 1];
    const b2 = gain[d];
    gain[d - 1] = -(a > b2 ? a : b2);
    d--;
  }

  return gain[0];
}

function seeGE(move, threshold) {
  return see(move) >= threshold ? 1 : 0;
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
// clearQpth runs at the start of each `go` so scores do not persist across
// UCI search invocations.
//
// [Sonnet 4.6] Added g_countermove table: 15×128 Uint32Array indexed by
// [prevPiece][prevToSq] storing the best response move (countermove heuristic).
//

const g_qpth = Array(15); // quiet piece to history

// [Sonnet 4.6] Countermove table: g_countermove[piece][toSq] = bestResponseMove
const g_countermove = Array(15);

// [Opus 4.7] HIST_MAX is the gravity-cap for history values. When a bonus
// is applied, the actual delta becomes `bonus - h * |bonus| / HIST_MAX`,
// which asymptotically clamps |h| <= HIST_MAX. Without gravity, history
// scores grow unboundedly and lose discriminative power between moves.
const HIST_MAX = 16384;

function updateQpth(move, bonus) {

  const to = move & 0x7F;
  const fr = (move >> 7) & 0x7F;
  const piece = g_board[fr];
  // [Opus 4.7] Gravity-bounded update.
  const h = g_qpth[piece][to];
  const absB = bonus < 0 ? -bonus : bonus;
  g_qpth[piece][to] = h + bonus - (h * absB / HIST_MAX | 0);

}

function initQpth () {

    for (let i=0; i < 15; i++) {
      g_qpth[i] = new Int32Array(128);
      // [Sonnet 4.6] Init countermove table alongside history
      g_countermove[i] = new Uint32Array(128);
    }

}

function clearQpth () {

    for (let i=0; i < 15; i++) {
      g_qpth[i].fill(0);
      // [Sonnet 4.6] Clear countermove table on each new search
      g_countermove[i].fill(0);
    }

    // [Sonnet 4.6] Clear per-ply killer and move fields on each new search
    // [Opus 4.7] also clear cached static eval for improving heuristic
    for (let i=0; i < MAX_PLY; i++) {
      g_ss[i].killer1 = 0;
      g_ss[i].killer2 = 0;
      g_ss[i].move = 0;
      g_ss[i].staticEv = -INF;
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

// [Sonnet 4.6] rankQuiets now accepts ply to access killer1, killer2, and countermove
function rankQuiets(node, ply) {

  const b = g_board;
  const moves = node.moves;
  const ranks = node.ranks;
  const n = node.numMoves;
  const nd = g_ss[ply];
  const k1 = nd.killer1;
  const k2 = nd.killer2;
  // [Sonnet 4.6] Look up countermove: what move beat the opponent's last move
  let cm = 0;
  const prevMove = nd.move;
  if (prevMove) {
    const prevPiece = b[prevMove & 0x7F];
    if (prevPiece) cm = g_countermove[prevPiece][prevMove & 0x7F];
  }

  for (let i = 0; i < n; i++) {

    const m = moves[i];
    // [Sonnet 4.6] Order: killer1 > killer2 > countermove > history
    if (m === k1) ranks[i] = 900000;
    else if (m === k2) ranks[i] = 800000;
    else if (m === cm) ranks[i] = 700000;
    else {
      const piece = b[(m >> 7) & 0x7F];
      ranks[i] = g_qpth[piece][m & 0x7F];
    }

    if (m & MOVE_FLAG_NOISY)
      console.log('NOISY MOVE IN QUIET LIST');
  }
}

// [Opus 4.7] rankNoisy now bands captures into "good" and "bad" via SEE.
// Good captures (SEE >= 0) get high positive ranks based on MVV-LVA;
// bad captures (SEE < 0) get a deeply negative band so they're ordered
// after killers and history-good quiets. Promotions stay on top regardless.
//
// The bands:
//   QUEEN promotion (any)           : 2,000,000+
//   other promotions                : 1,000,000 + promType*100,000
//   good capture (SEE >= 0)         :   100,000 + MVV-LVA score
//   bad capture (SEE < 0)           :  -100,000 + MVV-LVA + see/10
//
// Numerically these sit above/below the quiet-move ranks (which are bounded
// to ~HIST_MAX = 16,384) and above the special killer/countermove markers
// (700,000..900,000). Bad captures (~-100,000) land below quiets so they
// only run if no quiet is left.

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
      const promType = (m >> PROMOTE_SHIFT) & 7;
      rank = (promType === QUEEN ? 2000000 : 1000000) + promType * 100000;
      if (m & MOVE_FLAG_CAPTURE)
        rank += (b[to] & 7) * 100 - (b[fr] & 7);
    }
    else if (m & MOVE_FLAG_EPCAPTURE) {
      // EP is always a pawn capturing a pawn → SEE is trivially >= 0 (the
      // pawn just stepped to a square unattacked by another pawn on the
      // diagonal in the ep window). Keep it in the "good" band.
      rank = 100000 + PAWN * 100 - PAWN;
    }
    else {
      const mvvLva = (b[to] & 7) * 100 - (b[fr] & 7);
      // [Opus 4.7] Use SEE to split good/bad captures. Cheap MVV-LVA bypass
      // when the capturing piece is no bigger than the captured one — that
      // is always SEE >= 0 (you give up at most what they give up).
      let good = (b[fr] & 7) <= (b[to] & 7) ? 1 : seeGE(m, 0);
      if (good)
        rank = 100000 + mvvLva;
      else
        rank = -100000 + mvvLva; // bad captures
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
//   3  generate quiet moves and castling, rank quiets by killer/countermove/
//      g_qpth history, fall through to stage 4
//   4  drain best-ranked quiet move
// The case fall-throughs are deliberate — stages 1 and 3 set up the list
// and immediately serve the first move from it.
//
// Caller must initSearch(node, inCheck, ttMove, noisyOnly) before the first
// call. removeTTMove deduplicates the TT move out of the freshly generated
// list since stage 0 already returned it.
//
// [Sonnet 4.6] getNextMove now takes ply parameter for killer/countermove ordering
//

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
      // [Sonnet 4.6] Pass ply for killer/countermove ordering
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
  const inCheck = isAttacked(g_kingSq[stm], nstm); // to exercise the move iterator

  let move = 0;
  let total = 0;

  initSearch(node, inCheck, 0, 0);

  // [Sonnet 4.6] Pass ply to getNextMove (perft exercises the full move iterator)
  while ((move = getNextMove(node, ply))) {

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
  // [Opus 4.7] Slightly lower default movestogo when none given so each move
  // gets a touch more time. 20 was a bit conservative for 10+0.1.
  const movestogo = Math.max(params.movestogo || 25, 2);

  const myTime = g_stm === WHITE ? wtime : btime;
  const myInc = g_stm === WHITE ? winc : binc;

  // [Opus 4.7] Safety overhead — reserve a small amount of time per move so
  // we don't time out from scheduler jitter or final-move flush latency.
  // With fastchess timemargin=250, ~30ms gives a comfortable buffer.
  const overhead = 30;
  const effTime = Math.max(myTime - overhead, 1);

  let alloc = effTime / movestogo + myInc * 0.75;

  // don't use more than half the remaining time
  const limit = effTime / 2;
  if (alloc > limit) alloc = limit;
  if (alloc < 1) alloc = 1;

  g_finishTime = g_startTime + alloc;

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
//
// [Sonnet 4.6] Enhanced evaluate() with pawn structure (isolated, doubled,
// passed), bishop pair bonus, and rook open/semi-open file bonuses.
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

// [Sonnet 4.6] Module-level eval working arrays to avoid per-call allocation
const _evalWPF = new Uint8Array(8);  // white pawn counts per file
const _evalBPF = new Uint8Array(8);  // black pawn counts per file

initEval();

// [Sonnet 4.6] Passed pawn bonuses by rank (0x88 rank index 0..7)
// rank 0 = rank 1 (white's back rank), rank 7 = rank 8
// White pawn on rank r uses PASSED_MG[r]; rank 6 = 7th rank = large bonus
// Black pawn on rank r uses PASSED_MG[7-r]; rank 1 = 7th rank = large bonus
const PASSED_MG = new Int16Array([0, 5, 10, 20, 35, 55, 80, 0]);
const PASSED_EG = new Int16Array([0, 10, 20, 40, 65, 95, 130, 0]);

// [Opus 4.7] Mobility bonuses indexed by piece count. Capped at the maximum
// reachable count for each piece. Values are mg/eg in centipawns. These
// are kept small to avoid drowning out PST terms; the point is to make the
// engine prefer development and activity at equal material.
const KNIGHT_MOB_MG = new Int16Array([-30, -15, -5, 0, 5, 10, 15, 18, 20]);
const KNIGHT_MOB_EG = new Int16Array([-30, -15, -5, 0, 5, 10, 15, 18, 20]);
const BISHOP_MOB_MG = new Int16Array([-25, -10, 0, 5, 10, 15, 18, 21, 24, 26, 28, 30, 31, 32]);
const BISHOP_MOB_EG = new Int16Array([-25, -10, 0, 5, 10, 15, 18, 21, 24, 26, 28, 30, 31, 32]);
const ROOK_MOB_MG   = new Int16Array([-15, -8, -3, 0, 3, 6, 9, 12, 14, 16, 18, 19, 20, 21, 22]);
const ROOK_MOB_EG   = new Int16Array([-25, -12, -5, 0, 6, 12, 18, 22, 26, 30, 34, 36, 38, 39, 40]);
const QUEEN_MOB_MG  = new Int16Array(28);
const QUEEN_MOB_EG  = new Int16Array(28);
for (let i = 0; i < 28; i++) {
  // Queen mobility grows slowly and saturates — based on Stockfish ranges.
  QUEEN_MOB_MG[i] = i < 3 ? -10 + i * 3 : Math.min(20, 0 + i);
  QUEEN_MOB_EG[i] = i < 3 ? -20 + i * 5 : Math.min(40, 0 + i * 2);
}

// [Opus 4.7] Outpost bonus is given to knights on the 4th-6th rank (white)
// or 3rd-5th rank (black) when supported by a friendly pawn and not
// attackable by enemy pawns on adjacent files in front. Small but real.
const OUTPOST_MG = 20;
const OUTPOST_EG = 15;

// [Opus 4.7] King pawn-shield bonus per shielding pawn. Pawns immediately
// in front of the king (rank+1) and one rank further (rank+2) on the king's
// file and adjacent files. Larger bonus in midgame, very small in endgame
// (where king activity matters more than safety).
const SHIELD_MG = 12;
const SHIELD_EG = 0;

// [Opus 4.7] Connected/protected passed pawn extra bonus.
const PASSED_SUPPORT_MG = 15;
const PASSED_SUPPORT_EG = 25;

// [Opus 4.7] Tempo bonus — small mg-only bonus for the side to move.
const TEMPO_MG = 12;

// [Opus 4.7] Enhanced evaluate(): adds mobility, knight outposts, tempo,
// pawn shield, and protected-passed bonuses on top of 0002's structure.
function evaluate() {

  const b = g_board;
  let mgW = 0, mgB = 0, egW = 0, egB = 0;
  let phase = 0;

  _evalWPF.fill(0);
  _evalBPF.fill(0);
  let wBishops = 0, bBishops = 0;
  let wRookMask = 0, bRookMask = 0;
  // [Opus 4.7] King squares cached locally for pawn-shield.
  let wKingSq = 0, bKingSq = 0;

  // First pass: material+PST, mobility (sliders/knights), bishop/rook info.
  // Knight and slider mobility counts target squares that are empty or
  // contain an enemy piece. We deliberately do not exclude squares attacked
  // by enemy pawns — that simplification keeps the inner loop tight and
  // matches what plain "pseudo-legal target count" gives.
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) { sq += 7; continue; }
    const piece = b[sq];
    if (!piece) continue;
    const type = piece & 7;
    const file = sq & 7;
    const idx = piece * 128 + sq;
    const isBlack = piece & BLACK;
    const enemy = isBlack ? WHITE : BLACK;

    if (isBlack) {
      mgB += mgPST[idx];
      egB += egPST[idx];
    } else {
      mgW += mgPST[idx];
      egW += egPST[idx];
    }

    if (type === PAWN) {
      if (isBlack) _evalBPF[file]++; else _evalWPF[file]++;
    } else if (type === KING) {
      if (isBlack) bKingSq = sq; else wKingSq = sq;
    } else if (type === BISHOP) {
      if (isBlack) bBishops++; else wBishops++;
    } else if (type === ROOK) {
      if (isBlack) bRookMask |= (1 << file); else wRookMask |= (1 << file);
    }
    phase += PHASE_INC[type];

    // [Opus 4.7] Mobility scan for non-pawn non-king pieces.
    if (type === KNIGHT) {
      let mob = 0;
      for (let i = 0; i < 8; i++) {
        const to = sq + KNIGHT_OFFSETS[i];
        if (to & 0x88) continue;
        const tp = b[to];
        if (!tp || (tp & BLACK) === enemy) mob++;
      }
      if (mob > 8) mob = 8;
      if (isBlack) { mgB += KNIGHT_MOB_MG[mob]; egB += KNIGHT_MOB_EG[mob]; }
      else         { mgW += KNIGHT_MOB_MG[mob]; egW += KNIGHT_MOB_EG[mob]; }
    } else if (type === BISHOP) {
      let mob = 0;
      for (let i = 0; i < 4; i++) {
        const dir = BISHOP_OFFSETS[i];
        for (let to = sq + dir; !(to & 0x88); to += dir) {
          const tp = b[to];
          if (!tp) { mob++; continue; }
          if ((tp & BLACK) === enemy) mob++;
          break;
        }
      }
      if (mob > 13) mob = 13;
      if (isBlack) { mgB += BISHOP_MOB_MG[mob]; egB += BISHOP_MOB_EG[mob]; }
      else         { mgW += BISHOP_MOB_MG[mob]; egW += BISHOP_MOB_EG[mob]; }
    } else if (type === ROOK) {
      let mob = 0;
      for (let i = 0; i < 4; i++) {
        const dir = ROOK_OFFSETS[i];
        for (let to = sq + dir; !(to & 0x88); to += dir) {
          const tp = b[to];
          if (!tp) { mob++; continue; }
          if ((tp & BLACK) === enemy) mob++;
          break;
        }
      }
      if (mob > 14) mob = 14;
      if (isBlack) { mgB += ROOK_MOB_MG[mob]; egB += ROOK_MOB_EG[mob]; }
      else         { mgW += ROOK_MOB_MG[mob]; egW += ROOK_MOB_EG[mob]; }
    } else if (type === QUEEN) {
      let mob = 0;
      for (let i = 0; i < 8; i++) {
        const dir = QUEEN_OFFSETS[i];
        for (let to = sq + dir; !(to & 0x88); to += dir) {
          const tp = b[to];
          if (!tp) { mob++; continue; }
          if ((tp & BLACK) === enemy) mob++;
          break;
        }
      }
      if (mob > 27) mob = 27;
      if (isBlack) { mgB += QUEEN_MOB_MG[mob]; egB += QUEEN_MOB_EG[mob]; }
      else         { mgW += QUEEN_MOB_MG[mob]; egW += QUEEN_MOB_EG[mob]; }
    }
  }

  // Bishop pair bonus (stronger in endgame)
  if (wBishops >= 2) { mgW += 30; egW += 50; }
  if (bBishops >= 2) { mgB += 30; egB += 50; }

  // Rook on open or semi-open file bonus
  for (let f = 0; f < 8; f++) {
    if ((wRookMask >> f) & 1) {
      if (!_evalWPF[f] && !_evalBPF[f]) { mgW += 20; egW += 20; }  // fully open
      else if (!_evalWPF[f])             { mgW += 10; egW += 10; }  // semi-open
    }
    if ((bRookMask >> f) & 1) {
      if (!_evalWPF[f] && !_evalBPF[f]) { mgB += 20; egB += 20; }  // fully open
      else if (!_evalBPF[f])             { mgB += 10; egB += 10; }  // semi-open
    }
  }

  // [Opus 4.7] Second pass: pawn structure + outposts + protected passers.
  // Walks pawns and knights specifically.
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) { sq += 7; continue; }
    const piece = b[sq];
    if (!piece) continue;
    const type = piece & 7;

    if (type === PAWN) {

      const file = sq & 7;
      const rank = sq >> 4;

      if (!(piece & BLACK)) {
        // White pawn
        if (_evalWPF[file] > 1)                          { mgW -= 10; egW -= 15; }  // doubled
        const adjL = file > 0 ? _evalWPF[file - 1] : 0;
        const adjR = file < 7 ? _evalWPF[file + 1] : 0;
        if (!adjL && !adjR)                              { mgW -= 15; egW -= 20; }  // isolated
        // Passed pawn: no black pawn on same or adjacent files strictly ahead
        let passed = true;
        outer: for (let f2 = (file > 0 ? file - 1 : 0); f2 <= (file < 7 ? file + 1 : 7); f2++) {
          if (_evalBPF[f2] === 0) continue;
          for (let r2 = rank + 1; r2 <= 7; r2++) {
            if (b[r2 * 16 + f2] === BPAWN) { passed = false; break outer; }
          }
        }
        if (passed) {
          mgW += PASSED_MG[rank]; egW += PASSED_EG[rank];
          // [Opus 4.7] Protected/connected passer bonus — friendly pawn
          // diagonally behind on either side counts as support.
          const supL = file > 0 && b[(rank - 1) * 16 + file - 1] === WPAWN;
          const supR = file < 7 && b[(rank - 1) * 16 + file + 1] === WPAWN;
          if (supL || supR) {
            // Bonus scales with rank (closer to promotion = more valuable)
            const t = rank > 0 ? rank : 0;
            mgW += (PASSED_SUPPORT_MG * t / 7) | 0;
            egW += (PASSED_SUPPORT_EG * t / 7) | 0;
          }
        }
      } else {
        // Black pawn
        if (_evalBPF[file] > 1)                          { mgB -= 10; egB -= 15; }  // doubled
        const adjL = file > 0 ? _evalBPF[file - 1] : 0;
        const adjR = file < 7 ? _evalBPF[file + 1] : 0;
        if (!adjL && !adjR)                              { mgB -= 15; egB -= 20; }  // isolated
        let passed = true;
        outer: for (let f2 = (file > 0 ? file - 1 : 0); f2 <= (file < 7 ? file + 1 : 7); f2++) {
          if (_evalWPF[f2] === 0) continue;
          for (let r2 = rank - 1; r2 >= 0; r2--) {
            if (b[r2 * 16 + f2] === WPAWN) { passed = false; break outer; }
          }
        }
        if (passed) {
          mgB += PASSED_MG[7 - rank]; egB += PASSED_EG[7 - rank];
          // [Opus 4.7] Protected passer (mirror of white).
          const supL = file > 0 && b[(rank + 1) * 16 + file - 1] === BPAWN;
          const supR = file < 7 && b[(rank + 1) * 16 + file + 1] === BPAWN;
          if (supL || supR) {
            const t = (7 - rank) > 0 ? (7 - rank) : 0;
            mgB += (PASSED_SUPPORT_MG * t / 7) | 0;
            egB += (PASSED_SUPPORT_EG * t / 7) | 0;
          }
        }
      }
    } else if (type === KNIGHT) {
      // [Opus 4.7] Outpost: knight on rank 4-6 (white) or 3-5 (black),
      // supported by a friendly pawn diagonally behind, and not attackable
      // by an enemy pawn on adjacent files ahead.
      const file = sq & 7;
      const rank = sq >> 4;
      if (!(piece & BLACK)) {
        if (rank >= 3 && rank <= 5) {
          const supL = file > 0 && b[(rank - 1) * 16 + file - 1] === WPAWN;
          const supR = file < 7 && b[(rank - 1) * 16 + file + 1] === WPAWN;
          if (supL || supR) {
            let safe = true;
            for (let f2 = file > 0 ? file - 1 : 0; f2 <= (file < 7 ? file + 1 : 7); f2++) {
              if (f2 === file) continue;
              for (let r2 = rank + 1; r2 <= 7; r2++) {
                if (b[r2 * 16 + f2] === BPAWN) { safe = false; break; }
              }
              if (!safe) break;
            }
            if (safe) { mgW += OUTPOST_MG; egW += OUTPOST_EG; }
          }
        }
      } else {
        if (rank >= 2 && rank <= 4) {
          const supL = file > 0 && b[(rank + 1) * 16 + file - 1] === BPAWN;
          const supR = file < 7 && b[(rank + 1) * 16 + file + 1] === BPAWN;
          if (supL || supR) {
            let safe = true;
            for (let f2 = file > 0 ? file - 1 : 0; f2 <= (file < 7 ? file + 1 : 7); f2++) {
              if (f2 === file) continue;
              for (let r2 = rank - 1; r2 >= 0; r2--) {
                if (b[r2 * 16 + f2] === WPAWN) { safe = false; break; }
              }
              if (!safe) break;
            }
            if (safe) { mgB += OUTPOST_MG; egB += OUTPOST_EG; }
          }
        }
      }
    }
  }

  // [Opus 4.7] King pawn shield (midgame only). Count pawns on the king's
  // file and adjacent files at one and two ranks in front.
  // White king: pawn shield ranks are (kingRank+1) and (kingRank+2) on
  // files [kingFile-1 .. kingFile+1].
  {
    const wkFile = wKingSq & 7, wkRank = wKingSq >> 4;
    if (wkRank <= 2) {
      let shield = 0;
      for (let f = wkFile > 0 ? wkFile - 1 : 0; f <= (wkFile < 7 ? wkFile + 1 : 7); f++) {
        const r1 = wkRank + 1;
        const r2 = wkRank + 2;
        if (r1 <= 7 && b[r1 * 16 + f] === WPAWN) shield += 2;
        else if (r2 <= 7 && b[r2 * 16 + f] === WPAWN) shield += 1;
      }
      mgW += SHIELD_MG * shield;
      egW += SHIELD_EG * shield;
    }
    const bkFile = bKingSq & 7, bkRank = bKingSq >> 4;
    if (bkRank >= 5) {
      let shield = 0;
      for (let f = bkFile > 0 ? bkFile - 1 : 0; f <= (bkFile < 7 ? bkFile + 1 : 7); f++) {
        const r1 = bkRank - 1;
        const r2 = bkRank - 2;
        if (r1 >= 0 && b[r1 * 16 + f] === BPAWN) shield += 2;
        else if (r2 >= 0 && b[r2 * 16 + f] === BPAWN) shield += 1;
      }
      mgB += SHIELD_MG * shield;
      egB += SHIELD_EG * shield;
    }
  }

  // tapered eval
  let mgScore = g_stm === WHITE ? mgW - mgB : mgB - mgW;
  let egScore = g_stm === WHITE ? egW - egB : egB - egW;
  // [Opus 4.7] Tempo bonus for side to move (mg-weighted).
  mgScore += TEMPO_MG;

  let mgPhase = phase;
  if (mgPhase > 24) mgPhase = 24;
  const egPhase = 24 - mgPhase;

  return (mgScore * mgPhase + egScore * egPhase) / 24 | 0;
}

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
// Search. Negamax with PVS (principal variation search). go() drives
// iterative deepening with aspiration windows (depth >= 5) starting at ±25cp,
// growing ×1.5 on failure, falling back to full window after delta > 800.
// search recurses into itself for non-leaf nodes and into qsearch when
// depth <= 0.
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
//   - Late move reductions, inline (never applied to captures/promotions):
//       R = floor(0.75 + log(depth) * log(played) / 2.25)
//       then -inCheck, -isPV, clamped to depth - 2.
//   - IID-ish PV reduction when no TT move: depth>5 && isPV && !ttMove → d--.
//   - 2 killers per ply + countermove table for quiet move ordering.
//   - Quiet history bonus/malus on beta cutoff (via updateQpth).
//
// [Sonnet 4.6] Added aspiration windows, 2 killers, countermove updates,
// LMR guard for captures/promotions.
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

  // [Opus 4.7] Cache the static eval at this ply for the improving heuristic.
  // When in check we deliberately do NOT update staticEv so the next non-check
  // ancestor at ply+2 still compares against the previous reliable eval.
  if (!inCheck) node.staticEv = ev;

  // [Opus 4.7] Improving = current eval is better than the eval from two
  // plies ago (i.e. the same side, one full move earlier). Only meaningful
  // when neither this ply nor ply-2 was a null-move/in-check ply.
  let improving = 0;
  if (!inCheck && ply >= 2) {
    const prevEv = g_ss[ply - 2].staticEv;
    if (prevEv !== -INF && ev > prevEv) improving = 1;
  }

  // [Opus 4.7] Internal Iterative Reduction (IIR): when we have no TT move
  // and depth is moderately deep, shave a ply to avoid expensive blind search.
  // Applied for both PV and non-PV nodes.
  if (depth > 5 && !ttMove)
    depth--;

  let move = 0;
  let played = 0;
  let bestMove = 0;
  let bestScore = -INF;
  let score = 0;

  // [Opus 4.7] Reverse futility pruning — margin scales with depth and
  // tightens when not improving. Without improving, the threshold is harder
  // to clear; with improving, it's a touch easier (so we trim more nodes).
  if (!isPV && !inCheck && beta < MATEISH && depth <= 8) {
    const margin = (90 - 20 * improving) * depth;
    if (ev - margin >= beta)
      return ev;
  }

  // null move pruning
  if (!isPV && !inCheck && beta < MATEISH && depth > 2 && ev > beta) {

    // [Opus 4.7] Slightly deeper reduction at higher depth.
    const R = 3 + (depth >> 3);

    make_null(node);
    if (ply + 1 < MAX_PLY) g_ss[ply + 1].move = 0; // null move marker
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

    // late move pruning — drop quiets past a depth-cubed cap on the move count
    if (depth > 1 && !inCheck && !noisy && alpha > -MATEISH && played > depth * depth * depth)
      continue;

    // futility pruning
    if (played && !inCheck && depth <= 1 && !noisy && alpha > -MATEISH && ev + 100 < alpha)
      continue;

    // [Opus 4.7] SEE pruning for shallow captures with negative SEE — we
    // already filter via the SEE-aware noisy ordering, but with futility-
    // like margins SEE pruning is independent and often catches different
    // bad captures.
    if (depth <= 5 && noisy && (move & MOVE_FLAG_CAPTURE) && !(move & MOVE_FLAG_PROMOTE)
        && alpha > -MATEISH && played > 0) {
      // Threshold: at very shallow depth, demand more material for risky captures.
      const seeThr = -depth * 50;
      if (!seeGE(move, seeThr))
        continue;
    }

    make(node, move);
    if (isAttacked(g_kingSq[stm], nstm)) {
      unmake(node, move);
      continue;
    }

    // [Sonnet 4.6] Set move field on child ply for countermove lookup
    if (ply + 1 < MAX_PLY) g_ss[ply + 1].move = move;

    playedMoves[played++] = move;

    // [Opus 4.7] LMR formula with improving / isPV / inCheck adjustments.
    // Base = log(d)*log(played) / 2.25  + 0.75   (same as 0002 baseline).
    //   - reduce more when not improving (+1 ply)
    //   - reduce less in PV (-1 ply)
    //   - reduce less when we were in check (since check evasions matter)
    let R = 0;
    if (!noisy && depth >= 3 && played > 3) {
      R = Math.floor(0.75 + Math.log(depth) * Math.log(played) / 2.25);
      if (isPV) R -= 1;
      if (!improving) R += 1;
      R -= inCheck;
      // [GPT-5.5] Check-aware LMR. 0003 reduced late quiet checking moves like
      // ordinary quiets. A legal move that gives check is forcing, so reduce it
      // one ply less, but only pay the attack-test cost in the LMR-eligible
      // branch where the information is actually used.
      const givesCheck = isAttacked(g_kingSq[nstm], stm);
      if (givesCheck) R -= 1;
      // [Opus 4.7] History-based small adjustment: highly-rated quiets get
      // reduced less, poorly-rated more. The piece is at `to` post-make
      // (g_board[fr] is empty here, which was wrong in an earlier draft).
      const toSq = move & 0x7F;
      const pp = g_board[toSq];
      const hScore = g_qpth[pp][toSq];
      if (hScore > HIST_MAX / 2) R -= 1;
      else if (hScore < -HIST_MAX / 2) R += 1;
      if (R < 0) R = 0;
      if (R > depth - 2)
        R = depth - 2;
    }

    const childDepth = depth - 1;

    if (isPV) {
      if (played === 1) {
        score = -search(ply + 1, childDepth, -beta, -alpha);
      }
      else {
        score = -search(ply + 1, childDepth - R, -alpha - 1, -alpha);
        if (!g_finished && score > alpha)
          score = -search(ply + 1, childDepth, -beta, -alpha);
      }
    }
    else {
      score = -search(ply + 1, childDepth - R, -beta, -alpha);
      if (!g_finished && score > alpha)
        score = -search(ply + 1, childDepth, -beta, -alpha);
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
            // [Opus 4.7] Slightly larger bonus (scales with depth); capped
            // by HIST_MAX gravity inside updateQpth.
            const bonus = depth * depth + depth;
            updateQpth(bestMove, bonus);
            const nd = g_ss[ply];
            if (bestMove !== nd.killer1) {
              nd.killer2 = nd.killer1;
              nd.killer1 = bestMove;
            }
            const prevMoveNd = nd.move;
            if (prevMoveNd) {
              const prevPiece = g_board[prevMoveNd & 0x7F];
              if (prevPiece) g_countermove[prevPiece][prevMoveNd & 0x7F] = bestMove;
            }
            for (let i = 0; i < played - 1; i++) {
              const pm = playedMoves[i];
              if (!(pm & MOVE_FLAG_NOISY)) updateQpth(pm, -bonus);
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

  while ((move = getNextMove(node, ply))) {

    // delta pruning

    if (!inCheck && !(move & MOVE_FLAG_PROMOTE)) {
      const captured = (move & MOVE_FLAG_EPCAPTURE) ? PAWN : (g_board[move & 0x7F] & 7);
      if (ev + DELTA_VALS[captured] + 200 < alpha)
        continue;
    }

    // [Opus 4.7] SEE pruning: when not in check, skip captures with SEE < 0.
    // Without this, qsearch can balloon while exploring obviously losing
    // captures. Promotions are excluded (they're tactical regardless of SEE).
    // The seeGE call is fast because most captures are decided trivially by
    // the cheap MVV-LVA fast-path.
    if (!inCheck && (move & MOVE_FLAG_CAPTURE) && !(move & MOVE_FLAG_PROMOTE)) {
      const fr = (move >> 7) & 0x7F;
      const to = move & 0x7F;
      // Trivial good capture: smaller piece capturing larger or equal.
      const attT = g_board[fr] & 7;
      const victT = (move & MOVE_FLAG_EPCAPTURE) ? PAWN : (g_board[to] & 7);
      if (attT > victT && !seeGE(move, 0))
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

// [Opus 4.7] go() uses tighter aspiration windows: start at ±15cp, growing
// by ×4/3 on each failure (slower growth means more re-searches inside the
// window, but the window converges faster on close evals). Fallback to
// full window after delta > 600.
function go() {

  clearQpth();

  let bm = 0;
  let prevScore = 0;

  for (let depth = 1; depth <= g_maxDepth && !g_finished; depth++) {
    let score;

    if (depth <= 4) {
      // Full window for shallow depths — aspiration unreliable here
      score = search(0, depth, -INF, INF);
    } else {
      // [Opus 4.7] Tighter starting aspiration window, slower growth.
      let delta = 15;
      let lo = Math.max(-INF, prevScore - delta);
      let hi = Math.min(INF, prevScore + delta);

      for (;;) {
        score = search(0, depth, lo, hi);
        if (g_finished) break;
        if (score <= lo) {
          // [Opus 4.7] When failing low, keep beta where it is (asymmetric
          // window) — research shows this saves nodes.
          lo = Math.max(-INF, score - delta);
          delta = delta + (delta >> 2); // ×1.25 growth
        } else if (score >= hi) {
          hi = Math.min(INF, score + delta);
          delta = delta + (delta >> 2);
        } else {
          break;
        }
        if (delta > 600) {
          score = search(0, depth, -INF, INF);
          break;
        }
      }
    }

    if (g_finished) break;
    prevScore = score;
    const rootBm = rootNode.pvLen > 0 ? rootNode.pv[rootNode.pvLen - 1] : 0;
    if (rootBm) bm = rootBm;
    report(score, depth);
  }

  if (!bm) console.log('NO BEST MOVE');
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
      // [GPT-5.5] Updated engine identity for the new contender.
      console.log('id name Patchwork 0004_GPT_5_5');
      console.log('id author GPT-5.5');
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
