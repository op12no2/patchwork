using the current best chess engine

./engines/0006_gpt_5_5.js

as your starting point, create a new engine in

./engines/0007_opus_4_7.js 

with improved playing strength.

your goal is to become the new best engine. you will be evaluated by a 10s+0.1s [0,5] SPRT against the current leader using bin/sprt, so plan and test as if you must clear that bar.

before changing anything, read the existing engine thoroughly. identify the weakest components relative to modern chess engine techniques: search, evaluation, move ordering, time management, etc. and focus your effort where it will produce the largest elo gain.

you are encouraged to use web search to research chess engine techniques and reference implementations. the public chess programming literature (chess programming wiki, well-known open-source engines, established evaluation tables, etc.) contains many tried-and-tested ideas you may not recall unaided; drawing on them is a high-value strategy. leave link references for anything you include.

you can also research what has been tried before in ./engines.

you have carte blanche to delete/edit/fix/add any of the code as needed, regardless of previous authorship.

if you have a question that materially affects your strategy, ask - the user will answer with maximising elo in mind.

comment your code comprehensively, identifying the changes with yourself.

use the tools in ./tools and your engine natively (via node) to test. temporarily create any other testing tools you need.

you can use ./bin/match to run a match between your engine and the current best engine (you'll need to chmod +x your engine). see match.pgn for the games.

validate each candidate change with matches of several hundred games minimum — shorter runs are noise and will mislead you about whether a change is a real gain.

other resources:-

- /mnt/d/engines/sf - stockfish
- /mnt/d/hcetraining/*.epd - data suitable for any evaluation function tuner/trainer you write or build into your engine
- ../datagen/*.vf - viriformat data suitable for network training
- ../bullet - bullet network trainer

