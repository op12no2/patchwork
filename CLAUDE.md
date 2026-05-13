# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository purpose

Per `README.md`, this repo is "Cumulative LLM eval using phased sandboxed areas of a chess engine, starting with the evaluation function." A chess engine acts as a substrate for evaluating LLMs: each phase opens up one well-defined region of `engine.js` for edit (currently the eval region), LLMs reply with a unified diff via a fresh web-UI chat, and any diff that passes a [0, 5] SPRT becomes the new baseline `engine.js`. Syntax errors and crashes are not corrected. Older engines accumulate under `engines/`, results write up in the GitHub wiki. The engine lives in `engine.js`; three thin Node entry points (`bench.js`, `perft.js`, `eval.js`) `require('./engine.js')` and drive the suites. There is no build, no package.json, no dependencies, and no test framework.

## Running

The engine is a UCI chess engine (identifies as "Naddu 1") that runs under Node.js. It reads UCI lines from stdin and writes to stdout via `console.log`. The stdin/argv driver is gated on `if (require.main === module)` so `engine.js` is safe to `require` from other scripts.

Engine entry (`engine.js`):

- Interactive REPL: `node engine.js` then type UCI commands.
- One-shot: each extra `argv` becomes one UCI line, then process exits. Example: `node engine.js "position startpos" "go depth 8"`.

`uciExecLine` accepts only the standard UCI verbs: `uci`, `isready`, `ucinewgame`, `position`, `go`, `quit`. No `setoption`, no debug helpers, no shorthand aliases — anything dev-facing (perft, bench, calling `evaluate()` on a position) is done via `require('./engine.js')` from a driver script.

`engine.js` exports: `uciExecLine`, `position`, `perft`, `evaluate`, and `getNodes()` (current `g_nodes` counter).

## Built-in tests and benchmarks

Each driver takes an optional engine path so you can run a candidate engine from `engines/` without overwriting `engine.js`:

- `node perft.js [maxDepth] [enginePath]` — runs the `PERFTFENS` test suite; pass an int to cap per-FEN depth (e.g. `node perft.js 4` for a quick smoke test). Optional second arg picks a different engine.
- `node bench.js [enginePath]` — searches the 50-position `BENCHFENS` set at depth 6 and prints total nodes / nps. The standard "did I break/speed up the engine" measurement.
- `node eval.js [enginePath]` — calls `evaluate()` on each `BENCHFENS` position (no search) and prints the centipawn score next to the FEN, plus a `total` summary. Useful for spot-checking new eval terms.

Engine path defaults to `./engine.js`. Examples: `node bench.js engines/0001_haiku_4_5.js`, `node perft.js 4 engines/0001_haiku_4_5.js`.

There is no lint or formatter configured; match the existing style (no semicolons-omitted, two-space indent, `"use strict"` at top, no ES modules — everything is top-level globals).

## Architecture

Single-file, single-threaded, all-globals design inside `engine.js`. There are essentially no classes (the only constructor is `nodeStruct` for per-ply search state) and no internal module boundary — every function and table lives in the same scope and mutates shared globals. The CommonJS export at the bottom (`module.exports = { uciExecLine, position, perft, evaluate, getNodes }`) is a thin surface for the `bench.js`/`perft.js`/`eval.js` drivers; the engine itself does not call into them. When changing data layout, search every `g_*` use site; there is no encapsulation layer to protect you.

### Board representation

0x88 board (`g_board`, 128 entries — off-board squares have bit `0x88` set, used pervasively as the "off-board" test, e.g. `if (sq & 0x88)`). Piece encoding packs colour and type into one byte: low 3 bits are piece type (`PAWN`..`KING` = 1..6), bit 3 is colour (`WHITE`=0, `BLACK`=8). Macros `WPAWN`..`BKING` are the combined values; `piece & 7` extracts type, `piece & 8` (or `>>> 3`) extracts colour. The PST and Zobrist tables are sized `15 * 128` and indexed as `piece * 128 + sq` so the colour bit is part of the index.

There is no piece-list data structure — move generation, evaluation, and `isDraw` all walk `g_board` directly with `for (sq = 0; sq < 128; sq++) { if (sq & 0x88) { sq += 7; continue; } ... }`. The only piece location tracked outside the board is the king square: `g_kingSq` is a tiny `Uint8Array(16)` indexed by colour (`g_kingSq[WHITE]`, `g_kingSq[BLACK]`), kept in sync by `make`/`unmake` so `isAttacked(g_kingSq[stm], nstm)` is cheap for the legality test in `search`/`qsearch`/`perft`.

### Move encoding

Moves are packed into a 32-bit int: bits 0–6 = to square (0x88), bits 7–13 = from square, bits 14–17 = flags (`MOVE_FLAG_CAPTURE`, `MOVE_FLAG_EPCAPTURE`, `MOVE_FLAG_CASTLE`, `MOVE_FLAG_PROMOTE` — see `engine.js:43`), bits 20+ = promotion piece type. `MOVE_FLAG_NOISY = PROMOTE|CAPTURE` is the "is this a tactical move" test used throughout move ordering, LMR, futility/late-move pruning, and history updates.

### Hashing and history

64-bit Zobrist split into two 32-bit halves (`g_loHash` / `g_hiHash`) with parallel tables `g_loPieces` / `g_hiPieces`, etc. (`initZobrist`). `make` / `unmake` incrementally XOR the hash and also push the prior hash onto a history stack (`g_loHH` / `g_hiHH`, indexed by `g_hhNext`) so `isDraw` can detect 2-fold repetition by walking backwards only as far as `g_hmClock` (the half-move clock since the last irreversible move). `position()` resets both `g_hhNext` and `g_hmClock` — be aware that the engine treats 2-fold (not 3-fold) as a draw inside search.

### Transposition table

Struct-of-arrays layout for cache friendliness — seven parallel typed arrays (`g_ttLoHash`, `g_ttHiHash`, `g_ttType`, `g_ttDepth`, `g_ttMove`, `g_ttEval`, `g_ttScore`), each entry 18 bytes wide. Size is fixed at `TT_SIZE = 1 << TT_BITS` (`TT_BITS = 20`, so ~1M entries ≈ 18 MB), allocated unconditionally at load time. `TT_MASK = TT_SIZE - 1` is the index mask. The `type` byte packs the bound type (`TT_EXACT`/`TT_ALPHA`/`TT_BETA`) in the low 2 bits plus a `TT_INCHECK` flag in bit 2 — this lets `search` skip the relatively expensive `isAttacked` call on TT hits.

### Search

Negamax with PVS in `search` and `qsearch`. `go` is plain iterative deepening — `search(0, depth, -INF, INF)` at each iteration; no aspiration windows. Pruning/reduction features (and the conditions guarding each, which are load-bearing):

- TT cutoff (non-PV only). TT moves are trusted without legality validation — a 64-bit Zobrist collision producing an illegal move is astronomically rare and is not defended against.
- Mate distance pruning.
- Static beta pruning, null-move pruning (R=3), late-move pruning, futility pruning — all gated on `!isPV && !inCheck` (or similar) and a `score < MATEISH` bound to avoid mate score corruption.
- Late move reductions computed inline in `search` via `Math.floor(0.75 + Math.log(depth) * Math.log(played) / 2.25)`, then adjusted for `inCheck` and `isPV` and clamped to `depth - 2`.
- IID-ish PV depth reduction when no TT move: `if (depth > 5 && isPV && !ttMove) depth--`.
- Quiet history `g_qpth` (the "killers"/history table updated by `updateQpth`) is used for ordering and gets a bonus/malus on beta cutoff. **There is no explicit killer-move array** — quiet ordering rides entirely on this history table.

Move ordering is staged via the `node.stage` machine in `getNextMove`: TT move → noisy moves (ranked by `rankNoisy`, MVV/LVA-ish using `DELTA_VALS`) → quiet moves (ranked by `rankQuiets` from history) → castling. `genNoisy` / `genQuiets` / `genCastling` are split deliberately so `qsearch` can call only `genNoisy`.

Time control parsing in `initTimeControl` supports `depth`/`d`, `nodes`, `movetime`, `infinite`, `ponder`, and `wtime`/`btime`/`winc`/`binc`/`movestogo`. Time/node checks happen every 1024 nodes inside `search`/`qsearch`; `g_finished` is the universal "abort" flag — when set, all callers must return immediately without trusting the score.

### Evaluation (current sandbox)

The evaluation function is the active sandbox for the experiment — the only region of `engine.js` an LLM is asked to edit. Future phases may open other well-defined regions (move ordering, search-tuning constants, TT replacement policy, time management) the same way.

All evaluation code lives inside a clearly delimited region:

```
// ============================================================================
// >>> BEGIN EVAL REGION <<<
// ...
// >>> END EVAL REGION <<<
// ============================================================================
```

Anything between those banners (the `mgPST`/`egPST` arrays, the `PHASE_INC` table, `initEval`, `evaluate`, the `initEval()` call at the end of the region, and any helpers an LLM wants to add) is fair game to replace or extend. The contract is just: `evaluate()` exists and returns a centipawn score from the side-to-move perspective. The init call lives inside the region too, so the bottom-of-file init block doesn't reference eval at all — the region is self-contained and can be replaced wholesale without touching anything else.

The current baseline is Tomasz Michniewski's [Simplified Evaluation Function](https://www.chessprogramming.org/Simplified_Evaluation_Function). Two PSTs (`mgPST`, `egPST`), each `15 * 128` Int16, are built once by `initEval`. The MG and EG tables are deliberately *identical for every piece except the king*, which has separate middle- and end-game tables — so the tapered framework is in place but only the king's positioning shifts as material comes off.

`evaluate` is a single board scan that branches on the colour bit, accumulating `mg`/`eg` for white and black plus a `phase` total from `PHASE_INC` (knight/bishop=1, rook=2, queen=4, clamped to 24). There is currently **no** evaluation beyond material+PST (no pawn structure, mobility, king safety, bishop pair, etc.) — these are natural extensions for the LLM-edit workflow.

### Initialisation order

At the bottom of `engine.js`: `initNodes`, `initZobrist`, `initQpth` run unconditionally at load time (so `require('./engine.js')` from `bench.js`/`perft.js` also pays this cost once). `initEval()` runs from inside the eval region itself, just before the END banner — that way the region is fully self-contained. The TT arrays are sized as top-level `const`s and so are allocated at load too. If you add new global tables, initialise them here as well — there is no module loader to do it for you.

### Procedure

- save chat ui result to e.g. `engines/0001_gpt_5_5.diff`
- apply diff using e.g. `patch -p1 -o engines/0001_gpt_5_5.js engine.js < engines/0001_gpt_5_5.diff`
- `chmod +x engines/*.js`
- add the engine and diff to the repo e.g. `git add engines/*.js && git add engines/*.diff`
- test
- SPRT
- if it passes `cp engines/0001_gpt_5_5.js engine.js`
- add a wiki page called `0001_gpt_5_5` with the experiment results
- commit and push

