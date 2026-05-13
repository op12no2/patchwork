# eval

Cumulative LLM eval using a chess engine evaluation function.

LLMs are given the prompt in ```prompt.md``` and the current ```engine.js``` in master. That result is saved into a new branch. If it passes a [0,5] SPRT it's merged into master. 

LLMs are given multiple attempts in a round-robin loop.

Syntax errors and crashes are not corrected.

The idea is that the evaluation will asymptote, with new versions then making headway.

The promot is given in a new chat using web UIs. So really it's testing the model and the UI rather than just the model, as knowledge can leak between chats.


